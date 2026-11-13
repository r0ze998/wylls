// The NATURAL world (launcher `--world-preset local-natural-v1`): the command line, the world start with stand-in
// processes (the natural runner's arguments, the herald WITHOUT --local-play-metadata, `natural: true` in the answer,
// a plain runner never taken for a natural one) and the gate's herald check (an unjoined wallet accepted ONLY on the
// launcher's word `natural: true`).
//
// THIS FILE MAKES NO KEY and runs under the no-key guard:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/frontier-local-play-natural.test.mjs
// Stand-in runner/herald/relay scripts in a temp dir, on loopback 41980–41989 only; every process it starts is stopped
// by its own world's stop. No chain, world, real binary or stored key.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { parseConfig, startWorld, WorldManager, NATURAL_WORLD_PRESET } from '../src/frontier/local-play-launcher.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import { decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', OTHER = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
const SEASON = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '11').season;

async function tree(t, { runnerMode = 'natural' } = {}) {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-natural-test-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const script = async (rel, source) => { const f = path.join(tmp, rel); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, `#!${process.execPath}\n${source}`, { mode: 0o755 }); return f; };
  const head = `const fs = require('node:fs'), path = require('node:path'), http = require('node:http');\nconst arg = k => process.argv[process.argv.indexOf(k) + 1];\nprocess.on('SIGINT', () => process.exit(0));\n`;
  const runner = await script('bin/natural-runner', head + `
fs.writeFileSync(path.join(__dirname, '..', 'runner-args.json'), JSON.stringify(process.argv.slice(2)));
const MODE = ${JSON.stringify(runnerMode)};
const meta = { program: ${JSON.stringify(LP.LOCAL_PLAY_PROGRAM)}, rpc_url: 'http://127.0.0.1:' + arg('--rpc-port'), season: ${JSON.stringify(SEASON)}, season_id: 11,
  player_wallet: arg('--player-wallet'), artifact: { sha256: arg('--artifact-sha256') } };
if (MODE === 'natural') Object.assign(meta, { world: 'natural', world_preset: 'local-natural-v1' });
if (MODE === 'other-preset') Object.assign(meta, { world: 'natural', world_preset: 'local-conquest-test-v1' });
console.log(JSON.stringify(meta));
setInterval(() => {}, 1000);
`);
  const plain = await script('bin/plain-runner', head + `fs.writeFileSync(path.join(__dirname, '..', 'plain-args.json'), '[]'); setInterval(() => {}, 1000);`);
  const herald = await script('bin/herald', head + `
fs.writeFileSync(path.join(__dirname, '..', 'herald-args.json'), JSON.stringify(process.argv.slice(2)));
const [host, port] = arg('--listen').split(':');
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }).listen(Number(port), host);
`);
  // (the relay is an ES module: started as `node <file>.mjs`)
  await script('permutation-gateway/src/frontier/local-play-relay-server.mjs', `import fs from 'node:fs'; import path from 'node:path';
const arg = k => process.argv[process.argv.indexOf(k) + 1];
process.on('SIGINT', () => process.exit(0));
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'relay-args.json'), JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ listen: 'http://127.0.0.1:' + arg('--listen-port') }));
setInterval(() => {}, 1000);
`);
  await fsp.mkdir(path.join(tmp, 'permutation-server/web'), { recursive: true });
  const so = path.join(tmp, 'bin/program.so'); await fsp.writeFile(so, 'x');
  const c = { root: tmp, data: path.join(tmp, 'data'), runner: plain, naturalRunner: runner, herald, depart: plain, preview: plain, resident: plain, artifact: so, artifactSha: 'cd'.repeat(32),
    port: 41979, worldPort: 41980, economy: 'page-signed-v1', worldPreset: NATURAL_WORLD_PRESET, guard: { naturalFirstLineMs: 8000 } };
  await fsp.mkdir(c.data, { recursive: true });
  const read = async f => JSON.parse(await fsp.readFile(path.join(tmp, f), 'utf8'));
  return { tmp, c, read, so };
}

