// TEST-ONLY external AI residents (⑤ option B): the launcher's wiring, with stand-in processes (runner, herald, relay,
// operator residents) in a temp dir, on loopback 41402–41425 only; every process it starts is stopped by its world's
// stop. THIS FILE MAKES NO KEY: the admitted residents are fixed public addresses. No chain, no real binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { parseConfig, startWorld, NATURAL_WORLD_PRESET, OPERATOR_LAMPORTS } from '../src/frontier/local-play-launcher.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const OP = ['9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'];
const EXT = ['5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', 'C676sUVBzYBPsrUhf931tBwdM4XczCaG4jpChGnmMSwJ'];
const SEASON = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '11').season;

async function tree(t, { relayListens = true } = {}) {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-external-test-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const script = async (rel, source) => { const f = path.join(tmp, rel); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, `#!${process.execPath}\n${source}`, { mode: 0o755 }); return f; };
  const head = `const fs = require('node:fs'), path = require('node:path'), http = require('node:http');\nconst arg = k => process.argv[process.argv.indexOf(k) + 1];\nprocess.on('SIGINT', () => process.exit(0));\n`;
  const runner = await script('bin/natural-runner', head + `
const meta = { program: ${JSON.stringify(LP.LOCAL_PLAY_PROGRAM)}, rpc_url: 'http://127.0.0.1:' + arg('--rpc-port'), season: ${JSON.stringify(SEASON)}, season_id: 11,
  player_wallet: arg('--player-wallet'), artifact: { sha256: arg('--artifact-sha256') }, world: 'natural', world_preset: 'local-natural-v1' };
console.log(JSON.stringify(meta));
console.log(JSON.stringify({ schema: 'x', natural_step: 'ready-for-join', home_provinces: [{ nation: 1, p: '-1', q: '2' }] }));
setInterval(() => {}, 1000);
`);
  const herald = await script('bin/herald', head + `
const [host, port] = arg('--listen').split(':');
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ herald: true, path: req.url })); }).listen(Number(port), host);
`);
  // (a stand-in relay: records its arguments, listens, says so on its first line, and answers its info with ITS wallet)
  await script('permutation-gateway/src/frontier/local-play-relay-server.mjs', `import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const arg = k => process.argv[process.argv.indexOf(k) + 1];
process.on('SIGINT', () => process.exit(0));
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'relay-' + arg('--listen-port') + '.json'), JSON.stringify(process.argv.slice(2)));
${relayListens ? `http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ localPlay: true, cluster: 'localnet', wallet: arg('--wallet'), path: req.url })); })
  .listen(Number(arg('--listen-port')), '127.0.0.1', () => console.log(JSON.stringify({ listen: '127.0.0.1:' + arg('--listen-port') })));` : 'setInterval(() => {}, 1000);'}
`);
  await script('permutation-gateway/src/frontier/local-play-operator-residents.mjs', `process.on('SIGINT', () => process.exit(0));
console.log(JSON.stringify({ schema: 'frontier-local-play-operator-residents-v1', mode: 'operator-residents-v1', test_only: true, wallets: ${JSON.stringify(OP)} }));
setInterval(() => {}, 1000);
`);
  await fsp.mkdir(path.join(tmp, 'permutation-server/web'), { recursive: true });
  const so = path.join(tmp, 'bin/program.so'); await fsp.writeFile(so, 'x');
  const funded = [];
  const c = { root: tmp, data: path.join(tmp, 'data'), runner, naturalRunner: runner, herald, depart: runner, preview: runner, resident: runner, artifact: so, artifactSha: 'cd'.repeat(32),
    port: 41402, worldPort: 41404, economy: 'page-signed-v1', worldPreset: NATURAL_WORLD_PRESET, operatorResidents: 1,
    guard: { naturalFirstLineMs: 8000, operatorFund: async w => { funded.push(['op', w]); }, externalFund: async w => { funded.push(['ext', w]); }, externalListenTries: 30 } };
  await fsp.mkdir(c.data, { recursive: true });
  const read = async f => { for (let i = 0; ; i++) { try { return JSON.parse(await fsp.readFile(path.join(tmp, f), 'utf8')); } catch (e) { if (i > 50) throw e; await new Promise(r => setTimeout(r, 100)); } } };
  const worldDir = async () => path.join(c.data, (await fsp.readdir(c.data))[0]);
  return { tmp, c, read, so, funded, worldDir };
}

