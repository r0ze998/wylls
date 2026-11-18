// Tests of the devnet dry run (scripts/devnet/plan.mjs) with a fake file
// system and a fake process runner: nothing here builds, starts the Solana
// CLI, touches a key or contacts a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_FLAG, base58Decode, checkSo, cliTooOld, deployCost, isAddress, keyFileProblems, maxLenFor, parseCliVersion, profileProblems, rentExempt,
  rpcProblem, run, seasonCost, sol,
} from '../plan.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_TEXT = readFileSync(path.join(REPO, 'scripts/devnet/devnet-profile.json'), 'utf8');
const profile = () => JSON.parse(PROFILE_TEXT);
const PROGRAM = '11111111111111111111111111111112'; // valid 32-byte base58 (System program + 1), test value only
const AUTHORITY = 'SysvarRent111111111111111111111111111111111';
const filled = () => ({ ...profile(), programId: PROGRAM, upgradeAuthority: AUTHORITY });

/** A minimal ELF-looking buffer: magic, e_flags at 48, an overflow message, padding. */
function fakeSo({ flags = 2, overflow = true, marker = null, len = 4096, trailingZeros = 64 } = {}) {
  const b = Buffer.alloc(len);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b.writeUInt32LE(flags, 48);
  let o = 128;
  if (overflow) { b.write('attempt to add with overflow', o, 'latin1'); o += 40; }
  if (marker) b.write(marker, o, 'latin1');
  b.fill(7, 1024, len - trailingZeros);
  return b;
}

const SO_PATH = `${REPO}/permutation-frontier/target/deploy/permutation_frontier.so`;
const KEYS = { payer: '/keys/devnet-payer.json', program: '/keys/program.json', auth: '/keys/authority.json' };

function fakeIo({ files = {}, prof = filled(), modes = {}, addresses = {}, dump = null, failStep = null, cliVersion = 'solana-cli 4.4.1 (src:00000000; feat:0, client:Agave)' } = {}) {
  const fs = { [`${REPO}/scripts/devnet/devnet-profile.json`]: Buffer.from(JSON.stringify(prof)), [SO_PATH]: fakeSo(), ...files };
  const calls = [], logs = [], errs = [], writes = [], mkdirs = [];
  const io = {
    repoRoot: REPO, tmpDir: '/tmp/fake', uid: 501,
    readFile: f => { if (!(f in fs)) throw new Error(`ENOENT ${f}`); return fs[f]; },
    writeFile: (f, t) => { writes.push(f); fs[f] = Buffer.from(t); },
    mkdir: d => { mkdirs.push(d); },
    exists: f => f in fs,
    stat: f => {
      if (!Object.values(KEYS).includes(f) && !(f in modes)) throw new Error('ENOENT');
      return { isFile: () => true, mode: 0o100000 | (modes[f] ?? 0o600), uid: 501 };
    },
    exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (failStep && args.join(' ').startsWith(failStep)) return { status: 1, stdout: '' };
      if (cmd === 'solana' && args[0] === '--version') return { status: 0, stdout: `${cliVersion}\n` };
      if (cmd === 'solana' && args[0] === 'address') return { status: 0, stdout: `${addresses[args[2]] ?? ''}\n` };
      if (cmd === 'solana' && args[0] === 'program' && args[1] === 'dump') fs[args[3]] = dump ?? Buffer.concat([fs[SO_PATH], Buffer.alloc(9000)]);
      return { status: 0, stdout: '' };
    },
    log: t => logs.push(t), err: t => errs.push(t),
  };
  return { io, calls, logs, errs, writes, mkdirs, fs };
}
const sha = b => checkSo(b, profile()).sha256;
const openArgs = (so = fakeSo()) => [APPROVAL_FLAG, '--keypair', KEYS.payer, '--program-keypair', KEYS.program, '--upgrade-authority', KEYS.auth, '--approved-sha256', sha(so)];
const goodAddresses = { [KEYS.program]: PROGRAM, [KEYS.auth]: AUTHORITY };

// ------------------------------------------------------------ numbers

