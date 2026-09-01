#!/usr/bin/env bash
# Bring up a browser both a user and an agent can drive, and advertise it to
# herdr-web.
#
#   Xvfb  :N          a virtual X display
#   x11vnc            serves that display over VNC
#   websockify        bridges VNC to WebSocket and serves the noVNC client
#   pane metadata     tells herdr-web the URL, same mechanism as stream_sock
#
# The user drives it through noVNC in the browser; the agent drives the same X
# display through Appium/WebDriver. The shared surface is the display, not the
# iframe — which is why both sides can genuinely see and act on one GUI.
#
#   tools/shared-browser.sh [--display N] [--port P] [--geometry WxH] [--no-browser]
#   tools/shared-browser.sh --stop [--display N]
set -euo pipefail

DISPLAY_N=99; WS_PORT=6099; GEOM="1280x800x24"; LAUNCH_BROWSER=1; STOP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --display) DISPLAY_N="$2"; shift 2;;
    --port) WS_PORT="$2"; shift 2;;
    --geometry) GEOM="$2"; shift 2;;
    --no-browser) LAUNCH_BROWSER=0; shift;;
    --stop) STOP=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
VNC_PORT=$((5900 + DISPLAY_N))
NOVNC_ROOT=${NOVNC_ROOT:-/usr/share/novnc}

stop() {
  pkill -f "websockify .*${WS_PORT} " 2>/dev/null || true
  pkill -f "x11vnc -display :${DISPLAY_N}\b" 2>/dev/null || true
  pkill -f "Xvfb :${DISPLAY_N}\b" 2>/dev/null || true
  if [ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_BIN_PATH:-}" ]; then
    "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" \
      --source shared-browser --clear-token iframe_url >/dev/null 2>&1 || true
  fi
  echo "stopped display :${DISPLAY_N}"
}
[ "$STOP" = 1 ] && { stop; exit 0; }

for bin in Xvfb x11vnc websockify; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done
[ -f "$NOVNC_ROOT/vnc.html" ] || { echo "no noVNC at $NOVNC_ROOT" >&2; exit 1; }

Xvfb ":${DISPLAY_N}" -screen 0 "$GEOM" >/dev/null 2>&1 &
for _ in $(seq 20); do DISPLAY=":${DISPLAY_N}" xdpyinfo >/dev/null 2>&1 && break; sleep 0.25; done

# x11vnc inspects the AMBIENT session and exits with "Wayland display server
# detected" even when the target display is a plain X11 Xvfb. Clearing these is
# what lets it attach to :N on a Wayland desktop.
# -listen 127.0.0.1 is NOT optional: x11vnc binds every interface by default,
# which would put a live desktop with input enabled on the network. -no6 is
# needed as well — -listen only constrains IPv4, and x11vnc otherwise still
# binds the IPv6 wildcard [::].
env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE \
  x11vnc -display ":${DISPLAY_N}" -rfbport "$VNC_PORT" -listen 127.0.0.1 -no6 \
  -nopw -forever -shared -bg -quiet >/dev/null 2>&1

# Same for websockify: a bare port means 0.0.0.0.
websockify --web="$NOVNC_ROOT" "127.0.0.1:${WS_PORT}" "localhost:${VNC_PORT}" >/dev/null 2>&1 &
sleep 1

URL="http://127.0.0.1:${WS_PORT}/vnc.html?autoconnect=1&resize=scale"

if [ "$LAUNCH_BROWSER" = 1 ]; then
  for b in chromium google-chrome chromium-browser firefox; do
    if command -v "$b" >/dev/null; then
      env -u WAYLAND_DISPLAY DISPLAY=":${DISPLAY_N}" "$b" \
        --no-first-run --remote-debugging-port=$((9300 + DISPLAY_N)) \
        about:blank >/dev/null 2>&1 &
      echo "browser: $b on :${DISPLAY_N} (CDP $((9300 + DISPLAY_N)))"
      break
    fi
  done
fi

# Advertise to herdr-web. Same capability pattern as the agent stream: a pane
# token with a TTL, so a crashed session's view expires by itself.
if [ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_BIN_PATH:-}" ]; then
  "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" \
    --source shared-browser --token "iframe_url=${URL}" --ttl-ms 300000 >/dev/null 2>&1 \
    && echo "advertised to herdr-web on pane ${HERDR_PANE_ID}"
  ( while sleep 120; do
      "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" \
        --source shared-browser --token "iframe_url=${URL}" --ttl-ms 300000 >/dev/null 2>&1 || exit 0
    done ) &
else
  echo "not in a herdr pane — not advertising (HERDR_PANE_ID unset)"
fi

echo "display  :${DISPLAY_N}   vnc ${VNC_PORT}   novnc ${WS_PORT}"
echo "url      ${URL}   (${#URL} chars, cap is 80)"
echo "agent    drive it with DISPLAY=:${DISPLAY_N}, or CDP on $((9300 + DISPLAY_N))"
echo "stop     tools/shared-browser.sh --stop --display ${DISPLAY_N}"
