#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

if [ ! -x "$repo_root/.venv/bin/python" ]; then
    echo "Missing $repo_root/.venv/bin/python" >&2
    exit 1
fi

export PYTHONPATH="$repo_root/agent-backend:$repo_root/buddy-backend:$repo_root/stock-backend"
exec "$repo_root/.venv/bin/python" -m uvicorn app.main:app \
    --reload \
    --host 0.0.0.0 \
    --port "${ANOMALO_DEV_PORT:-8000}"
