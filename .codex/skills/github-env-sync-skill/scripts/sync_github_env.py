#!/usr/bin/env python3
"""Sync GitHub Actions Environment secrets and variables from env-like text."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_API_BASE = "https://api.github.com"
DEFAULT_API_VERSION = "2022-11-28"
DEFAULT_CONFIG_CANDIDATES = (
    ".codex/github-env-sync.json",
    ".github/github-env-sync.json",
)
SENSITIVE_NAME_RE = re.compile(
    r"(SECRET|TOKEN|PASSWORD|PASS|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|"
    r"CLIENT[_-]?SECRET|WEBHOOK|CERT|CREDENTIAL|AUTH)",
    re.IGNORECASE,
)
SECTION_RE = re.compile(r"^\s*\[?\s*(secrets?|variables?|vars?)\s*\]?\s*:?\s*$", re.I)
PREFIX_RE = re.compile(r"^\s*(secret|secrets|variable|variables|var|vars)[\s.:]+(.+)$", re.I)
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
BOM_PREFIXES = ("\ufeff", "\u00ef\u00bb\u00bf")


class SyncError(RuntimeError):
    pass


@dataclass
class HttpResult:
    status: int
    data: object
    text: str


def _strip_optional_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _strip_bom_prefix(value: str) -> str:
    for prefix in BOM_PREFIXES:
        if value.startswith(prefix):
            return value[len(prefix) :]
    return value


def _section_kind(raw: str) -> Optional[str]:
    match = SECTION_RE.match(raw.strip())
    if not match:
        return None
    token = match.group(1).lower()
    return "secret" if token.startswith("secret") else "variable"


def _split_key_value(raw: str) -> Optional[Tuple[str, str]]:
    eq_pos = raw.find("=")
    colon_pos = raw.find(":")
    candidates = [pos for pos in (eq_pos, colon_pos) if pos >= 0]
    if not candidates:
        return None
    pos = min(candidates)
    key = raw[:pos].strip()
    value = raw[pos + 1 :].strip()
    if key.lower().startswith("export "):
        key = key[7:].strip()
    if not key:
        return None
    return key, _strip_optional_quotes(value)


def _infer_kind(name: str, default_kind: str) -> str:
    return "secret" if SENSITIVE_NAME_RE.search(name) else default_kind


def parse_env_text(text: str, default_kind: str = "variable") -> Tuple[Dict[str, str], Dict[str, str]]:
    secrets: Dict[str, str] = {}
    variables: Dict[str, str] = {}
    current_kind: Optional[str] = None
    last_kind: Optional[str] = None
    last_name: Optional[str] = None

    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = _strip_bom_prefix(raw_line).strip()
        if not line or line.startswith("#"):
            continue
        had_bullet = False
        if line == "-":
            continue
        if line.startswith("- "):
            had_bullet = True
            line = line[1:].strip()

        section = _section_kind(line)
        if section:
            current_kind = section
            continue

        explicit_kind: Optional[str] = None
        prefix_match = PREFIX_RE.match(line)
        if prefix_match:
            prefix = prefix_match.group(1).lower()
            explicit_kind = "secret" if prefix.startswith("secret") else "variable"
            line = prefix_match.group(2).strip()

        parsed = _split_key_value(line)
        if not parsed:
            if last_kind and last_name:
                target = secrets if last_kind == "secret" else variables
                target[last_name] = f"{target[last_name]}\n{line}"
                continue
            continue
        name, value = parsed
        if not NAME_RE.match(name):
            if last_kind and last_name:
                target = secrets if last_kind == "secret" else variables
                target[last_name] = f"{target[last_name]}\n{line}"
                continue
            raise SyncError(f"Invalid key name on line {line_number}: {name!r}")
        if last_kind and last_name and not had_bullet and explicit_kind is None:
            target = secrets if last_kind == "secret" else variables
            previous_value = target.get(last_name, "")
            if "PRIVATE KEY" in previous_value or len(name) > 64:
                target[last_name] = f"{previous_value}\n{line}"
                continue

        kind = explicit_kind or current_kind or _infer_kind(name, default_kind)
        if kind == "secret":
            secrets[name] = value
        else:
            variables[name] = value
        last_kind = kind
        last_name = name

    return secrets, variables


def _repo_path(repo: str) -> str:
    repo = repo.strip().strip("/")
    if repo.count("/") != 1:
        raise SyncError("Repository must be in owner/repo format.")
    owner, name = repo.split("/", 1)
    if not owner or not name:
        raise SyncError("Repository must be in owner/repo format.")
    return f"{quote(owner, safe='')}/{quote(name, safe='')}"


def repo_owner(repo: str) -> str:
    repo = repo.strip().strip("/")
    if repo.count("/") != 1:
        raise SyncError("Repository must be in owner/repo format.")
    return repo.split("/", 1)[0].strip()


def repo_name(repo: str) -> str:
    repo = repo.strip().strip("/")
    if repo.count("/") != 1:
        raise SyncError("Repository must be in owner/repo format.")
    return repo.split("/", 1)[1].strip()


def env_key_fragment(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "_", str(value or "").strip()).strip("_")
    return text.upper()


def normalize_repo(repo: str) -> str:
    repo = repo.strip().strip("/")
    if repo.endswith(".git"):
        repo = repo[:-4]
    if repo.count("/") != 1:
        raise SyncError("Repository must be in owner/repo format.")
    owner, name = repo.split("/", 1)
    if not owner or not name:
        raise SyncError("Repository must be in owner/repo format.")
    return f"{owner}/{name}"


def parse_github_remote(value: str) -> Optional[str]:
    remote = str(value or "").strip()
    if not remote:
        return None
    patterns = [
        r"^git@github\.com:(?P<repo>[^/]+/[^/]+?)(?:\.git)?$",
        r"^https://github\.com/(?P<repo>[^/]+/[^/]+?)(?:\.git)?/?$",
        r"^ssh://git@github\.com/(?P<repo>[^/]+/[^/]+?)(?:\.git)?/?$",
    ]
    for pattern in patterns:
        match = re.match(pattern, remote)
        if match:
            return normalize_repo(match.group("repo"))
    return None


def infer_repo_from_git() -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "config", "--get", "remote.origin.url"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return parse_github_remote(result.stdout.strip())


def _headers(token: str, api_version: str) -> Dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": api_version,
        "Content-Type": "application/json",
        "User-Agent": "codex-github-env-sync-skill",
    }


def github_request(
    method: str,
    url: str,
    token: str,
    api_version: str,
    payload: Optional[dict] = None,
    expected: Iterable[int] = (200, 201, 204),
) -> HttpResult:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, method=method.upper(), headers=_headers(token, api_version))
    try:
        with urlopen(request, timeout=60) as response:
            text = response.read().decode("utf-8")
            data = json.loads(text) if text else {}
            result = HttpResult(status=response.status, data=data, text=text)
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        data = {}
        try:
            data = json.loads(text) if text else {}
        except json.JSONDecodeError:
            data = {"message": text}
        result = HttpResult(status=exc.code, data=data, text=text)

    if result.status not in set(expected):
        message = ""
        if isinstance(result.data, dict):
            message = str(result.data.get("message") or "")
        raise SyncError(f"GitHub API {method.upper()} {url} failed with {result.status}: {message or result.text}")
    return result


def encrypt_secret_value(value: str, public_key: str) -> str:
    try:
        from nacl import encoding, public
    except ImportError as exc:
        raise SyncError("PyNaCl is required for syncing secrets. Install requirements.txt first.") from exc

    key = public.PublicKey(public_key.encode("utf-8"), encoding.Base64Encoder())
    sealed_box = public.SealedBox(key)
    encrypted = sealed_box.encrypt(value.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")


def api_url(api_base: str, repo: str, env_name: str, suffix: str = "") -> str:
    base = api_base.rstrip("/")
    repo_part = _repo_path(repo)
    env_part = quote(env_name, safe="")
    return f"{base}/repos/{repo_part}/environments/{env_part}{suffix}"


def ensure_environment(repo: str, env_name: str, token: str, api_base: str, api_version: str) -> None:
    github_request(
        "PUT",
        api_url(api_base, repo, env_name),
        token,
        api_version,
        payload={},
        expected=(200, 201, 204),
    )


def get_environment_public_key(repo: str, env_name: str, token: str, api_base: str, api_version: str) -> dict:
    result = github_request(
        "GET",
        api_url(api_base, repo, env_name, "/secrets/public-key"),
        token,
        api_version,
    )
    if not isinstance(result.data, dict) or not result.data.get("key") or not result.data.get("key_id"):
        raise SyncError("GitHub public-key response did not include key and key_id.")
    return result.data


def put_secret(
    repo: str,
    env_name: str,
    name: str,
    value: str,
    key_data: dict,
    token: str,
    api_base: str,
    api_version: str,
) -> int:
    encrypted_value = encrypt_secret_value(value, str(key_data["key"]))
    result = github_request(
        "PUT",
        api_url(api_base, repo, env_name, f"/secrets/{quote(name, safe='')}"),
        token,
        api_version,
        payload={"encrypted_value": encrypted_value, "key_id": key_data["key_id"]},
        expected=(201, 204),
    )
    return result.status


def upsert_variable(
    repo: str,
    env_name: str,
    name: str,
    value: str,
    token: str,
    api_base: str,
    api_version: str,
) -> int:
    patch_url = api_url(api_base, repo, env_name, f"/variables/{quote(name, safe='')}")
    try:
        result = github_request(
            "PATCH",
            patch_url,
            token,
            api_version,
            payload={"name": name, "value": value},
            expected=(204,),
        )
        return result.status
    except SyncError as exc:
        if " with 404:" not in str(exc):
            raise

    result = github_request(
        "POST",
        api_url(api_base, repo, env_name, "/variables"),
        token,
        api_version,
        payload={"name": name, "value": value},
        expected=(201,),
    )
    return result.status


def read_input(path_value: str) -> str:
    if path_value == "-":
        return _strip_bom_prefix(sys.stdin.read())
    return Path(path_value).read_text(encoding="utf-8-sig")


def load_token_map(path_value: Optional[str]) -> Dict[str, str]:
    if not path_value:
        return {}
    path = Path(path_value).expanduser()
    if not path.exists():
        raise SyncError(f"Token map file does not exist: {path}")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise SyncError("Token map must be a JSON object.")
    raw_map = data.get("owners", data)
    if not isinstance(raw_map, dict):
        raise SyncError("Token map 'owners' must be a JSON object.")
    out: Dict[str, str] = {}
    for owner, token_env in raw_map.items():
        owner_key = str(owner or "").strip().lower()
        env_name = str(token_env or "").strip()
        if not owner_key or not env_name:
            continue
        if not NAME_RE.match(env_name):
            raise SyncError(f"Invalid token environment variable name for owner {owner}: {env_name}")
        out[owner_key] = env_name
    return out


def default_config_path() -> Optional[str]:
    env_path = os.getenv("GITHUB_ENV_SYNC_CONFIG")
    if env_path:
        return env_path
    for candidate in DEFAULT_CONFIG_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    return None


def load_sync_config(path_value: Optional[str]) -> Dict[str, object]:
    if not path_value:
        return {}
    path = Path(path_value).expanduser()
    if not path.exists():
        raise SyncError(f"Config file does not exist: {path}")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise SyncError("Config file must be a JSON object.")
    return data


def _dict_or_empty(value: object) -> Dict[str, object]:
    return value if isinstance(value, dict) else {}


def owner_config(config: Dict[str, object], repo: str) -> Dict[str, object]:
    owners = _dict_or_empty(config.get("owners"))
    raw = owners.get(repo_owner(repo).lower())
    if raw is None:
        raw = owners.get(repo_owner(repo))
    if isinstance(raw, str):
        return {"token_env": raw}
    return _dict_or_empty(raw)


def repo_config(config: Dict[str, object], repo: str) -> Dict[str, object]:
    repos = _dict_or_empty(config.get("repos"))
    normalized = normalize_repo(repo).lower()
    raw = repos.get(normalized)
    if raw is None:
        raw = repos.get(normalize_repo(repo))
    return _dict_or_empty(raw)


def _first_text(*values: object) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def resolve_effective_args(args: argparse.Namespace) -> argparse.Namespace:
    config_path = args.config or default_config_path()
    config = load_sync_config(config_path)
    defaults = _dict_or_empty(config.get("defaults"))

    repo = _first_text(args.repo, config.get("repo"), defaults.get("repo"))
    if not repo:
        repo = infer_repo_from_git() or ""
    if not repo:
        raise SyncError("Missing --repo and no GitHub remote.origin.url could be inferred.")
    repo = normalize_repo(repo)

    repo_cfg = repo_config(config, repo)
    owner_cfg = owner_config(config, repo)

    env_name = _first_text(args.env, repo_cfg.get("env"), owner_cfg.get("env"), defaults.get("env"))
    if not env_name:
        raise SyncError("Missing --env. Set it in config defaults/repos, or pass --env.")

    input_path = _first_text(args.input, repo_cfg.get("input"), owner_cfg.get("input"), defaults.get("input"))
    if not input_path:
        raise SyncError("Missing --input. Set it in config defaults/repos, pass --input, or use --input -.")

    token_env = _first_text(args.token_env, repo_cfg.get("token_env"), owner_cfg.get("token_env"), defaults.get("token_env"), "GITHUB_TOKEN")
    token_map = _first_text(args.token_map, repo_cfg.get("token_map"), owner_cfg.get("token_map"), defaults.get("token_map"))
    default_kind = _first_text(args.default_kind, repo_cfg.get("default_kind"), owner_cfg.get("default_kind"), defaults.get("default_kind"), "variable")
    if default_kind not in {"secret", "variable"}:
        raise SyncError("default_kind must be 'secret' or 'variable'.")

    args.config = config_path or ""
    args.repo = repo
    args.env = env_name
    args.input = input_path
    args.token_env = token_env
    args.token_map = token_map
    args.default_kind = default_kind
    args.ensure_env = bool(args.ensure_env or repo_cfg.get("ensure_env") or owner_cfg.get("ensure_env") or defaults.get("ensure_env"))
    return args


def resolve_token_env(repo: str, explicit_token_env: str, token_map_path: Optional[str]) -> str:
    if explicit_token_env and explicit_token_env != "GITHUB_TOKEN":
        return explicit_token_env

    owner_fragment = env_key_fragment(repo_owner(repo))
    repo_fragment = env_key_fragment(repo_name(repo))
    implicit_candidates = [
        f"GITHUB_TOKEN_{owner_fragment}_{repo_fragment}",
        f"GITHUB_TOKEN_{owner_fragment}",
    ]
    for candidate in implicit_candidates:
        if os.getenv(candidate):
            return candidate

    token_map = load_token_map(token_map_path)
    owner_key = repo_owner(repo).lower()
    mapped = token_map.get(owner_key)
    if mapped:
        return mapped

    return explicit_token_env or "GITHUB_TOKEN"


def print_plan(secrets: Dict[str, str], variables: Dict[str, str], dry_run: bool) -> None:
    prefix = "[dry-run] " if dry_run else ""
    print(f"{prefix}secrets: {len(secrets)}")
    for name in sorted(secrets):
        print(f"{prefix}  secret {name}")
    print(f"{prefix}variables: {len(variables)}")
    for name in sorted(variables):
        print(f"{prefix}  variable {name}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync GitHub Environment secrets and variables.")
    parser.add_argument("--repo", default="", help="Target repository in owner/repo format. Defaults to config or git remote.origin.url.")
    parser.add_argument("--env", default="", help="GitHub Environment name. Defaults to config.")
    parser.add_argument("--input", default="", help="Input file path, or '-' for stdin. Defaults to config.")
    parser.add_argument(
        "--config",
        default="",
        help="Optional config JSON. Defaults to GITHUB_ENV_SYNC_CONFIG, .codex/github-env-sync.json, or .github/github-env-sync.json.",
    )
    parser.add_argument("--api-base", default=DEFAULT_API_BASE, help="GitHub API base URL.")
    parser.add_argument("--api-version", default=DEFAULT_API_VERSION, help="GitHub REST API version header.")
    parser.add_argument("--token-env", default="", help="Environment variable that holds the token.")
    parser.add_argument(
        "--token-map",
        default=os.getenv("GITHUB_TOKEN_MAP", ""),
        help="Optional JSON file mapping repo owners to token environment variable names.",
    )
    parser.add_argument("--default-kind", choices=("secret", "variable"), default="")
    parser.add_argument("--ensure-env", action="store_true", help="Create/update the Environment before syncing.")
    parser.add_argument("--dry-run", action="store_true", help="Parse and show names without calling GitHub.")
    parser.add_argument("--show-config", action="store_true", help="Print resolved non-secret parameters and exit.")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = resolve_effective_args(build_parser().parse_args(argv))
    token_env = resolve_token_env(args.repo, args.token_env, args.token_map or None)

    if args.show_config:
        print(f"config: {args.config or '-'}")
        print(f"repo: {args.repo}")
        print(f"env: {args.env}")
        print(f"input: {args.input}")
        print(f"default_kind: {args.default_kind}")
        print(f"ensure_env: {str(bool(args.ensure_env)).lower()}")
        print(f"token_env: {token_env}")
        return 0

    text = read_input(args.input)
    secrets, variables = parse_env_text(text, default_kind=args.default_kind)
    print_plan(secrets, variables, dry_run=args.dry_run)

    if args.dry_run:
        return 0

    token = os.getenv(token_env)
    if not token:
        raise SyncError(f"Set {token_env} before running live sync.")
    print(f"token source: {token_env}")

    if args.ensure_env:
        ensure_environment(args.repo, args.env, token, args.api_base, args.api_version)
        print(f"environment {args.env}: ensured")

    key_data = None
    if secrets:
        key_data = get_environment_public_key(args.repo, args.env, token, args.api_base, args.api_version)

    for name, value in sorted(secrets.items()):
        status = put_secret(args.repo, args.env, name, value, key_data or {}, token, args.api_base, args.api_version)
        action = "created" if status == 201 else "updated"
        print(f"secret {name}: {action}")

    for name, value in sorted(variables.items()):
        status = upsert_variable(args.repo, args.env, name, value, token, args.api_base, args.api_version)
        action = "created" if status == 201 else "updated"
        print(f"variable {name}: {action}")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
