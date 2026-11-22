// B13 (loop-play2), TEST-ONLY `--coop-board`: workstream 01's co-op board served by the local-play launcher under a
// world's mount. Loopback 41280–41283 only. THIS FILE MAKES NO KEY: records carry ①'s key-free test mark
// (workstreams/01-national-strategy/test/nokey.mjs) and the board's signature check is that mark's. No chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import { createLauncherServer, parseConfig } from '../src/frontier/local-play-launcher.mjs';
import { COOP_BOARD_MODE, BOARD_PAGE_CSP, coopMount, coopRouteOf, openWorldBoard, chainWallClock, wallClockReader } from '../src/frontier/local-play-coop-board.mjs';
import { createBoard, fixedSigner, unsignedRecord } from '../../workstreams/01-national-strategy/test/nokey.mjs';
import { PAGE } from '../../workstreams/01-national-strategy/coop/board.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';

const LAUNCHER = 41280, WORLD = 41282, PAIR = 41283;
const PROGRAM = LP.LOCAL_PLAY_PROGRAM;
const listen = (srv, port) => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
const close = srv => new Promise(r => { srv.close(() => r()); srv.closeAllConnections?.(); });
/** One raw request (fetch cannot set Host): → {status, headers, text}. */
const raw = ({ port = LAUNCHER, method = 'GET', path: p, headers = {}, body = null }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject); req.end(body ?? undefined);
});

async function world(t, { coopBoard = true } = {}) {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-coop-launcher-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  // (the world's proxy, standing in: the board reads /h/caravans.json through it; the page's /h/* reads are passed to it)
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin ?? null });
    if (req.url === '/h/caravans.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ moving: [], ended: [], vaults: [] })); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ herald: req.url }));
  });
  await listen(proxy, WORLD);
  t.after(() => close(proxy));
  const board = createBoard({ herald: `http://127.0.0.1:${WORLD}`, programId: PROGRAM, seasonId: '11', dataDir: path.join(tmp, 'coop') });
  const entry = { board, ports: [WORLD, PAIR] };
  const manager = { coopFor: port => (entry.ports.includes(port) ? entry : null), close: () => {} };
  const { server } = createLauncherServer({ port: LAUNCHER, worldPort: 41284, web: tmp, ...(coopBoard ? { coopBoard: true } : {}) }, manager);
  await listen(server, LAUNCHER);
  t.after(() => close(server));
  return { tmp, board, seen };
}

const ORIGIN = `http://127.0.0.1:${LAUNCHER}`;

test('the mount: a five-digit proxy port, then the rest', () => {
  assert.equal(coopMount(41006), '/coop-world/41006');
  assert.deepEqual(coopRouteOf('/coop-world/41006/coop/config'), { port: 41006, rest: '/coop/config' });
  assert.deepEqual(coopRouteOf('/coop-world/41006'), { port: 41006, rest: '/' });
  for (const bad of ['/coop-world/abc/coop/config', '/coop-world/410/coop', '/coop/config', '/frontier/coop-world/41006/x']) assert.equal(coopRouteOf(bad), null, bad);
});

test('the command line: --coop-board in exactly its one word', async t => {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-coop-argv-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const bin = path.join(tmp, 'bin'); await fsp.writeFile(bin, 'x');
  await fsp.mkdir(path.join(tmp, 'permutation-server/web'), { recursive: true });
  await fsp.mkdir(path.join(tmp, 'permutation-gateway/src/frontier'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), '');
  const base = { root: tmp, data: path.join(tmp, 'data'), runner: bin, herald: bin, depart: bin, preview: bin, resident: bin, artifact: bin, 'artifact-sha': 'cd'.repeat(32), port: '41280', 'world-port': '41284' };
  const argv = o => Object.entries(o).flatMap(([k, v]) => [`--${k}`, String(v)]);
  assert.equal((await parseConfig(argv({ ...base, 'coop-board': COOP_BOARD_MODE }))).coopBoard, true);
  assert.equal((await parseConfig(argv(base))).coopBoard, undefined);
  await assert.rejects(parseConfig(argv({ ...base, 'coop-board': 'yes' })), e => e.code === 'InvalidCoopBoard');
});

