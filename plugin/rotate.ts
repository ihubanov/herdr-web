#!/usr/bin/env bun
/**
 * Action: mint fresh tokens. Every outstanding URL stops working, which is the
 * point — it is the revoke path as well as the setup path.
 *
 *   herdr plugin action invoke herdr-web.rotate-tokens -- alice bob
 */
import { randomBytes } from "node:crypto";
import { readEnv, writeEnv, urlsFor, envPath } from "./config.ts";

const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const env = readEnv();
const tok = () => randomBytes(24).toString("hex");

env.HERDR_WEB_PORT = env.HERDR_WEB_PORT || "7878";
env.HERDR_WEB_TOKEN = tok();
if (names.length) {
  env.HERDR_WEB_USERS = names.map((n) => `${n}:${tok()}`).join(",");
} else if (env.HERDR_WEB_USERS) {
  // Keep the same roster, new secrets.
  env.HERDR_WEB_USERS = env.HERDR_WEB_USERS.split(",")
    .map((p) => p.slice(0, p.indexOf(":")).trim()).filter(Boolean)
    .map((n) => `${n}:${tok()}`).join(",");
}
writeEnv(env);

console.log("Rotated. Previous URLs no longer work.\n");
for (const [name, url] of urlsFor(env)) console.log(`  ${name.padEnd(10)} ${url}`);
console.log(`\nconfig: ${envPath()}`);
console.log("Restart the herdr web server pane to pick these up.");
