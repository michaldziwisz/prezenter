# Prezenter

Prototype for an accessible Markdown presentation publisher.

The intended deployment is:

- static frontend on GitHub Pages or the VPS Caddy frontend,
- a small self-hosted worker for secrets, publication orchestration, and live sync,
- GitHub Actions for Pandoc/reveal.js builds,
- Internet Archive for public source and presentation storage.

## Directories

- `frontend/` - static, accessible UI for publishing and live rooms.
- `worker/` - Node.js worker API and WebSocket reflector.
- `.github/workflows/` - GitHub Actions presentation build workflow.

## Worker Environment

Copy `worker/.env.example` to `.env` on the server and fill the secrets there.

The worker intentionally supports a safe `PUBLISH_MODE=dry-run` mode. In that
mode publishing requests are accepted and logged, but no Internet Archive upload
or GitHub workflow dispatch is attempted.

## Current VPS Layout

On the `ca` host the worker is deployed under:

```text
/opt/prezenter
├─ deploy/.env        # server-only secrets and runtime config
├─ deploy/data/       # publication logs, uploaded bundles, room state
└─ worker/            # Node.js worker image source
```

The application runs as the non-root Linux user `prezenter`. Docker Compose
publishes the worker on server-local `127.0.0.1:8080`; Caddy exposes
`https://prezenter.eu.org` and `https://api.prezenter.eu.org`.

Deploy updates from this workspace with:

```bash
./scripts/deploy-to-ca.sh ca
```

The script intentionally excludes `creds.txt`, `deploy/.env`, and `deploy/data`.

## Switching To Live Publishing

Edit `/opt/prezenter/deploy/.env` on the server and set:

```dotenv
PUBLISH_MODE=live
PUBLIC_API_URL=https://api.example.org
PUBLIC_FRONTEND_URL=https://example.github.io/prezenter
ARCHIVE_ACCESS_KEY=...
ARCHIVE_SECRET_KEY=...
GITHUB_TOKEN=...
GITHUB_OWNER=...
GITHUB_REPO=...
CALLBACK_SECRET=...
```

Add matching GitHub repository secrets:

```text
ARCHIVE_ACCESS_KEY
ARCHIVE_SECRET_KEY
CALLBACK_SECRET
```

Then restart:

```bash
ssh -i ~/.ssh/prezenter_ca_ed25519 prezenter@ca
cd /opt/prezenter/deploy
docker compose up -d
```

For public use from GitHub Pages, put an HTTPS reverse proxy in front of the
worker and allow only the frontend origin in `ALLOWED_ORIGINS`.
