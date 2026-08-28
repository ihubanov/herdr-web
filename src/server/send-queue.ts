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
 *  3. `send_input {text, keys:["enter"]}` does NOT submit a large paste — the
 *     Enter is absorbed into the pasted block. Long messages need text, a
 *     settle delay, then a SEPARATE send_keys(["enter"]).
 *
 * Because this queue serializes, concurrency is handled structurally: only one
 * message per pane is ever in flight, so the non-atomic two-call path is safe.
 */
import { call } from "./herdr-socket.ts";

/** Above this, use the two-call path; below, one atomic send_input. */
const PASTE_THRESHOLD = 160;
const SETTLE_MS = 900;
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

/**
 * Enqueue an attributed message. The prefix is applied HERE, from the
 * authenticated identity — never from anything the client supplied.
 */
export function say(paneId: string, author: string, text: string): QueuedMessage {
  const msg: QueuedMessage = {
    id: `m${++seq}`, paneId, author,
    text: author ? `${author}: ${text}` : text,
    queuedAt: Date.now(), state: "queued",
  };
  const q = queues.get(paneId) ?? [];
  q.push(msg);
  queues.set(paneId, q);
  emit(msg);
  void drain(paneId);
  return msg;
}

async function receptive(paneId: string): Promise<boolean> {
  try {
    const st = (await call("pane.get", { pane_id: paneId }))?.pane?.agent_status;
    // Deliberately NOT also requiring the agent to be the sole foreground
    // process: agents keep persistent node children (MCP servers, sub-agents)
    // in the group while idle, and gating on that never passes.
    return st === "idle" || st === "blocked" || st === "unknown";
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deliver(m: QueuedMessage): Promise<void> {
  if (m.text.length <= PASTE_THRESHOLD) {
    // Short: one atomic call. Safe under contention with non-queue writers.
    await call("pane.send_input", { pane_id: m.paneId, text: m.text, keys: ["enter"] });
    return;
  }
  // Long: the agent will collapse this into a paste placeholder, and an Enter
  // bundled into the same call would be swallowed by it.
  await call("pane.send_text", { pane_id: m.paneId, text: m.text });
  await sleep(SETTLE_MS);
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
      while (!(await receptive(paneId))) {
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