test('max_len matches build-frontier.sh and frontier-abi max_len_for', () => {
  assert.equal(maxLenFor(1_409_560), 1_765_376); // the release build of 2026-11-18 (build-frontier.sh printed it)
  assert.equal(maxLenFor(869_536), 1_089_536); // W5-A's figure in frontier-abi/src/budgets.rs
  assert.equal(maxLenFor(4096), 8192);
});

test('rent formula reproduces the code\'s own figures at 5,080 lamports per byte', () => {
  // DESIGN.md: Citizen + Holding = 9,753,600 lamports; presets.rs: rent(Province 4,736) = 24,709,120
  assert.equal(rentExempt(384, 5080) + rentExempt(1280, 5080), 9_753_600n);
  assert.equal(rentExempt(4736, 5080), 24_709_120n);
  assert.equal(sol(1_234_567_891n), '1.2345');
});

test('deploy cost follows the CLI: the buffer is funded with the ProgramData rent and returned first', () => {
  const c = deployCost({ soLen: 1_409_560, maxLen: 1_765_376, rate: 6960, lamportsPerSignature: 5000, writeChunkBytes: 850, signaturesPerWrite: 2 });
  assert.equal(c.programdata, (128n + 45n + 1_765_376n) * 6960n);
  assert.equal(c.program, (128n + 36n) * 6960n);
  assert.equal(c.writes, 1659);
  // every Write is signed by the fee payer and by the buffer (= upgrade) authority
  assert.equal(c.fees, BigInt(2 + 2 * 1659 + 3) * 5000n);
  assert.equal(c.kept, c.programdata + c.program);
  // no separate buffer hold: agave's DeployWithMaxDataLen drains the buffer to the payer before the ProgramData is paid
  assert.equal(c.peak, c.programdata + c.program + c.fees);
  assert.equal(sol(c.peak), '12.3059');
  assert.equal(sol(deployCost({ soLen: 1_409_560, maxLen: 1_765_376, rate: 5080 }).peak), '8.9864');
  assert.equal(c.upgradeFloat, (128n + 45n + 1_409_560n) * 6960n);
  assert.equal(c.buffer, undefined);
});

test('season cost sums its lines and scales player rent', () => {
  const s = profile().season;
  const a = seasonCost(s, 5080), b = seasonCost({ ...s, players: s.players + 10 }, 5080);
  assert.equal(a.total, a.lines.reduce((x, l) => x + l[1], 0n));
  assert.ok(b.total > a.total);
  assert.ok(a.continuousPerDay > 0n);
});

// ------------------------------------------------------------ profile, addresses, RPC

test('the committed profile is devnet-only and still has its placeholders', () => {
  const p = profile();
  assert.deepEqual(profileProblems(p), []);
  assert.match(p.programId, /SET-BY-R0ZE/);
  assert.match(p.upgradeAuthority, /SET-BY-R0ZE/);
  assert.ok(!/"secret|"private/i.test(PROFILE_TEXT), 'the profile never holds key material');
});

test('the profile cap and markers follow the code (drift guard)', () => {
  const budgets = readFileSync(path.join(REPO, 'frontier-abi/src/v2/budgets.rs'), 'utf8');
  const cap = Number(/PLACEHOLDER_SO_LEN_S1: u32 = ([\d_]+);/.exec(budgets)[1].replace(/_/g, ''));
  assert.equal(profile().program.soLenCap, cap);
  const build = readFileSync(path.join(REPO, 'scripts/build-frontier.sh'), 'utf8');
  const line = /for m in (PSF_[A-Z_ ]+); do/.exec(build)[1].trim().split(/\s+/);
  assert.deepEqual([...profile().program.refusedMarkers].sort(), [...line].sort());
});

test('base58 addresses', () => {
  assert.equal(base58Decode('11111111111111111111111111111111').length, 32);
  assert.ok(isAddress(PROGRAM));
  assert.ok(!isAddress('0OIl'));
  assert.ok(!isAddress('<SET-BY-R0ZE: x>'));
});

