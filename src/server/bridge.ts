/**
 * herdr-web bridge server.
 *
 * Security posture (deliberate — herdr's own binary opens NO network port):
 *   - binds 127.0.0.1 only, never 0.0.0.0
 *   - requires a shared token on every request and WS upgrade
 *   - token is generated per-run and printed once, or set HERDR_WEB_TOKEN
 *   - RPC proxying is allow-listed by method prefix, not open passthrough
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, extname, normalize } from "node:path";
import { call, rpc, isErr, subscribe, socketPath } from "./herdr-socket.ts";
import { openTerminalSession, type TerminalSession } from "./terminal-bridge.ts";
import { startFleetTracker, getFleet, onFleet, refresh as refreshFleet } from "./fleet.ts";
import { Identity, type User } from "./identity.ts";
import { say as enqueueSay, pending as pendingFor, onMessage, clearQueue, allPending, type AttrFmt } from "./send-queue.ts";
import { detect as detectStream, open as openStream, type StreamHandle } from "./agent-stream.ts";
import { findTranscript, followTranscript, readBefore, type TranscriptHandle } from "./transcript.ts";
import * as InputLock from "./input-lock.ts";

// Loopback by default. HERDR_WEB_HOST widens the bind (e.g. 0.0.0.0 inside a container whose
// port is published to a LAN address that a tunnel fronts). The token stays mandatory either
// way — this changes reachability, not authentication. Never widen it on a machine whose port
// is directly routable from the internet.
const HOST = (process.env.HERDR_WEB_HOST || "127.0.0.1").trim();
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
 * Launch-command policy. Default OFF keeps the agnostic behavior above (the
 * dialog shows an editable, prefilled command that works for codex/cursor/shell).
 * A single-agent deployment can set HERDR_WEB_LOCK_LAUNCH=1 to LOCK the field:
 * the new-session dialog then shows the base command read-only and offers only a
 * "--dangerously-skip-permissions" checkbox (default off) instead of free text.
 * This is a UI safety-rail, not a security boundary — a pane is a terminal, so a
 * user with a pane can type anything regardless; it just stops the new-session
 * dialog from being an arbitrary-command box.
 */
/**
 * Optional link to another front end for the same agent (e.g. the classic beast-server web
 * UI), rendered as a header button so a person who is not comfortable here can switch with
 * one click. Nothing is rendered when unset. Interfaces, not conversations: the other UI
 * shows its own sessions.
 */
const ALT_UI_URL = (process.env.HERDR_WEB_ALT_UI_URL || "").trim();
const ALT_UI_LABEL = (process.env.HERDR_WEB_ALT_UI_LABEL || "Classic UI").trim();

/**
 * Passthrough: URL prefixes owned by ANOTHER local server on this host, proxied verbatim — e.g.
 * the classic beast-server UI under /v1/ and /sage-ui/ so one public hostname can front both
 * front ends. These requests bypass this bridge's token check entirely (the upstream has its
 * own authentication) and are streamed as-is, so SSE works. Format:
 *   HERDR_WEB_PASSTHROUGH="/v1/=http://127.0.0.1:8787,/sage-ui/=http://127.0.0.1:8787"
 * Only http(s) upstreams, and THIS proxy does not upgrade WebSockets (the classic UI uses
 * SSE). That limit is local to passthrough: the shared-display proxy at /shared/<pane>/ has
 * its own upgrade path and does carry noVNC's socket — a reader asking "can noVNC work
 * through this at all" hits this comment first, and the answer there is yes.
 */
const PASSTHROUGH: Array<[string, string]> = (process.env.HERDR_WEB_PASSTHROUGH || "")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((p): [string, string] => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim().replace(/\/$/, "")]; })
  .filter(([prefix, up]) => prefix.startsWith("/") && /^https?:\/\//.test(up));

async function passthrough(req: Request): Promise<Response | null> {
  if (PASSTHROUGH.length === 0) return null;
  const url = new URL(req.url);
  const hit = PASSTHROUGH.find(([prefix]) => url.pathname === prefix.replace(/\/$/, "") || url.pathname.startsWith(prefix));
  if (!hit) return null;
  const headers = new Headers(req.headers);
  for (const h of ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "accept-encoding"]) headers.delete(h);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") { init.body = req.body; init.duplex = "half"; }
  let up: Response;
  try { up = await fetch(hit[1] + url.pathname + url.search, init as RequestInit); }
  catch (e) { return new Response(`upstream ${hit[1]} unreachable: ${String(e).slice(0, 120)}`, { status: 502 }); }
  const rh = new Headers(up.headers);
  // fetch() already decoded any content-encoding; the length no longer matches either.
  for (const h of ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]) rh.delete(h);
  return new Response(up.body, { status: up.status, statusText: up.statusText, headers: rh });
}

/** Where an UNauthenticated visit to "/" goes instead of a bare 401 — e.g. the classic UI's path when
 *  this bridge has taken over a hostname whose old bookmarks people still hold. Unset = 401 as before. */
const UNAUTH_REDIRECT = (process.env.HERDR_WEB_UNAUTH_REDIRECT || "").trim();

/** Serve a small sign-in page at "/" to an unauthenticated visitor (paste your access link or token)
 *  instead of a bare 401. Takes precedence over HERDR_WEB_UNAUTH_REDIRECT. The page only turns the
 *  pasted token into the normal ?token= URL — there is no new credential path. */
