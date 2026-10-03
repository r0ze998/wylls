// Exposure check of the public herald origin (PT-B). Run it against the herald URL the tunnel will
// point at (a local rehearsal herald here: 127.0.0.1 only, no tunnel), as if it were a stranger:
//
//   node scripts/playtest/abuse-check.mjs --herald http://127.0.0.1:41110 [--json out.json]
//
// It checks, each as a named case with the expectation printed:
//   probe     operator and internal surfaces are not reachable through any public route, however the
//             path is written (the relay's /f/operator/*, the keeper API /v1/*, the chain's RPC, files)
//   headers   security headers on every kind of answer, CORS only where it is meant, no Server/X-Powered-By
//   leaks     no answer carries a filesystem path, an internal port, a token or a stack trace
//   limits    one address flooding the herald, the join route and the relay route is limited, another
//             address is not, X-Forwarded-For is read from the right end, CF-Connecting-IP wins
//   ws        sockets per address are capped, an unmasked or oversized frame closes the socket
//   body      a 70 KiB body is 413, odd methods are 405
// The client addresses are set the way a tunnel on this machine sets them (X-Forwarded-For /
// CF-Connecting-IP from a loopback peer); TEST-NET addresses only. Nothing here sends a Join or a
// relayed transaction: the bodies are junk by design, so no sponsor lamports can move.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const HERALD = new URL(arg('herald', 'http://127.0.0.1:41110'));
const OUT = arg('json', '');
if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(HERALD.hostname)) { console.error('refusing a non-loopback target: this script floods'); process.exit(2); }
if (/:(4185|4190|4191|4194|41300|41[4-9]\d\d)$/.test(HERALD.host)) { console.error(`refusing ${HERALD.host}`); process.exit(2); }

