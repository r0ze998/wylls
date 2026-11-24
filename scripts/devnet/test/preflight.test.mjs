// Tests of the deploy-day preflight (scripts/devnet/preflight-checks.mjs) with fake
// file systems, processes and networks: nothing here builds, starts a CLI, opens a
// key file, or contacts a network. Each check has a pass and a fail case, and the
// read-only rules (process allow-list, RPC method allow-list and budget, no key read,
// no secret printed) are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cryptoMod from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVNET_GENESIS, EXPECTED_ARTEFACT, FEATURES, RPC_BUDGET, RPC_METHODS, checkArtefact, checkEndpoint, checkGatewayCmd, checkHeraldCmd,
  checkKeeperConfig, checkKeyFiles, checkPlanner, checkProfile, checkRpc, checkServices, checkToolchain, execAllowed, featureState,
  errText, findServices, formatResults, parseKeeperToml, parsePreflightArgs, preflight, redactUrl, rpcUrlProblem, shellCommands,
} from '../preflight-checks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_PATH = `${REPO}/scripts/devnet/devnet-playable-profile.json`;
const PROFILE_TEXT = readFileSync(PROFILE_PATH, 'utf8');
const PROGRAM = '11111111111111111111111111111112'; // valid 32-byte base58, test value only
const AUTHORITY = 'SysvarRent111111111111111111111111111111111';
const profile = () => JSON.parse(PROFILE_TEXT);
const filled = () => ({ ...profile(), programId: PROGRAM, upgradeAuthority: AUTHORITY });
const HOME = '/Users/op';
const SO_PATH = `${REPO}/permutation-frontier/target/deploy-devnet-playable-sbf/permutation_frontier.so`;

/** An ELF-looking buffer carrying the playable marker (checkSo's view of a good build). */
function fakeSo({ flags = 2, marker = 'PSF_DEVNET_PLAYABLE_BUILD', extra = null, len = 8192 } = {}) {
  const b = Buffer.alloc(len);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b.writeUInt32LE(flags, 48);
  b.write('attempt to add with overflow', 128, 'latin1');
  if (marker) b.write(marker, 200, 'latin1');
  if (extra) b.write(extra, 300, 'latin1');
  b.fill(7, 1024, len - 64);
  return b;
}
const stat = ({ mode = 0o100600, uid = 501, file = true } = {}) => ({ mode, uid, isFile: () => file });

/**
 * A fake world: files (path → Buffer|string), stats (path → stat), exec answers by basename,
 * http(url, opts) → answer, tcpOpen set. Every effect is recorded.
 */
function fakeIo({ files = {}, stats = {}, execs = {}, http = null, open = new Set() } = {}) {
  const fs = { [PROFILE_PATH]: PROFILE_TEXT, ...files };
  const calls = { exec: [], http: [], tcp: [], read: [] };
  let t = 0;
  return {
    calls,
    repoRoot: REPO, home: HOME, uid: 501,
    readFile: p => { calls.read.push(p); if (!(p in fs)) throw new Error(`ENOENT ${p}`); return Buffer.from(fs[p]); },
    exists: p => p in fs || p in stats,
    stat: p => { if (p in stats) return stats[p]; if (p in fs) return stat(); throw new Error(`ENOENT ${p}`); },
    exec: (cmd, args) => {
      calls.exec.push([cmd, ...args]);
      const k = `${path.basename(cmd)} ${args.join(' ')}`;
      return execs[cmd] ?? execs[k] ?? { status: 127, stdout: '', stderr: 'not found' };
    },
    http: async (url, opts) => { calls.http.push({ url, ...opts }); if (!http) throw new Error('no network in this test'); return http(url, opts); },
    tcpOpen: async (h, p) => { calls.tcp.push(`${h}:${p}`); return open.has(p); },
    sleep: async ms => { t += ms; },
    now: () => t,
  };
}
const byId = (rs, id) => rs.find(x => x.id === id);

// ------------------------------------------------------------------ the read-only rules

test('exec allow-list: only --version, rustup toolchain list and the build script with --twice', () => {
  assert.ok(execAllowed('/x/solana', ['--version']));
  assert.ok(execAllowed('/x/cargo-build-sbf', ['--version']));
  assert.ok(execAllowed('rustup', ['toolchain', 'list']));
  assert.ok(execAllowed('/r/scripts/b.sh', ['--twice'], { buildScript: '/r/scripts/b.sh' }));
  for (const [c, a] of [['solana', ['program', 'deploy', 'x.so']], ['solana', ['address', '-k', 'k.json']], ['solana', ['balance']], ['solana', ['airdrop', '5']],
    ['solana', ['transfer']], ['solana', ['program', 'write-buffer', 'x.so']], ['/r/scripts/b.sh', []], ['/other.sh', ['--twice']], ['sh', ['-c', 'solana --version']]]) {
    assert.equal(execAllowed(c, a, { buildScript: '/r/scripts/b.sh' }), false, `${c} ${a.join(' ')}`);
  }
});

test('send flags are refused outright (the preflight is not the deploy)', () => {
  for (const f of ['--i-have-r0ze-approval', '--keypair', '--program-keypair', '--upgrade-authority', '--approved-sha256', '--yes-send']) {
    assert.throws(() => parsePreflightArgs([f, 'x']), /never sends/);
  }
  assert.throws(() => parsePreflightArgs(['--rate', 'abc']), /positive integer/);
  assert.throws(() => parsePreflightArgs(['--bogus']), /unknown/);
  assert.deepEqual(parsePreflightArgs(['--rpc', 'https://api.devnet.solana.com', '--build']), { rpc: 'https://api.devnet.solana.com', build: true });
});

