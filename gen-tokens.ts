#!/usr/bin/env bun
/** Regenerate .env.local with fresh tokens. Existing sessions will break. */
import { randomBytes } from "node:crypto";
import { writeFileSync, chmodSync, existsSync } from "node:fs";

// Flags must not be mistaken for usernames.
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const names = argv.filter((a) => !a.startsWith("-"));
const users = (names.length ? names : ["alice", "bob"])
  .map((n) => [n, randomBytes(24).toString("hex")] as const);
const admin = randomBytes(24).toString("hex");

if (existsSync(".env.local") && !force) {
  // Guard: regenerating invalidates every outstanding URL.
  console.error(".env.local exists — pass --force to overwrite (all current URLs stop working)");
  process.exit(1);
}

writeFileSync(".env.local",
`# herdr-web runtime config. NOT committed - contains live tokens.
export HERDR_WEB_PORT=7878
export HERDR_WEB_TOKEN=${admin}
export HERDR_WEB_USERS="${users.map(([n, t]) => `${n}:${t}`).join(",")}"
export HERDR_BIN="$HOME/.local/bin/herdr"
`);
chmodSync(".env.local", 0o600);
console.log("wrote .env.local (0600)\n");
for (const [n, t] of users) console.log(`  ${n.padEnd(8)} http://127.0.0.1:7878/?token=${t}`);
console.log(`  ${"admin".padEnd(8)} http://127.0.0.1:7878/?token=${admin}`);