const LOGIN_PAGE = ["1", "true", "yes", "on"].includes((process.env.HERDR_WEB_LOGIN_PAGE || "").trim().toLowerCase());
function loginPage(err = false): Response {
  const alt = ALT_UI_URL ? `<p class="alt"><a href="${ALT_UI_URL.replace(/"/g, "&quot;")}" rel="noopener">Use the ${ALT_UI_LABEL.replace(/</g, "&lt;")} instead</a></p>` : "";
  const name = (AGENT_NAME || "herdr").replace(/</g, "&lt;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${name} — sign in</title>
<style>:root{color-scheme:dark light}body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e6e6}
form{background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:28px 28px 20px;width:min(420px,92vw)}h1{font-size:20px;margin:0 0 6px}p{margin:6px 0 14px;color:#a9b0bd}
input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #3a4150;background:#0f1115;color:inherit}button{margin-top:12px;width:100%;font:inherit;padding:10px;border-radius:8px;border:0;background:#4f7cff;color:#fff;cursor:pointer}
.alt{margin:16px 0 0;text-align:center}.alt a{color:#a9b0bd}.err{color:#ff8a8a;min-height:1.4em;margin:8px 0 0}</style></head><body>
<form method="post" action="/login"><h1>${name}</h1><p>Paste your personal access link, or just the token from it. It is kept in a protected cookie — never in the address bar.</p>
<input id="t" name="token" autocomplete="off" autofocus placeholder="https://…/?token=… or the token" aria-label="access link or token"><button type="submit">Sign in</button><div class="err" id="e">${err ? "That link or token was not accepted." : ""}</div>${alt}</form></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/**
 * Resume picker: let the "+" dialog open an EXISTING agent conversation as a pane. Off by default
 * (HERDR_WEB_RESUME=1) because it only works when the agent's launcher honours the contract:
 * the picker prepends `HERDR_UI_RESUME=<session_id>` to the locked launch command and nothing
 * else. The list comes from the classic server's own session API on loopback, called with a
 * server-held token that never reaches the browser; titles are the first human line of each
 * transcript under $CLAUDE_CONFIG_DIR/projects.
 */
const RESUME_ENABLED = ["1", "true", "yes", "on"].includes((process.env.HERDR_WEB_RESUME || "").trim().toLowerCase());
const SESSIONS_URL = (process.env.HERDR_WEB_SESSIONS_URL || "http://127.0.0.1:8787/v1/beast/sessions").trim();
const SESSIONS_TOKEN = (process.env.HERDR_WEB_SESSIONS_TOKEN || process.env.BEAST_SERVER_TOKEN || "").trim();
const TRANSCRIPT_ROOT = join((process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")), "projects");
const titleCache = new Map<string, { at: number; title: string | null }>();
function sessionTitle(id: string): string | null {
  const c = titleCache.get(id); if (c && Date.now() - c.at < 60_000) return c.title;
  let title: string | null = null;
  try {
    const fs = require("fs") as typeof import("fs");
    for (const dir of fs.readdirSync(TRANSCRIPT_ROOT)) {
      const p = join(TRANSCRIPT_ROOT, dir, `${id}.jsonl`);
      let fd: number; try { fd = fs.openSync(p, "r"); } catch { continue; }
      const buf = Buffer.alloc(256 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
        try {
          const o = JSON.parse(line); const m = o?.message ?? o;
          if (m?.role !== "user") continue;
          const cnt = m.content; const t = typeof cnt === "string" ? cnt : Array.isArray(cnt) ? cnt.filter((x: any) => x?.type === "text").map((x: any) => x.text).join(" ") : "";
          const line1 = (t || "").replace(/\s+/g, " ").trim();
          if (line1 && !line1.startsWith("[") && !line1.startsWith("<")) { title = line1.slice(0, 90); break; }
        } catch { /* not json */ }
      }
      break;
    }
  } catch { /* no transcripts here */ }
  titleCache.set(id, { at: Date.now(), title });
  return title;
}
async function listSessions(): Promise<Array<{ id: string; title: string | null; messages: number; created_at: number; last_activity_at: number; busy: boolean }>> {
  const r = await fetch(SESSIONS_URL, { headers: SESSIONS_TOKEN ? { authorization: `Bearer ${SESSIONS_TOKEN}` } : {} });
  if (!r.ok) throw new Error(`session list ${r.status}`);
  const d: any = await r.json();
  const raw: any[] = Array.isArray(d) ? d : Array.isArray(d?.sessions) ? d.sessions : Object.values(d ?? {});
  return raw.filter((x) => x && typeof x.session_id === "string").map((x) => ({
    id: x.session_id, title: sessionTitle(x.session_id), messages: Number(x.message_count ?? 0),
    created_at: Number(x.created_at ?? 0), last_activity_at: Number(x.last_activity_at ?? 0), busy: !!x.busy,
  })).sort((a, b) => b.last_activity_at - a.last_activity_at).slice(0, 50);
}

/**
 * Cookie sessions (default ON; HERDR_WEB_COOKIE_AUTH=0 restores query-only auth). The token in
 * the URL is the credential, and a URL is on screen, in history and in bookmarks — a photo of the
 * screen is a login. So: POST /login (the sign-in page) or any page visit that arrives WITH
 * ?token= for a NAMED user sets an HttpOnly cookie carrying the token and redirects to the same
 * path without it. Every later request authenticates from the cookie; the address bar stays
 * clean. Ephemeral (expose.sh) tokens keep the query form, because their claim-on-first-use
 * pin depends on it. GET /logout clears the cookie.
 */
const COOKIE_AUTH = !["0", "false", "off", "no"].includes((process.env.HERDR_WEB_COOKIE_AUTH || "1").trim().toLowerCase());
const AUTH_COOKIE = "hw_auth";
const AUTH_COOKIE_MAX_AGE = 30 * 24 * 3600;
function cookieToken(req: Request): string | null {
  if (!COOKIE_AUTH) return null;
  const c = req.headers.get("cookie") ?? "";
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === AUTH_COOKIE) { try { return decodeURIComponent(v.join("=")); } catch { return v.join("="); } }
  }
  return null;
}
function cookieable(token: string): boolean {
  // named users and the admin: yes. ephemeral (pinned) guests: no — see above.
  return !!identity.resolve(token) && identity.pinState(token) === null;
}
function setAuthCookie(req: Request, token: string): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE};${secureAttr(req)}`;
}
function clearAuthCookie(req: Request): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0;${secureAttr(req)}`;
}
function tokenFromPasted(v: string): string {
  const s = (v || "").trim();
  if (/^https?:\/\//i.test(s)) { try { return new URL(s).searchParams.get("token") || ""; } catch { return ""; } }
  return s;
}

/** Which view a pane opens in before the person has chosen: "chat" (default) or "terminal". */
const DEFAULT_VIEW = (process.env.HERDR_WEB_DEFAULT_VIEW || "chat").trim() === "terminal" ? "terminal" : "chat";

const LOCK_LAUNCH = ["1", "true", "yes", "on"].includes(
  (process.env.HERDR_WEB_LOCK_LAUNCH || "").trim().toLowerCase(),
);

/**
 * Brandable name for the agent people are talking to, e.g. "Alice".
 *
 * In a shared session the transcript reads "alice: …" / "bob: …" with the
 * replies unattributed, which is odd when several humans are talking to one
 * agent. Naming it makes the conversation legible. Empty means unbranded.
 */
const AGENT_NAME = (process.env.HERDR_WEB_AGENT_NAME || "").trim();

/**
 * Embedded iframe views, advertised by an agent as an `iframe_url` pane token.
 *
 * OFF BY DEFAULT, deliberately. An iframe puts agent-controlled content inside
 * the page that holds the viewer's herdr-web token, so a prompt-injected agent
 * could render a convincing fake prompt inside a UI the user trusts. This is a
 * switch on an attack surface, not a preference.
 *
 *   off       tokens ignored entirely (default)
 *   loopback  only 127.0.0.1 / localhost — covers the noVNC case, which is the
 *             one where the agent and the user genuinely share a surface
 *   on        any http(s) origin
 */
type IframePolicy = "off" | "loopback" | "on";
/**
 * How the author reaches an agent that is fed keystrokes.
 *
 *   auto   (default) the structured envelope when the pane asks for it by
 *          advertising attr_fmt=json1, the legacy prefix otherwise
 *   json   always the envelope — only sane if every agent here understands it
 *   prefix always "name: message", the old behaviour
 *   none   never attribute
 */
const ATTRIBUTION = (process.env.HERDR_WEB_ATTRIBUTION || "auto").toLowerCase();

/**
 * Ask the pane how it wants attribution. Same discovery route as stream_sock
 * and iframe_url: a metadata token the agent sets, so an agent opts IN to the
 * envelope and nothing else is disturbed by its arrival.
 */
async function attrFmtFor(paneId: string): Promise<AttrFmt> {
  if (ATTRIBUTION === "json") return "json1";
  if (ATTRIBUTION === "prefix") return "prefix";
  if (ATTRIBUTION === "none") return "none";
  try {
    const tokens = (await call("pane.get", { pane_id: paneId }))?.pane?.tokens ?? {};
    const want = String(tokens.attr_fmt ?? "").trim().toLowerCase();
    if (want === "json1" || want === "json") return "json1";
    if (want === "none") return "none";
  } catch { /* pane vanished; fall through */ }
  return "prefix";
}

const UPLOAD_DIR = process.env.HERDR_WEB_UPLOAD_DIR
  || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "herdr-web", "uploads");
const UPLOAD_MAX = Number(process.env.HERDR_WEB_UPLOAD_MAX_BYTES || 25 * 1024 * 1024);
const IFRAME_POLICY: IframePolicy = (() => {
  const v = (process.env.HERDR_WEB_IFRAMES || "off").trim().toLowerCase();
  return v === "on" || v === "loopback" ? v : "off";
})();

/**
 * An iframe is only safe to grant `allow-same-origin` when its origin differs
 * from ours — otherwise the frame can reach into this page and read the token.
 * Rejecting our own origin is what makes that sandbox choice defensible.
 */
export /**
 * `Secure` when the viewer actually arrived over TLS.
 *
 * Not unconditional: herdr-web binds loopback and is commonly reached over
 * plain http, where a Secure cookie is simply dropped and the session silently
 * fails to stick. Behind a TLS reverse proxy the connection to us is still
 * http, so the proxy's x-forwarded-proto is the only thing that knows.
 */
function secureAttr(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const https = proto ? proto === "https" : new URL(req.url).protocol === "https:";
  return https ? " Secure;" : "";
}

function iframeUrlAllowed(raw: string, policy: IframePolicy, selfPort: number):
    { ok: true; url: string } | { ok: false; reason: string } {
  if (policy === "off") return { ok: false, reason: "iframes disabled (HERDR_WEB_IFRAMES=off)" };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "not a valid URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `scheme ${u.protocol} not allowed` };
  }
  const host = u.hostname;
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (policy === "loopback" && !isLoopback) {
    return { ok: false, reason: "only loopback URLs allowed (HERDR_WEB_IFRAMES=loopback)" };
  }
  // Never frame ourselves: same origin would let the frame drop its sandbox and
  // read this page, token included.
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (isLoopback && Number(port) === selfPort) {
    return { ok: false, reason: "refusing to frame herdr-web's own origin" };
  }
  return { ok: true, url: u.toString() };
}
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
  const t = url.searchParams.get("token") || req.headers.get("x-herdr-token") || cookieToken(req);
  return identity.resolve(t);
}
function authed(req: Request): boolean {
  return whoami(req) !== null;
}

