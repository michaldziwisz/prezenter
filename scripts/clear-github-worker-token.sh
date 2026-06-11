#!/usr/bin/env bash
set -euo pipefail

host="${1:-ca}"
key="${PREZENTER_SSH_KEY:-$HOME/.ssh/prezenter_ca_ed25519}"

ssh -i "$key" -o IdentitiesOnly=yes "prezenter@$host" "python3 - <<'PY'
from pathlib import Path

path = Path('/opt/prezenter/deploy/.env')
lines = path.read_text().splitlines()
out = []
for line in lines:
    if line.startswith((
        'GITHUB_TOKEN=',
        'GITHUB_APP_ID=',
        'GITHUB_APP_INSTALLATION_ID=',
        'GITHUB_APP_PRIVATE_KEY_BASE64=',
        'GITHUB_APP_PRIVATE_KEY=',
    )):
        out.append(line.split('=', 1)[0] + '=')
    else:
        out.append(line)
path.write_text('\n'.join(out) + '\n')
path.chmod(0o600)
PY
cd /opt/prezenter/deploy
docker compose up -d >/dev/null
curl -fsS http://127.0.0.1:8080/health >/dev/null
"

printf '%s\n' "GitHub worker token cleared and worker restarted."
