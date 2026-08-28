/**
 * herdr-web bridge server.
 *
 * Security posture (deliberate — herdr's own binary opens NO network port):
 *   - binds 127.0.0.1 only, never 0.0.0.0
 *   - requires a shared token on every request and WS upgrade
 *   - token is generated per-run and printed once, or set HERDR_WEB_TOKEN
 *   - RPC proxying is allow-listed by method prefix, not open passthrough
 */
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { call, rpc, isErr, subscribe, socketPath } from "./herdr-socket.ts";
import { openTerminalSession, type TerminalSession } from "./terminal-bridge.ts";
import { startFleetTracker, getFleet, onFleet, refresh as refreshFleet } from "./fleet.ts";
import { Identity, type User } from "./identity.ts";
import { say as enqueueSay, pending as pendingFor, onMessage, clearQueue, allPending } from "./send-queue.ts";
import { detect as detectStream, open as openStream, type StreamHandle } from "./agent-stream.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.HERDR_WEB_PORT || 7878);
const identity = new Identity();

/**
 * Optional pre-fill for the new-session dialog, e.g. "exec my-agent".
 *
 * herdr-web stays agent-agnostic: it hardcodes no agent and ships this empty.
 * A deployment that wants one-click sessions for a particular agent sets this
 * and the dialog pre-fills it — still visible and still editable, so the same
 * install keeps working for codex, cursor and plain shells.
 */
const DEFAULT_LAUNCH_CMD = (process.env.HERDR_WEB_DEFAULT_LAUNCH_CMD || "").trim();

/**
 * Brandable name for the agent people are talking to, e.g. "Alice".
 *
 * In a shared session the transcript reads "alice: …" / "bob: …" with the
 * replies unattributed, which is odd when several humans are talking to one
 * agent. Naming it makes the conversation legible. Empty means unbranded.
 */
const AGENT_NAME = (process.env.HERDR_WEB_AGENT_NAME || "").trim();
const TOKEN = identity.adminToken;
const WEB_ROOT = new URL("../web/", import.meta.url).pathname;

/** Methods the browser may invoke. Mutating server lifecycle is excluded. */
const ALLOWED_PREFIXES = [
  "ping",
  "workspace.",
  "tab.",
  "pane.",
  "agent.",
  "layout.",
  "worktree.",
  "session.snapshot",
  "notification.show",
];
/** Never reachable from the browser, admin or not. */
const DENIED = new Set(["server.stop", "server.live_handoff"]);

/**
 * Destructive structure changes. Creation is open to everyone; destruction is
 * admin-only, because in a shared UI one person closing another's running
 * session is not recoverable.
 */
const ADMIN_ONLY = new Set([
  "pane.close", "tab.close", "workspace.close", "worktree.remove",
]);

// Start the resident fleet tracker before serving.
const stopFleet = startFleetTracker();
process.on("SIGINT", () => { stopFleet(); process.exit(0); });
process.on("SIGTERM", () => { stopFleet(); process.exit(0); });

function methodAllowed(m: string): boolean {
  if (DENIED.has(m)) return false;
  return ALLOWED_PREFIXES.some((p) => (p.endsWith(".") ? m.startsWith(p) : m === p));
}

/** Resolve the caller to a user, or null to reject. */
function whoami(req: Request): User | null {
  const url = new URL(req.url);
  const t = url.searchParams.get("token") || req.headers.get("x-herdr-token");
  return identity.resolve(t);
}
function authed(req: Request): boolean {
  return whoami(req) !== null;
}

// ---- presence: who is watching which pane -----------------------------------
const presence = new Map<string, Set<string>>();   // paneId -> user labels
function joinPane(paneId: string, who: string) {
  if (!presence.has(paneId)) presence.set(paneId, new Set());
  presence.get(paneId)!.add(who);
  broadcastPresence();
}
function leavePane(paneId: string, who: string) {
  const s = presence.get(paneId);
  if (!s) return;
  s.delete(who);
  if (!s.size) presence.delete(paneId);
  broadcastPresence();
}
function presenceSnapshot(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of presence) out[k] = [...v];
  return out;
}
const eventClients = new Set<any>();
/** every live ws, for the admin overview and disconnect */
const liveSockets = new Set<any>();
function broadcastPresence() {
  const payload = JSON.stringify({ event: "presence", data: { presence: presenceSnapshot() } });
  for (const ws of eventClients) { try { ws.send(payload); } catch {} }
}
function broadcastQueue(m: any) {
  const payload = JSON.stringify({ event: "queue", data: { message: m } });
  for (const ws of eventClients) { try { ws.send(payload); } catch {} }
}
onMessage(broadcastQueue);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

