/**
 * Extra views: buttons beside "View" that show something else in the same
 * frame. Optional and generic: with no config the UI is exactly as before.
 *
 * herdr-web only connects. A view is either a VNC server someone else runs,
 * which herdr-web shows through its own noVNC viewer and relays to over the
 * same authenticated proxy as the pane displays, or a plain page loaded in the
 * frame under the iframe policy. Nothing here starts, stops or owns what is
 * behind the port, so a view outlives every pane and every bridge restart.
 *
 *   HERDR_WEB_VIEWS=/path/views.json
 *   [{ "id": "android", "label": "Android", "vnc": "127.0.0.1:5987", "resize": "scale" },
 *    { "id": "docs", "label": "Docs", "url": "http://127.0.0.1:8080/" }]
 *
 * or { "views": [...], "reserve": [87] }. A display number a view uses is kept
 * out of the pane browsers' slots: a loopback VNC port 5900+N reserves N, and
 * "reserve" lists any others.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** How the viewer fits a vnc view's screen: scale the picture (the default),
 *  ask the server to resize its screen to the frame, or neither. */
export type ResizeMode = "scale" | "remote" | "none";
export interface VncView { id: string; label: string; icon?: string; kind: "vnc"; host: string; port: number; resize: ResizeMode }
export interface UrlView { id: string; label: string; icon?: string; kind: "url"; url: string }
export type View = VncView | UrlView;
export interface ViewsConfig { views: View[]; reserved: Set<number>; errors: string[] }

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** "host:port", with [v6]:port for IPv6. */
function hostPort(s: string): { host: string; port: number } | null {
  const m = s.trim().match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1] ?? m[2], port };
}

export function parseViews(raw: unknown): ViewsConfig {
  const out: ViewsConfig = { views: [], reserved: new Set(), errors: [] };
  const list = Array.isArray(raw) ? raw : (raw as any)?.views;
  if (!Array.isArray(list)) {
    out.errors.push("expected a list of views, or {\"views\": [...]}");
    return out;
  }
  for (const n of Array.isArray((raw as any)?.reserve) ? (raw as any).reserve : []) {
    if (Number.isInteger(n) && n >= 0 && n <= 99) out.reserved.add(n);
    else out.errors.push(`reserve: ${JSON.stringify(n)} is not a display number 0-99`);
  }
  const seen = new Set<string>();
  for (const [i, e] of list.entries()) {
    const where = `view ${i}${typeof e?.id === "string" ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object") { out.errors.push(`${where}: not an object`); continue; }
    if (typeof e.id !== "string" || !ID.test(e.id)) {
      out.errors.push(`${where}: id must be lowercase letters, digits and dashes`); continue;
    }
    if (seen.has(e.id)) { out.errors.push(`${where}: duplicate id`); continue; }
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim().slice(0, 40) : e.id;
    const icon = typeof e.icon === "string" && e.icon.trim() ? e.icon.trim().slice(0, 8) : undefined;
    const hasVnc = typeof e.vnc === "string", hasUrl = typeof e.url === "string";
    if (hasVnc === hasUrl) { out.errors.push(`${where}: give exactly one of "vnc" or "url"`); continue; }
    if (hasVnc) {
      const hp = hostPort(e.vnc);
      if (!hp) { out.errors.push(`${where}: vnc must be host:port`); continue; }
      // Scale by default: the server behind a view is not ours, and its screen
      // is usually a fixed size (a phone) that must not be resized to the frame.
      let resize: ResizeMode = "scale";
      if (e.resize !== undefined) {
        if (e.resize === "scale" || e.resize === "remote" || e.resize === "none") resize = e.resize;
        else out.errors.push(`${where}: resize must be "scale", "remote" or "none"; using "scale"`);
      }
      out.views.push({ id: e.id, label, icon, kind: "vnc", ...hp, resize });
      if (LOOPBACK.has(hp.host) && hp.port >= 5900 && hp.port <= 5999) out.reserved.add(hp.port - 5900);
    } else {
      let u: URL;
      try { u = new URL(e.url); } catch { out.errors.push(`${where}: url is not a valid URL`); continue; }
      if (u.protocol !== "http:" && u.protocol !== "https:") { out.errors.push(`${where}: url must be http(s)`); continue; }
      out.views.push({ id: e.id, label, icon, kind: "url", url: u.toString() });
    }
    seen.add(e.id);
  }
  return out;
}

/** Read the config file. No path means no views; a bad file means no views and a reason. */
export function loadViews(path: string | undefined): ViewsConfig {
  const p = (path ?? "").trim();
  if (!p) return { views: [], reserved: new Set(), errors: [] };
  const file = p.startsWith("~/") ? homedir() + p.slice(1) : p;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (e: any) { return { views: [], reserved: new Set(), errors: [`${file}: ${e?.message ?? e}`] }; }
  return parseViews(raw);
}
