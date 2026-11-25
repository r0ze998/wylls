// TEST-ONLY operator AI residents and the world's goals (flag-keeps-ai, F4): the resident's own fogged view of the keeps
// (the page's survey + fog masks) and the residents' `--goals` argument. No process, no port, no network, no key; it
// imports the residents' module (a key-API file), so the scan keeps it to the key-tests job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { residentSeenKeeps, createResidentFog } from '../src/frontier/local-play-operator-march.mjs';
import { parseArgs } from '../src/frontier/local-play-operator-residents.mjs';
import { provinceCentre, tileHex, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';

const keep = (p, q, holder, extra = {}) => ({ p, q, tile: 30, holder, troops: 100, contender: 7, progress: 0, ...extra });

// (geometry: province centres 9 tiles apart; nation territory sees PROVINCE_RADIUS + 2 = 6 tiles from a held centre)
test('residentSeenKeeps: the resident\'s own player view — near sight live, far keeps unseen, own nation always, then last-known', () => {
  const c0 = provinceCentre(0, 0);
  const far = Array.from({ length: 61 }, (_, i) => i).find(i => { const h = tileHex(3, 0, i); return hexDistance(c0.q, c0.r, h.q, h.r) > 12; });
  const near = Array.from({ length: 61 }, (_, i) => i).find(i => { const h = tileHex(1, 0, i); return hexDistance(c0.q, c0.r, h.q, h.r) <= 5; });
  const keeps = new Map([['1,0', keep(1, 0, 3, { tile: near, contender: 4, progress: 7 })], ['3,0', keep(3, 0, 2, { tile: far })], ['-3,0', keep(-3, 0, 1, { tile: 0 })]]);
  const fog = createResidentFog();
  const a = residentSeenKeeps(keeps, { villages: [], hosts: [], territory: [{ p: 0, q: 0 }], faction: 1, fog });
  assert.deepEqual([...a.keys()].sort(), ['-3,0', '1,0'], 'the far keep is not seen; its own nation\'s far keep is');
  assert.equal(a.get('1,0').contender, 4, 'in sight: live, contest included');
  // (the territory is lost: the keep at (1,0) is out of sight — last-known holder, no contest)
  const b = residentSeenKeeps(new Map([['1,0', keep(1, 0, 5, { tile: near, contender: 2, progress: 50 })]]), { villages: [], hosts: [], territory: [], faction: 1, fog });
  assert.deepEqual([b.get('1,0').fog, b.get('1,0').holder, b.get('1,0').contender], ['memory', 3, 7], 'the last holder it saw (3, not the live 5), uncontested');
  const fresh = residentSeenKeeps(keeps, { villages: [], hosts: [], territory: [], faction: 1, fog: createResidentFog() });
  assert.deepEqual([...fresh.keys()], ['-3,0'], 'a resident that never saw a keep knows only its own nation\'s');
});

test('--goals: a loopback goals state, war worlds only', () => {
  const base = ['--count', '1', '--relay-ports', '41710', '--herald', 'http://127.0.0.1:41705', '--homes', JSON.stringify([{ p: 0, q: 1, nation: 1 }])];
  const url = 'http://127.0.0.1:41700/goals-world/41705/goals/state';
  assert.equal(parseArgs([...base, '--war', 'operator-war-v1', '--goals', url]).goals, url);
  // (research-impl, world goal ②: a world without war reads its nation's research view too)
  assert.equal(parseArgs([...base, '--goals', url]).goals, url);
  assert.throws(() => parseArgs([...base, '--war', 'operator-war-v1', '--goals', 'http://example.com:41700/goals-world/41705/goals/state']), /--goals/);
  assert.equal(parseArgs([...base, '--war', 'operator-war-v1']).goals, undefined);
});
