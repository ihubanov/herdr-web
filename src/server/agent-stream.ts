/**
 * Client for herdr-agent-stream/1 (docs/PROTOCOL.md).
 *
 * Detects whether a pane's agent advertises a structured stream, and if so
 * connects to it. Panes without the capability are unaffected — the caller
 * falls back to the terminal.
 */
import { connect, type Socket } from "node:net";
import { lstatSync } from "node:fs";
import { call } from "./herdr-socket.ts";

export interface StreamCapability {
  proto: number;
  sock: string;
  fmt: string;
  session?: string;
}

/** Reads a pane's advertised capability, or null. Never throws. */
export async function detect(paneId: string): Promise<StreamCapability | null> {
  let tokens: Record<string, string> | undefined;
  try {
    const res = await call("pane.get", { pane_id: paneId });
    tokens = res?.pane?.tokens;
  } catch {
    return null;
  }
  if (!tokens?.stream_proto || !tokens.stream_sock) return null;

  const proto = Number(tokens.stream_proto);
  // Unknown major version -> treat as unsupported (PROTOCOL.md §5).
  if (!Number.isInteger(proto) || proto !== 1) return null;
  if (tokens.stream_fmt && tokens.stream_fmt !== "stream-json") return null;
  if (!safeSocket(tokens.stream_sock)) return null;

  return { proto, sock: tokens.stream_sock, fmt: tokens.stream_fmt || "stream-json",
           session: tokens.stream_session };
}

/**
 * PROTOCOL.md §1 client duties: the path must be a socket, owned by us, and
 * not a symlink. An agent advertises this path, so it is attacker-influenced
 * if the agent is compromised — check before connecting.
 */
function safeSocket(path: string): boolean {
  try {
    const st = lstatSync(path);            // lstat: does not follow symlinks
    if (st.isSymbolicLink()) return false;
    if (!st.isSocket()) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

export interface StreamHandle {
  onFrame: (cb: (frame: any) => void) => void;
  onClose: (cb: (reason: string) => void) => void;
  /** Submit an attributed message. `author` is advisory to the agent.
   *  Returns the client-generated frame id, echoed as `ref` on any error the
   *  agent raises for it (PROTOCOL.md §3), or null if the socket is closed. */
  say: (author: string, text: string) => string | null;
  /** Answer a permission_request (PROTOCOL.md §3b). */
  permissionReply: (requestId: string, decision: "allow" | "deny", author: string) => boolean;
  /** Answer a question_request. `answers` is id -> label[], always arrays. */
  questionReply: (
    requestId: string,
    answers: Record<string, string[]>,
    author: string,
    declined?: boolean,
  ) => boolean;
  /** Abort the in-flight turn. */
  interrupt: (author: string) => boolean;
  close: () => void;
  /** Highest seq seen, for reconnect-with-replay. */
  lastSeq: () => number;
}

export function open(
  cap: StreamCapability,
  opts: { fromSeq?: number; client?: string } = {},
): StreamHandle {
  const sock: Socket = connect(cap.sock);
  const frameCbs: Array<(f: any) => void> = [];
  const closeCbs: Array<(r: string) => void> = [];
  let buf = "";
  let seen = opts.fromSeq ?? 0;
  let closed = false;

  const fireClose = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb(reason);
  };

  sock.on("connect", () => {
    sock.write(JSON.stringify({
      type: "hello", proto: 1,
      client: opts.client || "herdr-web",
      from_seq: opts.fromSeq ?? 0,
    }) + "\n");
  });

  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }

      // Every seq'd STREAM frame advances the replay cursor, not just `frame`:
      // permission_request/question_request and their *_resolved partners are
      // seq'd too (PROTOCOL.md §3b), and a client ignoring their seq would
      // re-request them on every reconnect.
      //
      // `ready` is excluded on purpose. Its `seq` is a HIGH-WATER MARK (the
      // highest seq the agent still holds), not this frame's position. Letting
      // it advance the cursor sets `seen` to the newest seq before replay even
      // starts, so the entire replay is then discarded as already-seen.
      if (typeof msg.seq === "number" && msg.type !== "ready") {
        // Gapless monotonic seq is the replay contract; a regression means a
        // buggy agent, so drop rather than render out of order.
        if (msg.seq <= seen) continue;
        seen = msg.seq;
      }
      if (msg.type === "bye") { fireClose(msg.reason || "agent said bye"); sock.destroy(); return; }
      for (const cb of frameCbs) cb(msg);
    }
  });

  sock.on("error", (err) => fireClose(`stream error: ${err.message}`));
  sock.on("close", () => fireClose("stream closed"));

  let frameSeq = 0;
  const send = (obj: Record<string, unknown>): boolean => {
    if (closed) return false;
    try { sock.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
  };

  return {
    onFrame: (cb) => frameCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    say: (author, text) => {
      const id = `c${++frameSeq}`;
      return send({ type: "say", id, author, text }) ? id : null;
    },
    permissionReply: (request_id, decision, author) =>
      send({ type: "permission_reply", request_id, decision, author }),
    questionReply: (request_id, answers, author, declined = false) =>
      send({ type: "question_reply", request_id, answers, declined, author }),
    interrupt: (author) => send({ type: "interrupt", author }),
    close: () => { try { sock.destroy(); } catch {} },
    lastSeq: () => seen,
  };
}
