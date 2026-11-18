// Tests of the devnet dry run with the PLAYABLE lane's profile (owner decision B7, 2026-11-18):
// scripts/devnet/devnet-playable-profile.json. A fake file system and a fake process runner: nothing here builds,
// starts the Solana CLI, touches a key or contacts a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_FLAG, checkSo, deployCost, MAX_PERMITTED_DATA_LENGTH, maxLenFor, profileProblems, run, sol } from '../plan.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = f => readFileSync(path.join(REPO, f), 'utf8');
const PLAYABLE_PATH = 'scripts/devnet/devnet-playable-profile.json';
const playable = () => JSON.parse(read(PLAYABLE_PATH));
const s1 = () => JSON.parse(read('scripts/devnet/devnet-profile.json'));
const PROGRAM = '11111111111111111111111111111112';
const AUTHORITY = 'SysvarRent111111111111111111111111111111111';
const MARKER = 'PSF_DEVNET_PLAYABLE_BUILD';

function fakeSo({ markers = [MARKER], len = 4096 } = {}) {
  const b = Buffer.alloc(len);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b.writeUInt32LE(2, 48);
  let o = 128;
  b.write('attempt to add with overflow', o, 'latin1'); o += 40;
  for (const m of markers) { b.write(m, o, 'latin1'); o += m.length + 8; }
  b.fill(7, 1024, len - 64);
  return b;
}

const SO_PATH = `${REPO}/${playable().program.so}`;
const PROFILE_FILE = `${REPO}/${PLAYABLE_PATH}`;
function fakeIo({ so = fakeSo(), prof = playable(), soExists = true } = {}) {
  const fs = { [PROFILE_FILE]: Buffer.from(JSON.stringify(prof)), ...(soExists ? { [SO_PATH]: so } : {}) };
  const calls = [], logs = [], errs = [], writes = [];
  const io = {
    repoRoot: REPO, tmpDir: '/tmp/fake', uid: 501,
    readFile: f => { if (!(f in fs)) throw new Error(`ENOENT ${f}`); return fs[f]; },
    writeFile: (f, t) => { writes.push(f); fs[f] = Buffer.from(t); },
    mkdir: () => {},
    exists: f => f in fs,
    stat: () => { throw new Error('ENOENT'); },
    exec: (cmd, args) => { calls.push([cmd, args]); if (cmd.endsWith('.sh')) fs[SO_PATH] = so; return { status: 0, stdout: '' }; },
    log: t => logs.push(t), err: t => errs.push(t),
  };
  return { io, calls, logs, errs, writes };
}

test('the playable profile is valid, devnet-only and names its own build, marker and version', () => {
  const p = playable();
  assert.deepEqual(profileProblems(p), []);
  assert.equal(p.cluster, 'devnet');
  assert.equal(p.lane, 'playable');
  assert.equal(p.program.build, 'scripts/build-frontier-devnet-playable-sbf.sh');
  assert.equal(p.program.so, 'permutation-frontier/target/deploy-devnet-playable-sbf/permutation_frontier.so');
  assert.deepEqual(p.program.requiredMarkers, [MARKER]);
  assert.equal(p.program.programVersion, '0x4804');
  assert.match(p.programId, /SET-BY-R0ZE/);
  assert.match(p.upgradeAuthority, /SET-BY-R0ZE/);
  assert.notEqual(p.programId, s1().programId, 'a different program from the S1 one');
  assert.ok(!/"secret|"private/i.test(read(PLAYABLE_PATH)));
});

test('drift guard: markers follow build-frontier.sh and the program (both profiles)', () => {
  const build = read('scripts/build-frontier.sh');
  const all = /for m in (PSF_[A-Z_ ]+); do/.exec(build)[1].trim().split(/\s+/);
  assert.ok(all.includes(MARKER), 'build-frontier.sh checks the devnet playable marker');
  assert.ok(read('permutation-frontier/src/markers.rs').includes(`b"${MARKER}"`));
  // the playable profile refuses every other marker the script knows and requires its own
  assert.deepEqual([...playable().program.refusedMarkers, ...playable().program.requiredMarkers].sort(), [...all].sort());
  // the S1 profile refuses the playable artefact
  assert.ok(s1().program.refusedMarkers.includes(MARKER));
  assert.ok(!s1().program.requiredMarkers, 'the S1 profile has no required marker (plain build)');
  // the cap is the loader's limit: max_len of the cap is exactly MAX_PERMITTED_DATA_LENGTH
  assert.equal(maxLenFor(playable().program.soLenCap), MAX_PERMITTED_DATA_LENGTH);
  assert.equal(MAX_PERMITTED_DATA_LENGTH, 10_485_760);
  // the lane clients' loaded-data limit is the runtime maximum (so no L(kind) table bounds the lane)
  assert.match(read('permutation-gateway/src/frontier/local-play-act.mjs'), /export const LOCAL_ACT_LOADED_LIMIT = 67108864;/);
  assert.match(read('permutation-server/web/frontier/flocalplay-reveal.mjs'), /loadedLimit: 64 \* 1024 \* 1024/);
});

