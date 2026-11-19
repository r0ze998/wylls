// TEST-ONLY contest pair in the launcher: ONE memory-only world for TWO players (two people; no automatic opponent).
// The first press waits; the second distinct wallet starts one runner with both; the second player's page is looked up
// (never a world of its own) and reaches ITS relay through its own proxy; one stop ends it for both. No world is started
// here: the manager's launch is a fake, and the proxy is checked against loopback stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WorldManager, createWorldProxy, runnerPairAgrees, CONTEST_PAIR_MODE, parseConfig } from '../src/frontier/local-play-launcher.mjs';

const A = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', B = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', C = 'Avexj6jFeyqKwd6V9Y8M7PVSqQEWmFJXAnAroC1wv3FJ';
const fakeLaunch = (calls, { pairOk = true, gate = null } = {}) => async (c, wallet, slot, forget, signal, opts) => {
  calls.push({ wallet, slot, second: opts?.second ?? null });
  if (gate) await gate;
  let stopped = false;
  return { herald: 'http://localhost:41924', expiry: { at: 1 }, natural: true, marchTrial: true, captureDemo: { scale: 30 },
    ...(opts?.second && pairOk ? { pair: { second: opts.second, herald: 'http://localhost:41929' } } : {}),
    stop: async () => { if (!stopped) { stopped = true; forget(); } } };
};

test('the first press waits, the second distinct wallet starts ONE world for both, and each side sees its own address', async () => {
  const calls = [];
  const m = new WorldManager({ contestPair: true }, fakeLaunch(calls));
  assert.deepEqual(await m.start(A), { pairWaiting: true, pair: { mode: CONTEST_PAIR_MODE } });
  assert.deepEqual(await m.start(A), { pairWaiting: true, pair: { mode: CONTEST_PAIR_MODE } }, 'asking again: still waiting, nothing started');
  assert.equal(calls.length, 0);
  const b = await m.start(B);
  assert.deepEqual(calls, [{ wallet: A, slot: 0, second: B }], 'one runner, started for A with B as the second');
  assert.equal(b.herald, 'http://localhost:41929'); assert.deepEqual(b.pair, { role: 'second', mode: CONTEST_PAIR_MODE });
  const a = await m.start(A);
  assert.equal(a.herald, 'http://localhost:41924'); assert.deepEqual(a.pair, { role: 'first', mode: CONTEST_PAIR_MODE });
  assert.deepEqual(a.expiry, b.expiry, 'one expiry for both');
  // B again (a reconnect): looked up, never a new world
  assert.equal((await m.start(B)).herald, 'http://localhost:41929'); assert.equal(calls.length, 1);
  // a third wallet while the pair world runs: refused
  await assert.rejects(m.start(C), e => e.code === 'WorldLimit');
});

test('simultaneous second presses start one runner only; the other is refused', async () => {
  const calls = [];
  let release; const gate = new Promise(r => { release = r; });
  const m = new WorldManager({ contestPair: true }, fakeLaunch(calls, { gate }));
  await m.start(A);
  const pb = m.start(B), pc = m.start(C);
  await assert.rejects(pc, e => e.code === 'WorldLimit', 'C finds the pair world being started');
  release();
  assert.equal((await pb).pair.role, 'second');
  assert.equal(calls.length, 1);
});

test('one stop ends the world for both; a waiting player can cancel; after the end each must pair again', async () => {
  const calls = [];
  const m = new WorldManager({ contestPair: true }, fakeLaunch(calls));
  await m.start(A); await m.start(B);
  assert.deepEqual(await m.stop(B), { stopped: true }, 'the second player\'s stop ends the shared world');
  assert.equal(m.worlds.size, 0); assert.equal(m.pairOf.size, 0, 'the pair is forgotten with its world');
  assert.deepEqual(await m.start(B), { pairWaiting: true, pair: { mode: CONTEST_PAIR_MODE } }, 'B now waits as a new first player');
  assert.deepEqual(await m.stop(B), { stopped: true }, 'a waiting player cancels');
  assert.equal(m.pairWaiting, null);
  assert.equal(calls.length, 1);
});

test('a runner that does not state THIS second wallet is not handed out: the world is stopped', async () => {
  const calls = [];
  const m = new WorldManager({ contestPair: true }, fakeLaunch(calls, { pairOk: false }));
  await m.start(A);
  await assert.rejects(m.start(B), e => e.code === 'PairNotReady');
  assert.equal(m.worlds.size, 0); assert.equal(m.pairOf.size, 0);
});

test('without the pair option nothing changes: every wallet starts its own world', async () => {
  const calls = [];
  const m = new WorldManager({}, fakeLaunch(calls));
  const a = await m.start(A);
  assert.equal(a.pairWaiting, undefined); assert.equal(a.pair, undefined);
  await m.start(B);
  assert.deepEqual(calls.map(c => [c.wallet, c.second]), [[A, null], [B, null]]);
});

