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

# 1600x1000, not 1280x800. The window this is viewed in is resizable, and with
# Xvfb the SCREEN is not: its RANDR maximum is fixed at whatever it was started
# with (verified: `xrandr -q` reports "maximum 1280 x 800" and every attempt to
# grow it is refused). So the client scales instead, and a generous native size
# means most window sizes scale DOWN, which stays sharp.
DISPLAY_N=99; WS_PORT=6099; GEOM="1600x1000x24"; LAUNCH_BROWSER=1; STOP=0
# Kiosk by default: this browser lives inside a small iframe, where a tab strip,
# address bar and bookmarks spend scarce pixels on chrome the viewer cannot
# usefully act on. --no-kiosk restores them when you do want to navigate by hand.
KIOSK=1; START_URL="about:blank"
while [ $# -gt 0 ]; do
  case "$1" in
    --display) DISPLAY_N="$2"; shift 2;;
    --port) WS_PORT="$2"; shift 2;;
    --geometry) GEOM="$2"; shift 2;;
    --no-browser) LAUNCH_BROWSER=0; shift;;
    --no-kiosk)   KIOSK=0; shift;;
    --url)        START_URL="$2"; shift 2;;
    --stop) STOP=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
VNC_PORT=$((5900 + DISPLAY_N))
NOVNC_ROOT=${NOVNC_ROOT:-/usr/share/novnc}

# What we start, recorded as we start it. Stopping by RECORDED PID rather than by
# `pkill -f <pattern>` is not tidiness: pkill -f matches any process whose command
# line merely CONTAINS the pattern, which includes the shell that is asking about
# it. It has killed an unrelated terminal here more than once — the pattern
# appears in the command that greps for it, so the grepper dies and the target
# lives. A pidfile cannot do that.
PIDFILE="${XDG_RUNTIME_DIR:-/tmp}/herdr-share-${DISPLAY_N}.pids"
note_pid() { [ -n "${1:-}" ] && printf '%s\n' "$1" >> "$PIDFILE"; }

stop() {
  if [ -s "$PIDFILE" ]; then
    # Youngest first: the browser and the gate before the X server they need.
    tac "$PIDFILE" | while read -r pid; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    sleep 0.5
    while read -r pid; do
      [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done < "$PIDFILE"
    rm -f "$PIDFILE"
  else
    # No record — started by an older version, or the runtime dir was cleared.
    # Fall back to patterns ANCHORED at the start of the command line, which a
    # shell merely mentioning the display cannot satisfy, and never kill self.
    for pat in "^Xvfb :${DISPLAY_N}\b" "^x11vnc -display :${DISPLAY_N}\b" "herdr-novnc-${DISPLAY_N}\b"; do
      pgrep -f "$pat" 2>/dev/null | while read -r p; do
        [ "$p" = "$$" ] || [ "$p" = "$PPID" ] || kill "$p" 2>/dev/null || true
      done
    done
  fi
  rm -rf "${XDG_RUNTIME_DIR:-/tmp}/herdr-novnc-${DISPLAY_N}" 2>/dev/null || true
  if [ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_BIN_PATH:-}" ]; then
    "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" \
      --source shared-browser --clear-token iframe_url >/dev/null 2>&1 || true
  fi
  echo "stopped display :${DISPLAY_N}"
}
[ "$STOP" = 1 ] && { stop; exit 0; }

# Starting on a display that is already up does not fail cleanly: Xvfb refuses,
# the script carries on, and you end up with two metadata refreshers fighting
# over the same pane token and one orphaned stack. Take the old one down first —
# this is what makes "start it again" mean restart.
if DISPLAY=":${DISPLAY_N}" xdpyinfo >/dev/null 2>&1; then
  echo "display :${DISPLAY_N} is already up — restarting it"
  stop >/dev/null
  sleep 1
fi

: > "$PIDFILE"                                   # a fresh start, a fresh record

for bin in Xvfb x11vnc websockify; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done
[ -f "$NOVNC_ROOT/vnc.html" ] || { echo "no noVNC at $NOVNC_ROOT" >&2; exit 1; }

# +extension RANDR so the client can ask for a size at all. Whether the server
# can HONOUR that is a property of the server, not of this flag — plain Xvfb
# cannot grow past its initial geometry — so the mode is probed below rather
# than assumed, and the viewer is told which one it got.
Xvfb ":${DISPLAY_N}" -screen 0 "$GEOM" +extension RANDR >/dev/null 2>&1 &
note_pid $!
for _ in $(seq 20); do DISPLAY=":${DISPLAY_N}" xdpyinfo >/dev/null 2>&1 && break; sleep 0.25; done

# x11vnc inspects the AMBIENT session and exits with "Wayland display server
# detected" even when the target display is a plain X11 Xvfb. Clearing these is
# what lets it attach to :N on a Wayland desktop.
# -listen 127.0.0.1 is NOT optional: x11vnc binds every interface by default,
# which would put a live desktop with input enabled on the network. -no6 is
# needed as well — -listen only constrains IPv4. And -no6 is STILL not enough:
# -rfbport sets the IPv4 port ONLY, so the IPv6 listener falls back to its
# default 5900 and comes up on [::] regardless. Observed live: a -nopw desktop
# on every IPv6 interface while the intended port was loopback-clean. Hence
# -rfbportv6 -1 to disable that listener outright, plus -localhost. Verify with
# `ss -ltn | grep -E ':5900|\[::\]'` after any change to this line.
env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE \
  x11vnc -display ":${DISPLAY_N}" -rfbport "$VNC_PORT" \
    -listen 127.0.0.1 -localhost -no6 -rfbportv6 -1 -xrandr resize \
  -nopw -forever -shared -bg -quiet >/dev/null 2>&1
# -bg makes x11vnc fork, so $! is the parent that already exited. Identify the
# daemon by the port it owns: exact, and it can match nothing else.
X11VNC_PID="$(ss -ltnpH 2>/dev/null | awk -v p=":${VNC_PORT}$" '$4 ~ p {
    if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); exit } }')"