/**
 * The local origin a pane advertises for its shared display.
 *
 * The pane token still holds the real http://127.0.0.1:<port>/... URL, because
 * that is what is true ON THIS HOST. What must never reach a remote viewer is
 * that URL itself — their browser would resolve 127.0.0.1 to their own machine
 * and show nothing, which is exactly what happened behind the tunnel. So the
 * token stays the single source of truth and the bridge proxies it.
 *
 * Only loopback targets are ever proxied: this turns herdr-web into an open
 * relay otherwise, reachable by anyone who can name a pane.
 */
/**
 * The URL a BROWSER should point at for this pane's advertised view.
 *
 * A raw 127.0.0.1 URL is right on this host and useless to everyone else, so a
 * display we can proxy is rewritten onto our own origin. Both /api/capability
 * and /api/share answer with this, because a button and a tool call handing back
 * different URLs for the same display is a bug waiting to happen.
 */
async function iframeForPane(
  paneId: string,
): Promise<{ url?: string; rejected?: string }> {
  try {
    const tokens = (await call("pane.get", { pane_id: paneId }))?.pane?.tokens ?? {};
    const raw = String(tokens.iframe_url ?? "").trim();
    if (!raw) return {};
    const v = iframeUrlAllowed(raw, IFRAME_POLICY, PORT);
    if (!v.ok) return { rejected: v.reason };
    const t = await sharedTarget(paneId);
    if (!t) return { url: v.url };
    const p = new URL(v.url);
    const tail = p.pathname.replace(/^\/+/, "");
    return {
      url: `/shared/${encodeURIComponent(paneId)}/` +
           (tail === "shared.html" ? "" : tail) + p.search,
    };
  } catch {
    return {};                                  // pane vanished
  }
}

/**
 * Which conversation a pane is writing, preferring the agent's own statement.
 *
 *   stream_session   a token the agent SETS, naming the file it is appending to
 *   agent_session    herdr's detection, which INFERS a session from the process
 *
 * They normally agree. They can disagree when an agent resumes an existing
 * conversation: the process is new, the file is old, and whether detection
 * re-reads or latches the id it first saw is herdr-core behaviour that neither
 * side of this integration controls. The agent that owns the file is the better
 * authority, so ask it first and fall back to detection.
 *
 * The distinction only reaches the transcript path when a pane advertises a
 * session but has no live stream socket — an agent between turns, or one that
 * has exited leaving its conversation on disk. That is exactly the case the
 * resume work creates.
 */
