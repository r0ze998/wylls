// integ-B, "season-end race fix" (frontier/ai-eosfix). smoke-r2 (14 game hours) ended with verify-minds M3 FAIL: an `anchor_gap` at bell 109,
// "the chain was paused". The closer wrote talk/109.json and minds/109.json in the same second the registrar's `publish` wrote the signed
// index (last_bell 108) and STATE/season-end.json: a bell closed after the index, on the chain the stack had already paused.
//
// Two causes, two rules (docs/frontier/ai-citizens/integ-B-NOTES.md, section 11):
//   (1) the closer's clock ran on real time between two herald polls, so once the brain was silent it crossed the close instant of a bell the
//       paused chain never reached (here: bell 109 closes at F + 17 game-s when the chain ended at F = start(110) + 3). `closeNow` is capped at
//       the newest chain time a poll returned, once the brain is silent.
//   (2) THE SEAL ENDS THE CLOSER (mind/seal.mjs): `publish` waits for the bells the chain closed, writes STATE/season-sealing.json, waits for a
//       close that is already in flight, and only then counts the closed bells; a sealed closer closes nothing.
// Every test below that names "old code" fails on frontier/ai-integ d6f2bc3 (checked: the recorded failing run is in integ-B-NOTES.md section 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
import * as R from '../citizens/registrar.mjs';
import * as CLOSER from '../citizens/mind/closer.mjs'; // (a namespace import: on the old code a missing export fails one test, not the whole file)
const { createClock, createCloser } = CLOSER;
import { catchUpClockFromHerald, createCitizensService } from '../citizens/server.mjs';
import { permissionFlags } from '../citizens/mind/permissions.mjs';
import { makeStores, makeEpisode, makeRosterJson, renderMemoryDouble, renderPersonaDouble, personaOfDouble, nameOfDouble, makeSpeech, makeSocial, CONFIG } from './fixtures/ai-mind-doubles.mjs';

// the smoke-r2 geometry: genesis G, the chain's last game second F = start(110) + 3, so the close instant of bell 109 is F + 17
const G = 1_785_542_400;
const F = G + 110 * 600 + 3;
const E = (b) => G + (b + 1) * 600 + 20; // close instant of bell b (contract 6.3)
const season = (latestUnix) => ({ ok: true, status: 200, json: async () => ({ latestUnix, genesisTs: G }) });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-eosfix-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const newDir = (tag) => fs.mkdtempSync(path.join(tmp, `${tag}-`));
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b, k) => String((b * 2 + k) % 10).repeat(64);
const writeBell = (aiDir, b) => {
  write(path.join(aiDir, 'pub', 'talk', `${b}.json`), JSON.stringify({ bell: b, root: hex(b, 0), records: [] }));
  write(path.join(aiDir, 'pub', 'minds', `${b}.json`), JSON.stringify({ bell: b, root: hex(b, 1), records: [] }));
};
const anchorOf = (aiDir, b) => write(path.join(aiDir, 'pub', 'anchors', `${b}.json`), JSON.stringify({ bell: b, social_root: hex(b, 0), minds_root: hex(b, 1), signature: `S${b}`, slot: b }));

