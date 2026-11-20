#!/usr/bin/env bash
# Runs ON the host, inside the deploy-only git checkout of this repo.
# Pull main, install, test, reload the relay under pm2.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch --quiet origin main
git reset --quiet --hard origin/main   # deploy-only checkout: never edit on the host
npm ci --omit=dev --no-audit --no-fund --loglevel=error
npm test --silent
pm2 startOrReload deploy/ecosystem.config.cjs --update-env >/dev/null
pm2 save >/dev/null
port=$(node -p "require('./deploy/ecosystem.config.cjs').apps[0].env.PORT")
# the process needs a moment to listen; a relay that does not answer within 10 s is a failed deploy
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/lab/" || true)
  [ "$code" = 200 ] && break
  sleep 0.5
done
echo "relay: $code"
[ "$code" = 200 ] || { echo "relay does not answer on :${port} — see: pm2 logs syntone" >&2; exit 1; }
echo "deployed $(git rev-parse --short HEAD)"