function sessionIdFor(pane: any): string {
  const stated = String(pane?.tokens?.stream_session ?? "").trim();
  if (stated) return stated;
  return String(pane?.agent_session?.value ?? "").trim();
}

/** The pane token TTL. Short on purpose: a crashed session's view expires. */
const ADVERTISE_TTL_MS = 300_000;
const ADVERTISE_REFRESH_MS = 120_000;

function advertise(paneId: string, url: string): Promise<unknown> {
  return call("pane.report_metadata", {
    pane_id: paneId, source: "herdr-web",
    tokens: { iframe_url: url }, ttl_ms: ADVERTISE_TTL_MS,
  });
}

/**
 * Keep a pane's advertisement alive for as long as the pane is.
 *
 * The token carries a TTL so a crashed session's view expires by itself. That
 * is right for the MECHANISM and wrong for the CALLER: an agent that says "here
 * is the report I built" and then carries on working has silently taken it away
 * five minutes later, with nothing anywhere to explain why the button vanished.
 * From the caller's side a TTL is not a safety property, it is a deadline they
 * were never told about.
 *
 * So the bridge renews it. The bridge is the long-lived process that already
 * knows whether the pane still exists, which makes it the only honest place for
 * this — a refresher inside the calling agent dies with the agent, and one in a
 * detached shell outlives the thing it is advertising.
 */
const advertised = new Map<string, { url: string; timer: ReturnType<typeof setInterval> }>();

function stopAdvertising(paneId: string): void {
  const e = advertised.get(paneId);
  if (!e) return;
  clearInterval(e.timer);
  advertised.delete(paneId);
}

function keepAdvertised(paneId: string, url: string): void {
  stopAdvertising(paneId);                        // replacing, not stacking
  const timer = setInterval(async () => {
    try {
      // Stop if the pane is gone, or if somebody else has taken the slot: two
      // renewers fighting over one token is the bug this replaced, from the
      // other direction.
      const pane = (await call("pane.get", { pane_id: paneId }))?.pane;
      const current = String(pane?.tokens?.iframe_url ?? "");
      if (!pane || (current && current !== url)) { stopAdvertising(paneId); return; }
      await advertise(paneId, url);
    } catch {
      stopAdvertising(paneId);                    // pane vanished, or herdr is down
    }
  }, ADVERTISE_REFRESH_MS);
  advertised.set(paneId, { url, timer });
}

