#!/usr/bin/env bun
/**
 * cdp-gate — the agent side of input arbitration on a shared display.
 *
 * Chrome's remote-debugging port is the agent's hands. This sits in front of it
 * and refuses to forward unless herdr-web says the agent currently holds the
 * input lock. An agent that ignores the lock cannot drive the display at all,
 * which is the difference between arbitration and an honour system.
 *
 * It gates at CONNECT time, not per message: CDP runs over a long-lived
 * WebSocket, so a connection opened while the agent held the lock would survive
 * losing it. A held lock is therefore re-checked on an interval and open
 * connections are dropped the moment it lapses or moves.
 *
 *   cdp-gate.ts --listen 9471 --target 9371 --pane w3:p16 [--web http://127.0.0.1:7878]
 */
import { connect, createServer, type Socket } from "node:net";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  console.error(`cdp-gate: --${name} is required`);
  process.exit(2);
}

const LISTEN = Number(arg("listen"));
const TARGET = Number(arg("target"));
const PANE = arg("pane");
const WEB = arg("web", "http://127.0.0.1:7878").replace(/\/$/, "");
const TOKEN = process.env.HERDR_WEB_TOKEN || "";
const POLL_MS = 2000;

let agentHolds = false;
const live = new Set<Socket>();

async function poll() {
  try {
    const u = new URL(`${WEB}/api/input-lock`);
    u.searchParams.set("pane_id", PANE);
    if (TOKEN) u.searchParams.set("token", TOKEN);
    const r = await fetch(u, { signal: AbortSignal.timeout(1500) });
    const s: any = await r.json();
    const now = s?.owner === "agent" && (!s.expires || s.expires > Date.now());
    if (agentHolds && !now) {
      // Lost it mid-session: drop everything rather than let an in-flight
      // command land on a display the human has taken back.
      for (const sock of live) { try { sock.destroy(); } catch {} }
      live.clear();
    }
    agentHolds = now;
  } catch {
    // herdr-web unreachable: fail CLOSED. An ungated debugging port on a display
    // someone may be using is worse than an agent that cannot drive.
    if (agentHolds) { for (const sock of live) { try { sock.destroy(); } catch {} } live.clear(); }
    agentHolds = false;
  }
}

const server = createServer((client) => {
  if (!agentHolds) {
    // Answer in HTTP so a driver gets a diagnosable refusal rather than a
    // bare reset it will report as "Chrome is not running".
    const body = JSON.stringify({
      error: "input lock not held by agent",
      pane: PANE,
      hint: "claim it: tools/input-lock.sh claim --pane " + PANE,
    });
    client.end(
      "HTTP/1.1 423 Locked\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" + body);
    return;
  }
  const upstream = connect(TARGET, "127.0.0.1");
  live.add(client);
  const drop = () => {
    live.delete(client);
    try { client.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };
  client.on("error", drop);
  upstream.on("error", drop);
  client.on("close", drop);
  upstream.on("close", drop);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on("error", (e) => { console.error(`cdp-gate: ${e.message}`); process.exit(1); });
server.listen(LISTEN, "127.0.0.1", () => {
  console.error(`cdp-gate: 127.0.0.1:${LISTEN} -> 127.0.0.1:${TARGET} (pane ${PANE})`);
});

void poll();
setInterval(poll, POLL_MS);
