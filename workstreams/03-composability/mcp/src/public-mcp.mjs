// (2026-11-20, ③ public exposure) The PUBLIC read-only MCP endpoint: `POST /public/mcp`, Streamable HTTP (one JSON-RPC
// message, a JSON answer), tools = src/public-tools.mjs only. A separate server process (bin/wylls-mcp-public.mjs)
// from the owner server: it has no authorization server, no store, no relay, no capability and no write path, so
// exposing it can never expose an owner's authority. Off unless started; loopback-only unless the operator opts in
// (bin/public-settings.mjs, the same rule as the owner server).
//
// Order of checks for every request (each refusal happens before anything later runs):
//   1. Host allow-list (DNS rebinding) → 403          (src/exposure.mjs, as the owner server)
//   2. Origin allow-list (browser pages) → 403
//   3. who: a public API key (`Authorization: Bearer wylls_pk_…`, src/api-keys.mjs) or, only when the operator allowed
//      it, an anonymous caller keyed by its address; anything else → 401. An owner-link token (or any other bearer) is
//      refused: it was issued for another resource (MCP authorization, token audience / no token passthrough).
//   4. the global bucket (protects the herald; spent only by a caller step 3 let in, so a keyless flood cannot
//      starve key holders) → 429
//   5. the caller's bucket (burst) → 429
//   6. the body (≤ 16 KB, one message, no batch) → JSON-RPC errors
//   7. tools/call: the tool exists and the key may call it (the key's `tools` list) → -32602; the caller holds the
//      tool's scopes → 403 insufficient_scope with a `WWW-Authenticate … scope=` challenge (MCP 2025-11-25 step-up);
//      the tool's extra cost against the bucket and the daily quota → 429; the arguments → -32602.
// Then the tool runs: one public herald GET. Its answer is plain JSON, ≤ MAX_RESULT_BYTES.
import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSIONS } from './protocol.mjs';
import { toolNamed, unknownToolText } from './dispatch.mjs';
import { PUBLIC_TOOLS, PUBLIC_INSTRUCTIONS, MAX_RESULT_BYTES, PublicError, argsError } from './public-tools.mjs';
import { PUBLIC_SCOPE, TOKEN } from './api-keys.mjs';
import { hostChecker, originChecker } from './exposure.mjs';
import { audited, clientAddress } from './audit.mjs';
import { TokenBuckets, DailyQuota } from './rate-limit.mjs';

export const PUBLIC_PATH = '/public/mcp';
export const PUBLIC_SERVER_INFO = Object.freeze({ name: 'wylls-mcp-public', title: 'Wylls public world data (read-only)', version: '0.1.0' });
const MAX_BODY = 16 * 1024;
export const PUBLIC_DEFAULTS = Object.freeze({
  keyRate: { burst: 30, everySecs: 1 }, keyPerDay: 5_000,
  anonRate: { burst: 10, everySecs: 3 }, anonPerDay: 500,
  globalRate: { burst: 200, everySecs: 0.02 },
});

const text = o => [{ type: 'text', text: JSON.stringify(o) }];
const ok = o => ({ content: text(o), structuredContent: o, isError: false });
const fail = (code, message, extra = {}) => { const e = { ok: false, error: { code, message, ...extra } }; return { content: text(e), structuredContent: e, isError: true }; };

/**
 * The JSON-RPC side (transport-free). `principal` = {kind: 'key'|'anonymous', id?, scopes, tools: null | string[]}.
 * `charge(principal, tool)` spends the tool's extra cost and the daily quota: null, or a refusal {status, reason, retryAfterSecs}.
 */
