#!/usr/bin/env bash
# Deploy the latest pushed `main`: the host pulls, tests and reloads itself (deploy/update.sh).
# Push your commits first.
#   TARGET=user@host [JUMP=jumphost] [APP_DIR=/srv/apps/syntone] deploy/deploy.sh
set -euo pipefail
: "${TARGET:?set TARGET=user@host}"
APP_DIR=${APP_DIR:-/srv/apps/syntone}

here=$(dirname "$0")/..
local_head=$(git -C "$here" rev-parse --short HEAD 2>/dev/null || true)
remote_main=$(git -C "$here" rev-parse --short origin/main 2>/dev/null || true)
[ "$local_head" = "$remote_main" ] || echo "note: local HEAD $local_head ≠ origin/main $remote_main — deploying origin/main"

ssh ${JUMP:+-J "$JUMP"} "$TARGET" "$APP_DIR/deploy/update.sh"
