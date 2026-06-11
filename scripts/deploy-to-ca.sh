#!/usr/bin/env bash
set -euo pipefail

host="${1:-ca}"
key="${PREZENTER_SSH_KEY:-$HOME/.ssh/prezenter_ca_ed25519}"

rsync -az \
  --delete \
  --exclude 'creds.txt' \
  --exclude '.git' \
  --exclude 'deploy/.env' \
  --exclude 'deploy/data' \
  --exclude 'deploy/caddy' \
  -e "ssh -i $key -o IdentitiesOnly=yes" \
  ./ "prezenter@$host:/opt/prezenter/"

ssh -i "$key" -o IdentitiesOnly=yes "prezenter@$host" \
  'set -eu; cd /opt/prezenter/deploy; docker compose build; docker compose up -d; docker compose ps'
