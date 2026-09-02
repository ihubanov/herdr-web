# herdr-agent-stream/1

A protocol by which an agent running inside a herdr pane exposes a structured
event stream, so a client (herdr-web) can render message-level chat instead of
terminal bytes.

**Not agent-specific.** Any agent that can emit Claude Code's `stream-json`
format can implement this.

Status: **v1, end-to-end verified against an independent implementation.** A
reference implementation lives at
`tools/mock-agent.ts`; the client is `src/server/agent-stream.ts`.

Verified run (herdr 0.8.2 / protocol 20):

```
1. detect -> {proto:1, sock:"$XDG_RUNTIME_DIR/<agent>/mock-…sock",
              fmt:"stream-json", session:"mock-…"}
2. ready  -> {seq:2, replay:true}          replayed 2 seeded frames
3. say("alice","please re-run the migration") -> accepted
4. frames:  1:system/init  2:assistant/text  3:user/text(alice)
            4:assistant/thinking  5:assistant/tool_use
            6:user/tool_result    7:assistant/text
5. second subscriber, from_seq=0        -> replayed all 7
6. third subscriber, from_seq=lastSeq-2 -> replayed only 2
7. participants frame observed
```

That covers every property the design depends on: capability discovery through
pane metadata, multi-subscriber fan-out, gapless `seq`, full **and** incremental
replay, attributed user frames, and the three renderable block kinds
(`thinking`, `tool_use`, `tool_result`).

---

## 1. Discovery

The agent advertises the stream through herdr's own pane metadata. No registry,
no config file, no port allocation.

```bash
"$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" \
  --source <agent-id> \
  --token stream_proto=1 \
  --token stream_sock=$XDG_RUNTIME_DIR/<agent>/<session>.sock \
  --token stream_fmt=stream-json \
  --ttl-ms 120000
```

The client reads it back with `pane.get` → `pane.tokens`.

### Tokens

| Token | Required | Value |
|---|---|---|
| `stream_proto` | yes | protocol major version, `"1"` |
| `stream_sock` | yes | absolute path to a listening AF_UNIX SOCK_STREAM socket |
| `stream_fmt` | yes | `"stream-json"` |
| `stream_session` | no | agent's own session id, when it has one |

Constraints inherited from herdr: ≤16 tokens per source, key must match
`^[A-Za-z0-9_-]{1,32}$`, `ttl_ms` ≤ 86_400_000.

### ⚠ TTL proves the process lives, not that it still owns the pane

Observed in the first cross-implementation handshake: an agent was launched with
`HERDR_PANE_ID=w5:p6`, its pane's shell later died, the agent was reparented to
init (ppid 1) — and it kept running, kept listening on its socket, and kept
refreshing its advertisement against a pane that by then ran a plain shell. A
client discovering through `pane.get` connected happily to a session that was no
longer in that pane, and whose engine could no longer complete a turn.

The TTL guards against a *dead* agent. It does not guard against a *live but
detached* one. An agent **must** therefore re-check, on each refresh, that the
pane it advertises still exists, and stop advertising (and shut down) when it
does not.

⚠ **Do not use a change of parent pid as the signal.** It looks like a cheap
orphan check and it is wrong: any deliberately detached or daemonised launch
reparents immediately, so the agent kills itself the moment it starts. This was
observed — an implementation added ppid-change detection to fix the stale-pointer
bug above, and its own detached test sessions then exited on their first refresh.

What to check instead, in order of strictness:

1. **The pane still exists** — `pane.get` on `HERDR_PANE_ID` succeeds. Cheap,
   correct for every launch style, and catches the case that matters (the pane
   went away).
2. **This process still occupies it** — its own pid appears in that pane's
   process tree (`pane.process_info`). Strictly correct, but only valid for an
   agent actually launched *in* the pane; a detached process advertising on a
   pane it does not occupy will fail it, which may be intentional in testing.

An agent that advertises on a pane it does not occupy is making a claim it
cannot honour, and clients are entitled to reject it.

### TTL is the liveness signal

The agent **must re-report before the TTL expires** (suggested: `ttl_ms=120000`,
refresh every 45s). If the agent dies, the advertisement expires on its own and
the client falls back to terminal rendering. There is no unregister step and no
stale-socket problem.

### Client duties