async function sharedTarget(paneId: string): Promise<URL | null> {
  try {
    const tokens = (await call("pane.get", { pane_id: paneId }))?.pane?.tokens ?? {};
    const raw = String(tokens.iframe_url ?? "").trim();
    if (!raw) return null;
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname;
    if (h !== "127.0.0.1" && h !== "localhost" && h !== "::1" && h !== "[::1]") return null;
    return u;
  } catch { return null; }
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
  kind: "events" | "terminal" | "stream" | "novnc";
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
  /** Transcript follower, for agents with no live protocol socket. */
  tail?: TranscriptHandle;
  /** The token this socket authenticated with, so it can be cut off later. */
  authTok?: string;
  /** Upstream websockify socket, for a proxied shared display. */
  up?: WebSocket;
  wsTarget?: string;
  /** Frames that arrived before the upstream finished connecting. */
  pending?: Array<string | Uint8Array>;
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

    // Another local server's URL space: proxied before ANY of this bridge's gates apply.

    const proxied = await passthrough(req);

    if (proxied) return proxied;

    if (COOKIE_AUTH) {

      const u0 = new URL(req.url);

      if (req.method === "POST" && u0.pathname === "/login") {

        let raw = "";

        const ct = req.headers.get("content-type") || "";

        try {

          if (ct.includes("json")) raw = String(((await req.json()) as any)?.token ?? "");

          else raw = String((await req.formData()).get("token") ?? "");

        } catch { raw = ""; }

        const tok = tokenFromPasted(raw);

        if (tok && cookieable(tok)) {

          return new Response(null, { status: 303, headers: { location: "/", "set-cookie": setAuthCookie(req, tok), "cache-control": "no-store", "referrer-policy": "no-referrer" } });

        }

        return new Response(null, { status: 303, headers: { location: "/?err=1", "cache-control": "no-store" } });

      }

      if (req.method === "GET" && u0.pathname === "/logout") {

        return new Response(null, { status: 303, headers: { location: "/", "set-cookie": clearAuthCookie(req), "cache-control": "no-store" } });

      }

      // A page visit carrying ?token= for a named user: move the token into the cookie and

      // redirect to the clean URL, so it never sits in the address bar, history or a screenshot.

      const qtok = u0.searchParams.get("token");

      if (qtok && req.method === "GET" && (u0.pathname === "/" || u0.pathname === "/index.html")

          && (req.headers.get("accept") || "").includes("text/html") && cookieable(qtok)) {

        return new Response(null, { status: 303, headers: { location: u0.pathname, "set-cookie": setAuthCookie(req, qtok), "cache-control": "no-store", "referrer-policy": "no-referrer" } });

      }

    }

    if (new URL(req.url).pathname === "/" && !authed(req)) {

      if (LOGIN_PAGE) return loginPage(new URL(req.url).searchParams.get("err") === "1");

      if (UNAUTH_REDIRECT) return Response.redirect(UNAUTH_REDIRECT, 302);

    }
    // Claim-on-first-use, enforced before routing so it covers websockets too.
    const pin = pinGate(req);
    if (pin.deny) {
      return new Response(JSON.stringify({ error: "this link has already been claimed" }), {
        status: 401,
        headers: { "content-type": "application/json", "referrer-policy": "no-referrer" },
      });
    }
    // Every response gets these, rather than each handler remembering to.
    // Referrer-Policy matters most: the token lives in the query string, so any
    // outbound navigation carrying a Referer would hand the URL — and with it
    // control of this machine's shells — to a third party. Individual links
    // already set rel=noreferrer; this covers everything that does not.
    const res = await handleRequest(req, srv);
    if (!res) return res as any;
    try {
      res.headers.set("referrer-policy", "no-referrer");
      res.headers.set("x-content-type-options", "nosniff");
      res.headers.set("x-frame-options", "SAMEORIGIN");
      if (pin.setCookie) res.headers.append("set-cookie", pin.setCookie);
    } catch { /* some responses have immutable headers; not worth failing over */ }
    return res;
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
            // Fall back to the on-disk transcript before giving up.
            let path: string | null = null, sid = "", paneAgent = "";
            try {
              const pane = (await call("pane.get", { pane_id: d.paneId! }))?.pane;
              sid = sessionIdFor(pane);
              paneAgent = String(pane?.agent ?? "");
              if (sid) path = await findTranscript(sid);
            } catch { /* pane vanished */ }
            if (!path) {
              try { ws.send(JSON.stringify({ type: "_nostream" })); ws.close(1000, "no stream"); } catch {}
              return;
            }
            const t = followTranscript(path, { session: sid, agent: paneAgent });
            d.tail = t;
            t.onFrame((f) => { try { ws.send(JSON.stringify(f)); } catch {} });
            t.onClose((reason) => {
              try { ws.send(JSON.stringify({ type: "_closed", reason })); ws.close(1000, reason); } catch {}
            });
            return;
          }
          // A live stream carries no history: the agent sends what happens from
          // now on. For a RESUMED conversation that is most of it — the prior
          // messages are on disk and the pane would render as if the session had
          // just begun. So if the pane names a session we can find a transcript
          // for, anchor history at the file's size AT CONNECT TIME and let the
          // client page backwards through it exactly as it does for a
          // transcript-backed pane. Everything before that offset is history;
          // everything the stream sends is live.
          //
          // The client already understands `historyFrom` on a ready frame — this
          // is the half that was missing, and it was missing on our side of the
          // socket, not the agent's.
          let anchor = 0;
          try {
            const sid2 = sessionIdFor((await call("pane.get", { pane_id: d.paneId! }))?.pane);
            const p2 = sid2 ? await findTranscript(sid2) : null;
            if (p2) anchor = (await stat(p2)).size;
          } catch { /* no transcript for this pane: nothing to page back through */ }

          const h = openStream(cap, { fromSeq: 0, client: `herdr-web/${d.who}` });
          d.stream = h;
          h.onFrame((f) => {
            // Augment only the ready frame, and only when we found something to
            // offer. An agent that sends its own historyFrom keeps it.
            if (anchor > 0 && f?.type === "ready" && f.historyFrom === undefined) {
              f = { ...f, historyFrom: anchor };
            }
            try { ws.send(JSON.stringify(f)); } catch {}
          });
          h.onClose((reason) => {
            try { ws.send(JSON.stringify({ type: "_closed", reason })); ws.close(1000, reason); } catch {}
          });
        })();
        return;
      }

      if (d.kind === "novnc" && d.wsTarget) {
        // RFB is binary and starts talking immediately, so anything the viewer
        // sends before the upstream is ready must be held, not dropped — losing
        // a handshake byte wedges the session with no error anywhere.
        d.pending = [];
        const up = new WebSocket(d.wsTarget);
        up.binaryType = "arraybuffer";
        d.up = up;
        up.onopen = () => {
          for (const m of d.pending ?? []) { try { up.send(m); } catch {} }
          d.pending = [];
        };
        up.onmessage = (ev: any) => {
          try {
            ws.send(ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data);
          } catch {}
        };
        up.onclose = () => { try { ws.close(); } catch {} };
        up.onerror = () => { try { ws.close(1011, "shared display unreachable"); } catch {} };
        return;
      }

      if (d.kind === "terminal" && d.paneId) {
        joinPane(d.paneId, d.who || "operator");
        ws.send(JSON.stringify({ type: "_ready", you: d.who || "operator" }));
      }
    },

    async message(ws, raw) {
      const d = ws.data;

      if (d.kind === "novnc") {
        const payload = typeof raw === "string" ? raw : new Uint8Array(raw as any);
        if (d.up && d.up.readyState === 1) { try { d.up.send(payload); } catch {} }
        else d.pending?.push(payload);
        return;
      }

      if (d.kind === "stream") {
        const txt = typeof raw === "string" ? raw : Buffer.from(raw as any).toString("utf8");
        let m: any; try { m = JSON.parse(txt); } catch { return; }
        // The author is OURS, from the authenticated connection — never the
        // client's claim (docs/PROTOCOL.md §3).
        const who = d.who || "operator";

        // A transcript-backed pane has no protocol channel back to the agent —
        // a file is a record, not a way in. The reply still has to arrive, so it
        // goes the only way available: as pane input, through the same queue the
        // REST path uses. Without this the say was silently dropped while the
        // composer cleared, which looked exactly like a broken send button.
        if (!d.stream) {
          if (d.tail && d.paneId && m.type === "say") {
            const text = String(m.text ?? "");
            if (text.trim()) {
              try {
                const q = enqueueSay(d.paneId, who, text, await attrFmtFor(d.paneId));
                ws.send(JSON.stringify({ type: "_queued", id: q.id, state: q.state }));
              } catch (e) {
                ws.send(JSON.stringify({
                  type: "_sayfailed",
                  reason: e instanceof Error ? e.message : String(e),
                }));
              }
            }
          }
          return;
        }
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
      ws.data.tail?.close();
      if (ws.data.up) { try { ws.data.up.close(); } catch {} }
      ws.data.unsub?.();
      ws.data.session?.release();
      if ((ws.data.kind === "terminal" || ws.data.kind === "stream") && ws.data.paneId) {
        leavePane(ws.data.paneId, ws.data.who || "operator");
      }
    },
  },
});

function tokenOf(req: Request): string {
  return new URL(req.url).searchParams.get("token") || req.headers.get("x-herdr-token") || cookieToken(req) || "";
}

/**
 * Cut off every live socket holding a token that no longer resolves.
 *
 * Without this, revoking a link only stops the NEXT request — an already-open
 * terminal or chat socket keeps streaming, so the device you meant to cut off
 * carries on watching, and typing, indefinitely. Revocation that leaves the
 * existing connection alive is not revocation.
 *
 * 4001 is a private close code the client recognises so it can say what
 * happened and stop trying to reconnect.
 */
function evictRevoked(reason = "link revoked"): number {
  let n = 0;
  for (const ws of liveSockets) {
    const tok = (ws as any)?.data?.authTok;
    if (!tok) continue;
    if (identity.resolve(tok)) continue;
    try { (ws as any).close(4001, reason); } catch {}
    n++;
  }
  if (n) console.log(`[expose] evicted ${n} live connection(s) on a dead token`);
  return n;
}

// Expiry is silent by nature, so sweep for it rather than waiting for traffic.
setInterval(() => evictRevoked("link expired"), 15_000);

