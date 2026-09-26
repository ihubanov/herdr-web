#!/usr/bin/env bun
/**
 * herdr-web as MCP tools.
 *
 * An agent running inside a herdr pane can already do all of this with the
 * shell scripts beside this file. The reason to also speak MCP is that a tool
 * DESCRIPTION is read before the tool is used, while a shell script's help is
 * read only after someone thinks to run it — so the rules that actually matter
 * (a browser on the real desktop cannot be shown; the CDP gate refuses until
 * you hold the input lock) arrive before the mistake instead of after it.
 *
 * Everything here delegates to the HTTP API. No display arithmetic, no pane
 * tokens, no process management lives in this file — that was the drift that
 * made `herdr-share browser` and the herdr-web button start two DIFFERENT
 * displays for one pane, because each computed the display number its own way.
 *
 * Transport is stdio JSON-RPC, hand-rolled. The protocol is small, and a
 * dependency-free server is one that still starts in two years.
 *
 * Register it with:
 *   claude mcp add herdr-view -- bun /path/to/tools/mcp-server.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROTOCOL_VERSION = "2024-11-05";

/* ----------------------------------------------------------------- config */

/** herdr-web's own plugin config is the authority for port and token. */
function cfg(key: string): string | null {
  const envf = join(
    process.env.HERDR_PLUGIN_CONFIG_DIR
      ?? join(process.env.HOME ?? "", ".config", "herdr", "plugins", "config", "herdr-web"),
    "env",
  );
  try {
    for (const line of readFileSync(envf, "utf8").split("\n")) {
      const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no config file: fall through to the environment */ }
  return null;
}

const WEB = (process.env.HERDR_WEB_URL
  ?? `http://127.0.0.1:${process.env.HERDR_WEB_PORT ?? cfg("HERDR_WEB_PORT") ?? "7878"}`)
  .replace(/\/$/, "");
const TOKEN = process.env.HERDR_WEB_TOKEN ?? cfg("HERDR_WEB_TOKEN") ?? "";

/**
 * Which pane these tools act on.
 *
 * Resolved per call, not once at startup: an MCP server is long-lived and the
 * environment it was spawned in is the environment it keeps, so caching this
 * would pin the tools to whichever pane happened to start the server.
 */
function pane(given?: string): string {
  const p = (given ?? process.env.HERDR_PANE_ID ?? "").trim();
  if (!p) {
    throw new Error(
      "no pane id. These tools act on a herdr pane: run inside one (herdr sets " +
      "HERDR_PANE_ID), or pass pane_id explicitly.",
    );
  }
  return p;
}

function auth(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${WEB}${path}${TOKEN ? `${sep}token=${encodeURIComponent(TOKEN)}` : ""}`;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(auth(path), { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (e: any) {
    throw new Error(
      `herdr-web is not answering on ${WEB} (${e?.message ?? e}). ` +
      `It runs as a herdr plugin; start it before using these tools.`,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

const post = (path: string, body: unknown) => api(path, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/* ------------------------------------------------------------------ tools */

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: any) => Promise<string>;
}

const paneArg = {
  pane_id: {
    type: "string",
    description: "Which pane to act on. Defaults to the pane this agent runs in.",
  },
} as const;

const TOOLS: Tool[] = [
  {
    name: "show_url",
    description:
      "Show a web page to the user, in a window inside herdr-web. Use it for " +
      "anything you are already serving: a dev server, a rendered report, a " +
      "dashboard. The user gets a movable window; they do not have to leave the " +
      "terminal or find the URL themselves.\n" +
      "The URL must be reachable from the machine herdr-web runs on, and the " +
      "policy is normally loopback-only, so a public URL will be refused — you " +
      "are told why, immediately, rather than nothing appearing.\n" +
      "This CANNOT show a browser window on the user's real desktop: there is no " +
      "surface to stream. For that, use open_shared_browser.\n" +
      "It stays up until you replace it or call close_view — you do not have to " +
      "keep re-sending it.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page to show, e.g. http://127.0.0.1:5173/" },
        ...paneArg,
      },
      required: ["url"],
    },
    async run(a) {
      const r = await post("/api/share", { pane_id: pane(a.pane_id), action: "url", url: String(a.url ?? "") });
      return `Showing ${r.url}\nThe user opens it from the embedded-view button in herdr-web.`;
    },
  },

  {
    name: "open_shared_browser",
    description:
      "Start a browser that BOTH you and the user can drive, and show it to them.\n" +
      "It runs in kiosk mode on a virtual display streamed into the user's " +
      "herdr-web window, so the user watches and can take over; you drive it " +
      "over CDP. Use it when you need a real GUI — a login flow the user must " +
      "complete, a page that needs a human decision, anything you want witnessed.\n" +
      "You cannot drive it until you hold the input lock: the CDP gate refuses " +
      "to forward otherwise, so call take_input first. Connect to the returned " +
      "cdp_url, never to the browser's own debugging port.\n" +
      "Starting it again on the same pane restarts it, it does not stack.\n" +
      "The display CANNOT BE RESIZED once running: a CDP resize or a larger " +
      "viewport will report success and change nothing, because the virtual " +
      "screen is fixed at the size it started with. Pass `geometry` up front if " +
      "the default 1600x1000 is wrong for what you are about to do.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Page to open at startup. Defaults to a blank page." },
        geometry: { type: "string", description: "Display size, e.g. 1600x1000x24. Rarely needed." },
        kiosk: {
          type: "boolean",
          description:
            "Kiosk (no tabs, no address bar) is the default. Pass false when the " +
            "USER will need to navigate by hand, since kiosk leaves them no way to.",
        },
        ...paneArg,
      },
    },
    async run(a) {
      const p = pane(a.pane_id);
      const r = await post("/api/share", {
        pane_id: p, action: "browser",
        ...(a.url ? { url: String(a.url) } : {}),
        ...(a.geometry ? { geometry: String(a.geometry) } : {}),
        ...(a.kiosk === false ? { kiosk: false } : {}),
      });
      const cdp = `http://127.0.0.1:${r.cdp_gate_port}`;
      return [
        `Started on display :${r.display} and shown to the user.`,
        `cdp_url: ${cdp}   (the gate — it refuses until you hold the input lock)`,
        `display: :${r.display}   (for X tools; the same arbitration does not apply there)`,
        r.iframe_rejected ? `NOTE: the user cannot see it — ${r.iframe_rejected}` : "",
        `Take the lock with take_input before driving, and release_input when done.`,
      ].filter(Boolean).join("\n");
    },
  },

  {
    name: "take_input",
    description:
      "Claim the input lock on this pane's shared display, so you may drive it.\n" +
      "The lock is not advisory: the CDP gate refuses to forward while you do " +
      "not hold it. It EXPIRES — renew it by calling this again during long " +
      "work, or the user gets the display back mid-task.\n" +
      "A claim fails while the user holds it. That is deliberate; wait, or ask " +
      "them in chat. You cannot force it.",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "What you are about to do. The user sees this, so make it specific.",
        },
        ttl_ms: { type: "number", description: "How long the claim lasts. Default 30000." },
        ...paneArg,
      },
    },
    async run(a) {
      const p = pane(a.pane_id);
      try {
        const r = await post(`/api/input-lock?pane_id=${encodeURIComponent(p)}`, {
          action: "claim", owner: "agent",
          label: a.label ? String(a.label) : "agent",
          ttl_ms: Number(a.ttl_ms ?? 30_000),
        });
        return `You hold input until ${new Date(r.state?.expires ?? Date.now()).toISOString()}. ` +
               `Renew before then, and release_input when you stop.`;
      } catch (e: any) {
        // A refused claim is an ordinary outcome here, not a failure to report
        // as a broken tool: somebody else is driving.
        return `Refused — ${e?.message ?? e}. The user is driving; wait or ask them.`;
      }
    },
  },

  {
    name: "release_input",
    description:
      "Give the input lock back. Do this as soon as you stop driving: until you " +
      "do, the user is watching a display they cannot touch.",
    inputSchema: { type: "object", properties: { ...paneArg } },
    async run(a) {
      const p = pane(a.pane_id);
      await post(`/api/input-lock?pane_id=${encodeURIComponent(p)}`, { action: "release", owner: "agent" });
      return "Released. The user can drive the display again.";
    },
  },

  {
    name: "view_status",
    description:
      "What this pane is currently showing the user, and who holds input on it. " +
      "Check here first when something you showed does not seem to have arrived: " +
      "a refusal is reported with its reason.",
    inputSchema: { type: "object", properties: { ...paneArg } },
    async run(a) {
      const p = pane(a.pane_id);
      const [cap, lock] = await Promise.all([
        api(`/api/capability?pane_id=${encodeURIComponent(p)}`),
        api(`/api/input-lock?pane_id=${encodeURIComponent(p)}`),
      ]);
      const owner = lock?.owner ?? null;
      return [
        `showing: ${cap?.iframe?.url ?? "nothing"}`,
        cap?.iframeRejected ? `refused: ${cap.iframeRejected}` : "",
        `policy : ${cap?.iframePolicy ?? "unknown"}`,
        `input  : ${owner ? `${owner}${lock.label ? ` (${lock.label})` : ""}` : "free"}`,
      ].filter(Boolean).join("\n");
    },
  },

  {
    name: "close_view",
    description:
      "Stop showing anything, and shut the shared display down if one is running " +
      "for this pane. Call it when you are finished: a shared display is an X " +
      "server, a browser and a VNC server that otherwise keep running.",
    inputSchema: { type: "object", properties: { ...paneArg } },
    async run(a) {
      const p = pane(a.pane_id);
      await post("/api/share", { pane_id: p, action: "stop" });
      return "Stopped. Nothing is being shown and the shared display is down.";
    },
  },
];

/* -------------------------------------------------------------- transport */

function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id: unknown, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  // A notification has no id and must never be answered — replying to one is
  // a protocol error that some clients treat as a fatal desync.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "herdr-view", version: "1.0.0" },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return;

    case "ping":
      return reply(id, {});

    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `no such tool: ${params?.name}`);
      try {
        const text = await tool.run(params?.arguments ?? {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e: any) {
        // A failed tool call is reported IN the result, not as a JSON-RPC error:
        // the model is meant to read it and adapt, and an -32603 is handed to
        // the client as plumbing trouble instead.
        return reply(id, {
          content: [{ type: "text", text: `Failed: ${e?.message ?? e}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return;
      return fail(id, -32601, `method not found: ${method}`);
  }
}

// Line-delimited JSON on stdin. Buffered, because a chunk boundary can fall
// anywhere — including mid-message, which is how a naive reader loses a call
// under load and simply stops responding.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); }
    catch { continue; }                      // not ours to interpret
    void handle(msg).catch((e) => {
      if (msg?.id !== undefined) fail(msg.id, -32603, String(e?.message ?? e));
    });
  }
});
process.stdin.on("end", () => process.exit(0));
