#!/usr/bin/env bun
/**
 * cdp-gate — the agent side of input arbitration on a shared display.
 *
 * Chrome's remote-debugging port is the agent's hands. This sits in front of it
 * and decides, per the mode, whether the agent may use them.
 *
 * co-drive (the default): the agent works alongside the user. The input lock
 * still says who is driving, in the UI and the API, but it does not block: the
 * user taking input does not cut the agent off, and the agent may connect
 * without holding it. An agent such as Squire watches what the user does and
 * works in parallel; dropping it whenever the user touched the display made
 * that impossible.
 *
 * exclusive (HERDR_WEB_CDP_MODE=exclusive or --mode exclusive): it refuses to
 * forward unless herdr-web says the agent holds the input lock, so an agent
 * that ignores the lock cannot drive at all. It gates at CONNECT time, not per
 * message: CDP runs over a long-lived WebSocket, so a connection opened while
 * the agent held the lock would survive losing it. A held lock is therefore
 * re-checked and open connections are dropped the moment it lapses or moves.
 *
 * Both modes refuse new connections when the gate cannot reach herdr-web or
 * its token is rejected: an unverified debugging port is an open one.
 *
 *   cdp-gate.ts --listen 9471 --target 9371 --pane w3:p16 [--web http://127.0.0.1:7878] [--mode co-drive|exclusive]
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
const EXCLUSIVE = arg("mode", process.env.HERDR_WEB_CDP_MODE || "co-drive").trim().toLowerCase() === "exclusive";
const POLL_MS = 2000;

/** Whether a new connection is let through. */
let admit = false;
// Why the gate is shut, so a refusal can say which. "unheld" and "cannot ask"
// look identical to a driver otherwise, and the second is a misconfiguration it
// could fix — exactly the ambiguity that made the lock scripts hard to debug.
let reason: "unheld" | "unauthorized" | "unreachable" | "ok" = "unreachable";
const live = new Set<Socket>();

/** One in-flight poll, shared. A burst of connections must not become a burst
 *  of requests to the bridge. */
let polling: Promise<void> | null = null;
function pollOnce(): Promise<void> {
  if (!polling) polling = poll().finally(() => { polling = null; });
  return polling;
}

/** Take a lock state, from the poll or the push, and act on it. */
function apply(s: any) {
  // In co-drive a lock state the gate could read is all it needs: the lock is
  // shown to both sides but blocks neither.
  const now = !EXCLUSIVE || (s?.owner === "agent" && (!s.expires || s.expires > Date.now()));
  reason = now ? "ok" : "unheld";
  if (admit && !now) {
    // Lost it mid-session: drop everything rather than let an in-flight
    // command land on a display the human has taken back.
    dropAll();
  }
  admit = now;
}

/** Cut every open connection. Only exclusive mode does this: in co-drive a
 *  connection that was verified when it opened keeps working, so a bridge
 *  restart does not stop an agent mid-task. */
function dropAll() {
  if (!EXCLUSIVE) return;
  for (const sock of live) { try { sock.destroy(); } catch {} }
  live.clear();
}

/**
 * The push half: the bridge streams this pane's lock state on every change, so
 * a person taking input back cuts the agent off at once rather than at the next
 * poll — up to POLL_MS during which an in-flight command could still land. The
 * poll stays as the fallback: if this stream is down, the gate still fails
 * closed within POLL_MS.
 */
async function watch() {
  for (;;) {
    try {
      const u = new URL(`${WEB}/api/input-lock/watch`);
      u.searchParams.set("pane_id", PANE);
      if (TOKEN) u.searchParams.set("token", TOKEN);
      const r = await fetch(u);
      if (r.ok && r.body) {
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let cut: number;
          while ((cut = buf.indexOf("\n\n")) !== -1) {
            const event = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try { apply(JSON.parse(line.slice(5))); } catch { /* a bad frame is not a state */ }
            }
          }
        }
      }
    } catch { /* bridge down or restarting: the poll covers it */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function poll() {
  try {
    const u = new URL(`${WEB}/api/input-lock`);
    u.searchParams.set("pane_id", PANE);
    if (TOKEN) u.searchParams.set("token", TOKEN);
    const r = await fetch(u, { signal: AbortSignal.timeout(1500) });
    if (r.status === 401) {
      // Fails closed, but say so: the gate could not ASK, which is a token
      // problem on this side, not the human holding the display.
      if (admit) dropAll();
      admit = false; reason = "unauthorized";
      return;
    }
    apply(await r.json());
  } catch {
    // herdr-web unreachable: fail CLOSED. An ungated debugging port on a display
    // someone may be using is worse than an agent that cannot drive.
    if (admit) dropAll();
    admit = false; reason = "unreachable";
  }
}

const REFUSAL: Record<string, { error: string; hint: string }> = {
  unheld: { error: "input lock not held by agent",
            hint: "claim it: tools/input-lock.sh claim --pane <pane>" },
  unauthorized: { error: "gate cannot read the input lock (401)",
                  hint: "HERDR_WEB_TOKEN is missing or wrong for this gate process" },
  unreachable: { error: "gate cannot reach herdr-web",
                 hint: "is the bridge running on the configured port?" },
  ok: { error: "input lock not held by agent", hint: "" },
};

const server = createServer(async (client) => {
  const early: Buffer[] = [];
  const stash = (c: Buffer) => { early.push(c); };
  client.on("data", stash);

  // Re-ask on EVERY new connection, in both directions, before deciding.
  //
  // Refusing from cached state turns the normal sequence — claim, then drive —
  // into a spurious refusal the caller has to sleep through; that is where the
  // "wait 2-3s after claiming" advice came from.
  //
  // ADMITTING from cached state is the worse half: the human takes the display
  // back and, until the next interval poll, a NEW connection is still let
  // through. Dropping live sockets on the way down was never enough on its own.
  //
  // One local request per new CDP connection, coalesced so a burst is one poll.
  // A driver opens a handful of connections, not thousands.
  await pollOnce();
  if (!admit) {
    // Answer in HTTP so a driver gets a diagnosable refusal rather than a
    // bare reset it will report as "Chrome is not running".
    const r = REFUSAL[reason] ?? REFUSAL.unheld;
    const body = JSON.stringify({
      error: r.error,
      reason,
      pane: PANE,
      hint: r.hint.replace("<pane>", PANE),
    });
    client.off("data", stash);
    client.end(
      "HTTP/1.1 423 Locked\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" + body);
    return;
  }
  // Whatever the client sent while we were asking is already in flight, and it
  // is the HTTP request itself. Capture it and replay it once upstream is
  // connected: with the poll now awaited on every connection, a naive pipe
  // loses those first bytes, upstream never sees a request, and the caller gets
  // an accepted connection that answers nothing — which reads as a hung gate.
  const upstream = connect(TARGET, "127.0.0.1");
  upstream.on("connect", () => {
    client.off("data", stash);
    for (const c of early) upstream.write(c);
    early.length = 0;
    client.pipe(upstream);
  });
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
  upstream.pipe(client);          // client->upstream is piped once connected
});

server.on("error", (e) => { console.error(`cdp-gate: ${e.message}`); process.exit(1); });
server.listen(LISTEN, "127.0.0.1", () => {
  console.error(`cdp-gate: 127.0.0.1:${LISTEN} -> 127.0.0.1:${TARGET} (pane ${PANE})`);
});

void pollOnce();
setInterval(() => void pollOnce(), POLL_MS);
void watch();
