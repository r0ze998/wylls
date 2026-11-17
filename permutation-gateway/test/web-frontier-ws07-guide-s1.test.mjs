// Workstream 07 (player experience), claim 5: on an S1 or conquest season the
// guide's drawer teaches the seven conquest steps (screens/conquestguide.mjs),
// while the map's guide mark and its "show me" (hud/guide.mjs guideTarget)
// followed the instant-home steps of an M1 season: the map said "ガイド：ここから
// 探索" and "ガイド：蛮族の野営地" while the drawer said "兵を訓練する". The map
// now points at what the drawer asks for, and at nothing the drawer does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { guideTarget, guideLabel } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { objectiveModel } from '../../permutation-server/web/frontier/screens/onboarding.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';

const store = u => ({ value: BigInt(u) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const village = (extra = {}) => ({ p: 0, q: 2, site: 0, tile: 30, gen: 1, state: 2, tier: 0, faction: 1, stores: Array.from({ length: 8 }, () => store(500)), reserve: [0, 0, 0, 0, 0, 0, 0, 0], queue: [{ kind: 1, item: 0, doneAt: 10n }], transit: [], ...extra });
const home = { p: 0, q: 2, entries: [], sites: [30], siteCount: 1, siteMirror: [{ state: 1, faction: 1 }], camp: { state: 1, tile: 12 } };
const camp = { p: 1, q: 2, entries: [], sites: [], siteCount: 0, siteMirror: [], camp: { state: 1, tile: 40 } };
const world = (programVersion, extra = {}) => ({ mode: 'play', season: { layoutVersion: 2, programVersion }, citizen: { faction: 1, explores: 1 }, land: { stage: 'final' }, holdings: [village()], activeHolding: 0,
  chain: { now: () => 1000 }, nowBell: 100, provinces: new Map([['0,2', { province: home }], ['1,2', { province: camp }]]), ui: { guide: 'all', dismissed: ['ob:explore-result'] }, marches: [], orders: [], conquest: { keeps: new Map() }, ...extra });

test('on an S1 season the map\'s guide points where the drawer\'s step does, never at a camp the drawer does not ask for', () => {
  setLang('ja');
  for (const pv of [3, 4]) {
    const FS = world(pv);
    const o = objectiveModel(FS), t = guideTarget(FS);
    assert.equal(o.id, 'train', `program ${pv}: the drawer asks to train`);
    assert.ok(t, `program ${pv}: the map has a target`);
    assert.deepEqual([t.kind, t.p, t.q, t.tile], ['train', 0, 2, 30], `program ${pv}: the village, to train`);
    assert.equal(guideLabel(t), 'ガイド：ここで兵を訓練');
  }
});

test('the S1 guide\'s build step marks the village; its march and hold steps mark nothing on the map (the drawer names the keep)', () => {
  const unbuilt = world(4, { holdings: [village({ queue: [] })] });
  assert.equal(objectiveModel(unbuilt).id, 'build');
  assert.deepEqual(guideTarget(unbuilt) && [guideTarget(unbuilt).kind, guideTarget(unbuilt).tile], ['build', 30]);
  const trained = world(4, { holdings: [village({ reserve: [200, 0, 0, 0, 0, 0, 0, 0] })] });
  assert.equal(objectiveModel(trained).id, 'muster');
  assert.equal(guideTarget(trained)?.kind, 'muster');
  // a host formed: the drawer's step is the march on a keep; the map marks no camp
  const host = { id: hostId({ p: 0, q: 2, site: 0, gen: 1, seq: 1 }), faction: 1, unit: 0, troops: 200_000, tile: 30, state: 1, fromBell: 1, staminaValue: 100, staminaBell: 1, pendOp: 0 };
  const marching = world(4, { holdings: [village({ reserve: [0, 0, 0, 0, 0, 0, 0, 0] })], provinces: new Map([['0,2', { province: { ...home, entries: [host] } }], ['1,2', { province: camp }]]) });
  assert.equal(objectiveModel(marching).id, 'march');
  assert.equal(guideTarget(marching), null);
});

test('an M1 season keeps its own guide on the map (the camp for the first march)', () => {
  const FS = world(2);
  const t = guideTarget(FS);
  assert.equal(t?.kind, 'march');
  assert.equal(guideLabel(t), 'ガイド：蛮族の野営地');
});
