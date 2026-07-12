# GitHub Environment API Reference

This skill targets GitHub Actions repository Environments.

## Headers

Use:

- `Accept: application/vnd.github+json`
- `Authorization: Bearer <token>`
- `X-GitHub-Api-Version: 2022-11-28` unless a newer version is explicitly required

## Permissions

For classic PATs on private repositories, use `repo`.

For fine-grained tokens, grant repository Environment write permissions. Secret endpoints may also require GitHub Actions secrets write permissions depending on token type and organization policy.

## Endpoints

Environment:

- `PUT /repos/{owner}/{repo}/environments/{environment_name}`

Secrets:

- `GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key`
- `PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}`

Variables:

- `POST /repos/{owner}/{repo}/environments/{environment_name}/variables`
- `PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}`
- `GET /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}`

Important: environment variables do not support create-or-update via `PUT`. Create with `POST`; update with `PATCH`.