test('the command line: the natural preset needs its runner and the economy, and takes no preparation or conquest CLI', { timeout: 60000 }, async t => {
  const { tmp, c, so } = await tree(t);
  const base = { root: tmp, data: path.join(tmp, 'data2'), runner: c.runner, herald: c.herald, depart: c.runner, preview: c.runner, resident: c.runner, artifact: so, 'artifact-sha': 'cd'.repeat(32) };
  const argv = o => Object.entries(o).flatMap(([k, v]) => [`--${k}`, String(v)]);
  const natural = { ...base, 'world-preset': 'local-natural-v1', 'natural-runner': c.naturalRunner, economy: 'page-signed-v1' };
  const good = await parseConfig(argv(natural));
  assert.equal(good.worldPreset, 'local-natural-v1'); assert.equal(good.naturalRunner, c.naturalRunner); assert.equal(good.prepareScale, undefined);
  const refused = (o, code) => assert.rejects(parseConfig(argv(o)), e => e.code === code, code);
  const { 'natural-runner': _r, ...noRunner } = natural; await refused(noRunner, 'NaturalNeedsRunner');
  const { economy: _e, ...noEconomy } = natural; await refused(noEconomy, 'NaturalNeedsEconomy');
  await refused({ ...natural, 'prepare-scale': '20' }, 'NaturalHasNoPreparation');
  await refused({ ...natural, conquest: c.runner }, 'ConquestNeedsWorldPreset');
  await refused({ ...natural, 'natural-runner': 'relative/runner' }, 'AbsolutePathRequired');
  await refused({ ...base, 'natural-runner': c.naturalRunner }, 'NaturalRunnerNeedsPreset');
  await refused({ ...natural, 'natural-runner': path.join(tmp, 'bin/missing') }, 'MissingFile');
  // the default and the conquest preset are as before
  assert.equal((await parseConfig(argv(base))).worldPreset, undefined);
  await refused({ ...base, 'world-preset': 'local-conquest-test-v1' }, 'WorldPresetNeedsPrepare');
  await refused({ ...base, 'world-preset': 'local-natural-v2' }, 'InvalidWorldPreset');
});

test('a natural world: its own runner with the keeper and no wide destination; the herald folds real transactions only; the answer says natural', { timeout: 60000 }, async t => {
  const { c, read } = await tree(t);
  const world = await startWorld(c, WALLET, 0, () => {}, new AbortController().signal);
  t.after(() => world.stop());
  assert.equal(world.natural, true); assert.equal(world.herald, 'http://localhost:41982');
  assert.deepEqual(await read('runner-args.json'), ['--artifact', c.artifact, '--artifact-sha256', c.artifactSha, '--player-wallet', WALLET, '--rpc-port', '41980', '--ws-port', '41981', '--keeper', 'public-quicknet']);
  const herald = await read('herald-args.json');
  assert.ok(!herald.includes('--local-play-metadata'), 'no synthetic seed for a natural world');
  assert.ok(herald.includes('--relay'));
  const relay = await read('relay-args.json');
  assert.ok(relay.includes('--economy') && relay[relay.indexOf('--economy') + 1] === 'page-signed-v1', 'the page-signed economy (Join and PlaceHome are the player\'s)');
  assert.ok(!relay.includes('--conquest-bin'), 'no conquest CLI');
  await assert.rejects(fsp.readFile(path.join(c.root, 'plain-args.json')), 'the plain runner never started');
  await world.stop();
  // and through the manager, the start answer carries it
  const m = new WorldManager(c, async () => ({ herald: 'http://localhost:41982', stop: async () => {}, keeper: async () => null, natural: true }));
  assert.deepEqual(await m.start(WALLET), { herald: 'http://localhost:41982', natural: true });
  const plain = new WorldManager(c, async () => ({ herald: 'http://localhost:41982', stop: async () => {} }));
  assert.deepEqual(await plain.start(WALLET), { herald: 'http://localhost:41982' }, 'a plain world\'s answer is unchanged');
});

for (const runnerMode of ['plain', 'other-preset']) {
  test(`a natural start refuses a runner that does not state the natural world (${runnerMode})`, { timeout: 60000 }, async t => {
    const { c } = await tree(t, { runnerMode });
    await assert.rejects(startWorld(c, WALLET, 0, () => {}, new AbortController().signal), e => e.code === 'RunnerNotReady');
  });
}

test('startWorld refuses an inconsistent natural configuration before any process', { timeout: 30000 }, async t => {
  const { c } = await tree(t);
  for (const bad of [{ naturalRunner: undefined }, { economy: undefined }, { prepareScale: 20 }, { conquest: c.runner }]) {
    await assert.rejects(startWorld({ ...c, ...bad }, WALLET, 0, () => {}, new AbortController().signal), e => e.code === 'InvalidWorldPreset', JSON.stringify(Object.keys(bad)));
  }
});

