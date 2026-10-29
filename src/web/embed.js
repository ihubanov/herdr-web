// @ts-check
// Embed (chromeless) mode: herdr-web rendered inside another app's shell — the
// KAI v2 app iframes `/chat/?embed=1&pane=<id>` into its content area and draws
// the pane list in its own sidebar, so herdr-web's header, sidebar and divider
// must go and the selected pane is chosen by the URL rather than by a click.
//
// Kept apart from app.js so the parsing and the pick are unit-tested (app.js
// itself is not reachable from a test).

/**
 * Read the embed settings from a query string.
 * `embed` is on for `1`, `true` or a bare `?embed`; anything else is off, so a
 * stray `embed=0` does not strip the chrome. `pane` and `brain` only mean
 * anything in embed mode — outside it the full UI already has its own controls.
 * The same goes for the two host-chosen settings:
 *  - `view=chat|terminal`: the pane view to open in, overriding both the
 *    server default and the browser's stored choice. Anything else is null
 *    (no override).
 *  - `controls=0|false`: hide the pane control strip's buttons (view toggle,
 *    `view`, `detach`, read-only/controlling), for a host that does pane
 *    switching in its own sidebar. Shown unless turned off.
 * @param {string} search  location.search, with or without the leading "?"
 * @returns {{ embed: boolean, pane: string | null, brain: boolean,
 *             view: "chat" | "terminal" | null, controls: boolean }}
 */
export function readEmbed(search) {
  const q = new URLSearchParams(search);
  const on = (/** @type {string | null} */ v) => v !== null && (v === "" || v === "1" || v === "true");
  const embed = on(q.get("embed"));
  if (!embed) return { embed: false, pane: null, brain: false, view: null, controls: true };
  const v = q.get("view");
  const c = q.get("controls");
  return {
    embed: true,
    pane: q.get("pane") || null,
    brain: on(q.get("brain")),
    view: v === "chat" || v === "terminal" ? v : null,
    controls: !(c === "0" || c === "false"),
  };
}

/**
 * The fleet entry embed mode should show, once, the first time it is listed.
 * `wanted` is the ?pane= value or the pane the host last asked for over
 * postMessage. With none and `orFocused` set (a bare `?embed=1`), it is the
 * pane herdr has focused. Returns null when there is nothing to do: already
 * picked, or not (yet) in the fleet — the next fleet update tries again.
 * @template {{ pane_id: string, focused?: boolean }} F
 * @param {string | null} wanted
 * @param {F[]} fleet
 * @param {boolean} done          true once the pane has been attached
 * @param {boolean} [orFocused]   fall back to the focused pane when nothing is wanted
 * @returns {F | null}
 */
export function pickEmbedPane(wanted, fleet, done, orFocused = false) {
  if (done) return null;
  if (wanted) return fleet.find((f) => f.pane_id === wanted) ?? null;
  return orFocused ? fleet.find((f) => f.focused) ?? null : null;
}

/** Message types the host shell sends in (`herdr-embed:attach`, `herdr-embed:brain`,
 *  `herdr-embed:view`) and that embed mode posts back (`herdr-embed:ready`,
 *  `herdr-embed:active`). */
export const EMBED_MSG = /** @type {const} */ ({
  attach: "herdr-embed:attach",
  brain: "herdr-embed:brain",
  view: "herdr-embed:view",
  ready: "herdr-embed:ready",
  active: "herdr-embed:active",
});

/**
 * Read a message from the host shell. Only same-origin messages count: the
 * host lives under the same origin (the KAI shell and /chat/ share it), and
 * anything else could be a page that framed this one to steer it.
 * @param {{ origin: string, data: unknown }} ev  the MessageEvent
 * @param {string} origin                        location.origin
 * @returns {{ kind: "attach", pane_id: string } | { kind: "brain" }
 *            | { kind: "view", view: "chat" | "terminal" } | null}
 */
export function readEmbedMessage(ev, origin) {
  if (ev.origin !== origin) return null;
  const d = /** @type {any} */ (ev.data);
  if (!d || typeof d !== "object") return null;
  if (d.type === EMBED_MSG.brain) return { kind: "brain" };
  if (d.type === EMBED_MSG.view && (d.view === "chat" || d.view === "terminal")) {
    return { kind: "view", view: d.view };
  }
  if (d.type === EMBED_MSG.attach && typeof d.pane_id === "string" && d.pane_id && d.pane_id.length <= 200) {
    return { kind: "attach", pane_id: d.pane_id };
  }
  return null;
}
