// TEST-ONLY `--wide-land local-wide-land-v1` (owner t377u: "広い版何枚か写真送れる？"): a natural local world whose Season is
// the devnet wide preset S1_DEVNET_WIDE_7D, grown by the runner during its setup to the rim (ring 128) and into the
// wide land (rings 129+). The word, the command line, the refusals (never with the demo, the pair, the land preview or
// a kept world), the agreement with the runner's first line, and the wiring with stand-in processes (a temp dir,
// loopback 41930–41938 only; every process is stopped by its world's stop). Also the page's ring banners on a grown
// map (hud/milestones.mjs bannerMilestones). THIS FILE MAKES NO KEY: no chain, no real binary, no network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as L from '../src/frontier/local-play-launcher.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import * as M from '../../permutation-server/web/frontier/hud/milestones.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const SEASON = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '11').season;
const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
const natural = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1'];
const summary = (more = {}) => ({ test_participants: [{ nation: 0, p: -1, q: 2, site: 0 }], legacy_rings_opened: 129, r_max_ext: 128, rim_provinces: [{ p: 64, q: 64 }],
  wide_rings: [{ ring: 129, provinces: [{ p: '65', q: '64' }] }], bell_at_ready: 129, setup_secs: 6, ...more });
const stated = (more = {}, sum = {}) => ({ wide_land: { mode: L.WIDE_LAND_MODE, preset: 'S1_DEVNET_WIDE_7D', test_only: true, summary: summary(sum), ...more } });

test('the word: local-wide-land-v1, in the usage, off unless given', () => {
  assert.equal(L.WIDE_LAND_MODE, 'local-wide-land-v1');
  assert.match(L.USAGE, /--wide-land local-wide-land-v1: TEST-ONLY, natural preset only/);
  assert.match(L.USAGE, /S1_DEVNET_WIDE_7D/);
});

test('parseConfig: the word exact, once, on a natural world without the demo, the land preview or a kept world', async () => {
  const fault = async (args, code) => assert.rejects(L.parseConfig(args), e => e.code === code, `${code}: ${args.slice(-4).join(' ')}`);
  for (const v of ['true', 'yes', 'wide', 'local-wide-land-v2', 'LOCAL-WIDE-LAND-V1']) await fault([...natural, '--wide-land', v], 'InvalidWideLand');
  await fault([...natural, '--wide-land', L.WIDE_LAND_MODE, '--wide-land', L.WIDE_LAND_MODE], 'InvalidArguments');
  await fault([...abs, '--wide-land', L.WIDE_LAND_MODE], 'WideLandNeedsNaturalWorld');
  await fault([...natural, '--march-trial', L.MARCH_TRIAL_MODE, '--capture-demo', L.CAPTURE_DEMO_MODE, '--demo-scale', '20', '--wide-land', L.WIDE_LAND_MODE], 'WideLandNeedsNaturalWorld');
  await fault([...natural, '--continuous', L.CONTINUOUS_MODE, '--wide-land', L.WIDE_LAND_MODE], 'WideLandNeedsNaturalWorld');
  await fault([...natural, '--persist', L.PERSIST_MODE, '--wide-land', L.WIDE_LAND_MODE], 'WideLandNeedsNaturalWorld');
  // (well-formed alone, with the march trial, residents or a fresh map: it fails only later, at the paths, which do not exist here)
  const words = ['InvalidWideLand', 'WideLandNeedsNaturalWorld', 'InvalidArguments'];
  for (const more of [[], ['--march-trial', L.MARCH_TRIAL_MODE], ['--operator-residents', '2'], ['--fresh-map', L.FRESH_MAP_MODE]])
    await assert.rejects(L.parseConfig([...natural, ...more, '--wide-land', L.WIDE_LAND_MODE]), e => !words.includes(e.code), String(more));
});