test('a default run makes no network call, reads no key file and starts only allow-listed processes', async () => {
  const keys = `${HOME}/wylls-devnet-keys`;
  const io = fakeIo({
    files: { [SO_PATH]: fakeSo() },
    stats: { [`${keys}/deployer.json`]: stat(), [`${keys}/program-playable.json`]: stat(), [`${keys}/authority.json`]: stat(), [keys]: stat({ mode: 0o40700, file: false }) },
  });
  const res = await preflight([], io);
  assert.equal(io.calls.http.length, 0);
  assert.equal(io.calls.tcp.length, 0);
  assert.ok(!io.calls.read.some(p => p.includes('wylls-devnet-keys')), 'key files are stat()ed, never read');
  for (const [c, ...a] of io.calls.exec) assert.ok(execAllowed(c, a), `${c} ${a.join(' ')}`);
  assert.equal(byId(res.results, 'rpc').status, 'SKIP');
  assert.equal(byId(res.results, 'endpoint').status, 'SKIP');
  assert.equal(res.exitCode, 1); // the committed profile still has placeholders
});

// ------------------------------------------------------------------ MUST 3 toolchain

const goodExecs = {
  [`solana --version`]: { status: 0, stdout: 'solana-cli 3.1.9 (src:765ee54a; feat:1620780344, client:Agave)\n' },
  'cargo-build-sbf --version': { status: 0, stdout: 'solana-cargo-build-sbf 3.1.9\nplatform-tools v1.52\n' },
  'node --version': { status: 0, stdout: 'v20.19.0\n' },
  'cargo --version': { status: 0, stdout: 'cargo 1.89.0 (c24e10642 2025-06-23)\n' },
  'rustup toolchain list': { status: 0, stdout: '1.89.0-aarch64-apple-darwin\n1.95.0-aarch64-apple-darwin (default)\n' },
};
const S4 = `${HOME}/solana-4x/bin/solana`;
const REL = `${HOME}/.local/share/solana/install/active_release/bin`;

test('toolchain: 4.x CLI beside 3.1.9, node, cargo + toolchains → PASS', () => {
  const io = fakeIo({ stats: { [S4]: stat(), [`${REL}/cargo-build-sbf`]: stat() }, execs: { ...goodExecs, [S4]: { status: 0, stdout: 'solana-cli 4.4.1 (src:5bb30402; feat:9fd5a0b5, client:Agave)\n' } } });
  const rs = checkToolchain(io, {});
  assert.deepEqual(rs.map(x => x.status), ['PASS', 'PASS', 'PASS', 'PASS'], JSON.stringify(rs));
  assert.match(byId(rs, 'tool.solana4').detail, /4\.4\.1/);
});

test('toolchain: missing / too-old 4.x CLI, wrong build tool, old node, missing toolchain → FAIL each', () => {
  let rs = checkToolchain(fakeIo({ stats: { [`${REL}/cargo-build-sbf`]: stat() }, execs: goodExecs }), {});
  assert.equal(byId(rs, 'tool.solana4').status, 'FAIL');
  assert.match(byId(rs, 'tool.solana4').fix, /4\.0\.0/);
  rs = checkToolchain(fakeIo({ stats: { [S4]: stat(), [`${REL}/cargo-build-sbf`]: stat() }, execs: { ...goodExecs, [S4]: { status: 0, stdout: 'solana-cli 3.1.9 (src:x)\n' } } }), {});
  assert.equal(byId(rs, 'tool.solana4').status, 'FAIL');
  assert.match(byId(rs, 'tool.solana4').detail, /< 4\.0\.0/);
  rs = checkToolchain(fakeIo({ stats: { [S4]: stat(), [`${REL}/cargo-build-sbf`]: stat() }, execs: { ...goodExecs, [S4]: { status: 0, stdout: 'solana-cli 4.0.0\n' },
    'cargo-build-sbf --version': { status: 0, stdout: 'solana-cargo-build-sbf 4.4.1\nplatform-tools v1.53\n' }, 'node --version': { status: 0, stdout: 'v18.20.0\n' },
    'rustup toolchain list': { status: 0, stdout: '1.89.0-aarch64-apple-darwin\n' } } }), {});
  assert.equal(byId(rs, 'tool.solana4').status, 'PASS');
  assert.equal(byId(rs, 'tool.build-sbf').status, 'FAIL');
  assert.equal(byId(rs, 'tool.node').status, 'FAIL');
  assert.equal(byId(rs, 'tool.cargo').status, 'FAIL');
  assert.match(byId(rs, 'tool.cargo').detail, /1\.95\.0/);
});

// ------------------------------------------------------------------ MUST 4 profile and keys

test('profile: committed file has the right shape but placeholders → shape PASS, keys FAIL; filled → PASS', () => {
  // (the committed playable profile is filled since devnet-deploy-1; the placeholder case is its unfilled form)
  let rs = checkProfile({ ...profile(), programId: '<SET-BY-R0ZE: program>', upgradeAuthority: '<SET-BY-R0ZE: authority>' });
  assert.equal(byId(rs, 'profile.shape').status, 'PASS');
  assert.equal(byId(rs, 'profile.keys').status, 'FAIL');
  assert.match(byId(rs, 'profile.keys').detail, /programId is still a placeholder; upgradeAuthority is still a placeholder/);
  rs = checkProfile(filled());
  assert.deepEqual(rs.map(x => x.status), ['PASS', 'PASS']);
  assert.deepEqual(checkProfile(profile()).map(x => x.status), ['PASS', 'PASS']);
});

