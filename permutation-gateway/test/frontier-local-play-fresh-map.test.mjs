// TEST-ONLY `--fresh-map local-fresh-map-v1` (owner feedback t363u: "not a random map yet"): without it every natural
// local world has the SAME map (one fixed clock origin → one genesis round → one genesis seed); with it the launcher
// picks each NEW world's clock origin and the runner's first line must state exactly that origin. The word, the
// command line, the origin's bounds, the agreement with the runner's line, and the wiring with stand-in processes (a
// temp dir, loopback 41864–41868 only; every process is stopped by its world's stop). THIS FILE MAKES NO KEY: no chain,
// no real binary, no network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as L from '../src/frontier/local-play-launcher.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const SEASON = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '11').season;
const G0 = 1_785_542_400, SPAN = 365 * 86_400;
const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
const natural = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1'];
const stated = (origin, more = {}) => ({ fresh_map: { mode: L.FRESH_MAP_MODE, origin, genesis_round: 26_173_955, test_only: true, ...more } });

test('the word and the bounds: local-fresh-map-v1; an origin is a whole second in the 365 days before the fixed one', () => {
  assert.equal(L.FRESH_MAP_MODE, 'local-fresh-map-v1');
  assert.deepEqual([L.MAP_ORIGIN_DEFAULT, L.MAP_ORIGIN_SPAN_SECS], [G0, SPAN]);
  for (const ok of [G0 - SPAN, G0 - SPAN + 1, G0 - 86_400, G0 - 1]) assert.equal(L.mapOriginOk(ok), true, String(ok));
  for (const bad of [G0, G0 + 1, G0 - SPAN - 1, 0, -1, G0 - 0.5, String(G0 - 5), null, undefined, NaN, Infinity]) assert.equal(L.mapOriginOk(bad), false, String(bad));
  // (the pick: the whole range and nothing else — the nearest and the farthest second; never the fixed origin itself)
  const asked = [];
  assert.equal(L.freshMapOrigin((lo, hi) => { asked.push([lo, hi]); return lo; }), G0 - 1);
  assert.equal(L.freshMapOrigin((lo, hi) => hi - 1), G0 - SPAN);
  assert.deepEqual(asked, [[1, SPAN + 1]]);
  const picks = new Set(Array.from({ length: 64 }, () => L.freshMapOrigin()));
  for (const g of picks) assert.equal(L.mapOriginOk(g), true);
  assert.ok(picks.size > 1, 'each new world draws its own origin');
});

test('parseConfig: the word exact, once, on a natural world only; off unless given', async () => {
  const fault = async (args, code) => assert.rejects(L.parseConfig(args), e => e.code === code, code);
  for (const v of ['true', 'yes', 'random', 'local-fresh-map-v2', 'LOCAL-FRESH-MAP-V1', '1771234567']) await fault([...natural, '--fresh-map', v], 'InvalidFreshMap');
  await fault([...natural, '--fresh-map', L.FRESH_MAP_MODE, '--fresh-map', L.FRESH_MAP_MODE], 'InvalidArguments');
  await fault([...abs, '--fresh-map', L.FRESH_MAP_MODE], 'FreshMapNeedsNaturalWorld');
  // (an origin is never taken from the command line: the launcher picks it per world)
  await fault([...natural, '--map-origin', String(G0 - 5)], 'InvalidArguments');
  // (well-formed with the kept world's words and with the demo's: it fails only later, at the paths, which do not exist here)
  const words = ['InvalidFreshMap', 'FreshMapNeedsNaturalWorld', 'InvalidArguments', 'PersistNeedsNaturalWorld', 'InvalidCaptureDemo'];
  for (const more of [[], ['--continuous', L.CONTINUOUS_MODE, '--persist', L.PERSIST_MODE], ['--march-trial', L.MARCH_TRIAL_MODE, '--capture-demo', L.CAPTURE_DEMO_MODE, '--demo-scale', '20']])
    await assert.rejects(L.parseConfig([...natural, ...more, '--fresh-map', L.FRESH_MAP_MODE]), e => !words.includes(e.code), String(more));
  assert.match(L.USAGE, /--fresh-map local-fresh-map-v1: TEST-ONLY, natural preset only/);
});

test('startWorld refuses the option off a natural world, in another shape, or with an origin out of bounds, before anything starts', async () => {
  const base = { worldPreset: 'local-natural-v1', naturalRunner: '/x/natural', economy: 'page-signed-v1' };
  const refused = async (c, why) => assert.rejects(L.startWorld(c, WALLET, 0, () => {}), e => e.code === 'InvalidWorldPreset', why);
  await refused({ economy: 'page-signed-v1', freshMap: true }, 'off a natural world');
  await refused({ ...base, freshMap: 'yes' }, 'not exactly true');
  await refused({ ...base, freshMap: false }, 'not exactly true');
  for (const g of [G0, G0 + 60, G0 - SPAN - 1, 1.5]) await refused({ ...base, freshMap: true, guard: { mapOrigin: () => g } }, `origin ${g}`);
});