test('RPC: devnet https hosts of the profile only', () => {
  const p = profile();
  assert.equal(rpcProblem('https://api.devnet.solana.com', p), null);
  assert.match(rpcProblem('https://api.mainnet-beta.solana.com', p), /refused/);
  assert.match(rpcProblem('https://api.testnet.solana.com', p), /refused/);
  assert.match(rpcProblem('http://api.devnet.solana.com', p), /https only/);
  assert.match(rpcProblem('https://u:p@api.devnet.solana.com', p), /credentials/);
  assert.match(rpcProblem('https://example.org', p), /allowedRpcHosts/);
  // a hand-made profile cannot allow mainnet or testnet
  const wide = { ...p, allowedRpcHosts: ['api.mainnet-beta.solana.com', 'api.testnet.solana.com'], refusedRpcHostPatterns: [] };
  assert.match(rpcProblem('https://api.mainnet-beta.solana.com', wide), /refused/);
  assert.match(rpcProblem('https://api.testnet.solana.com', wide), /refused/);
});

// ------------------------------------------------------------ the artefact

test('checkSo passes a clean SBPF v2 file and refuses the build-frontier.sh failures', () => {
  const p = profile();
  assert.deepEqual(checkSo(fakeSo(), p).problems, []);
  assert.match(checkSo(fakeSo({ flags: 1 }), p).problems.join(), /e_flags 1/);
  assert.match(checkSo(fakeSo({ overflow: false }), p).problems.join(), /overflow/);
  assert.match(checkSo(fakeSo({ marker: 'PSF_LOCALNET_CONQUEST_SBF_BUILD' }), p).problems.join(), /never deployable/);
  assert.match(checkSo(fakeSo({ marker: 'PSF_TEST_BEACON_BUILD' }), p).problems.join(), /never deployable/);
  assert.match(checkSo(fakeSo({ len: p.program.soLenCap + 1 }), p).problems.join(), /L\(kind\)/);
  assert.deepEqual(checkSo(Buffer.from('not an elf at all, just text, long enough to have a header....'), p).problems, ['not an ELF file']);
  const c = checkSo(fakeSo(), p);
  assert.notEqual(c.sha256, c.programHash, 'program_hash strips the trailing zeros');
});

// ------------------------------------------------------------ the gate

test('dry run by default: prints the plan, starts nothing, gate closed', () => {
  const { io, calls, logs } = fakeIo({ prof: profile() });
  assert.equal(run([], io), 0);
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /SEND GATE: CLOSED/);
  assert.match(logs.join('\n'), /not given: dry run only/);
  assert.match(logs.join('\n'), /TOTAL to hold/);
});

test('approval flag alone, or key files alone, never send', () => {
  for (const args of [[APPROVAL_FLAG], ['--keypair', KEYS.payer, '--program-keypair', KEYS.program, '--upgrade-authority', KEYS.auth, '--approved-sha256', sha(fakeSo())]]) {
    const { io, calls, logs } = fakeIo({ addresses: goodAddresses });
    assert.equal(run(args, io), 0);
    assert.deepEqual(calls, [], args.join(' '));
    assert.match(logs.join('\n'), /SEND GATE: CLOSED/);
  }
});

test('placeholders left in the profile keep the gate closed even with every flag', () => {
  const { io, calls, logs } = fakeIo({ prof: profile(), addresses: goodAddresses });
  assert.equal(run(openArgs(), io), 0);
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /programId is still a placeholder/);
});

test('key files: mode 600 and outside the repository only', () => {
  const inRepo = `${REPO}/permutation-frontier/target/deploy/permutation_frontier-keypair.json`;
  const cases = [
    [{ modes: { [KEYS.payer]: 0o644 } }, openArgs(), /must be 600/],
    [{ modes: { [inRepo]: 0o600 } }, openArgs().map(a => (a === KEYS.program ? inRepo : a)), /inside the repository/],
    [{}, openArgs().map(a => (a === KEYS.auth ? 'relative/auth.json' : a)), /not found|absolute/],
  ];
  for (const [extra, args, re] of cases) {
    const { io, calls, logs } = fakeIo({ ...extra, addresses: goodAddresses });
    assert.equal(run(args, io), 0);
    assert.deepEqual(calls, []);
    assert.match(logs.join('\n'), re);
  }
});

