# herdr-web — build plan

## What this is

A local web UI for the herdr agent runtime. herdr is terminal-only by design and
has **no web UI and no network listener** — its entire control surface is a
newline-delimited JSON Unix socket. This project adds a loopback bridge and a
browser client on top of that socket.

Standalone by necessity: upstream auto-closes unsolicited PRs (`.github/workflows/pr-gate.yml`),
and a browser UI cuts against herdr's stated "one rust binary, no electron"
positioning. Building it separately costs nothing and gates nothing.

## What the web form is actually good for

Not "the TUI again, in a tab." The TUI already wins at driving one pane. The web
form wins where a terminal grid is weak:

1. **Fleet view.** Every agent across every workspace on one screen, sorted by who
   needs you. herdr already computes `agent_status` per pane; the TUI shows it in
   a sidebar bounded by terminal height. A browser can show 40 agents at once.
2. **Blocked-first triage.** `blocked` means an agent is waiting on a human. That
   is the single highest-value signal herdr produces. Surface it as a queue and
   the product becomes "answer your agents," not "find your agents."
3. **Reachability.** Loopback now; Tailscale/SSH-tunnel later. Check on agents
   from a phone without an SSH client.
4. **History and telemetry.** The TUI is ephemeral. A bridge can persist state
   transitions and answer "how long was this blocked," "which repo eats my time."
5. **Multi-pane attention.** Watch 4 agents side by side, each live.

## Architecture

```
browser ──ws/http──> bridge (bun, 127.0.0.1 + token) ──unix socket──> herdr server
                          └─ spawns: herdr terminal session control <pane>
```

Two data paths, deliberately separate:

- **Control/metadata** — direct NDJSON on `herdr.sock`. Cheap, request/response,
  plus one long-lived `events.subscribe` connection for lifecycle pushes.
- **Terminal bytes** — spawn `herdr terminal session control`, forward base64
  ANSI frames to xterm.js as binary WS messages. Do NOT poll `pane.read` for
  live rendering; that is a fallback for snapshots only.

### Security posture

herdr deliberately opens no port (verified: zero HTTP/TLS crates in `Cargo.lock`,
no `TcpListener`). This bridge is the one new attack surface, so:

- bind `127.0.0.1` only, never `0.0.0.0`
- per-run token on every request and WS upgrade
- RPC proxy is **allow-listed by method**, not open passthrough;
  `server.stop`, `server.live_handoff`, `pane.close`, `workspace.close` denied
- anyone who can reach the port can drive every agent — treat the token as a
  credential, and put it behind a tunnel rather than exposing the port

## Layout

The web client mirrors the TUI rather than inventing its own shape: **collapsible
spaces and agents on the left, terminal as the main surface.** The earlier
drawer-over-a-grid arrangement had it backwards — herdr is a terminal
multiplexer, so the terminal is the product, not a popup.

The sidebar is sized as a percentage of the viewport rather than a fixed pixel
width, and is resizable by dragging its divider — matching what herdr's TUI
allows (`set_manual_sidebar_width`, clamped 18-36 columns). Percentages alone
break at extremes, so the clamp is percentage-first with pixel guardrails
(10-40%, floored at 170px and capped at 560px).

The fleet grid survives as an **overlay view** (`g`), and is what you see before
picking an agent. Dropping it entirely would have thrown away the blocked-triage
value that is the only real reason a web UI beats the TUI. When a blocked agent
is open in the terminal, its question and the reply presets appear as a bar
above the terminal instead.

## Status

### Done — scaffold verified running

- `src/server/herdr-socket.ts` — NDJSON client: `rpc`, `call`, `subscribe`
- `src/server/terminal-bridge.ts` — wraps `herdr terminal session observe|control`
- `src/server/bridge.ts` — Bun HTTP + WS, loopback, token auth, allow-list
- `src/web/` — xterm.js client, workspace tree, status dots, live attach

Verified live: `/api/health` returns herdr's pong (protocol 20); `/api/state`
returned 4 workspaces / 12 panes / 11 agents; no-token request → 401; event
subscription ACKs and delivers `pane_created`/`tab_created`/`layout_updated`.

### Next — in order

*(M1 complete; see above)*

**M1. Fleet view — DONE**
- ✅ Card grid: status stripe, agent badge, repo, branch, cwd, time-in-state
- ✅ Grouped + sorted blocked → working → idle → other; within a group,
  longest-in-state first
- ✅ `time_in_state` derived in `src/server/fleet.ts` (herdr reports current
  status, not duration — we stamp transitions ourselves)
- ✅ Filter pills with live counts + free-text search
- ✅ Click card → terminal drawer (read-only, take-control button)
- ✅ Inline reply box on blocked cards → `POST /api/reply`
- ✅ Browser notification on any → blocked transition

**M2. Triage — DONE**
- ✅ **Context preview on blocked cards** — the tail of the pane's screen, so you
  can see *what* is being asked without attaching. Server-side, fetched only for
  blocked panes and cached against the pane `revision`.
- ✅ **Triage mode** (`t`) — blocked-only full-width view, with an explicit
  "All clear" state when nothing needs you.
- ✅ **Reply presets** — yes / continue / no / explain, on the card and bound to
  `1`–`4`. Most blocked prompts are a confirmation, not an essay.
- ✅ **Keyboard-driven**: `j`/`k` cursor, `↵` open terminal, `r` focus reply,
  `/` search, `s` sound, `?` help, `esc` dismiss.
- ✅ **Sound on blocked** (WebAudio two-tone, toggleable, persisted).
- ✅ **Notification click → focus that card** (filters to blocked, moves cursor,
  scrolls into view).
- ✅ `GET /api/context?pane_id=&lines=` for on-demand screen text.
- Preferences persist in `localStorage`.

**M3. Terminal fidelity**
- Correct resize handshake (currently hardcodes 120×40 at open)
- Reconnect with scrollback replay via `pane.read source=recent`
- `observe` mode for read-only viewing so the TUI keeps input ownership
- Handle controller takeover conflicts explicitly

**M4. Session history**
- SQLite: state transitions, durations, per-repo aggregates
- "Blocked >10min" alerting
- This is data the TUI structurally cannot keep

**M5. Multi-view + mobile**
- 2×2 live terminal grid
- Responsive card layout, touch targets
- Optional: PWA so it installs on a phone

### Explicitly out of scope

- Reimplementing TUI layout/splits in the browser — the TUI is better at that
- Anything requiring changes to herdr itself
- Exposing the bridge beyond loopback without a tunnel

## Open decisions

1. **Framework.** Scaffold is vanilla ES modules — zero build step, easy to read.
   M1's card grid with sorting/filtering is where that starts to hurt. Suggest
   moving to React+Vite at M1, not before.
2. **Bridge language.** Bun/TS is fastest to iterate and matches herdr's own
   website/workers tooling. A Rust bridge could link the socket client directly
   and ship one binary — worth it only if this becomes a real distributable.
3. **Write access.** Currently `control` mode with `--takeover`, which steals
   input from the TUI. Safer default is `observe` (read-only) with an explicit
   "take control" button.