test('checkSo: the playable artefact passes only with its marker and without any other', () => {
  const p = playable();
  assert.deepEqual(checkSo(fakeSo(), p).problems, []);
  assert.match(checkSo(fakeSo({ markers: [] }), p).problems.join(';'), /marker PSF_DEVNET_PLAYABLE_BUILD missing/);
  for (const other of ['PSF_LOCALNET_EXPEDITION_SBF_BUILD', 'PSF_LOCALNET_CONQUEST_SBF_BUILD', 'PSF_TEST_BEACON_BUILD', 'PSF_RIGHTS_EXPERIMENTAL_BUILD']) {
    assert.match(checkSo(fakeSo({ markers: [MARKER, other] }), p).problems.join(';'), new RegExp(`carries ${other}`), other);
  }
  // the S1 profile refuses the playable artefact, and the playable profile refuses a plain (S1) artefact
  assert.match(checkSo(fakeSo(), s1()).problems.join(';'), /carries PSF_DEVNET_PLAYABLE_BUILD/);
  assert.match(checkSo(fakeSo({ markers: [] }), p).problems.join(';'), /missing/);
});

test('checkSo: the cap is the profile cap, with its own message', () => {
  const p = { ...playable(), program: { ...playable().program, soLenCap: 2048 } };
  const r = checkSo(fakeSo(), p);
  assert.match(r.problems.join(';'), /so_len 4096 > 2048: over this profile's cap/);
  assert.ok(!/regenerate frontier-abi/.test(r.problems.join(';')), 'not the S1 table message');
});

test('profileProblems refuses a marker both required and refused, and a cap past the loader limit', () => {
  const p = playable();
  assert.match(profileProblems({ ...p, program: { ...p.program, refusedMarkers: [...p.program.refusedMarkers, MARKER] } }).join(';'), /both required and refused/);
  assert.match(profileProblems({ ...p, program: { ...p.program, soLenCap: 8_388_609 } }).join(';'), /soLenCap/);
});

test('dry run with --profile playable: --build runs the playable script (and --twice), prints the lane, sends nothing', () => {
  const a = fakeIo({ soExists: false });
  assert.equal(run(['--profile', PROFILE_FILE, '--build', '--twice'], a.io), 0);
  assert.deepEqual(a.calls, [[`${REPO}/scripts/build-frontier-devnet-playable-sbf.sh`, ['--twice']]]);
  assert.ok(a.writes.includes(SO_PATH.replace(/\.so$/, '-keypair.json')), 'the keypair placeholder is written first');
  const text = a.logs.join('\n');
  assert.match(text, /lane playable {2}program_version 0x4804 {2}build scripts\/build-frontier-devnet-playable-sbf.sh/);
  assert.match(text, /checks pass/);
  assert.match(text, /SEND GATE: CLOSED/);
  assert.ok(!a.calls.some(([c]) => c === 'solana'), 'no Solana CLI call in a dry run');
});

test('dry run with --profile playable refuses an S1 or localnet artefact (exit 3)', () => {
  for (const markers of [[], ['PSF_LOCALNET_EXPEDITION_SBF_BUILD', 'PSF_LOCALNET_CONQUEST_SBF_BUILD']]) {
    const a = fakeIo({ so: fakeSo({ markers }) });
    assert.equal(run(['--profile', PROFILE_FILE], a.io), 3, markers.join(','));
    assert.match(a.logs.join('\n'), /checks FAIL/);
  }
});

test('the send gate stays closed with placeholders even with every flag', () => {
  const a = fakeIo();
  const so = fakeSo();
  const r = run(['--profile', PROFILE_FILE, APPROVAL_FLAG, '--keypair', '/k/a.json', '--program-keypair', '/k/b.json', '--upgrade-authority', '/k/c.json', '--approved-sha256', checkSo(so, playable()).sha256], a.io);
  assert.equal(r, 0);
  assert.match(a.logs.join('\n'), /programId is still a placeholder/);
  assert.ok(!a.calls.some(([c]) => c === 'solana'));
  // with the addresses filled the key files are still checked (none exist here)
  const b = fakeIo({ prof: { ...playable(), programId: PROGRAM, upgradeAuthority: AUTHORITY } });
  run(['--profile', PROFILE_FILE, APPROVAL_FLAG, '--keypair', '/k/a.json', '--program-keypair', '/k/b.json', '--upgrade-authority', '/k/c.json', '--approved-sha256', checkSo(so, playable()).sha256], b.io);
  assert.match(b.logs.join('\n'), /--keypair \/k\/a.json: not found/);
  assert.ok(!b.calls.some(([c]) => c === 'solana'));
});

test('deploy cost of a playable-sized .so follows the formula (numbers in the report)', () => {
  // 3,651,280 B: the land lane as built today with the release profile (reports/devnet-playable-lane.md)
  const soLen = 3_651_280;
  const maxLen = maxLenFor(soLen);
  assert.equal(maxLen, 4_567_040);
  const c = deployCost({ soLen, maxLen, rate: 6960, lamportsPerSignature: 5000, writeChunkBytes: 850, signaturesPerWrite: 2 });
  assert.equal(c.programdata, (128n + 45n + BigInt(maxLen)) * 6960n);
  assert.equal(sol(c.kept), '31.7889');
});