// ------------------------------------------------------------------ (1) the closer's clock never runs past a chain that stopped
test('clock: once the brain is silent the closer measures against the newest chain time seen, never the extrapolation (old code: bell 109 closed 17 game-s past the chain\'s end)', async () => {
  const t = { v: 0 };
  const clock = createClock({ genesisTs: G, scale: 20, nowMs: () => t.v });
  clock.observe({ now_game: F - 500, scale: 20 }, 0); // the brain's last word; the fleet exits, the drain runs at 20x
  const closed = [];
  const closer = createCloser({ clock, social: { closeBell: async () => null }, records: { closeBell: () => ({}) }, onClosed: async (b) => closed.push(b), start: 108, nowMs: () => t.v });
  t.v = 40_000; // brain silent 40 s: the clock follows the chain; the extrapolation is at F + 300
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(F)), true, 'the poll pulls the clock back to the chain\'s last game second');
  assert.equal(clock.gameNow(t.v), F);
  assert.ok(clock.brainSilentMs(t.v) > 30_000);
  // the chain is now PAUSED at F. One second of real time passes before the next 2-s poll: the extrapolation reaches F + 20 >= E(109) = F + 17
  t.v += 1000;
  assert.equal(clock.gameNow(t.v), F + 20, 'the uncapped extrapolation has crossed the close instant of bell 109');
  assert.equal(E(109), F + 17);
  assert.deepEqual(await closer.tick(t.v), [108], 'bell 108 (closed by the chain long before F) closes; bell 109 does not: the chain never reached its close instant');
  t.v += 1500; // still before the next poll
  assert.deepEqual(await closer.tick(t.v), []);
  // later polls see the same frozen latestUnix
  await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(F));
  t.v += 60_000;
  assert.deepEqual(await closer.tick(t.v), []);
  assert.deepEqual(closed, [108]);
  assert.equal(closer.next(), 109);
});

test('clock: while the brain is active nothing changes (the closer closes on the brain\'s clock, on time); the cap needs a poll and a silent brain', async () => {
  const t = { v: 0 };
  const clock = createClock({ genesisTs: G, scale: 10, nowMs: () => t.v });
  clock.observe({ now_game: G + 100, scale: 10 }, 0);
  assert.equal(clock.closeNow(5000), G + 150, 'no chain time seen yet: the plain clock');
  clock.noteChain(G + 90); // the herald lags the brain a little (the old clock has no such method: this test fails there)
  t.v = 10_000;
  clock.observe({ now_game: G + 200, scale: 10 }, t.v); // the brain speaks again
  clock.noteChain(G + 150);
  t.v = 12_000;
  assert.equal(clock.closeNow(t.v), G + 220, 'the brain is active: not capped at the (older) herald time');
  // the brain falls silent but no poll ever came: no cap is known, the plain clock (the catch-up of smoke-b4 is what moves it)
  const c2 = createClock({ genesisTs: G, scale: 10, nowMs: () => 0 });
  c2.observe({ now_game: G + 100, scale: 10 }, 0);
  assert.equal(c2.closeNow(200_000), G + 2100);
  c2.noteChain(NaN); c2.noteChain(-5);
  assert.equal(c2.closeNow(200_000), G + 2100, 'garbage is not a chain time');
});

test('catch-up notes the chain time on every successful poll, also when it does not move the clock (equal times)', async () => {
  const t = { v: 0 };
  const clock = createClock({ genesisTs: G, scale: 20, nowMs: () => t.v });
  clock.observe({ now_game: F, scale: 20 }, 0);
  t.v = 60_000;
  await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(F - 2000)); // pulls back, noted
  const g = clock.gameNow(t.v);
  assert.equal(g, F - 2000);
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(g)), false, 'equal: the clock does not move');
  t.v += 10_000; // the extrapolation runs 200 game-s on; the chain time stays what the last poll said
  assert.equal(clock.closeNow(t.v), g);
});

// ------------------------------------------------------------------ (2) the seal ends the closer
// (a tolerant import, so that on the old code, which has no such module, each test fails on its own and not the whole file)
const seal = await import('../citizens/mind/seal.mjs').catch(() => ({}));
const sealSeason = (...a) => seal.sealSeason(...a), closerGuard = (...a) => seal.closerGuard(...a), waitForCloserIdle = (...a) => seal.waitForCloserIdle(...a), isSealed = (...a) => seal.isSealed(...a);
const claimPath = (state) => path.join(state, 'closer-claim.json'), sealPath = (state) => path.join(state, 'season-sealing.json');

const dueClock = (b) => { const clock = createClock({ genesisTs: G, scale: 10, nowMs: () => 0 }); clock.observe({ now_game: E(b) + 5, scale: 10 }, 0); return clock; };