test('the runner\'s first line must state exactly the origin asked for; a resumed kept world keeps its own map', () => {
  const A = G0 - 14_307_833, B = G0 - 25_542_399;
  const ok = (meta, origin, why) => assert.equal(L.runnerMapAgrees(meta, origin), true, why);
  const no = (meta, origin, why) => assert.equal(L.runnerMapAgrees(meta, origin), false, why);
  assert.deepEqual(L.runnerFreshMap(stated(A)), { origin: A, genesis_round: 26_173_955 });
  assert.equal(L.runnerFreshMap({}), null);
  ok({}, null, 'a plain world on a plain launcher (and any older runner)');
  ok({ continuous: false, memory_only: true }, null);
  ok(stated(A), A, 'a new world of the origin asked for');
  no({}, A, 'the runner ignored the option: the world has the fixed map');
  no(stated(B), A, 'another origin than the one asked for');
  no(stated(A), null, 'a fresh map this launcher did not ask for');
  no(stated(G0), G0, 'the fixed origin is not a fresh map');
  no(stated(G0 - SPAN - 1), G0 - SPAN - 1, 'out of bounds');
  no(stated(A, { mode: 'local-fresh-map-v2' }), A, 'another mode');
  no(stated(A, { test_only: false }), A, 'not test-only');
  no(stated(A, { genesis_round: 0 }), A, 'no round');
  no(stated(A, { genesis_round: '26173955' }), A, 'round not a number');
  no(stated(String(A)), A, 'origin not a number');
  no(stated(A, { extra: 1 }), A, 'anything more');
  no({ fresh_map: null }, A, 'null');
  no({ fresh_map: null }, null, 'null, not asked');
  no({ fresh_map: true }, A, 'not an object');
  // (resumed: the ledger's own origin wins over this start's, with or without the option; a malformed statement never passes)
  const resumed = { persist: { mode: L.PERSIST_MODE, resumed: true, test_only: true, not_for_production: true }, memory_only: false };
  ok({ ...resumed, ...stated(B) }, A, 'resumed: made with another origin');
  ok({ ...resumed, ...stated(B) }, null, 'resumed by a launcher without the option');
  ok({ ...resumed }, A, 'resumed: a world of the fixed map stays so');
  no({ ...resumed, ...stated(G0) }, A, 'resumed, malformed');
  no({ ...resumed, fresh_map: null }, null, 'resumed, null');
  no({ persist: { resumed: false }, ...stated(B) }, A, 'a NEW kept world of another origin');
});

