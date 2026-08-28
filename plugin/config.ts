/**
 * Plugin config lives in HERDR_PLUGIN_CONFIG_DIR, not the plugin root.
 *
 * herdr's plugin docs are explicit about this: a GitHub-installed plugin root
 * is a managed source checkout, so credentials written there are lost on
 * reinstall. The config dir is the documented home for user-editable `.env`
 * files and herdr creates it for us.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export function configDir(): string {
  const d = process.env.HERDR_PLUGIN_CONFIG_DIR
    || join(process.env.HOME || ".", ".config", "herdr", "plugins", "herdr-web");
  mkdirSync(d, { recursive: true });
  return d;
}

export const envPath = () => join(configDir(), "env");

export function readEnv(): Record<string, string> {
  const p = envPath();
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function writeEnv(vars: Record<string, string>) {
  const body = "# herdr-web config. Contains live tokens — keep private.\n"
    + Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n";
  writeFileSync(envPath(), body);
  chmodSync(envPath(), 0o600);
}

/** First run: mint an admin token so the plugin works with no setup. */
export function ensureConfig(): Record<string, string> {
  const env = readEnv();
  if (!env.HERDR_WEB_TOKEN) {
    env.HERDR_WEB_TOKEN = randomBytes(24).toString("hex");
    env.HERDR_WEB_PORT = env.HERDR_WEB_PORT || "7878";
    writeEnv(env);
  }
  return env;
}

export function urlsFor(env: Record<string, string>): Array<[string, string]> {
  const port = env.HERDR_WEB_PORT || "7878";
  const base = `http://127.0.0.1:${port}/?token=`;
  const rows: Array<[string, string]> = [];
  for (const pair of (env.HERDR_WEB_USERS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) rows.push([pair.slice(0, i).trim(), base + pair.slice(i + 1).trim()]);
  }
  rows.push(["admin", base + (env.HERDR_WEB_TOKEN || "")]);
  return rows;
}
