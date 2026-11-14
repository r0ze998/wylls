// The local-play versions read from the deployment (one definition: src/frontier/local-lane-versions.mjs = page
// flocallanes.mjs). The conquest lane 0x4804 is served exactly as before; the LOCAL TEST CANDIDATE 0xC804
// (localnet-conquest-nft-sbf, not an allocation) is served too, and nothing else. A Season's version is a number,
// a deployment's a decimal string: each check takes only its own kind. Every module reads the version from the
// deployment (no second literal), and a prepared proposal must echo the deployment's own version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCAL_LANE_VERSIONS, servesLocalVersion, servesDeploymentVersion, isCandidateVersion, CANDIDATE_FEATURE } from '../src/frontier/local-lane-versions.mjs';
import * as page from '../../permutation-server/web/frontier/flocallanes.mjs';

test('one definition on both sides; 0x4804 and the candidate 0xC804 only; numbers for Seasons, decimal strings for deployments', () => {
  assert.equal(readFileSync(new URL('../src/frontier/local-lane-versions.mjs', import.meta.url), 'utf8'), readFileSync(new URL('../../permutation-server/web/frontier/flocallanes.mjs', import.meta.url), 'utf8'));
  assert.deepEqual(LOCAL_LANE_VERSIONS, { conquest: 0x4804, conquestNftCandidate: 0xc804 });
  assert.deepEqual(page.LOCAL_LANE_VERSIONS, LOCAL_LANE_VERSIONS);
  assert.equal(CANDIDATE_FEATURE, 'localnet-conquest-nft-sbf');
  for (const v of [0x4804, 0xc804]) { assert.equal(servesLocalVersion(v), true, v.toString(16)); assert.equal(servesDeploymentVersion(String(v)), true); }
  for (const v of [4, 0x4004, 0x8004, 0x4805, 0xc805, 0]) assert.equal(servesLocalVersion(v), false, v.toString(16));
  for (const s of ['18436 ', '018436', '0x4804', '', '18437', '32772']) assert.equal(servesDeploymentVersion(s), false, JSON.stringify(s));
  assert.equal(servesLocalVersion('18436'), false, 'a Season version is a number');
  assert.equal(servesDeploymentVersion(18436), false, 'a deployment version is a string');
  assert.equal(isCandidateVersion(0xc804), true); assert.equal(isCandidateVersion('51204'), true); assert.equal(isCandidateVersion(0x4804), false); assert.equal(isCandidateVersion('18436'), false);
});

test('no module carries its own literal any more: each reads the deployment (or the Season) through the definition, and a proposal echoes the deployment\'s version', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
  const files = { '../src/frontier/expedition-prepare.mjs': 'servesDeploymentVersion', '../src/frontier/conquest-prepare.mjs': 'servesDeploymentVersion', '../src/frontier/expedition-depart-prepare.mjs': 'servesDeploymentVersion',
    '../../permutation-server/web/frontier/fexpedition-prepare.mjs': 'servesDeploymentVersion', '../../permutation-server/web/frontier/fexpedition-depart-prepare.mjs': 'servesDeploymentVersion',
    '../../permutation-server/web/frontier/flocalplay.mjs': 'servesLocalVersion', '../../permutation-server/web/frontier/hud/hand.mjs': 'servesDeploymentVersion' };
  for (const [f, fn] of Object.entries(files)) {
    const src = read(f);
    assert.ok(src.includes(`${fn}(`), `${f} checks through ${fn}`);
    assert.doesNotMatch(src.replace(/^\s*(\/\/|\*).*$/gm, ''), /=== '18436'|!== '18436'|=== DEPART_PREPARE_PROGRAM_VERSION|!== DEPART_PREPARE_PROGRAM_VERSION|!== VERSION|=== VERSION|!== LOCAL_PLAY_PROGRAM_VERSION/, `${f}: no comparison with a literal`);
  }
  assert.match(read('../src/frontier/expedition-prepare.mjs'), /p\.program_version === source\.deployment\.program_version/);
  assert.match(read('../src/frontier/conquest-prepare.mjs'), /p\.program_version === source\.deployment\.program_version/);
  assert.match(read('../src/frontier/expedition-depart-prepare.mjs'), /p\.program_version === request\.deployment\.program_version/);
  assert.match(read('../../permutation-server/web/frontier/fexpedition-prepare.mjs'), /p\.program_version === r\.deployment\.program_version/);
  assert.match(read('../../permutation-server/web/frontier/fexpedition-depart-prepare.mjs'), /p\.program_version === request\.deployment\.program_version/);
});
