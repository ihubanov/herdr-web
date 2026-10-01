// Tests for the capability-poll rule the client got wrong: a pane the server has
// reported gone kept being asked about every 5s.
//
// This lives outside src/web/ on purpose — everything under that directory is
// served statically by the bridge (bridge.ts WEB_ROOT), so a .ts file there would
// be downloadable.
import { describe, expect, test } from "bun:test";
import { createGonePanes } from "../src/web/pane-poll.js";

const fleet = (...ids: string[]) => ids.map((pane_id) => ({ pane_id }));

describe("createGonePanes", () => {
  test("polls an id it has never heard of", () => {
    expect(createGonePanes().shouldPoll("w5:p2", [])).toBe(true);
  });

  test("does not poll without a selected pane", () => {
    const g = createGonePanes();
    expect(g.shouldPoll(null, [])).toBe(false);
    expect(g.shouldPoll("", [])).toBe(false);
    expect(g.shouldPoll(undefined, [])).toBe(false);
  });

  test("skips an id the server reported gone", () => {
    const g = createGonePanes();
    g.mark("w5:p2");
    expect(g.shouldPoll("w5:p2", [])).toBe(false);
    // Absence from the fleet alone does NOT revive it — that was the bug: the
    // pane is gone, and the fleet simply has not refreshed yet.
    expect(g.has("w5:p2")).toBe(true);
  });

  test("revives the id once the fleet lists it again", () => {
    // Ids are positional: "w5:p2" reappearing means a DIFFERENT pane now holds
    // that id, so the tombstone must not keep hiding it.
    const g = createGonePanes();
    g.mark("w5:p2");
    expect(g.shouldPoll("w5:p2", fleet("w5:p2"))).toBe(true);
    expect(g.has("w5:p2")).toBe(false);
  });

  test("a different pane in the fleet does not revive it", () => {
    const g = createGonePanes();
    g.mark("w5:p2");
    expect(g.shouldPoll("w5:p2", fleet("w4:p4", "w5:p3"))).toBe(false);
    expect(g.has("w5:p2")).toBe(true);
  });

  test("clear() forgets a tombstone — attaching proves the pane is alive", () => {
    const g = createGonePanes();
    g.mark("w5:p2");
    g.clear("w5:p2");
    expect(g.shouldPoll("w5:p2", [])).toBe(true);
  });

  test("mark ignores an empty id, so callers need not guard", () => {
    const g = createGonePanes();
    g.mark(null);
    g.mark(undefined);
    g.mark("");
    expect(g.has("")).toBe(false);
    expect(g.shouldPoll("", [])).toBe(false);
  });

  test("only the tombstoned id is skipped", () => {
    const g = createGonePanes();
    g.mark("w5:p2");
    expect(g.shouldPoll("w4:p4", [])).toBe(true);
  });

  test("two instances do not share state", () => {
    const a = createGonePanes();
    const b = createGonePanes();
    a.mark("w5:p2");
    expect(b.shouldPoll("w5:p2", [])).toBe(true);
  });
});
