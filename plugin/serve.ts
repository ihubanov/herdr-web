#!/usr/bin/env bun
/** Pane entrypoint: run the bridge, printing each person's URL first. */
import { ensureConfig, urlsFor, envPath } from "./config.ts";

const env = ensureConfig();
for (const [k, v] of Object.entries(env)) process.env[k] = v;
process.env.HERDR_BIN = process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || "herdr";

console.log("herdr web");
console.log("---------");
for (const [name, url] of urlsFor(env)) console.log(`  ${name.padEnd(10)} ${url}`);
console.log(`\n  config  ${envPath()}`);
console.log(`  bound   127.0.0.1 only\n`);

// Restart on crash so a transient failure does not take the UI down for
// everyone; herdr shows this pane's output, so failures stay visible.
for (;;) {
  const p = Bun.spawn(["bun", "src/server/bridge.ts"], {
    cwd: process.env.HERDR_PLUGIN_ROOT || ".",
    stdout: "inherit", stderr: "inherit", env: process.env as any,
  });
  const code = await p.exited;
  console.error(`\n[herdr-web] bridge exited (${code}); restarting in 3s`);
  await new Promise((r) => setTimeout(r, 3000));
}
