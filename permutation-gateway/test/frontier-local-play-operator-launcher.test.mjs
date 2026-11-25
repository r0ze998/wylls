// TEST-ONLY operator AI residents (⑤ option A): the launcher's wiring, with stand-in processes (runner, herald,
// relay, residents) in a temp dir, on loopback 41429–41447 only; every process it starts is stopped by its world's
// stop. THIS FILE MAKES NO KEY: the stand-in residents print fixed public addresses. No chain, no real binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { parseConfig, startWorld, NATURAL_WORLD_PRESET, OPERATOR_LAMPORTS } from '../src/frontier/local-play-launcher.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const AI = ['5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', 'C676sUVBzYBPsrUhf931tBwdM4XczCaG4jpChGnmMSwJ'];
const SEASON = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '11').season;

async function tree(t, { wallets = AI, residentsExit = false, war = false } = {}) {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-operator-test-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const script = async (rel, source) => { const f = path.join(tmp, rel); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, `#!${process.execPath}\n${source}`, { mode: 0o755 }); return f; };
  const head = `const fs = require('node:fs'), path = require('node:path'), http = require('node:http');\nconst arg = k => process.argv[process.argv.indexOf(k) + 1];\nprocess.on('SIGINT', () => process.exit(0));\n`;
  const runner = await script('bin/natural-runner', head + `
const meta = { program: ${JSON.stringify(LP.LOCAL_PLAY_PROGRAM)}, rpc_url: 'http://127.0.0.1:' + arg('--rpc-port'), season: ${JSON.stringify(SEASON)}, season_id: 11,
  player_wallet: arg('--player-wallet'), artifact: { sha256: arg('--artifact-sha256') }, world: 'natural', world_preset: 'local-natural-v1' };
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'runner-args.json'), JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify(meta));
console.log(JSON.stringify({ schema: 'x', natural_step: 'ready-for-join', home_provinces: [{ nation: 1, p: '-1', q: '2' }, { nation: 4, p: '0', q: '-2' }] }));
setInterval(() => {}, 1000);
`);
  const herald = await script('bin/herald', head + `
const [host, port] = arg('--listen').split(':');
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }).listen(Number(port), host);
`);
  await script('permutation-gateway/src/frontier/local-play-relay-server.mjs', `import fs from 'node:fs'; import path from 'node:path';
const arg = k => process.argv[process.argv.indexOf(k) + 1];
process.on('SIGINT', () => process.exit(0));
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'relay-' + arg('--listen-port') + '.json'), JSON.stringify(process.argv.slice(2)));
setInterval(() => {}, 1000);
`);
  await script('permutation-gateway/src/frontier/local-play-operator-residents.mjs', `import fs from 'node:fs'; import path from 'node:path';
process.on('SIGINT', () => process.exit(0));
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'operators-args.json'), JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ schema: 'frontier-local-play-operator-residents-v1', mode: 'operator-residents-v1', test_only: true, wallets: ${JSON.stringify(wallets)} }));
${residentsExit ? 'setTimeout(() => process.exit(3), 300);' : 'setInterval(() => {}, 1000);'}
`);
  await fsp.mkdir(path.join(tmp, 'permutation-server/web'), { recursive: true });
  const so = path.join(tmp, 'bin/program.so'); await fsp.writeFile(so, 'x');
  const funded = [];
  const c = { root: tmp, data: path.join(tmp, 'data'), runner, naturalRunner: runner, herald, depart: runner, preview: runner, resident: runner, artifact: so, artifactSha: 'cd'.repeat(32),
    port: 41429, worldPort: 41430, economy: 'page-signed-v1', worldPreset: NATURAL_WORLD_PRESET, operatorResidents: wallets.length, ...(war ? { operatorWar: true } : {}),
    guard: { naturalFirstLineMs: 8000, operatorFund: async w => { funded.push(w); } } };
  await fsp.mkdir(c.data, { recursive: true });
  // (a stand-in writes its file just after it starts: waited for, briefly)
  const read = async f => { for (let i = 0; ; i++) { try { return JSON.parse(await fsp.readFile(path.join(tmp, f), 'utf8')); } catch (e) { if (i > 50) throw e; await new Promise(r => setTimeout(r, 100)); } } };
  const worldDir = async () => path.join(c.data, (await fsp.readdir(c.data))[0]);
  return { tmp, c, read, so, funded, worldDir };
}

