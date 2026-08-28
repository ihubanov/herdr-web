# herdr-web

Local web UI for [herdr](https://herdr.dev), built on its socket API.

herdr is terminal-only and opens no network port. This adds a loopback bridge
(`127.0.0.1` + token) and a browser client that talks to the herdr server over
its Unix socket.

## Multi-user

Set named users (a comma-separated list of name:token pairs):

```bash
bun run gen-tokens alice bob     # writes .env.local (0600, gitignored)
./start.sh                         # prints each person's URL
```

Accounts are for **humans only** — the agent answering in a pane is not a user.

Each person gets `http://127.0.0.1:7878/?token=<their token>`. `HERDR_WEB_TOKEN`
keeps working alongside as an unnamed admin.

Open a pane and everyone connected to it sees each other in the roster and can
message the agent from the composer. **Attribution is applied server-side from
the authenticated token** — a client cannot claim to be someone else by putting
an `author` in the request body.

Messages are queued per pane and delivered one at a time, only when the agent
can actually receive them (see `docs/PROTOCOL.md` §7 for why that is not
trivial).

### Admin

`HERDR_WEB_TOKEN` is the admin account. It is attributed in chat like anyone
else (`admin: …`) — an anonymous voice in a shared conversation is confusing,
not a privilege. What it actually gets is a moderation surface; everyone else
receives `403`:

| Endpoint | Effect |
|---|---|
| `GET /api/admin/overview` | live connections, presence, queue depths |
| `POST /api/admin/release-control` | force-drop whoever holds a pane's terminal |
| `POST /api/admin/clear-queue` | drop messages jammed behind a busy agent |
| `POST /api/admin/disconnect` | kick a user's live connections |

## Install as a herdr plugin

```bash
herdr plugin link /path/to/herdr-web      # local development
herdr plugin pane open --plugin herdr-web --entrypoint server
herdr plugin action invoke herdr-web.url  # print everyone's URL
```

The server runs as a **pane**, not a startup hook: herdr supervises pane
processes, shows their output, and restores the pane with the session. herdr's
own docs describe startup hooks as one-shot initialisation rather than
supervised daemons, and a hook that forked a server would leave it unsupervised
— the exact orphan pattern this project had to debug elsewhere.

Config lives in `HERDR_PLUGIN_CONFIG_DIR`, not the plugin root, because a
GitHub-installed root is a managed checkout that reinstall replaces. An admin
token is minted on first run, so the plugin works with no setup.

```bash
herdr plugin action invoke herdr-web.rotate-tokens -- alice bob
```

Mints fresh tokens for the named users. Every outstanding URL stops working,
which makes this the revoke path as well as the setup path.

## Run standalone



```bash
bun install
bun start
```

Prints a URL with a one-time token. Set `HERDR_WEB_TOKEN` to pin it and
`HERDR_WEB_PORT` (default 7878) to change the port.

Requires a running herdr server (`herdr status` should show it live).

## What it does

Layout mirrors the TUI: **collapsible spaces/agents on the left, terminal as the
main window.**

- **Sidebar** — workspaces as collapsible groups, agents with live status dots
  and time-in-state. **Drag the divider to resize** (double-click to reset);
  width is a percentage of the viewport with pixel guardrails, and both the
  width and the per-space collapse state persist. `b` hides it entirely.
- **Terminal** — the main surface. Read-only by default, explicit *take control*.
- **Fleet view** (`g`) — every pane as a card: agent, repo, branch, path, and how
  long it has been in its current state. Shown before you pick an agent.
- **Blocked-first triage** — cards group and sort by who needs a human, longest
  wait first. Filter pills and free-text search.
- **Inline reply** — answer a blocked agent from its card without attaching.
- **Terminal drawer** — click any card for a live xterm view. Read-only by
  default; explicit *take control* when you want to type.
- **Context preview** — blocked cards show the tail of the agent's screen, so you
  can see what it is asking without attaching.
- **Triage mode** (`t`) — blocked-only view, keyboard driven.
- **Presets** — yes / continue / no / explain, bound to `1`–`4`.
- **Alerting** — sound + desktop notification on blocked; clicking the toast
  jumps to that card.
- **Live** — pushes over a websocket; no polling in the browser.

The browser tab title tracks state: `(2) alice · api-refactor` —
blocked count, who you are signed in as, and what the tab is showing. Blocked
count leads because tabs truncate from the right.

### Managing spaces and sessions

`+▣` in the sidebar header creates a space; `+` on a space header creates a
session in it; `✎` renames. Keyboard: `n` new session, `N` new space.

**Creating is open to everyone; closing is admin-only.** In a shared UI, one
person closing another's running session is not recoverable, so `pane.close`,
`tab.close`, `workspace.close` and `worktree.remove` require the admin token.
Non-admins do not see the `✕` buttons at all, and the API returns 403 with
`adminOnly: true` if called directly.

### One input: the terminal

There is no composer. You type in the terminal and **the bridge** injects your
name at the start of each line, so the agent receives `bob: do the thing` and
every other viewer sees who said it.

Attribution is applied server-side, at **submit** time. On Enter the bridge
jumps to the start of the line, inserts `<user>: `, jumps back to the end, and
only then submits — so you never see the prefix sitting in your input and cannot
backspace it away, while the agent still receives an attributed line. The prefix
comes from the authenticated identity on that connection, so a client cannot
type as someone else.

A `typing as <you>` badge sits in the control bar. It is deliberately not in or
beside the terminal: anything there costs columns, and the terminal is the
product.

**Per-message badges are not possible in this view.** Once submitted, `bob: ` is
ordinary text in the agent's own rendering — the bridge receives a grid of
characters, not a list of messages, so it cannot attach a badge to one. That is
what the chat view below is for.

## Conformance

`tools/handshake.ts` points this repo's client at another party's
implementation of the protocol and reports per spec item — discovery, socket
hygiene, `ready` as high-water, replay ordering, `say` attribution, concurrent
subscribers, `from_seq` honouring, HITL and interrupt.

```bash
bun tools/handshake.ts <pane_id>       # discovery via pane.get
bun tools/handshake.ts --sock <path>   # direct, skips discovery
```

`tools/mock-agent.ts` is the reference implementation it is validated against.

## Chat view

For agents that implement [`herdr-agent-stream/1`](docs/PROTOCOL.md), a **chat
view** button appears in the control bar. It renders the session as a
conversation instead of a terminal:

- every message carries a real badge — `bob` for you, `Alice(AI)` for the agent
- thinking, tool calls and tool results render as distinct blocks
- permission prompts get allow/deny buttons; `AskUserQuestion` gets its options
  as buttons, and resolution dismisses the prompt for every viewer
- a composer at the bottom, because there is no terminal to type into

The capability is probed with a single `pane.get` when you open a pane
(`pane.list` does not carry metadata tokens, so sweeping every pane on every
refresh would cost N extra round trips). Panes without it simply do not show the
button.

Typing also claims control implicitly. A terminal has exactly one writer (herdr
enforces it), so requiring a click first was ceremony; the first keystroke takes
control and the status line says so.

When the agent is blocked, its question and the preset replies appear **above**
the terminal, next to the thing you are answering. A thin strip below shows who
else is watching and any queued messages.

### Naming the agent

```bash
HERDR_WEB_AGENT_NAME=Alice
```

Brands the header and adds the agent to the roster as `Alice(AI)`, so a shared
transcript reads as a conversation between named parties rather than `alice: …`
followed by an anonymous reply. The `(AI)` marker is not optional: in a roster of
names, `bob Alice` gives no clue which participant is a person.

Purely presentational — the agent's own output is its to render, and the bridge
does not rewrite it.

### Scrolling

There is no client-side scrollback — the stream carries the pane's *current*
rendered viewport, not its history, so scrolling happens server-side and
**requires control mode**. In read-only the wheel reports
`take control to scroll` rather than silently doing nothing.

Two cases behave differently, by nature rather than by choice:

| Pane | herdr scrollback | Scrolled by |
|---|---|---|
| shell-like | yes (`scroll.max_offset_from_bottom > 0`) | `terminal.scroll` |
| alt-screen agent (Claude Code &c) | none — always `0` | the app itself, via mouse input |

For alt-screen agents the wheel is forwarded to the application as mouse input
by xterm, so its own scrolling works; herdr has no scrollback to move.

### Shortcuts

`b` sidebar · `g` fleet ⇄ terminal · `t` triage · `j`/`k` move · `↵` open ·
`r` reply · `1`–`4` preset · `/` filter · `s` sound · `?` help · `esc` dismiss

## Layout

```
src/server/herdr-socket.ts    NDJSON client for ~/.config/herdr/herdr.sock
src/server/fleet.ts           resident fleet tracker + time-in-state
src/server/terminal-bridge.ts wraps `herdr terminal session observe|control`
src/server/bridge.ts          Bun HTTP + WebSocket, loopback + token + allow-list
src/web/                      xterm.js frontend
docs/API-NOTES.md             socket API recon (91 methods, 27 events, shapes)
docs/PLAN.md                  architecture, roadmap, open decisions
```

## Security

Anyone who reaches this port can drive every agent in your session. It binds
loopback only and requires a token; do not expose it directly — use an SSH
tunnel or Tailscale. The RPC proxy is allow-listed by method, and destructive
methods (`server.stop`, `pane.close`, ...) are denied.

## Relationship to herdr

Independent project. herdr-web is a client of herdr's documented socket API and
vendors no herdr code; it is not affiliated with the herdr project.