export function createPublicMcp({ reader, tools = PUBLIC_TOOLS, log = () => {} }) {
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  const listedFor = p => tools.filter(t => !p.tools || p.tools.includes(t.name)).map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
  const runners = Object.fromEntries(tools.map(t => [t.name, args => reader[t.name](args)]));

  /** @returns {Promise<{rpc: object|null, challenge?: {scopes: string[]}, refusal?: object}>} */
  async function handle(msg, principal, { charge = () => null } = {}) {
    const badId = msg !== null && typeof msg === 'object' && msg.id !== undefined && typeof msg.id !== 'string' && !Number.isInteger(msg.id);
    if (badId) return { rpc: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: id must be a string or an integer' } } };
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { rpc: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } };
    const notification = msg.id === undefined;
    const reply = result => ({ rpc: notification ? null : { jsonrpc: '2.0', id: msg.id, result } });
    const error = (code, message) => ({ rpc: notification ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } } });
    switch (msg.method) {
      case 'initialize': {
        const p = msg.params;
        const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
        if (!isObj(p) || typeof p.protocolVersion !== 'string' || !isObj(p.capabilities) || !isObj(p.clientInfo)) return error(-32602, 'invalid params: initialize needs protocolVersion, capabilities and clientInfo');
        return reply({ protocolVersion: PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: PUBLIC_SERVER_INFO, instructions: PUBLIC_INSTRUCTIONS });
      }
      case 'notifications/initialized': case 'notifications/cancelled': return { rpc: null };
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: listedFor(principal) });
      case 'tools/call': {
        const name = msg.params?.name;
        const run = toolNamed(runners, name);
        // a tool outside the key's own list is unknown to this caller, exactly as one that does not exist
        if (!run || (principal.tools && !principal.tools.includes(name))) return error(-32602, unknownToolText(name));
        const tool = byName[name];
        const missing = tool.scopes.filter(s => !principal.scopes.includes(s));
        if (missing.length) return { ...error(-32001, `insufficient scope: ${tool.scopes.join(' ')}`), challenge: { scopes: tool.scopes } };
        const bad = argsError(tool, msg.params?.arguments);
        if (bad) return error(-32602, `invalid arguments: ${bad}`);
        const refusal = charge(principal, tool);
        if (refusal) return { ...error(-32000, refusal.reason === 'quota' ? 'daily quota used up' : 'rate limited'), refusal };
        let out;
        try { out = await run(msg.params?.arguments ?? {}); } catch (e) {
          if (e instanceof PublicError) return { ...reply(fail(e.code, e.message, e.extra)), outcome: e.code };
          log(`public-mcp: ${name} threw ${String(e?.message ?? e).slice(0, 120)}`);
          return { ...reply(fail('InternalError', 'internal error')), outcome: 'InternalError' };
        }
        const r = ok(out);
        if (Buffer.byteLength(JSON.stringify(r)) > MAX_RESULT_BYTES) return { ...reply(fail('ResultTooLarge', `the answer is over ${MAX_RESULT_BYTES} bytes; it is not cut`)), outcome: 'ResultTooLarge' };
        return { ...reply(r), outcome: 'ok' };
      }
      default: return error(-32601, `method not found: ${msg.method.slice(0, 40)}`);
    }
  }

  return { handle, tools: tools.map(t => t.name) };
}

/**
 * The HTTP handler of the public endpoint.
 * @param {object} o
 * @param {object} o.mcp            createPublicMcp(...)
 * @param {KeyRing|null} o.keys     the public API keys (null: no key is accepted)
 * @param {boolean} [o.anonymous]   accept callers without a key (keyed by address; stricter limits)
 * @param {string[]|null} o.allowedHosts  Host names (bin/public-settings.mjs); null = not checked (tests only)
 * @param {string[]} [o.origins]    browser Origins allowed besides the server's own `origin`
 */