const PIN_COOKIE = "hw_claim";

/**
 * A pinned token belongs to whoever opens it first; everyone else is refused,
 * even holding the same token. The claimant is remembered with an HttpOnly
 * cookie, so a leaked URL is useless once it has been used.
 *
 * The claim is taken on the first authenticated API request, NOT on the HTML.
 * Link previews matter here: paste the URL into a chat app and its crawler
 * fetches the page, which would otherwise burn the link before the human ever
 * taps it. A crawler does not run the app's JS, so it never reaches /api.
 */
function pinGate(req: Request): { deny: boolean; setCookie?: string } {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || req.headers.get("x-herdr-token");
  if (!token) return { deny: false };
  const st = identity.pinState(token);
  if (!st || !st.pinned) return { deny: false };

  const cookies = req.headers.get("cookie") ?? "";
  const mine = cookies.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === PIN_COOKIE)?.[1];

  if (st.bound) return { deny: mine !== st.bound };

  // Unclaimed. Only an API call (or a websocket) claims it.
  const claimable = url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/");
  if (!claimable) return { deny: false };
  const secret = identity.claimEphemeral(token);
  if (!secret) return { deny: true };          // lost a race to a concurrent claim
  console.log(`[expose] link claimed — further openers will be refused`);
  return {
    deny: false,
    setCookie: `${PIN_COOKIE}=${secret}; Path=/; HttpOnly;${secureAttr(req)} SameSite=Lax; Max-Age=86400`,
  };
}

