/**
 * Transcript-backed chat, for agents that do NOT speak herdr-agent-stream/1.
 *
 * Claude Code writes every session to ~/.claude/projects/<slug>/<session-id>.jsonl,
 * and herdr already knows each pane's agent session id. That is enough to render
 * the conversation for ANY claude pane, not just one wired for the socket protocol.
 *
 * The records are already in SDKMessage shape — {type:"assistant", message:{role,
 * content, usage}} — so they feed the same client renderer as the live protocol,
 * carrying real usage numbers. What this CANNOT do is deliver a message: a file is
 * a record of a conversation, not a way into it. Sending stays on the pane-input
 * path, so a transcript pane is chat you can read and reply to, but the reply goes
 * in as keystrokes rather than as a protocol frame.
 */
import { readFile, stat, open } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".claude", "projects");

/** Record types that are Claude Code bookkeeping, not conversation. */
const SKIP = new Set([
  "attachment", "last-prompt", "permission-mode", "mode", "ai-title",
  "custom-title", "summary", "file-history-snapshot", "queued-command",
]);

/**
 * Locate the transcript for a session id. The project directory is derived from
 * cwd, but we do not reproduce Claude's slug rules — we scan for the file, which
 * is correct regardless of how the slug is built and survives a pane changing cwd.
 */
export async function findTranscript(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return null;   // never a path
  let dirs: string[];
  try { dirs = await readdir(ROOT); } catch { return null; }
  for (const d of dirs) {
    const p = join(ROOT, d, `${sessionId}.jsonl`);
    try { await stat(p); return p; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Read the tail of a file without loading it. Transcripts reach tens of MB, and a
 * pane opening must not pull that through memory to show the last few turns.
 */
async function readTail(path: string, maxBytes: number): Promise<{ text: string; size: number; whole: boolean }> {
  const st = await stat(path);
  const size = st.size;
  if (size <= maxBytes) return { text: await readFile(path, "utf8"), size, whole: true };
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, size - maxBytes);
    // Drop the leading partial line — it is a fragment of a record we cut through.
    const text = buf.toString("utf8");
    return { text: text.slice(text.indexOf("\n") + 1), size, whole: false };
  } finally { await fh.close(); }
}

/** One JSONL record -> the SDKMessage the client renders, or null to drop it. */
function toMessage(rec: any): any | null {
  const t = rec?.type;
  if (!t || SKIP.has(t)) return null;
  // Subagent conversations are a separate thread; folding them into the main
  // transcript interleaves two dialogues into nonsense.
  if (rec.isSidechain) return null;
  if (t === "assistant" || t === "user") {
    const m = rec.message;
    if (!m || !Array.isArray(m.content)) return null;
    return { type: t, message: m };
  }
  if (t === "system") return { type: "system", subtype: rec.subtype, model: rec.model };
  return null;
}

export interface TranscriptHandle {
  onFrame(cb: (f: any) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

/**
 * Follow a transcript: replay the tail, then poll for appended records.
 *
 * Polling rather than fs.watch — watch semantics differ across platforms and
 * filesystems, and a transcript that misses its tail is worse than one that
 * arrives 800ms late. The cost is one stat per interval per open chat pane.
 */
export function followTranscript(
  path: string,
  opts: { tailBytes?: number; intervalMs?: number; session?: string } = {},
): TranscriptHandle {
  const tailBytes = opts.tailBytes ?? 512 * 1024;
  const intervalMs = opts.intervalMs ?? 800;
  const frameCbs: Array<(f: any) => void> = [];
  const closeCbs: Array<(r: string) => void> = [];
  let offset = 0;          // byte position we have consumed up to
  let carry = "";          // partial trailing line between polls
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const emit = (f: any) => { for (const cb of frameCbs) cb(f); };

  /** Parse a chunk into renderable frames without emitting them. */
  const parseLines = (chunk: string): Array<{ msg: any; ts: number }> => {
    const lines = (carry + chunk).split("\n");
    carry = lines.pop() ?? "";
    const out: Array<{ msg: any; ts: number }> = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      const msg = toMessage(rec);
      if (!msg) continue;
      out.push({ msg, ts: Date.parse(rec.timestamp) || Date.now() });
    }
    return out;
  };

  const emitAll = (items: Array<{ msg: any; ts: number }>) => {
    for (const it of items) emit({ type: "frame", seq: ++seq, ts: it.ts, msg: it.msg });
  };

  void (async () => {
    try {
      const { text, size } = await readTail(path, tailBytes);
      const backlog = parseLines(text);
      offset = size;
      // Order matters: `ready` FIRST, then the backlog — the live protocol does
      // it that way and clients clear the transcript view on `ready`. Emitting
      // history first means the ready handler wipes everything just rendered.
      // `seq` is a HIGH-WATER MARK covering that backlog, so the client treats
      // it as history and does not start a turn clock for a finished conversation.
      emit({
        type: "ready", proto: 1, agent: "claude", session: opts.session,
        seq: backlog.length, source: "transcript",
      });
      emitAll(backlog);
    } catch (e) {
      for (const cb of closeCbs) cb(`transcript unreadable: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (stopped) return;
    timer = setInterval(async () => {
      try {
        const st = await stat(path);
        if (st.size < offset) {           // truncated/rotated — resync from the tail
          offset = 0; carry = "";
        }
        if (st.size === offset) return;
        const fh = await open(path, "r");
        try {
          const len = st.size - offset;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, offset);
          emitAll(parseLines(buf.toString("utf8")));
          offset = st.size;
        } finally { await fh.close(); }
      } catch { /* file briefly gone; try again next tick */ }
    }, intervalMs);
  })();

  return {
    onFrame(cb) { frameCbs.push(cb); },
    onClose(cb) { closeCbs.push(cb); },
    close() { stopped = true; if (timer) clearInterval(timer); },
  };
}
