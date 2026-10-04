// The bell closer (contract section 6.3): at bell_start(b+1) + 20 game-s it calls social.closeBell(b)
// and records.closeBell(b), which write PUB/talk/<b>.json and PUB/minds/<b>.json once. Every bell is
// closed, empty ones too (empty root = 32 zero bytes), because the registrar anchors one memo per
// closed bell. Also the game clock the mind needs (bell of a real instant, deadlines).
//
// Clock model: chain time runs at `scale` x real time. The brain tells the mind `now_game` and `scale`
// with every request, so the clock is anchored on those (error: one HTTP round trip, well under a game
// second at 10x). `genesisTs` (the SEASON_CREATED payload of /h/events, or --genesis-ts) fixes bell 0.
export const CLOSE_DELAY_GAME_S = 20;

export function createClock({ genesisTs = null, scale = 10, bellSecs = 600, nowMs = () => Date.now() } = {}) {
  let anchor = null; // {game_s, real_ms}
  let sc = scale;
  let gts = genesisTs;
  const api = {
    setGenesis(ts) {
      gts = Number(ts);
    },
    genesis: () => gts,
    /** anchor on a request: now_game (unix seconds, game time) at this real instant */
    observe({ now_game, scale: s }, realMs = nowMs()) {
      if (Number.isFinite(now_game)) anchor = { game_s: now_game, real_ms: realMs };
      if (Number.isFinite(s) && s > 0) sc = s;
    },
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

export function createCloser({ clock, social, records, metrics, onClosed = () => {}, start = 0, setIntervalFn = setInterval, clearIntervalFn = clearInterval, nowMs = () => Date.now() } = {}) {
  let next = start; // lowest bell not yet closed
  let timer = null;
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
      if (!clock.hasAnchor()) return [];
      const g = clock.gameNow(realMs);
      const done = [];
      for (let guard = 0; guard < 500; guard++) {
        const b = next;
        if (clock.bellStartGame(b + 1) + CLOSE_DELAY_GAME_S > g) break;
        if (!(await closeOne(b))) break;
        done.push(b);
        next = b + 1;
      }
      return done;
    },
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
