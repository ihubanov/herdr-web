/**
 * One herdr terminal session per pane, shared by every viewer.
 *
 * herdr allows exactly ONE attached client per terminal — measured: a second
 * control attach without --takeover is refused with "already has an attached
 * client", and the refusal closes the session; with --takeover it succeeds by
 * kicking the first, whose keystrokes then stop working with no signal.
 *
 * Nothing says that client has to be a person. The bridge is the one client;
 * viewers subscribe to its output and write to its input. herdr sees exactly
 * what it supports, and the people get a shared terminal — tmux with N clients.
 *
 * Two things this file is responsible for and nothing else is:
 *
 *  1. THE REFCOUNT. The session lives while at least one viewer is attached and
 *     is closed by the last one to leave. A leaked session is not a wasted
 *     process, it is a pane herdr's own TUI can no longer attach to without a
 *     takeover — so every exit path decrements, including errors.
 *
 *  2. THE GEOMETRY. The pane is sized to the SMALLEST viewer. Sizing to the
 *     largest leaves everyone else reading wrapped lines, which is the bug this
 *     work started from. The cost is that one phone joining reflows the card
 *     for everyone, which is the correct trade and a visible one.
 */
import { openTerminalSession, type TerminalSession } from "./terminal-bridge.ts";

export interface Viewer {
  /** Stable per-socket id, so leaving removes the right one. */
  id: number;
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
  onClose: (reason: string) => void;
  /** Told when the shared session's mode changes under them. */
  onMode: (mode: "observe" | "control") => void;
}

interface Shared {
  paneId: string;
  session: TerminalSession;
  mode: "observe" | "control";
  viewers: Map<number, Viewer>;
  /** Whether the CURRENT line already carries an attribution prefix. Shared,
   *  because the line is: two people typing into one prompt share a buffer, and
   *  a per-socket flag would prefix the same line twice. */
  lineHasContent: boolean;
  /** Guards against re-entering the fallback or an upgrade twice. */
  settling: boolean;
}

const panes = new Map<string, Shared>();
let nextId = 1;

export function viewerId(): number { return nextId++; }

/** The smallest box every viewer can display in full. */
function fit(s: Shared): { cols: number; rows: number } {
  let cols = Infinity, rows = Infinity;
  for (const v of s.viewers.values()) {
    if (v.cols > 0) cols = Math.min(cols, v.cols);
    if (v.rows > 0) rows = Math.min(rows, v.rows);
  }
  return {
    cols: Number.isFinite(cols) ? cols : 80,
    rows: Number.isFinite(rows) ? rows : 24,
  };
}

function applyGeometry(s: Shared): void {
  const { cols, rows } = fit(s);
  try { s.session.resize(cols, rows); } catch { /* session already gone */ }
}

function broadcastClose(s: Shared, reason: string): void {
  for (const v of [...s.viewers.values()]) { try { v.onClose(reason); } catch {} }
  s.viewers.clear();
  panes.delete(s.paneId);
}

/**
 * Open the underlying session and wire it to the pane's viewers.
 *
 * `takeover` false is a polite bid: herdr refuses it when something else holds
 * the terminal, and we fall back to observe rather than leaving every viewer
 * with a closed socket.
 */
function openSession(s: Shared, mode: "observe" | "control", takeover: boolean): void {
  const { cols, rows } = fit(s);
  const session = openTerminalSession({ paneId: s.paneId, cols, rows, mode, takeover });
  s.session = session;
  s.mode = mode;

  session.onData((bytes) => {
    for (const v of s.viewers.values()) { try { v.onData(bytes); } catch {} }
  });

  session.onClose((reason) => {
    if (mode === "control" && !takeover && !s.settling
        && /already has an attached client/i.test(String(reason))) {
      // Somebody else holds the pane. Watch it instead of dying.
      s.settling = true;
      try {
        openSession(s, "observe", false);
        for (const v of s.viewers.values()) { try { v.onMode("observe"); } catch {} }
      } catch { broadcastClose(s, String(reason)); }
      s.settling = false;
      return;
    }
    broadcastClose(s, String(reason));
  });
}

