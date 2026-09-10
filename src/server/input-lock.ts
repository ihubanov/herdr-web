/**
 * Input arbitration for a shared display.
 *
 * A shared browser has two drivers — a human through noVNC and an agent through
 * CDP/XTEST — pointed at one X display. Without arbitration they fight: the
 * pointer jumps mid-drag, keystrokes interleave into the same field, and neither
 * side can tell whether what it just saw was its own doing.
 *
 * The lock is per pane, single-owner, and always expires. A held lock with no
 * heartbeat is indistinguishable from a crashed holder, so holding one forever
 * is not a state this allows: miss the renewals and it lapses.
 *
 * Enforcement differs by side, deliberately:
 *   - the human's RFB client is put in viewOnly, so its input never leaves the
 *     browser (see the noVNC shim);
 *   - the agent's CDP port is gated, so a driver that ignores the lock cannot
 *     connect at all.
 * Neither side is asked to be polite about it.
 */

export type Owner = "user" | "agent";

export interface LockState {
  owner: Owner | null;
  /** Who asked, by name, for display — not an authorisation check. */
  label: string | null;
  since: number | null;
  expires: number | null;
  /** Set when the other side asked for it while this one held it. */
  requestedBy: Owner | null;
  requestedAt: number | null;
}

interface Entry extends LockState { timer: ReturnType<typeof setTimeout> | null }

const DEFAULT_TTL = 30_000;
/** A lock nobody renews lapses; this bounds how long a crash can wedge it. */
const MAX_TTL = 300_000;

const locks = new Map<string, Entry>();
const listeners = new Set<(paneId: string, s: LockState) => void>();

function blank(): Entry {
  return { owner: null, label: null, since: null, expires: null,
           requestedBy: null, requestedAt: null, timer: null };
}

function pub(e: Entry): LockState {
  const { timer, ...rest } = e;
  void timer;
  return rest;
}

function entry(paneId: string): Entry {
  let e = locks.get(paneId);
  if (!e) { e = blank(); locks.set(paneId, e); }
  return e;
}

function notify(paneId: string, e: Entry) {
  for (const cb of listeners) { try { cb(paneId, pub(e)); } catch { /* a bad listener is not the lock's problem */ } }
}

function arm(paneId: string, e: Entry) {
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (!e.expires) return;
  const ms = Math.max(0, e.expires - Date.now());
  e.timer = setTimeout(() => {
    // Lapsed rather than released: the holder stopped renewing.
    const cur = locks.get(paneId);
    if (!cur || !cur.expires || cur.expires > Date.now()) return;
    Object.assign(cur, blank());
    notify(paneId, cur);
  }, ms + 50);
}

export function status(paneId: string): LockState {
  const e = entry(paneId);
  if (e.expires && e.expires <= Date.now()) { Object.assign(e, blank()); }
  return pub(e);
}

/**
 * Claim the lock. Free locks are granted; a held lock is NOT stolen — the
 * request is recorded so the holder's UI can offer to hand over. `force` exists
 * for the human only, because a person watching a stuck agent needs a way in
 * that does not depend on that agent still working.
 */
export function claim(
  paneId: string, owner: Owner, label: string | null, ttlMs = DEFAULT_TTL, force = false,
): { ok: boolean; state: LockState; reason?: string } {
  const e = entry(paneId);
  if (e.expires && e.expires <= Date.now()) Object.assign(e, blank());
  const ttl = Math.min(Math.max(1000, ttlMs), MAX_TTL);

  if (e.owner && e.owner !== owner && !force) {
    e.requestedBy = owner;
    e.requestedAt = Date.now();
    notify(paneId, e);
    return { ok: false, state: pub(e), reason: `held by ${e.owner}` };
  }
  if (e.owner !== owner) { e.since = Date.now(); e.requestedBy = null; e.requestedAt = null; }
  e.owner = owner;
  e.label = label;
  e.expires = Date.now() + ttl;
  arm(paneId, e);
  notify(paneId, e);
  return { ok: true, state: pub(e) };
}

/** Renew without changing owner. Renewing a lock you do not hold is a no-op. */
export function heartbeat(paneId: string, owner: Owner, ttlMs = DEFAULT_TTL): LockState {
  const e = entry(paneId);
  if (e.owner === owner) {
    e.expires = Date.now() + Math.min(Math.max(1000, ttlMs), MAX_TTL);
    arm(paneId, e);
  }
  return pub(e);
}

export function release(paneId: string, owner: Owner): LockState {
  const e = entry(paneId);
  // Releasing someone else's lock is ignored rather than an error: it is what a
  // stale client does on reconnect, and it must not disturb the real holder.
  if (e.owner && e.owner !== owner) return pub(e);
  if (e.timer) clearTimeout(e.timer);
  Object.assign(e, blank());
  notify(paneId, e);
  return pub(e);
}

export function onChange(cb: (paneId: string, s: LockState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Drop all state for a pane that has gone away. */
export function forget(paneId: string) {
  const e = locks.get(paneId);
  if (e?.timer) clearTimeout(e.timer);
  locks.delete(paneId);
}
