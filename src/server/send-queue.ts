/**
 * Per-pane FIFO delivery queue.
 *
 * Delivering text to a TUI agent is not "call send_input and hope". Three
 * hazards, all observed live (docs/PROTOCOL.md §7):
 *
 *  1. A PTY routes input to its FOREGROUND process group. While an agent runs a
 *     tool, that group is the agent's child — the write succeeds, herdr returns
 *     ok, and the message is silently lost. So: only deliver when the agent is
 *     idle or blocked, and queue otherwise.
 *
 *  2. Long input is collapsed by the agent into a `[Pasted text #N]` placeholder.
 *     The literal text never renders, so verifying delivery by searching pane
 *     output for the message always reports failure.
 *
 *  3. `send_input {text, keys:["enter"]}` does NOT reliably submit at all. The
 *     Enter is absorbed into a pasted block above the paste threshold, and an
 *     Ink prompt with bracketed paste swallows it at ANY length. Every message
 *     goes text, settle, then a SEPARATE send_keys(["enter"]).
 *
 *     The byte is not the problem: herdr sends 0x0D for "enter" (its encoders
 *     have no LF path), which is what submits. The BUNDLING is — text and key
 *     arrive as one write, and once that chunk is flagged as a paste the
 *     trailing CR reads as content rather than as a submit.
 *
 *     THIS IS NOT A BUG AWAITING A FIX UPSTREAM, and the trade is worth knowing
 *     before anyone proposes "make a trailing CR in a paste submit". A paste
 *     that auto-submits means someone pasting a command with a trailing newline
 *     starts the turn before they can read it back. The ambiguity is resolved
 *     in favour of NOT submitting, deliberately, by the agent. Sending the CR
 *     separately is what every terminal client does anyway.
 *
 * Because this queue serializes, concurrency is handled structurally: only one
 * message per pane is ever in flight, so the non-atomic two-call path is safe.
 */
import { call } from "./herdr-socket.ts";

/** Above this the agent collapses input into a paste placeholder, which needs
 *  longer to settle before Enter will submit it. */
const PASTE_THRESHOLD = 160;
const SETTLE_MS = 900;
const SHORT_SETTLE_MS = 250;
const POLL_MS = 1500;
const MAX_WAIT_MS = 10 * 60_000;

export interface QueuedMessage {
  id: string;
  paneId: string;
  author: string;
  text: string;
  queuedAt: number;
  state: "queued" | "sending" | "sent" | "failed";
  error?: string;
}

type Listener = (m: QueuedMessage) => void;

const queues = new Map<string, QueuedMessage[]>();
const draining = new Set<string>();
let listeners: Listener[] = [];
let seq = 0;

export function onMessage(fn: Listener): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}
function emit(m: QueuedMessage) { for (const l of listeners) l(m); }

/** Drop everything still waiting for a pane. Returns how many were dropped. */
export function clearQueue(paneId: string): number {
  const q = queues.get(paneId) ?? [];
  let n = 0;
  for (const m of q) {
    if (m.state === "queued") { m.state = "failed"; m.error = "cleared by admin"; n++; emit(m); }
  }
  queues.set(paneId, q.filter((m) => m.state !== "failed"));
  return n;
}

/** Queue depth for every pane that has one, for the admin overview. */
export function allPending(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pane, q] of queues) {
    const n = q.filter((m) => m.state === "queued" || m.state === "sending").length;
    if (n) out[pane] = n;
  }
  return out;
}

/** Queue depth per pane, for the UI. */
export function pending(paneId: string): QueuedMessage[] {
  return (queues.get(paneId) ?? []).filter((m) => m.state === "queued" || m.state === "sending");
}

/** How the author travels with a message delivered as keystrokes. */
export type AttrFmt = "json1" | "prefix" | "none";

/**
 * Wrap a message so the author survives delivery.
 *
 * There is no out-of-band channel on this path: the pane receives typed
 * characters and nothing else. So attribution has to live IN the line, and the
 * only question is whether it corrupts the message.
 *
 *  json1   {"herdr":1,"author":"alice","text":"…"} — the author is its own field,
 *          the message is untouched, and a harness can unwrap it exactly. The
 *          key is "author" because herdr-agent-stream/1 already calls it that;
 *          two transports carrying the same fact should not disagree about its
 *          name. Only sent to panes that have ASKED for it, because an agent
 *          that does not understand the envelope would read JSON where a
 *          sentence should be — and note the key is for the HARNESS, not the
 *          model: unwrapped, the model never sees it, which is the point.
 *  prefix  "alice: …" — legacy. Readable by any agent, but it mangles the
 *          message: the agent cannot tell the attribution from the content, and
 *          anything that parses its own input sees a corrupted first line.
 *  none    the message verbatim, attribution dropped.
 */
function wrap(author: string, text: string, fmt: AttrFmt): string {
  if (!author || fmt === "none") return text;
  if (fmt === "json1") return JSON.stringify({ herdr: 1, author, text });
  return `${author}: ${text}`;
}

/**
 * Enqueue an attributed message. The author is applied HERE, from the
 * authenticated identity — never from anything the client supplied.
 */
