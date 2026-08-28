#!/usr/bin/env bun
/** Action: print the URLs. Handy from `herdr plugin action invoke`. */
import { ensureConfig, urlsFor, envPath } from "./config.ts";
const env = ensureConfig();
for (const [name, url] of urlsFor(env)) console.log(`${name.padEnd(10)} ${url}`);
console.log(`\nconfig: ${envPath()}`);
console.log(`Add users:  HERDR_WEB_USERS="alice:tok,bob:tok"  (or run the rotate-tokens action)`);
