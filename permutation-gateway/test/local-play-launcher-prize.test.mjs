// ⑰ (2026-11-15): the launcher's TEST ONLY prize option (--prize-test-only-so). Pure: parseConfig over a temporary root
// of empty stand-in files (no world, no process, no key) and the first-line check over literal objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encode as b58 } from '../client/src/base58.mjs';
import { candidateMetaAgrees, CONQUEST_WORLD_PRESET, parseConfig, PRIZE_TEST_ONLY_PROGRAM, prizeTestOnlyMetaAgrees } from '../src/frontier/local-play-launcher.mjs';

const fill = n => b58(new Uint8Array(32).fill(n));

test('the TEST id is [0x50; 32] and none of the lanes\' or the candidate\'s ids', () => {
  assert.equal(PRIZE_TEST_ONLY_PROGRAM, fill(0x50));
  for (const n of [0x45, 0x4c, 0x4e]) assert.notEqual(PRIZE_TEST_ONLY_PROGRAM, fill(n), `0x${n.toString(16)}`);
});

const good = { program: PRIZE_TEST_ONLY_PROGRAM, pool: fill(0x70), mint: fill(0x72), vault: fill(0x71), test_only: true };

test('first line: unasked, no prize_test_only key at all; asked, exactly the TEST id with pool, mint and vault', () => {
  assert.equal(prizeTestOnlyMetaAgrees({}, false), true, 'a line without the key, unasked: as before');
  assert.equal(prizeTestOnlyMetaAgrees({ prize_test_only: good }, false), false, 'a line that carries it unasked is refused');
  assert.equal(prizeTestOnlyMetaAgrees({}, true), false, 'asked but absent: refused');
  assert.equal(prizeTestOnlyMetaAgrees({ prize_test_only: good }, true), true);
  for (const bad of [{ ...good, program: fill(0x4c) }, { ...good, pool: good.mint }, { ...good, vault: 'nope' }, { ...good, test_only: undefined }, null, 'x']) {
    assert.equal(prizeTestOnlyMetaAgrees({ prize_test_only: bad }, true), false, JSON.stringify(bad));
  }
  // The existing candidate check is untouched by the option: a plain line is still taken as a plain line.
  assert.equal(candidateMetaAgrees({ program_version: '0x4804' }, false, '/tmp/w'), true);
});

/** A temporary root with empty files where parseConfig looks for them. */
async function root(t) {
  const r = await mkdtemp(path.join(os.tmpdir(), 'wylls-prize-launcher-'));
  t.after(() => rm(r, { recursive: true, force: true }));
  await mkdir(path.join(r, 'permutation-server/web'), { recursive: true });
  await mkdir(path.join(r, 'permutation-gateway/src/frontier'), { recursive: true });
  await mkdir(path.join(r, 'bin'), { recursive: true });
  for (const f of ['runner', 'herald', 'program.so', 'resident.so', 'core.so', 'nft-setup.mjs', 'mint.mjs', 'prize.so']) await writeFile(path.join(r, 'bin', f), 'x');
  await writeFile(path.join(r, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), '');
  return r;
}
const argv = o => Object.entries(o).flatMap(([k, v]) => [`--${k}`, String(v)]);

test('the command line: --prize-test-only-so only with the candidate lane, an absolute path; without it nothing changes', async t => {
  const r = await root(t), b = n => path.join(r, 'bin', n);
  const base = { root: r, data: path.join(r, 'data'), runner: b('runner'), herald: b('herald'), depart: b('runner'), preview: b('runner'), resident: b('runner'), artifact: b('program.so'), 'artifact-sha': 'cd'.repeat(32) };
  const candidate = { ...base, 'world-preset': CONQUEST_WORLD_PRESET, 'prepare-scale': 30, 'lane-candidate': 'localnet-conquest-nft-sbf', 'resident-so': b('resident.so'), 'core-so': b('core.so'), 'nft-setup': b('nft-setup.mjs'), mint: b('mint.mjs'), 'mint-port': 41996 };
  const plain = await parseConfig(argv(base));
  assert.equal(plain.prizeTestOnlySo, undefined, 'no option, no key');
  const cand = await parseConfig(argv(candidate));
  assert.equal(cand.prizeTestOnlySo, undefined, 'the candidate alone is as before');
  const asked = await parseConfig(argv({ ...candidate, 'prize-test-only-so': b('prize.so') }));
  assert.equal(asked.prizeTestOnlySo, b('prize.so'));
  await assert.rejects(parseConfig(argv({ ...base, 'prize-test-only-so': b('prize.so') })), e => e.code === 'PrizeTestOnlyNeedsCandidate', 'never on the conquest lane alone');
  await assert.rejects(parseConfig(argv({ ...candidate, 'prize-test-only-so': 'bin/prize.so' })), e => e.code === 'AbsolutePathRequired');
  await assert.rejects(parseConfig(argv({ ...candidate, 'prize-test-only-so': path.join(r, 'bin/absent.so') })), e => e.code === 'MissingFile');
});
