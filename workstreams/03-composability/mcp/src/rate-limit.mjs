// (2026-11-20, ③ public exposure) Rate limits and quotas for the MCP servers. Pure: no I/O, no timers; the clock is
// the caller's. Memory is bounded: past `maxKeys` the least recently used key is forgotten (it starts again with a
// full allowance) — never the whole table at once, so spraying new keys cannot reset everyone's limit (http.mjs's
// older per-address limiter clears the whole table at 10 000 addresses; it is left as it was, see PUBLIC-EXPOSURE.md).
//
// TokenBuckets: `burst` calls at once, then one every `everySecs` per key (the same shape as http.mjs and server.mjs).
// DailyQuota: at most `perDay` units per key per UTC day.
// Both take a `cost` (whole units ≥ 1): a heavier tool spends more of the allowance.

/** The `burst/everySecs` text of a setting (e.g. "30/1", "10/0.5"), or null. */
export function parseRate(text) {
  const m = /^(\d{1,6})\/(\d{1,5}(?:\.\d{1,3})?)$/.exec(String(text ?? ''));
  if (!m) return null;
  const burst = Number(m[1]);
  const everySecs = Number(m[2]);
  if (!(burst >= 1) || !(everySecs > 0)) return null;
  return { burst, everySecs };
}

const unitCost = cost => (Number.isInteger(cost) && cost >= 1 ? cost : 1);

/** Least-recently-used bounded map: a touched key moves to the end; the first key is the oldest. */
class Lru {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k, v) { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
  get size() { return this.m.size; }
}

export class TokenBuckets {
  /** @param {{burst: number, everySecs: number, now?: () => number, maxKeys?: number}} o  now in ms */
  constructor({ burst, everySecs, now = Date.now, maxKeys = 10_000 }) {
    if (!(Number.isInteger(burst) && burst >= 1) || !(everySecs > 0)) throw new Error('TokenBuckets: burst ≥ 1 and everySecs > 0');
    this.burst = burst; this.everySecs = everySecs; this.now = now; this.keys = new Lru(maxKeys);
  }

  /** Spend `cost` for `key`: {ok: true} or {ok: false, retryAfterSecs} (nothing spent when refused). */
  take(key, cost = 1) {
    const c = unitCost(cost);
    const t = this.now() / 1000;
    const b = this.keys.get(key) ?? { tokens: this.burst, t };
    b.tokens = Math.min(this.burst, b.tokens + (t - b.t) / this.everySecs);
    b.t = t;
    this.keys.set(key, b);
    if (b.tokens < c) return { ok: false, retryAfterSecs: Math.max(1, Math.ceil((c - b.tokens) * this.everySecs)) };
    b.tokens -= c;
    return { ok: true };
  }

  get size() { return this.keys.size; }
}

const DAY_MS = 86_400_000;

export class DailyQuota {
  /** @param {{perDay: number, now?: () => number, maxKeys?: number}} o */
  constructor({ perDay, now = Date.now, maxKeys = 10_000 }) {
    if (!(Number.isInteger(perDay) && perDay >= 1)) throw new Error('DailyQuota: perDay ≥ 1');
    this.perDay = perDay; this.now = now; this.keys = new Lru(maxKeys);
  }

  /** Spend `cost` for `key` today (UTC): {ok, remaining, resetAt (ms)}; nothing spent when refused. */
  take(key, cost = 1, perDay = this.perDay) {
    const c = unitCost(cost);
    const t = this.now();
    const day = Math.floor(t / DAY_MS);
    const resetAt = (day + 1) * DAY_MS;
    const q = this.keys.get(key);
    const used = q && q.day === day ? q.used : 0;
    if (used + c > perDay) { this.keys.set(key, { day, used }); return { ok: false, remaining: perDay - used, resetAt, retryAfterSecs: Math.max(1, Math.ceil((resetAt - t) / 1000)) }; }
    this.keys.set(key, { day, used: used + c });
    return { ok: true, remaining: perDay - used - c, resetAt };
  }
}
