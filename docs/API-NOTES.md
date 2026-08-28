# herdr socket API — recon notes

Verified live against **herdr 0.8.2, protocol 20** on 2026-08-24.

## Transport

- Unix domain socket: `~/.config/herdr/herdr.sock` (env `HERDR_SOCKET_PATH`)
- **Newline-delimited JSON.** Request = one JSON object + `\n`; response = one JSON object + `\n`.
- No TCP listener exists anywhere in the herdr binary. Any web UI must add its
  own loopback port — that is a new network surface herdr itself does not have.

Request:  `{"id":"x","method":"pane.list","params":{}}`
Response: `{"id":"x","result":{"type":"pane_list","panes":[...]}}`
Error:    `{"id":"x","error":{"code":"invalid_request","message":"..."}}`

## Surface: 91 methods

| Namespace | n | Notes |
|---|---|---|
| `pane.*` | 30 | read, split, resize, send_input/keys/text, zoom, graphics, agent reporting |
| `agent.*` | 12 | list, get, prompt, read, wait, start, explain, send_keys |
| `plugin.*` | 11 | list/enable/disable/link, action.invoke, pane.open |
| `workspace.*` | 9 | CRUD, focus, move, move_block, report_metadata |
| `tab.*` | 7 | CRUD, focus, move |
| `server.*` | 5 | stop, reload_config, agent_manifests, live_handoff |
| `worktree.*` | 4 | create, list, open, remove — git worktree integration |
| `layout.*` | 3 | apply, export, set_split_ratio |
| `events.*` | 2 | subscribe, wait |
| others | 8 | ping, session.snapshot, notification.show, integration.*, client.*, popup.close |

## Events

`events.subscribe` takes an array of `{"type": "..."}`. First response line is the
ack `{"result":{"type":"subscription_started"}}`; subsequent lines are events.

**27 subscribable types.** Most take no params. Three take filters:

- `pane.output_matched` — `pane_id`, `match` (`{type:"substring"|"regex", value}`), `source`, `lines`, `strip_ansi`
- `pane.agent_status_changed` — `pane_id`, `agent_status`
- `pane.scroll_changed` — `pane_id`

Lifecycle types: `workspace.{created,updated,metadata_updated,renamed,moved,reordered,closed,focused}`,
`worktree.{created,opened,removed}`, `tab.{created,closed,focused,renamed,moved}`,
`pane.{created,closed,updated,focused,moved,exited,agent_detected}`, `layout.updated`.

⚠️ Subscription names use **dots** (`pane.created`); emitted event names use
**underscores** (`pane_created`). Easy to get wrong.

## Terminal content — two mechanisms

**1. Poll — `pane.read`**
```json
{"pane_id":"w1:p6","source":"visible","format":"ansi","strip_ansi":false,"lines":40}
```
- `source`: `visible` | `recent` | `recent_unwrapped` | `detection`
- `format`: `text` | `ansi`
- Response nests under `read`: `{pane_id, workspace_id, tab_id, source, format, text, revision, truncated}`
- ANSI output carries **24-bit truecolor** SGR (`\x1b[38;2;R;G;Bm`) — xterm.js renders it directly.

**2. Stream — the documented third-party bridge** ← use this for a web UI
```bash
herdr terminal session observe <pane> --cols N --rows M   # read-only, multiple allowed
herdr terminal session control <pane> --cols N --rows M   # read/write, one owner
```
Emits NDJSON `terminal.frame` records with **base64 ANSI** in `bytes`, then
`terminal.closed`. `control` reads NDJSON commands on stdin:
`terminal.input` (`text` or `bytes`), `terminal.resize`, `terminal.scroll`, `terminal.release`.

The docs explicitly frame `observe` as *"for third-party bridges that only need
rendered terminal bytes."* A web UI is an anticipated consumer.

## Object shapes (live)

**Pane**
```json
{"pane_id":"w1:p6","terminal_id":"term_...","workspace_id":"w1","tab_id":"w1:t6",
 "focused":false,"cwd":"...","foreground_cwd":"...","agent":"claude",
 "terminal_title":"✳ api-refactor","terminal_title_stripped":"api-refactor",
 "agent_status":"idle",
 "scroll":{"offset_from_bottom":0,"max_offset_from_bottom":0,"viewport_rows":44},
 "revision":2}
```

**Agent** — adds `state_change_seq`, drops `scroll`.

**Workspace**
```json
{"workspace_id":"w1","number":1,"label":"Backend","focused":true,
 "pane_count":5,"tab_count":4,"active_tab_id":"w1:tA","agent_status":"idle"}
```

## Agent state model

`src/detect/mod.rs`: **`idle` | `working` | `blocked` | `unknown`**
(docs also surface `done` at the CLI layer).

Two authority sources:
- **Screen detection** — manifests in `src/detect/manifests/*.toml`, matched against
  the bottom buffer. Always available, inherently heuristic.
- **Hook/plugin reports** — `pane.report_agent` with a stable `--source`. For
  *lifecycle-authority* agents (Pi, OMP, Kimi, OpenCode, Kilo, MastraCode) hooks
  fully author state. For *session-identity* agents (Claude Code, Codex, Copilot,
  Devin, Droid, Qoder, Qwen, Cursor, Hermes, Antigravity, Grok) the hook reports
  session refs for restore; **state still comes from screen detection**.

`revision` and `state_change_seq` are monotonic — use them to drop stale updates.

## Gotchas found the hard way

- `herdr api` CLI only exposes `snapshot` and `schema`. There is no `api request`
  subcommand — talk to the socket directly.
- Subscribing with a wrong type name returns an error on the **ack line**, and the
  connection then yields nothing. Always check the first line.
- `pane.read` returns `{result:{read:{...}}}`, not `{result:{text}}`.
- Agents that are idle emit no events. An empty stream is not a broken stream.
