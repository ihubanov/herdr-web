import { afterAll, describe, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";

const GATE = join(import.meta.dir, "..", "tools", "cdp-gate.ts");
const cleanup: Array<() => void> = [];
afterAll(() => { for (const c of cleanup) { try { c(); } catch { /* already gone */ } } });

function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => done(p));
    });
  });
}

/** Stands in for Chrome's debugging port: greets every connection. */
async function target(): Promise<number> {
  const port = await freePort();
  const s: Server = createServer((c) => c.end("HELLO-FROM-CHROME")).listen(port, "127.0.0.1");
  cleanup.push(() => s.close());
  return port;
}

/** Stands in for herdr-web: the user holds the lock. */
async function bridge(): Promise<string> {
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/input-lock") return Response.json({ owner: "user", expires: Date.now() + 60_000 });
      return new Response("not found", { status: 404 });
    },
  });
  cleanup.push(() => srv.stop(true));
  return `http://127.0.0.1:${srv.port}`;
}

async function gate(web: string, mode: string | null): Promise<number> {
  const listen = await freePort();
  const tgt = await target();
  const proc = Bun.spawn(["bun", GATE, "--listen", String(listen), "--target", String(tgt), "--pane", "w1:p1",
                          "--web", web, ...(mode ? ["--mode", mode] : [])],
                         { stdout: "ignore", stderr: "ignore", env: { ...process.env, HERDR_WEB_CDP_MODE: "" } });
  cleanup.push(() => proc.kill());
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((done) => {
      const c = connect(listen, "127.0.0.1", () => { c.destroy(); done(true); });
      c.on("error", () => done(false));
    });
    if (up) return listen;
    await Bun.sleep(100);
  }
  throw new Error("gate did not start");
}

/** Open a connection through the gate and return everything it answers. */
function through(port: number): Promise<string> {
  return new Promise((done) => {
    let got = "";
    const c = connect(port, "127.0.0.1", () => c.write("GET /json/version HTTP/1.1\r\nHost: x\r\n\r\n"));
    c.on("data", (d) => { got += d.toString(); });
    c.on("close", () => done(got));
    c.on("error", () => done(got));
    setTimeout(() => { c.destroy(); }, 4000);
  });
}

describe("cdp-gate while the user holds input", () => {
  test("co-drive (the default) lets the agent through", async () => {
    const port = await gate(await bridge(), null);
    expect(await through(port)).toContain("HELLO-FROM-CHROME");
  });

  test("exclusive refuses it with 423 unheld", async () => {
    const port = await gate(await bridge(), "exclusive");
    const got = await through(port);
    expect(got).toContain("423 Locked");
    expect(got).toContain('"reason":"unheld"');
  });

  test("co-drive still refuses when it cannot reach herdr-web", async () => {
    const port = await gate(`http://127.0.0.1:${await freePort()}`, "co-drive");
    const got = await through(port);
    expect(got).toContain("423 Locked");
    expect(got).toContain('"reason":"unreachable"');
  });
});
