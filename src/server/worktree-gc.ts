/**
 * Worktree GC: remove the checkouts of finished work, never the work itself.
 *
 * herdr makes a git worktree per pane or space and never removes it when the
 * pane closes; removal is a manual, unbound action. On a host that runs many
 * agents that is unbounded: one laptop reached 705 worktrees and 24 GB.
 *
 * The contract, which is what makes it safe to run unattended:
 *  - Only the checkout directory goes. A branch is never deleted, so every
 *    commit stays in the repo.
 *  - `git worktree remove` without --force. git refuses a worktree with
 *    modified or untracked files, so uncommitted work is never lost.
 *  - Only work already in main: the worktree's HEAD is an ancestor of main
 *    (merged), or merging it into main changes nothing (squash-merged).
 *  - Kept: the main checkout, locked worktrees, `*-main-ro` mirrors, a
 *    worktree holding a KEEP_MARKER file, one a process or pane is in, one
 *    touched recently, and one owned by another user.
 *
 * The last two are about seeing in-use worktrees reliably. Whether a process
 * is inside a worktree is read from /proc/<pid>/cwd, which only shows the
 * processes of the user the bridge runs as. A worktree owned by someone else
 * may be in use by a process we cannot see, so it is not ours to judge.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** A file of this name in a worktree's root keeps it, whatever its state. */
export const KEEP_MARKER = ".herdr-keep";

export interface GcAction {
  repo: string;
  path: string;
  branch: string;
  action: "removed" | "would-remove" | "refused" | "kept";
  reason: string;
}

export interface GcOptions {
  /** Report what would go and change nothing. */
  dryRun: boolean;
  /** Directories in use (process and pane cwds); a worktree containing one is kept. */
  live: string[];
  /** Only worktrees owned by this uid are touched; null skips the check. */
  uid: number | null;
  /** A worktree touched more recently than this is kept. */
  minIdleMs?: number;
  now?: number;
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((done) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 60_000 }, (e, out, err) =>
      done({ ok: !e, out: String(out ?? "").trim(), err: String(err ?? "").trim() }));
  });
}

interface Worktree { path: string; head: string; branch: string; locked: boolean; bare: boolean }

async function worktrees(repo: string): Promise<Worktree[]> {
  const r = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const out: Worktree[] = [];
  for (const block of r.out.split(/\n\s*\n/)) {
    const w: Worktree = { path: "", head: "", branch: "(detached)", locked: false, bare: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) w.path = line.slice(9);
      else if (line.startsWith("HEAD ")) w.head = line.slice(5);
      else if (line.startsWith("branch ")) w.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "locked" || line.startsWith("locked ")) w.locked = true;
      else if (line === "bare") w.bare = true;
    }
    if (w.path) out.push(w);
  }
  return out;
}

/** Is any of these directories the worktree or inside it? */
export function inside(path: string, dirs: string[]): boolean {
  return dirs.some((d) => d === path || d.startsWith(path + "/"));
}

/** Newest of the worktree dir and its git HEAD/index: when anyone last worked in it. */
async function lastTouched(path: string): Promise<number> {
  let t = 0;
  const bump = (p: string) => { try { t = Math.max(t, statSync(p).mtimeMs); } catch { /* absent */ } };
  bump(path);
  const gd = await git(path, ["rev-parse", "--absolute-git-dir"]);
  if (gd.ok) { bump(join(gd.out, "HEAD")); bump(join(gd.out, "index")); }
  return t;
}

/** Every directory a visible process is in, or null when /proc cannot be read. */
export function processCwds(): string[] | null {
  let pids: string[];
  try { pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { return null; }
  const out = new Set<string>();
  for (const p of pids) { try { out.add(readlinkSync(`/proc/${p}/cwd`)); } catch { /* gone, or not ours */ } }
  return [...out];
}

/** One pass over one repo's worktrees. */
export async function gcRepo(repo: string, o: GcOptions): Promise<GcAction[]> {
  const minIdle = o.minIdleMs ?? 24 * 3600_000;
  const now = o.now ?? Date.now();
  const main = (await git(repo, ["rev-parse", "--verify", "-q", "origin/main"])).out
    || (await git(repo, ["rev-parse", "--verify", "-q", "main"])).out;
  if (!main) return [];
  const mainTree = (await git(repo, ["rev-parse", `${main}^{tree}`])).out;

  const acts: GcAction[] = [];
  const all = await worktrees(repo);
  // The first entry is always the main worktree, which is never a candidate.
  for (const w of all.slice(1)) {
    const keep = (reason: string) => acts.push({ repo, path: w.path, branch: w.branch, action: "kept", reason });
    if (w.bare) { keep("bare"); continue; }
    if (w.locked) { keep("locked"); continue; }
    if (basename(w.path).endsWith("-main-ro")) { keep("read-only mirror"); continue; }
    if (!existsSync(w.path)) { keep("directory missing"); continue; }
    if (existsSync(join(w.path, KEEP_MARKER))) { keep("keep marker"); continue; }
    if (o.uid !== null) {
      let owner = -1;
      try { owner = statSync(w.path).uid; } catch { /* unreadable: not ours */ }
      if (owner !== o.uid) { keep("owned by another user"); continue; }
    }
    if (inside(w.path, o.live)) { keep("in use"); continue; }
    if (now - (await lastTouched(w.path)) < minIdle) { keep("recently used"); continue; }

    let why = "";
    if ((await git(repo, ["merge-base", "--is-ancestor", w.head, main])).ok) why = "merged";
    else {
      const mt = await git(repo, ["merge-tree", "--write-tree", main, w.head]);
      if (mt.ok && mt.out.split("\n")[0] === mainTree) why = "squash-merged";
    }
    if (!why) { keep("not in main"); continue; }

    if (o.dryRun) { acts.push({ repo, path: w.path, branch: w.branch, action: "would-remove", reason: why }); continue; }
    const rm = await git(repo, ["worktree", "remove", w.path]);
    acts.push({
      repo, path: w.path, branch: w.branch,
      action: rm.ok ? "removed" : "refused",
      reason: rm.ok ? why : (rm.err.split("\n")[0] || "git refused"),
    });
  }
  if (!o.dryRun && acts.some((a) => a.action === "removed")) await git(repo, ["worktree", "prune"]);
  return acts;
}
