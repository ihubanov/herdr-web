#!/usr/bin/env bash
# expose.sh — put this herdr-web on the internet, briefly, with no account.
#
#   tools/expose.sh [--ttl-minutes N | --ttl-hours N] [--label TEXT] [--no-pin]
#
# Uses a Cloudflare Quick Tunnel: a random *.trycloudflare.com hostname, no
# Cloudflare account, no API token, no DNS of your own. Ctrl-C ends it.
#
# READ THIS BEFORE YOU RUN IT.
#
# herdr-web drives your terminal panes. Anyone who reaches it with a valid token
# can type into your shells — that is remote code execution on this machine, as
# you. The token is in the URL, so THE URL IS THE CREDENTIAL: a screenshot, a
# pasted link, or synced browser history is enough to hand it over.
#
# Two things reduce the blast radius, and neither removes it:
#   * the link is CLAIMED BY THE FIRST DEVICE that opens it. A second opener is
#     refused even holding the same token, so a leaked URL is useless once used.
#     Pass --no-pin if you genuinely need several devices on one link.
#   * the tunnel gets an EPHEMERAL token, not your admin one. It expires on its
#     own and is revoked when this script exits — and revoking CUTS the live
#     connection, it does not merely block the next request.
#   * that token is not admin, so a guest cannot close panes, disconnect other
#     viewers, or destroy worktrees.
#
# trycloudflare hostnames are public DNS and are routinely probed. Without the
# token a prober gets 401 — but assume the endpoint WILL be found.
set -euo pipefail

# Minutes, not hours. A link that grants shell access should outlive the task
# and nothing more; anything still open an hour later is an oversight, not a
# requirement. --ttl-hours remains for the rare long session.
TTL_MIN=15
LABEL="tunnel"
PIN=true
while [ $# -gt 0 ]; do
  case "$1" in
    --ttl-minutes) TTL_MIN="$2"; shift 2;;
    --ttl-hours)   TTL_MIN=$(( $2 * 60 )); shift 2;;
    --label)     LABEL="$2"; shift 2;;
    --no-pin)    PIN=false; shift;;
    -h|--help)   sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "expose: unknown argument $1" >&2; exit 2;;
  esac
done

ENVF="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/herdr-web}/env"
_cfg() {
  [ -f "$ENVF" ] || return 1
  local v; v="$(grep -E "^(export[[:space:]]+)?$1=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  [ -n "$v" ] || return 1; printf '%s' "$v"
}
PORT="${HERDR_WEB_PORT:-$(_cfg HERDR_WEB_PORT || echo 7878)}"
ADMIN="${HERDR_WEB_TOKEN:-$(_cfg HERDR_WEB_TOKEN || true)}"
WEB="http://127.0.0.1:${PORT}"

command -v cloudflared >/dev/null || {
  cat >&2 <<'EOS'
expose: cloudflared is not installed.

It is a single Go binary from Cloudflare; there is no Python or JS package that
does this (the PyPI wrapper just downloads the same binary). Install it with
your package manager, or:

  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared
EOS
  exit 3
}

curl -sS -m 4 -o /dev/null "${WEB}/api/viewing?pane_id=x" 2>/dev/null || {
  echo "expose: nothing is answering on ${WEB} — is the herdr-web bridge running?" >&2
  exit 4
}
[ -n "$ADMIN" ] || { echo "expose: no admin token found (HERDR_WEB_TOKEN or $ENVF)" >&2; exit 5; }

# Mint the ephemeral token FIRST: if this fails there is no point opening a hole.
MINT="$(curl -sS -m 5 -X POST -H 'content-type: application/json' \
  -d "{\"ttl_ms\":$((TTL_MIN*60000)),\"label\":\"${LABEL//\"/}\",\"pin\":${PIN}}" \
  "${WEB}/api/expose-token?token=${ADMIN}")" || { echo "expose: could not mint a token" >&2; exit 6; }
GUEST="$(printf '%s' "$MINT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"
[ -n "$GUEST" ] || { echo "expose: mint failed: $MINT" >&2; exit 6; }

LOG="$(mktemp -t herdr-expose-XXXXXX.log)"
cleanup() {
  # Revoke before killing the tunnel: a live URL with a dead token is harmless,
  # a dead URL with a live token is a credential still in someone's history.
  curl -sS -m 4 -X DELETE "${WEB}/api/expose-token?token=${ADMIN}&t=${GUEST}" >/dev/null 2>&1 || true
  [ -n "${CF_PID:-}" ] && kill "$CF_PID" 2>/dev/null || true
  rm -f "$LOG"
  echo; echo "expose: tunnel closed and the guest token revoked."
}
trap cleanup EXIT INT TERM

cloudflared tunnel --no-autoupdate --url "$WEB" >"$LOG" 2>&1 &
CF_PID=$!

echo "expose: starting a Cloudflare quick tunnel…"
URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$CF_PID" 2>/dev/null || { echo "expose: cloudflared exited:" >&2; tail -5 "$LOG" >&2; exit 7; }
  sleep 1
done
[ -n "$URL" ] || { echo "expose: no tunnel URL after 40s:" >&2; tail -5 "$LOG" >&2; exit 7; }

cat <<EOS

  ${URL}/?token=${GUEST}

  This link grants control of your terminal panes to anyone who opens it.
  Treat it as a password. It expires in ${TTL_MIN} min, and dies when you Ctrl-C here.
  The guest is NOT admin: no closing panes, no disconnecting others.
$([ "$PIN" = true ] && echo "  The FIRST device to open it claims it; later openers are refused." || echo "  --no-pin: any number of devices may use this link.")

EOS
wait "$CF_PID"