test('a sealed season: the closer closes nothing, writes no file, removes its claim, and stays sealed (old code: no guard, the bell was closed)', async () => {
  const state = newDir('seal-a');
  sealSeason(state);
  assert.equal(isSealed(state), true);
  const closed = [];
  const closer = createCloser({ clock: dueClock(109), social: { closeBell: async (b) => closed.push(['social', b]) }, records: { closeBell: (b) => closed.push(['records', b]) }, guard: closerGuard(state), start: 109, nowMs: () => 0 });
  assert.deepEqual(await closer.tick(0), []);
  assert.deepEqual(closed, []);
  assert.equal(closer.sealed(), true);
  assert.equal(fs.existsSync(claimPath(state)), false, 'the claim of the refused close is removed');
  assert.equal(closer.next(), 109);
  assert.deepEqual(await closer.tick(1e9), [], 'sealed for good');
});

test('the order inside one tick: a close that is IN FLIGHT when the season is sealed finishes, and the registrar side waits for it; the next tick closes nothing', async () => {
  const state = newDir('seal-b');
  let release; const gate = new Promise((r) => { release = r; });
  const wrote = [];
  const closer = createCloser({
    clock: dueClock(109),
    social: { closeBell: async (b) => { await gate; wrote.push(`talk/${b}`); return null; } },
    records: { closeBell: (b) => { wrote.push(`minds/${b}`); return {}; } },
    guard: closerGuard(state), start: 109, nowMs: () => 0,
  });
  const tick = closer.tick(0); // the closer has claimed bell 109 and is inside social.closeBell
  await sleep(20);
  assert.equal(fs.existsSync(claimPath(state)), true);
  sealSeason(state); // the registrar: step 1
  let idle = false;
  const waiting = waitForCloserIdle(state, { timeoutMs: 5000, intervalMs: 10 }).then((r) => { idle = true; return r; });
  await sleep(80);
  assert.equal(idle, false, 'the registrar side does not go on while the closer is inside a close');
  assert.deepEqual(wrote, []);
  release();
  assert.deepEqual(await tick, [109]);
  const r = await waiting;
  assert.equal(r.held, false);
  assert.deepEqual(wrote, ['talk/109', 'minds/109'], 'both files were written before the registrar went on to count the closed bells');
  assert.equal(fs.existsSync(claimPath(state)), false);
  assert.deepEqual(await closer.tick(1e9), [], 'the next bell is refused');
  assert.equal(closer.sealed(), true);
});

test('the claim of a dead closer, a stale claim and the wait bound do not hang the registrar', async () => {
  const state = newDir('seal-c');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  write(claimPath(state), JSON.stringify({ v: 1, pid: dead, bell: 5, since_ms: Date.now() }));
  assert.deepEqual(await waitForCloserIdle(state, { timeoutMs: 1000 }).then((r) => r.held), false, 'a dead holder is not waited for');
  write(claimPath(state), JSON.stringify({ v: 1, pid: process.pid, bell: 5, since_ms: Date.now() - 120_000 }));
  assert.equal((await waitForCloserIdle(state, { timeoutMs: 1000 })).held, false, 'a claim older than staleMs is not waited for');
  write(claimPath(state), JSON.stringify({ v: 1, pid: process.pid, bell: 5, since_ms: Date.now() }));
  const r = await waitForCloserIdle(state, { timeoutMs: 120, intervalMs: 10 });
  assert.equal(r.held, true, 'a live fresh claim that outlasts the bound is reported, not waited for for ever');
  assert.ok(r.waited_ms >= 100);
  assert.equal(sealSeason(state).v, 1);
  const first = readJ(sealPath(state));
  assert.deepEqual(sealSeason(state), first, 'sealing twice keeps the first seal');
});

