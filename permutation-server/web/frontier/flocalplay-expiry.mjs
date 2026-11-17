// LOCAL PLAY — a launcher world's automatic end as the page may show it (PURE; no text, no request, no timer).
//
// The launcher fixes a world's end ONCE, at the world's own TTL origin, and states it with the world
// (`local-play-launcher.mjs` `expiryOf`: `{schema, startedAt, ttlMs, expiresAt, instance}`). This module decides
// what the page may say from that statement and nothing else:
//   - `known`: the statement is exactly well formed (schema, keys, safe integers, `expiresAt == startedAt + ttlMs`)
//     AND bound to the runner instance this page is connected to; then the REAL-clock remaining time is
//     `expiresAt - now` (never below 0). It is wall time on this machine, not game time;
//   - `unknown` in every other case: absent, malformed, another instance, no instance, a clock that is not a number.
//     Nothing is filled in (no default two hours, no guess from another field).
// It never starts, stops, extends or signs anything; showing it calls nothing. The page uses it only through
// flocalplay-instance.mjs, with the instance the relay confirmed (never the statement's own instance).

export const WORLD_EXPIRY_SCHEMA = 'frontier-local-play-world-expiry-v1';
const KEYS = ['schema', 'startedAt', 'ttlMs', 'expiresAt', 'instance'];
const DATE_MAX_MS = 8.64e15;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `payload`: the launcher's `expiry` (from the start answer or the worlds list) for THIS page's world.
 * `runnerInstance`: the runner instance this page's world is pinned to (64 lower-case hex), or null when unknown.
 * `now`: this machine's clock, ms. → `{state: 'known', expiresAt, remainingMs, ttlMs}` or `{state: 'unknown', why}`.
 */
export function expiryView(payload, runnerInstance, now) {
  const unknown = why => Object.freeze({ state: 'unknown', why });
  if (payload === null || payload === undefined) return unknown('absent');
  if (typeof payload !== 'object' || Array.isArray(payload)) return unknown('malformed');
  const keys = Object.keys(payload);
  if (keys.length !== KEYS.length || !KEYS.every(k => Object.hasOwn(payload, k))) return unknown('malformed');
  const { schema, startedAt, ttlMs, expiresAt, instance } = payload;
  if (schema !== WORLD_EXPIRY_SCHEMA) return unknown('schema');
  if (![startedAt, ttlMs, expiresAt].every(Number.isSafeInteger) || startedAt < 0 || ttlMs <= 0 || expiresAt > DATE_MAX_MS) return unknown('malformed');
  if (startedAt + ttlMs !== expiresAt) return unknown('inconsistent');
  if (typeof instance !== 'string' || !HEX64.test(instance) || /^0{64}$/.test(instance)) return unknown('no-instance');
  if (typeof runnerInstance !== 'string' || !HEX64.test(runnerInstance) || runnerInstance !== instance) return unknown('other-instance');
  if (!Number.isFinite(now)) return unknown('clock');
  return Object.freeze({ state: 'known', instance, expiresAt, remainingMs: Math.max(0, expiresAt - now), ttlMs });
}

/**
 * Whether a new statement may replace the one shown (a reconnect or a refreshed list): only for the SAME world
 * (same instance) and only the same end — an end that moved is not believed (the launcher never moves it), so the
 * page then shows `unknown` instead of either value.
 */
export function expiryStable(shown, fresh) {
  if (!shown || !fresh || shown.state !== 'known' || fresh.state !== 'known') return false;
  // the same world first (its instance), then the same end: two worlds started in the same millisecond with the same
  // life are still two worlds
  return typeof shown.instance === 'string' && shown.instance === fresh.instance && shown.expiresAt === fresh.expiresAt && shown.ttlMs === fresh.ttlMs;
}