note_pid "${X11VNC_PID:-}"

# The page we serve is OUR shim, not noVNC's stock vnc.html, because input
# arbitration has to be enforced in the RFB client itself: viewOnly there means
# the events are never sent. It needs noVNC's modules beside it, so the web root
# is a directory that overlays the shim onto a symlink farm of the real thing.
SHIM_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/novnc-shim"
WEB_ROOT="${XDG_RUNTIME_DIR:-/tmp}/herdr-novnc-${DISPLAY_N}"
rm -rf "$WEB_ROOT"; mkdir -p "$WEB_ROOT"
for f in "$NOVNC_ROOT"/*; do ln -sf "$f" "$WEB_ROOT/$(basename "$f")"; done
cp "$SHIM_SRC/index.html" "$WEB_ROOT/shared.html"

# Same for websockify: a bare port means 0.0.0.0.
websockify --web="$WEB_ROOT" "127.0.0.1:${WS_PORT}" "localhost:${VNC_PORT}" >/dev/null 2>&1 &
note_pid $!
sleep 1

# resize=remote, not scale: with RANDR above, dragging the window edge changes
# the actual desktop size instead of stretching a picture of an 1280x800 screen.
# Which kind of resize the viewer should attempt, decided by asking the X server
# instead of hoping. A server whose RANDR maximum is larger than its current
# screen can genuinely reflow (real Xorg, TigerVNC's Xvnc); Xvfb reports maximum
# == current and can only be scaled. Getting this wrong is not cosmetic: a viewer
# that asks for a resize the server refuses just shows black margins.
RESIZE_MODE=scale
if command -v xrandr >/dev/null; then
  read -r CUR_W MAX_W <<<"$(DISPLAY=":${DISPLAY_N}" xrandr -q 2>/dev/null | awk '
    /^Screen/ { for (i=1;i<=NF;i++) {
                  if ($i == "current") cur=$(i+1);
                  if ($i == "maximum") max=$(i+1) }
                gsub(/,/,"",cur); print cur+0, max+0; exit }')"
  [ "${MAX_W:-0}" -gt "${CUR_W:-0}" ] 2>/dev/null && RESIZE_MODE=remote
fi
URL="http://127.0.0.1:${WS_PORT}/shared.html?resize=${RESIZE_MODE}"

if [ "$LAUNCH_BROWSER" = 1 ]; then
  # google-chrome FIRST, deliberately. On this machine `chromium` is the snap,
  # which is confined and cannot render on an arbitrary Xvfb display — it starts,
  # answers on its debug port, and never maps a window, which looks exactly like
  # a working display serving a black screen.
  for b in google-chrome chromium chromium-browser firefox; do
    if command -v "$b" >/dev/null; then
      # A DEDICATED profile is required, not a nicety. Started on the default
      # profile while the user already has that browser open, Chrome hands the
      # URL to the running instance and exits — so nothing appears on :N at all,
      # and the user's own session gets a surprise tab. A separate user-data-dir
      # makes this a genuinely separate browser on the virtual display.
      # --window-size must match the display. There is no window manager on this
      # X server to maximise anything, so without it Chrome opens at its default
      # size and leaves a black margin inside the iframe.
      # Chrome wants W,H — with a COMMA. Passing "1280x800" is not an error, it
      # is silently ignored, and the window comes up at Chrome's own 1050x780
      # leaving a black margin inside the iframe that looks like a VNC fault.
      SCREEN_W="${GEOM%%x*}"; SCREEN_H="$(printf '%s' "$GEOM" | cut -dx -f2)"
      KIOSK_ARGS=""
      [ "$KIOSK" = 1 ] && KIOSK_ARGS="--kiosk"
      # -u XDG_SESSION_TYPE is as important as -u WAYLAND_DISPLAY and was the
      # missing half: with it still set to "wayland", Chrome's ozone auto-detect
      # picks the Wayland backend, ignores DISPLAY entirely, and the window opens
      # ON THE USER'S REAL DESKTOP while :N stays empty.
      # shellcheck disable=SC2086
      env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE DISPLAY=":${DISPLAY_N}" "$b" \
        --user-data-dir="${XDG_RUNTIME_DIR:-/tmp}/shared-browser-${DISPLAY_N}" \
        --no-first-run --no-default-browser-check \
        --disable-session-crashed-bubble --disable-infobars \
        $KIOSK_ARGS --window-position=0,0 --window-size="${SCREEN_W},${SCREEN_H}" \
        --remote-debugging-port=$((9300 + DISPLAY_N)) \
        "$START_URL" >/dev/null 2>&1 &
      note_pid $!
      # Verify it actually MAPPED a window, rather than merely starting. A browser
      # that answers CDP but has no window serves a black screen, and every
      # failure mode above produces exactly that.
      MAPPED=0
      for _ in $(seq 24); do
        if DISPLAY=":${DISPLAY_N}" xwininfo -root -children 2>/dev/null \
             | grep -q 'Google-chrome\|Chromium\|Navigator'; then MAPPED=1; break; fi
        sleep 0.5
      done
      if [ "$MAPPED" = 0 ]; then
        echo "browser: $b started but mapped no window on :${DISPLAY_N} — trying the next one" >&2
        continue
      fi
      echo "browser: $b on :${DISPLAY_N} (CDP $((9300 + DISPLAY_N)))"

      # No window manager runs on this X server, so nothing resizes the browser
      # when the client asks the screen to change size. Without this the remote
      # resize half-works: the desktop grows and the browser keeps its old
      # geometry, leaving black margins. Poll the root size and follow it.
      if [ "${RESIZE_MODE:-scale}" = remote ] && command -v xdotool >/dev/null; then
        ( last=""
          while sleep 1; do
            DISPLAY=":${DISPLAY_N}" xdpyinfo >/dev/null 2>&1 || exit 0
            cur="$(DISPLAY=":${DISPLAY_N}" xdpyinfo | awk '/dimensions:/{print $2; exit}')"
            [ "$cur" = "$last" ] && continue
            last="$cur"
            w="${cur%%x*}"; h="${cur#*x}"
            for win in $(DISPLAY=":${DISPLAY_N}" xdotool search --class 'chrome|chromium' 2>/dev/null); do
              DISPLAY=":${DISPLAY_N}" xdotool windowmove "$win" 0 0 windowsize "$win" "$w" "$h" 2>/dev/null || true
            done
          done ) >/dev/null 2>&1 &
        note_pid $!
      fi
      # The agent drives through CDP, so that is where the agent side of the
      # lock is enforced. Chrome listens on a private port; the gate in front of
      # it refuses to forward unless the lock says the agent holds input. An
      # agent that ignores the lock therefore cannot connect at all, rather than
      # being asked nicely not to.
      if [ -n "${HERDR_PANE_ID:-}" ]; then
        "$(dirname "${BASH_SOURCE[0]}")/cdp-gate.ts" \
          --listen $((9400 + DISPLAY_N)) --target $((9300 + DISPLAY_N)) \
          --pane "$HERDR_PANE_ID" --web "${HERDR_WEB_URL:-http://127.0.0.1:7878}" \
          >/dev/null 2>&1 &
        note_pid $!
        echo "cdp gate: 127.0.0.1:$((9400 + DISPLAY_N)) (agent must hold the input lock)"
      fi
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
  # >/dev/null on the SUBSHELL, not just the command inside it: a background
  # child inherits this script's stdout, and anything reading that pipe to EOF —
  # /api/share does — waits for this loop to end, which is never.
  ( while sleep 120; do
      # Die with the display. Without this check the refresher outlives --stop
      # (report-metadata keeps succeeding, so it never noticed) and a stopped
      # display goes on advertising itself — two of them then take turns
      # overwriting the token, which is how a stale URL reappears after a
      # restart that looked clean.
      DISPLAY=":${DISPLAY_N}" xdpyinfo >/dev/null 2>&1 || exit 0
      "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" \
        --source shared-browser --token "iframe_url=${URL}" --ttl-ms 300000 >/dev/null 2>&1 || exit 0
    done ) >/dev/null 2>&1 &
  note_pid $!
else
  echo "not in a herdr pane — not advertising (HERDR_PANE_ID unset)"
fi

echo "display  :${DISPLAY_N}   vnc ${VNC_PORT}   novnc ${WS_PORT}"
echo "url      ${URL}   (${#URL} chars, cap is 80)"
echo "resize   ${RESIZE_MODE}$([ "$RESIZE_MODE" = scale ] && echo "  (this X server cannot reflow; the viewer scales ${GEOM%x*})")"
echo "agent    drive it with DISPLAY=:${DISPLAY_N}, or CDP on $((9300 + DISPLAY_N))"
echo "stop     tools/shared-browser.sh --stop --display ${DISPLAY_N}"
