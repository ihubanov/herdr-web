import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcRepo, inside, KEEP_MARKER, type GcOptions } from "../src/server/worktree-gc.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A repo on main with one commit, in a fresh temp dir. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wtgc-")));
  const r = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", r]);
  writeFileSync(join(r, "a.txt"), "a\n");
  git(r, "add", "a.txt");
  git(r, "commit", "-qm", "init");
  const wt = (name: string, branch = name) => {
    const p = join(root, name);
    git(r, "worktree", "add", "-q", "-b", branch, p);
    return p;
  };
  const commit = (cwd: string, file: string, body: string, msg = file) => {
    writeFileSync(join(cwd, file), body);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", msg);
  };
  return { root, r, wt, commit };
}

const opts = (o: Partial<GcOptions> = {}): GcOptions =>
  ({ dryRun: false, live: [], uid: process.getuid?.() ?? null, minIdleMs: 0, ...o });
const act = (acts: Awaited<ReturnType<typeof gcRepo>>, path: string) => acts.find((a) => a.path === path);

describe("gcRepo", () => {
  test("removes a merged, idle worktree and keeps its branch", async () => {
    const { r, wt, commit } = repo();
    const p = wt("done");
    commit(p, "b.txt", "b\n");
    git(r, "merge", "-q", "--ff-only", "done");
    const a = act(await gcRepo(r, opts()), p);
    expect(a).toMatchObject({ action: "removed", reason: "merged", branch: "done" });
    expect(existsSync(p)).toBe(false);
    expect(git(r, "branch", "--list", "done")).toContain("done");
  });

  test("keeps a branch with work that is not in main", async () => {
    const { r, wt, commit } = repo();
    const p = wt("wip");
    commit(p, "b.txt", "b\n");
    expect(act(await gcRepo(r, opts()), p)).toMatchObject({ action: "kept", reason: "not in main" });
    expect(existsSync(p)).toBe(true);
  });

  test("removes a squash-merged worktree", async () => {
    const { r, wt, commit } = repo();
    const p = wt("sq");
    commit(p, "b.txt", "b\n");
    // The same change landed on main as a different commit. The message differs
    // so it cannot hash to the very same commit, which would read as merged.
    commit(r, "b.txt", "b\n", "squashed: sq");
    expect(act(await gcRepo(r, opts()), p)).toMatchObject({ action: "removed", reason: "squash-merged" });
  });

  test("git refuses a worktree with uncommitted changes, and it stays", async () => {
    const { r, wt } = repo();
    const p = wt("dirty");
    writeFileSync(join(p, "a.txt"), "edited\n");
    expect(act(await gcRepo(r, opts()), p)?.action).toBe("refused");
    expect(existsSync(p)).toBe(true);
  });

  test("keeps a worktree something is in", async () => {
    const { r, wt } = repo();
    const p = wt("busy");
    expect(act(await gcRepo(r, opts({ live: [join(p, "sub")] })), p)).toMatchObject({ action: "kept", reason: "in use" });
  });

  test("keeps a worktree with the keep marker", async () => {
    const { r, wt } = repo();
    const p = wt("pinned");
    writeFileSync(join(p, KEEP_MARKER), "");
    expect(act(await gcRepo(r, opts()), p)).toMatchObject({ action: "kept", reason: "keep marker" });
  });

  test("keeps read-only mirrors, recent and other users' worktrees", async () => {
    const { r, wt } = repo();
    const ro = wt("x-main-ro", "ro");
    expect(act(await gcRepo(r, opts()), ro)?.reason).toBe("read-only mirror");
    const fresh = wt("fresh");
    expect(act(await gcRepo(r, opts({ minIdleMs: 3600_000 })), fresh)?.reason).toBe("recently used");
    expect(act(await gcRepo(r, opts({ uid: 4_000_000 })), fresh)?.reason).toBe("owned by another user");
  });

  test("dry run reports and changes nothing; the main checkout is never listed", async () => {
    const { r, wt } = repo();
    const p = wt("idle");
    const acts = await gcRepo(r, opts({ dryRun: true }));
    expect(act(acts, p)).toMatchObject({ action: "would-remove", reason: "merged" });
    expect(existsSync(p)).toBe(true);
    expect(act(acts, r)).toBeUndefined();
  });
});

describe("inside", () => {
  test("matches the dir and below it, not a sibling with the same prefix", () => {
    expect(inside("/w/a", ["/w/a"])).toBe(true);
    expect(inside("/w/a", ["/w/a/b"])).toBe(true);
    expect(inside("/w/a", ["/w/ab"])).toBe(false);
  });
});
