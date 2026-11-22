// The gateway's guard in front of keeper A's public routes (fix-gw-highs;
// security audit H-1, H-2, M-2).
//
// `POST /f/reveal` and `POST /f/nudge` are anonymous: anyone reaches them
// through the herald's `/gw`. Keeper A refuses junk itself before any chain
// read (keeper/src/api_guard.rs: seal roots of its indexed departures, the
// current bell, a budget of its own for external chain reads), so nothing
// here is the last line; this guard keeps junk off the keeper link at all:
//
// * per client address (app.mjs FRONTIER_IP_LIMITS, tightened here) AND a
//   GLOBAL bucket per route (KEEPER_GLOBAL_LIMITS): spoofed or rotated
//   addresses (many IPv6 /64s, a proxy that passes the client's own
//   X-Forwarded-For through) still share the global one. Over it: 503
//   `KeeperUnavailable` with `reason: "KeeperBusy"` (the code the page
//   already treats as "never reached a keeper": it asks a reveal again 60 s
//   later, at most ten times, marchbook.mjs UNREACHED).
// * dedupe: the same body within DEDUPE_MS is answered from the last answer
//   (identical requests in flight share one keeper call). 5xx answers are
//   not kept.
// * counters of every refusal (`GET /f/operator/keeper-guard`) and at most
//   one log line per LOG_EVERY_MS summing them.
import { createHash } from 'node:crypto';
import { RouteError } from '../routes/errors.mjs';

/**
 * Per route, all client addresses together (burst, then a steady rate). A cap on RAW VOLUME only: keeper A tells
 * forged material from an owner's at zero RPC cost (its seal-root index), the gateway cannot, so a tight global
 * bucket would let a flood lock real players out (the first offline replay, 30 / 2 per s: the owner's reveal got ten
 * 503s while keeper A would have admitted it). Over this rate keeper A's process is protected; the page asks again.
 */
export const KEEPER_GLOBAL_LIMITS = Object.freeze({
  'POST /f/reveal': { burst: 1_000, perSecond: 300 },
  'POST /f/nudge': { burst: 1_000, perSecond: 300 },
});

/** How long an identical body is answered from the last answer. */
export const DEDUPE_MS = Object.freeze({ 'POST /f/reveal': 30_000, 'POST /f/nudge': 10_000 });
const DEDUPE_MAX = 4_096;
const LOG_EVERY_MS = 10_000;

const canonical = v => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v));

export class KeeperGuard {
  constructor({ limiter, now = Date.now, log = console.log, limits = KEEPER_GLOBAL_LIMITS, dedupeMs = DEDUPE_MS } = {}) {
    Object.assign(this, { limiter, now, log, limits, dedupeMs });
    this.cache = new Map(); // key → {at, value} | {pending}
    this.events = {};
    this.loggedAt = -Infinity;
    this.loggedEvents = {};
  }

  /** Counts `event` (`refused`: may log a summary line). */
  count(event, refused = false) {
    this.events[event] = (this.events[event] ?? 0) + 1;
    if (!refused) return;
    const t = this.now();
    if (t - this.loggedAt < LOG_EVERY_MS) return;
    const delta = Object.entries(this.events).filter(([k]) => /refused|busy|limited|unattributed/.test(k))
      .map(([k, v]) => [k, v - (this.loggedEvents[k] ?? 0)]).filter(([, d]) => d > 0).map(([k, d]) => `${k}=${d}`);
    this.log(`keeper guard: refusals since last line: ${delta.join(' ')}`);
    this.loggedAt = t;
    this.loggedEvents = { ...this.events };
  }

  /** The counters (`GET /f/operator/keeper-guard`). */
  snapshot() {
    return { events: { ...this.events }, limits: this.limits, dedupeMs: this.dedupeMs, cached: this.cache.size };
  }

  /**
   * Runs `call()` (the keeper link) for route `key` and checked body `body`,
   * unless the same body was answered within the dedupe window (or is in
   * flight), or the route's global bucket is empty (503 KeeperBusy).
   */
  async run(key, body, call) {
    const name = key.split('/').at(-1);
    const id = `${key} ${createHash('sha256').update(canonical(body)).digest('hex')}`;
    const t = this.now();
    const hit = this.cache.get(id);
    if (hit?.pending) { this.count(`${name}_deduped`); return hit.pending; }
    if (hit && t - hit.at < (this.dedupeMs[key] ?? 0)) { this.count(`${name}_deduped`); return hit.value; }
    if (hit) this.cache.delete(id);
    if (this.limits[key] && !this.limiter.take(`f-global:${key}`, this.limits[key])) {
      this.count(`${name}_busy_global`, true);
      throw new RouteError(503, 'the keeper is busy; ask again later', 'KeeperUnavailable', { reason: 'KeeperBusy' });
    }
    const pending = (async () => call())();
    this.cache.set(id, { pending });
    try {
      const value = await pending;
      const s = value?.status ?? 200;
      if (s < 500) this.remember(id, value); else this.cache.delete(id);
      this.count(s < 300 ? `${name}_forwarded_ok` : `${name}_forwarded_refused_${value?.body?.code ?? s}`, s >= 300);
      return value;
    } catch (e) {
      this.cache.delete(id);
      this.count(`${name}_keeper_unavailable`, true);
      throw e;
    }
  }

  remember(id, value) {
    this.cache.set(id, { at: this.now(), value });
    if (this.cache.size <= DEDUPE_MAX) return;
    const t = this.now();
    for (const [k, v] of this.cache) if (!v.pending && t - v.at >= 30_000) this.cache.delete(k);
    while (this.cache.size > DEDUPE_MAX) this.cache.delete(this.cache.keys().next().value);
  }
}