test('the seal module loads and works under the service\'s permission flags (the claim is written under STATE; old code: no such module)', () => {
  const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  const aiDir = fs.realpathSync(newDir('seal-perm'));
  const state = path.join(aiDir, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(aiDir, 'pub'), { recursive: true });
  const sealFile = path.join(repoRoot, 'permutation-gateway/citizens/mind/seal.mjs');
  const code = `const m = await import(${JSON.stringify(sealFile)}); const g = m.closerGuard(${JSON.stringify(state)}); const leave = g.enter(7); const during = null; leave(); m.sealSeason(${JSON.stringify(state)}); console.log(JSON.stringify({ entered: typeof leave, sealed: g.sealed(), refused: g.enter(8) === null, during }));`;
  const r = spawnSync(process.execPath, [...permissionFlags({ repoRoot, aiDir }), '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual([out.entered, out.sealed, out.refused], ['function', true, true]);
  assert.equal(fs.existsSync(path.join(state, 'closer-claim.json')), false);
  assert.equal(fs.existsSync(path.join(state, 'season-sealing.json')), true);
});

// ------------------------------------------------------------------ the registrar: expected last bell, the seal, the index
test('lastChainClosedBell: the last bell whose close instant the chain reached (the smoke-r2 end is bell 108, a chain 17 game-s further would close 109)', () => {
  const s = (latestUnix) => R.lastChainClosedBell({ genesisTs: G, bellSecs: 600, latestUnix });
  assert.equal(s(F), 108);
  assert.equal(s(E(109) - 1), 108);
  assert.equal(s(E(109)), 109);
  assert.equal(s(G + 10), -1);
});

/** A loopback herald (/h/season with the chain's last game second) and a JSON-RPC server (paused chain). */
function servers({ latestUnix = F, paused = true } = {}) {
  const heard = [];
  const rpc = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const { id, method } = JSON.parse(Buffer.concat(chunks));
      heard.push(method);
      const out = method === 'frontier_status' ? { jsonrpc: '2.0', id, result: { paused } } : { jsonrpc: '2.0', id, error: { code: -32000, message: `unexpected ${method}` } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  const herald = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ cluster: 'localnet', genesisTs: G, bellSecs: 600, latestUnix, season: '31' })); });
  const up = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
  return Promise.all([up(rpc), up(herald)]).then(([rpcUrl, heraldUrl]) => ({ rpcUrl, heraldUrl, heard, close: () => Promise.all([rpc, herald].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))) }));
}
async function publishCli(aiDir, s, extra = []) {
  write(path.join(aiDir, 'pub', 'commitments.json'), JSON.stringify({ season_id: 31 }));
  R.loadOrCreateKey(path.join(aiDir, 'keys', 'registrar.json'), aiDir);
  const lines = [];
  const code = await R.main(['publish', '--ai-dir', aiDir, '--key', path.join(aiDir, 'keys', 'registrar.json'), '--herald', s.heraldUrl, '--rpc', s.rpcUrl, '--memo-tries', '2', '--memo-interval-ms', '1', ...extra], { log: (m) => lines.push(m), out: (m) => lines.push(m) });
  return { code, lines };
}
/** a run directory at the end of smoke-r2: bells 106..108 closed and anchored on the chain */
function endOfRun(tag) {
  const aiDir = newDir(tag);
  for (const b of [106, 107, 108]) { writeBell(aiDir, b); anchorOf(aiDir, b); }
  return aiDir;
}

test('publish seals the season BEFORE it counts the closed bells: a closer that wakes up after the index closes nothing (the smoke-r2 race; old code: bell 109 was written after the index)', async () => {
  const aiDir = endOfRun('pub-a');
  fs.mkdirSync(path.join(aiDir, 'pub', 'minds'), { recursive: true });
  const s = await servers();
  const svc = await createCitizensService(
    { aiDir, herald: s.heraldUrl, llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: 31, genesisTs: G },
    { test: true, noCloserTimer: true, clockPollMs: 1e9, config: CONFIG, speech: makeSpeech(), stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble, personaOf: personaOfDouble, nameOf: nameOfDouble, social: makeSocial(), feed: { cursorBell: () => null, wakeEvents: () => [] }, audit: false },
  );
  try {
    assert.equal(svc.closer.next(), 109, 'the service resumes after the last minds file (108)');
    const { code, lines } = await publishCli(aiDir, s, ['--wait-last-secs', '2']);
    assert.equal(code, 0, lines.join('\n'));
    const idx = readJ(path.join(aiDir, 'pub', 'anchors', 'index.json'));
    assert.deepEqual([idx.first_bell, idx.last_bell, idx.gaps], [106, 108, []]);
    assert.equal(fs.existsSync(path.join(aiDir, 'state', 'season-end.json')), true);
    // the same second: the closer's clock says bell 109 is due (it ran on past the chain's end), the tick comes after the index
    svc.clock.observe({ now_game: E(109) + 5, scale: 20 });
    const done = await svc.closer.tick();
    assert.deepEqual(done, [], 'a closer that wakes up after the season-end writes closes nothing');
    assert.equal(fs.existsSync(path.join(aiDir, 'pub', 'minds', '109.json')), false, 'no minds file of bell 109');
    assert.equal(fs.existsSync(path.join(aiDir, 'pub', 'talk', '109.json')), false, 'no talk file of bell 109');
    assert.equal(svc.closer.sealed(), true);
    assert.deepEqual(R.closedBells(path.join(aiDir, 'pub')), [106, 107, 108], 'the index covers every closed bell');
  } finally { await svc.close(); await s.close(); }
});