interface WsData {
  kind: "events" | "terminal" | "stream";
  paneId?: string;
  session?: TerminalSession;
  unsub?: () => void;
  /** Terminal sessions spawn lazily on the client's `init` message. */
  started?: boolean;
  who?: string;
  /** Has the current line any typed content? Drives submit-time attribution. */
  lineHasContent?: boolean;
  /** Structured agent stream, for the chat view. */
  stream?: StreamHandle;
}

const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;
const SUBMIT = /[\r\n]/;

/** readline/emacs motions honoured by virtually every TUI input, incl. Ink. */
const HOME = "\x01";   // ctrl+a
const END  = "\x05";   // ctrl+e

/**
 * Input is only meaningful in control mode; tell the UI instead of dropping
 * silently.
 *
 * Attribution is applied HERE, from the authenticated identity on this
 * connection, so a client cannot type as someone else.
 *
 * It is injected at SUBMIT time, not as you type: on Enter we jump to the start
 * of the line, insert "<user>: ", jump back to the end, and only then submit.
 * The typist therefore never sees the prefix sitting in their input and cannot
 * backspace it away, while the agent still receives an attributed line. The
 * gutter badge in the browser is what tells them who they are typing as.
 */
function forwardInput(ws: any, d: WsData, text: string) {
  if (!d.session) return;
  if (d.session.mode !== "control") {
    try { ws.send(JSON.stringify({ type: "_readonly" })); } catch {}
    return;
  }

  const prefix = d.who && d.who !== "operator" ? `${d.who}: ` : "";
  if (!prefix) { d.session.write(text); return; }

  if (SUBMIT.test(text)) {
    // Only attribute a line that actually has content; a bare Enter stays bare.
    if (d.lineHasContent) {
      const [before, ...rest] = text.split(/([\r\n])/);
      if (before) d.session.write(before);
      d.session.write(HOME);
      d.session.write(prefix);
      d.session.write(END);
      d.session.write(rest.join(""));
    } else {
      d.session.write(text);
    }
    d.lineHasContent = false;
    return;
  }

  if (PRINTABLE.test(text)) d.lineHasContent = true;
  d.session.write(text);
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,

  async fetch(req, srv) {
    const url = new URL(req.url);

    // --- WebSocket upgrades -------------------------------------------------
    if (url.pathname === "/ws/events") {
      const u = whoami(req);
      if (!u) return new Response("unauthorized", { status: 401 });
      if (srv.upgrade(req, { data: { kind: "events", who: Identity.label(u) } })) return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/ws/stream/")) {
      const u = whoami(req);
      if (!u) return new Response("unauthorized", { status: 401 });
      const paneId = decodeURIComponent(url.pathname.slice("/ws/stream/".length));
      if (srv.upgrade(req, { data: { kind: "stream", paneId, who: Identity.label(u) } }))
        return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/ws/terminal/")) {
      if (!authed(req)) return new Response("unauthorized", { status: 401 });
      const u = whoami(req);
      if (!u) return new Response("unauthorized", { status: 401 });
      const paneId = decodeURIComponent(url.pathname.slice("/ws/terminal/".length));
      if (srv.upgrade(req, { data: { kind: "terminal", paneId, who: Identity.label(u) } })) return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }

    // --- JSON API -----------------------------------------------------------
    if (url.pathname.startsWith("/api/")) {
      if (!authed(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

      if (url.pathname === "/api/health") {
        try {
          const pong = await call("ping");
          return Response.json({ ok: true, herdr: pong, socket: socketPath() });
        } catch (err: any) {
          return Response.json({ ok: false, error: err.message }, { status: 502 });
        }
      }

      // Aggregated snapshot the dashboard boots from.
      // ---- admin-only surface -------------------------------------------
      if (url.pathname.startsWith("/api/admin/")) {
        const u = whoami(req)!;
        if (!u.isAdmin) {
          return Response.json({ error: "admin only" }, { status: 403 });
        }

        if (url.pathname === "/api/admin/overview") {
          const conns: Array<Record<string, unknown>> = [];
          for (const ws of liveSockets) {
            conns.push({ kind: ws.data?.kind, who: ws.data?.who,
                         pane_id: ws.data?.paneId ?? null,
                         mode: ws.data?.session?.mode ?? null });
          }
          return Response.json({
            connections: conns,
            presence: presenceSnapshot(),
            queues: allPending(),
            users: identity.names(),
          });
        }

        if (req.method === "POST" && url.pathname === "/api/admin/release-control") {
          const { pane_id } = (await req.json().catch(() => ({}))) as any;
          if (!pane_id) return Response.json({ error: "pane_id required" }, { status: 400 });
          let n = 0;
          for (const ws of [...liveSockets]) {
            if (ws.data?.kind === "terminal" && ws.data.paneId === pane_id
                && ws.data.session?.mode === "control") {
              try { ws.data.session.release(); ws.close(1000, "control released by admin"); n++; } catch {}
            }
          }
          return Response.json({ released: n });
        }

        if (req.method === "POST" && url.pathname === "/api/admin/clear-queue") {
          const { pane_id } = (await req.json().catch(() => ({}))) as any;
          if (!pane_id) return Response.json({ error: "pane_id required" }, { status: 400 });
          return Response.json({ cleared: clearQueue(pane_id) });
        }

        if (req.method === "POST" && url.pathname === "/api/admin/disconnect") {
          const { who } = (await req.json().catch(() => ({}))) as any;
          if (!who) return Response.json({ error: "who required" }, { status: 400 });
          let n = 0;
          for (const ws of [...liveSockets]) {
            if (ws.data?.who === who) {
              try { ws.data.session?.release(); ws.close(1000, "disconnected by admin"); n++; } catch {}
            }
          }
          return Response.json({ disconnected: n, who });
        }

        return Response.json({ error: "not found" }, { status: 404 });
      }

      if (url.pathname === "/api/whoami") {
        const u = whoami(req)!;
        return Response.json({
          name: u.name, label: Identity.label(u), isAdmin: u.isAdmin,
          multiuser: identity.multiuser, users: identity.multiuser ? identity.names() : [],
          canDestroy: u.isAdmin, adminOnly: [...ADMIN_ONLY],
          defaultLaunchCmd: DEFAULT_LAUNCH_CMD,
          agentName: AGENT_NAME,
        });
      }

      // Attributed group-chat message. The prefix is applied server-side from
      // the AUTHENTICATED identity — never from the request body.
      if (url.pathname === "/api/say" && req.method === "POST") {
        const u = whoami(req)!;
        let body: any;
        try { body = await req.json(); } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
        const { pane_id, text } = body ?? {};
        if (typeof pane_id !== "string" || typeof text !== "string" || !text.trim()) {
          return Response.json({ error: "pane_id and non-empty text required" }, { status: 400 });
        }
        const m = enqueueSay(pane_id, u.name, text);
        return Response.json({ queued: m.id, state: m.state, pending: pendingFor(pane_id).length });
      }

      // Does this pane's agent advertise herdr-agent-stream/1? One pane.get,
      // asked only when a pane is opened — pane.list does not carry tokens, so
      // sweeping every pane on every refresh would cost N extra round trips.
      if (url.pathname === "/api/capability") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return Response.json({ error: "pane_id required" }, { status: 400 });
        const cap = await detectStream(paneId);
        return Response.json({ pane_id: paneId, stream: !!cap, capability: cap });
      }

      if (url.pathname === "/api/presence") {
        return Response.json({ presence: presenceSnapshot() });
      }

      if (url.pathname === "/api/fleet") {
        // Serve the resident snapshot; force a refresh only if asked.
        if (url.searchParams.get("refresh") === "1") {
          try { await refreshFleet(); } catch {}
        }
        return Response.json({ fleet: getFleet(), at: new Date().toISOString() });
      }

      // Answer a blocked agent without attaching a terminal.
      if (url.pathname === "/api/reply" && req.method === "POST") {
        let body: any;
        try { body = await req.json(); } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
        const { pane_id, text, submit } = body ?? {};
        if (typeof pane_id !== "string" || typeof text !== "string" || !text.length) {
          return Response.json({ error: "pane_id and non-empty text required" }, { status: 400 });
        }
        try {
          await call("pane.send_text", { pane_id, text });
          if (submit !== false) await call("pane.send_keys", { pane_id, keys: ["enter"] });
          setTimeout(() => { refreshFleet().catch(() => {}); }, 400);
          return Response.json({ ok: true });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 502 });
        }
      }

      // On-demand screen context for any pane (triage preview / refresh).
      if (url.pathname === "/api/context") {
        const paneId = url.searchParams.get("pane_id");
        const lines = Math.min(200, Math.max(5, Number(url.searchParams.get("lines")) || 40));
        if (!paneId) return Response.json({ error: "pane_id required" }, { status: 400 });
        try {
          const res = await call("pane.read", {
            pane_id: paneId, source: "visible", format: "text", lines, strip_ansi: true,
          });
          const text = String(res?.read?.text ?? "");
          return Response.json({
            pane_id: paneId,
            lines: text.split("\n").map((l: string) => l.replace(/\s+$/, ""))
                       .filter((l: string) => l.trim().length > 0),
          });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 502 });
        }
      }

      if (url.pathname === "/api/state") {
        try {
          const [workspaces, panes, agents] = await Promise.all([
            call("workspace.list"),
            call("pane.list"),
            call("agent.list"),
          ]);
          return Response.json({
            workspaces: workspaces.workspaces ?? [],
            panes: panes.panes ?? [],
            agents: agents.agents ?? [],
            at: new Date().toISOString(),
          });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 502 });
        }
      }

      if (url.pathname === "/api/rpc" && req.method === "POST") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
        const { method, params } = body ?? {};
        if (typeof method !== "string") {
          return Response.json({ error: "method required" }, { status: 400 });
        }
        if (!methodAllowed(method)) {
          return Response.json({ error: `method not allowed: ${method}` }, { status: 403 });
        }
        if (ADMIN_ONLY.has(method) && !whoami(req)!.isAdmin) {
          return Response.json(
            { error: `${method} is admin only`, adminOnly: true }, { status: 403 });
        }
        try {
          const res = await rpc(method, params ?? {});
          if (isErr(res)) return Response.json({ error: res.error }, { status: 400 });
          return Response.json({ result: res.result });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 502 });
        }
      }

      return Response.json({ error: "not found" }, { status: 404 });
    }

    // --- Static frontend ----------------------------------------------------
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    const file = join(WEB_ROOT, safe);
    if (!file.startsWith(WEB_ROOT) || !existsSync(file)) {
      return new Response("not found", { status: 404 });
    }
    const body = readFileSync(file);
    return new Response(body, {
      headers: { "content-type": MIME[extname(file)] || "application/octet-stream" },
    });
  },

  websocket: {
    open(ws) {
      const d = ws.data;
      liveSockets.add(ws);
      if (d.kind === "events") {
        // Lifecycle events that matter for a dashboard. Names verified
        // against the schema's Subscription enum.
        const types = [
          "workspace.created", "workspace.updated", "workspace.renamed",
          "workspace.closed", "workspace.focused",
          "tab.created", "tab.closed", "tab.renamed", "tab.focused",
          "pane.created", "pane.closed", "pane.updated", "pane.focused",
          "pane.exited", "pane.agent_detected",
          "layout.updated",
        ];
        eventClients.add(ws);
        try { ws.send(JSON.stringify({ event: "presence", data: { presence: presenceSnapshot() } })); } catch {}

        // Push the resident fleet snapshot: initial + on every change.
        const off = onFleet((fleet) => {
          try { ws.send(JSON.stringify({ event: "fleet", data: { fleet } })); } catch {}
        });
        try { ws.send(JSON.stringify({ event: "fleet", data: { fleet: getFleet() } })); } catch {}

        const unsubEvents = subscribe(
          types.map((t) => ({ type: t })),
          (evt) => { try { ws.send(JSON.stringify(evt)); } catch {} },
          (reason) => {
            try { ws.send(JSON.stringify({ event: "_bridge_closed", data: { reason } })); } catch {}
          },
        );
        d.unsub = () => { off(); unsubEvents(); };
        return;
      }

      // Terminal sessions are NOT spawned here. We wait for the client's
      // {type:"init",cols,rows,mode} so the PTY opens at the browser's real
      // geometry and in the mode the user asked for. Spawning at open with a
      // guessed 120x40 makes the first paint wrap incorrectly.
      if (d.kind === "stream" && d.paneId) {
        joinPane(d.paneId, d.who || "operator");
        void (async () => {
          const cap = await detectStream(d.paneId!);
          if (!cap) {
            try { ws.send(JSON.stringify({ type: "_nostream" })); ws.close(1000, "no stream"); } catch {}
            return;
          }
          const h = openStream(cap, { fromSeq: 0, client: `herdr-web/${d.who}` });
          d.stream = h;
          h.onFrame((f) => { try { ws.send(JSON.stringify(f)); } catch {} });
          h.onClose((reason) => {
            try { ws.send(JSON.stringify({ type: "_closed", reason })); ws.close(1000, reason); } catch {}
          });
        })();
        return;
      }

      if (d.kind === "terminal" && d.paneId) {
        joinPane(d.paneId, d.who || "operator");
        ws.send(JSON.stringify({ type: "_ready", you: d.who || "operator" }));
      }
    },

    message(ws, raw) {
      const d = ws.data;

      if (d.kind === "stream") {
        if (!d.stream) return;
        const txt = typeof raw === "string" ? raw : Buffer.from(raw as any).toString("utf8");
        let m: any; try { m = JSON.parse(txt); } catch { return; }
        // The author is OURS, from the authenticated connection — never the
        // client's claim (docs/PROTOCOL.md §3).
        const who = d.who || "operator";
        if (m.type === "say") d.stream.say(who, String(m.text ?? ""));
        else if (m.type === "permission_reply")
          d.stream.permissionReply(String(m.request_id), m.decision === "allow" ? "allow" : "deny", who);
        else if (m.type === "question_reply")
          d.stream.questionReply(String(m.request_id), m.answers ?? {}, who, !!m.declined);
        else if (m.type === "interrupt") d.stream.interrupt(who);
        return;
      }

      if (d.kind !== "terminal" || !d.paneId) return;

      const text = typeof raw === "string" ? raw : Buffer.from(raw as any).toString("utf8");

      // Control frames are JSON; anything else is literal keystrokes.
      let msg: any = null;
      if (text.startsWith("{")) { try { msg = JSON.parse(text); } catch { msg = null; } }

      if (msg?.type === "init") {
        if (d.started) return;
        d.started = true;
        const mode: "observe" | "control" = msg.mode === "control" ? "control" : "observe";
        const session = openTerminalSession({
          paneId: d.paneId,
          cols: Number(msg.cols) || 80,
          rows: Number(msg.rows) || 24,
          mode,
          takeover: mode === "control" && msg.takeover !== false,
        });
        d.session = session;
        d.lineHasContent = false;
        session.onData((bytes) => { try { ws.send(bytes); } catch {} });
        session.onClose((reason) => {
          try { ws.send(JSON.stringify({ type: "_closed", reason })); } catch {}
          try { ws.close(1000, String(reason).slice(0, 120)); } catch {}
        });
        try { ws.send(JSON.stringify({ type: "_attached", mode })); } catch {}
        return;
      }

      if (!d.session) return; // not initialised yet

      if (msg?.type === "resize") { d.session.resize(msg.cols, msg.rows); return; }
      if (msg?.type === "scroll") {
        d.session.scroll(msg.direction === "down" ? "down" : "up", msg.lines ?? 3);
        return;
      }
      if (msg?.type === "input")  { forwardInput(ws, d, msg.text ?? ""); return; }

      forwardInput(ws, d, text);
    },

    close(ws) {
      liveSockets.delete(ws);
      eventClients.delete(ws);
      ws.data.stream?.close();
      ws.data.unsub?.();
      ws.data.session?.release();
      if ((ws.data.kind === "terminal" || ws.data.kind === "stream") && ws.data.paneId) {
        leavePane(ws.data.paneId, ws.data.who || "operator");
      }
    },
  },
});

console.log(`
  herdr-web bridge
  ----------------
  url     http://${HOST}:${server.port}/?token=${TOKEN}
  socket  ${socketPath()}
  users   ${identity.describe()}
  launch  ${DEFAULT_LAUNCH_CMD || "(none — new sessions open a shell)"}
  agent   ${AGENT_NAME || "(unbranded)"}
  bound   ${HOST} only (never 0.0.0.0)

  Set HERDR_WEB_TOKEN to pin the token, HERDR_WEB_PORT to change the port.
`);