test('profile: wrong cluster, lane, roles, rings duty, same address twice, bad base58 → FAIL', () => {
  const p = filled();
  p.cluster = 'mainnet-beta'; p.lane = 's1'; p.services.keeperA.roles = p.services.keeperA.roles.filter(x => x !== 'wide-resolve'); p.services.keeperA.ringsDuty.wide_rings = 4;
  p.season.preset = 'S1_LOCAL_7D';
  let rs = checkProfile(p);
  const d = byId(rs, 'profile.shape').detail;
  for (const s of ['cluster mainnet-beta', 'lane s1', 'missing wide-resolve', 'wide_rings = 4', 'season.preset S1_LOCAL_7D']) assert.ok(d.includes(s), `${s} in ${d}`);
  // devnet-continuous-1: both playable presets pass the shape
  for (const preset of ['S1_DEVNET_WIDE_CONTINUOUS', 'S1_DEVNET_WIDE_7D']) {
    const q = filled(); q.season.preset = preset;
    assert.equal(byId(checkProfile(q), 'profile.shape').status, 'PASS', preset);
  }
  // devnet-new-world-plan: the new world's preset needs a neutral keep holder; unknown / OrbitBalanced are refused
  // devnet-territory-dev (verify-pr221): that world's keeper A also runs `territory` (keeperRolesFor)
  const t = filled(); t.season.preset = 'S1_DEVNET_TERRITORY'; t.services.keeperA.roles = [...t.services.keeperA.roles, 'territory'];
  assert.match(byId(checkProfile(t), 'profile.shape').detail, /S1_DEVNET_TERRITORY needs Neutral or NeutralTerritoryV1/);
  for (const k of ['Neutral', 'NeutralTerritoryV1']) {
    t.wide = { keepHolder: k };
    const r = byId(checkProfile(t), 'profile.shape');
    assert.equal(r.status, 'PASS', `${k}: ${r.detail}`);
    assert.match(r.detail, new RegExp(`keep holder ${k}`));
  }
  t.wide = { keepHolder: 'MixedInterleaved' };
  assert.equal(byId(checkProfile(t), 'profile.shape').status, 'FAIL');
  const w = filled(); w.wide = { keepHolder: 'neutral' };
  assert.match(byId(checkProfile(w), 'profile.shape').detail, /wide\.keepHolder neutral/);
  w.wide = { keepHolder: 'OrbitBalanced' };
  assert.match(byId(checkProfile(w), 'profile.shape').detail, /placement 2 refuses it/);
  w.wide = { keepHolder: 'NeutralTerritoryV1' }; // a reused Season 2 (Q-NWP-1 b) would keep its preset with neutral land
  assert.equal(byId(checkProfile(w), 'profile.shape').status, 'PASS');
  rs = checkProfile({ ...filled(), upgradeAuthority: PROGRAM });
  assert.match(byId(rs, 'profile.keys').detail, /same address/);
  rs = checkProfile({ ...filled(), programId: 'not-base58-0OIl' });
  assert.match(byId(rs, 'profile.keys').detail, /not a 32-byte base58/);
});

test('key files: present, 600, owned, outside the repo → PASS (stat only); missing / 644 / in repo / same path → FAIL', () => {
  const k = `${HOME}/wylls-devnet-keys`;
  const good = { [`${k}/deployer.json`]: stat(), [`${k}/program-playable.json`]: stat(), [`${k}/authority.json`]: stat(), [k]: stat({ mode: 0o40700, file: false }) };
  let io = fakeIo({ stats: good });
  let rs = checkKeyFiles(io, {});
  assert.deepEqual(rs.map(x => x.status), ['PASS']);
  assert.equal(io.calls.read.length, 0);
  io = fakeIo({ stats: { ...good, [`${k}/authority.json`]: stat({ mode: 0o100644 }), [`${k}/deployer.json`]: stat({ uid: 0 }), [k]: stat({ mode: 0o40755, file: false }) } });
  rs = checkKeyFiles(io, { programKey: `${REPO}/keys/p.json` });
  const d = byId(rs, 'keys.files').detail;
  assert.match(d, /authority .*mode 644/);
  assert.match(d, /deployer .*not owned/);
  assert.match(d, /program-playable .*not found/);
  assert.equal(byId(rs, 'keys.dir').status, 'WARN');
  io = fakeIo({ stats: { ...good, [`${REPO}/k.json`]: stat() } });
  rs = checkKeyFiles(io, { programKey: `${REPO}/k.json`, authorityKey: `${REPO}/k.json` });
  assert.match(byId(rs, 'keys.files').detail, /inside the repository.*three different files/);
});

// ------------------------------------------------------------------ MUST 6 artefact

test('artefact: checks pass but sha differs from the approved one → so.sha256 FAIL; matching expect → PASS', () => {
  const so = fakeSo();
  const io = fakeIo({ files: { [SO_PATH]: so } });
  let { results } = checkArtefact(io, profile(), {});
  assert.equal(byId(results, 'so.checks').status, 'PASS');
  assert.equal(byId(results, 'so.sha256').status, 'FAIL');
  assert.match(byId(results, 'so.sha256').detail, new RegExp(EXPECTED_ARTEFACT.sha256));
  assert.equal(byId(results, 'so.size').status, 'PASS');
  assert.equal(byId(results, 'so.build').status, 'SKIP');
  const { createHash } = cryptoMod;
  const sha = createHash('sha256').update(so).digest('hex');
  let n = so.length; while (n && so[n - 1] === 0) n--;
  const ph = createHash('sha256').update(so.subarray(0, n)).digest('hex');
  ({ results } = checkArtefact(io, profile(), { expectSha256: sha, expectProgramHash: ph }));
  assert.equal(byId(results, 'so.sha256').status, 'PASS');
  assert.equal(byId(results, 'so.program_hash').status, 'PASS');
  ({ results } = checkArtefact(io, { ...profile(), program: { ...profile().program, expectedSha256: sha } }, {}));
  assert.equal(byId(results, 'so.sha256').status, 'PASS', 'the profile may name another approved artefact');
});

test('artefact: wrong build (localnet marker, no playable marker, SBPF v1, over cap), missing file → FAIL', () => {
  let io = fakeIo({ files: { [SO_PATH]: fakeSo({ marker: null, extra: 'PSF_LOCALNET_CONQUEST_SBF_BUILD', flags: 1 }) } });
  let { results } = checkArtefact(io, profile(), {});
  const d = byId(results, 'so.checks').detail;
  for (const s of ['e_flags 1', 'PSF_LOCALNET_CONQUEST_SBF_BUILD', 'PSF_DEVNET_PLAYABLE_BUILD missing']) assert.ok(d.includes(s), d);
  const p = profile(); p.program.soLenCap = 4096;
  ({ results } = checkArtefact(fakeIo({ files: { [SO_PATH]: fakeSo() } }), p, {}));
  assert.equal(byId(results, 'so.size').status, 'FAIL');
  ({ results } = checkArtefact(fakeIo(), profile(), {}));
  assert.equal(byId(results, 'so.checks').status, 'FAIL');
  assert.match(byId(results, 'so.checks').fix, /--twice/);
});

