// REPRO (workstream 07): these tests pin a defect AS THE BASE PAGE HAS IT (a997a756, before patches/). They pass
// on the base and are EXPECTED TO FAIL once the patch that fixes the defect is applied. They are evidence, not part of
// any regular suite: the regular tests are ../*.test.mjs here and permutation-gateway/test/web-frontier-ws07-*.test.mjs
// in the patches (INTEGRATION.ja.md §2).
// Workstream 07, claim 4 of the brief: can the arrival and the road of a
// caravan be worked out before it is sent, by the rule the program uses?
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schedule, caravanPreview, CARAVAN_TIME_BPS } from '../../src/caravan-preview.mjs';
import { stepSecsOf, fastestPath } from '../../../../permutation-server/web/frontier/fcaravan.mjs';
import { stepTiles, watchOf, structuresIn, caravanWatch, KIND_PALISADE, KIND_TOWER } from '../../src/s1walk.mjs';

const V = JSON.parse(readFileSync(new URL('../../vectors/s1-walk-v1.json', import.meta.url), 'utf8'));
const DOCTRINE_RS = readFileSync(new URL('../../../../permutation-rules/src/frontier/doctrine.rs', import.meta.url), 'utf8');
const CONTROLLER = readFileSync(new URL('../../../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const landsOf = c => c.lands.map(l => ({ p: l.p, q: l.q, passable: BigInt(l.passable), rough: BigInt(l.rough), road: BigInt(l.road) }));

test('REPRO: the page sends a caravan along the fastest road without removing the palisades that stop it', () => {
  // controller.mjs s1Caravan: `fastestPath(…, await landsFor(from, dst))` — the lands as served, palisades and all
  const body = CONTROLLER.slice(CONTROLLER.indexOf('async function s1Caravan'), CONTROLLER.indexOf('export const ACTIONS'));
  assert.match(body, /fastestPath\(\{ p: from\.p, q: from\.q, tile: from\.tile \}, \{ p: dst\.p, q: dst\.q, tile: dst\.tile \}, await landsFor\(from, dst\)\)/);
  assert.doesNotMatch(body, /palisade|block|structures/i);
  const lands = CONTROLLER.slice(CONTROLLER.indexOf('async function landsFor'), CONTROLLER.indexOf('const s1Tile'));
  assert.doesNotMatch(lands, /avoidingPalisades|palisade|block/i, 'nor do the lands it plans over (connection patch 0001 removes them there)');
  // and on the rules' own roads such a send is refused: where the fastest road meets a stopping palisade, caravan_watch
  // is Blocked (the program returns Path), while a road around it exists
  const refusedButAvoidable = V.walks.filter(c => c.caravan?.walked === 'blocked' && c.fastestAvoiding?.length);
  assert.ok(refusedButAvoidable.length >= 10, `${refusedButAvoidable.length} roads the page would have refused that go round`);
});
