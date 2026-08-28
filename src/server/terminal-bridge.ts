/**
 * Terminal streaming bridge.
 *
 * herdr ships a documented third-party bridge interface (docs/persistence-remote.mdx,
 * "For third-party bridges that only need rendered terminal bytes"):
 *
 *   herdr terminal session observe <pane> --cols N --rows M   read-only, many allowed
 *   herdr terminal session control <pane> --cols N --rows M   read/write, ONE owner
 *
 * Both emit NDJSON `terminal.frame` records with base64 ANSI in `bytes`, then
 * `terminal.closed`. Per the docs both send "the current rendered terminal
 * state, then live ANSI frames" — so no scrollback replay is needed on attach.
 *
 * `control` reads NDJSON commands on stdin:
 *   {"type":"terminal.input","text":"..."} | {"bytes":"<base64>"}
 *   {"type":"terminal.resize","cols":N,"rows":M}
 *   {"type":"terminal.scroll",...}
 *   {"type":"terminal.release"}
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type TerminalMode = "observe" | "control";

export interface TerminalSessionOptions {
  paneId: string;
  cols: number;
  rows: number;
  mode: TerminalMode;
  /** control mode only: seize input ownership from the current owner (incl. the TUI). */
  takeover?: boolean;
  herdrBin?: string;
}

export interface TerminalSession {
  readonly mode: TerminalMode;
  onData: (cb: (bytes: Buffer) => void) => void;
  onClose: (cb: (reason: string) => void) => void;
  /** No-op in observe mode. */
  write: (text: string) => void;
  resize: (cols: number, rows: number) => void;
  /** Scroll herdr's viewport. Only meaningful for panes with scrollback;
   *  alt-screen apps own their own scrolling and ignore it. */
  scroll: (direction: "up" | "down", lines: number) => void;
  release: () => void;
}

/** herdr rejects nonsense geometry; keep it in a sane band. */
function clampGeom(cols: number, rows: number): [number, number] {
  const c = Number.isFinite(cols) ? Math.trunc(cols) : 80;
  const r = Number.isFinite(rows) ? Math.trunc(rows) : 24;
  return [Math.min(500, Math.max(20, c)), Math.min(200, Math.max(5, r))];
}

export function openTerminalSession(opts: TerminalSessionOptions): TerminalSession {
  const bin = opts.herdrBin || process.env.HERDR_BIN || "herdr";
  const [cols, rows] = clampGeom(opts.cols, opts.rows);

  const args = [
    "terminal", "session", opts.mode, opts.paneId,
    "--cols", String(cols),
    "--rows", String(rows),
  ];
  // --takeover is only valid for control mode.
  if (opts.mode === "control" && opts.takeover) args.push("--takeover");

  // Strip inherited herdr client-socket override so we always reach the
  // user's real server rather than a nested/dev one.
  const env = { ...process.env };
  delete env.HERDR_CLIENT_SOCKET_PATH;

  const child: ChildProcessWithoutNullStreams = spawn(bin, args, {
    env, stdio: ["pipe", "pipe", "pipe"],
  });

  const dataCbs: Array<(b: Buffer) => void> = [];
  const closeCbs: Array<(r: string) => void> = [];
  let buf = "";
  let closed = false;
  let stderrTail = "";

  const fireClose = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb(reason);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }

      if (typeof rec.bytes === "string" && rec.bytes.length) {
        const decoded = Buffer.from(rec.bytes, "base64");
        for (const cb of dataCbs) cb(decoded);
      }
      if (rec.type === "terminal.closed") {
        fireClose(rec.reason || "terminal closed by server");
      }
    }
  });

  child.stderr.on("data", (c: Buffer) => {
    const msg = c.toString("utf8");
    stderrTail = (stderrTail + msg).slice(-400);
    const t = msg.trim();
    if (t) console.error(`[terminal ${opts.paneId}] ${t}`);
  });

  child.on("error", (err) => fireClose(`spawn failed: ${err.message}`));
  child.on("exit", (code, signal) => {
    if (code === 0) return fireClose("session ended");
    const detail = stderrTail.trim().split("\n").pop() || `code ${code}${signal ? `/${signal}` : ""}`;
    fireClose(detail);
  });

  const send = (obj: Record<string, unknown>) => {
    if (closed || opts.mode !== "control") return;
    try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch { /* stdin gone */ }
  };

  return {
    mode: opts.mode,
    onData: (cb) => dataCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    write: (text) => send({ type: "terminal.input", text }),
    resize: (c, r) => {
      const [cc, rr] = clampGeom(c, r);
      send({ type: "terminal.resize", cols: cc, rows: rr });
    },
    scroll: (direction, lines) => {
      send({ type: "terminal.scroll", direction,
             lines: Math.min(50, Math.max(1, Math.trunc(lines) || 3)),
             source: "wheel" });
    },
    release: () => {
      send({ type: "terminal.release" });
      setTimeout(() => { if (!child.killed) child.kill(); }, 150);
    },
  };
}
