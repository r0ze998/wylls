// The effects clock (UX-DESIGN §8.1): the one place in fx/ that reads
// performance.now(). Every effect takes its time from here, in seconds, so
// the whole layer can be slowed, frozen, stepped and rewound together: the
// demo switch (§8.6) captures any effect frame by frame, a hit-stop holds
// every effect for a few frames at once, and a test drives the clock by hand.
//
//   fxNow()            seconds on the effects clock (monotone unless seeked)
//   setRate(n)         0.25 = slow motion, 1 = real time
//   freeze() / play()  stop and resume
//   seek(t)            jump to t seconds and stay frozen
//   step(dt)           advance a frozen clock by dt seconds (default one 60 Hz frame)
//   hitStop(ms)        hold the clock for that many real milliseconds, then go on
//
// The default clock is published as `globalThis.__fxNow` (a function) so a
// module outside fx/ can read effect time without importing this file.

const realMs = () => globalThis.performance?.now?.() ?? Date.now();

/** A clock over `now()` (real milliseconds). Starts running at 0 s. */
export function createClock({ now = realMs } = {}) {
  let rate = 1, frozen = false;
  let base = 0;            // effect seconds at the anchor
  let anchor = null;       // real ms at the anchor (null until first read: no clock call at import)
  let holdUntil = 0;       // real ms until which a hit-stop holds the clock
  const real = () => { const r = now(); if (anchor === null) anchor = r; return r; };
  const read = () => {
    const r = real();
    if (frozen) return base;
    // a hit-stop: time stands at the anchor until it ends, then the anchor moves past it
    if (r < holdUntil) return base;
    if (holdUntil > anchor) { anchor = Math.max(anchor, Math.min(r, holdUntil)); holdUntil = 0; }
    return base + ((r - anchor) / 1000) * rate;
  };
  const rebase = () => { base = read(); anchor = real(); };
  return {
    now: read,
    /** Real milliseconds (unscaled): for throttles, never for an effect's own time. */
    wall: real,
    get rate() { return rate; },
    get frozen() { return frozen; },
    setRate(n) { rebase(); rate = Number.isFinite(n) && n >= 0 ? Math.min(n, 16) : 1; return rate; },
    freeze() { rebase(); frozen = true; },
    play(n) { if (n !== undefined) this.setRate(n); if (!frozen) return; anchor = real(); holdUntil = 0; frozen = false; },
    seek(t) { base = Math.max(0, Number(t) || 0); anchor = real(); holdUntil = 0; frozen = true; return base; },
    step(dt = 1 / 60) { if (!frozen) this.freeze(); base = Math.max(0, base + (Number(dt) || 0)); return base; },
    hitStop(ms) {
      if (frozen || !(ms > 0)) return;
      rebase();
      holdUntil = Math.max(holdUntil, anchor + Math.min(ms, 250));
    },
    state() { return { t: read(), rate, frozen }; },
  };
}

/** The page's effects clock. */
export const clock = createClock();
/** Seconds on the effects clock. */
export const fxNow = () => clock.now();

if (globalThis.__fxNow === undefined) { try { globalThis.__fxNow = fxNow; } catch { /* a frozen global: the import still works */ } }