test('key file paths must be normalised, so ".." cannot hide a file inside the repository', () => {
  const stat = () => ({ isFile: () => true, mode: 0o100600, uid: 501 });
  const sneaky = `/tmp/../${REPO.slice(1)}/key.json`;
  assert.match(keyFileProblems('--keypair', sneaky, { stat, repoRoot: REPO, uid: 501 }).join(), /normalised/);
  assert.match(keyFileProblems('--keypair', `${REPO}/key.json`, { stat, repoRoot: REPO, uid: 501 }).join(), /inside the repository/);
  assert.deepEqual(keyFileProblems('--keypair', '/keys/a.json', { stat, repoRoot: REPO, uid: 501 }), []);
  assert.match(keyFileProblems('--keypair', '/keys/a.json', { stat, repoRoot: REPO, uid: 502 }).join(), /not owned/);
});

test('Solana CLI versions: 3.1.x cannot deploy this program', () => {
  assert.deepEqual(parseCliVersion('solana-cli 3.1.9 (src:765ee54a; feat:1620780344, client:Agave)'), [3, 1, 9]);
  assert.equal(parseCliVersion('something else'), null);
  assert.ok(cliTooOld([3, 1, 9]));
  assert.ok(!cliTooOld([4, 0, 0]));
  assert.ok(!cliTooOld([4, 4, 1]));
  assert.ok(!cliTooOld([5, 0, 0]));
});

test('gate open but the Solana CLI is 3.1.9 or unreadable: stops before any key file is used (exit 4)', () => {
  for (const cliVersion of ['solana-cli 3.1.9 (src:765ee54a; feat:1620780344, client:Agave)', 'garbage']) {
    const { io, calls, errs } = fakeIo({ addresses: goodAddresses, cliVersion });
    assert.equal(run(openArgs(), io), 4);
    assert.deepEqual(calls.map(([c, a]) => `${c} ${a[0]}`), ['solana --version']);
    assert.match(errs.join('\n'), /need 4\.0\.0 or newer/);
  }
});

test('the approval is bound to one .so: another sha256 keeps the gate closed', () => {
  const { io, calls, logs } = fakeIo({ addresses: goodAddresses });
  const args = openArgs();
  args[args.length - 1] = 'ab'.repeat(32);
  assert.equal(run(args, io), 0);
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /is not this \.so/);
});

test('a refused artefact stops before the gate (exit 3), even with every flag', () => {
  const bad = fakeSo({ marker: 'PSF_TEST_BEACON_BUILD' });
  const { io, calls } = fakeIo({ files: { [SO_PATH]: bad }, addresses: goodAddresses });
  assert.equal(run(openArgs(bad), io), 3);
  assert.deepEqual(calls, []);
});

test('a mainnet RPC is refused outright (exit 2)', () => {
  const { io, calls } = fakeIo({ addresses: goodAddresses });
  assert.equal(run([...openArgs(), '--rpc', 'https://api.mainnet-beta.solana.com'], io), 2);
  assert.deepEqual(calls, []);
  const p = { ...filled(), rpcUrl: 'https://api.mainnet-beta.solana.com' };
  const f = fakeIo({ prof: p });
  assert.equal(run([], f.io), 2);
});

test('gate open (fake CLI): the exact command sequence, devnet only, no airdrop and no --final', () => {
  const { io, calls, logs } = fakeIo({ addresses: goodAddresses });
  assert.equal(run(openArgs(), io), 0);
  assert.match(logs.join('\n'), /SEND GATE: OPEN/);
  assert.match(logs.join('\n'), /deployed and verified/);
  assert.deepEqual(calls.map(([c, a]) => `${c} ${a.slice(0, 2).join(' ')}`), [
    'solana --version', 'solana address --keypair', 'solana address --keypair', 'solana balance --keypair',
    'solana program deploy', 'solana program show', 'solana program dump',
  ]);
  const deploy = calls[4][1];
  assert.deepEqual(deploy.slice(deploy.indexOf('--max-len'), deploy.indexOf('--max-len') + 2), ['--max-len', String(maxLenFor(4096))]);
  assert.equal(deploy[deploy.indexOf('--program-id') + 1], KEYS.program);
  assert.equal(deploy[deploy.indexOf('--upgrade-authority') + 1], KEYS.auth);
  for (const [, a] of calls) {
    assert.ok(!a.includes('airdrop') && !a.includes('--final'), a.join(' '));
    const u = a.indexOf('--url');
    if (u >= 0) assert.equal(a[u + 1], 'https://api.devnet.solana.com');
  }
});

