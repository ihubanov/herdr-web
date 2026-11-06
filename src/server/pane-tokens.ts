/**
 * Per-pane tokens: what a program running IN a pane uses to reach that pane's
 * shared browser and input lock, and nothing else.
 *
 * A card's agent needs to start or reuse its pane's browser (/api/share) and
 * take turns on it (/api/input-lock). Handing it a user token would let it act
 * on every pane and the whole API; trusting any local caller that names a pane
 * would let one card drive another's browser. A token minted per pane and
 * checked against the pane_id it is used for scopes the caller to its own pane.
 *
 * Delivery is a file, never the command line: a token typed into the shell
 * lands in scrollback and history. Each pane gets
 *   $XDG_RUNTIME_DIR/herdr-web/panes/<encodeURIComponent(pane_id)>.json   (0600)
 *   {"pane_id": "...", "token": "...", "url": "http://127.0.0.1:7878"}
 * and a program finds it from HERDR_PANE_ID, which herdr already sets in the pane.
 *
 * Scope, stated plainly: the file is readable by the user the bridge runs as.
 * Where every card runs as that one user, this stops accidental and non-pane
 * callers, not a hostile card reading another card's file. Isolation between
 * people needs separate users or containers.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PaneTokens {
  /** The pane a token belongs to, or null. */
  resolve(token: string | null | undefined): string | null;
  /** The pane's token, minting (and writing its file) if it has none. */
  ensure(paneId: string): string;
  /** Mint for panes that appeared, revoke for panes that went away. */
  sync(paneIds: string[]): void;
  /** Where a pane's file is. */
  fileFor(paneId: string): string;
}

function eq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function paneTokens(
  url: string,
  dir = join(process.env.XDG_RUNTIME_DIR || "/tmp", "herdr-web", "panes"),
): PaneTokens {
  const byPane = new Map<string, string>();
  const fileFor = (paneId: string) => join(dir, `${encodeURIComponent(paneId)}.json`);

  const ready = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* not ours to fix */ }
  };

  const write = (paneId: string, token: string) => {
    ready();
    const f = fileFor(paneId);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pane_id: paneId, token, url }), { mode: 0o600 });
    renameSync(tmp, f);
  };

  // A restart keeps the tokens that are already on disk, so a program holding
  // one does not find it dead just because the bridge restarted.
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const d = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (typeof d?.pane_id === "string" && typeof d?.token === "string" && d.token.length >= 32) {
          byPane.set(d.pane_id, d.token);
          if (d.url !== url) write(d.pane_id, d.token);
        }
      } catch { /* unreadable: ignored, re-minted if its pane is live */ }
    }
  } catch { /* no dir yet */ }

  const ensure = (paneId: string) => {
    let t = byPane.get(paneId);
    if (!t) {
      t = `hwp_${randomBytes(24).toString("base64url")}`;
      byPane.set(paneId, t);
      try { write(paneId, t); } catch (e: any) { console.error(`[pane-tokens] could not write ${fileFor(paneId)}: ${e?.message ?? e}`); }
    }
    return t;
  };

  return {
    resolve(token) {
      if (!token || !token.startsWith("hwp_")) return null;
      for (const [pane, t] of byPane) if (eq(token, t)) return pane;
      return null;
    },
    ensure,
    sync(paneIds) {
      // An empty list is what a failed refresh looks like; revoking every pane
      // on it would kill every card's access for nothing.
      if (!paneIds.length) return;
      const live = new Set(paneIds);
      for (const p of live) ensure(p);
      for (const p of [...byPane.keys()]) {
        if (live.has(p)) continue;
        byPane.delete(p);
        try { unlinkSync(fileFor(p)); } catch { /* already gone */ }
      }
    },
    fileFor,
  };
}
