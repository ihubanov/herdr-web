import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneTokens, runtimeDir } from "../src/server/pane-tokens.ts";

const URL_ = "http://127.0.0.1:7878";
const freshDir = () => join(mkdtempSync(join(tmpdir(), "ptok-")), "panes");

describe("paneTokens", () => {
  test("a token resolves to its own pane and nothing else", () => {
    const t = paneTokens(URL_, freshDir());
    const a = t.ensure("w1:p1");
    const b = t.ensure("w1:p2");
    expect(a).not.toBe(b);
    expect(t.resolve(a)).toBe("w1:p1");
    expect(t.resolve(b)).toBe("w1:p2");
    expect(t.resolve("hwp_nope")).toBe(null);
    expect(t.resolve("")).toBe(null);
    expect(t.resolve(null)).toBe(null);
  });

  test("the file is 0600 in a 0700 dir and says where to ask", () => {
    const dir = freshDir();
    const t = paneTokens(URL_, dir);
    const tok = t.ensure("w1:p1");
    const f = t.fileFor("w1:p1");
    expect(f).toBe(join(dir, "w1%3Ap1.json"));
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ pane_id: "w1:p1", token: tok, url: URL_ });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("sync mints for new panes and revokes gone ones", () => {
    const t = paneTokens(URL_, freshDir());
    t.sync(["a", "b"]);
    const a = t.ensure("a");
    const b = t.ensure("b");
    t.sync(["a"]);
    expect(t.resolve(a)).toBe("a");
    expect(t.resolve(b)).toBe(null);
    expect(existsSync(t.fileFor("b"))).toBe(false);
  });

  test("an empty fleet revokes nothing", () => {
    const t = paneTokens(URL_, freshDir());
    const a = t.ensure("a");
    t.sync([]);
    expect(t.resolve(a)).toBe("a");
  });

  test("a restart keeps the tokens on disk", () => {
    const dir = freshDir();
    const a = paneTokens(URL_, dir).ensure("w2:p9");
    const again = paneTokens(URL_, dir);
    expect(again.resolve(a)).toBe("w2:p9");
    expect(again.ensure("w2:p9")).toBe(a);
  });

  test("runtimeDir: XDG_RUNTIME_DIR, else the user's /run/user dir, else /tmp", () => {
    expect(runtimeDir({ XDG_RUNTIME_DIR: "/x" }, 1000)).toBe("/x");
    expect(runtimeDir({}, 987654)).toBe("/tmp");
    expect(runtimeDir({}, undefined)).toBe("/tmp");
  });
});
