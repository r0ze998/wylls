// The social service (contract §8.2, §11.6): `createSocial({herald, aiDir,
// roster, clock, provenance, …}) → {routes, book, council, closeBell,
// memberCall, subscribe, tick}` and its HTTP routes under `/f/ai/*`
// (also reachable as `/gw/f/ai/*`; serve.mjs forwards both).
//
//   POST /f/ai/talk  · POST /f/ai/ballot      {bytes_b64, sig_b64, decision_id?, item?}
//   GET  /f/ai/talk?after&channel&limit       GET /f/ai/inbox?wallet&after
//   GET  /f/ai/council?faction[&period]       GET /f/ai/council/call?faction&period&wallet&unix&sig
//
// Nothing else is routed: in particular there is no pact route (404, App. A.5).
// The service binds loopback only, and only a port in 41901–41999 (or 0 in tests).
import { createServer } from 'node:http';
import { SocialError, encodeCallRead, fromBase58, fromBase64, toBase58 } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { Refusal, createBook, defaultSanitize } from './book.mjs';
import { createCouncil } from './council.mjs';
import { CALLREAD_PER_BELL, MAX_BODY_BYTES, clientIp, createBellCounter, createIpLimiter, isLoopback, portAllowed } from './limits.mjs';

const CHANNEL_NAMES = { world: 0, nation: 1, direct: 3, 0: 0, 1: 1, 3: 3 };
const ok = body => ({ status: 200, body });
const intOf = (v, what, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) => {
  if ((v === null || v === undefined || v === '') && optional) return null;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Refusal('BadBytes', `${what}: an integer ${min}..${max} is expected`);
  return n;
};