test('the command line: one or two addresses, natural worlds only, not with the contest pair, ports in range', { timeout: 30000 }, async t => {
  const { tmp, c, so } = await tree(t);
  const base = { root: tmp, data: path.join(tmp, 'data2'), runner: c.runner, herald: c.herald, depart: c.runner, preview: c.runner, resident: c.runner, artifact: so, 'artifact-sha': 'cd'.repeat(32),
    'world-preset': 'local-natural-v1', 'natural-runner': c.naturalRunner, economy: 'page-signed-v1', port: '41402', 'world-port': '41404' };
  const argv = o => Object.entries(o).flatMap(([k, v]) => [`--${k}`, String(v)]);
  assert.deepEqual((await parseConfig(argv({ ...base, 'external-residents': EXT.join(',') }))).externalResidents, EXT);
  assert.equal((await parseConfig(argv(base))).externalResidents, undefined);
  const refused = (o, code) => assert.rejects(parseConfig(argv(o)), e => e.code === code, code);
  await refused({ ...base, 'external-residents': `${EXT[0]},${EXT[0]}` }, 'InvalidExternalResidents');
  await refused({ ...base, 'external-residents': [...EXT, WALLET].join(',') }, 'InvalidExternalResidents');
  const { 'world-preset': _p, 'natural-runner': _n, ...plain } = base;
  await refused({ ...plain, 'external-residents': EXT[0] }, 'ExternalResidentsNeedNatural');
  await refused({ ...base, 'march-trial': 'local-march-trial-v1', 'capture-demo': 'capture-demo-v1', 'demo-scale': '10', 'contest-pair': 'contest-pair-v1', 'external-residents': EXT[0] }, 'ExternalResidentsNeedNatural');
  // (two worlds + operators + residents: 10 + 8 + 8 ports from --world-port, below 42000; without operators 10 + 8, missing 41970)
  await refused({ ...base, 'operator-residents': '1', 'external-residents': EXT[0], 'world-port': '41975' }, 'InvalidPorts');
  await refused({ ...base, 'external-residents': EXT[0], 'world-port': '41955', port: '41940' }, 'InvalidPorts');
});

test('a natural world with two admitted residents: funded like the player, a relay pinned to each wallet, a proxy each; the page is told nothing', { timeout: 60000 }, async t => {
  const { c, read, funded, worldDir } = await tree(t);
  let stops = 0;
  const w = await startWorld(c, WALLET, 0, () => { stops++; }, undefined, { external: EXT });
  t.after(() => w.stop());
  // funding: the same amount for the operator and the residents (the player's own), each once, nothing more
  assert.deepEqual(funded, [['op', OP[0]], ['ext', EXT[0]], ['ext', EXT[1]]]);
  const arg = (a, k) => a[a.indexOf(k) + 1];
  const r0 = await read('relay-41423.json'), r1 = await read('relay-41425.json'), player = await read('relay-41407.json');
  assert.equal(arg(r0, '--wallet'), EXT[0]); assert.equal(arg(r1, '--wallet'), EXT[1]);
  const strip = a => a.filter((x, i) => !['--wallet', '--listen-port', '--resident-turns'].includes(x) && !['--wallet', '--listen-port', '--resident-turns'].includes(a[i - 1]));
  assert.deepEqual(strip(r0), strip(player), 'the player\'s relay arguments, only the wallet and the port changed (and the turn lease)');
  // (Q16-2: an external resident's relay holds it to one action per bell, on the world's lease directory; the player's does not)
  assert.equal(arg(r0, '--resident-turns'), arg(r1, '--resident-turns'));
  assert.ok(path.isAbsolute(arg(r0, '--resident-turns')) && arg(r0, '--resident-turns').endsWith(`${path.sep}resident-turns`));
  assert.equal(player.includes('--resident-turns'), false);
  // the world's answer names each resident's own proxy; its relay routes reach ITS relay, the rest the shared herald
  assert.deepEqual(w.external, { [EXT[0]]: 'http://localhost:41422', [EXT[1]]: 'http://localhost:41424' });
  const info = await (await fetch('http://localhost:41422/gw/f/local-play/info')).json();
  assert.deepEqual([info.wallet, info.path], [EXT[0], '/f/local-play/info']);
  const h = await (await fetch('http://localhost:41424/h/status')).json();
  assert.deepEqual([h.herald, h.path], [true, '/h/status']);
  // the proxy's own rules: no other route, no write without the launcher page's Origin
  assert.equal((await fetch('http://localhost:41422/operators.json')).status, 404);
  assert.equal((await fetch('http://localhost:41422/gw/f/local-play/act/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const dir = await worldDir();
  const roster = JSON.parse(await fsp.readFile(path.join(dir, 'externals.json'), 'utf8'));
  assert.deepEqual([roster.wallets, roster.lamports_each, roster.test_only, roster.ports], [EXT, OPERATOR_LAMPORTS, true, [{ herald: 41422, relay: 41423 }, { herald: 41424, relay: 41425 }]]);
  const procs = JSON.parse(await fsp.readFile(path.join(dir, 'processes.json'), 'utf8'));
  assert.ok([41422, 41423, 41424, 41425].every(p => procs.ports.includes(p)));
  await w.stop();
  assert.equal(stops, 1);
  // stopped with the world: its proxies are closed too
  await assert.rejects(fetch('http://localhost:41422/h/status'));
});

test("a resident's relay that never says it listens refuses the world's start; an admitted address that is a player's is refused", { timeout: 60000 }, async t => {
  const a = await tree(t, { relayListens: false });
  await assert.rejects(startWorld(a.c, WALLET, 0, () => {}, undefined, { external: [EXT[0]] }), e => e.code === 'ExternalRelayNotReady');
  const b = await tree(t);
  await assert.rejects(startWorld(b.c, WALLET, 0, () => {}, undefined, { external: [WALLET] }), e => e.code === 'InvalidExternalResidents');
  await assert.rejects(startWorld(b.c, WALLET, 0, () => {}, undefined, { external: [OP[0]] }), e => e.code === 'InvalidExternalResidents');
  assert.deepEqual(b.funded.filter(([k]) => k === 'ext'), [], 'nothing funded for a refused admission');
});
