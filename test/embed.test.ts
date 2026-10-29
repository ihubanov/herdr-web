// Tests for embed mode's URL parsing and pane pick (src/web/embed.js). Outside
// src/web/ for the same reason as pane-poll.test.ts: that directory is served.
import { describe, expect, test } from "bun:test";
import { pickEmbedPane, readEmbed, readEmbedMessage } from "../src/web/embed.js";

describe("readEmbed", () => {
  test("off when absent", () => {
    expect(readEmbed("?token=x")).toEqual({ embed: false, pane: null, brain: false, view: null, controls: true });
  });
  test("on for 1, true and a bare flag", () => {
    for (const s of ["?embed=1", "?embed=true", "?embed", "embed=1"]) expect(readEmbed(s).embed).toBe(true);
  });
  test("embed=0 does not strip the chrome", () => {
    expect(readEmbed("?embed=0").embed).toBe(false);
  });
  test("reads pane and brain in embed mode", () => {
    expect(readEmbed("?embed=1&pane=w5:p2&brain=1"))
      .toEqual({ embed: true, pane: "w5:p2", brain: true, view: null, controls: true });
  });
  test("ignores pane and brain outside embed mode", () => {
    expect(readEmbed("?pane=w5:p2&brain=1")).toEqual({ embed: false, pane: null, brain: false, view: null, controls: true });
  });
  test("empty pane is no pane", () => {
    expect(readEmbed("?embed=1&pane=").pane).toBe(null);
  });
  test("view takes chat or terminal, nothing else", () => {
    expect(readEmbed("?embed=1&view=chat").view).toBe("chat");
    expect(readEmbed("?embed=1&view=terminal").view).toBe("terminal");
    expect(readEmbed("?embed=1&view=fleet").view).toBe(null);
    expect(readEmbed("?embed=1").view).toBe(null);
  });
  test("controls are shown unless turned off", () => {
    expect(readEmbed("?embed=1").controls).toBe(true);
    expect(readEmbed("?embed=1&controls=1").controls).toBe(true);
    expect(readEmbed("?embed=1&controls=0").controls).toBe(false);
    expect(readEmbed("?embed=1&controls=false").controls).toBe(false);
  });
  test("view and controls mean nothing outside embed mode", () => {
    expect(readEmbed("?view=chat&controls=0")).toEqual({ embed: false, pane: null, brain: false, view: null, controls: true });
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
  const withFocus = [{ pane_id: "w1:p1", focused: false }, { pane_id: "w5:p2", focused: true }];
  test("bare embed falls back to the focused pane", () => {
    expect(pickEmbedPane(null, withFocus, false, true)).toBe(withFocus[1]);
  });
  test("a wanted pane beats the focused one", () => {
    expect(pickEmbedPane("w1:p1", withFocus, false, true)).toBe(withFocus[0]);
  });
  test("no fallback once picked", () => {
    expect(pickEmbedPane(null, withFocus, true, true)).toBe(null);
  });
});

describe("readEmbedMessage", () => {
  const O = "https://kai.example";
  test("reads attach", () => {
    expect(readEmbedMessage({ origin: O, data: { type: "herdr-embed:attach", pane_id: "w5:p2" } }, O))
      .toEqual({ kind: "attach", pane_id: "w5:p2" });
  });
  test("reads brain", () => {
    expect(readEmbedMessage({ origin: O, data: { type: "herdr-embed:brain" } }, O)).toEqual({ kind: "brain" });
  });
  test("reads view chat/terminal", () => {
    expect(readEmbedMessage({ origin: O, data: { type: "herdr-embed:view", view: "chat" } }, O))
      .toEqual({ kind: "view", view: "chat" });
    expect(readEmbedMessage({ origin: O, data: { type: "herdr-embed:view", view: "terminal" } }, O))
      .toEqual({ kind: "view", view: "terminal" });
  });
  test("ignores view with a bad target", () => {
    for (const view of [undefined, "fleet", "", 1]) {
      expect(readEmbedMessage({ origin: O, data: { type: "herdr-embed:view", view } }, O)).toBe(null);
    }
  });
  test("ignores another origin", () => {
    expect(readEmbedMessage({ origin: "https://evil.example", data: { type: "herdr-embed:brain" } }, O)).toBe(null);
  });
  test("ignores attach without a usable pane id", () => {
    for (const pane_id of [undefined, "", 5, "x".repeat(201)]) {
      expect(readEmbedMessage({ origin: O, data: { type: "herdr-embed:attach", pane_id } }, O)).toBe(null);
    }
  });
  test("ignores unrelated messages", () => {
    for (const data of [null, "herdr-embed:brain", { type: "herdr-input-lock" }]) {
      expect(readEmbedMessage({ origin: O, data }, O)).toBe(null);
    }
  });
});