Before connecting, the client **must**:
1. `lstat` the path and confirm it is a socket;
2. confirm the socket's owner uid equals the client's own uid;
3. refuse paths that are symlinks.

A pane is only *claimed* to support the protocol if `stream_proto` is a version
the client understands. Unknown major version → treat as unsupported, use the
terminal.

---

## 2. Transport

AF_UNIX, SOCK_STREAM. **Newline-delimited JSON in both directions** — the same
idiom as herdr's own socket API.

Socket file mode **must** be `0600`. The agent creates it under a directory it
owns; `$XDG_RUNTIME_DIR` is the recommended parent.

One connection = one subscriber. The agent must support **many concurrent
subscribers** on the same socket (every viewer of a shared session opens one).

---

## 3. Client → agent

### `hello` — first frame, required

```jsonc
{"type":"hello","proto":1,"client":"herdr-web/0.1","from_seq":0}
```

`from_seq` requests replay: send every buffered frame with `seq > from_seq`,
then continue live. `0` means "everything you still hold". Omit for live-only.

### `say` — submit an attributed message

```jsonc
{"type":"say","author":"alice","text":"can you re-run the migration?"}
```

`author` is **advisory**. The agent must not trust it for anything
security-relevant; herdr-web has already authenticated the user and is the
authority. It exists so the agent can render/store attribution without the
client having to smuggle it inside `text`.

Clients that cannot use `say` (or agents that do not implement it) fall back to
`pane.send_input` on herdr's API, which needs no controller and is atomic —
see §6.

### `ping`

```jsonc
{"type":"ping"}
```
Agent replies `{"type":"pong"}`. Used for liveness; the client may close a
connection that fails to pong.

### Correlating a rejection: `id` on client frames

Any client→agent frame MAY carry a client-generated `id`. The agent echoes it as
`ref` on any `error` it raises for that frame. Without it a client that has sent
several `say`s cannot tell which one was refused.

```jsonc
{"type":"say","id":"c17","author":"alice","text":"…"}
```


---

## 3b. Human-in-the-loop: permission and question

Two structured round-trips. They are kept **separate** because their UIs differ
(an allow/deny button vs a radio/checkbox menu) and their reply shapes differ.

Both follow the same three-frame pattern:

```
agent → client   *_request    seq'd, buffered, replayable
client → agent   *_reply      not seq'd; advisory author
agent → client   *_resolved   seq'd — dismisses the prompt for EVERY viewer
```

**Requests and resolutions are seq'd and buffered like `frame`.** This is the
whole point: a viewer who joins or reconnects mid-prompt replays the pending
request via `from_seq` and can answer it. Resolution frames are how a prompt is
dismissed across all viewers, including the one who did not answer it.

### permission — out-of-sandbox mutation approval

```jsonc
// agent → client
{"type":"permission_request","seq":1842,"ts":1756…,"request_id":"p_7f3",
 "tool":"Bash","input":{"command":"rm -rf build/"},
 "reason":"writes outside the sandbox","timeout_ms":120000}

// client → agent
{"type":"permission_reply","request_id":"p_7f3","decision":"allow","author":"alice"}

// agent → client
{"type":"permission_resolved","seq":1846,"request_id":"p_7f3",
 "decision":"deny","by":"timeout"}
```

`decision` is `allow` | `deny` in v1. **Clients must tolerate unknown decision
strings** (treat as deny and render the literal) so `allow_always` and friends
can be added without a major bump.

### question — structured multi-choice (AskUserQuestion)

```jsonc
// agent → client
{"type":"question_request","seq":1901,"ts":1756…,"request_id":"q_2b1",
 "timeout_ms":300000,
 "questions":[
   {"id":"q1","question":"Which database?","header":"Storage","multiSelect":false,
    "options":[{"label":"Postgres","description":"…","preview":"…"},
               {"label":"SQLite","description":"…"}]}]}

// client → agent
{"type":"question_reply","request_id":"q_2b1","declined":false,"author":"alice",
 "answers":{"q1":["Postgres"]}}

// agent → client
{"type":"question_resolved","seq":1904,"request_id":"q_2b1","by":"alice"}
```

Two deliberate departures from the shape an SSE chat API would use:

**`answers` is keyed by a per-question `id`, not by the question text.** Question
text is long, may repeat between questions, and may contain any character — it
is a display string, not a key. Agents synthesize a stable `id` per question
(`q1`, `q2`, …); the text stays in `question` for rendering.