/** Attach a viewer, opening the pane's session if this is the first one. */
export function join(paneId: string, v: Viewer): "observe" | "control" {
  let s = panes.get(paneId);
  if (!s) {
    s = {
      paneId, session: null as unknown as TerminalSession, mode: "observe",
      viewers: new Map(), lineHasContent: false, settling: false,
    };
    panes.set(paneId, s);
    s.viewers.set(v.id, v);
    // First viewer bids politely for control, so the pane takes their geometry.
    openSession(s, "control", false);
    return s.mode;
  }
  s.viewers.set(v.id, v);
  applyGeometry(s);            // a smaller newcomer reflows the pane for everyone
  return s.mode;
}

/** Detach a viewer; the last one out closes the session. */
export function leave(paneId: string, id: number): void {
  const s = panes.get(paneId);
  if (!s) return;
  s.viewers.delete(id);
  if (s.viewers.size === 0) {
    panes.delete(paneId);
    try { s.session?.release(); } catch { /* already gone */ }
    return;
  }
  applyGeometry(s);            // the smallest viewer may have just left
}

export function resize(paneId: string, id: number, cols: number, rows: number): void {
  const s = panes.get(paneId);
  const v = s?.viewers.get(id);
  if (!s || !v) return;
  v.cols = cols; v.rows = rows;
  applyGeometry(s);
}

export function write(paneId: string, text: string): void {
  try { panes.get(paneId)?.session.write(text); } catch { /* gone */ }
}

export function scroll(paneId: string, direction: "up" | "down", lines: number): void {
  try { panes.get(paneId)?.session.scroll(direction, lines); } catch { /* gone */ }
}

export function modeOf(paneId: string): "observe" | "control" | null {
  return panes.get(paneId)?.mode ?? null;
}

/** Shared per-LINE state, for attribution: see bridge.ts forwardInput. */
export function lineHasContent(paneId: string): boolean {
  return !!panes.get(paneId)?.lineHasContent;
}
export function setLineHasContent(paneId: string, value: boolean): void {
  const s = panes.get(paneId);
  if (s) s.lineHasContent = value;
}

/**
 * Escalate a watching pane to control, seizing it.
 *
 * Only ever called because a human typed: taking a pane from whoever holds it
 * is a deliberate act, so it must not happen merely because someone opened a
 * card. Every viewer is told, because they are all about to be able to type.
 */
export function takeControl(paneId: string): boolean {
  const s = panes.get(paneId);
  if (!s || s.mode === "control") return false;
  s.settling = true;
  try { s.session?.release(); } catch { /* already gone */ }
  try {
    openSession(s, "control", true);
    for (const v of s.viewers.values()) { try { v.onMode("control"); } catch {} }
  } catch {
    s.settling = false;
    return false;
  }
  s.settling = false;
  return true;
}

/**
 * Give a pane back — close the shared session and tell every viewer why.
 *
 * "Release control" means something different now that the bridge is the one
 * client: there is no per-person control to drop, so releasing frees the pane
 * for herdr's own TUI or another tool. Everyone watching is told, because
 * everyone watching loses the view.
 */
export function release(paneId: string, reason: string): number {
  const s = panes.get(paneId);
  if (!s) return 0;
  const n = s.viewers.size;
  try { s.session?.release(); } catch { /* already gone */ }
  broadcastClose(s, reason);
  return n;
}

/** Diagnostics for /api/state. */
export function stats(): Record<string, { viewers: number; mode: string }> {
  const out: Record<string, { viewers: number; mode: string }> = {};
  for (const [id, s] of panes) out[id] = { viewers: s.viewers.size, mode: s.mode };
  return out;
}
