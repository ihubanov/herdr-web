// @ts-check
//
// Which panes the capability poll should still be asking about.
//
// This lives in its own module, rather than inline in app.js, purely so it can
// be tested: app.js does DOM work at import time and exports nothing, so nothing
// in it is reachable from a test runner. The rule below is the one the client
// got wrong — see the commit that introduced it — so it is the part worth
// pinning down. It is plain JavaScript on purpose: the browser loads it directly
// as an ES module, and this repo has no build step to compile a .ts for it.

/**
 * Tracks the pane ids the server has told us are gone.
 *
 * Before this existed, a pane that closed while selected cost a `pane.get` every
 * 5s for as long as the page stayed open, because nothing recorded the answer.
 *
 * A tombstone is NOT permanent. herdr pane ids are positional ("w5:p2"), so the
 * same id can be re-registered as a DIFFERENT pane; an id that reappears in the
 * fleet means exactly that, and must not stay hidden.
 */
export function createGonePanes() {
  /** @type {Set<string>} */
  const gone = new Set();

  return {
    /**
     * Record that the server reported this pane gone. Ignores an empty id, so
     * callers can pass a possibly-unset selection without guarding first.
     * @param {string | null | undefined} paneId
     */
    mark(paneId) {
      if (paneId) gone.add(paneId);
    },

    /**
     * Forget a tombstone: attaching proves the pane is alive, and a reappearing
     * id is a different pane.
     * @param {string | null | undefined} paneId
     */
    clear(paneId) {
      gone.delete(String(paneId));
    },

    /**
     * @param {string | null | undefined} paneId
     * @returns {boolean}
     */
    has(paneId) {
      return gone.has(String(paneId));
    },

    /**
     * Whether the poll should ask about `paneId` right now.
     *
     * Clears a tombstone for an id the fleet lists again — that is a different
     * pane holding a recycled id, so polling resumes. A tombstone for an id the
     * fleet still omits is honoured: absence alone does not revive it.
     *
     * @param {string | null | undefined} paneId
     * @param {Array<{ pane_id: string }>} fleet
     * @returns {boolean}
     */
    shouldPoll(paneId, fleet) {
      if (!paneId) return false;
      if (!gone.has(paneId)) return true;
      if (!fleet.some((f) => f.pane_id === paneId)) return false;
      gone.delete(paneId);
      return true;
    },
  };
}
