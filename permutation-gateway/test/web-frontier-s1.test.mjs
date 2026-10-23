// The redesign's stage 1 (S1, program_version 4) on the web page (1f):
//  - the S1 numbers the page shows (fs1.mjs), pinned against permutation-rules
//    arms.rs;
//  - the Horses slot named and drawn as arms, the strong units' arms cost,
//    the workshop offered (and named in the queue) on an S1 season only;
//  - the herald's S1 feeds (h/caravans.json, h/structures.json,
//    h/nations.json) read strictly, as herald/src/{caravan,structure,nation}.rs
//    write them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S1 from '../../permutation-server/web/frontier/fs1.mjs';
import { trainingCost, queueItem, queueBuildingItem, buildItemOf } from '../../permutation-server/web/frontier/fland.mjs';
import { trainCost, buildOffers } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { RESOURCES, BUILDINGS } from '../../permutation-server/web/frontier/fi18n.mjs';
import { resourceIcon } from '../../permutation-server/web/frontier/hud/icons.mjs';
import { parseCaravans, parseStructures, parseNations, createHerald } from '../../permutation-server/web/frontier/herald.mjs';

const ARMS_RS = readFileSync(new URL('../../permutation-rules/src/frontier/arms.rs', import.meta.url), 'utf8');
const rsConst = name => {
  const m = ARMS_RS.match(new RegExp(`pub const ${name}: [^=]+= ([^;]+);`));
  assert.ok(m, `arms.rs has ${name}`);
  return m[1];
};
const rsArray = name => JSON.parse(rsConst(name));
const rsInt = name => Number(rsConst(name));

const S1_SEASON = { layoutVersion: 2, programVersion: 4 };
const MC_SEASON = { layoutVersion: 2, programVersion: 3 };
const withS1 = (season, fn) => { S1.setS1(season); try { return fn(); } finally { S1.setS1(null); } };

test('the S1 numbers are arms.rs\'s', () => {
  assert.match(rsConst('ARMS'), /Resource::Horses/);
  assert.equal(S1.ARMS, 4, 'Horses is store slot 4');
  assert.deepEqual([...S1.TRAIN_ARMS_PER_100], rsArray('TRAIN_ARMS_PER_100'));
  assert.equal(S1.SIEGE_ARMS, rsInt('SIEGE_ARMS'));
  assert.equal(S1.WORKSHOP.item, rsInt('ITEM_WORKSHOP'));
  assert.deepEqual([...S1.WORKSHOP.cost], rsArray('WORKSHOP_COST'));
  assert.equal(S1.WORKSHOP.perHour, rsInt('WORKSHOP_ARMS_PER_HOUR'));
  assert.equal(S1.WORKSHOP.orePerArm, rsInt('WORKSHOP_ORE_PER_HOUR') / rsInt('WORKSHOP_ARMS_PER_HOUR'));
  assert.equal(S1.WORKSHOP.woodPerArm, rsInt('WORKSHOP_WOOD_PER_HOUR') / rsInt('WORKSHOP_ARMS_PER_HOUR'));
});

test('an S1 season is layout 2 with program_version 4 or later', () => {
  assert.equal(S1.s1Season(S1_SEASON), true);
  assert.equal(S1.s1Season({ layoutVersion: 2, programVersion: 5 }), true);
  assert.equal(S1.s1Season(MC_SEASON), false);
  assert.equal(S1.s1Season({ layoutVersion: 1, programVersion: 4 }), false);
  assert.equal(S1.s1Season(null), false);
  withS1(S1_SEASON, () => assert.equal(S1.s1On(), true));
  assert.equal(S1.s1On(), false);
});

