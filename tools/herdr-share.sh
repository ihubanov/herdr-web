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
_cfg() { [ -f "$ENVF" ] || return 0; grep -E "^$1=" "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' '; }
WEB="${HERDR_WEB_URL:-http://127.0.0.1:$(_cfg HERDR_WEB_PORT || echo 7878)}"
WEB="${WEB%/}"
TOKEN="${HERDR_WEB_TOKEN:-$(_cfg HERDR_WEB_TOKEN)}"
PANE="${HERDR_PANE_ID:-}"
TTL=300000

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

# Advertise, then read back what herdr-web made of it. Reporting the refusal is
# the point: the policy lives in the bridge, and an agent that is told "refused,
# because X" can act, where silence just looks broken.
advertise() {
  local url="$1"
  "$HERDR" pane report-metadata "$PANE" --source herdr-share \
    --token "iframe_url=${url}" --ttl-ms "$TTL" >/dev/null 2>&1 \
    || die "could not set the pane token (is the herdr socket reachable?)"
  sleep 1
  local out; out="$(cap)"
  python3 - "$out" "$url" <<'PY'
import json, sys
try: d = json.loads(sys.argv[1])
except Exception: d = {}
url = sys.argv[2]
if d.get("iframe"):
    print(f"showing: {d['iframe']['url']}")
    print("The user opens it from the embedded-view button in herdr-web.")
    sys.exit(0)
why = d.get("iframeRejected")
pol = d.get("iframePolicy")
if why:
    print(f"REFUSED: {why}", file=sys.stderr)
elif pol == "off":
    print("REFUSED: embedded views are disabled (HERDR_WEB_IFRAMES=off).", file=sys.stderr)
elif pol == "loopback" and not any(h in url for h in ("127.0.0.1", "localhost", "[::1]")):
    print(f"REFUSED: policy is 'loopback' and {url} is not a loopback URL.", file=sys.stderr)
elif d.get("_unverified"):
    # The token was missing or wrong. The advertisement itself already went in;
    # only the read-back failed, so do not call this a refusal.
    print(f"advertised: {url}", file=sys.stderr)
    print("could not confirm it (herdr-web needs a token to read capability). "
          "Check the embedded-view button in herdr-web.", file=sys.stderr)
    sys.exit(0)
else:
    print("REFUSED: herdr-web did not accept it and gave no reason "
          "(is the bridge running?).", file=sys.stderr)
sys.exit(1)
PY
}

case "${1:-status}" in
  url)
    [ $# -ge 2 ] || die "usage: herdr-share url <URL>"
    advertise "$2"
    ;;

  browser)
    # Pick a display/port from the pane id so two panes never collide.
    N=$(( ( $(printf '%s' "$PANE" | cksum | cut -d' ' -f1) % 40 ) + 50 ))
    "$HERE/shared-browser.sh" --display "$N" --port $(( 6900 + N )) >/dev/null 2>&1 || \
      die "shared-browser.sh failed — run it directly to see why."
    sleep 2
    advertise "http://127.0.0.1:$(( 6900 + N ))/shared.html?resize=scale"
    echo "drive it: DISPLAY=:${N}, or CDP through the gate on 127.0.0.1:$(( 9400 + N ))"
    echo "the gate refuses until you hold input:"
    echo "  $HERE/input-lock.sh claim --pane $PANE --label 'what you are doing'"
    echo "  $HERE/input-lock.sh release --pane $PANE"
    [ $# -ge 2 ] && echo "open $2 in it once you hold the lock."
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
    "$HERDR" pane report-metadata "$PANE" --source herdr-share \
      --clear-token iframe_url >/dev/null 2>&1 || true
    for n in $(seq 50 89); do
      [ -e "${XDG_RUNTIME_DIR:-/tmp}/herdr-novnc-${n}" ] && \
        "$HERE/shared-browser.sh" --stop --display "$n" >/dev/null 2>&1 || true
    done
    echo "stopped advertising"
    ;;

  *) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2;;
esac
