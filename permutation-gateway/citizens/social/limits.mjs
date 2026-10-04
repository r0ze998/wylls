// Limits of the social service (contract §6.2 rule 6) and the loopback rule
// of the ports (§1.1). Everything here is memory-only: client IPs live in the
// rate limiter's table and nowhere else (§5.6, §6.8 item 2): they are never
// written to STATE or PUB, never put in a record, never logged.
import { isIP } from 'node:net';

export const BELLS_PER_DAY = 144;
/** Humans and AIs alike. */
export const TALK_PER_BELL = 3;
export const TALK_PER_DAY = 40;
export const CALLREAD_PER_BELL = 2;
/** Per IP: POST burst 20 refilled 1/s; GET burst 40 refilled 4/s. Loopback clients (the bots) are exempt. */
export const IP_POST = Object.freeze({ burst: 20, perSec: 1 });
export const IP_GET = Object.freeze({ burst: 40, perSec: 4 });
export const MAX_BODY_BYTES = 8192;

export const dayOf = bell => Math.floor(bell / BELLS_PER_DAY);

/** AI processes bind only 41901–41999 (§1.1); port 0 (an ephemeral loopback port) is for tests. */
export const portAllowed = port => port === 0 || (Number.isInteger(port) && port >= 41901 && port <= 41999);

export function isLoopback(ip) {
  if (typeof ip !== 'string') return false;
  const a = ip.replace(/^::ffff:/i, '');
  return a === '::1' || a === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * The client address for rate limiting. `X-Forwarded-For` is set by
 * serve.mjs and trusted only when the TCP peer is loopback (the last entry,
 * the one the trusted proxy appended); a peer that is not loopback is itself
 * the client. No forwarded address from a loopback peer = a loopback client.
 */
export function clientIp(peer, forwardedFor) {
  if (!isLoopback(peer)) return peer ?? 'unknown';
  const v = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (typeof v !== 'string' || !v.trim()) return peer;
  const last = (v.split(',').map(x => x.trim()).filter(Boolean).pop() ?? '').replace(/^\[|\]$/g, '');
  // An unreadable value from the trusted proxy is not an exemption: it shares one limited bucket.
  return isIP(last) ? last : 'unknown';
}

/**
 * Token buckets per client address and kind ('post' | 'get'), in memory
 * only. `allow(ip, kind)` is true while the bucket has a token; loopback
 * addresses are never limited. The table is pruned and capped.
 */
export function createIpLimiter({ now = () => Date.now(), maxEntries = 20_000 } = {}) {
  const table = new Map();
  const spec = { post: IP_POST, get: IP_GET };
  function prune(t) {
    if (table.size < maxEntries) return;
    for (const [k, v] of table) if (t - v.t > 60_000) table.delete(k);
    while (table.size >= maxEntries) table.delete(table.keys().next().value);
  }
  return {
    allow(ip, kind) {
      if (isLoopback(ip)) return true;
      const s = spec[kind];
      const t = now();
      const key = `${kind}|${ip}`;
      let b = table.get(key);
      if (!b) { prune(t); b = { tokens: s.burst, t }; table.set(key, b); }
      b.tokens = Math.min(s.burst, b.tokens + ((t - b.t) / 1000) * s.perSec);
      b.t = t;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    /** Entries held (memory only; for tests and the metrics counter). */
    get size() { return table.size; },
  };
}

/** A per-key counter keyed by bell (call reads per bell), pruned to the last few bells. */
export function createBellCounter(keep = 4) {
  const m = new Map();
  return {
    /** Count one use of `key` in `bell`; false (and no count) when it already has `max`. */
    take(key, bell, max) {
      const k = `${bell}|${key}`;
      const n = m.get(k) ?? 0;
      if (n >= max) return false;
      m.set(k, n + 1);
      if (m.size > 4096) for (const kk of m.keys()) if (Number(kk.split('|', 1)[0]) < bell - keep) m.delete(kk);
      return true;
    },
  };
}