test('the command line: 1-4 residents, natural worlds only, their ports inside the range', { timeout: 30000 }, async t => {
  const { tmp, c, so } = await tree(t);
  const base = { root: tmp, data: path.join(tmp, 'data2'), runner: c.runner, herald: c.herald, depart: c.runner, preview: c.runner, resident: c.runner, artifact: so, 'artifact-sha': 'cd'.repeat(32),
    'world-preset': 'local-natural-v1', 'natural-runner': c.naturalRunner, economy: 'page-signed-v1', port: '41429', 'world-port': '41430' };
  const argv = o => Object.entries(o).flatMap(([k, v]) => [`--${k}`, String(v)]);
  assert.equal((await parseConfig(argv({ ...base, 'operator-residents': '2' }))).operatorResidents, 2);
  assert.equal((await parseConfig(argv(base))).operatorResidents, undefined);
  const refused = (o, code) => assert.rejects(parseConfig(argv(o)), e => e.code === code, code);
  await refused({ ...base, 'operator-residents': '5' }, 'InvalidOperatorResidents');
  await refused({ ...base, 'operator-residents': '0' }, 'InvalidOperatorResidents');
  // (Q16-2: one action per resident per bell is not a setting: the former --operator-per-turn is refused)
  await assert.rejects(parseConfig(argv({ ...base, 'operator-residents': '2', 'operator-per-turn': '1' })), e => e.code === 'InvalidArguments');
  const { 'world-preset': _p, 'natural-runner': _n, ...plain } = base;
  await refused({ ...plain, 'operator-residents': '1' }, 'OperatorResidentsNeedNatural');
  // (the 18 ports of two worlds and their residents must fit below 42000 and miss 41904-41907 and 41970)
  await refused({ ...base, 'operator-residents': '1', 'world-port': '41985' }, 'InvalidPorts');
  await refused({ ...base, 'operator-residents': '1', 'world-port': '41890' }, 'InvalidPorts');
  await refused({ ...base, 'operator-residents': '1', 'world-port': '41960', port: '41950' }, 'InvalidPorts');
  // ⑰ (owner 2026-11-18 21:44): no AI residents in paid periods; and the launcher has no paid windows at all.
  await refused({ ...base, 'operator-residents': '1', 'prize-epochs': 'on' }, 'AiResidentsInPaidWindow');
  await refused({ ...base, 'prize-epochs': 'on' }, 'PrizeNotInLauncher');
  await assert.rejects(parseConfig([...argv({ ...base, 'prize-epochs': 'on' }), '--external-residents', '11111111111111111111111111111112']), e => e.code === 'AiResidentsInPaidWindow');
});