test('artefact --build: runs only the profile build script with --twice; a failing build → so.build FAIL', () => {
  const script = `${REPO}/scripts/build-frontier-devnet-playable-sbf.sh`;
  let io = fakeIo({ files: { [SO_PATH]: fakeSo() }, execs: { [script]: { status: 0, stdout: `twice          ${'ab'.repeat(32)} (both builds)\n` } } });
  let { results } = checkArtefact(io, profile(), { build: true });
  assert.equal(byId(results, 'so.build').status, 'PASS');
  assert.deepEqual(io.calls.exec, [[script, '--twice']]);
  io = fakeIo({ files: { [SO_PATH]: fakeSo() }, execs: { [script]: { status: 4, stdout: '' } } });
  ({ results } = checkArtefact(io, profile(), { build: true }));
  assert.equal(byId(results, 'so.build').status, 'FAIL');
});

// ------------------------------------------------------------------ MUST 2/5 planner

test('planner: 5,080 and a measured 6,960 → totals from plan.mjs; the planner neither writes nor starts anything', () => {
  const io = fakeIo({ files: { [SO_PATH]: fakeSo({ len: 3_447_064 }) } });
  const rs = checkPlanner(io, profile(), { profilePath: PROFILE_PATH, soPath: SO_PATH, rates: [{ rate: 5080, why: 'profile' }, { rate: 6960, why: 'measured' }] });
  assert.deepEqual(rs.map(x => x.status), ['PASS', 'PASS']);
  // The same .so length as the approved build: the runbook §4a totals (120.15 / 136.28 SOL).
  assert.match(byId(rs, 'plan.5080').detail, /deploy peak 21\.93 \+ season 98\.21 = 120\.15 SOL; faucet 5-SOL requests: 5 for the deploy, 25 with one season/);
  assert.match(byId(rs, 'plan.6960').detail, /deploy peak 30\.03 \+ season 106\.24 = 136\.28 SOL; faucet 5-SOL requests: 7 for the deploy, 28 with one season/);
  assert.equal(io.calls.exec.length, 0);
});

test('planner: a rate outside the SIMD-0437 steps, or no .so → FAIL', () => {
  const io = fakeIo({ files: { [SO_PATH]: fakeSo() } });
  let rs = checkPlanner(io, profile(), { profilePath: PROFILE_PATH, soPath: SO_PATH, rates: [{ rate: 4000, why: '--rate' }] });
  assert.equal(rs[0].status, 'FAIL');
  rs = checkPlanner(io, profile(), { profilePath: PROFILE_PATH, soPath: null, rates: [{ rate: 5080, why: 'x' }] });
  assert.equal(rs[0].status, 'FAIL');
});

// ------------------------------------------------------------------ MUST 2 RPC (only with --rpc)

function rpcAnswers({ genesis = DEVNET_GENESIS, rate = 5080, bls = true, sbpf = true, simd0500 = false, program = null, balance = 60e9 } = {}) {
  const feat = on => (on ? { data: [Buffer.concat([Buffer.from([1]), Buffer.alloc(8, 0)]).toString('base64'), 'base64'], owner: 'Feature111111111111111111111111111111111111' } : null);
  return (url, opts) => {
    const { method, params } = JSON.parse(opts.body);
    const result = {
      getGenesisHash: genesis,
      getVersion: { 'solana-core': '4.5.0-beta.0', 'feature-set': 1 },
      getMinimumBalanceForRentExemption: (128 + params?.[0]) * rate,
      getMultipleAccounts: { value: [feat(bls), feat(sbpf), feat(simd0500), program] },
      getBalance: { value: balance },
    }[method];
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
  };
}

test('rpc: OFF by default (SKIP, no call)', async () => {
  const io = fakeIo({ http: rpcAnswers() });
  const { results } = await checkRpc(io, filled(), {});
  assert.equal(results[0].status, 'SKIP');
  assert.equal(io.calls.http.length, 0);
});

test('rpc: devnet answers → PASS lines; read methods only, within budget, spaced', async () => {
  const io = fakeIo({ http: rpcAnswers() });
  const { results, rate, rpcLog } = await checkRpc(io, filled(), { rpc: 'https://api.devnet.solana.com' });
  assert.equal(rate, 5080);
  for (const id of ['rpc.genesis', 'rpc.version', 'rpc.rent', 'rpc.features', 'rpc.program', 'rpc.funds']) assert.equal(byId(results, id).status, 'PASS', id);
  assert.ok(rpcLog.every(m => RPC_METHODS.includes(m)));
  assert.ok(rpcLog.length <= RPC_BUDGET);
  for (const c of io.calls.http) assert.ok(!/sendTransaction|requestAirdrop|simulateTransaction/.test(c.body));
});

test('rpc: wrong genesis stops after one call; rent 6,960 → WARN with the measured rate; features off / SIMD-0500 on → FAIL', async () => {
  let io = fakeIo({ http: rpcAnswers({ genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }) });
  let r = await checkRpc(io, filled(), { rpc: 'https://api.devnet.solana.com' });
  assert.equal(byId(r.results, 'rpc.genesis').status, 'FAIL');
  assert.equal(io.calls.http.length, 1);
  io = fakeIo({ http: rpcAnswers({ rate: 6960, bls: false, simd0500: true, program: { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true }, balance: 1e9 }) });
  r = await checkRpc(io, filled(), { rpc: 'https://api.devnet.solana.com' });
  assert.equal(r.rate, 6960);
  assert.equal(byId(r.results, 'rpc.rent').status, 'WARN');
  assert.equal(byId(r.results, 'rpc.features').status, 'FAIL');
  assert.match(byId(r.results, 'rpc.features').detail, /BLS12-381.*inactive.*SIMD-0500.*ACTIVE/);
  assert.equal(byId(r.results, 'rpc.program').status, 'WARN');
  assert.equal(byId(r.results, 'rpc.funds').status, 'WARN');
  io = fakeIo({ http: rpcAnswers({ rate: 4321 }) });
  r = await checkRpc(io, filled(), { rpc: 'https://api.devnet.solana.com' });
  assert.equal(byId(r.results, 'rpc.rent').status, 'FAIL');
});

