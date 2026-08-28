#!/usr/bin/env bash
# Start the herdr-web bridge with pinned tokens from .env.local.
# Designed to run in a herdr pane so it outlives any one agent session.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if [[ ! -f .env.local ]]; then
  echo "error: .env.local missing. Run: bun run gen-tokens" >&2
  exit 1
fi
set -a; source .env.local; set +a

echo "herdr-web starting on 127.0.0.1:${HERDR_WEB_PORT:-7878}"
echo "user URLs (token per person):"
python3 - <<'PY'
import os
port = os.environ.get("HERDR_WEB_PORT", "7878")
for pair in os.environ.get("HERDR_WEB_USERS", "").split(","):
    if ":" in pair:
        n, t = pair.split(":", 1)
        print(f"  {n:<8} http://127.0.0.1:{port}/?token={t}")
print(f"  {'admin':<8} http://127.0.0.1:{port}/?token={os.environ.get('HERDR_WEB_TOKEN','')}")
PY
echo

# Restart on crash so a transient failure doesn't take the UI down for everyone.
while true; do
  bun src/server/bridge.ts || echo "[start.sh] bridge exited ($?), restarting in 3s"
  sleep 3
done