const results = [];
const check = (group, name, ok, detail = '') => { results.push({ group, name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${group}: ${name}${detail ? `  [${detail}]` : ''}`); };

/** One raw request (no URL normalisation): `{status, headers, body}`. */
function req(method, path, { headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise(resolve => {
    const r = http.request({ host: HERALD.hostname, port: HERALD.port, method, path, headers: { ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers }, agent: false, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    r.on('error', e => resolve({ status: 0, headers: {}, body: String(e.message) }));
    if (body) r.write(body);
    r.end();
  });
}
const as = ip => ({ 'X-Forwarded-For': ip });

// ------------------------------------------------------------------ probe
const SECRETISH = /\/Users\/|\/private\/|\/var\/|\.local|operator-token|bearer|master\.seed|gate\.key|invite\.secret|keeper\.token|ECONNREFUSED|at \w+ \(|node:internal|panicked|stack backtrace|127\.0\.0\.1:41\d\d\d|localhost:41\d\d\d/i;
const probes = [
  ['GET', '/gw/f/operator/pool'], ['POST', '/gw/f/operator/invites', '{"count":1}'], ['GET', '/gw/f/operator/pool/'],
  ['GET', '/gw/f/tx/%2e%2e/operator/pool'], ['GET', '/gw/f/tx/%2E%2E/operator/pool'], ['GET', '/gw//f/operator/pool'], ['GET', '/gw/F/operator/pool'],
  ['GET', '/gw/f/operator/pool?x=1'], ['GET', '/f/operator/pool'], ['GET', '/operator/pool'],
  ['GET', '/gw/v1/status'], ['POST', '/gw/v1/nudge', '{"province":[0,0],"bell":1}'], ['POST', '/gw/v1/reveal', '{}'], ['GET', '/v1/status'], ['POST', '/v1/nudge', '{}'],
  ['POST', '/gw/', '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'], ['POST', '/rpc', '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'], ['POST', '/', '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'],
  ['GET', '/gw/..%2f..%2fetc/passwd'], ['GET', '/gw/%2e%2e/%2e%2e/etc/passwd'], ['GET', '/frontier/..%2f..%2fetc%2fpasswd'], ['GET', '/frontier/../../../../etc/passwd'], ['GET', '/frontier/%2e%2e/%2e%2e/etc/passwd'],
  ['GET', '/frontier/.env'], ['GET', '/frontier/.git/config'], ['GET', '/frontier/frontier/.hidden'], ['GET', '/frontier/frontier/playtest/..'], ['GET', '/frontier/%00'], ['GET', '/h/../gw/f/operator/pool'],
  ['GET', '/h/events?after=-1'], ['GET', '/h/province/..%2f..%2f/latest'], ['GET', '/h/overview/0/..%2f..%2fstate.json'], ['GET', '/h/me/%2e%2e%2f'], ['GET', `/${'a'.repeat(9000)}`],
];
for (const [m, p, b] of probes) {
  const r = await req(m, p, { body: b ?? null, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything', ...as('203.0.113.50') } });
  const leaked = r.body.match(SECRETISH)?.[0];
  const ok = ![200, 201, 202].includes(r.status) || (p.startsWith('/h/') && ['/h/events?after=-1'].includes(p)) || (p === '/gw/f/tx/%2e%2e/operator/pool' && false);
  // A 200 is acceptable only for the herald's own public reads (none of the probes above is one).
  check('probe', `${m} ${p.length > 70 ? `${p.slice(0, 60)}…(${p.length})` : p}`, ok && !leaked && !/"payers"|"invites"|"jsonrpc"|root:/.test(r.body), `${r.status}${leaked ? ` leaked ${leaked}` : ''}`);
}

// ------------------------------------------------------------------ headers
const ip1 = as('203.0.113.60');
const kinds = [['GET', '/frontier/frontier/index.html', 'page'], ['GET', '/frontier/frontier/app.mjs', 'script'], ['GET', '/h/season', 'api'], ['GET', '/gw/f/season', 'relay'], ['GET', '/nope', '404'], ['GET', '/h/status', 'status']];
for (const [m, p, kind] of kinds) {
  const r = await req(m, p, { headers: ip1 });
  const h = r.headers;
  const csp = h['content-security-policy'] ?? '';
  const wantSelf = kind === 'page' || kind === 'script';
  check('headers', `${kind}: X-Frame-Options DENY, nosniff, no-referrer, CSP`, h['x-frame-options'] === 'DENY' && h['x-content-type-options'] === 'nosniff' && h['referrer-policy'] === 'no-referrer'
    && (wantSelf ? /script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/unsafe-inline|unsafe-eval(?!.*wasm)/.test(csp.replace('wasm-unsafe-eval', '')) : /default-src 'none'/.test(csp)), `${r.status} ${csp.slice(0, 60)}`);
  check('headers', `${kind}: no Server / X-Powered-By`, !h.server && !h['x-powered-by'], `server=${h.server ?? '-'}`);
  const acao = h['access-control-allow-origin'];
  check('headers', `${kind}: CORS ${p.startsWith('/h/') ? '* (public reads)' : 'absent'}`, p.startsWith('/h/') ? acao === '*' : acao === undefined, `acao=${acao ?? '-'}`);
}
const pre = await req('OPTIONS', '/gw/f/join', { headers: { ...ip1, Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
check('headers', 'a cross-origin preflight to /gw gets no CORS grant', !pre.headers['access-control-allow-origin'], `${pre.status}`);
const xo = await req('POST', '/gw/f/join', { body: '{}', headers: { ...ip1, Origin: 'https://evil.example', 'Content-Type': 'application/json' } });
check('headers', 'a cross-origin POST to /gw gets no CORS grant (the browser will not show the answer)', !xo.headers['access-control-allow-origin'], `${xo.status}`);
const page = await req('GET', '/frontier/frontier/index.html', { headers: ip1 });
check('headers', 'the game page carries the playtest script exactly once, before app.mjs', (page.body.match(/playtest\/boot\.mjs/g) ?? []).length === 1 && page.body.indexOf('playtest/boot.mjs') < page.body.indexOf('src="app.mjs"'), `${page.status}`);
const root = await req('GET', '/', { headers: ip1 });
check('headers', '/ leads to the start page', root.status === 302 && /\/frontier\/frontier\/playtest\/$/.test(root.headers.location ?? ''), `${root.status} ${root.headers.location ?? ''}`);
for (const f of ['/frontier/frontier/playtest/index.html', '/frontier/frontier/playtest/landing.mjs', '/frontier/frontier/playtest/boot.mjs', '/frontier/frontier/playtest/guestkey.mjs', '/frontier/frontier/playtest/playtest.css', '/frontier/frontier/playtest/config.json']) {
  const r = await req('GET', f, { headers: ip1 });
  check('headers', `${f} is served`, r.status === 200, `${r.status}`);
}
const landing = (await req('GET', '/frontier/frontier/playtest/index.html', { headers: ip1 })).body;
check('headers', 'the start page has no inline script or style (the CSP forbids them)', !/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(landing) && !/\sstyle=|<style/i.test(landing));

// ------------------------------------------------------------------ leaks
for (const [m, p, b] of [['GET', '/gw/f/relay?citizen=%00'], ['POST', '/gw/f/relay', '{"tx":"@@@"}'], ['POST', '/gw/f/join', '[1]'], ['POST', '/gw/f/invite-check', '{"invite":{"x":1}}'], ['GET', '/gw/f/tx/short'], ['POST', '/gw/f/nudge', '{"province":"x"}'], ['GET', '/h/me/zzzz'], ['GET', '/h/province/x/latest'], ['GET', '/h/bell/9999999999/region/0']]) {
  const r = await req(m, p, { body: b ?? null, headers: { 'Content-Type': 'application/json', ...as('203.0.113.70') } });
  check('leaks', `${m} ${p}`, !SECRETISH.test(r.body) && r.status !== 0, `${r.status} ${r.body.slice(0, 60).replace(/\s+/g, ' ')}`);
}

// ------------------------------------------------------------------ limits
{
  const flood = as('198.51.100.20');
  const codes = {};
  const N = 3200;
  await Promise.all(Array.from({ length: N }, async () => { const r = await req('GET', '/h/season', { headers: flood }); codes[r.status] = (codes[r.status] ?? 0) + 1; }));
  check('limits', `${N} quick reads from one address: a third or more are refused (429) once its bucket (1,500) is empty`, (codes[429] ?? 0) > N / 3 && (codes[200] ?? 0) + (codes[304] ?? 0) <= 1800, JSON.stringify(codes));
  const other = await req('GET', '/h/season', { headers: as('198.51.100.21') });
  check('limits', 'another address is not affected', other.status === 200, `${other.status}`);
  const retry = await req('GET', '/h/season', { headers: flood });
  check('limits', 'the refusal says when to come back (Retry-After) and carries the security headers', retry.status !== 429 || (retry.headers['retry-after'] && retry.headers['x-frame-options'] === 'DENY'), `${retry.status}`);
}
{
  // X-Forwarded-For: the browser's own claim comes first, the tunnel appends the real address. Varying the claim must not help.
  const codes = {};
  for (let i = 0; i < 40; i++) { const r = await req('POST', '/gw/f/join', { body: '{}', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}, 198.51.100.30` } }); codes[r.status] = (codes[r.status] ?? 0) + 1; }
  check('limits', '40 Joins from one address (a different claimed address each time): at most 10 get past the per-address limit', (codes[429] ?? 0) >= 28 && Object.keys(codes).every(k => ['400', '429'].includes(k)), JSON.stringify(codes));
  const fresh = await req('POST', '/gw/f/join', { body: '{}', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.31' } });
  check('limits', 'a different real address is answered normally (400 for the junk body)', fresh.status === 400, `${fresh.status}`);
  // CF-Connecting-IP is the tunnel's own word and wins over X-Forwarded-For.
  const codes2 = {};
  for (let i = 0; i < 30; i++) { const r = await req('POST', '/gw/f/join', { body: '{}', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.40', 'X-Forwarded-For': `198.51.100.${100 + i}` } }); codes2[r.status] = (codes2[r.status] ?? 0) + 1; }
  check('limits', 'with CF-Connecting-IP the claimed X-Forwarded-For does not matter', (codes2[429] ?? 0) >= 18, JSON.stringify(codes2));
  // The relay route and the nudge route.
  const c3 = {}; const c4 = {};
  for (let i = 0; i < 60; i++) {
    const a = await req('POST', '/gw/f/relay', { body: '{"tx":"AAAA"}', headers: { 'Content-Type': 'application/json', ...as('198.51.100.50') } }); c3[a.status] = (c3[a.status] ?? 0) + 1;
    const b = await req('POST', '/gw/f/nudge', { body: '{"province":[0,0],"bell":1}', headers: { 'Content-Type': 'application/json', ...as('198.51.100.51') } }); c4[b.status] = (c4[b.status] ?? 0) + 1;
  }
  check('limits', '60 relayed transactions (junk) from one address: refused as invalid, then limited', (c3[429] ?? 0) >= 15 && !c3[200] && !c3[202], JSON.stringify(c3));
  check('limits', '60 nudges from one address: limited', (c4[429] ?? 0) >= 40, JSON.stringify(c4));
}

// ------------------------------------------------------------------ websocket
function ws(headers = {}) {
  return new Promise(resolve => {
    const key = crypto.randomBytes(16).toString('base64');
    const s = net.connect(HERALD.port, HERALD.hostname);
    let buf = '';
    s.setTimeout(6000, () => { s.destroy(); resolve({ status: 0, s }); });
    s.on('error', () => resolve({ status: 0, s }));
    s.on('connect', () => s.write(`GET /h/ws HTTP/1.1\r\nHost: ${HERALD.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
    s.on('data', d => { buf += d.toString('latin1'); const i = buf.indexOf('\r\n\r\n'); if (i >= 0 && !s.__done) { s.__done = true; resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1]), s, head: buf.slice(0, i) }); } });
  });
}
const frame = (op, payload, { mask = true, claim = null } = {}) => {
  const len = claim ?? payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, (mask ? 0x80 : 0) | len]) : len < 65536 ? Buffer.from([0x80 | op, (mask ? 0x80 : 0) | 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | op, (mask ? 0x80 : 0) | 127]), Buffer.from(BigInt(len).toString(16).padStart(16, '0'), 'hex')]);
  if (!mask) return Buffer.concat([head, payload]);
  const k = crypto.randomBytes(4);
  return Buffer.concat([head, k, Buffer.from(payload.map((b, i) => b ^ k[i % 4]))]);
};
{
  const open = [];
  const codes = [];
  for (let i = 0; i < 10; i++) { const w = await ws(as('198.51.100.80')); codes.push(w.status); if (w.status === 101) open.push(w.s); else w.s.destroy(); }
  check('ws', 'sockets per address are capped (101 up to the cap, then 429)', codes.filter(c => c === 101).length >= 1 && codes.filter(c => c === 101).length <= 6 && codes.includes(429), codes.join(','));
  const w2 = await ws(as('198.51.100.81'));
  check('ws', 'another address can still connect', w2.status === 101, `${w2.status}`);
  // An unmasked frame, an oversized claim: the socket is closed by the herald.
  const closed = s => new Promise(res => { let t = setTimeout(() => res(false), 4000); s.on('close', () => { clearTimeout(t); res(true); }); s.on('end', () => { clearTimeout(t); res(true); }); });
  if (w2.status === 101) { const c = closed(w2.s); w2.s.write(frame(1, Buffer.from('{}'), { mask: false })); check('ws', 'an unmasked frame closes the socket', await c); }
  const w3 = await ws(as('198.51.100.82'));
  if (w3.status === 101) { const c = closed(w3.s); w3.s.write(frame(1, Buffer.alloc(8), { claim: 10 * 1024 * 1024 }).subarray(0, 14)); check('ws', 'a frame claiming 10 MiB closes the socket', await c); }
  const w4 = await ws(as('198.51.100.83'));
  if (w4.status === 101) { w4.s.write(frame(1, Buffer.from('{"op":"nonsense"}'))); const got = await new Promise(res => { const t = setTimeout(() => res(''), 3000); w4.s.once('data', d => { clearTimeout(t); res(d.toString('latin1')); }); }); check('ws', 'a malformed subscription is answered with an error, not a crash', /error|BadSub|Bad/i.test(got) || got.length > 0, got.slice(2, 60)); w4.s.destroy(); }
  for (const s of open) s.destroy();
  w2.s.destroy(); w3.s.destroy();
  await new Promise(r => setTimeout(r, 400));
  const again = await ws(as('198.51.100.80'));
  check('ws', 'closing sockets frees the address\'s slots', again.status === 101, `${again.status}`);
  again.s.destroy();
  const st = JSON.parse((await req('GET', '/h/status', { headers: as('203.0.113.90') })).body || '{}');
  check('ws', 'the herald counts its sockets (/h/status ws.open is small after the test)', (st.ws?.open ?? 99) <= 3, JSON.stringify(st.ws));
}

// ------------------------------------------------------------------ body and methods
{
  const big = await req('POST', '/gw/f/relay', { body: JSON.stringify({ tx: 'A'.repeat(70 * 1024) }), headers: { 'Content-Type': 'application/json', ...as('203.0.113.95') } });
  check('body', 'a 70 KiB body to /gw is refused (413)', big.status === 413, `${big.status}`);
  for (const m of ['PUT', 'DELETE', 'PATCH']) { const r = await req(m, '/gw/f/join', { body: '{}', headers: as('203.0.113.96') }); check('body', `${m} /gw is 405`, r.status === 405, `${r.status}`); }
  const tr = await req('TRACE', '/gw/f/season', { headers: as('203.0.113.96') });
  check('body', 'TRACE is refused', [405, 400, 404].includes(tr.status), `${tr.status}`);
  const post = await req('POST', '/h/season', { body: '{}', headers: as('203.0.113.97') });
  check('body', 'POST /h/season is not a thing (405/404)', [405, 404].includes(post.status), `${post.status}`);
}
// Half-open connections do not stop the service.
{
  const socks = [];
  for (let i = 0; i < 150; i++) { const s = net.connect(HERALD.port, HERALD.hostname); s.on('error', () => {}); s.on('connect', () => s.write('GET /h/season HTTP/1.1\r\nHost: x\r\nX-Slow: ')); socks.push(s); }
  await new Promise(r => setTimeout(r, 600));
  const t0 = Date.now();
  const r = await req('GET', '/h/season', { headers: as('203.0.113.99') });
  check('body', '150 half-written requests are open: a normal request is still answered quickly', r.status === 200 && Date.now() - t0 < 2000, `${r.status} ${Date.now() - t0} ms`);
  for (const s of socks) s.destroy();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(f => `${f.group}: ${f.name}`).join(' | ')}` : ''}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ herald: HERALD.origin, at: new Date().toISOString(), results }, null, 1));
process.exit(failed.length ? 1 : 0);