test('rpc: mainnet / testnet / plain http (non-loopback) refused before any call; --expect-genesis loopback only', async () => {
  for (const u of ['https://api.mainnet-beta.solana.com', 'https://api.testnet.solana.com', 'https://api.solana.com', 'http://rpc.example.com', 'https://u:p@devnet.example.com']) {
    assert.ok(rpcUrlProblem(u, profile()), u);
    const io = fakeIo({ http: rpcAnswers() });
    const { results } = await checkRpc(io, filled(), { rpc: u });
    assert.equal(results[0].status, 'FAIL', u);
    assert.equal(io.calls.http.length, 0, u);
  }
  assert.equal(rpcUrlProblem('https://api.devnet.solana.com', profile()), null);
  assert.equal(rpcUrlProblem('https://devnet.helius-rpc.com/?api-key=x', profile()), null);
  assert.equal(rpcUrlProblem('http://127.0.0.1:41850', profile(), { expectGenesis: 'x' }), null);
  assert.ok(rpcUrlProblem('https://api.devnet.solana.com', profile(), { expectGenesis: 'x' }));
});

test('rpc: provider keys never printed; featureState decodes Option<u64>', async () => {
  assert.equal(redactUrl('https://devnet.helius-rpc.com/v1/abc?api-key=SECRET'), 'https://devnet.helius-rpc.com/…');
  const io = fakeIo({ http: () => { throw new Error('connect ECONNREFUSED https://devnet.example.com/?api-key=SECRET'); } });
  const { results } = await checkRpc(io, filled(), { rpc: 'https://devnet.example.com/?api-key=SECRET' });
  assert.ok(!JSON.stringify(results).includes('SECRET'), JSON.stringify(results));
  assert.deepEqual(featureState(null), { active: false, why: 'no account' });
  const d = Buffer.alloc(9); d[0] = 1; d.writeBigUInt64LE(457488000n, 1);
  assert.deepEqual(featureState({ data: [d.toString('base64'), 'base64'] }), { active: true, slot: 457488000 });
  assert.equal(Object.keys(FEATURES).length, 3);
});

// ------------------------------------------------------------------ MUST 7/7b endpoint

const GAME_HTML = '<!doctype html><html><head><title>WYLLS Frontier</title></head><body><script type="module" src="./app.mjs"></script> frontier</body></html>';
/** A proxy + herald + gateway stand-in: `xff` = 'replace' (right), 'pass' (client header), plus switches. */
function endpoint({ xff = 'replace', hsts = true, cluster = 'devnet', game = GAME_HTML, rootRedirect = true } = {}) {
  const buckets = new Map();
  return (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/h/season') return { status: 200, headers: hsts ? { 'strict-transport-security': 'max-age=31536000' } : {}, body: JSON.stringify({ cluster, programId: PROGRAM, rulesetHash: 'ab'.repeat(32) }) };
    if (u.pathname === '/frontier/frontier/') return { status: 200, headers: {}, body: game };
    if (u.pathname === '/') return rootRedirect ? { status: 302, headers: { location: '/frontier/frontier/' }, body: '' } : { status: 200, headers: {}, body: '<html>lobby /api/x</html>' };
    if (u.pathname === '/gw/f/nudge') {
      const client = xff === 'replace' ? '198.51.100.7' : opts.headers['x-forwarded-for'];
      const n = (buckets.get(client) ?? 0) + 1; buckets.set(client, n);
      return { status: n > 10 ? 429 : 400, headers: {}, body: '{}' };
    }
    return { status: 404, headers: {}, body: '' };
  };
}

test('endpoint: right proxy → TLS, HSTS, season, game, root, XFF (10 × 400 then 5 × 429), closed ports PASS', async () => {
  const io = fakeIo({ http: endpoint() });
  const rs = await checkEndpoint(io, filled(), { publicUrl: 'https://play.example.org' });
  for (const id of ['ep.tls', 'ep.hsts', 'ep.season', 'ep.game', 'ep.root', 'ep.xff', 'ep.ports']) assert.equal(byId(rs, id)?.status, 'PASS', `${id}: ${JSON.stringify(byId(rs, id))}`);
  assert.match(byId(rs, 'ep.xff').detail, /400 400 400 400 400 400 400 400 400 400 429 429 429 429 429/);
  const nudges = io.calls.http.filter(c => c.url.endsWith('/gw/f/nudge'));
  assert.equal(nudges.length, 15);
  assert.ok(nudges.every(c => c.body === '{}' && c.headers['x-forwarded-for']), 'empty body, forged header each');
  assert.equal(io.calls.tcp.length, 4);
});

