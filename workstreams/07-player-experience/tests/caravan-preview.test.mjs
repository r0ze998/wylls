// Workstream 07, claim 4 of the brief: can the arrival and the road of a
// caravan be worked out before it is sent, by the rule the program uses?
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schedule, caravanPreview, CARAVAN_TIME_BPS } from '../src/caravan-preview.mjs';
import { stepSecsOf, fastestPath } from '../../../permutation-server/web/frontier/fcaravan.mjs';
import { stepTiles, watchOf, structuresIn, caravanWatch, KIND_PALISADE, KIND_TOWER } from '../src/s1walk.mjs';

const V = JSON.parse(readFileSync(new URL('../vectors/s1-walk-v1.json', import.meta.url), 'utf8'));
const DOCTRINE_RS = readFileSync(new URL('../../../permutation-rules/src/frontier/doctrine.rs', import.meta.url), 'utf8');
const CONTROLLER = readFileSync(new URL('../../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const landsOf = c => c.lands.map(l => ({ p: l.p, q: l.q, passable: BigInt(l.passable), rough: BigInt(l.rough), road: BigInt(l.road) }));

test('the turns a caravan stands on each tile are caravan.rs `schedule`, and its step seconds `walk`', () => {
  let n = 0;
  for (const c of V.walks) {
    if (!c.caravan?.atSecs) continue;
    const lands = landsOf(c);
    const plan = fastestPath(c.origin, c.dst, lands);
    const onRoad = plan.provinces.map(pc => lands.find(l => l.p === pc.p && l.q === pc.q));
    const secs = stepSecsOf(c.origin, c.fastest, onRoad, c.caravan.bps);
    assert.deepEqual(secs, c.caravan.atSecs, `case ${c.case} seconds`);
    const steps = stepTiles(c.origin, c.fastest).map((s, i) => ({ ...s, atSecs: secs[i] }));
    assert.deepEqual(schedule(c.caravan.genesis, c.caravan.depart, c.origin, steps), c.caravan.schedule, `case ${c.case} schedule`);
    n++;
  }
  assert.ok(n > 150, `${n} roads`);
});

test('the caravan speed by nation is DOCTRINES_V3\'s: B Tide alone carries caravan_time_bps 8000', () => {
  assert.match(DOCTRINE_RS, /name: "B Tide",[\s\S]{0,80}caravan_time_bps: 8_000/);
  assert.equal((DOCTRINE_RS.match(/caravan_time_bps: \d/g) ?? []).length, 1, 'one doctrine changes it (NEUTRAL keeps BPS_ONE)');
  assert.match(DOCTRINE_RS, /DOCTRINES_V3[\s\S]{0,200}\n    DOCTRINES\[1\],/, 'S1 keeps B as it is');
  assert.deepEqual(CARAVAN_TIME_BPS, [10000, 8000, 10000, 10000, 10000, 10000]);
});

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

test('the preview finds the road round a palisade, the arrival turn, the wear of the cargo and who is known on the way', () => {
  // two Provinces side by side, all flat; the viewer of nation 0, an enemy (nation 3) palisade in the way, a tower too
  const ALL = (1n << 61n) - 1n;
  const lands = [{ p: 0, q: 0, passable: ALL, rough: 0n, road: 0n }, { p: 1, q: 0, passable: ALL, rough: 0n, road: 0n }];
  const from = { p: 0, q: 0, tile: 30 }, to = { p: 1, q: 0, tile: 30 };
  const plain = fastestPath(from, to, lands);
  const first = stepTiles(from, plain.dirs)[1];
  const structures = [{ kind: KIND_PALISADE, p: first.p, q: first.q, tile: first.tile, faction: 3 }, { kind: KIND_TOWER, p: 1, q: 0, tile: 30, faction: 3 }];
  const genesisTs = 1_000_000, now = genesisTs + 600 * 50 + 10;
  const provinces = new Map();
  const pv = caravanPreview(from, to, [0, 500, 0, 0, 0, 0, 0, 0], { lands, structures, faction: 0, genesisTs, now, provinces, sight: () => 3 });
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.equal(pv.avoided, true, 'the road goes round the palisade');
  assert.ok(!stepTiles(from, pv.road.dirs).some(s => s.p === first.p && s.q === first.q && s.tile === first.tile));
  assert.equal(pv.arrive.bell, Math.floor((now + pv.travelSecs - genesisTs) / 600));
  assert.ok(pv.wear.bps > 0 && pv.wear.bps <= 3000, 'the tower at the destination wears the last steps');
  assert.ok(pv.wear.cargo[1] < 500);
  // the same cargo worn by the same rule the program applies
  const watchAt = (p, q) => watchOf(structuresIn(structures, p, q), null, 0, false);
  assert.equal(typeof caravanWatch(pv.road.steps, watchAt), 'number');
  // a nation at pass toward nation 0 stops nothing: the straight road again, no wear
  const pass = Array.from({ length: 6 }, (_, n) => Array.from({ length: 6 }, (_, f) => (n === 3 && f === 0 ? 1 : 0)));
  const open = caravanPreview(from, to, [0, 500, 0, 0, 0, 0, 0, 0], { lands, structures, stances: pass, faction: 0, genesisTs, now, provinces, sight: () => 3 });
  assert.deepEqual([open.avoided, open.wear.bps], [false, 0]);
  // what is seen is told; what is not seen is said to be unknown, never guessed. A host on a tile the caravan only
  // passes between two turns' starts is not on its way (a raid is judged at a turn): only the turns' tiles count
  assert.ok(open.turns.length >= 2, `${open.turns.length} turns`);
  const at = open.turns[1];
  const seenOn = new Map([[`${at.p},${at.q}`, { province: { p: at.p, q: at.q, sites: [], siteCount: 0, siteMirror: [], entries: [{ state: 1, tile: at.tile, faction: 3, troops: 200_000 }, { state: 1, tile: at.tile, faction: 0, troops: 50_000 }] } }]]);
  const met = caravanPreview(from, to, [0, 500, 0, 0, 0, 0, 0, 0], { lands, structures, stances: pass, faction: 0, genesisTs, now, provinces: seenOn, sight: () => 3 });
  assert.deepEqual(met.turns[1].known, [{ faction: 3, troops: 200 }], 'the enemy host seen on the road; the own nation\'s is no danger');
  assert.ok(met.turns.every((t, i) => i === 1 || t.known.length === 0));
  const blind = caravanPreview(from, to, [0, 500, 0, 0, 0, 0, 0, 0], { lands, structures, stances: pass, faction: 0, genesisTs, now, provinces: seenOn, sight: () => 1 });
  assert.equal(blind.unknown, true);
  assert.ok(blind.turns.every(t => t.known.length === 0 && t.unknown));
});

test('a road a palisade closes everywhere is said as such, not as "too far"', () => {
  const ALL = (1n << 61n) - 1n;
  const lands = [{ p: 0, q: 0, passable: ALL, rough: 0n, road: 0n }];
  const from = { p: 0, q: 0, tile: 30 }, to = { p: 0, q: 0, tile: 31 };
  const pv = caravanPreview(from, to, [1, 0, 0, 0, 0, 0, 0, 0], { lands, structures: [{ kind: KIND_PALISADE, p: 0, q: 0, tile: 31, faction: 2 }], faction: 0, genesisTs: 0, now: 6000 });
  assert.deepEqual([pv.ok, pv.why], [false, 'OnlyThroughPalisade']);
});

test('who may raid at a turn: another nation (not on a tile a garrison holds), never a scout, and a village of the own nation even there', () => {
  const ALL = (1n << 61n) - 1n;
  const lands = [{ p: 0, q: 0, passable: ALL, rough: 0n, road: 0n }, { p: 1, q: 0, passable: ALL, rough: 0n, road: 0n }];
  const from = { p: 0, q: 0, tile: 30 }, to = { p: 1, q: 0, tile: 30 }, genesisTs = 1_000_000, now = genesisTs + 600 * 50 + 10;
  const first = caravanPreview(from, to, [1, 0, 0, 0, 0, 0, 0, 0], { lands, faction: 0, genesisTs, now, sight: () => 3 });
  const at = first.turns[1];
  const prov = extra => new Map([[`${at.p},${at.q}`, { province: { p: at.p, q: at.q, sites: [], siteCount: 0, siteMirror: [], camp: { state: 0 }, forts: [], entries: [], ...extra } }]]);
  const e = (faction, unit, troops, own = false) => ({ state: 1, tile: at.tile, faction, unit, troops, own });
  const run = (extra, ownHost) => caravanPreview(from, to, [1, 0, 0, 0, 0, 0, 0, 0], { lands, faction: 0, genesisTs, now, sight: () => 3, provinces: prov(extra), ownHost }).turns[1];
  assert.deepEqual(run({ entries: [e(3, 6, 500_000)] }).known, [], 'a scout never raids');
  assert.deepEqual(run({ entries: [e(3, 0, 200_000)] }).known, [{ faction: 3, troops: 200 }]);
  const fort = run({ entries: [e(3, 0, 200_000)], forts: [{ state: 1, tile: at.tile, troops: 100_000 }] });
  assert.deepEqual([fort.sheltered, fort.known], [true, []], 'a manned fort\'s tile keeps it out of the clash');
  assert.equal(run({ camp: { state: 1, tile: at.tile } }).sheltered, true, 'the camp\'s tile too');
  const dom = run({ entries: [e(0, 0, 100_000)], forts: [{ state: 1, tile: at.tile, troops: 100_000 }] }, x => x.own);
  assert.deepEqual(dom.domestic, [{ faction: 0, troops: 100, sure: true }], 'the own nation\'s other village may raid even on a sheltered tile');
  assert.deepEqual(run({ entries: [e(0, 0, 100_000), e(0, 0, 50_000, true)] }, x => x.own).domestic, [], 'not while one of the owner\'s hosts stands there');
});