test('the runner\'s first line must state exactly this pair, and a one-player runner never mentions it', () => {
  const ok = { contest_pair: { mode: CONTEST_PAIR_MODE, second_wallet: B, test_only: true, automatic_opponent: false } };
  assert.equal(runnerPairAgrees(ok, B), true);
  assert.equal(runnerPairAgrees(ok, C), false, 'another second wallet');
  assert.equal(runnerPairAgrees(ok, null), false, 'a pair runner where one player was asked');
  assert.equal(runnerPairAgrees({}, null), true); assert.equal(runnerPairAgrees({}, B), false);
  assert.equal(runnerPairAgrees({ contest_pair: { ...ok.contest_pair, automatic_opponent: true } }, B), false);
  assert.equal(runnerPairAgrees({ contest_pair: { ...ok.contest_pair, extra: 1 } }, B), false);
});

const stub = name => new Promise(resolve => {
  const seen = [];
  const s = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ from: name, path: req.url })); });
  s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port, seen }));
});
const listen = proxy => new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));

test('the second player\'s proxy sends /gw to ITS relay (prefix removed) and everything else to the shared herald', async () => {
  const herald = await stub('herald'), relayB = await stub('relay-b');
  const launcherPort = 41999;
  const proxyB = createWorldProxy({ port: 0, targetPort: herald.port, launcherPort, relayPort: relayB.port });
  const portB = await listen(proxyB);
  // (the proxy checks its own host name: re-created on the port it got)
  await proxyB.closeNow?.() ?? proxyB.close();
  const pb = createWorldProxy({ port: portB, targetPort: herald.port, launcherPort, relayPort: relayB.port });
  await new Promise(r => pb.listen(portB, '127.0.0.1', r));
  const get = async (port, p) => (await fetch(`http://localhost:${port}${p}`)).json();
  assert.deepEqual(await get(portB, '/gw/f/local-play/info'), { from: 'relay-b', path: '/f/local-play/info' });
  assert.deepEqual(await get(portB, '/h/status'), { from: 'herald', path: '/h/status' });
  // the first player's proxy (no relay port) keeps sending /gw to the herald, which forwards to the first relay
  const pa0 = createWorldProxy({ port: 0, targetPort: herald.port, launcherPort });
  const portA = await listen(pa0); await pa0.closeNow?.() ?? pa0.close();
  const pa = createWorldProxy({ port: portA, targetPort: herald.port, launcherPort });
  await new Promise(r => pa.listen(portA, '127.0.0.1', r));
  assert.deepEqual(await get(portA, '/gw/f/local-play/info'), { from: 'herald', path: '/gw/f/local-play/info' });
  assert.deepEqual(relayB.seen, ['/f/local-play/info'], 'the first player\'s page never reaches the second relay');
  await (pb.closeNow?.() ?? pb.close()); await (pa.closeNow?.() ?? pa.close()); herald.s.close(); relayB.s.close();
});

test('the pair option is accepted with the capture demo or on any natural world (B16), and the second slot is reserved for it', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(out\['contest-pair'\] !== undefined && \(out\['contest-pair'\] !== CONTEST_PAIR_MODE \|\| \(out\['capture-demo'\] === undefined && !natural\)\)\) throw fault\('InvalidContestPair'\);/);
  // (startWorld refuses a second wallet without the option, off both the demo and a natural world, the same wallet twice, or no next slot)
  assert.match(src, /if \(second !== null && \(!c\.contestPair \|\| \(demo === null && !natural\) \|\| !validWallet\(second\) \|\| second === wallet \|\| slot \+ 1 >= WORLD_LIMIT\)\) throw fault\('InvalidContestPair', 503\);/);
  // (the second relay is pinned to the second wallet; the first relay keeps the first)
  assert.match(src, /launch\('relay-b', process\.execPath, \[path\.join\(c\.root, 'permutation-gateway\/src\/frontier\/local-play-relay-server\.mjs'\), \.\.\.relayArgsFor\(second, pairPorts\.relay\)\]\);/);
  assert.match(src, /const relayArgs = \(conquest = \[\]\) => relayArgsFor\(wallet, relay, conquest\);/);
});

// ---------------------------------------------------------------- B16 (loop-play3, fix-b14-b16): two people in a KEPT world
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as L from '../src/frontier/local-play-launcher.mjs';