test('startWorld refuses the option off a natural world, in another shape, or with the demo / land / kept world / pair, before anything starts', async () => {
  const base = { worldPreset: 'local-natural-v1', naturalRunner: '/x/natural', economy: 'page-signed-v1' };
  const refused = async (c, why) => assert.rejects(L.startWorld(c, WALLET, 0, () => {}), e => e.code === 'InvalidWorldPreset', why);
  await refused({ economy: 'page-signed-v1', wideLand: true }, 'off a natural world');
  await refused({ ...base, wideLand: 'yes' }, 'not exactly true');
  await refused({ ...base, wideLand: false }, 'not exactly true');
  await refused({ ...base, marchTrial: true, captureDemo: { scale: 20 }, wideLand: true }, 'with the demo');
  await refused({ ...base, continuous: true, wideLand: true }, 'continuous');
  await refused({ ...base, persist: true, wideLand: true }, 'kept');
});

test('the runner\'s first line must state the wide land exactly when it was asked for', () => {
  const ok = (meta, wide, why) => assert.equal(L.runnerWideAgrees(meta, wide), true, why);
  const no = (meta, wide, why) => assert.equal(L.runnerWideAgrees(meta, wide), false, why);
  ok({}, false, 'a plain world on a plain launcher (and any older runner)');
  ok(stated(), true, 'a wide world as asked');
  no({}, true, 'the runner ignored the option: the map ends at ring 16');
  no(stated(), false, 'a wide land this launcher did not ask for');
  no(stated({ mode: 'local-wide-land-v2' }), true, 'another mode');
  no(stated({ test_only: false }), true, 'not test-only');
  no(stated({ preset: 'S1_LOCAL_7D' }), true, 'another preset');
  no(stated({}, { legacy_rings_opened: 17 }), true, 'not grown to the rim');
  no(stated({}, { legacy_rings_opened: '129' }), true, 'rings not a number');
  no(stated({}, { wide_rings: [] }), true, 'no wide ring opened');
  no({ wide_land: null }, true, 'null');
  no({ wide_land: true }, true, 'not an object');
  no({ wide_land: null }, false, 'null, not asked');
});

