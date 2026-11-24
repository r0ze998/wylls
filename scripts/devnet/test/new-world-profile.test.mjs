// devnet-new-world-plan: the committed new-world profile (scripts/devnet/devnet-new-world-profile.json) is the live
// playable profile with exactly the new world's fields changed (preset, season id 3, the wide keep holder, notes), and
// it passes the deploy-day preflight's profile check. Reads two committed files; no network, no key, no signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProfile } from '../preflight-checks.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

test('new-world profile: S1_DEVNET_TERRITORY, season id 3, keep holder NeutralTerritoryV1, same program and keys', () => {
  const p = read('devnet-new-world-profile.json');
  const live = read('devnet-playable-profile.json');
  assert.equal(p.season.preset, 'S1_DEVNET_TERRITORY');
  assert.equal(p.operator.seasonId, 3);
  assert.equal(p.wide.keepHolder, 'NeutralTerritoryV1');
  assert.equal(p.programId, live.programId);
  assert.equal(p.upgradeAuthority, live.upgradeAuthority);
  assert.equal(live.operator.seasonId, 2, 'the live profile still describes Season 2 until the new world is created');
  assert.doesNotMatch(JSON.stringify(p), /\[\s*\d+\s*(,\s*\d+\s*){31,}\]/, 'no key-file byte array in the profile');
});

test('new-world profile: only the documented fields differ from the live playable profile (drift guard)', () => {
  const p = read('devnet-new-world-profile.json');
  const live = read('devnet-playable-profile.json');
  const strip = x => {
    const y = structuredClone(x);
    delete y.note; delete y.wide;
    delete y.season.preset; delete y.season.newWorldNote;
    delete y.operator.seasonId; delete y.operator.note;
    return y;
  };
  assert.deepEqual(strip(p), strip(live));
  assert.deepEqual(Object.keys(p), [...Object.keys(live).slice(0, Object.keys(live).indexOf('season') + 1), 'wide',
    ...Object.keys(live).slice(Object.keys(live).indexOf('season') + 1)]);
});

test('new-world profile: the deploy-day preflight accepts its shape and keys', () => {
  const rs = checkProfile(read('devnet-new-world-profile.json'), { profilePath: 'scripts/devnet/devnet-new-world-profile.json' });
  assert.deepEqual(rs.map(r => [r.id, r.status]), [['profile.shape', 'PASS'], ['profile.keys', 'PASS']], JSON.stringify(rs));
  assert.match(rs[0].detail, /preset S1_DEVNET_TERRITORY, keep holder NeutralTerritoryV1/);
});
