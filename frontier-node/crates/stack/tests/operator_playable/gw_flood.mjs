// PGWF (fix-gw-highs; security audit H-1, H-2): an offline flood of keeper A's anonymous routes through the herald's
// `/gw`, 127.0.0.1 only. It plays an attacker that needs no wallet:
//   * forged reveals: a fresh random holding, host and salt each time, a plaintext that passes the keeper's shape and
//     plaintext checks (so before fix-gw-highs each one reached the chain gate: the Clock and getMultipleAccounts on
//     the pacer every keeper duty shares);
//   * far-future nudges: bell 4294967295 for every province of a grid (before: SkipQuiet each bell, season-long).
// Phase `one` sends from ONE client address (X-Forwarded-For through the herald, which takes the last entry from a
// loopback peer), then phase `many` rotates addresses (a fresh one per request: the per-address buckets never fill).
// Every 2 s it samples keeper A's `/v1/status` (bell, slot, `api` counters) and writes the whole report to `--out`
// (so a killed run keeps what it measured). SIGTERM ends it.
//
//   node gw_flood.mjs --herald P --keeper P --token T --gw-op P --op-token T --out F [--one-secs 60] [--workers 24]
//                     [--off]   (baseline: only the sampler)
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import http from 'node:http';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const herald = Number(arg('herald'));
const keeper = Number(arg('keeper'));
const token = arg('token');
const gwOp = Number(arg('gw-op', '0'));
const opToken = arg('op-token', '');
const out = arg('out');
const oneSecs = Number(arg('one-secs', '60'));
const workers = Number(arg('workers', '24'));
const off = process.argv.includes('--off');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex')}`);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = `1${s}`; }
  return s;
}

/** A plaintext that passes `fclient::seal::validate` against itself: version 1, no path, tile 0, stance 0. */
function plain() {
  const b = Buffer.alloc(37);
  b[0] = 1;
  randomBytes(8).copy(b, 1); // host id
  b.writeUInt32LE(20 + Math.floor(Math.random() * 10), 9); // arrival bell
  return b;
}

function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, timeout: 15_000,
      headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { json = null; }
        resolve({ status: res.statusCode, json, ms: performance.now() - t0 });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, json: { code: e.message }, ms: performance.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}

const report = { started: new Date().toISOString(), off, oneSecs, workers, phases: {}, samples: [], guard: null, keeperApi: null };
const t0 = Date.now();
const phase = () => (Date.now() - t0 < oneSecs * 1000 ? 'one' : 'many');
let ipSeq = 0;
const ipOf = p => (p === 'one' ? '203.0.113.7' : `198.${18 + ((ipSeq >> 16) & 1)}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`);
const provinces = [];
for (let p = -6; p <= 6; p++) for (let q = -6; q <= 6; q++) if (Math.abs(p + q) <= 6) provinces.push([p, q]);

function tally(p, kind, r) {
  const ph = (report.phases[p] ??= { since: Date.now() - t0, sent: {}, answers: {}, ms: {} });
  ph.sent[kind] = (ph.sent[kind] ?? 0) + 1;
  const key = `${kind} ${r.status} ${r.json?.code ?? r.json?.error ?? (r.json?.accepted ? 'accepted' : r.json?.queued ? 'queued' : '')}${r.json?.reason ? `/${r.json.reason}` : ''}`;
  ph.answers[key] = (ph.answers[key] ?? 0) + 1;
  const m = (ph.ms[kind] ??= { n: 0, sum: 0, max: 0 });
  m.n += 1; m.sum += r.ms; m.max = Math.max(m.max, r.ms);
}

let stop = false;
async function worker(id) {
  let i = id;
  while (!stop) {
    const p = phase();
    const headers = { 'X-Forwarded-For': ipOf(p) };
    if (i++ % 4 === 3) {
      const [pp, qq] = provinces[i % provinces.length];
      tally(p, 'nudge', await request(herald, 'POST', '/gw/f/nudge', { body: { province: [pp, qq], bell: 4294967295 }, headers }));
    } else {
      const body = { holding: base58(randomBytes(32)), transit_slot: i % 4, plain_b64: plain().toString('base64'),
        salt_b64: randomBytes(32).toString('base64'), ct_hash_b64: randomBytes(32).toString('base64') };
      tally(p, 'reveal', await request(herald, 'POST', '/gw/f/reveal', { body, headers }));
    }
  }
}

async function sample() {
  const r = await request(keeper, 'GET', '/v1/status', { headers: { Authorization: `Bearer ${token}` } });
  const s = r.json ?? {};
  report.samples.push({ t: Date.now() - t0, phase: off ? 'off' : phase(), ms: Math.round(r.ms), status: r.status, bell: s.bell ?? null, slot: s.slot ?? null,
    nextBell: s.duties?.next_bell ?? null, api: s.api ?? null });
  report.keeperApi = s.api ?? report.keeperApi;
}

async function flush() {
  if (gwOp) {
    const g = await request(gwOp, 'GET', '/f/operator/keeper-guard', { headers: { Authorization: `Bearer ${opToken}` } });
    report.guard = g.status === 200 ? g.json : { status: g.status, body: g.json };
  }
  report.elapsedSecs = (Date.now() - t0) / 1000;
  writeFileSync(out, JSON.stringify(report, null, 1));
}

process.on('SIGTERM', async () => { stop = true; await flush(); process.exit(0); });
const sampler = setInterval(() => { sample().then(flush).catch(() => {}); }, 2_000);
sampler.unref?.();
if (!off) await Promise.all(Array.from({ length: workers }, (_, k) => worker(k)));
else await new Promise(() => {});