test('gate open but the program key file is another address: stops before deploy (exit 4)', () => {
  const { io, calls } = fakeIo({ addresses: { ...goodAddresses, [KEYS.program]: AUTHORITY } });
  assert.equal(run(openArgs(), io), 4);
  assert.ok(!calls.some(([, a]) => a[1] === 'deploy'));
});

test('gate open but the authority key file is another address: stops before deploy (exit 4)', () => {
  const { io, calls, errs } = fakeIo({ addresses: { ...goodAddresses, [KEYS.auth]: PROGRAM } });
  assert.equal(run(openArgs(), io), 4);
  assert.ok(!calls.some(([, a]) => a[1] === 'deploy'));
  assert.match(errs.join('\n'), /--upgrade-authority is not/);
});

test('each key file and the approved sha256 is required: leaving any one out keeps the gate closed', () => {
  for (const flag of ['--keypair', '--program-keypair', '--upgrade-authority', '--approved-sha256']) {
    const args = openArgs();
    args.splice(args.indexOf(flag), 2);
    const { io, calls, logs } = fakeIo({ addresses: goodAddresses });
    assert.equal(run(args, io), 0, flag);
    assert.deepEqual(calls, [], flag);
    assert.match(logs.join('\n'), /SEND GATE: CLOSED/, flag);
    assert.match(logs.join('\n'), new RegExp(`${flag} <[^>]+> is required`), flag);
  }
});

test('gate open, deploy fails: no verification steps after it (exit 4)', () => {
  const { io, calls } = fakeIo({ addresses: goodAddresses, failStep: 'program deploy' });
  assert.equal(run(openArgs(), io), 4);
  assert.ok(!calls.some(([, a]) => a[1] === 'show'));
});

test('on-chain bytes that differ from the .so are reported (exit 4)', () => {
  const { io } = fakeIo({ addresses: goodAddresses, dump: fakeSo({ len: 8192 }) });
  assert.equal(run(openArgs(), io), 4);
});

test('--build writes a non-key placeholder only when the file is missing, then builds', () => {
  const holder = SO_PATH.replace(/\.so$/, '-keypair.json');
  const a = fakeIo({ prof: profile() });
  assert.equal(run(['--build'], a.io), 0);
  assert.deepEqual(a.writes, [holder]);
  assert.deepEqual(a.mkdirs, [path.dirname(holder)], 'a fresh checkout has no target/deploy directory yet');
  assert.match(a.fs[holder].toString(), /^PLACEHOLDER: not a key/);
  assert.deepEqual(a.calls, [[`${REPO}/scripts/build-frontier.sh`, []]]);
  const b = fakeIo({ prof: profile(), files: { [holder]: Buffer.from('{"existing": true}') } });
  assert.equal(run(['--build', '--twice'], b.io), 0);
  assert.deepEqual(b.writes, []);
  assert.deepEqual(b.calls, [[`${REPO}/scripts/build-frontier.sh`, ['--twice']]]);
  // a placeholder that cannot be written stops the build (exit 3) instead of letting cargo-build-sbf make a key
  const c = fakeIo({ prof: profile() });
  c.io.writeFile = () => { throw new Error('EACCES'); };
  assert.equal(run(['--build'], c.io), 3);
  assert.deepEqual(c.calls, []);
});