const absArgs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
const naturalArgs = [...absArgs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1', '--march-trial', L.MARCH_TRIAL_MODE];

test('parseConfig: the pair on a natural world (kept or not) passes the words; off a natural world it is refused', async () => {
  await assert.rejects(parseConfig([...absArgs, '--contest-pair', CONTEST_PAIR_MODE]), e => e.code === 'InvalidContestPair');
  await assert.rejects(parseConfig([...naturalArgs, '--contest-pair', 'contest-pair-v2']), e => e.code === 'InvalidContestPair');
  // (well-formed: it fails only later, at the paths, which do not exist here)
  for (const extra of [[], ['--continuous', L.CONTINUOUS_MODE, '--persist', L.PERSIST_MODE]]) {
    await assert.rejects(parseConfig([...naturalArgs, ...extra, '--contest-pair', CONTEST_PAIR_MODE]), e => !['InvalidContestPair', 'InvalidArguments', 'PersistNeedsNaturalWorld'].includes(e.code), String(extra));
  }
});

const pairRecord = (first, second) => JSON.stringify({ schema: L.PAIR_FILE_SCHEMA, mode: CONTEST_PAIR_MODE, first, second, test_only: true });
const keptHome = (data, first, text) => {
  const home = path.join(data, 'persist', first);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (text !== undefined) { writeFileSync(path.join(home, L.PAIR_FILE), text, { mode: 0o600 }); chmodSync(path.join(home, L.PAIR_FILE), 0o600); }
  return home;
};

test('a kept pair record: exactly its shape, private, of its own folder; anything else is not a pair', async () => {
  const data = mkdtempSync(path.join(tmpdir(), 'kept-pair-'));
  assert.equal(await L.readPersistedPair(keptHome(data, A, pairRecord(A, B))), B);
  assert.equal(await L.readPersistedPair(keptHome(data, C)), null, 'no record: a world of one');
  const other = mkdtempSync(path.join(tmpdir(), 'kept-pair-'));
  assert.equal(await L.readPersistedPair(keptHome(other, B, pairRecord(A, C))), false, 'a record of another folder');
  const bad = mkdtempSync(path.join(tmpdir(), 'kept-pair-'));
  assert.equal(await L.readPersistedPair(keptHome(bad, A, pairRecord(A, A))), false, 'the same wallet twice');
  const loose = mkdtempSync(path.join(tmpdir(), 'kept-pair-'));
  const h = keptHome(loose, A, pairRecord(A, B)); chmodSync(path.join(h, L.PAIR_FILE), 0o644);
  assert.equal(await L.readPersistedPair(h), false, 'a record others can read is refused');
  const extra = mkdtempSync(path.join(tmpdir(), 'kept-pair-'));
  assert.equal(await L.readPersistedPair(keptHome(extra, A, JSON.stringify({ ...JSON.parse(pairRecord(A, B)), key: 'x' }))), false, 'never more than the addresses');
  assert.deepEqual([...(await L.persistedPairs(data))], [[A, B]]);
  assert.deepEqual([...(await L.persistedPairs(path.join(data, 'none')))], []);
});

test('a kept pair resumes at EITHER player\'s press, for both, without waiting; a stranger still waits', async () => {
  for (const presser of [A, B]) {
    const calls = [];
    const m = new WorldManager({ contestPair: true, persist: true, data: '/d', guard: { persistedPairs: async () => new Map([[A, B]]) } }, fakeLaunch(calls));
    const first = await m.start(presser);
    assert.deepEqual(calls, [{ wallet: A, slot: 0, second: B }], `one runner for the recorded pair (pressed by ${presser === A ? 'A' : 'B'})`);
    assert.equal(first.pairWaiting, undefined, 'no waiting for a kept pair');
    assert.equal(first.pair.role, presser === A ? 'first' : 'second');
    const other = await m.start(presser === A ? B : A);
    assert.equal(other.pair.role, presser === A ? 'second' : 'first');
    assert.equal(calls.length, 1, 'the other player finds the same world');
    await assert.rejects(m.start(C), e => e.code === 'WorldLimit', 'a third wallet while the pair world runs');
    assert.deepEqual(await m.stop(B), { stopped: true });
    assert.equal(m.worlds.size, 0);
  }
  // a wallet in no kept pair pairs as before
  const calls = [];
  const m = new WorldManager({ contestPair: true, persist: true, data: '/d', guard: { persistedPairs: async () => new Map([[A, B]]) } }, fakeLaunch(calls));
  assert.deepEqual(await m.start(C), { pairWaiting: true, pair: { mode: CONTEST_PAIR_MODE } });
  assert.equal(calls.length, 0);
});

test('startWorld: a kept world records its pair once and resumes only as the same pair (sources)', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(second !== null && pair !== null && pair !== second\) throw fault\('PersistPairMismatch', 503\);/);
  assert.match(src, /if \(second === null && pair !== null\) throw fault\('PersistPairMismatch', 503\);/);
  assert.match(src, /if \(await has\('run\/world\.json'\)\) throw fault\('PersistNotAPair', 503\);/);
  assert.match(src, /await fs\.writeFile\(path\.join\(home, PAIR_FILE\), JSON\.stringify\(\{ schema: PAIR_FILE_SCHEMA, mode: CONTEST_PAIR_MODE, first: wallet, second, test_only: true \}\), \{ flag: 'wx', mode: 0o600 \}\);/);
});
