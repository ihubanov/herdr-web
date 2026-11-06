/**
 * Which X display (and so which ports) each pane's shared browser uses.
 *
 * Display n owns Xvfb :n, noVNC on 6900+n, raw CDP on 9300+n and the CDP gate
 * on 9400+n. That number used to be a hash of the pane id into 40 slots, so two
 * panes could land on the same one: the second pane's start then restarted the
 * first pane's browser and handed both the same gate port. With a 1-in-40
 * chance per pair, that is likely with even a handful of panes sharing.
 *
 * So the bridge hands out slots instead: the lowest free one, recorded per pane
 * and kept in a file, so a bridge restart still finds the display a pane
 * already has. The file lives in the runtime dir because the displays do not
 * survive a reboot either.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const FIRST_SLOT = 50;
export const LAST_SLOT = 89;          // 49 is the brain display; it is not a pane's

export interface SlotStore {
  /** The slot this pane already holds, or null. */
  peek(paneId: string): number | null;
  /**
   * The pane's slot, allocating one if it has none: `prefer` when no other pane
   * holds it, else the lowest free one. Null when all are taken.
   */
  take(paneId: string, prefer?: number): number | null;
  /** Whether some pane other than this one holds slot n. */
  heldByOther(paneId: string, n: number): boolean;
  /** Give the pane's slot back. */
  release(paneId: string): void;
  /** Panes that hold a slot. */
  panes(): string[];
}

/**
 * Is display n in use by something this table did not hand out? Xvfb writes
 * /tmp/.X<n>-lock with its pid; a live pid there means the display is taken
 * (a browser started before slots existed, or anything else on that display).
 * A lock left by a killed server names a dead pid and does not count.
 */
export function displayBusy(n: number): boolean {
  let pid = 0;
  try { pid = parseInt(readFileSync(`/tmp/.X${n}-lock`, "utf8").trim(), 10); } catch { return false; }
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export function slotStore(
  file = join(process.env.XDG_RUNTIME_DIR || "/tmp", "herdr-share-slots.json"),
  busy: (n: number) => boolean = displayBusy,
): SlotStore {
  const map = new Map<string, number>();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const [pane, n] of Object.entries(raw ?? {})) {
      if (Number.isInteger(n) && (n as number) >= FIRST_SLOT && (n as number) <= LAST_SLOT) map.set(pane, n as number);
    }
  } catch { /* no file yet, or unreadable: start empty */ }

  const save = () => {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
      renameSync(tmp, file);
    } catch { /* a lost write costs a restart's memory of slots, not correctness now */ }
  };

  return {
    peek: (paneId) => map.get(paneId) ?? null,
    take(paneId, prefer) {
      const have = map.get(paneId);
      if (have !== undefined) return have;
      const used = new Set(map.values());
      // `prefer` is NOT checked for busy: it is how a display started by the old
      // hashed numbering is adopted by its pane instead of orphaned on upgrade.
      if (prefer !== undefined && prefer >= FIRST_SLOT && prefer <= LAST_SLOT && !used.has(prefer)) {
        map.set(paneId, prefer);
        save();
        return prefer;
      }
      for (let n = FIRST_SLOT; n <= LAST_SLOT; n++) {
        if (used.has(n) || busy(n)) continue;
        map.set(paneId, n);
        save();
        return n;
      }
      return null;
    },
    release(paneId) {
      if (map.delete(paneId)) save();
    },
    heldByOther: (paneId, n) => [...map].some(([p, m]) => m === n && p !== paneId),
    panes: () => [...map.keys()],
  };
}
