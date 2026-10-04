#!/usr/bin/env bash
# One-command deploy: register this addon with HydroOJ and restart it.
# Usage:  ./deploy.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v hydrooj >/dev/null 2>&1; then
    echo "error: 'hydrooj' not found in PATH." >&2
    echo "Run this on the machine where HydroOJ is installed (same user that runs it)." >&2
    exit 1
fi

echo "==> Registering addon: $DIR"
hydrooj addon add "$DIR"

echo "==> Restarting HydroOJ"
if command -v pm2 >/dev/null 2>&1 && pm2 describe hydrooj >/dev/null 2>&1; then
    pm2 restart hydrooj
    echo "==> Done. Open  /sim  (control panel → 查重系统)."
else
    echo "==> Addon registered. Restart HydroOJ to apply, e.g.:"
    echo "      pm2 restart hydrooj      # if managed by pm2"
    echo "      # or restart your hydrooj process manually"
fi