test('endpoint: proxy passing the client header → ep.xff FAIL; http → ep.tls FAIL; open port, wrong cluster, no game → FAIL', async () => {
  let rs = await checkEndpoint(fakeIo({ http: endpoint({ xff: 'pass' }) }), filled(), { publicUrl: 'https://play.example.org' });
  assert.equal(byId(rs, 'ep.xff').status, 'FAIL');
  assert.match(byId(rs, 'ep.xff').detail, /no 429/);
  assert.match(byId(rs, 'ep.xff').fix, /\$remote_addr/);
  rs = await checkEndpoint(fakeIo({ http: endpoint({ hsts: false, cluster: 'localnet', game: '<html>lobby fetch("/api/state")</html>', rootRedirect: false }), open: new Set([41040]) }), filled(), { publicUrl: 'http://play.example.org' });
  assert.equal(byId(rs, 'ep.tls').status, 'FAIL');
  assert.equal(byId(rs, 'ep.season').status, 'FAIL');
  assert.equal(byId(rs, 'ep.game').status, 'FAIL');
  assert.equal(byId(rs, 'ep.root').status, 'WARN');
  assert.equal(byId(rs, 'ep.ports').status, 'FAIL');
  assert.match(byId(rs, 'ep.ports').detail, /41040/);
  rs = await checkEndpoint(fakeIo({ http: () => { throw new Error('self-signed certificate'); } }), filled(), { publicUrl: 'https://play.example.org' });
  assert.equal(byId(rs, 'ep.tls').status, 'FAIL');
  assert.match(byId(rs, 'ep.tls').detail, /self-signed/);
});

test('endpoint: no --public-url → SKIP, no call; loopback host skips the port probe', async () => {
  let io = fakeIo({ http: endpoint() });
  let rs = await checkEndpoint(io, filled(), {});
  assert.equal(rs[0].status, 'SKIP');
  assert.equal(io.calls.http.length, 0);
  io = fakeIo({ http: endpoint() });
  rs = await checkEndpoint(io, filled(), { publicUrl: 'https://localhost:41880' });
  assert.equal(byId(rs, 'ep.ports').status, 'SKIP');
  assert.equal(io.calls.tcp.length, 0);
});

// ------------------------------------------------------------------ MUST 7b service configs

const SERVICES = `#!/bin/sh
# deploy-day services (runbook §8 steps 5-7)
frontier-node/target/release/frontier-keeper --config keeper-a/keeper.toml
frontier-node/target/release/frontier-herald --data herald/ --program ${PROGRAM} --season 2 \\
  --rpc $RPC --source rpc --cluster devnet --rpc-min-gap-ms 100 --poll-ms 1000 \\
  --listen 127.0.0.1:41040 --web permutation-server/web --relay 127.0.0.1:41033 \\
  --public-host play.example.org
FRONTIER_OPERATOR_TOKEN=very-secret-token node permutation-gateway/src/frontier/server.mjs \\
  --cluster devnet --rpc $RPC --program ${PROGRAM} --season 2 \\
  --port 41030 --public-port 41033 \\
  --herald http://127.0.0.1:41040 \\
  --keeper http://127.0.0.1:41050 --keeper-token-file keeper-a/keeper.token \\
  --pool-size 150 --master-seed-file relay/relay-master.seed \\
  --invite-secret-file relay/invite.secret --state-file relay/relay-state.json \\
  --devnet-play --devnet-play-ruleset-hash ${'ab'.repeat(32)} \\
  --public-proxy xff        # required off localnet without --dev
`;
const KEEPER = `program = "${PROGRAM}"
season = 2
rpc = ["https://api.devnet.solana.com"]
feed = "rpc"
drand = ["https://api.drand.sh", "https://drand.cloudflare.com"]
roles = ["beacon", "archive", "rings", "fold", "tickets", "wide-tickets", "reveal", "settle-departure", "gather", "resolve", "skip", "settle", "close", "claims", "expeditions", "wide-resolve"]
reveal_pool = 150
delay_pool = 32
funders = 4
r99_reveals = 150
beneficiary = "${AUTHORITY}"
api = "127.0.0.1:41050"
token_file = "keeper-a/keeper.token"
master_seed_file = "keeper-a/keeper.seed"
journal = "keeper-a/keeper.journal.sqlite"
extend = true
extend_max_ring = 128
lazy_provinces = true
rim_per_wedge = 6
provinces_reach = 3
# provinces_per_pass = 12, provinces_max = 600
wide_rings = 3
wide_per_wedge = 6
rpc_min_gap_ms = 250
`;
const svcIo = (services = SERVICES, keeper = KEEPER, extraStats = {}) => fakeIo({
  files: { '/ops/services.sh': services, [`${REPO}/keeper-a/keeper.toml`]: keeper },
  stats: { [`${REPO}/keeper-a/keeper.token`]: stat(), [`${REPO}/keeper-a/keeper.seed`]: stat(), ...extraStats },
});

test('shell parsing: continuations, comments, env names, node script', () => {
  const cmds = shellCommands('A=1 B="x y" node s.mjs --a 1 \\\n --b # c\nfoo --c \'q r\'; bar && baz');
  assert.deepEqual(cmds, [['A=1', 'B=x y', 'node', 's.mjs', '--a', '1', '--b'], ['foo', '--c', 'q r'], ['bar'], ['baz']]);
  assert.deepEqual(shellCommands('T=$(cat a/b) node x.mjs --k "$(echo (1))"'), [['T=$(cat a/b)', 'node', 'x.mjs', '--k', '$(echo (1))']]);
  const s = findServices(SERVICES);
  assert.deepEqual(s.gateway.env, ['FRONTIER_OPERATOR_TOKEN']);
  assert.equal(s.herald.flags.get('poll-ms'), '1000');
  assert.equal(s.gateway.flags.get('devnet-play'), true);
  assert.equal(s.keeper.flags.get('config'), 'keeper-a/keeper.toml');
});

test('services: runbook §8 lines + keeper.toml → herald, gateway, keeper PASS; token value never printed; secrets stat only', async () => {
  const io = svcIo();
  const rs = await checkServices(io, filled(), { services: '/ops/services.sh' });
  for (const id of ['cfg.herald', 'cfg.gateway', 'cfg.gateway.env', 'cfg.keeper']) assert.equal(byId(rs, id)?.status, 'PASS', `${id}: ${JSON.stringify(byId(rs, id))}`);
  assert.ok(!formatResults(rs).includes('very-secret-token'));
  assert.ok(!io.calls.read.some(p => /keeper\.(token|seed)$/.test(p)));
});