export function say(
  paneId: string, author: string, text: string, fmt: AttrFmt = "prefix",
): QueuedMessage {
  const msg: QueuedMessage = {
    id: `m${++seq}`, paneId, author,
    text: wrap(author, text, fmt),
    queuedAt: Date.now(), state: "queued",
  };
  const q = queues.get(paneId) ?? [];
  q.push(msg);
  queues.set(paneId, q);
  emit(msg);
  void drain(paneId);
  return msg;
}

/**
 * Can this pane receive a queued message yet?
 *
 * Three answers, not two, and the third is why this is no longer a boolean.
 * The old version caught every error and returned false, which made "herdr
 * says this pane does not exist" indistinguishable from "herdr is briefly
 * unreachable" — so a message queued to a pane that had since closed was
 * polled every 1.5s for the full 10 minutes (~400 calls, all failing), then
 * failed with "pane never became receptive": the wrong reason, and one that
 * hid the real one.
 *
 * This loop was NOT the source of the large 2026-09-29 pane.get storm — that
 * was /api/capability resolving one pane four times per request, at a ~5.5s
 * cadence this loop's 1.5s cannot produce. But the pathology here is the same
 * and its cost is bounded only by MAX_WAIT_MS.
 */
type Receptiveness =
  | { verdict: "ready" }
  | { verdict: "wait" }
  | { verdict: "gone"; reason: string };

async function receptive(paneId: string): Promise<Receptiveness> {
  try {
    const st = (await call("pane.get", { pane_id: paneId }))?.pane?.agent_status;
    // Deliberately NOT also requiring the agent to be the sole foreground
    // process: agents keep persistent node children (MCP servers, sub-agents)
    // in the group while idle, and gating on that never passes.
    // "done" means the agent finished its turn and is sitting at the prompt —
    // the single most receptive moment there is. Omitting it queued messages to
    // a settled pane forever, which looked like a broken send button.
    const ok = st === "idle" || st === "done" || st === "blocked" || st === "unknown";
    return { verdict: ok ? "ready" : "wait" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // herdr ANSWERED — it resolved the request and reported that this id cannot
    // be looked up. That is a definitive empty-state, not a busy pane, and
    // polling cannot change it. Nor is it safe to keep waiting: pane ids are
    // positional (w5:p2), so if that id is ever re-registered it names a
    // DIFFERENT pane and the message would be typed into a stranger's prompt.
    // Fail now, with herdr's own words.
    if (/pane_not_found|invalid_request/.test(msg)) return { verdict: "gone", reason: msg };
    // A transport blip (socket closed, timeout, herdr restarting) says nothing
    // about the pane itself. Keep waiting, exactly as before.
    return { verdict: "wait" };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deliver(m: QueuedMessage): Promise<void> {
  // Text, settle, THEN Enter — at every length.
  //
  // There used to be an atomic send_input for short messages, on the reasoning
  // that one call cannot be interleaved by another writer. It does not submit in
  // every TUI: claude-local's Ink prompt with bracketed paste swallows a bundled
  // Enter at ANY length, not only above the paste threshold, and the message
  // then sits visible at the prompt forever while the pane reports idle. Nothing
  // reports an error, which is the worst shape of failure — it looks delivered.
  //
  // Separating them is what the long path already did, and it works on every
  // agent tried here. The cost is a settle window in which another writer could
  // interleave; a person typing into the same pane at the same moment was
  // already a mess, so this trades a theoretical race for a real bug.
  await call("pane.send_text", { pane_id: m.paneId, text: m.text });
  // A short line needs only the terminal's own round trip; a long one is
  // collapsed into a paste placeholder first, which takes longer to settle.
  await sleep(m.text.length <= PASTE_THRESHOLD ? SHORT_SETTLE_MS : SETTLE_MS);
  await call("pane.send_keys", { pane_id: m.paneId, keys: ["enter"] });
}

async function drain(paneId: string): Promise<void> {
  if (draining.has(paneId)) return;
  draining.add(paneId);
  try {
    for (;;) {
      const q = queues.get(paneId) ?? [];
      const next = q.find((m) => m.state === "queued");
      if (!next) return;

      // Wait for the pane to be able to receive.
      const deadline = Date.now() + MAX_WAIT_MS;
      for (;;) {
        const r = await receptive(paneId);
        if (r.verdict === "ready") break;
        if (r.verdict === "gone") {
          // No timeout to serve: the answer is already final, so report why.
          next.state = "failed";
          next.error = r.reason;
          emit(next);
          break;
        }
        if (Date.now() > deadline) {
          next.state = "failed";
          next.error = "pane never became receptive";
          emit(next);
          break;
        }
        await sleep(POLL_MS);
      }
      if (next.state === "failed") continue;

      next.state = "sending";
      emit(next);
      try {
        await deliver(next);
        next.state = "sent";
      } catch (err: any) {
        next.state = "failed";
        next.error = err?.message ?? String(err);
      }
      emit(next);

      // Let the agent pick it up before considering the next message, so two
      // queued messages don't land as one turn.
      await sleep(1200);

      const keep = (queues.get(paneId) ?? []).filter(
        (m) => m.state === "queued" || m.state === "sending" ||
               Date.now() - m.queuedAt < 60_000);
      queues.set(paneId, keep);
    }
  } finally {
    draining.delete(paneId);
  }
}
