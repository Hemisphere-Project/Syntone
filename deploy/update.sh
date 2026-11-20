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
curl -fsS -o /dev/null -w "relay: %{http_code}\n" "http://127.0.0.1:${port}/lab/"
echo "deployed $(git rev-parse --short HEAD)"
