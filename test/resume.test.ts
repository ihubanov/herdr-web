import { describe, expect, test } from "bun:test";
import { resumeCommand } from "../src/server/resume.ts";

describe("resumeCommand", () => {
  test("prepends the one env var to the launch command", () => {
    expect(resumeCommand("exec my-agent", "abc-123")).toBe("HERDR_UI_RESUME=abc-123 exec my-agent");
  });
  test("adds the skip flag only when asked", () => {
    expect(resumeCommand(" exec a ", "s1", true)).toBe("HERDR_UI_RESUME=s1 exec a --dangerously-skip-permissions");
  });
  test("null without a launch command", () => {
    expect(resumeCommand("  ", "s1")).toBe(null);
  });
  test("null for an id that is not safe on a command line", () => {
    for (const id of ["", "a b", "a;rm -rf ~", "$(x)", "x".repeat(129)]) expect(resumeCommand("exec a", id)).toBe(null);
  });
});
