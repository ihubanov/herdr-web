// Who may close what hangs on these flags (bridge.ts ADMIN_ONLY / NO_GUESTS).
import { describe, expect, test } from "bun:test";
import { Identity } from "../src/server/identity.ts";

describe("Identity.resolve", () => {
  const id = new Identity("ivo:tokIvo,ana:tokAna", "tokAdmin");
  test("admin token is admin, not a guest", () => {
    expect(id.resolve("tokAdmin")).toEqual({ name: "admin", isAdmin: true, guest: false });
  });
  test("a named user is neither admin nor guest", () => {
    expect(id.resolve("tokIvo")).toEqual({ name: "ivo", isAdmin: false, guest: false });
  });
  test("an ephemeral token is a guest", () => {
    const { token } = id.mintEphemeral("visitor", 60_000);
    expect(id.resolve(token)).toEqual({ name: "visitor", isAdmin: false, guest: true });
  });
  test("an unknown token is rejected", () => {
    expect(id.resolve("nope")).toBe(null);
    expect(id.resolve("")).toBe(null);
  });
});