// ---------------------------------------------------------------- the gate's herald check
const ADDRS = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '11');
function herald(me) {
  return { season: async () => ({ ok: true, record: { programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', season: '11', seasonAddress: ADDRS.season }, season: { programVersion: 0x4804, seasonId: 11n } }),
    me: async () => me, pin() {} };
}
const citizenOf = w => ({ wallet: fromB58(w) });

test('the gate: an unjoined wallet is accepted ONLY on a natural world; a Citizen there must be this wallet\'s', async () => {
  const unjoined = { ok: true, citizen: null, holdings: [] };
  assert.deepEqual(await LP.verifyLocalPlayHerald(herald(unjoined), WALLET), { ok: false, code: 'WalletNotBound' }, 'not natural: as before');
  const n = await LP.verifyLocalPlayHerald(herald(unjoined), WALLET, { natural: true });
  assert.equal(n.ok, true); assert.equal(n.identity.natural, true); assert.equal(n.identity.address, WALLET); assert.ok(Object.isFrozen(n.identity));
  // joined, home not placed yet: natural only
  const joined = { ok: true, citizen: citizenOf(WALLET), holdings: [] };
  assert.equal((await LP.verifyLocalPlayHerald(herald(joined), WALLET)).code, 'WalletNotBound');
  assert.equal((await LP.verifyLocalPlayHerald(herald(joined), WALLET, { natural: true })).ok, true);
  // placed: both, and the plain identity has no natural mark
  const placed = { ok: true, citizen: citizenOf(WALLET), holdings: [{}] };
  const plainOk = await LP.verifyLocalPlayHerald(herald(placed), WALLET);
  assert.equal(plainOk.ok, true); assert.equal('natural' in plainOk.identity, false);
  assert.equal((await LP.verifyLocalPlayHerald(herald(placed), WALLET, { natural: true })).identity.natural, true);
  // another wallet's Citizen, or villages without a Citizen: refused even on a natural world
  assert.equal((await LP.verifyLocalPlayHerald(herald({ ok: true, citizen: citizenOf(OTHER), holdings: [] }), WALLET, { natural: true })).code, 'WalletBindingMismatch');
  assert.equal((await LP.verifyLocalPlayHerald(herald({ ok: true, citizen: null, holdings: [{}] }), WALLET, { natural: true })).code, 'WalletBindingMismatch');
  // only the boolean true counts
  for (const v of ['true', 1, {}, null]) assert.equal((await LP.verifyLocalPlayHerald(herald(unjoined), WALLET, { natural: v })).code, 'WalletNotBound', String(v));
  // a herald record error is not an unjoined wallet
  assert.equal((await LP.verifyLocalPlayHerald(herald({ ok: false, code: 'WrongKey' }), WALLET, { natural: true })).code, 'WalletBindingMismatch');
});

test('the gate source: the natural word comes only from the launcher\'s start answer', async () => {
  const src = await fsp.readFile(new URL('../../permutation-server/web/frontier/flocalplay.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(code.split('{ natural }').length - 1, 1, 'passed once, in the launcher branch');
  assert.match(code, /if \(\(body\?\.natural === true\) !== natural\) return \{ ok: false, code: 'LauncherWorldMismatch' \};/, 'the page\'s mode and the launcher\'s answer must agree');
  assert.match(code, /natural = localNaturalWorld\(cfg, loc\), longest = natural \? NATURAL_START_MS : accelerated \? 150000 : 70000;/, 'only the natural mode waits longer');
  assert.equal(code.split('verifyLocalPlayHerald(makeHerald(base), handle.address)').length - 1, 1, 'the operator\'s own herald path is checked as before');
});

// ---------------------------------------------------------------- the mode contract, known before a start
import http from 'node:http';
import { once } from 'node:events';
import { createLauncherServer, NATURAL_START_BOUND_MS } from '../src/frontier/local-play-launcher.mjs';

function get(port, route) {
  return new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: route, headers: { host: 'localhost:41920' } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location })); }); req.on('error', reject); req.end(); });
}

test('the launcher marks its pages world=natural only for the natural preset, and sends other addresses to it', async t => {
  const page = '/frontier/frontier/index.html';
  const serve = async c => { const { server } = createLauncherServer({ port: 41920, web: '/nonexistent', ...c }, { close() {} }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r))); return server.address().port; };
  const nat = await serve({ worldPreset: NATURAL_WORLD_PRESET });
  assert.equal((await get(nat, '/')).location, `${page}?localPlay=1&launcher=1&devWallet=off&world=natural`);
  const r = await get(nat, `${page}?localPlay=1&launcher=1&devWallet=off`);
  assert.equal(r.status, 302); assert.match(r.location, /[?&]world=natural(&|$)/);
  const plain = await serve({});
  assert.equal((await get(plain, '/')).location, `${page}?localPlay=1&launcher=1&devWallet=off`, 'a plain launcher\'s page is as before');
  const wrong = await get(plain, `${page}?localPlay=1&launcher=1&devWallet=off&world=natural`);
  assert.equal(wrong.status, 302); assert.doesNotMatch(wrong.location, /world=/, 'a plain launcher never keeps the natural word');
  const acc = await serve({ prepareScale: 20 });
  assert.equal((await get(acc, '/')).location, `${page}?localPlay=1&launcher=1&devWallet=off&prepare=accelerated`, 'accelerated as before');
  assert.ok(LP.NATURAL_START_MS > NATURAL_START_BOUND_MS, 'the page waits past the launcher\'s own natural bound');
});