test('a natural world with two residents: funded like the player, one relay each pinned to its wallet; the page is told only which nations have one', { timeout: 60000 }, async t => {
  const { c, read, funded, worldDir } = await tree(t);
  let stops = 0;
  const w = await startWorld(c, WALLET, 0, () => { stops++; });
  t.after(() => w.stop());
  // the answer the page gets has no word about WHO the residents are (Y2: shown as any other resident) — only the
  // nations that have one, as numbers, for the nation picker's "AI present" mark (owner 2026-11-25 12:04 Q-LP16-4 (a);
  // verify-pr237: this test still said "the page is told nothing" and failed on the new field)
  assert.deepEqual(Object.keys(w).filter(k => /operator|resident|ai/i.test(k)), ['aiNations']);
  assert.deepEqual(w.aiNations, [1, 4]);
  assert.ok(!JSON.stringify(w.aiNations).includes(AI[0]) && w.aiNear === undefined);
  assert.deepEqual(funded, AI);
  const r0 = await read('relay-41440.json'), r1 = await read('relay-41441.json');
  const arg = (a, k) => a[a.indexOf(k) + 1];
  assert.equal(arg(r0, '--wallet'), AI[0]); assert.equal(arg(r1, '--wallet'), AI[1]);
  // the player's relay arguments, with only the wallet and the port changed
  const player = await read('relay-41433.json');
  const strip = a => a.filter((x, i) => !['--wallet', '--listen-port', '--resident-turns'].includes(x) && !['--wallet', '--listen-port', '--resident-turns'].includes(a[i - 1]));
  assert.deepEqual(strip(r0), strip(player));
  // (and one thing more, Q16-2: a resident's relay holds it to one action per bell; the player's relay does not)
  const dirOfWorld = await worldDir();
  assert.equal(arg(r0, '--resident-turns'), path.resolve(dirOfWorld, 'resident-turns')); assert.equal(arg(r1, '--resident-turns'), path.resolve(dirOfWorld, 'resident-turns'));
  assert.equal(player.includes('--resident-turns'), false);
  const ops = await read('operators-args.json');
  assert.equal(arg(ops, '--count'), '2'); assert.equal(arg(ops, '--relay-ports'), '41440,41441'); assert.equal(arg(ops, '--herald'), 'http://127.0.0.1:41432');
  assert.deepEqual(JSON.parse(arg(ops, '--homes')), [{ p: -1, q: 2, nation: 1 }, { p: 0, q: -2, nation: 4 }]);
  assert.equal(ops.includes('--per-turn'), false, 'no pace per turn is passed: one action per bell');
  const dir = await worldDir();
  const roster = JSON.parse(await fsp.readFile(path.join(dir, 'operators.json'), 'utf8'));
  assert.deepEqual([roster.count, roster.wallets, roster.ports, roster.lamports_each, roster.test_only], [2, AI, [41440, 41441], OPERATOR_LAMPORTS, true]);
  const procs = JSON.parse(await fsp.readFile(path.join(dir, 'processes.json'), 'utf8'));
  assert.ok(procs.ports.includes(41440) && procs.ports.includes(41441));
  await w.stop();
  assert.equal(stops, 1);
});

test("the residents' own end never ends the people's world; a resident wallet that is the player's is refused", { timeout: 60000 }, async t => {
  const a = await tree(t, { residentsExit: true });
  let stops = 0;
  const w = await startWorld(a.c, WALLET, 0, () => { stops++; });
  t.after(() => w.stop());
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(stops, 0, 'the world still runs after the residents process ended');
  assert.equal(JSON.parse(await fsp.readFile(path.join(await a.worldDir(), 'stopped.json'), 'utf8').catch(() => 'null')), null);
  await w.stop();
  const b = await tree(t, { wallets: [AI[0], WALLET] });
  await assert.rejects(startWorld(b.c, WALLET, 0, () => {}), e => e.code === 'OperatorResidentsNotReady');
  assert.deepEqual(b.funded, [], 'nothing funded for a refused roster');
});