test("a world's board is opened for the runner's own program and Season, its records in the world's directory", async t => {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-coop-open-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const made = [];
  const deps = { createBoard: o => { made.push(o); return { o }; }, rpcReader: url => ({ url }) };
  const e = await openWorldBoard({ dir: tmp, meta: { program: PROGRAM, season_id: 11, rpc_url: 'http://127.0.0.1:41284' }, heraldPort: WORLD, pairPort: PAIR, deps });
  assert.deepEqual(e.ports, [WORLD, PAIR]);
  // (fix-loop8, LP8-3: the reader is ①'s rpcReader of the world's RPC with its blockTime put on the board's clock)
  assert.deepEqual([made[0].herald, made[0].programId, made[0].seasonId, made[0].dataDir, made[0].rpc, made[0].reader.url, typeof made[0].reader.transaction, made[0].cluster],
    [`http://127.0.0.1:${WORLD}`, PROGRAM, '11', path.join(tmp, 'coop'), 'http://127.0.0.1:41284', 'http://127.0.0.1:41284', 'function', 'localnet']);
  e.stop();
  await assert.rejects(openWorldBoard({ dir: tmp, meta: { program: PROGRAM, season_id: 11, rpc_url: 'http://example.com:1' }, heraldPort: WORLD, deps }), e2 => e2.code === 'CoopBoardNotReady');
});

