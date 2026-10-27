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
 * @param {string} search  location.search, with or without the leading "?"
 * @returns {{ embed: boolean, pane: string | null, brain: boolean }}
 */
export function readEmbed(search) {
  const q = new URLSearchParams(search);
  const on = (/** @type {string | null} */ v) => v !== null && (v === "" || v === "1" || v === "true");
  const embed = on(q.get("embed"));
  if (!embed) return { embed: false, pane: null, brain: false };
  return { embed: true, pane: q.get("pane") || null, brain: on(q.get("brain")) };
}

/**
 * The fleet entry the embed URL asked for, once, the first time it is listed.
 * Returns null when there is nothing to do: no pane requested, already picked,
 * or not (yet) in the fleet — the next fleet update tries again.
 * @template {{ pane_id: string }} F
 * @param {string | null} wanted  the ?pane= value
 * @param {F[]} fleet
 * @param {boolean} done          true once the pane has been attached
 * @returns {F | null}
 */
export function pickEmbedPane(wanted, fleet, done) {
  if (!wanted || done) return null;
  return fleet.find((f) => f.pane_id === wanted) ?? null;
}