test('the war option (owner t359u): exact word, only with residents and the march trial — any natural world (loop-play4 B-6); 5-12 residents only with it', { timeout: 30000 }, async t => {
  const { tmp, c, so } = await tree(t);
  const base = { root: tmp, data: path.join(tmp, 'data3'), runner: c.runner, herald: c.herald, depart: c.runner, preview: c.runner, resident: c.runner, artifact: so, 'artifact-sha': 'cd'.repeat(32),
    'world-preset': 'local-natural-v1', 'natural-runner': c.naturalRunner, economy: 'page-signed-v1', 'march-trial': 'local-march-trial-v1', 'capture-demo': 'capture-demo-v1', 'demo-scale': '30', port: '41400', 'world-port': '41404' };
  const argv = o => Object.entries(o).flatMap(([k, v]) => [`--${k}`, String(v)]);
  const ok = await parseConfig(argv({ ...base, 'operator-residents': '12', 'operator-war': 'operator-war-v1' }));
  assert.deepEqual([ok.operatorResidents, ok.operatorWar], [12, true]);
  assert.equal((await parseConfig(argv({ ...base, 'operator-residents': '2' }))).operatorWar, undefined);
  const refused = (o, code) => assert.rejects(parseConfig(argv(o)), e => e.code === code, code);
  await refused({ ...base, 'operator-residents': '12' }, 'InvalidOperatorResidents');
  await refused({ ...base, 'operator-residents': '13', 'operator-war': 'operator-war-v1' }, 'InvalidOperatorResidents');
  await refused({ ...base, 'operator-residents': '6', 'operator-war': 'yes' }, 'InvalidOperatorWar');
  await refused({ ...base, 'operator-war': 'operator-war-v1' }, 'OperatorWarNeedsResidentsTrial');
  // (loop-play4 B-6: no longer the capture demo's only — a plain, a kept and a wide natural world take it too)
  const { 'capture-demo': _c, 'demo-scale': _s, ...noDemo } = base;
  assert.equal((await parseConfig(argv({ ...noDemo, 'operator-residents': '4', 'operator-war': 'operator-war-v1' }))).operatorWar, true);
  assert.equal((await parseConfig(argv({ ...noDemo, 'operator-residents': '4', 'operator-war': 'operator-war-v1', continuous: 'local-continuous-v1', persist: 'local-persist-v1' }))).operatorWar, true);
  const wideOk = await parseConfig(argv({ ...noDemo, 'operator-residents': '4', 'operator-war': 'operator-war-v1', 'wide-land': 'local-wide-land-v1', 'wide-scale': '60', 'herald-output': 'compact-v2' }));
  assert.deepEqual([wideOk.operatorWar, wideOk.wideLand], [true, true]);
  // (but its marches are the page's own trial sends: never without the march trial)
  const { 'march-trial': _m, ...noTrial } = noDemo;
  await refused({ ...noTrial, 'operator-residents': '4', 'operator-war': 'operator-war-v1' }, 'OperatorWarNeedsResidentsTrial');
  // (12 residents: two worlds of five ports and two slots of twelve relays = 34 ports from the world port)
  await refused({ ...base, 'operator-residents': '12', 'operator-war': 'operator-war-v1', 'world-port': '41940', port: '41920' }, 'InvalidPorts');
  assert.equal((await parseConfig(argv({ ...base, 'operator-residents': '12', 'operator-war': 'operator-war-v1', 'world-port': '41936', port: '41920' }))).worldPort, 41936);
});

test('a war world: the runner serves the residents\' villages from operators.json; the residents are told to war', { timeout: 60000 }, async t => {
  const { c, read, worldDir } = await tree(t, { war: true });
  const w = await startWorld(c, WALLET, 0, () => {});
  t.after(() => w.stop());
  const runner = await read('runner-args.json'), ops = await read('operators-args.json');
  const arg = (a, k) => a[a.indexOf(k) + 1];
  assert.equal(arg(runner, '--operator-villages'), path.join(await worldDir(), 'operators.json'));
  assert.equal(arg(ops, '--war'), 'operator-war-v1');
  await w.stop();
  // (an ordinary world: neither)
  const p = await tree(t);
  const w2 = await startWorld(p.c, WALLET, 0, () => {});
  t.after(() => w2.stop());
  assert.equal((await p.read('runner-args.json')).includes('--operator-villages'), false);
  assert.equal((await p.read('operators-args.json')).includes('--war'), false);
  await w2.stop();
});
