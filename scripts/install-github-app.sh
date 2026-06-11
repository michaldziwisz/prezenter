#!/usr/bin/env bash
set -euo pipefail

host="${1:-ca}"
key="${PREZENTER_SSH_KEY:-$HOME/.ssh/prezenter_ca_ed25519}"
owner="${GITHUB_OWNER:-michaldziwisz}"
repo="${GITHUB_REPO:-prezenter}"
workflow="${GITHUB_WORKFLOW:-build-presentation.yml}"

read -r -p "GitHub App ID: " app_id
read -r -p "GitHub App installation ID: " installation_id
read -r -p "Path to GitHub App private key .pem: " private_key_path

if [ -z "$app_id" ] || [ -z "$installation_id" ] || [ -z "$private_key_path" ]; then
  printf '%s\n' "App ID, installation ID and private key path are required." >&2
  exit 1
fi

if [ ! -f "$private_key_path" ]; then
  printf 'Private key not found: %s\n' "$private_key_path" >&2
  exit 1
fi

validation_script="$(mktemp --suffix=.mjs)"
validation_output="$(mktemp)"
payload="$(mktemp)"
trap 'rm -f "$validation_script" "$validation_output" "$payload"' EXIT

cat > "$validation_script" <<'NODE'
import { createSign } from 'node:crypto';
import fs from 'node:fs';

const [appId, installationId, owner, repo, workflow, privateKeyPath] = process.argv.slice(2);
const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createJwt() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson({
    iat: now - 60,
    exp: now + 540,
    iss: appId
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey, 'base64url')}`;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'prezenter-worker-installer',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers
    }
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

const jwt = createJwt();
const installation = await request(`https://api.github.com/app/installations/${installationId}`, {
  headers: { Authorization: `Bearer ${jwt}` }
});

const tokenBody = await request(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({
    repositories: [repo],
    permissions: { actions: 'write' }
  })
});

await request(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}`, {
  headers: { Authorization: `Bearer ${tokenBody.token}` }
});

console.log(JSON.stringify({
  installationAccount: installation.account?.login,
  repository: `${owner}/${repo}`,
  workflow,
  expiresAt: tokenBody.expires_at
}));
NODE

node "$validation_script" "$app_id" "$installation_id" "$owner" "$repo" "$workflow" "$private_key_path" > "$validation_output"
printf 'GitHub App validation OK: %s\n' "$(cat "$validation_output")"

APP_ID="$app_id" INSTALLATION_ID="$installation_id" OWNER="$owner" REPO="$repo" WORKFLOW="$workflow" KEY_PATH="$private_key_path" \
  python3 - <<'PY' > "$payload"
import base64
import json
import os
from pathlib import Path

key = Path(os.environ["KEY_PATH"]).read_bytes()
json.dump({
    "GITHUB_APP_ID": os.environ["APP_ID"],
    "GITHUB_APP_INSTALLATION_ID": os.environ["INSTALLATION_ID"],
    "GITHUB_APP_PRIVATE_KEY_BASE64": base64.b64encode(key).decode("ascii"),
    "GITHUB_TOKEN": "",
    "GITHUB_OWNER": os.environ["OWNER"],
    "GITHUB_REPO": os.environ["REPO"],
    "GITHUB_WORKFLOW": os.environ["WORKFLOW"],
    "GITHUB_REF": "main",
}, open("/dev/stdout", "w"))
PY
chmod 600 "$payload"

remote_tmp="/tmp/prezenter-github-app-$$.json"
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

printf '%s\n' "GitHub App credentials installed and worker restarted."
