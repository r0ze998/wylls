// The bell closer (contract section 6.3): at bell_start(b+1) + 20 game-s it calls social.closeBell(b)
// and records.closeBell(b), which write PUB/talk/<b>.json and PUB/minds/<b>.json once. Every bell is
// closed, empty ones too (empty root = 32 zero bytes), because the registrar anchors one memo per
// closed bell. Also the game clock the mind needs (bell of a real instant, deadlines).
//
// Clock model: chain time runs at `scale` x real time. The brain tells the mind `now_game` and `scale`
// with every request, so the clock is anchored on those (error: one HTTP round trip, well under a game
// second at 10x). `genesisTs` (the SEASON_CREATED payload of /h/events, or --genesis-ts) fixes bell 0.
export const CLOSE_DELAY_GAME_S = 20;
/** Real ms the brain must have been silent before the clock follows the chain (server.mjs `catchUpClockFromHerald`) and the closer measures against it. */
export const CHAIN_FOLLOW_SILENT_MS = 30000;

export function createClock({ genesisTs = null, scale = 10, bellSecs = 600, nowMs = () => Date.now() } = {}) {
  let anchor = null; // {game_s, real_ms}
  let lastBrainMs = null; // real ms of the last observe() (the brain's request), not of observeChain()
  let chainUnix = null; // the newest chain unix time a poll of the herald returned (noteChain); it never runs ahead of the chain
  let sc = scale;
  let gts = genesisTs;
  const api = {
    setGenesis(ts) {
      gts = Number(ts);
    },
    genesis: () => gts,
    /** anchor on a request: now_game (unix seconds, game time) at this real instant */
    observe({ now_game, scale: s }, realMs = nowMs()) {
      if (Number.isFinite(now_game)) { anchor = { game_s: now_game, real_ms: realMs }; lastBrainMs = realMs; }
      if (Number.isFinite(s) && s > 0) sc = s;
    },
    /** integ-B: re-anchor on the chain's own unix time (the herald's /h/season latestUnix); does not count as a brain observation */
    observeChain(unix, realMs = nowMs()) {
      if (Number.isFinite(unix)) anchor = { game_s: unix, real_ms: realMs };
    },
    /** season-end race fix: remember the chain's own unix time the herald reported (every successful poll, whether or not it moves the clock) */
    noteChain(unix) {
      if (Number.isFinite(unix) && unix > 0) chainUnix = unix;
    },
    /**
     * The instant the closer measures bell close times against. While the brain is active it is `gameNow`. Once the brain has been silent
     * (the fleet exited, the drain runs, at the end the chain completes and is PAUSED) it is `gameNow` capped at the newest chain time
     * the herald reported: a paused chain never reaches the close instant of its last, unfinished bell, but `gameNow` keeps running on
     * real time between two polls and used to cross it (smoke-r2: bell 109 was closed 17 game-s past the chain's end, after the index).
     * The cost is that a bell closes up to one herald poll later than the extrapolation says, in the drain only.
     */
    closeNow(realMs = nowMs(), silentMs = CHAIN_FOLLOW_SILENT_MS) {
      const g = api.gameNow(realMs);
      if (g == null) return null;
      return chainUnix !== null && api.brainSilentMs(realMs) > silentMs ? Math.min(g, chainUnix) : g;
    },
    /** real ms since the brain last anchored the clock (Infinity: never) */
    brainSilentMs: (realMs = nowMs()) => (lastBrainMs == null ? Infinity : realMs - lastBrainMs),
    scale: () => sc,
    hasAnchor: () => anchor !== null && gts !== null,
    gameNow(realMs = nowMs()) {
      if (!anchor) return null;
      return anchor.game_s + ((realMs - anchor.real_ms) * sc) / 1000;
    },
    bellOf(gameS) {
      return gts == null ? null : Math.floor((gameS - gts) / bellSecs);
    },
    bell(realMs = nowMs()) {
      const g = api.gameNow(realMs);
      return g == null ? null : api.bellOf(g);
    },
    bellStartGame: (b) => gts + b * bellSecs,
    /** real unix ms at which game second g occurs */
    realOfGame(g) {
      return anchor.real_ms + ((g - anchor.game_s) * 1000) / sc;
    },
    bellStartReal: (b) => api.realOfGame(gts + b * bellSecs),
    /** margin of section 3.4: max(3 s real, 60 game-s / scale) */
    marginMs: (minMs = 3000) => Math.max(minMs, (60 / sc) * 1000),
  };
  return api;
}

/**
 * `guard` (optional, mind/seal.mjs `closerGuard`): `enter(bell)` returns a `leave()` or `null` when the season is sealed; a sealed closer closes
 * no bell, now or later (the registrar's season-end publication is the end of the closer, whatever the clock says).
 */
export function createCloser({ clock, social, records, metrics, guard = null, onClosed = () => {}, start = 0, setIntervalFn = setInterval, clearIntervalFn = clearInterval, nowMs = () => Date.now() } = {}) {
  let next = start; // lowest bell not yet closed
  let timer = null;
  let sealed = false;
  const errors = { social: 0, records: 0 };
  async function closeOne(b) {
    let s = null;
    try {
      s = (await social?.closeBell?.(b)) ?? null;
    } catch {
      errors.social += 1;
      metrics?.inc('close_error_social');
      return false;
    }
    let r;
    try {
      r = records.closeBell(b);
    } catch {
      errors.records += 1;
      metrics?.inc('close_error_records');
      return false;
    }
    metrics?.inc('bells_closed');
    try {
      await onClosed(b, { social: s, minds: r });
    } catch {
      metrics?.inc('close_hook_error');
    }
    return true;
  }
  return {
    errors,
    /** close every bell whose close instant (bell_start(b+1) + 20 game-s) has passed; returns the bells closed */
    async tick(realMs = nowMs()) {
      if (sealed || !clock.hasAnchor()) return [];
      const g = clock.closeNow ? clock.closeNow(realMs) : clock.gameNow(realMs);
      const done = [];
      for (let n = 0; n < 500; n++) {
        const b = next;
        if (clock.bellStartGame(b + 1) + CLOSE_DELAY_GAME_S > g) break;
        const leave = guard ? guard.enter(b) : () => {};
        if (!leave) { sealed = true; metrics?.inc('close_refused_sealed'); break; }
        let ok;
        try { ok = await closeOne(b); } finally { leave(); }
        if (!ok) break;
        done.push(b);
        next = b + 1;
      }
      return done;
    },
    /** true once the season-end seal stopped this closer */
    sealed: () => sealed,
    next: () => next,
    setNext(b) {
      next = b;
    },
    startTimer(ms = 1000) {
      if (timer) return;
      timer = setIntervalFn(() => {
        this.tick().catch(() => metrics?.inc('close_tick_error'));
      }, ms);
      timer.unref?.();
    },
    stopTimer() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
  };
}