test('build-frontier.sh --twice puts a placeholder in both temporary out dirs (no key is generated)', () => {
  const build = readFileSync(path.join(REPO, 'scripts/build-frontier.sh'), 'utf8');
  const i = build.indexOf('PLACEHOLDER: not a key'), j = build.indexOf('build "$tmp/out1" "$tmp/t1"');
  assert.ok(i > 0 && j > i, 'the placeholders are written before the first build');
  assert.match(build, /the keypair placeholder was replaced/);
});

test('bad arguments and rates are refused (exit 2)', () => {
  for (const args of [['--nope'], ['--rate', '1234'], ['--players', '-1'], ['--keypair']]) {
    const { io, calls } = fakeIo();
    assert.equal(run(args, io), 2, args.join(' '));
    assert.deepEqual(calls, []);
  }
});

test('--json gives machine-readable numbers', () => {
  const { io, logs } = fakeIo({ prof: profile() });
  assert.equal(run(['--json', '--rate', '5080'], io), 0);
  const j = JSON.parse(logs[0]);
  assert.equal(j.gate, 'closed');
  assert.equal(j.rate, 5080);
  assert.equal(j.costs.length, 6);
});

// ⑳ NFT resident ID (owner decision 2026-11-18 18:26 JST: devnet/local only, no sale).
const NFT_SO = `${REPO}/permutation-frontier/target/deploy-nft-experimental/permutation_frontier.so`;

test('--nft-resident plans the nft-experimental build, wants its marker and keeps the gate closed', () => {
  const { io, logs } = fakeIo({ files: { [NFT_SO]: fakeSo({ marker: 'PSF_NFT_EXPERIMENTAL_BUILD' }) } });
  assert.equal(run(['--nft-resident'], io), 0);
  const out = logs.join('\n');
  assert.match(out, /with ⑳ NFT resident ID \(Reopened 2026-11-18 by owner; devnet\/local only/);
  assert.match(out, /build scripts\/build-frontier\.sh --features nft-experimental/);
  assert.match(out, /checks pass/);
  assert.match(out, /SEND GATE: CLOSED[\s\S]*--nft-resident: ⑳ is devnet-ready only/);
});

test('--nft-resident refuses an artefact without the NFT marker or with a localnet marker', () => {
  for (const [marker, want] of [[null, /marker PSF_NFT_EXPERIMENTAL_BUILD missing/], ['PSF_LOCALNET_NFT_SBF_BUILD', /carries PSF_LOCALNET_NFT_SBF_BUILD/]]) {
    const { io, logs } = fakeIo({ files: { [NFT_SO]: fakeSo({ marker }) } });
    assert.equal(run(['--nft-resident'], io), 3);
    assert.match(logs.join('\n'), want);
  }
});

test('the default plan refuses the NFT builds', () => {
  for (const marker of ['PSF_NFT_EXPERIMENTAL_BUILD', 'PSF_LOCALNET_NFT_SBF_BUILD']) {
    const { io, logs } = fakeIo({ files: { [SO_PATH]: fakeSo({ marker }) } });
    assert.equal(run([], io), 3);
    assert.match(logs.join('\n'), new RegExp(`carries ${marker}`));
  }
});

test('--nft-resident --build runs build-frontier.sh with the nft-experimental feature, and the gate stays closed even when everything else is given', () => {
  const { io, calls, logs } = fakeIo({ files: { [NFT_SO]: fakeSo({ marker: 'PSF_NFT_EXPERIMENTAL_BUILD' }) }, addresses: { [KEYS.program]: PROGRAM, [KEYS.auth]: AUTHORITY } });
  const so = checkSo(io.readFile(NFT_SO), filled(), { nftResident: true });
  assert.deepEqual(so.problems, []);
  const argv = ['--nft-resident', '--build', APPROVAL_FLAG, '--keypair', KEYS.payer, '--program-keypair', KEYS.program, '--upgrade-authority', KEYS.auth, '--approved-sha256', so.sha256];
  assert.equal(run(argv, io), 0);
  assert.deepEqual(calls[0], [`${REPO}/scripts/build-frontier.sh`, ['--features', 'nft-experimental']]);
  assert.ok(!calls.some(([c]) => c === 'solana'), 'nothing is sent');
  assert.match(logs.join('\n'), /SEND GATE: CLOSED/);
});