**Answer values are always arrays**, even for single-select. Comma-joining
multi-select answers is ambiguous the moment a label contains a comma, and
labels are author-supplied prose. `["Postgres"]` and `["a, b","c"]` are both
unambiguous; `"a, b, c"` is not.

### Rules

- **First reply wins.** The agent resolves a `request_id` exactly once. Replies
  arriving after resolution are ignored — not an error, since two people can
  legitimately click at the same moment. Losers learn the outcome from
  `*_resolved.by`.
- **Timeout is agent-side.** The agent owns the clock and emits
  `*_resolved{by:"timeout"}`. Clients must not run their own timer and must not
  synthesize a decision. `timeout_ms` is advisory, for rendering a countdown.
- **Replay may deliver an already-resolved request.** A client replaying from
  `from_seq` receives the request and then its resolution; it must apply them in
  order and not leave a dismissed prompt on screen.
- **`author` is advisory**, exactly as on `say`. The client authenticates the
  human and is the authority; the agent uses it for display and audit only.
- **Optionally**, `ready` may carry `pending: ["p_7f3"]` so a joining client can
  render outstanding prompts without a full replay. Clients must not depend on it.

### interrupt

```jsonc
{"type":"interrupt","author":"alice"}
```

Client → agent, aborts the in-flight turn. **Included in v1** rather than
deferred: the terminal fallback covers it only while a terminal is on screen,
and the point of the chat view is that it need not be.

---

## 4. Agent → client

### `ready` — first frame the agent sends

```jsonc
{"type":"ready","proto":1,"agent":"<agent-id>","session":"<id>",
 "seq":1841,"replay":true,"participants":["alice","alice"]}
```

`seq` here is a **high-water mark** — the highest sequence number the agent
still holds — *not* this frame's position in the stream. `replay` says whether
frames before it are still available.

⚠ **`ready.seq` must not advance a client's replay cursor.** A client that
treats every frame carrying `seq` as a stream frame will set its cursor to the
newest value before replay begins, and then silently discard the entire replay
as already-seen. Ask the reference client how it knows this
(`src/server/agent-stream.ts`).

### `frame` — the payload

```jsonc
{"type":"frame","seq":1842,"ts":1756...,"author":"alice","msg":{ /* SDKMessage */ }}
```

- `seq` — **monotonically increasing, gapless per connection**. This is what
  makes reconnect-and-replay work; it is the contract `turnHub` already
  satisfies internally.
- `msg` — one whole `SDKMessage`, exactly as `--output-format stream-json`
  emits. Not a token delta unless the SDKMessage itself is a `stream_event`.
- `author` — present on user-originated frames when known.

#### Turn boundaries and cost

Clients that show a live turn indicator ("working, 5m 11s, 5.7k tokens") need
two things from the stream. Both are optional; a client must render sensibly
without either.

- **Usage.** Put `usage` on the assistant message exactly where the Anthropic
  API does — `msg.message.usage` with `input_tokens` / `output_tokens`. A turn
  spanning several API calls reports usage per call; clients sum them.
- **A closing `result`.** Emit `{"type":"result","subtype":"success",
  "duration_ms":…,"usage":{…}}` when a turn finishes. Without it a client
  cannot tell "still thinking" from "done and quiet", and must fall back to
  the pane's `agent_status` — which is coarser and lags.

Agents that report neither still work; the client just shows elapsed time, or
no indicator at all.

### `participants` — presence changed

```jsonc
{"type":"participants","list":["alice","alice","bob"]}
```

Advisory. herdr-web maintains its own roster from authenticated connections;
this is for agents that also know about non-herdr participants.

### `error` — the agent refused something

```jsonc
{"type":"error","code":"busy","ref":"c17",
 "message":"a turn is already running"}
```

Not seq'd: it concerns one client's frame, not the shared conversation.

`code` is an open string; `busy` is the one v1 defines. Clients MUST tolerate
unknown codes and surface them rather than failing.

**An agent must not silently drop a client frame it cannot act on.** Observed in
the first cross-implementation handshake: an implementation applied
first-`say`-wins while a turn ran, discarding later `say`s with no response. From
the client the transport looked healthy and the agent looked hung — the two are
indistinguishable without a reply, and that ambiguity cost an hour of misdiagnosis.

