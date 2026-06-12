#!/usr/bin/env bash
set -euo pipefail

host="${1:-ca}"
key="${PREZENTER_SSH_KEY:-$HOME/.ssh/prezenter_ca_ed25519}"
owner="${GITHUB_OWNER:-michaldziwisz}"
repo="${GITHUB_REPO:-prezenter}"

read -r -s -p "Internet Archive access key: " archive_access_key
printf '\n'
read -r -s -p "Internet Archive secret key: " archive_secret_key
printf '\n'

if [ -z "$archive_access_key" ] || [ -z "$archive_secret_key" ]; then
  printf '%s\n' "Internet Archive access key and secret key are required." >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ia_config="$tmpdir/ia.ini"
cat > "$ia_config" <<EOF
[s3]
access = $archive_access_key
secret = $archive_secret_key
EOF
chmod 600 "$ia_config"

if command -v ia >/dev/null 2>&1; then
  ia --config-file "$ia_config" metadata ia-page-terms >/dev/null
else
  docker run --rm \
    -v "$ia_config:/ia.ini:ro" \
    python:3.12-slim \
    sh -c 'pip install --quiet internetarchive >/dev/null && ia --config-file /ia.ini metadata ia-page-terms >/dev/null'
fi

payload="$tmpdir/archive-keys.json"
ARCHIVE_ACCESS_KEY="$archive_access_key" ARCHIVE_SECRET_KEY="$archive_secret_key" python3 - <<'PY' > "$payload"
import json
import os

json.dump({
    "ARCHIVE_ACCESS_KEY": os.environ["ARCHIVE_ACCESS_KEY"],
    "ARCHIVE_SECRET_KEY": os.environ["ARCHIVE_SECRET_KEY"],
}, open("/dev/stdout", "w"))
PY
chmod 600 "$payload"

remote_tmp="/tmp/prezenter-archive-keys-$$.json"
scp -q -i "$key" -o IdentitiesOnly=yes "$payload" "prezenter@$host:$remote_tmp"

ssh -i "$key" -o IdentitiesOnly=yes "prezenter@$host" "python3 - '$remote_tmp' <<'PY'
from pathlib import Path
import json
import sys

remote_tmp = Path(sys.argv[1])
updates = json.loads(remote_tmp.read_text())
path = Path('/opt/prezenter/deploy/.env')
lines = path.read_text().splitlines()
seen = set()
out = []
for line in lines:
    if '=' in line:
        key = line.split('=', 1)[0]
        if key in updates:
            out.append(f'{key}={updates[key]}')
            seen.add(key)
            continue
    out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f'{key}={value}')
path.write_text('\n'.join(out) + '\n')
path.chmod(0o600)
remote_tmp.unlink(missing_ok=True)
PY
cd /opt/prezenter/deploy
docker compose up -d >/dev/null
for attempt in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null; then
    exit 0
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/health >/dev/null
"

gh secret set ARCHIVE_ACCESS_KEY -R "$owner/$repo" --body "$archive_access_key"
gh secret set ARCHIVE_SECRET_KEY -R "$owner/$repo" --body "$archive_secret_key"

printf '%s\n' "Internet Archive keys installed on VPS and GitHub Actions secrets."
