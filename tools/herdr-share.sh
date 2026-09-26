#!/usr/bin/env bash
# herdr-share — put something on the user's screen from inside a herdr pane.
#
# herdr-web shows an embedded view (a modal in its UI) for any pane that
# advertises an `iframe_url` token. This is the front door for that, so an agent
# does not have to know the token mechanism, and — more importantly — finds out
# IMMEDIATELY when the URL was refused instead of watching nothing happen.
#
#   herdr-share url <URL>        show an existing page (a dev server, a report)
#   herdr-share browser [URL]    start a browser BOTH of you can drive, and show it
#   herdr-share status           what this pane is currently advertising
#   herdr-share stop             stop advertising (and stop the browser if we started it)
#
# `url` is for something you are already serving. `browser` is for when you need
# to drive a GUI the user can also touch: it runs on a virtual display served
# over noVNC, with input arbitration, so you and the user cannot fight over the
# pointer. A browser on the user's real desktop CANNOT be shown here — there is
# no surface to stream — which is the usual reason nothing appears.
#
# Requires HERDR_PANE_ID (herdr sets it in every pane it spawns).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR="${HERDR_BIN_PATH:-$(command -v herdr || echo herdr)}"
# herdr-web's own plugin config is the authority for port and token. Reading it
# here is fair — this script IS herdr-web — and without the token the capability
# read-back 401s, which the old code reported as "refused" even though the
# advertisement had gone through. A false refusal is worse than no check.
ENVF="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/herdr-web}/env"
# Returns non-zero when it finds nothing, so `|| echo <default>` actually fires.
# Returning 0 on a missing file made the port interpolate EMPTY, giving
# WEB=http://127.0.0.1: — every request then failed and the script reported a
# refusal for an advertisement that had in fact succeeded.
_cfg() {
  [ -f "$ENVF" ] || return 1
  local v
  v="$(grep -E "^(export[[:space:]]+)?$1=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}
WEB="${HERDR_WEB_URL:-http://127.0.0.1:${HERDR_WEB_PORT:-$(_cfg HERDR_WEB_PORT || echo 7878)}}"
WEB="${WEB%/}"
# `|| true`: _cfg now fails when it finds nothing, and a failing command
# substitution inside an assignment aborts the script under `set -e`.
TOKEN="${HERDR_WEB_TOKEN:-$(_cfg HERDR_WEB_TOKEN || true)}"
PANE="${HERDR_PANE_ID:-}"

die() { echo "herdr-share: $*" >&2; exit 1; }
[ -n "$PANE" ] || die "no HERDR_PANE_ID — run this inside a herdr pane."

cap() {
  local body code
  body="$(curl -sS -m 5 -w '\n%{http_code}' \
    "${WEB}/api/capability?pane_id=${PANE}${TOKEN:+&token=$TOKEN}" 2>/dev/null)" || { echo '{}'; return; }
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  if [ "$code" = "401" ]; then echo '{"_unverified":true}'; return; fi
  [ -n "$body" ] && echo "$body" || echo '{}'
}

case "${1:-status}" in
  url)
    [ $# -ge 2 ] || die "usage: herdr-share url <URL>"
    # Through the bridge, not straight at the pane token. Writing the token here
    # worked, but it was written ONCE with a 5-minute TTL and nothing renewed it,
    # so "here is the report I built for you" quietly disappeared five minutes
    # later and looked like a broken feature. The bridge renews it for as long as
    # the pane exists.
    body="$(curl -sS -m 20 -X POST -H 'content-type: application/json' \
      -d "{\"pane_id\":\"${PANE}\",\"action\":\"url\",\"url\":\"$2\"}" \
      "${WEB}/api/share${TOKEN:+?token=$TOKEN}" 2>/dev/null)" \
      || die "could not reach herdr-web on ${WEB} — is the bridge running?"
    printf '%s' "$body" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('error'):
    print('REFUSED:', d['error'], file=sys.stderr); sys.exit(1)
print('showing:', d.get('url'))
print('The user opens it from the embedded-view button in herdr-web.')
print('It stays up until you run: herdr-share stop')
"
    ;;

  browser)
    # Delegate to the bridge rather than starting the display here. This used to
    # pick its own display number — from cksum, where the bridge used a different
    # hash — so the same pane got TWO different displays depending on whether the
    # browser was started from here, from the herdr-web button, or over MCP, and
    # a stop from one could not find what the other had started.
    body="$(curl -sS -m 90 -X POST -H 'content-type: application/json' \
      -d "{\"pane_id\":\"${PANE}\",\"action\":\"browser\"${2:+,\"url\":\"$2\"}}" \
      "${WEB}/api/share${TOKEN:+?token=$TOKEN}" 2>/dev/null)" \
      || die "could not reach herdr-web on ${WEB} — is the bridge running?"
    printf '%s' "$body" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('error'):
    print('FAILED:', d['error'], file=sys.stderr); sys.exit(1)
print('showing:', d.get('iframe_url') or '(advertised, but herdr-web did not accept it)')
if d.get('iframe_rejected'): print('REFUSED:', d['iframe_rejected'], file=sys.stderr)
print('drive it: CDP through the gate on 127.0.0.1:%s' % d.get('cdp_gate_port'))
print('          (or DISPLAY=:%s for X tools)' % d.get('display'))
"
    echo "the gate refuses until you hold input:"
    echo "  $HERE/input-lock.sh claim --pane $PANE --label 'what you are doing'"
    echo "  $HERE/input-lock.sh release --pane $PANE"
    ;;

  status)
    cap | python3 -c "
import json,sys
d=json.load(sys.stdin)
f=d.get('iframe')
print('showing:', f['url'] if f else 'nothing')
print('policy :', d.get('iframePolicy'))
if d.get('iframeRejected'): print('refused:', d['iframeRejected'])
"
    ;;

  stop)
    # Also through the bridge: it knows which display belongs to this pane, where
    # the old loop here just tried all forty and would have stopped another
    # pane's display as readily as this one's.
    curl -sS -m 30 -X POST -H 'content-type: application/json' \
      -d "{\"pane_id\":\"${PANE}\",\"action\":\"stop\"}" \
      "${WEB}/api/share${TOKEN:+?token=$TOKEN}" >/dev/null 2>&1 \
      || die "could not reach herdr-web on ${WEB} — is the bridge running?"
    "$HERDR" pane report-metadata "$PANE" --source herdr-share \
      --clear-token iframe_url >/dev/null 2>&1 || true
    echo "stopped advertising, and stopped the shared display if one was running"
    ;;

  *) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2;;
esac
