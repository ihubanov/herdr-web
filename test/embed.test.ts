// Tests for embed mode's URL parsing and pane pick (src/web/embed.js). Outside
// src/web/ for the same reason as pane-poll.test.ts: that directory is served.
import { describe, expect, test } from "bun:test";
import { pickEmbedPane, readEmbed } from "../src/web/embed.js";

describe("readEmbed", () => {
  test("off when absent", () => {
    expect(readEmbed("?token=x")).toEqual({ embed: false, pane: null, brain: false });
  });
  test("on for 1, true and a bare flag", () => {
    for (const s of ["?embed=1", "?embed=true", "?embed", "embed=1"]) expect(readEmbed(s).embed).toBe(true);
  });
  test("embed=0 does not strip the chrome", () => {
    expect(readEmbed("?embed=0").embed).toBe(false);
  });
  test("reads pane and brain in embed mode", () => {
    expect(readEmbed("?embed=1&pane=w5:p2&brain=1")).toEqual({ embed: true, pane: "w5:p2", brain: true });
  });
  test("ignores pane and brain outside embed mode", () => {
    expect(readEmbed("?pane=w5:p2&brain=1")).toEqual({ embed: false, pane: null, brain: false });
  });
  test("empty pane is no pane", () => {
    expect(readEmbed("?embed=1&pane=").pane).toBe(null);
  });
});

describe("pickEmbedPane", () => {
  const fleet = [{ pane_id: "w1:p1" }, { pane_id: "w5:p2" }];
  test("returns the requested pane", () => {
    expect(pickEmbedPane("w5:p2", fleet, false)).toBe(fleet[1]);
  });
  test("null once already picked, so a later fleet update does not re-attach", () => {
    expect(pickEmbedPane("w5:p2", fleet, true)).toBe(null);
  });
  test("null while the pane is not listed yet", () => {
    expect(pickEmbedPane("w9:p9", fleet, false)).toBe(null);
  });
  test("null when no pane was requested", () => {
    expect(pickEmbedPane(null, fleet, false)).toBe(null);
  });
});