test('the Horses slot is arms on an S1 season, horses otherwise', () => {
  assert.equal(String(RESOURCES.Horses), '馬');
  assert.doesNotMatch(String(resourceIcon('Horses')), /#swords/);
  withS1(S1_SEASON, () => {
    assert.equal(String(RESOURCES.Horses), '兵器');
    assert.match(String(resourceIcon('Horses')), /swords/);
    assert.equal(String(BUILDINGS.Horses), '工房');
  });
});

test('the strong units cost arms to train from program_version 4', () => {
  // Pikeman (3) 150 troops: two batches of 100.
  assert.equal(trainingCost(3, 150, 3)[4], 0, 'MC: no arms');
  assert.equal(trainingCost(3, 150, 4)[4], 100);
  assert.equal(trainingCost(4, 100, 4)[4], 70);
  assert.equal(trainingCost(5, 201, 4)[4], 120);
  assert.equal(trainingCost(0, 100, 4)[4], 0, 'militia need none');
  for (const unit of [0, 1, 2, 3, 4, 5, 6]) {
    for (const n of [1, 100, 250]) {
      assert.deepEqual(trainCost(unit, n, 4), trainingCost(unit, n, 4), `rulebook and fland agree on ${unit} × ${n}`);
    }
  }
  assert.equal(trainCost(3, 100, 3)[4], 0);
});

test('the workshop is offered on an S1 season only, and arms production is its in the queue', () => {
  const h = { tier: 1, flags: 0, buildings: [], queue: [] };
  const items = o => o.map(x => x.item);
  assert.ok(!items(buildOffers(h)).includes(8));
  const offers = buildOffers(h, { s1: true });
  const w = offers.find(o => o.item === 8);
  assert.ok(w, 'the workshop is offered');
  assert.equal(w.resource, 'Horses');
  assert.deepEqual(w.cost, [...S1.WORKSHOP.cost]);
  assert.ok(offers.findIndex(o => o.item === 8) < offers.findIndex(o => o.kind === 'walls'), 'before the walls');
  assert.equal(buildItemOf(8), S1.WORKSHOP);
  assert.equal(queueItem({ kind: 1, arg: 4 }), null, 'no MC building makes horses');
  withS1(S1_SEASON, () => {
    assert.equal(queueItem({ kind: 1, arg: 4 }), 8);
    assert.equal(queueBuildingItem({ kind: 1, arg: 4 }), 8);
  });
  assert.notEqual(queueItem({ kind: 1, arg: 0 }), 8);
});

// ---------------------------------------------------------------- the feeds

const place = (kind, tile) => ({ kind, p: 3, q: 0, at: 2, gen: 1, tile });
const CARAVANS = {
  v: 1,
  moving: [{ ownerTag: '18446744073709551615', seq: 0, faction: 1, src: place(1, 20), dst: place(2, 40), steps: 7,
    cargo: [0, 100, 0, 0, 0, 0, 0, 0], arriveTs: 1790000000, runs: [{ p: 3, q: 0, firstBell: 290, n: 2 }], raided: false }],
  vaults: [{ p: 3, q: 0, tile: 40, ownerTag: '9', faction: 1, gen: 1 }],
};
const STRUCTURES = {
  v: 1,
  structures: [
    { p: 3, q: 0, tile: 20, kind: 1, faction: 1, ownerTag: '7', gen: 1, notify: 1, cover: [12, 13, 19, 20, 21, 27, 28], sent: 0 },
    { p: -2, q: 1, tile: 5, kind: 3, faction: 2, ownerTag: '8', gen: 2, notify: 0, cover: [], sent: 300 },
  ],
  sightings: [
    { bell: 290, tower: { p: 3, q: 0, tile: 20 }, towerFaction: 1, notify: 1, ownerTag: '7', what: 'depart', faction: null, p: 3, q: 0, tile: 21, subject: '12', seq: 40 },
    { bell: 291, tower: { p: 3, q: 0, tile: 20 }, towerFaction: 1, notify: 1, ownerTag: '7', what: 'caravan', faction: 2, p: 3, q: 0, tile: 21, subject: 'caravan 5/0', seq: 41 },
  ],
};
const stances = Array.from({ length: 6 }, (_, n) => Array.from({ length: 6 }, (_, f) => (n === 0 && f === 3 ? 1 : 0)));
const NATIONS = {
  v: 1,
  stances,
  proposals: [{ faction: 0, id: 3, slot: 1, kind: 'expel', targetFaction: 0, value: 0, proposerTag: '11', targetTag: '12',
    openBell: 300, closeBell: 444, yes: 3, no: 1, state: 'open' }],
  expelled: [{ tag: '13', faction: 0, since: 445 }],
  domesticRaids: [{ ownerTag: '14', seq: 0, p: 3, q: 0, bell: 450, raiderHost: '15', raiderTag: '16' }],
};
const clone = o => JSON.parse(JSON.stringify(o));
const code = fn => { try { fn(); return null; } catch (e) { return e.code; } };

test('the caravans feed is read as herald/src/caravan.rs writes it', () => {
  const c = parseCaravans(JSON.stringify(CARAVANS));
  assert.deepEqual(c, CARAVANS);
  assert.equal(c.moving[0].ownerTag, '18446744073709551615', 'tags stay exact decimal strings');
  const bad = [
    o => { o.v = 2; },
    o => { o.moving[0].cargo.pop(); },
    o => { o.moving[0].ownerTag = '18446744073709551616'; },
    o => { o.moving[0].ownerTag = 9; },
    o => { o.moving[0].raided = 0; },
    o => { o.moving[0].faction = 6; },
    o => { delete o.moving[0].runs; },
    o => { o.vaults[0].tile = 61; },
  ];
  for (const f of bad) { const o = clone(CARAVANS); f(o); assert.ok(code(() => parseCaravans(o)), String(f)); }
  assert.deepEqual(parseCaravans({ v: 1, moving: [], vaults: [] }), { v: 1, moving: [], vaults: [] });
});

test('the structures feed is read as herald/src/structure.rs writes it', () => {
  const s = parseStructures(STRUCTURES);
  assert.equal(s.structures.length, 2);
  assert.equal(s.structures[1].sent, 300);
  assert.equal(s.sightings[0].faction, null, 'a departing host the herald has not seen');
  assert.equal(s.sightings[1].what, 'caravan');
  const bad = [
    o => { o.structures[0].kind = 4; },
    o => { o.structures[1].cover = [3]; },
    o => { o.structures[0].notify = 2; },
    o => { o.sightings[0].what = 'march'; },
    o => { o.sightings[1].seq = 40; },
    o => { delete o.sightings[0].tower; },
  ];
  for (const f of bad) { const o = clone(STRUCTURES); f(o); assert.ok(code(() => parseStructures(o)), String(f)); }
});

test('the nations feed is read as herald/src/nation.rs writes it', () => {
  const n = parseNations(NATIONS);
  assert.equal(n.stances[0][3], 1);
  assert.equal(n.proposals[0].kind, 'expel');
  assert.equal(n.expelled[0].since, 445);
  assert.equal(n.domesticRaids[0].raiderTag, '16');
  const bad = [
    o => { o.stances.pop(); },
    o => { o.stances[2].push(0); },
    o => { o.stances[1][1] = 3; },
    o => { o.proposals[0].kind = 'unknown'; },
    o => { o.proposals[0].state = 'closed'; },
    o => { o.expelled[0].tag = '-1'; },
    o => { delete o.domesticRaids; },
  ];
  for (const f of bad) { const o = clone(NATIONS); f(o); assert.ok(code(() => parseNations(o)), String(f)); }
});

test('the herald client fetches the S1 feeds from h/', async () => {
  const files = { '/s/h/caravans.json': CARAVANS, '/s/h/structures.json': STRUCTURES, '/s/h/nations.json': NATIONS };
  const seen = [];
  const fetch = async url => {
    seen.push(url);
    const body = files[url];
    return body ? { ok: true, status: 200, json: async () => clone(body) } : { ok: false, status: 404 };
  };
  const h = createHerald({ base: '/s', fetch });
  const [c, s, n] = await Promise.all([h.caravans(), h.structures(), h.nations()]);
  assert.equal(c.ok && c.caravans.vaults[0].ownerTag, '9');
  assert.equal(s.ok && s.structures.structures[0].kind, 1);
  assert.equal(n.ok && n.nations.proposals[0].id, 3);
  const none = createHerald({ base: '/x', fetch });
  assert.equal((await none.caravans()).code, 'NotFound');
  files['/s/h/nations.json'] = { ...NATIONS, v: 9 };
  assert.equal((await h.nations()).ok, false);
});
