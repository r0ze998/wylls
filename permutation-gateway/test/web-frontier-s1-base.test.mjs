// S1 base production (permutation-rules arms.rs holding_base_production): an S1
// holding's ore base is its stored terrain ore under the tier bonus, so the ore
// it makes from the hills around it is not read as mines it has built.
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { buildingsOf } from '../../permutation-server/web/frontier/map/board.mjs';
import { copyNumber } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { hasBuilt } from '../../permutation-server/web/frontier/onboarding.mjs';

const prod = ore => ['40000', '30000', '20000', String(ore), '0', '15000', '5000', '0'];

test('the base: catalog values without terrain ore, the terrain ore with the tier bonus on an S1 holding', () => {
  assert.deepEqual(baseProduction(0).map(Number), [40000, 30000, 20000, 15000, 0, 15000, 5000, 0]);
  assert.equal(baseProduction(0, '34000')[3], 34000n);
  assert.equal(baseProduction(1, 34000n)[3], 51000n);           // Town +50%
  assert.equal(baseProduction(3, 34000)[3], 93500n);            // Stronghold +175%
  assert.equal(baseProduction(1, 34000)[0], 60000n);            // the other entries keep the catalog's
});

test('a new S1 hamlet on hills has no mine, and its first mine is the first copy', () => {
  const h = { tier: 0, terrainOre: '34000', production: prod(34000), queue: [] };
  assert.deepEqual(buildingsOf(h), [0, 0, 0, 0, 0, 0]);
  assert.equal(copyNumber(h, 3), 1);
  assert.equal(hasBuilt(h, 0), false);
  const built = { ...h, production: prod(34000 + 6000) };
  assert.equal(buildingsOf(built)[3], 1);
  assert.equal(copyNumber(built, 3), 2);
  assert.equal(hasBuilt(built, 0), true);
});

test('a holding without terrain ore (M1, MC) reads as before', () => {
  const h = { tier: 0, production: prod(15000 + 12000), queue: [] };
  assert.equal(buildingsOf(h)[3], 2);
  assert.equal(copyNumber(h, 3), 3);
});
