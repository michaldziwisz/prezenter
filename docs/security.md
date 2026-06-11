# Security Notes

## GitHub Worker Token

The worker only needs to trigger one GitHub Actions workflow:

```text
POST /repos/michaldziwisz/prezenter/actions/workflows/build-presentation.yml/dispatches
```

Use a fine-grained personal access token scoped to:

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

To remove the worker token from the VPS:

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

## VPS Boundaries

- Runtime secrets live only in `/opt/prezenter/deploy/.env`.
- The worker runs as the non-root Linux user `prezenter`.
- The worker container is exposed only on `127.0.0.1:8080`.
- Public HTTP/HTTPS traffic terminates at Caddy.
- The deploy script excludes `creds.txt`, `deploy/.env`, `deploy/data`, and
  Caddy runtime state.