// ------------------------------------------------------------------ the wiring, with stand-in processes
async function tree(t, runnerStates) {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-fresh-map-test-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const script = async (rel, source) => { const f = path.join(tmp, rel); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, `#!${process.execPath}\n${source}`, { mode: 0o755 }); return f; };
  const head = `const fs = require('node:fs'), path = require('node:path'), http = require('node:http');\nconst arg = k => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined;\nprocess.on('SIGINT', () => process.exit(0));\n`;
  // (a stand-in runner: records its arguments; states the origin it was given as the real runner does — `honest` — or
  //  ignores it like a runner that predates the option — `ignores` — or states another — `other`)
  const runner = await script('bin/natural-runner', head + `
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'runner-args.json'), JSON.stringify(process.argv.slice(2)));
const meta = { program: ${JSON.stringify(LP.LOCAL_PLAY_PROGRAM)}, rpc_url: 'http://127.0.0.1:' + arg('--rpc-port'), season: ${JSON.stringify(SEASON)}, season_id: 11,
  player_wallet: arg('--player-wallet'), artifact: { sha256: arg('--artifact-sha256') }, world: 'natural', world_preset: 'local-natural-v1', continuous: false, memory_only: true };
const g0 = arg('--map-origin'), how = ${JSON.stringify(runnerStates)};
if (g0 !== undefined && how !== 'ignores') meta.fresh_map = { mode: 'local-fresh-map-v1', origin: Number(g0) - (how === 'other' ? 3 : 0), genesis_round: 26173955, test_only: true };
console.log(JSON.stringify(meta));
console.log(JSON.stringify({ schema: 'x', natural_step: 'ready-for-join', home_provinces: [{ nation: 1, p: '-1', q: '2' }] }));
setInterval(() => {}, 1000);
`);
  const herald = await script('bin/herald', head + `
const [host, port] = arg('--listen').split(':');
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ herald: true, path: req.url })); }).listen(Number(port), host);
`);
  await script('permutation-gateway/src/frontier/local-play-relay-server.mjs', `import http from 'node:http';
const arg = k => process.argv[process.argv.indexOf(k) + 1];
process.on('SIGINT', () => process.exit(0));
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ localPlay: true, cluster: 'localnet', wallet: arg('--wallet'), path: req.url })); })
  .listen(Number(arg('--listen-port')), '127.0.0.1', () => console.log(JSON.stringify({ listen: '127.0.0.1:' + arg('--listen-port') })));
`);
  await fsp.mkdir(path.join(tmp, 'permutation-server/web'), { recursive: true });
  const so = path.join(tmp, 'bin/program.so'); await fsp.writeFile(so, 'x');
  const c = { root: tmp, data: path.join(tmp, 'data'), runner, naturalRunner: runner, herald, depart: runner, preview: runner, resident: runner, artifact: so, artifactSha: 'cd'.repeat(32),
    port: 41860, worldPort: 41864, economy: 'page-signed-v1', worldPreset: L.NATURAL_WORLD_PRESET, guard: { naturalFirstLineMs: 8000 } };
  await fsp.mkdir(c.data, { recursive: true });
  const runnerArgs = async () => JSON.parse(await fsp.readFile(path.join(tmp, 'runner-args.json'), 'utf8'));
  const worldDirs = async () => (await fsp.readdir(c.data)).map(d => path.join(c.data, d));
  return { c, runnerArgs, worldDirs };
}
const valueOf = (a, k) => a.includes(k) ? a[a.indexOf(k) + 1] : undefined;

test('without the option nothing changes: the runner is given no origin and nothing is recorded', { timeout: 60000 }, async t => {
  const { c, runnerArgs, worldDirs } = await tree(t, 'honest');
  const w = await L.startWorld(c, WALLET, 0, () => {});
  t.after(() => w.stop());
  assert.equal((await runnerArgs()).includes('--map-origin'), false);
  const [dir] = await worldDirs();
  await assert.rejects(fsp.stat(path.join(dir, 'fresh-map.json')), e => e.code === 'ENOENT');
  await w.stop();
});

test('with the option each new world is given its own origin, the runner must state it, and the start records it', { timeout: 60000 }, async t => {
  const { c, runnerArgs, worldDirs } = await tree(t, 'honest');
  const origins = [];
  for (let i = 0; i < 2; i++) {
    const w = await L.startWorld({ ...c, freshMap: true }, WALLET, 0, () => {});
    t.after(() => w.stop());
    const g0 = Number(valueOf(await runnerArgs(), '--map-origin'));
    assert.equal(L.mapOriginOk(g0), true);
    assert.equal(String(g0), valueOf(await runnerArgs(), '--map-origin'), 'written plainly');
    origins.push(g0);
    await w.stop();
  }
  // (two draws of 31,536,000 seconds: equal by chance once in 31.5 million runs)
  assert.notEqual(origins[0], origins[1], 'two new worlds, two origins');
  const records = await Promise.all((await worldDirs()).map(async d => JSON.parse(await fsp.readFile(path.join(d, 'fresh-map.json'), 'utf8'))));
  assert.deepEqual(records.map(r => r.asked_origin).sort(), [...origins].sort());
  for (const r of records) assert.deepEqual(r, { mode: 'local-fresh-map-v1', asked_origin: r.asked_origin, world: { origin: r.asked_origin, genesis_round: 26_173_955 }, resumed: false, fixed_origin: G0, test_only: true });
  // (a pinned pick reaches the runner unchanged)
  const w = await L.startWorld({ ...c, freshMap: true, guard: { ...c.guard, mapOrigin: () => G0 - 14_307_833 } }, WALLET, 0, () => {});
  t.after(() => w.stop());
  assert.equal(valueOf(await runnerArgs(), '--map-origin'), String(G0 - 14_307_833));
  await w.stop();
});

test('a runner that ignores the option, or states another origin, is not started with: never a fixed map passed off as a fresh one', { timeout: 60000 }, async t => {
  for (const how of ['ignores', 'other']) {
    const { c, runnerArgs } = await tree(t, how);
    await assert.rejects(L.startWorld({ ...c, freshMap: true }, WALLET, 0, () => {}), e => e.code === 'RunnerNotReady', how);
    assert.equal((await runnerArgs()).includes('--map-origin'), true, 'it was asked');
  }
});
