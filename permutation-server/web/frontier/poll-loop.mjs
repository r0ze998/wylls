// The page's poll loop (controller.mjs): one tick at a time, and a wake that brings the next tick forward.
//
// A hidden page polls slowly (the reveal-only tick, controller.mjs HIDDEN_POLL); when it is shown again the loop is
// woken: the next tick runs at once (a full read, since the page is no longer hidden) and the one after it is timed by
// the visible cadence — not by the hidden wait that was pending. A wake during a running tick never starts a second
// one alongside it: it asks for one more tick as soon as the running one ends. Reads only: the loop schedules the
// caller's `tick`; it builds, signs and sends nothing.

/**
 * `tick()`: one poll (may be async; a throw is the caller's to report — the loop goes on).
 * `delay()`: seconds until the next tick, asked after each tick ends.
 * `setTimer(fn, ms)` / `clearTimer(handle)`: the timer (setTimeout / clearTimeout in the page; a fake one in tests).
 * Returns `{ start(firstSeconds), wake(), running(), pending() }`.
 */
export function createPollLoop({ tick, delay, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = h => clearTimeout(h) }) {
  let timer = null, busy = false, again = false;
  const schedule = secs => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(run, Math.max(0, Number(secs) || 0) * 1000);
  };
  async function run() {
    timer = null;
    if (busy) { again = true; return; }
    busy = true;
    try { await tick(); } catch { /* the caller's tick reports its own errors */ }
    busy = false;
    if (again) { again = false; schedule(0); } else schedule(delay());
  }
  return Object.freeze({
    start(firstSeconds) { schedule(firstSeconds); },
    /** Shown again (or back from the browser's cache): the next tick now, then the visible cadence. */
    wake() { if (busy) again = true; else schedule(0); },
    running: () => busy,
    pending: () => timer !== null,
  });
}
