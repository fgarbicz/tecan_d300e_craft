#!/usr/bin/env bash
# Serve the D300 Designer locally (static files; ES modules need http://, not file://).
# Open http://127.0.0.1:${D300_PORT:-8931}/app/
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 -I bin/serve.py "${D300_PORT:-8931}"