test('the seal leaves a trace: onSealed fires once at the first refused close (review: a live run could not tell whether the seal fired; old code: no hook)', async () => {
  const state = newDir('seal-trace');
  sealSeason(state);
  const heard = [];
  const closer = createCloser({ clock: dueClock(109), social: { closeBell: async () => null }, records: { closeBell: () => ({}) }, guard: closerGuard(state), onSealed: (b) => heard.push(b), start: 109, nowMs: () => 0 });
  await closer.tick(0);
  await closer.tick(1e9);
  assert.deepEqual(heard, [109], 'once, with the bell that was due');
});

test('the service writes the metrics (close_refused_sealed) and a log line when the seal stops its closer, so the run\'s files show that the seal fired (old code: the counter stayed in memory)', async () => {
  const aiDir = endOfRun('pub-trace');
  fs.mkdirSync(path.join(aiDir, 'pub', 'minds'), { recursive: true });
  const s = await servers();
  const svc = await createCitizensService(
    { aiDir, herald: s.heraldUrl, llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: 31, genesisTs: G },
    { test: true, noCloserTimer: true, clockPollMs: 1e9, config: CONFIG, speech: makeSpeech(), stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble, personaOf: personaOfDouble, nameOf: nameOfDouble, social: makeSocial(), feed: { cursorBell: () => null, wakeEvents: () => [] }, audit: false },
  );
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  try {
    const { code, lines } = await publishCli(aiDir, s, ['--wait-last-secs', '2']);
    assert.equal(code, 0, lines.join('\n'));
    assert.equal(fs.existsSync(path.join(aiDir, 'pub', 'metrics', 'latest.json')), false, 'no bell was closed by the service: no metrics file yet');
    svc.clock.observe({ now_game: E(109) + 5, scale: 20 });
    assert.deepEqual(await svc.closer.tick(), []);
    const m = readJ(path.join(aiDir, 'pub', 'metrics', 'latest.json'));
    assert.equal(m.counters.close_refused_sealed, 1);
    assert.ok(errs.some((l) => /closer: sealed by the season-end publication; bell 109/.test(l)), errs.join('\n'));
  } finally { console.error = realErr; await svc.close(); await s.close(); }
});

test('publish waits for a close that is in flight (claim held), then includes its bell in the index: nothing is written after the index (old code: index last_bell 108, bell 109 written after)', async () => {
  const aiDir = endOfRun('pub-b');
  const state = path.join(aiDir, 'state');
  write(claimPath(state), JSON.stringify({ v: 1, pid: process.pid, bell: 109, since_ms: Date.now() })); // the closer has claimed bell 109 ...
  setTimeout(() => { writeBell(aiDir, 109); fs.rmSync(claimPath(state)); }, 400); // ... and writes it 400 ms after publish started
  const s = await servers();
  try {
    const { code, lines } = await publishCli(aiDir, s, ['--wait-last-secs', '5']);
    assert.equal(code, 0, lines.join('\n'));
    assert.equal(fs.existsSync(sealPath(state)), true, 'the seal is written');
    const idx = readJ(path.join(aiDir, 'pub', 'anchors', 'index.json'));
    assert.equal(idx.last_bell, 109, 'the bell the closer was closing is in the index (a named gap: the chain is paused), not written after it');
    assert.deepEqual(idx.gaps, [109]);
    assert.match(readJ(path.join(aiDir, 'pub', 'anchors', '109.json')).reason, /paused/);
    await sleep(500);
    assert.deepEqual(R.closedBells(path.join(aiDir, 'pub')), [106, 107, 108, 109], 'nothing appears after the index');
    assert.match(lines.at(-1), /3 anchored, 1 gap\(s\) of 4 closed bells/);
  } finally { await s.close(); }
});