test("the launcher serves ①'s board under the world's mount: config, page, records, view, herald reads", { timeout: 30000 }, async t => {
  const { seen } = await world(t);
  const m = coopMount(WORLD);
  // config: the page is named under THIS mount (the game opens it there); the internal herald address is not given
  const cfg = await raw({ path: `${m}/coop/config` });
  assert.equal(cfg.status, 200);
  const c = JSON.parse(cfg.text);
  assert.deepEqual(c.season, { programId: PROGRAM, seasonId: '11' });
  assert.equal(c.page, `${m}${PAGE}`); assert.equal(c.mount, m); assert.equal(c.herald, null);
  assert.equal(c.relay, null, 'no relay under the mount: ①\'s page offers no caravan send from itself');
  // the pair's second proxy names the same board, under its own mount
  assert.equal(JSON.parse((await raw({ path: `${coopMount(PAIR)}/coop/config` })).text).page, `${coopMount(PAIR)}${PAGE}`);
  // ①'s page and the modules it imports, with the board page's own policy
  const page = await raw({ path: `${m}${PAGE}` });
  assert.equal(page.status, 200); assert.match(page.text, /国をまたぐ依頼/);
  assert.equal(page.headers['content-security-policy'], BOARD_PAGE_CSP);
  assert.equal((await raw({ path: `${m}/ws01/repo/workstreams/01-national-strategy/coop/mount.mjs` })).status, 200);
  assert.equal((await raw({ path: `${m}/ws01/repo/permutation-server/web/wallet.mjs` })).status, 200);
  assert.equal((await raw({ path: `${m}/ws01/repo/frontier-node/Cargo.toml` })).status, 404, 'nothing outside ①\'s page and the web modules');
  assert.equal((await raw({ path: `${m}/ws01/repo/../../etc/passwd` })).status, 400);
  assert.equal((await raw({ path: `${m}/ws01/` })).headers.location, `${m}${PAGE}`);
  // a record: only from the launcher's own origin, as JSON
  const a = await fixedSigner(Array.from({ length: 32 }, (_, i) => i + 1));
  const now = Math.floor(Date.now() / 1000);
  const rec = await unsignedRecord(a, { v: 1, season: { programId: PROGRAM, seasonId: '11' }, at: now, kind: 'request', goalId: 'crossing-storehouse-v1', need: { wood: 1 },
    to: { kind: 'holding', p: -1, q: 2, site: 0, gen: 0 }, nation: 1, expiresAt: now + 3600, nonce: 'b13' });
  const body = JSON.stringify(rec);
  assert.equal((await raw({ method: 'POST', path: `${m}/coop/records`, headers: { 'content-type': 'application/json' }, body })).status, 403, 'no Origin: refused');
  assert.equal((await raw({ method: 'POST', path: `${m}/coop/records`, headers: { origin: 'http://127.0.0.1:41999', 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await raw({ method: 'POST', path: `${m}/coop/records`, headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body })).status, 403);
  const ok = await raw({ method: 'POST', path: `${m}/coop/records`, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body });
  assert.equal(ok.status, 200, ok.text); assert.equal(JSON.parse(ok.text).ok, true);
  const view = JSON.parse((await raw({ path: `${m}/coop/view` })).text);
  assert.equal(view.requests.length, 1); assert.deepEqual(view.requests[0].to, { kind: 'holding', p: -1, q: 2, site: 0, gen: 0 });
  // the read-only RPC: this board has none (no --rpc), said as such
  assert.equal((await raw({ method: 'POST', path: `${m}/coop/rpc`, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{"method":"getAccountInfo"}' })).status, 404);
  // the world's public herald, GET only, through its proxy with the proxy's own Host and no Origin
  const h = await raw({ path: `${m}/h/status?x=1` });
  assert.deepEqual([h.status, JSON.parse(h.text)], [200, { herald: '/h/status?x=1' }]);
  const last = seen.at(-1);
  assert.deepEqual([last.host, last.origin], [`127.0.0.1:${WORLD}`, null]);
  assert.equal((await raw({ method: 'POST', path: `${m}/h/status`, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status, 405);
  // nothing else under the mount: no relay, no other path
  assert.equal((await raw({ method: 'POST', path: `${m}/gw/f/local-play/act/submit`, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status, 405);
  assert.equal((await raw({ path: `${m}/gw/f/local-play/info` })).status, 404);
  // another site's page cannot read it; another Host is refused before anything
  assert.equal((await raw({ path: `${m}/coop/view`, headers: { origin: 'http://evil.localhost:1' } })).status, 403);
  assert.equal((await raw({ path: `${m}/coop/config`, headers: { host: 'evil.example:41280' } })).status, 403);
  // no live world behind that port: no board (the page hides its slot)
  assert.equal((await raw({ path: `${coopMount(41289)}/coop/config` })).status, 404);
});

test('a launcher started without --coop-board serves no board (the page hides its slot, as before)', { timeout: 30000 }, async t => {
  await world(t, { coopBoard: false });
  const r = await raw({ path: `${coopMount(WORLD)}/coop/config` });
  assert.equal(r.status, 404);
});

// (fix-loop8, LP8-3 — live: a ×60 local world's chain blockTime was ~112 days behind the board's wall clock, so ①'s
//  timing rule — sent after the answer, ±5 s — read every caravan as 「応じる前に送った隊商」 and none was ever counted)
test('fix-loop8 LP8-3: the chain\'s blockTime is put on the board\'s wall clock by interpolating (chain, wall) samples; ①\'s rule is unchanged', async () => {
  // a ×60 chain: chain = C0 + 60 × (wall − W0)
  const C0 = 1785649416, W0 = 1795309161;
  let wall = W0;
  const call = async (method, params) => (method === 'getSlot' ? 9872 + Math.round((wall - W0) / 0.4) : C0 + 60 * (wall - W0));
  const clock = chainWallClock({ call, now: () => wall });
  assert.equal(clock.wallOf(C0 + 600), C0 + 600, 'no sample yet: as the chain gave it');
  await clock.sample();
  assert.equal(clock.wallOf(C0), W0, 'one sample: the offset');
  for (let i = 0; i < 30; i++) { wall += 2; await clock.sample(); }
  assert.equal(clock.samples, 31);
  // a caravan sent 41 s of wall time after the first sample
  assert.equal(clock.wallOf(C0 + 60 * 41), W0 + 41, 'inside the samples: interpolated');
  assert.equal(clock.wallOf(C0 + 60 * 70), W0 + 70, 'past the last sample: the last rate');
  assert.equal(clock.wallOf(C0 - 60 * 10), W0 - 10, 'before the first: the first rate');
  // a chain that stalls (the runner under load) gives no backward or repeated samples
  const before = clock.samples; assert.equal(await clock.sample(), false); assert.equal(clock.samples, before, 'the same chain time again: not kept');
  const failing = chainWallClock({ call: async () => { throw new Error('down'); } });
  assert.equal(await failing.sample(), false); assert.equal(failing.wallOf(5), 5);
  // the reader: only a transaction's blockTime moves; null and absent stay
  const r = wallClockReader({ account: async () => 'acc', transaction: async s => (s === 'none' ? null : { slot: 1, blockTime: s === 'nobt' ? null : C0 + 60 * 41, err: null }) }, clock);
  assert.equal(await r.account('x'), 'acc');
  assert.equal((await r.transaction('sig')).blockTime, W0 + 41);
  assert.equal(await r.transaction('none'), null);
  assert.equal((await r.transaction('nobt')).blockTime, null);
  // ①'s own rule, unchanged: an answer received at W0 + 30 and that caravan → after
  const { timingOf } = await import('../../workstreams/01-national-strategy/coop/goal.mjs');
  assert.equal(timingOf((await r.transaction('sig')).blockTime, W0 + 30).status, 'after');
  assert.equal(timingOf(C0 + 60 * 41, W0 + 30).status, 'before', 'the raw chain time read "before" (the bug)');
});