**An agent should refuse rather than queue.** Queuing inside the agent hides
ordering and latency from the only party that can do anything sensible about
them. A client knows whether to retry, drop, show "agent busy", or hold in its
own queue — herdr-web already serialises through a per-pane queue for the
terminal path, and applies the same pattern here.

### `bye`

```jsonc
{"type":"bye","reason":"session ended"}
```

---

## 5. Versioning

`stream_proto` carries the **major** version only. A client that understands
major `1` must tolerate unknown frame `type` values and unknown object keys
(ignore them). Breaking changes bump the major and get a new token value.

---

## 6. What this does NOT replace

The terminal remains the source of truth. This protocol is a **projection** of
a session, not a substitute for it:

- Input still works via `pane.send_input` for every agent, protocol or not.
- `terminal session observe` still streams raw bytes to any number of viewers.
- `terminal session control` remains exclusive, single-writer, unchanged.

A client should always be able to fall back to the terminal, and should offer it
as a view even when the stream is available.

---

## 7. Reference: the fallback path (no protocol)

Verified live against herdr 0.8.2:

- **Many readers** — `terminal session observe` is explicitly multi-observer.
- **Many writers** — `pane.send_input {pane_id, text, keys:["enter"]}` requires
  no controller and no ownership.
- **Atomicity** — `send_input` is one call and is safe under concurrency.
  `send_text` followed by a separate `send_keys` is **two** calls and interleaves
  under concurrent senders. Never use the two-call form for multi-writer input.

### ⚠ Delivering text to a TUI agent is not as simple as `send_input`

Three hazards, all observed directly against a live `claude` pane. Any client
using the fallback path has to handle them.

**1. Foreground process group.** A PTY delivers input to its foreground process
group. While an agent runs a tool, that group belongs to the agent's *child*.
Input then lands in the child's stdin: herdr returns `ok`, the write genuinely
succeeded, and the message is lost. Gate on `agent_status ∈ {idle, blocked}`.

*Do not* additionally require the agent to be the only foreground process —
agents keep persistent `node` children (MCP servers, sub-agents) in the group
while perfectly idle. A gate of `foreground_processes == [agent]` never passes
and silently blocks delivery forever.

**2. Long input becomes a paste placeholder.** A TUI agent collapses large input
into `[Pasted text #N]` in its composer. The literal text is *never rendered*.
Verifying delivery by searching pane output for a substring of the message will
therefore always report failure, even on success.

**3. `send_input {text, keys:["enter"]}` does not submit a large paste.** The
Enter is absorbed into the pasted block as a newline rather than acting as
submit. Send the text, wait for the composer to settle, then send `enter` as a
**separate** `pane.send_keys` call.

Note this directly conflicts with the atomicity advice above: `send_input` is
the right call for short concurrent messages, and the two-call form is required
for long ones. A client must choose per message size, and serialize through a
per-pane queue either way.

**Verify by state transition, not by content.** The reliable signal that a
message was accepted is `agent_status` moving to `working` and the composer
returning to empty.

**This is the strongest argument for the protocol.** `say` over the stream
socket goes to the agent process directly and is unaffected by which process
owns the PTY foreground group. Agents implementing herdr-agent-stream/1 should
prefer it, and clients should prefer it whenever `stream_proto` is advertised.

---

## 8. Implementation checklist

- [ ] on startup, if `HERDR_ENV=1` and `HERDR_PANE_ID` is set, create
      `$XDG_RUNTIME_DIR/<agent>/<session>.sock` (mode 0600)
- [ ] advertise via `pane report-metadata`, refresh every ~45s with `ttl_ms=120000`
- [ ] accept many concurrent connections; per connection: read `hello`, send
      `ready`, then replay from `from_seq` and continue live
- [ ] serve existing `turnHub` frames as `frame`; `turnHub`'s monotonic ids
      already satisfy the `seq` contract
- [ ] implement `say` by feeding the existing turn path, preserving the
      per-session mutex in `turnSemaphore`
- [ ] HITL: `permission_request` / `question_request` (seq'd + buffered),
      `permission_reply` / `question_reply`, and the two `*_resolved` emits
- [ ] agent-side timeout emitting `*_resolved{by:"timeout"}`
- [ ] `interrupt`
- [ ] `bye` + socket unlink on shutdown
- [ ] if the agent already exposes another interface, run **alongside** it;
      retire that one only once this path has replaced it at every call site