test('publish waits (bounded) until the closer has closed the last bell the chain closed, then seals; a bell the closer never closes is logged, not waited for for ever', async () => {
  // the chain reached E(108): bell 108 is the last bell it closed. The closer is a little behind (one herald poll): bell 108's files appear 300 ms in.
  const aiDir = newDir('pub-c');
  for (const b of [106, 107]) { writeBell(aiDir, b); anchorOf(aiDir, b); }
  setTimeout(() => { writeBell(aiDir, 108); anchorOf(aiDir, 108); }, 300);
  const s = await servers({ latestUnix: E(108) + 1 });
  try {
    const t0 = Date.now();
    const { code, lines } = await publishCli(aiDir, s, ['--wait-last-secs', '5']);
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(Date.now() - t0 >= 250, 'publish waited for bell 108');
    const idx = readJ(path.join(aiDir, 'pub', 'anchors', 'index.json'));
    assert.deepEqual([idx.last_bell, idx.gaps], [108, []], 'without the wait the index would end at 107 and verify-minds would read tail_truncated');
  } finally { await s.close(); }
  // a closer that never closes it: the bound runs out, the season is sealed without it, and the log says so
  const aiDir2 = newDir('pub-d');
  for (const b of [106, 107]) { writeBell(aiDir2, b); anchorOf(aiDir2, b); }
  const s2 = await servers({ latestUnix: E(108) + 1 });
  try {
    const { code, lines } = await publishCli(aiDir2, s2, ['--wait-last-secs', '1']);
    assert.equal(code, 0);
    assert.ok(lines.some((l) => /the chain closed bell 108 but the closer had not closed it/.test(l)), lines.join('\n'));
    assert.equal(readJ(path.join(aiDir2, 'pub', 'anchors', 'index.json')).last_bell, 107);
    assert.equal(fs.existsSync(sealPath(path.join(aiDir2, 'state'))), true);
  } finally { await s2.close(); }
});

test('publish with a herald that has no bell fields (the older doubles) waits for nothing and still seals', async () => {
  const aiDir = endOfRun('pub-e');
  const herald = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ cluster: 'localnet', genesisTs: 1, season: '31' })); });
  await new Promise((r) => herald.listen(0, '127.0.0.1', r));
  const s = await servers();
  try {
    const t0 = Date.now();
    const { code } = await publishCli(aiDir, { ...s, heraldUrl: `http://127.0.0.1:${herald.address().port}` }, ['--wait-last-secs', '30']);
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 < 5000, 'no wait');
    assert.equal(fs.existsSync(sealPath(path.join(aiDir, 'state'))), true);
  } finally { herald.closeAllConnections?.(); await new Promise((r) => herald.close(r)); await s.close(); }
});

// ------------------------------------------------------------------ the run script
test('the run script clears a seal and a closer claim left in a reused AI_DIR (they would stop the next run\'s closer), and says what publish does', () => {
  const sh = fs.readFileSync(new URL('../citizens/bin/ai-citizens-run.sh', import.meta.url), 'utf8');
  assert.match(sh, /rm -f "\$STATE\/season-sealing\.json" "\$STATE\/closer-claim\.json"/);
  assert.ok(sh.indexOf('season-sealing.json') < sh.indexOf('bg citizens'), 'the files are removed before the service starts');
  assert.match(sh, /seals the season so the closer closes no later bell/);
  void Keypair;
});