export function createSocial({
  herald, aiDir = null, roster = {}, clock, provenance = null, config = {}, season, sanitize = defaultSanitize, fixCall = null, random, now = () => Date.now(), callreadSkewSecs = 600,
} = {}) {
  const book = createBook({ aiDir, roster, season, clock, herald, provenance, sanitize, now });
  const council = createCouncil({ aiDir, book, config: config.council ?? config, clock, fixCall, random });
  const ips = createIpLimiter({ now });
  const reads = createBellCounter();

  /** `GET /f/ai/council/call`: a signed member read of the sealed Strike Order (§6.5 step 6). */
  async function callRead(q) {
    const faction = intOf(q.faction, 'faction', { max: 255 });
    const period = intOf(q.period, 'period', { max: 0xffffffff });
    if (typeof q.wallet !== 'string' || !q.wallet) throw new Refusal('BadBytes', 'wallet is required');
    let walletBytes;
    try { walletBytes = fromBase58(q.wallet); } catch { throw new Refusal('BadBytes', 'wallet: base58 expected'); }
    if (walletBytes.length !== 32) throw new Refusal('BadBytes', 'wallet: 32 bytes expected');
    if (typeof q.unix !== 'string' || !/^-?\d{1,18}$/.test(q.unix)) throw new Refusal('BadBytes', 'unix: an integer is expected');
    if (typeof q.sig !== 'string' || !q.sig) throw new Refusal('BadBytes', 'sig is required');
    let sig;
    // A '+' in a query string arrives as a space unless the client percent-encoded it.
    try { sig = fromBase64(q.sig.replace(/ /g, '+')); } catch { throw new Refusal('BadBytes', 'sig: base64 expected'); }
    if (sig.length !== 64) throw new Refusal('BadBytes', 'sig: 64 bytes expected');
    let bytes;
    try { bytes = encodeCallRead({ season: book.season, faction, period, wallet: walletBytes, unix: BigInt(q.unix) }); } catch (e) { throw e instanceof SocialError ? new Refusal(e.code, e.message) : e; }
    if (Math.abs(Number(q.unix) - Math.floor(clock.unix())) > callreadSkewSecs) throw new Refusal('BellSkew', 'the read is stamped too far from chain time');
    const me = await book.authenticate(q.wallet, bytes, sig);
    const bell = clock.bell();
    if (!reads.take(q.wallet, bell, CALLREAD_PER_BELL)) throw new Refusal('RateLimited', `at most ${CALLREAD_PER_BELL} call reads per bell`);
    if (Number(me.citizen.faction) !== faction) throw new Refusal('NotMember', 'only citizens of the nation read its Strike Order');
    await council.tick();
    const c = council.memberCall(faction, period);
    if (!c) throw new Refusal('WindowClosed', 'no sealed Strike Order for this nation and period');
    const { option, kind, p, q: qq, tile, strike_bell, follow_from, invited, nonce, call_commit } = c;
    return { period, option, kind, p, q: qq, tile, strike_bell, follow_from, invited, nonce, call_commit };
  }

  /**
   * One request, transport-free: `{method, path, query (object), headers, body (Buffer | string | object), peer}`
   * → `{status, body}`. Refusals are `{error, code, detail}`.
   */
  async function dispatch({ method = 'GET', path = '/', query = {}, headers = {}, body = null, peer = '127.0.0.1' }) {
    try {
      let route = path.replace(/^\/gw(?=\/f\/ai(\/|$))/, '');
      if (route !== '/f/ai' && !route.startsWith('/f/ai/')) throw new Refusal('NotFound', 'no such route', 404);
      route = route.replace(/\/+$/, '');
      const ip = clientIp(peer, headers['x-forwarded-for']);
      if (!ips.allow(ip, method === 'POST' ? 'post' : 'get')) throw new Refusal('RateLimited', 'too many requests from this address');
      const sub = route.slice('/f/ai'.length);
      if (sub === '/talk' || sub === '/ballot') {
        if (method === 'GET' && sub === '/talk') {
          const ch = query.channel === undefined || query.channel === '' ? null : CHANNEL_NAMES[query.channel];
          if (ch === undefined) throw new Refusal('BadBytes', 'channel: 0, 1, 3, world, nation or direct');
          return ok(book.list({ after: intOf(query.after, 'after', { optional: true }) ?? 0, channel: ch, limit: intOf(query.limit, 'limit', { optional: true, min: 1 }) ?? 50 }));
        }
        if (method !== 'POST') throw new Refusal('MethodNotAllowed', `${sub} takes POST${sub === '/talk' ? ' (and GET)' : ''}`, 405);
        let json = body;
        if (Buffer.isBuffer(body) || typeof body === 'string') {
          if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Refusal('BadBytes', 'the body is too large', 413);
          try { json = JSON.parse(String(body)); } catch { throw new Refusal('BadBytes', 'the body is not JSON'); }
        }
        return ok(await book.submit(sub.slice(1), json));
      }
      if (method !== 'GET') {
        if (['/inbox', '/council', '/council/call'].includes(sub)) throw new Refusal('MethodNotAllowed', 'GET only', 405);
        throw new Refusal('NotFound', 'no such route', 404);
      }
      if (sub === '/inbox') {
        if (typeof query.wallet !== 'string' || !query.wallet) throw new Refusal('BadBytes', 'wallet is required');
        try { if (fromBase58(query.wallet).length !== 32) throw new Error(); } catch { throw new Refusal('BadBytes', 'wallet: base58 expected'); }
        return ok(await book.inbox({ wallet: query.wallet, after: intOf(query.after, 'after', { optional: true }) ?? 0, limit: intOf(query.limit, 'limit', { optional: true, min: 1 }) ?? 50 }));
      }
      if (sub === '/council') {
        const faction = intOf(query.faction, 'faction', { max: 255 });
        const period = intOf(query.period, 'period', { optional: true, max: 0xffffffff });
        await council.tick();
        return ok(council.publicState(faction, period));
      }
      if (sub === '/council/call') return ok(await callRead(query));
      throw new Refusal('NotFound', 'no such route', 404);
    } catch (e) {
      if (e instanceof Refusal) return { status: e.status, body: e.toJSON() };
      if (e instanceof SocialError) { const r = new Refusal(e.code, e.message); return { status: r.status, body: r.toJSON() }; }
      return { status: 500, body: { error: 'InternalError', code: 'InternalError', detail: 'the social service failed on this request' } };
    }
  }

  /** A node:http request listener (`(req, res)`) over `dispatch`. */
  function handle(req, res) {
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES * 2) { dead = true; res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify(new Refusal('BadBytes', 'the body is too large', 413))); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (dead) return;
      const url = new URL(req.url, 'http://127.0.0.1');
      const out = await dispatch({
        method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers,
        body: chunks.length ? Buffer.concat(chunks) : null, peer: req.socket.remoteAddress,
      });
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out.body));
    });
  }

  /** Bind loopback on a port the AI rule allows (41901–41999; 0 for tests); returns `{port, close}`. */
  function listen({ port = 41981, host = '127.0.0.1' } = {}) {
    if (!isLoopback(host)) throw new Error(`the social service binds loopback only, not ${host}`);
    if (!portAllowed(port)) throw new Error(`port ${port} is outside the AI range 41901-41999`);
    return new Promise((resolve, reject) => {
      const server = createServer(handle);
      server.once('error', reject);
      server.listen(port, host, () => resolve({ port: server.address().port, close: () => new Promise(r => server.close(() => r())) }));
    });
  }

  const routes = { dispatch, handle, listen, limiter: ips };
  return {
    routes, book, council,
    /** Close bell `b` (the bell closer calls this at bell_start(b+1) + 20 game-s): `{bell, root (hex), file, count}`. Council deadlines are checked in the background. */
    closeBell(b) {
      const r = book.closeBell(b);
      council.tick().catch(() => {});
      return r;
    },
    /** The sealed Strike Order of a nation (for `memberView(f)`): never hand it to another nation's prompt. */
    memberCall: (faction, period = null) => council.memberCall(faction, period),
    /** Events: record, closed (bell), council_open, motion, ballot, council_closed, call_sealed, call_opened. */
    subscribe(fn) { const a = book.subscribe(fn); const b = council.subscribe(fn); return () => { a(); b(); }; },
    tick: () => council.tick(),
    toBase58,
  };
}