test('services: --dev, no --public-proxy, wrong herald flags, keeper gap / roles / --dev → FAIL with the reason', async () => {
  const bad = SERVICES.replace('--public-proxy xff', '--dev').replace('--poll-ms 1000', '--poll-ms 200').replace('--listen 127.0.0.1:41040', '--listen 0.0.0.0:41040 --test-key')
    .replace('--config keeper-a/keeper.toml', '--config keeper-a/keeper.toml --dev');
  const badKeeper = KEEPER.replace('rpc_min_gap_ms = 250\n', '').replace(', "wide-resolve"', '').replace('wide_rings = 3', 'wide_rings = 2');
  const rs = await checkServices(svcIo(bad, badKeeper, { [`${REPO}/keeper-a/keeper.seed`]: stat({ mode: 0o100644 }) }), filled(), { services: '/ops/services.sh' });
  const h = byId(rs, 'cfg.herald'), g = byId(rs, 'cfg.gateway'), k = byId(rs, 'cfg.keeper'), kc = byId(rs, 'cfg.keeper.cmd');
  assert.equal(h.status, 'FAIL'); assert.match(h.detail, /--poll-ms 200/); assert.match(h.detail, /--listen 0\.0\.0\.0:41040/); assert.match(h.detail, /--test-key/);
  assert.equal(g.status, 'FAIL'); assert.match(g.detail, /--public-proxy \(missing\)/); assert.match(g.detail, /--dev must not be set/);
  assert.equal(k.status, 'FAIL'); assert.match(k.detail, /rpc_min_gap_ms missing/); assert.match(k.detail, /missing wide-resolve/); assert.match(k.detail, /wide_rings = 2/); assert.match(k.detail, /keeper\.seed mode 644/);
  assert.equal(kc.status, 'FAIL');
});

test('services: the gateway\'s own config check is consulted (and its message redacts the RPC key)', async () => {
  const svc = SERVICES.replace(/--rpc \$RPC --program/, '--rpc https://devnet.example.com/?api-key=SECRET --program');
  let seen = null;
  const gatewayConfig = argv => { seen = argv; throw new Error('frontier relay config: --rpc https://devnet.example.com/?api-key=SECRET: something'); };
  const rs = await checkGatewayCmd(findServices(svc).gateway, filled(), { gatewayConfig });
  assert.equal(rs[0].status, 'FAIL');
  assert.ok(!JSON.stringify(rs).includes('SECRET'));
  assert.ok(seen.includes('--public-proxy') && seen.includes('xff'));
});

test('herald / keeper: placeholders (<PROGRAM_ID>) and missing lines → FAIL; no inputs → SKIP', async () => {
  const s = findServices(SERVICES.replaceAll(PROGRAM, '<PROGRAM_ID>'));
  assert.match(checkHeraldCmd(s.herald, filled()).detail, /fill the program id/);
  assert.equal(checkHeraldCmd(undefined, filled()).status, 'FAIL');
  assert.equal((await checkGatewayCmd(undefined, filled()))[0].status, 'FAIL');
  assert.equal((await checkServices(fakeIo(), filled(), {}))[0].status, 'SKIP');
  assert.equal(checkKeeperConfig(fakeIo(), filled(), {})[0].status, 'SKIP');
  assert.throws(() => parseKeeperToml('a = 1\na = 2'), /twice/);
  assert.deepEqual(parseKeeperToml('x = ["a", "b"] # c\ny = 1_000\nz = true'), { x: ['a', 'b'], y: 1000, z: true });
});

// ------------------------------------------------------------------ the whole run

test('whole run: everything ready → exit 0, one line per item in MUST order', async () => {
  const k = `${HOME}/keys`;
  const so = fakeSo({ len: 3_447_064 });
  const sha = cryptoMod.createHash('sha256').update(so).digest('hex');
  let n = so.length; while (n && so[n - 1] === 0) n--;
  const ph = cryptoMod.createHash('sha256').update(so.subarray(0, n)).digest('hex');
  const prof = { ...filled(), program: { ...profile().program, expectedSha256: sha, expectedProgramHash: ph } };
  const io = fakeIo({
    files: { [PROFILE_PATH]: JSON.stringify(prof), [SO_PATH]: so, '/ops/services.sh': SERVICES, [`${REPO}/keeper-a/keeper.toml`]: KEEPER },
    stats: { [S4]: stat(), [`${REL}/cargo-build-sbf`]: stat(), [`${k}/deployer.json`]: stat(), [`${k}/program-playable.json`]: stat(), [`${k}/authority.json`]: stat(), [k]: stat({ mode: 0o40700, file: false }),
      [`${REPO}/keeper-a/keeper.token`]: stat(), [`${REPO}/keeper-a/keeper.seed`]: stat() },
    execs: { ...goodExecs, [S4]: { status: 0, stdout: 'solana-cli 4.4.1\n' } },
    http: (() => { const rpc = rpcAnswers(), ep = endpoint(); return (url, opts) => (url.includes('api.devnet') ? rpc : ep)(url, opts); })(),
  });
  const res = await preflight(['--keys-dir', k, '--services', '/ops/services.sh', '--public-url', 'https://play.example.org', '--rpc', 'https://api.devnet.solana.com', '--deployer-address', AUTHORITY], io);
  const fails = res.results.filter(x => x.status === 'FAIL');
  assert.deepEqual(fails, []);
  assert.equal(res.exitCode, 0);
  const order = res.results.map(x => x.must.split('/')[0]);
  assert.equal(order[0], '1');
  assert.equal(res.results.at(-1).id, 'witness');
  const text = formatResults(res.results);
  assert.match(text, /0 FAIL/);
  assert.ok(text.split('\n').filter(l => /^(PASS|FAIL|WARN|SKIP) /.test(l)).length === res.results.length);
});

