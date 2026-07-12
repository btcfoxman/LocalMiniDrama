---
name: github-env-sync-skill
description: Sync GitHub Actions environment secrets and variables from pasted env text, .env-like files, or mixed key/value notes into a repository Environment. Use when the user asks to upload, import, migrate, synchronize, or compare GitHub Environment secrets/variables, especially with messy text containing secrets/variables sections, KEY=value lines, or KEY:value lines.
---

# GitHub Environment Sync

Use this skill to help sync GitHub Actions Environment secrets and variables safely.

## Workflow

1. Resolve the target repository, Environment name, input file, and token env from config before asking the user.
2. Ask for, or locate, the input text/file containing env values.
3. Classify entries:
   - Prefer explicit sections: `secrets:`, `[secrets]`, `variables:`, `[variables]`.
   - Prefer explicit prefixes: `secret.NAME=value`, `variable.NAME=value`, `secret NAME=value`, `variable NAME=value`.
   - If no marker is present, treat sensitive-looking names as secrets and all others as variables.
4. Run a dry-run first and show only names/counts, never secret values.
5. If the user approves live changes, run the sync script with `GITHUB_TOKEN` set.
6. For multiple GitHub users/owners, prefer automatic token environment variables by repo owner. Use a token map only when the naming convention cannot be used.

## Script

Use `scripts/sync_github_env.py`.

If `.codex/github-env-sync.json` or `.github/github-env-sync.json` exists, the script can infer `--repo`, `--env`, `--input`, `--token-env`, and `--ensure-env`.

Show resolved non-secret parameters:

```bash
python .codex/skills/github-env-sync-skill/scripts/sync_github_env.py --show-config
```

Dry-run from config:

```bash
python .codex/skills/github-env-sync-skill/scripts/sync_github_env.py --dry-run
```

Dry-run from explicit parameters:

```bash
python .codex/skills/github-env-sync-skill/scripts/sync_github_env.py \
  --repo OWNER/REPO \
  --env ENVIRONMENT_NAME \
  --input path/to/env.txt \
  --dry-run
```

Live sync:

```bash
GITHUB_TOKEN=... python .codex/skills/github-env-sync-skill/scripts/sync_github_env.py \
  --repo OWNER/REPO \
  --env ENVIRONMENT_NAME \
  --input path/to/env.txt \
  --ensure-env
```

PowerShell live sync:

```powershell
$env:GITHUB_TOKEN = "..."
python .codex\skills\github-env-sync-skill\scripts\sync_github_env.py `
  --repo OWNER/REPO `
  --env ENVIRONMENT_NAME `
  --input path\to\env.txt `
  --ensure-env
```

Multiple GitHub usernames or repo owners:

Preferred: configure token environment variables once, then omit `--token-env` and `--token-map`.

The script checks these names in order for `--repo alice/project-api`:

1. `GITHUB_TOKEN_ALICE_PROJECT_API`
2. `GITHUB_TOKEN_ALICE`
3. `GITHUB_TOKEN`

Owner and repo names are uppercased and non-alphanumeric characters become `_`.

PowerShell profile example:

```powershell
[Environment]::SetEnvironmentVariable("GITHUB_TOKEN_ALICE", "github_pat_...", "User")
[Environment]::SetEnvironmentVariable("GITHUB_TOKEN_BOB", "github_pat_...", "User")
[Environment]::SetEnvironmentVariable("GITHUB_TOKEN_MY_ORG", "github_pat_...", "User")
```

After opening a new terminal:

```powershell
python .codex\skills\github-env-sync-skill\scripts\sync_github_env.py `
  --repo alice/project-api `
  --env production `
  --input env.txt `
  --ensure-env
```

Optional token map, for custom names:

```json
{
  "owners": {
    "alice": "GITHUB_TOKEN_ALICE",
    "bob": "GITHUB_TOKEN_BOB",
    "my-org": "GITHUB_TOKEN_MY_ORG"
  }
}
```

```powershell
$env:GITHUB_TOKEN_ALICE = "github_pat_..."
$env:GITHUB_TOKEN_BOB = "github_pat_..."
$env:GITHUB_TOKEN_MY_ORG = "github_pat_..."
python .codex\skills\github-env-sync-skill\scripts\sync_github_env.py `
  --repo alice/project `
  --env production `
  --input env.txt `
  --token-map .github-token-map.json `
  --ensure-env
```

If `--token-map` is omitted, the script uses `--token-env` and defaults to `GITHUB_TOKEN`. If both are supplied, an explicit `--token-env` other than `GITHUB_TOKEN` wins.
If convention-based env vars exist, they are used before the token map.

## Local Config

Use `.codex/github-env-sync.json` in a repo to avoid repeating parameters. This file must not contain PAT values or secret values.

For one machine-wide config, set `GITHUB_ENV_SYNC_CONFIG` once:

```powershell
[Environment]::SetEnvironmentVariable("GITHUB_ENV_SYNC_CONFIG", "C:\Users\YOUR_NAME\.codex\github-env-sync.json", "User")
```

Then put the same JSON structure in that file. The script checks `GITHUB_ENV_SYNC_CONFIG` before repo-local config files.

```json
{
  "defaults": {
    "env": "production",
    "input": ".github/env/production.env",
    "ensure_env": true,
    "default_kind": "variable"
  },
  "owners": {
    "alice": {
      "token_env": "GITHUB_TOKEN_ALICE"
    },
    "my-org": {
      "token_env": "GITHUB_TOKEN_MY_ORG",
      "env": "SSH-JP"
    }
  },
  "repos": {
    "alice/project-api": {
      "env": "production",
      "input": ".github/env/project-api.env",
      "token_env": "GITHUB_TOKEN_ALICE_PROJECT_API"
    }
  }
}
```

Resolution order:

- `repo`: command line, config `repo`, config `defaults.repo`, current `git remote.origin.url`
- `env`: command line, `repos[repo].env`, `owners[owner].env`, `defaults.env`
- `input`: command line, `repos[repo].input`, `owners[owner].input`, `defaults.input`
- `token_env`: command line, repo/owner environment-variable convention, config repo/owner/default token env, `GITHUB_TOKEN`
- `ensure_env`: command line `--ensure-env` or any matching config `ensure_env: true`

## Safety Rules

- Do not print secret values in chat or logs.
- Use `--dry-run` before live API calls unless the user explicitly asks to apply immediately.
- Do not pass tokens as command-line arguments. Use `GITHUB_TOKEN` or `--token-env`.
- Do not store PAT values in token-map files. Store only environment variable names.
- Do not store PAT values or secret values in `.codex/github-env-sync.json`.
- Use `--default-kind variable` unless the user explicitly wants unknown entries treated as secrets.
- If the Environment may not exist, use `--ensure-env`.

## GitHub API Notes

Read `references/github_api.md` when changing the script or debugging GitHub API errors.

Key details:
- Environment names and variable/secret names must be URL encoded in path segments.
- Environment secrets use `GET .../secrets/public-key` then `PUT .../secrets/{secret_name}` with a LibSodium sealed box value.
- Environment variables use `POST .../variables` to create and `PATCH .../variables/{name}` to update.