async function handleRequest(req: Request, srv: any): Promise<Response | undefined> {
    const url = new URL(req.url);

    // --- WebSocket upgrades -------------------------------------------------
    if (url.pathname === "/ws/events") {
      const u = whoami(req);
      if (!u) return new Response("unauthorized", { status: 401 });
      if (srv.upgrade(req, { data: { kind: "events", who: Identity.label(u), authTok: tokenOf(req) } })) return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/ws/stream/")) {
      const u = whoami(req);
      if (!u) return new Response("unauthorized", { status: 401 });
      const paneId = decodeURIComponent(url.pathname.slice("/ws/stream/".length));
      if (srv.upgrade(req, { data: { kind: "stream", paneId, who: Identity.label(u), authTok: tokenOf(req) } }))
        return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/ws/terminal/")) {
      if (!authed(req)) return new Response("unauthorized", { status: 401 });
      const u = whoami(req);
      if (!u) return new Response("unauthorized", { status: 401 });
      const paneId = decodeURIComponent(url.pathname.slice("/ws/terminal/".length));
      if (srv.upgrade(req, { data: { kind: "terminal", paneId, who: Identity.label(u), authTok: tokenOf(req) } })) return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }

    // --- Shared display proxy ----------------------------------------------
    // Serves the pane's noVNC surface through THIS origin, so it rides whatever
    // tunnel the viewer already came in on. Without it the browser modal only
    // ever worked for a viewer on the same host as herdr-web.
    if (url.pathname.startsWith("/shared/")) {
      const rest = url.pathname.slice("/shared/".length);
      const cut = rest.indexOf("/");
      const paneId = decodeURIComponent(cut === -1 ? rest : rest.slice(0, cut));
      const sub = cut === -1 ? "" : rest.slice(cut + 1);

      // The iframe cannot set headers, and its subrequests carry no query token,
      // so the entry request mints a path-scoped cookie the rest ride on.
      const cookieName = `hw_shared_${paneId.replace(/[^A-Za-z0-9]/g, "_")}`;
      const cookies = req.headers.get("cookie") ?? "";
      const hasCookie = cookies.split(";").some((c) => {
        const [k, v] = c.trim().split("=");
        return k === cookieName && identity.resolve(decodeURIComponent(v ?? "")) !== null;
      });
      const qTok = url.searchParams.get("token");
      const viaQuery = qTok !== null && identity.resolve(qTok) !== null;
      // A cookie-signed-in viewer has no token to put in the iframe URL; the
      // session cookie is Path=/ so every subrequest carries it too.
      const viaSession = identity.resolve(cookieToken(req)) !== null;
      if (!hasCookie && !viaQuery && !viaSession) return new Response("unauthorized", { status: 401 });

      const target = await sharedTarget(paneId);
      if (!target) return new Response("this pane is not sharing a display", { status: 404 });

      // WebSocket: accept here, dial websockify in open(), relay both ways.
      if (sub === "websockify" || sub.endsWith("/websockify")) {
        const wsTarget = `${target.protocol === "https:" ? "wss:" : "ws:"}//${target.host}/websockify`;
        if (srv.upgrade(req, { data: { kind: "novnc", paneId, wsTarget, authTok: tokenOf(req) } })) return undefined as any;
        return new Response("upgrade failed", { status: 400 });
      }

      // The shim itself, served from OUR origin so its relative imports resolve
      // back through this proxy.
      const isEntry = sub === "" || sub === "index.html" || sub === "shared.html";
      const upstream = new URL(isEntry ? "/shared.html" : `/${sub}`, target.origin);
      let res: Response;
      try {
        res = await fetch(upstream, { signal: AbortSignal.timeout(8000) });
      } catch {
        return new Response("shared display is not reachable", { status: 502 });
      }
      const headers = new Headers();
      const ct = res.headers.get("content-type");
      if (ct) headers.set("content-type", ct);
      headers.set("cache-control", "no-cache");
      if (isEntry && viaQuery && qTok) {
        headers.append("set-cookie",
          `${cookieName}=${encodeURIComponent(qTok)}; Path=/shared/${encodeURIComponent(paneId)}; ` +
          `HttpOnly;${secureAttr(req)} SameSite=Lax; Max-Age=28800`);
      }
      return new Response(res.body, { status: res.status, headers });
    }

    // --- JSON API -----------------------------------------------------------
    if (url.pathname.startsWith("/api/")) {
      // ONE unauthenticated probe, deliberately minimal: is anyone viewing this
      // pane in herdr-web? A tool running in a pane needs this to know whether a
      // window it opens on the physical desktop is visible to the person
      // watching — and making it read the admin token to find out would be a far
      // worse trade. It answers a single boolean about a pane the caller already
      // names, and discloses no viewer names, no other panes, and nothing about
      // what any of them contain.
      if (url.pathname === "/api/viewing") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return Response.json({ error: "pane_id required" }, { status: 400 });
        return Response.json({ pane_id: paneId, viewing: (presence.get(paneId)?.size ?? 0) > 0 });
      }

      if (!authed(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

      if (url.pathname === "/api/sessions") {

        if (!RESUME_ENABLED) return Response.json({ error: "not found" }, { status: 404 });

        try { return Response.json({ sessions: await listSessions() }); }

        catch (e: any) { return Response.json({ error: String(e?.message || e) }, { status: 502 }); }

      }


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
          lockLaunch: LOCK_LAUNCH,
          agentName: AGENT_NAME,
          altUiUrl: ALT_UI_URL || null,
          altUiLabel: ALT_UI_LABEL,
          defaultView: DEFAULT_VIEW,
          resume: RESUME_ENABLED,
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
        const m = enqueueSay(pane_id, u.name, text, await attrFmtFor(pane_id));
        return Response.json({ queued: m.id, state: m.state, pending: pendingFor(pane_id).length });
      }

      // Does this pane's agent advertise herdr-agent-stream/1? One pane.get,
      // asked only when a pane is opened — pane.list does not carry tokens, so
      // sweeping every pane on every refresh would cost N extra round trips.
      if (url.pathname === "/api/capability") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return Response.json({ error: "pane_id required" }, { status: 400 });
        const cap = await detectStream(paneId);
        // No live socket? A claude pane still has a transcript on disk, which is
        // enough to render the conversation read-only. Chat then works for every
        // claude pane rather than only those wired for the protocol.
        let transcript: { path: string; session: string } | null = null;
        if (!cap) {
          try {
            const sid = sessionIdFor((await call("pane.get", { pane_id: paneId }))?.pane);
            if (sid) {
              const path = await findTranscript(sid);
              if (path) transcript = { path, session: sid };
            }
          } catch { /* pane vanished */ }
        }

        // An agent advertises a view the same way it advertises a stream:
        // a pane metadata token. Same discovery path, same TTL semantics.
        const resolved = await iframeForPane(paneId);
        const iframe: { url: string } | null = resolved.url ? { url: resolved.url } : null;
        const iframeRejected: string | null = resolved.rejected ?? null;

        return Response.json({
          pane_id: paneId,
          stream: !!cap || !!transcript,
          // "live" speaks the protocol both ways; "transcript" is read-only
          // history the client must not offer to reply into as a protocol say.
          source: cap ? "live" : (transcript ? "transcript" : null),
          capability: cap,
          transcript: transcript ? { session: transcript.session } : null,
          iframe, iframeRejected, iframePolicy: IFRAME_POLICY,
        });
      }

      // Page backwards through a pane's transcript. `before` is the byte offset
      // the client currently holds (from ready.historyFrom, then from each
      // response), so pages abut exactly with no gap and no duplicate.
      if (url.pathname === "/api/history") {
        const paneId = url.searchParams.get("pane_id");
        const before = Number(url.searchParams.get("before") ?? "0");
        if (!paneId || !Number.isFinite(before) || before < 0) {
          return Response.json({ error: "pane_id and non-negative before required" }, { status: 400 });
        }
        if (before === 0) return Response.json({ frames: [], startOffset: 0, done: true });
        try {
          const sid = sessionIdFor((await call("pane.get", { pane_id: paneId }))?.pane);
          const path = sid ? await findTranscript(sid) : null;
          if (!path) return Response.json({ frames: [], startOffset: 0, done: true });
          return Response.json(await readBefore(path, before));
        } catch {
          return Response.json({ frames: [], startOffset: before, done: false });
        }
      }

      // Attachments. The chat cannot hand an agent bytes — it drives a terminal
      // — but every coding agent reads file paths. So a dropped or pasted file
      // is written to a known directory and its PATH goes into the message.
      if (url.pathname === "/api/upload" && req.method === "POST") {
        try {
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof File)) {
            return Response.json({ error: "file field required" }, { status: 400 });
          }
          if (file.size > UPLOAD_MAX) {
            return Response.json(
              { error: `file too large (max ${Math.floor(UPLOAD_MAX / 1048576)}MB)` }, { status: 413 });
          }
          // Name is attacker-controlled: keep an extension for the agent's
          // benefit, discard everything else about the path.
          const base = (file.name || "upload").split(/[\\/]/).pop() || "upload";
          const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(-64) || "upload";
          const dir = join(UPLOAD_DIR, new Date().toISOString().slice(0, 10));
          await mkdir(dir, { recursive: true });
          const path = join(dir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${safe}`);
          await writeFile(path, Buffer.from(await file.arrayBuffer()));
          return Response.json({ path, name: safe, size: file.size, type: file.type || null });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "upload failed" }, { status: 400 });
        }
      }

      // Input arbitration for a shared display. GET reads, POST acts. The owner
      // is taken from the caller's declared side, not inferred: a human clicking
      // "take input" and an agent's driver are different actors on one display.
      if (url.pathname === "/api/input-lock") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return Response.json({ error: "pane_id required" }, { status: 400 });
        if (req.method === "GET") return Response.json(InputLock.status(paneId));
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

        const body = await req.json().catch(() => ({} as any));
        const owner = body?.owner === "agent" ? "agent" : "user";
        const ttl = Number(body?.ttl_ms ?? 30000);
        const act = String(body?.action ?? "claim");

        if (act === "release") return Response.json({ ok: true, state: InputLock.release(paneId, owner) });
        if (act === "heartbeat") return Response.json({ ok: true, state: InputLock.heartbeat(paneId, owner, ttl) });
        if (act === "claim") {
          // Only a human may force. An agent that could seize the display from
          // the person watching it defeats the point of arbitrating at all.
          const force = owner === "user" && !!body?.force;
          const label = typeof body?.label === "string"
            ? body.label.slice(0, 60)
            : (whoami(req)?.name ?? null);
          const r = InputLock.claim(paneId, owner, label, ttl, force);
          return Response.json(r, { status: r.ok ? 200 : 409 });
        }
        return Response.json({ error: "action must be claim|release|heartbeat" }, { status: 400 });
      }

      // Ephemeral access, for handing the UI to something that must not hold a
      // permanent credential — a public tunnel above all.
      if (url.pathname === "/api/expose-token") {
        const me = whoami(req);
        if (!me?.isAdmin) return Response.json({ error: "admin only" }, { status: 403 });
        if (req.method === "POST") {
          const b = await req.json().catch(() => ({} as any));
          const ttl = Number(b?.ttl_ms ?? 8 * 3600_000);
          const label = typeof b?.label === "string" ? b.label : "tunnel";
          const t = identity.mintEphemeral(label, ttl, b?.pin !== false);
          console.log(`[expose] minted an ephemeral token (${label}), expires ${new Date(t.expires).toISOString()}`);
          return Response.json(t);
        }
        if (req.method === "DELETE") {
          const tok = url.searchParams.get("t") ?? "";
          const gone = identity.revokeEphemeral(tok);
          // Kick before replying, so the link is dead the moment this returns.
          const evicted = gone ? evictRevoked("link revoked") : 0;
          if (gone) console.log("[expose] ephemeral token revoked");
          return Response.json({ revoked: gone, evicted, active: identity.ephemeralCount() });
        }
        return new Response("method not allowed", { status: 405 });
      }

      // Open something in a pane's embedded view. One endpoint for both the
      // human (the toolbar button) and an agent (MCP, later), so there is a
      // single place where policy, gating and teardown live.
      if (url.pathname === "/api/share" && req.method === "POST") {
        const b = await req.json().catch(() => ({} as any));
        const paneId = String(b?.pane_id ?? "");
        const action = String(b?.action ?? "");
        if (!paneId) return Response.json({ error: "pane_id required" }, { status: 400 });

        const here = dirname(new URL(import.meta.url).pathname);
        const tools = join(here, "..", "..", "tools");
        // shared-browser.sh shells out to the herdr CLI, so it needs a binary
        // path even though this server talks to herdr over its socket.
        const herdrBin = process.env.HERDR_BIN_PATH
          || join(process.env.HOME ?? "", ".local", "bin", "herdr");
        const env = { ...process.env, HERDR_PANE_ID: paneId, HERDR_BIN_PATH: herdrBin };

        if (action === "url") {
          const raw = String(b?.url ?? "").trim();
          if (!raw) return Response.json({ error: "url required" }, { status: 400 });
          // Check the policy BEFORE advertising: a refusal the caller can read
          // beats a token that silently never renders.
          const v = iframeUrlAllowed(raw, IFRAME_POLICY, PORT);
          if (!v.ok) return Response.json({ error: v.reason }, { status: 400 });
          try {
            await advertise(paneId, v.url);
            keepAdvertised(paneId, v.url);
            return Response.json({ ok: true, url: v.url });
          } catch (e: any) {
            return Response.json({ error: e?.message ?? "could not advertise" }, { status: 502 });
          }
        }

        if (action === "stop") stopAdvertising(paneId);

        if (action === "browser" || action === "stop") {
          const script = join(tools, "shared-browser.sh");
          // Display and port derive from the pane id so two panes never collide,
          // and so "stop" can find what "browser" started without bookkeeping.
          const n = 50 + (Math.abs([...paneId].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 40);
          const args = action === "stop"
            // Pass the port on the stop path too. shared-browser.sh no longer
            // needs it to find websockify, but anything else keyed to the port
            // stays correct without having to remember this asymmetry.
            ? ["--stop", "--display", String(n), "--port", String(6900 + n)]
            : ["--display", String(n), "--port", String(6900 + n),
               ...(b?.geometry ? ["--geometry", String(b.geometry)] : []),
               ...(b?.url ? ["--url", String(b.url)] : []),
               ...(b?.kiosk === false ? ["--no-kiosk"] : [])];
          // Output goes to a FILE, not a pipe. The script leaves background
          // children running by design, they inherit its stdout, and reading a
          // pipe to EOF therefore waits for a process that never exits — the
          // request hung for the full timeout with the display already up.
          const logPath = join(
            process.env.XDG_RUNTIME_DIR || "/tmp",
            `herdr-share-${n}-${Date.now()}.log`,
          );
          try {
            const proc = Bun.spawn([script, ...args], {
              env, stdin: "ignore",
              stdout: Bun.file(logPath), stderr: Bun.file(logPath),
            });
            const timedOut = Symbol("timeout");
            const code = await Promise.race([
              proc.exited,
              new Promise((r) => setTimeout(() => r(timedOut), 45_000)),
            ]);
            if (code === timedOut) {
              proc.kill();
              return Response.json({ error: "shared-browser.sh did not finish in 45s" },
                                   { status: 504 });
            }
            let out = "";
            try { out = readFileSync(logPath, "utf8"); } catch { /* nothing written */ }
            try { unlinkSync(logPath); } catch { /* already gone */ }
            if (code !== 0) {
              return Response.json({ error: out.trim().slice(0, 400) || `exit ${code}` },
                                   { status: 500 });
            }
            // The script advertises the display through pane metadata; read it
            // back rather than reconstructing it, so the caller gets exactly the
            // URL the UI would resolve — proxied onto this origin.
            const view = action === "browser" ? await iframeForPane(paneId) : {};
            return Response.json({
              ok: true, display: n,
              iframe_url: view.url,
              iframe_rejected: view.rejected,
              // The GATE port, never the raw CDP port: handing out 9300+n would
              // let an agent drive the display without holding the input lock.
              cdp_gate_port: action === "browser" ? 9400 + n : undefined,
              output: out.trim().slice(0, 600),
            });
          } catch (e: any) {
            return Response.json({ error: e?.message ?? "spawn failed" }, { status: 500 });
          }
        }

        return Response.json({ error: "action must be url|browser|stop" }, { status: 400 });
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
    // Validators, not lifetimes. With neither, a CDN in front of this is free to
    // pin a stale client indefinitely — and even without one, a browser holds
    // the old app.js across a server restart, which looks exactly like a change
    // that did not take. `no-cache` means revalidate every time, not "do not
    // store": the ETag then makes that revalidation a 304 rather than a refetch.
    const etag = `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 27)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });
    }
    return new Response(body, {
      headers: {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "cache-control": "no-cache",
        etag,
      },
    });
  }


console.log(`
  herdr-web bridge
  ----------------
  url     http://${HOST}:${server.port}/?token=${TOKEN}
  socket  ${socketPath()}
  users   ${identity.describe()}
  launch  ${DEFAULT_LAUNCH_CMD || "(none — new sessions open a shell)"}
  agent   ${AGENT_NAME || "(unbranded)"}
  iframes ${IFRAME_POLICY}${IFRAME_POLICY === "off" ? " (set HERDR_WEB_IFRAMES=loopback to enable)" : ""}
  bound   ${HOST} only (never 0.0.0.0)

  Set HERDR_WEB_TOKEN to pin the token, HERDR_WEB_PORT to change the port.
`);
