import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadViews, parseViews } from "../src/server/views.ts";

describe("parseViews", () => {
  test("a vnc view and a url view", () => {
    const c = parseViews([
      { id: "android", label: "Android", vnc: "127.0.0.1:5987" },
      { id: "docs", url: "http://127.0.0.1:8080/" },
    ]);
    expect(c.errors).toEqual([]);
    expect(c.views).toEqual([
      { id: "android", label: "Android", icon: undefined, kind: "vnc", host: "127.0.0.1", port: 5987, resize: "scale" },
      { id: "docs", label: "docs", icon: undefined, kind: "url", url: "http://127.0.0.1:8080/" },
    ]);
  });

  test("a loopback VNC port reserves its display; reserve adds more", () => {
    const c = parseViews({ views: [{ id: "a", vnc: "localhost:5987" }, { id: "b", vnc: "10.0.0.5:5990" }], reserve: [70] });
    expect([...c.reserved].sort()).toEqual([70, 87]);
  });

  test("resize defaults to scale; a bad one is reported and falls back", () => {
    const c = parseViews([
      { id: "r", vnc: "127.0.0.1:5901", resize: "remote" },
      { id: "x", vnc: "127.0.0.1:5902", resize: "stretch" },
    ]);
    expect(c.views.map((v) => (v as any).resize)).toEqual(["remote", "scale"]);
    expect(c.errors.length).toBe(1);
  });

  test("IPv6 host:port", () => {
    expect(parseViews([{ id: "v6", vnc: "[::1]:5901" }]).views[0]).toMatchObject({ host: "::1", port: 5901 });
  });

  test("bad entries are skipped with a reason, good ones kept", () => {
    const c = parseViews([
      { id: "Bad Id", vnc: "127.0.0.1:5900" },
      { id: "both", vnc: "127.0.0.1:5900", url: "http://x/" },
      { id: "neither" },
      { id: "noport", vnc: "127.0.0.1" },
      { id: "ftp", url: "ftp://x/" },
      { id: "ok", vnc: "127.0.0.1:5901" },
      { id: "ok", vnc: "127.0.0.1:5902" },
    ]);
    expect(c.views.map((v) => v.id)).toEqual(["ok"]);
    expect(c.errors.length).toBe(6);
  });

  test("not a list is an error, not a crash", () => {
    expect(parseViews({ nope: 1 }).errors.length).toBe(1);
    expect(parseViews(null).views).toEqual([]);
  });
});

describe("loadViews", () => {
  test("no path means no views and no errors", () => {
    expect(loadViews(undefined)).toEqual({ views: [], reserved: new Set(), errors: [] });
  });

  test("reads a file; a broken one gives a reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "views-"));
    writeFileSync(join(dir, "ok.json"), JSON.stringify([{ id: "a", vnc: "127.0.0.1:5987" }]));
    writeFileSync(join(dir, "bad.json"), "{");
    expect(loadViews(join(dir, "ok.json")).views.length).toBe(1);
    const bad = loadViews(join(dir, "bad.json"));
    expect(bad.views).toEqual([]);
    expect(bad.errors.length).toBe(1);
  });
});
