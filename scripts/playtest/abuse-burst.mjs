// An invalid-invite and junk burst against the front door (PT-C drill), loopback herald only:
//
//   node scripts/playtest/abuse-burst.mjs --herald http://127.0.0.1:41117
//
// The attackers are TEST-NET addresses given to the herald the way a tunnel gives it a client (CF-Connecting-IP from a
// loopback peer). One honest control address asks the same routes while the flood runs, so the output says whether
// a flooded address is limited and an unrelated one is not. Bodies are junk by design: no Join is sent, no
// sponsor lamport can move.
//   A  invite-check with random (invalid) codes, 300 requests in about 5 s from one address
//   B  POST /gw/f/join with a junk transaction and a garbage invite, 200 requests from one address
//   C  POST /gw/f/relay junk, 200 requests from one address
//   D  a spread: 100 addresses x 3 requests of invite-check (each stays under the limit: all pass, and the relay's
//      own checks, not the limits, are what answer "invalid")
// Prints one summary line per case and exits 0 when: the flooders were limited (429 appears), the honest address
// was never limited, and no answer was a 5xx.
import http from 'node:http';
import crypto from 'node:crypto';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const H = new URL(arg('herald', 'http://127.0.0.1:41117'));
if (!/^(127\.0\.0\.1|localhost)$/.test(H.hostname) || !(Number(H.port) >= 41100 && Number(H.port) <= 41139)) { console.error('loopback playtest ports only'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
function post(path, body, ip) {
  return new Promise(res => {
    const t = Date.now(); const data = JSON.stringify(body);
    const r = http.request({ host: H.hostname, port: H.port, method: 'POST', path, agent, timeout: 10_000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'CF-Connecting-IP': ip } }, x => { let s = ''; x.on('data', d => { s += d; }); x.on('end', () => res({ status: x.statusCode, ms: Date.now() - t, body: s.slice(0, 120) })); });
    r.on('timeout', () => { r.destroy(); res({ status: 0, ms: Date.now() - t, body: 'timeout' }); });
    r.on('error', e => res({ status: 0, ms: Date.now() - t, body: e.message }));
    r.end(data);
  });
}
const tally = rs => rs.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
const code = () => crypto.randomBytes(28).toString('base64url');
const lat = rs => { const s = rs.map(r => r.ms).sort((a, b) => a - b); return { p50: s[Math.floor(s.length / 2)], max: s.at(-1) }; };

let bad = 0;
const honest = []; const honestIp = '203.0.113.200';
const honestLoop = (async () => { for (let i = 0; i < 12; i++) { honest.push(await post('/gw/f/invite-check', { invite: code() }, honestIp)); await sleep(2500); } })();

const A = []; const t0 = Date.now();
for (let i = 0; i < 300; i++) { A.push(post('/gw/f/invite-check', { invite: code() }, '198.51.100.1')); if (i % 30 === 29) await sleep(500); }
const a = await Promise.all(A);
console.log(JSON.stringify({ case: 'A invite-check flood', n: a.length, ms: Date.now() - t0, statuses: tally(a), latency: lat(a) }));
const b = await Promise.all(Array.from({ length: 200 }, () => post('/gw/f/join', { tx: Buffer.from('junk').toString('base64'), invite: code() }, '198.51.100.2')));
console.log(JSON.stringify({ case: 'B junk join flood', n: b.length, statuses: tally(b), latency: lat(b), sample: b.find(x => x.status >= 400 && x.status !== 429)?.body }));
const c = await Promise.all(Array.from({ length: 200 }, () => post('/gw/f/relay', { tx: Buffer.from('junk').toString('base64') }, '198.51.100.3')));
console.log(JSON.stringify({ case: 'C junk relay flood', n: c.length, statuses: tally(c), latency: lat(c) }));
const d = await Promise.all(Array.from({ length: 100 }, (_, i) => Promise.all([0, 1, 2].map(() => post('/gw/f/invite-check', { invite: code() }, `192.0.2.${i + 1}`)))));
const dd = d.flat();
console.log(JSON.stringify({ case: 'D spread over 100 addresses', n: dd.length, statuses: tally(dd), latency: lat(dd) }));
await honestLoop;
console.log(JSON.stringify({ case: 'honest control during the flood', n: honest.length, statuses: tally(honest), latency: lat(honest) }));
if (!(tally(a)[429] > 0)) { console.log('FAIL: the invite-check flood was never limited'); bad++; }
if (!(tally(b)[429] > 0)) { console.log('FAIL: the junk join flood was never limited'); bad++; }
if (honest.some(r => r.status !== 200)) { console.log('FAIL: the honest address was refused during the flood'); bad++; }
if ([...a, ...b, ...c, ...dd].some(r => r.status >= 500 || r.status === 0)) { console.log('FAIL: a 5xx or no answer'); bad++; }
console.log(bad ? 'abuse-burst: FAILED' : 'abuse-burst: ok');
agent.destroy();
process.exit(bad ? 1 : 0);