test('whole run: bad arguments → exit 2; --help → usage', async () => {
  assert.equal((await preflight(['--keypair', '/k'], fakeIo())).exitCode, 2);
  assert.equal((await preflight(['--profile', '/nope.json'], fakeIo())).exitCode, 2);
  const h = await preflight(['--help'], fakeIo());
  assert.equal(h.exitCode, 0);
  assert.match(h.help, /never sends/);
});

test('endpoint: a herald with no season yet answers NoSeasonYet → ep.season WARN (not FAIL)', async () => {
  const ep = endpoint();
  const io = fakeIo({ http: (url, opts) => (url.endsWith('/h/season') ? { status: 503, headers: {}, body: '{"code":"NoSeasonYet","ok":false}' } : ep(url, opts)) });
  const rs = await checkEndpoint(io, filled(), { publicUrl: 'https://play.example.org' });
  assert.equal(byId(rs, 'ep.season').status, 'WARN');
  assert.equal(byId(rs, 'ep.tls').status, 'PASS');
});

// ------------------------------------------------------------------ verify-pr181 fixes

test('verify-pr181: --solana4 / --node-bin not named solana / node → a FAIL line, never an uncaught allow-list refusal', () => {
  const io = fakeIo({ stats: { '/t/solana-4.4.1': stat({ mode: 0o100755 }) } });
  let rs;
  assert.doesNotThrow(() => { rs = checkToolchain(io, { solana4: '/t/solana-4.4.1', nodeBin: '/t/nodejs' }); });
  assert.equal(byId(rs, 'tool.solana4').status, 'FAIL');
  assert.match(byId(rs, 'tool.solana4').detail, /not a bin\/solana/);
  assert.equal(byId(rs, 'tool.node').status, 'FAIL');
  assert.ok(!io.calls.exec.some(([c]) => c.startsWith('/t/')), 'neither file was started');
});

test('verify-pr181: an empty-message AggregateError (ECONNREFUSED to localhost) still prints a reason', async () => {
  const agg = new AggregateError([Object.assign(new Error('connect ECONNREFUSED ::1:41899'), { code: 'ECONNREFUSED' }), Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:41899'), { code: 'ECONNREFUSED' })], '');
  assert.equal(agg.message, '');
  assert.match(errText(agg), /ECONNREFUSED ::1:41899; connect ECONNREFUSED 127\.0\.0\.1:41899/);
  assert.equal(errText(Object.assign(new Error(''), { code: 'ECONNRESET' })), 'ECONNRESET');
  const io = fakeIo({ http: () => { throw agg; } });
  const rs = await checkEndpoint(io, filled(), { publicUrl: 'https://localhost:41899' });
  for (const id of ['ep.tls', 'ep.game', 'ep.xff']) assert.match(byId(rs, id).detail, /ECONNREFUSED/, id);
});

test('verify-pr181: a 502 among the nudges is reported as a broken relay path, not as "addresses got their own bucket"', async () => {
  const right = endpoint();
  let n = 0;
  const io = fakeIo({ http: (url, opts) => (new URL(url).pathname === '/gw/f/nudge' && ++n === 14 ? { status: 502, headers: {}, body: 'bad gateway' } : right(url, opts)) });
  const rs = await checkEndpoint(io, filled(), { publicUrl: 'https://play.example.org', portsHost: false });
  const x = byId(rs, 'ep.xff');
  assert.equal(x.status, 'FAIL');
  assert.match(x.detail, /HTTP 502 is neither/);
  assert.match(x.fix, /herald could not reach the gateway/);
});

test('verify-pr181: keeper token / seed relative paths are looked up from the repository root (the keeper\'s working directory)', async () => {
  // keeper.toml outside the repo: config.rs resolves token_file against the process cwd (= repo root in runbook §8), not the toml's folder
  const io = fakeIo({ files: { '/etc/wylls/keeper.toml': KEEPER }, stats: { [`${REPO}/keeper-a/keeper.token`]: stat(), [`${REPO}/keeper-a/keeper.seed`]: stat() } });
  let rs = checkKeeperConfig(io, filled(), { keeperConfig: '/etc/wylls/keeper.toml' });
  assert.equal(byId(rs, 'cfg.keeper').status, 'PASS', JSON.stringify(rs));
  const io2 = fakeIo({ files: { '/etc/wylls/keeper.toml': KEEPER }, stats: { '/etc/keeper-a/keeper.token': stat(), '/etc/keeper-a/keeper.seed': stat() } });
  rs = checkKeeperConfig(io2, filled(), { keeperConfig: '/etc/wylls/keeper.toml' });
  assert.equal(byId(rs, 'cfg.keeper').status, 'FAIL');
  assert.match(byId(rs, 'cfg.keeper').detail, /looked at .*keeper-a\/keeper\.token: relative to the repository root/);
});

test('verify-pr181: --deployer-address is judged against the deploy peak at the rent just read (30.03 SOL at 6,960), not always 21.93', async () => {
  const DEPLOYER = 'SysvarC1ock11111111111111111111111111111111';
  const so = { [SO_PATH]: fakeSo({ len: 3_447_064 }) };
  const opts = { rpc: 'https://api.devnet.solana.com', deployerAddress: DEPLOYER, profilePath: PROFILE_PATH, soPath: SO_PATH };
  let io = fakeIo({ files: so, http: rpcAnswers({ rate: 6960, balance: 25e9 }) });
  let r = await checkRpc(io, filled(), opts);
  assert.equal(byId(r.results, 'rpc.funds.deployer').status, 'WARN', JSON.stringify(r.results));
  assert.match(byId(r.results, 'rpc.funds.deployer').detail, /deployer holds 25\.00 SOL; deploy peak 30\.03 at 6,960/);
  io = fakeIo({ files: so, http: rpcAnswers({ rate: 5080, balance: 25e9 }) });
  r = await checkRpc(io, filled(), opts);
  assert.equal(byId(r.results, 'rpc.funds.deployer').status, 'PASS');
  assert.match(byId(r.results, 'rpc.funds.deployer').detail, /deploy peak 21\.93 at 5,080/);
  assert.equal(io.calls.exec.length, 0);
});
