#!/usr/bin/env bash
set -euo pipefail

host="${1:-ca}"
key="${PREZENTER_SSH_KEY:-$HOME/.ssh/prezenter_ca_ed25519}"
owner="${GITHUB_OWNER:-michaldziwisz}"
repo="${GITHUB_REPO:-prezenter}"
workflow="${GITHUB_WORKFLOW:-build-presentation.yml}"

printf '%s\n' "This installs a GitHub fine-grained PAT into /opt/prezenter/deploy/.env on $host."
printf '%s\n' "Required token access: repository $owner/$repo, Repository permissions: Actions = Read and write."
printf '%s\n' "The token will be read locally without echo and sent over SSH; it will not be printed."
printf '\n'
read -r -s -p "GitHub fine-grained PAT: " token
printf '\n'

if [ -z "$token" ]; then
  printf '%s\n' "Token is empty." >&2
  exit 1
fi

api_response="$(mktemp)"
trap 'rm -f "$api_response" "$payload"' EXIT

status="$(
  curl -sS -o "$api_response" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer $token" \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/$owner/$repo/actions/workflows/$workflow"
)"

if [ "$status" != "200" ]; then
  printf '%s\n' "GitHub token validation failed with HTTP $status." >&2
  sed -n '1,20p' "$api_response" >&2
  exit 1
fi

payload="$(mktemp)"
TOKEN="$token" OWNER="$owner" REPO="$repo" WORKFLOW="$workflow" python3 - <<'PY' > "$payload"
import json
import os

json.dump({
    "GITHUB_TOKEN": os.environ["TOKEN"],
    "GITHUB_OWNER": os.environ["OWNER"],
    "GITHUB_REPO": os.environ["REPO"],
    "GITHUB_WORKFLOW": os.environ["WORKFLOW"],
    "GITHUB_REF": "main",
}, open("/dev/stdout", "w"))
PY
chmod 600 "$payload"

remote_tmp="/tmp/prezenter-github-token-$$.json"
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
curl -fsS http://127.0.0.1:8080/health >/dev/null
"

printf '%s\n' "GitHub worker token installed and worker restarted."