function stubDocument() {
  const all = [], doc = { focused: null };
  const make = tag => {
    const listeners = {};
    const el = { tag, className: '', textContent: '', id: '', hidden: false, disabled: false, value: '', type: '', dataset: {}, attrs: {}, children: [], parent: null, listeners, ownerDocument: doc,
      setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { for (const x of xs) { x.parent = el; el.children.push(x); } }, prepend(x) { x.parent = el; el.children.unshift(x); }, addEventListener(k, f) { (listeners[k] ??= []).push(f); },
      focus() { doc.focused = el; }, click() { for (const f of listeners.click ?? []) f(); return true; } };
    all.push(el); return el;
  };
  const body = make('body'), head = make('head');
  return Object.assign(doc, { body, head, createElement: make, byId: id => all.find(e => e.id === id), all });
}
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const CFG = { origin: 'http://127.0.0.1:41920', herald: 'http://127.0.0.1:41920', relay: 'http://127.0.0.1:41920/gw', dev: true, mode: 'play' };
const pageLoc = world => { const href = `http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off${world ? '&world=natural' : ''}`; return { href, hostname: '127.0.0.1', origin: 'http://127.0.0.1:41920' }; };
function gateWith({ world, answer, me }) {
  const doc = stubDocument(), win = new EventTarget();
  const makeWallet = async () => ({ address: WALLET, destroyed: false, destroy() { this.destroyed = true; }, announce() {} });
  const makeHerald = () => herald(me);
  const request = async url => (url.endsWith('/local-play/start') ? reply(200, answer) : reply(404, {}));
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: pageLoc(world), doc, win, makeHerald, request, makeWallet, retryDelayMs: 1, launcherTimeoutMs: 5000, now: () => 1_800_000_000_000 });
  return { gate, doc };
}
async function pressed(o) { for (let i = 0; i < 500 && o.gate.state().phase === 'creating'; i++) await settle(1); await o.gate.connect(); await settle(); return o.gate.state(); }

test('the gate: the natural page boots an unjoined wallet on a natural answer; any disagreement is refused', async () => {
  assert.equal(LP.localNaturalWorld(CFG, pageLoc(true)), true); assert.equal(LP.localNaturalWorld(CFG, pageLoc(false)), false);
  const unjoined = { ok: true, citizen: null, holdings: [] };
  const ok = gateWith({ world: true, answer: { herald: 'http://localhost:41926', natural: true }, me: unjoined });
  assert.equal((await pressed(ok)).phase, 'connected');
  const boot = await ok.gate.ready; assert.equal(boot.cfg.localPlay.natural, true, 'the boot knows the player has a home to choose');
  // the page is natural, the answer is not (or the reverse): refused before any herald check counts
  const a = gateWith({ world: true, answer: { herald: 'http://localhost:41926' }, me: unjoined });
  const sa = await pressed(a); assert.equal(sa.phase, 'refused'); assert.equal(sa.code, 'LauncherWorldMismatch');
  const b = gateWith({ world: false, answer: { herald: 'http://localhost:41926', natural: true }, me: { ok: true, citizen: citizenOf(WALLET), holdings: [{}] } });
  const sb = await pressed(b); assert.equal(sb.phase, 'refused'); assert.equal(sb.code, 'LauncherWorldMismatch');
});

test('the gate: the natural page says what a natural start does, in either language', async () => {
  const { setLang, lang } = await import('../../permutation-server/web/lang.mjs');
  const was = lang();
  try {
    setLang('ja');
    let release; const slow = new Promise(r => { release = r; });
    const doc = stubDocument(), win = new EventTarget();
    const gate = LP.openLocalPlayGate({ cfg: CFG, loc: pageLoc(true), doc, win, makeHerald: () => herald({ ok: true, citizen: null, holdings: [] }), request: async () => { await slow; return reply(200, { herald: 'http://localhost:41926', natural: true }); },
      makeWallet: async () => ({ address: WALLET, destroyed: false, destroy() {}, announce() {} }), retryDelayMs: 1, launcherTimeoutMs: 5000, now: () => 0 });
    for (let i = 0; i < 500 && gate.state().phase === 'creating'; i++) await settle(1);
    const p = gate.connect(); await settle();
    assert.ok(doc.all.some(e => /新しいシーズンを最初から作っています…（最大4分/.test(e.textContent)), 'the natural starting text');
    assert.ok(!doc.all.some(e => /最大70秒/.test(e.textContent)));
    release(); await p;
  } finally { setLang(was); }
});
