import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotStore, FIRST_SLOT, LAST_SLOT } from "../src/server/share-slots.ts";

const fresh = (busy: (n: number) => boolean = () => false) => {
  const file = join(mkdtempSync(join(tmpdir(), "slots-")), "slots.json");
  return { file, s: slotStore(file, busy) };
};

describe("slotStore", () => {
  test("two panes never share a slot", () => {
    const { s } = fresh();
    const a = s.take("w1:p1");
    const b = s.take("w1:p2");
    expect(a).toBe(FIRST_SLOT);
    expect(b).toBe(FIRST_SLOT + 1);
    expect(s.take("w1:p1")).toBe(a);
  });

  test("a preferred slot is used only when no other pane holds it", () => {
    const { s } = fresh();
    expect(s.take("a", 70)).toBe(70);
    expect(s.take("b", 70)).toBe(FIRST_SLOT);
    expect(s.heldByOther("b", 70)).toBe(true);
    expect(s.heldByOther("a", 70)).toBe(false);
  });

  test("skips a display something else is running", () => {
    const { s } = fresh((n) => n === FIRST_SLOT);
    expect(s.take("a")).toBe(FIRST_SLOT + 1);
  });

  test("released slots are reused", () => {
    const { s } = fresh();
    s.take("a");
    s.release("a");
    expect(s.peek("a")).toBe(null);
    expect(s.take("b")).toBe(FIRST_SLOT);
  });

  test("survives a restart through the file", () => {
    const { file, s } = fresh();
    s.take("a"); s.take("b");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: FIRST_SLOT, b: FIRST_SLOT + 1 });
    const again = slotStore(file, () => false);
    expect(again.peek("b")).toBe(FIRST_SLOT + 1);
    expect(again.take("c")).toBe(FIRST_SLOT + 2);
  });

  test("null when every slot is taken", () => {
    const { s } = fresh();
    for (let i = FIRST_SLOT; i <= LAST_SLOT; i++) expect(s.take(`p${i}`)).toBe(i);
    expect(s.take("one-too-many")).toBe(null);
  });
});