export function createPublicHandler({ mcp, keys = null, anonymous = false, allowedHosts = null, origin = null, origins = [], now = Date.now, log = () => {},
  limits = {}, audit = null, trustProxy = false }) {
  const L = { ...PUBLIC_DEFAULTS, ...limits };
  const hostOk = hostChecker(allowedHosts);
  const originOk = originChecker(new Set([...(origin ? [origin] : []), ...origins]));
  const global = new TokenBuckets({ ...L.globalRate, now, maxKeys: 1 });
  const keyBuckets = new TokenBuckets({ ...L.keyRate, now });
  const perKeyBuckets = new Map(); // keys with their own `rate`
  const anonBuckets = new TokenBuckets({ ...L.anonRate, now });
  const quota = new DailyQuota({ perDay: Math.max(L.keyPerDay, L.anonPerDay), now });
  const challenge = (error, extra = '') => `Bearer realm="wylls-public"${error ? `, error="${error}"` : ''}${extra}`;
  const send = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(obj === null ? '' : JSON.stringify(obj));
  };
  const note = (req, o) => { if (req.wyllsAudit) Object.assign(req.wyllsAudit, o); };
  const bucketOf = p => {
    if (p.kind === 'anonymous') return anonBuckets;
    if (!p.rate) return keyBuckets;
    let b = perKeyBuckets.get(p.id);
    if (!b || b.burst !== p.rate.burst || b.everySecs !== p.rate.everySecs) { b = new TokenBuckets({ ...p.rate, now, maxKeys: 1 }); perKeyBuckets.set(p.id, b); }
    return b;
  };
  const bucketKey = p => (p.kind === 'anonymous' ? `a:${p.addr}` : `k:${p.id}`);
  const perDayOf = p => (p.kind === 'anonymous' ? L.anonPerDay : p.perDay ?? L.keyPerDay);

  function who(req) {
    const h = req.headers.authorization;
    if (h === undefined) return anonymous ? { principal: { kind: 'anonymous', addr: clientAddress(req, trustProxy), scopes: [PUBLIC_SCOPE], tools: null } } : { error: null, message: 'a Wylls public key is required (Authorization: Bearer wylls_pk_…)' };
    const m = /^Bearer (\S{1,300})$/.exec(String(h));
    if (!m) return { error: 'invalid_request', message: 'Authorization: Bearer <key> expected' };
    if (!TOKEN.test(m[1])) return { error: 'invalid_token', message: 'not a Wylls public key: this endpoint accepts no other token (an owner connection belongs to the owner server)' };
    if (!keys) return { error: 'invalid_token', message: 'this server accepts no keys' };
    const v = keys.verify(m[1]);
    if (v.error) return { error: v.error, message: v.message };
    return { principal: { kind: 'key', id: v.key.id, scopes: [...v.key.scopes], tools: v.key.tools, rate: v.key.rate, perDay: v.key.perDay } };
  }

  async function body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX_BODY) return { tooLarge: true }; chunks.push(c); }
    try { return { msg: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { return { parse: true }; }
  }

  async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://public.invalid'); } catch { return send(res, 400, { error: 'invalid_request' }); }
    try {
      if (!hostOk(req)) return send(res, 403, { error: 'forbidden', error_description: 'host not allowed' });
      if (!originOk(req)) return send(res, 403, { error: 'forbidden', error_description: 'origin not allowed' });
      if (url.pathname !== PUBLIC_PATH) return send(res, 404, { error: 'not_found' });
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      const w = who(req);
      if (!w.principal) {
        note(req, { outcome: 'Unauthenticated' });
        return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: w.message } }, { 'www-authenticate': challenge(w.error) });
      }
      const p = w.principal;
      note(req, { who: { kind: p.kind, ...(p.kind === 'key' ? { id: p.id } : {}) } });
      // (2026-11-20, verify-pr114) The global bucket is spent by authenticated (or allowed anonymous) callers only:
      // charged before `who`, a keyless flood of 401s emptied it and every key holder got 429 (only a tool call
      // reaches the herald, and an unauthenticated request never does).
      // (security-audit) The caller's own bucket first: a request it refuses spends no global token, so one key (or
      // address) flooding past its own rate can no longer empty the global bucket and lock every other key out.
      const b = bucketOf(p).take(bucketKey(p), 1);
      if (!b.ok) { note(req, { outcome: 'RateLimited' }); return send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'rate limited', data: { reason: 'rate' } } }, { 'retry-after': String(b.retryAfterSecs) }); }
      const g = global.take('all', 1);
      if (!g.ok) { note(req, { outcome: 'GlobalLimit' }); return send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'the server is busy', data: { reason: 'global' } } }, { 'retry-after': String(g.retryAfterSecs) }); }
      const v = req.headers['mcp-protocol-version'];
      if (v && !PROTOCOL_VERSIONS.includes(v)) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `unsupported MCP-Protocol-Version ${String(v).slice(0, 20)}` } });
      const r = await body(req);
      if (r.tooLarge) return send(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'the request body is too large' } });
      if (r.parse) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: the body is not JSON' } });
      const msg = r.msg;
      if (!msg || typeof msg !== 'object') return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'a JSON-RPC message is required' } });
      if (Array.isArray(msg)) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batches are not supported' } });
      note(req, { rpc: typeof msg.method === 'string' ? msg.method : undefined, tool: msg.method === 'tools/call' && msg.params?.name !== undefined ? (mcp.tools.includes(msg.params.name) ? msg.params.name : '(unknown)') : undefined });
      // the tool's cost beyond the 1 already spent, and the daily quota (the whole cost)
      const charge = (pr, tool) => {
        if (tool.cost > 1) { const x = bucketOf(pr).take(bucketKey(pr), tool.cost - 1); if (!x.ok) return { status: 429, reason: 'rate', retryAfterSecs: x.retryAfterSecs }; }
        const q = quota.take(bucketKey(pr), tool.cost, perDayOf(pr));
        return q.ok ? null : { status: 429, reason: 'quota', retryAfterSecs: q.retryAfterSecs, resetAt: q.resetAt };
      };
      const out = await mcp.handle(msg, p, { charge });
      if (out.challenge) {
        note(req, { outcome: 'InsufficientScope' });
        return send(res, 403, out.rpc, { 'www-authenticate': challenge('insufficient_scope', `, scope="${out.challenge.scopes.join(' ')}"`) });
      }
      if (out.refusal) {
        note(req, { outcome: out.refusal.reason === 'quota' ? 'QuotaExceeded' : 'RateLimited' });
        const rpc = out.rpc && { ...out.rpc, error: { ...out.rpc.error, data: { reason: out.refusal.reason, ...(out.refusal.resetAt ? { resetAt: out.refusal.resetAt } : {}) } } };
        return send(res, out.refusal.status, rpc, { 'retry-after': String(out.refusal.retryAfterSecs) });
      }
      note(req, { outcome: out.outcome ?? (out.rpc?.error ? `rpc${-out.rpc.error.code}` : 'ok') });
      if (out.rpc === null) { res.writeHead(202); return res.end(); }
      const headers = msg.method === 'initialize' && out.rpc.result !== undefined ? { 'mcp-session-id': randomBytes(16).toString('hex') } : {};
      return send(res, 200, out.rpc, headers);
    } catch (e) {
      log(`public-mcp: ${req.method} ${url.pathname} failed: ${String(e?.message ?? e).slice(0, 200)}`);
      return send(res, 500, { error: 'server_error' });
    }
  }

  return audited(handler, audit, { addressOf: req => clientAddress(req, trustProxy), now, paths: [PUBLIC_PATH] });
}
