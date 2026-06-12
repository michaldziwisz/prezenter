# Security Notes

## GitHub App For Workflow Dispatch

Prefer a GitHub App over a personal access token. The worker uses the App's
private key to mint short-lived installation tokens and dispatch the build
workflow.

### Create The App

Open:

```text
https://github.com/settings/apps/new
```

Set:

```text
GitHub App name: Prezenter workflow dispatcher
Homepage URL: https://prezenter.eu.org
Webhook: inactive / unchecked
```

Under `Repository permissions`, set:

```text
Actions: Read and write
```

Leave every other repository permission as `No access`. Account permissions are
not needed.

Under `Where can this GitHub App be installed?`, choose:

```text
Only on this account
```

Click:

```text
Create GitHub App
```

On the App page:

1. Copy `App ID`.
2. In `Private keys`, click `Generate a private key` and save the downloaded
   `.private-key.pem` file locally.
3. In the left sidebar, open `Install App`.
4. Install it only on `michaldziwisz/prezenter`.
5. Open the installation details page and copy the numeric installation ID from
   the URL. It is the number at the end of a URL like:

```text
https://github.com/settings/installations/12345678
```

Install the credentials into the VPS from this local workspace:

```bash
./scripts/install-github-app.sh ca
```

The script validates the App against GitHub's API, sends only the required
runtime values over SSH, writes `/opt/prezenter/deploy/.env`, and restarts the
worker. Do not use `gh` on the VPS.

### Worker Environment

The relevant server-side variables are:

```dotenv
GITHUB_OWNER=michaldziwisz
GITHUB_REPO=prezenter
GITHUB_WORKFLOW=build-presentation.yml
GITHUB_REF=main
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY_BASE64=
```

`GITHUB_TOKEN` should remain empty when GitHub App credentials are configured.

## Fallback: Personal Access Token

The worker only needs to trigger one GitHub Actions workflow:

```text
POST /repos/michaldziwisz/prezenter/actions/workflows/build-presentation.yml/dispatches
```

If a GitHub App is not available, use a fine-grained personal access token
scoped to:

- Resource owner: `michaldziwisz`
- Repository access: only `michaldziwisz/prezenter`
- Repository permissions: `Actions` = `Read and write`
- Expiration: preferably 90 days or less

GitHub automatically includes `Metadata: read`.

GitHub token creation URL template:

```text
https://github.com/settings/personal-access-tokens/new?name=Prezenter%20workflow%20dispatcher&description=Dispatch%20build-presentation.yml%20for%20michaldziwisz%2Fprezenter&target_name=michaldziwisz&expires_in=90&actions=write
```

After generating the token, install it from this local workspace:

```bash
./scripts/install-github-worker-token.sh ca
```

Do not use `gh` on the VPS for this. The script reads the token locally without
echoing it, validates repository workflow access through GitHub's API, sends it
over SSH, updates `/opt/prezenter/deploy/.env`, and restarts the worker.

To remove GitHub dispatch credentials from the VPS:

```bash
./scripts/clear-github-worker-token.sh ca
```

## GitHub Actions Secrets

The repository currently needs:

```text
CALLBACK_SECRET
ARCHIVE_ACCESS_KEY
ARCHIVE_SECRET_KEY
```

`CALLBACK_SECRET` authenticates GitHub Actions callbacks to the worker. Internet
Archive keys are not needed until live publishing is enabled.

Install Internet Archive keys from the local workspace:

```bash
./scripts/install-archive-keys.sh ca
```

The script validates the keys, writes them to `/opt/prezenter/deploy/.env`, sets
the matching GitHub Actions secrets, and restarts the worker. It does not use
`gh` on the VPS.

## VPS Boundaries

- Runtime secrets live only in `/opt/prezenter/deploy/.env`.
- The worker runs as the non-root Linux user `prezenter`.
- The worker container is exposed only on `127.0.0.1:8080`.
- Public HTTP/HTTPS traffic terminates at Caddy.
- The deploy script excludes `creds.txt`, `deploy/.env`, `deploy/data`, and
  Caddy runtime state.