// ------------------------------------------------------------------ the wiring, with stand-in processes
async function tree(t, runnerStates) {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-wide-land-test-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const script = async (rel, source) => { const f = path.join(tmp, rel); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, `#!${process.execPath}\n${source}`, { mode: 0o755 }); return f; };
  const head = `const fs = require('node:fs'), path = require('node:path'), http = require('node:http');\nconst arg = k => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined;\nprocess.on('SIGINT', () => process.exit(0));\n`;
  // (a stand-in runner: records its arguments; states the wide land it was asked for as the real runner does —
  //  `honest` — or ignores the option like a runner that predates it — `ignores`)
  const runner = await script('bin/natural-runner', head + `
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'runner-args.json'), JSON.stringify(process.argv.slice(2)));
const meta = { program: ${JSON.stringify(LP.LOCAL_PLAY_PROGRAM)}, rpc_url: 'http://127.0.0.1:' + arg('--rpc-port'), season: ${JSON.stringify(SEASON)}, season_id: 11,
  player_wallet: arg('--player-wallet'), artifact: { sha256: arg('--artifact-sha256') }, world: 'natural', world_preset: 'local-natural-v1', continuous: false, memory_only: true };
if (arg('--wide-land') !== undefined && ${JSON.stringify(runnerStates)} === 'honest') meta.wide_land = ${JSON.stringify(stated().wide_land)};
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
    port: 41930, worldPort: 41934, economy: 'page-signed-v1', worldPreset: L.NATURAL_WORLD_PRESET, guard: { naturalFirstLineMs: 8000 } };
  await fsp.mkdir(c.data, { recursive: true });
  const runnerArgs = async () => JSON.parse(await fsp.readFile(path.join(tmp, 'runner-args.json'), 'utf8'));
  const worldDirs = async () => (await fsp.readdir(c.data)).map(d => path.join(c.data, d));
  return { c, runnerArgs, worldDirs };
}
const valueOf = (a, k) => a.includes(k) ? a[a.indexOf(k) + 1] : undefined;

test('without the option nothing changes: the runner is not asked and nothing is recorded', { timeout: 60000 }, async t => {
  const { c, runnerArgs, worldDirs } = await tree(t, 'honest');
  const w = await L.startWorld(c, WALLET, 0, () => {});
  t.after(() => w.stop());
  assert.equal((await runnerArgs()).includes('--wide-land'), false);
  const [dir] = await worldDirs();
  await assert.rejects(fsp.stat(path.join(dir, 'wide-land.json')), e => e.code === 'ENOENT');
  await w.stop();
});

test('with the option the runner is asked for the wide land, must state it, and the start records it', { timeout: 60000 }, async t => {
  const { c, runnerArgs, worldDirs } = await tree(t, 'honest');
  const w = await L.startWorld({ ...c, wideLand: true }, WALLET, 0, () => {});
  t.after(() => w.stop());
  assert.equal(valueOf(await runnerArgs(), '--wide-land'), L.WIDE_LAND_MODE);
  for (const k of ['--capture-demo', '--continuous', '--persist-dir', '--land-preview']) assert.equal((await runnerArgs()).includes(k), false, k);
  const [dir] = await worldDirs();
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, 'wide-land.json'), 'utf8')), { mode: L.WIDE_LAND_MODE, world: stated().wide_land, test_only: true });
  await w.stop();
});

test('a runner that ignores the option is not started with: never a ring-16 map passed off as the wide land', { timeout: 60000 }, async t => {
  const { c, runnerArgs } = await tree(t, 'ignores');
  await assert.rejects(L.startWorld({ ...c, wideLand: true }, WALLET, 0, () => {}), e => e.code === 'RunnerNotReady');
  assert.equal(valueOf(await runnerArgs(), '--wide-land'), L.WIDE_LAND_MODE, 'it was asked');
});

// ------------------------------------------------------------------ the page's ring banners on a grown map
test('ring banners: rings open before the viewer\'s first record are quiet; of several new rings only the newest is told', () => {
  const ring = r => ({ id: `ring:${r}`, kind: 'ring', ring: r });
  const first = { id: 'first-holding', kind: 'first-holding', p: 1, q: 2, site: 0, tier: 0 };
  const grown = [first, ...Array.from({ length: 127 }, (_, i) => ring(i + 2))];
  // (a player who joins the wide land at turn 129: 127 rings are old news, the village is not)
  assert.deepEqual(M.bannerMilestones(grown, { firstRecord: true }), [first]);
  // (a viewer with a record: rings opening together are one banner, the newest)
  assert.deepEqual(M.bannerMilestones([ring(5), first, ring(7), ring(6)], { firstRecord: false }), [first, ring(7)]);
  assert.deepEqual(M.bannerMilestones([ring(5)]), [ring(5)], 'one new ring, as before');
  assert.deepEqual(M.bannerMilestones([first]), [first]);
  assert.deepEqual(M.bannerMilestones([]), []);
  // (the record still remembers every ring: newMilestones is unchanged)
  const reached = M.reachedMilestones({ holdings: [{ p: 1, q: 2, site: 0, tier: 0, state: 1 }], record: { rings: Array.from({ length: 129 }) } });
  assert.equal(reached.filter(m => m.kind === 'ring').length, 127);
  const { fresh, record } = M.newMilestones({ v: 1, seen: {} }, reached, 129);
  assert.equal(Object.keys(record.seen).filter(k => k.startsWith('ring:')).length, 127);
  assert.deepEqual(M.bannerMilestones(fresh, { firstRecord: true }).map(m => m.kind), ['first-holding']);
});

test('the page source uses the banner filter where the milestones are told', async () => {
  const src = await fsp.readFile(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(src, /const firstRecord = !FS\.mileRecord;/);
  assert.match(src, /const say = milestones\.bannerMilestones\(fresh\.filter\(m => m\.id !== 'first-holding' \|\| !mapRef\), \{ firstRecord \}\);/);
});
