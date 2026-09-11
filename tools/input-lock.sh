#!/usr/bin/env bash
# input-lock.sh — an agent's side of input arbitration on a shared display.
#
# Claim it before driving, renew while you work, release when you stop. The
# claim is not advisory: the CDP gate refuses to forward until you hold it, so
# an agent that skips this simply cannot reach the browser.
#
#   tools/input-lock.sh status  [--pane ID]
#   tools/input-lock.sh claim   [--pane ID] [--ttl 30000] [--label "what you are doing"]
#   tools/input-lock.sh hold    [--pane ID] -- <command...>   # claim, run, release
#   tools/input-lock.sh release [--pane ID]
#
# --pane defaults to $HERDR_PANE_ID, so inside a herdr pane it can be omitted.
set -euo pipefail

# Same as herdr-share: take port and token from herdr-web's own plugin config
# when the environment does not carry them. Without this every call 401s and
# reports a lock failure that never happened.
ENVF="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/herdr-web}/env"
_cfg() { [ -f "$ENVF" ] || return 0; grep -E "^(export[[:space:]]+)?$1=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' '; }
WEB="${HERDR_WEB_URL:-http://127.0.0.1:$(_cfg HERDR_WEB_PORT || echo 7878)}"
WEB="${WEB%/}"
TOKEN="${HERDR_WEB_TOKEN:-$(_cfg HERDR_WEB_TOKEN)}"
PANE="${HERDR_PANE_ID:-}"
TTL=30000
LABEL="agent"
ACTION="${1:-status}"; shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --pane)  PANE="$2"; shift 2;;
    --ttl)   TTL="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --web)   WEB="$2"; shift 2;;
    --)      shift; break;;
    *)       break;;
  esac
done

if [ -z "$PANE" ]; then
  echo "input-lock: no pane. Pass --pane ID or run inside a herdr pane." >&2
  exit 2
fi

url() { printf '%s/api/input-lock?pane_id=%s%s' "$WEB" "$PANE" "${TOKEN:+&token=$TOKEN}"; }

post() {
  curl -sS -m 5 -X POST -H 'content-type: application/json' \
    -d "{\"owner\":\"agent\",\"action\":\"$1\",\"ttl_ms\":$TTL,\"label\":\"${LABEL//\"/}\"}" \
    "$(url)"
}

case "$ACTION" in
  status)  curl -sS -m 5 "$(url)"; echo;;
  claim)
    out="$(post claim)"; echo "$out"
    # A refusal is a real outcome, not a warning: the display is someone else's.
    echo "$out" | grep -q '"ok":true' || { echo "input-lock: not granted" >&2; exit 1; }
    ;;
  heartbeat) post heartbeat; echo;;
  release)   post release; echo;;
  hold)
    [ $# -gt 0 ] || { echo "input-lock: hold needs a command after --" >&2; exit 2; }
    out="$(post claim)"
    echo "$out" | grep -q '"ok":true' || { echo "input-lock: not granted; not running" >&2; exit 1; }
    # Renew in the background so a long command cannot outlive its own lock, and
    # release on ANY exit — including a signal, which is when a stuck lock hurts.
    ( while :; do sleep $(( TTL / 2000 )); post heartbeat >/dev/null 2>&1 || exit 0; done ) &
    HB=$!
    cleanup() { kill "$HB" 2>/dev/null || true; post release >/dev/null 2>&1 || true; }
    trap cleanup EXIT INT TERM
    "$@"
    ;;
  *) echo "usage: input-lock.sh status|claim|heartbeat|release|hold [--pane ID] [--ttl MS] [--label TEXT]" >&2; exit 2;;
esac
