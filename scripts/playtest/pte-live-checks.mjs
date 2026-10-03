// PT-E live checks against the rehearsal herald (loopback, TEST-NET client addresses only)
import http from 'node:http';
const H = { host: '127.0.0.1', port: 41117 };
const call = (method, path, { body = null, headers = {} } = {}) => new Promise(res => {
  const data = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const r = http.request({ ...H, method, path, agent: false, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, x => { let s = ''; x.on('data', d => { s += d; }); x.on('end', () => res({ status: x.statusCode, body: s.slice(0, 200) })); });
  r.on('error', e => res({ status: 0, body: e.message })); if (data) r.write(data); r.end();
});
const as = ip => ({ 'CF-Connecting-IP': ip });
let bad = 0; const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}  [${d}]`); if (!c) bad++; };
const st = await (await fetch('http://127.0.0.1:41117/h/season')).json();
// the chain's own clock (the game time), not the wall clock
const bell = Math.floor((Number(st.latestUnix) - Number(st.genesisTs)) / Number(st.bellSecs));
console.log('bell now', bell);
const n = async (b, ip) => call('POST', '/gw/f/nudge', { body: b, headers: as(ip) });
let r;
r = await n({ province: [0, 0], bell: 4294967295 }, '203.0.113.141'); ok('nudge: u32 bell on an existing province refused', r.status === 400, `${r.status} ${r.body}`);
r = await n({ province: [0, 0], bell: bell + 5 }, '203.0.113.141'); ok('nudge: a bell 5 ahead refused', r.status === 400, `${r.status}`);
r = await n({ province: [12000, -12000], bell: Math.max(bell, 0) }, '203.0.113.141'); ok('nudge: a made-up province refused', r.status === 400, `${r.status} ${r.body}`);
r = await n({ province: [0, 0], bell: Math.max(bell, 0) }, '203.0.113.142'); ok('nudge: the current bell on a real province reaches the keeper (not a 4xx from the relay check)', [200, 202, 409, 503].includes(r.status), `${r.status} ${r.body}`);
r = await n({ province: [0, 0], bell: 0 }, '203.0.113.143'); ok('nudge: a lagging resolved_next (bell 0) is still accepted, as the page sends it', [200, 202, 409, 503].includes(r.status), `${r.status} ${r.body}`);
r = await call('POST', '/gw/f/relay', { body: JSON.stringify({ tx: 'A'.repeat(80 * 1024) }), headers: as('203.0.113.144') }); ok('/gw: an 80 KiB body is refused before it is read in full', r.status === 413, `${r.status}`);
r = await call('POST', '/gw/f/relay', { body: JSON.stringify({ tx: 'A'.repeat(66 * 1024) }), headers: as('203.0.113.144') }); ok('/gw: a 66 KiB body is refused (413)', r.status === 413, `${r.status}`);
r = await call('POST', '/gw/f/relay', { body: JSON.stringify({ tx: 'A'.repeat(2 * 1024 * 1024) }), headers: as('203.0.113.145') }); ok('/gw: a 2 MiB body is refused (413)', r.status === 413, `${r.status}`);
// the localnet's own RPC
const rpc = (headers = {}) => call('POST', '/', { body: { jsonrpc: '2.0', id: 1, method: 'getHealth' }, headers });
const L = { host: '127.0.0.1', port: 41112 };
const lcall = (headers) => new Promise(res => { const d = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }); const q = http.request({ ...L, method: 'POST', path: '/', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), ...headers } }, x => { let s = ''; x.on('data', c => { s += c; }); x.on('end', () => res({ status: x.statusCode, body: s.slice(0, 80) })); }); q.on('error', e => res({ status: 0, body: e.message })); q.end(d); });
r = await lcall({}); ok('localnet RPC: a normal local call works', r.status === 200, `${r.status} ${r.body}`);
r = await lcall({ Host: 'localhost:41112' }); ok('localnet RPC: Host localhost:41112 works', r.status === 200, `${r.status}`);
r = await lcall({ Host: 'attacker.example:41112' }); ok('localnet RPC: a rebound Host (attacker.example) is refused', r.status === 403, `${r.status}`);
r = await lcall({ Host: '127.0.0.1.attacker.example' }); ok('localnet RPC: Host 127.0.0.1.attacker.example is refused', r.status === 403, `${r.status}`);
r = await lcall({ Origin: 'https://attacker.example' }); ok('localnet RPC: a request with an Origin header is refused', r.status === 403, `${r.status}`);
r = await new Promise(res => { const q = http.request({ ...L, method: 'POST', path: '/', agent: false, headers: { 'content-type': 'application/json', Host: 'attacker.example' } }, x => { let s=''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode, body: s })); }); q.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'frontier_pause' })); });
ok('localnet RPC: frontier_pause from a rebound Host does nothing (403)', r.status === 403, `${r.status}`);
const stt = await lcall({}); void stt;
const paused = await new Promise(res => { const d = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'frontier_status' }); const q = http.request({ ...L, method: 'POST', path: '/', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, x => { let s=''; x.on('data', c => s += c); x.on('end', () => res(JSON.parse(s).result.paused)); }); q.end(d); });
ok('localnet: the chain is not paused', paused === false, String(paused));
// herald: the expensive routes
const ip = '203.0.113.150'; const codes = {};
for (let i = 0; i < 400; i++) { const x = await call('GET', '/h/events?after=0', { headers: as(ip) }); codes[x.status] = (codes[x.status] ?? 0) + 1; }
ok('herald: /h/events costs 10 tokens: of 400 quick calls from one address about 150 pass (bucket 1,500 / 10), the rest are 429', (codes[429] ?? 0) >= 230 && (codes[200] ?? 0) + (codes[503] ?? 0) <= 170, JSON.stringify(codes));
const t0 = Date.now(); const s2 = await call('GET', '/h/season', { headers: as('203.0.113.151') }); ok('herald: /h/season for another address is quick meanwhile', s2.status === 200 && Date.now() - t0 < 500, `${Date.now() - t0} ms`);
console.log(bad ? `FAILED ${bad}` : 'all ok'); process.exit(bad ? 1 : 0);
