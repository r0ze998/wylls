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
    cargo: [0, 100, 0, 0, 0, 0, 0, 0], arriveTs: 1790000000, runs: [{ p: 3, q: 0, firstBell: 290, n: 2 }], raided: false,
    path: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], provinces: [[3, 0], [4, 0]] }],
  vaults: [{ p: 3, q: 0, tile: 40, ownerTag: '9', faction: 1, gen: 1, shares: null }],
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
  assert.deepEqual(c, { ...CARAVANS, moving: [{ ...CARAVANS.moving[0], provinces: [{ p: 3, q: 0 }, { p: 4, q: 0 }] }] });
  const older = clone(CARAVANS); delete older.moving[0].path; delete older.moving[0].provinces;
  assert.equal(parseCaravans(older).moving[0].provinces, null, 'a checkpoint from before the route was published');
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
    o => { o.moving[0].path.pop(); },
    o => { o.moving[0].provinces[1] = [4]; },
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

// ---------------------------------------------------------------- the map's marks

import * as MARKS from '../../permutation-server/web/frontier/map/s1marks.mjs';

const recorder = () => {
  const calls = [];
  const ctx = new Proxy({ globalAlpha: 1 }, { get(t, k) { if (k in t) return t[k]; return (...a) => { calls.push([k, ...a]); }; }, set(t, k, v) { t[k] = v; return true; }, has: (t, k) => k in t });
  return { ctx, calls };
};

test('the marks: the feeds\' vaults, structures and caravans, the viewer\'s own told apart, a caravan placed by its bells', () => {
  const s1 = { caravans: parseCaravans(CARAVANS), structures: parseStructures(STRUCTURES), nations: null };
  const m = MARKS.s1Marks(s1, { own: 9n, bell: 290 });
  assert.deepEqual(m.vaults.map(v => [v.kind, v.own]), [['vault', true]]);
  assert.deepEqual(m.structures.map(s => [s.kind, s.own, s.sent]), [['tower', false, 0], ['fort', false, 300]]);
  const c = m.caravans[0];
  assert.equal(c.own, false);
  assert.equal(c.arriveBell, 292, 'after its last run');
  assert.equal(c.share, 0, 'at its first bell it stands at its origin');
  assert.equal(MARKS.s1Marks(s1, { bell: 291 }).caravans[0].share, 0.5);
  assert.equal(MARKS.s1Marks(s1, { bell: 400 }).caravans[0].share, 1);
  assert.equal(MARKS.s1Marks(s1, { own: 18446744073709551615n }).caravans[0].own, true, 'tags compare exactly beyond 2^53');
  assert.equal(MARKS.s1Marks(s1).caravans[0].share, null, 'no bell, no place');
  assert.deepEqual(MARKS.s1Marks(null), { vaults: [], structures: [], caravans: [] });
  const p = MARKS.caravanPoint({ ...c, share: 0.5 });
  assert.ok(Math.abs(p.x - (p.a.x + p.b.x) / 2) < 1e-9 && Math.abs(p.y - (p.a.y + p.b.y) / 2) < 1e-9);
});

test('the marks are painted: a tower of the viewer\'s nation rims its cover; every figure stands; a caravan is tagged', () => {
  const s1 = { caravans: parseCaravans(CARAVANS), structures: parseStructures(STRUCTURES) };
  const marks = MARKS.s1Marks(s1, { bell: 291 });
  const strokes = faction => { const { ctx, calls } = recorder(); const stood = []; const tags = MARKS.paintS1Marks(ctx, marks, { faction, stand: (x, y, fn) => { stood.push([x, y]); fn(); } }); return { calls, stood, tags }; };
  const mine = strokes(1), other = strokes(4);
  const dashed = r => r.calls.filter(c => c[0] === 'setLineDash').length;
  assert.equal(dashed(mine), 1, 'faction 1 sees its tower\'s watch');
  assert.equal(dashed(other), 0);
  assert.equal(mine.stood.length, 4, 'a vault, two structures and a caravan');
  assert.equal(mine.tags.length, 1);
  assert.match(String(MARKS.caravanTagText(292)), /292/);
  for (const f of [MARKS.paintVault, MARKS.paintStructure, MARKS.paintCaravan]) assert.doesNotThrow(() => f(null, 0, 0, 10));
  for (const kind of ['tower', 'palisade', 'fort']) { const { ctx, calls } = recorder(); MARKS.paintStructure(ctx, 0, 0, 10, { kind, own: true }); assert.ok(calls.some(c => c[0] === 'fill'), kind); }
  assert.notEqual(String(MARKS.S1_WORDS.fort()), '砦', 'a fort is not a conquest keep');
});

// ---------------------------------------------------------------- a caravan's road

import * as CAR from '../../permutation-server/web/frontier/fcaravan.mjs';

test('the caravan planner is caravan.rs\'s: fastest path, packing and step seconds over the Rust vectors', () => {
  const V = JSON.parse(readFileSync(new URL('./fixtures/caravan-path-v1.json', import.meta.url), 'utf8'));
  assert.equal(V.v, 1);
  let found = 0;
  for (const [i, c] of V.cases.entries()) {
    const got = CAR.fastestPath(c.origin, c.dst, c.lands);
    if (c.answer === null) { assert.equal(got, null, `case ${i}: no path`); continue; }
    found++;
    assert.deepEqual(got.dirs, c.answer.dirs, `case ${i}: directions`);
    assert.deepEqual(got.provinces.map(o => [o.p, o.q]), c.answer.provinces, `case ${i}: provinces`);
    assert.deepEqual([...CAR.pack(got.dirs)], c.answer.path, `case ${i}: packed`);
    if (got.dirs.length) assert.deepEqual(CAR.stepSecsOf(c.origin, got.dirs, c.lands), c.answer.atSecs, `case ${i}: seconds`);
  }
  assert.ok(found >= 16);
  assert.equal(CAR.pack(Array(33).fill(0)), null);
  assert.equal(CAR.pack([6]), null);
});

test('the S1 caravan and vault numbers are caravan.rs\'s and travel.rs\'s', () => {
  const rs = readFileSync(new URL('../../permutation-rules/src/frontier/caravan.rs', import.meta.url), 'utf8');
  const tr = readFileSync(new URL('../../permutation-rules/src/frontier/travel.rs', import.meta.url), 'utf8');
  const c = (src, n) => src.match(new RegExp(`pub const ${n}: [^=]+= ([^;]+);`))[1].replace(/_/g, '');
  assert.equal(CAR.CARAVAN_FEE, BigInt(c(rs, 'CARAVAN_FEE')));
  assert.equal(CAR.CARAVAN_SLOW_BPS, Number(c(rs, 'CARAVAN_SLOW_BPS')));
  assert.equal(CAR.MAX_VAULTS, Number(c(rs, 'MAX_VAULTS')));
  assert.deepEqual([...CAR.VAULT_COST], JSON.parse(c(rs, 'VAULT_COST')));
  for (const n of ['FLAT_HEX_SECS', 'ROUGH_HEX_SECS', 'ROAD_BPS', 'MAX_PATH_STEPS', 'MAX_PATH_PROVINCES']) assert.equal(CAR[n], Number(c(tr, n)), n);
});

import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';

test('the S1 accounts\' addresses are fclient\'s (vault, structure, caravan, nation)', () => {
  const V = JSON.parse(readFileSync(new URL('./fixtures/s1-addresses-v1.json', import.meta.url), 'utf8'));
  const A = seasonAddresses(V.program, V.seasonId);
  for (const x of V.vault) assert.equal(A.of('Vault', x), x.address);
  for (const x of V.structure) assert.equal(A.of('Structure', x), x.address);
  for (const x of V.caravan) assert.equal(A.of('Caravan', { ownerTag: BigInt(x.ownerTag), seq: x.seq }), x.address);
  for (const x of V.nation) assert.equal(A.of('Nation', x), x.address);
});

import { accountsFor, buildShape, placeData, raidProvinces, cargoBytes, RAID_CHOICE, SIGNED_BY } from '../../permutation-server/web/frontier/fplay.mjs';
import { frontierIx, classify } from '../../permutation-server/web/sdk/frontier/shapes.mjs';
import { wireTransaction, parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';

/** The S1 shapes this page sends, as the vectors' inputs (fclient caravan_path_vectors.rs s1_instruction_vectors). */
function s1Shapes(V, A) {
  const h = { p: 3, q: -1, site: 4 };
  const raider = { p: 5, q: -2, site: 1 };
  const caravan = A.of('Caravan', { ownerTag: 77n, seq: 1 });
  const take = { raid: { p: 4, q: -2 }, dst: { kind: 'holding', ...raider, gen: 2 }, pathProvinces: [{ p: 5, q: -2 }], oldRoute: [{ p: 3, q: -1 }, { p: 4, q: -2 }, { p: 4, q: -1 }] };
  const burn = { raid: take.raid, dst: null, oldRoute: take.oldRoute };
  const raidFields = (r, choice, steps, dirs) => ({ p: r.raid.p, q: r.raid.q, choice, n_path: raidProvinces(r).nPath,
    ...(r.dst ? placeData(r.dst) : { dst_kind: 0, dst_p: 0, dst_q: 0, dst_at: 0, dst_gen: 0 }), steps, path: CAR.pack(dirs) });
  const dst = { kind: 'vault', p: 4, q: -2, tile: 17, gen: 3 };
  return [
    ['BuildVault', { holding: h, at: { p: 3, q: -1, tile: 20 } }, { tile: 20 }],
    ['BuildVault', { holding: h, at: { p: 4, q: -1, tile: 0 } }, { tile: 0 }],
    ['BuildStructure', { holding: h, at: { p: 3, q: -1, tile: 21 } }, { kind: 1, tile: 21, notify: 1 }],
    ['BuildStructure', { holding: h, at: { p: 4, q: -1, tile: 9 } }, { kind: 3, tile: 9, notify: 0 }],
    ['FortGarrison', { holding: h, tile: 21 }, { troops: 250 }],
    ['SendCaravan', { seq: 2, src: { kind: 'holding', ...h, gen: 1 }, dst, provinces: [{ p: 3, q: -1 }, { p: 4, q: -2 }] },
      { seq: 2, ...placeData(dst), steps: 3, path: CAR.pack([0, 1, 5]), cargo: cargoBytes([0, 100, 50, 0, 7, 0, 0, 0]), fee: 50000n }],
    ['RaidCaravan', { caravan, raider, ...take }, raidFields(take, RAID_CHOICE.take, 2, [3, 3])],
    ['RaidCaravan', { caravan, raider, ...burn }, raidFields(burn, RAID_CHOICE.burn, 0, [])],
    ['Propose', { faction: 2 }, { kind: 1, target_faction: 4, value: 2 }],
    ['Propose', { faction: 2, target: V.target }, { kind: 2, target_faction: 2, value: 0 }],
    ['Vote', { faction: 2 }, { slot: 1, id: 9, yes: 1 }],
  ];
}

test('the S1 shapes are fclient\'s instructions, key for key and byte for byte, and the relay takes them', () => {
  const V = JSON.parse(readFileSync(new URL('./fixtures/s1-ix-v1.json', import.meta.url), 'utf8'));
  const A = seasonAddresses(V.program, V.seasonId);
  const shapes = s1Shapes(V, A);
  assert.equal(shapes.length, V.cases.length);
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  // an S1 season pinned (profile 3: RULESET_HASH_V3)
  assert.equal(io.setPin({ programId: V.program, cluster: 'localnet', seasonId: V.seasonId, rulesetHash: rulesetFor(3) }).profile, 3);
  shapes.forEach(([name, v, fields], i) => {
    const want = V.cases[i];
    assert.equal(name, want.name);
    assert.equal(SIGNED_BY[name], 'session');
    const accounts = accountsFor(name, { addresses: A, wallet: V.wallet, actor: V.actor, profile: 3, ...v });
    const ix = frontierIx(V.program, name, { ...accounts, payer: V.payer }, fields, 3);
    assert.equal(hex(ix.data), want.data, `${name} #${i}: data`);
    assert.deepEqual(ix.keys.map(k => k.pubkey), want.keys.map(k => k[0]), `${name} #${i}: accounts`);
    // a key's privileges are those of the message (duplicates merged), as the program sees them
    const merged = keys => { const m = new Map(); for (const [k, s, w] of keys) { const o = m.get(k) ?? [false, false]; m.set(k, [o[0] || s, o[1] || w]); } return m; };
    assert.deepEqual(merged(ix.keys.map(k => [k.pubkey, k.isSigner, k.isWritable])), merged(want.keys), `${name} #${i}: privileges`);
    const { message } = buildShape({ programId: V.program, name, accounts, fields, feePayer: V.payer, blockhash: V.program, profile: 3 });
    const wire = wireTransaction(message), r = classify(parseTransaction(wire), { programId: V.program, wireBytes: wire.length, profile: 3 });
    assert.equal(r.ok, true, `${name} #${i}: ${r.problem}`);
    // and the page's own pre-signing check lets it through
    const problems = io.messageProblems(message, { feePayer: V.payer, blockhash: V.program, tag: ix.data[0], signers: [V.actor], cuLimit: null, loadedLimit: null, expected: ix });
    assert.deepEqual(problems, [], `${name} #${i}`);
  });
});

// ---------------------------------------------------------------- the play screens (screens/s1.mjs) and their orders

import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';

const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile, units = 1000) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => store(units)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [] });
const prov = (p, q, extra = {}) => ({ p, q, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 2, sites: [5, 6], camp: { state: 1, tile: 7 }, keep: { tile: 8, holder: 1 }, resolvedNext: 10, structures: [], forts: [], caravans: [], ...extra });
const world = (extra = {}) => ({ mode: 'play', nowBell: 100, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 0, caravans: 4, voted: [0, 0, 0, 0] },
  holdings: [holding(0, 0, 0, 30), holding(1, 0, 2, 20)], activeHolding: 0, provinces: new Map(), s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [], sightings: [] }, nations: null }, ...extra });

test('a tile takes a storehouse or a structure only where the program allows it, paid from the village in hand', () => {
  const P = prov(0, 0);
  assert.equal(SCR.siteProblem(P, 30), null);
  assert.equal(SCR.siteProblem(P, 5), 'Site');
  assert.equal(SCR.siteProblem(P, 7), 'Camp');
  assert.equal(SCR.siteProblem(P, 8), 'Keep');
  assert.equal(SCR.siteProblem({ ...P, passableMask: ALL ^ (1n << 30n) }, 30), 'Impassable');
  assert.equal(SCR.siteProblem(null, 30), 'Unknown');
  const fs = world({ provinces: new Map([['0,0', { province: P }]]) });
  const m = SCR.s1TileModel(fs, { p: 0, q: 0, idx: 31 });
  assert.deepEqual(m.build.vault.blocks, []);
  assert.deepEqual(m.build.structures.map(s => s.blocks), [[], [], []]);
  const poor = SCR.s1TileModel({ ...fs, holdings: [holding(0, 0, 0, 30, 10)] }, { p: 0, q: 0, idx: 31 });
  assert.ok(poor.build.vault.blocks.includes('Insufficient'));
  const full = SCR.s1TileModel({ ...fs, citizen: { ...fs.citizen, vaults: 3, forts: 1 } }, { p: 0, q: 0, idx: 31 });
  assert.ok(full.build.vault.blocks.includes('VaultLimit'));
  assert.ok(full.build.structures[2].blocks.includes('StructureLimit'));
  const crowded = SCR.s1TileModel({ ...fs, provinces: new Map([['0,0', { province: { ...P, forts: [{ state: 1 }, { state: 1 }] } }]]) }, { p: 0, q: 0, idx: 31 });
  assert.deepEqual(crowded.build.structures.map(s => s.blocks.includes('StructureFull')), [false, false, true], 'two forts fill a province');
  const taken = SCR.s1TileModel({ ...fs, s1: { ...fs.s1, caravans: { moving: [], vaults: [{ p: 0, q: 0, tile: 31, ownerTag: '9', faction: 2, gen: 1 }] } } }, { p: 0, q: 0, idx: 31 });
  assert.ok(taken.build.vault.blocks.includes('Taken'));
  assert.equal(taken.vault.faction, 2);
  assert.match(String(SCR.renderS1Tile(fs, { p: 0, q: 0, idx: 31 })), /data-act="s1-vault"[^>]*data-tile="31"/);
  assert.match(String(SCR.renderS1Tile(fs, { p: 0, q: 0, idx: 31 })), /data-act="s1-structure"[^>]*data-kind="3"/);
  assert.match(String(SCR.renderS1Tile(fs, { p: 0, q: 0, idx: 5 })), /data-act="s1-vault"[^>]*data-tile="5" disabled>/, 'on a village\'s site the offer stands, disabled');
  assert.doesNotMatch(String(SCR.renderS1Tile(fs, { p: 0, q: 0, idx: 31 })), /data-act="s1-vault"[^>]*disabled/);
});

test('a raid the viewer\'s host has won is offered on its tile until its window closes', () => {
  const c = { ownerTag: '77', seq: 1, faction: 2, src: { p: 0, q: 0, tile: 1 }, dst: { p: 2, q: 0, tile: 1 }, runs: [], raided: false, provinces: [{ p: 0, q: 0 }, { p: 1, q: 0 }] };
  const raider = hostId({ p: 1, q: 0, site: 2, gen: 1, seq: 3 });
  const slot = { id: SCR.caravanId(77n, 1), faction: 2, n: 3, raidOff: 1, raidPos: 0, firstBell: 98, tiles: [10, 11, 12, 0, 0, 0, 0, 0], raider };
  const fs = world({ provinces: new Map([['1,0', { province: prov(1, 0, { caravans: [slot, { id: 0n }] }) }]]), s1: { caravans: { moving: [c], vaults: [] } } });
  const r = SCR.raidOffers(fs);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].p, r[0].q, r[0].tile, r[0].slot, r[0].raidBell, r[0].decideBy, r[0].open], [1, 0, 11, 0, 99, 105, true]);
  assert.equal(SCR.raidOffers({ ...fs, nowBell: 106 })[0].open, false);
  assert.equal(SCR.raidOffers({ ...fs, holdings: [holding(0, 0, 0, 30)] }).length, 0, 'another\'s host');
  assert.equal(SCR.raidOffers({ ...fs, provinces: new Map([['1,0', { province: prov(1, 0, { caravans: [{ ...slot, raidOff: SCR.RAID_SETTLED }] }) }]]) }).length, 0, 'settled');
  assert.match(String(SCR.renderS1Tile(fs, { p: 1, q: 0, idx: 11 })), /data-act="s1-raid"[^>]*data-choice="take"/);
  assert.equal(SCR.caravanId(77n, 1), (1n << 63n) | (77n << 16n) | 1n);
});

test('the village offers caravans to its other places, its fort, and its nation\'s votes', () => {
  const tag = 5n;
  const fs = world({ provinces: new Map([['0,0', { province: prov(0, 0, { forts: [{ tile: 33, state: 1, troops: 150000, pend: 20 }] }) }]]),
    s1: { caravans: { moving: [{ ownerTag: '5', seq: 0, faction: 1, runs: [{ p: 0, q: 0, firstBell: 99, n: 4 }], raided: false }], vaults: [{ p: 0, q: 1, tile: 9, ownerTag: '5', faction: 1, gen: 2 }] },
      structures: { structures: [{ p: 0, q: 0, tile: 33, kind: 3, faction: 1, ownerTag: '5', gen: 1, notify: 0, cover: [], sent: 170 }], sightings: [] },
      nations: { stances: Array.from({ length: 6 }, () => Array(6).fill(0)).map((r, n) => (n === 1 ? [0, 0, 2, 1, 0, 0] : r)),
        proposals: [{ faction: 1, id: 7, slot: 2, kind: 'stance', targetFaction: 4, value: 1, yes: 2, no: 0, closeBell: 120, state: 'open' }, { faction: 2, id: 1, slot: 0, kind: 'stance', targetFaction: 1, value: 0, yes: 0, no: 0, closeBell: 120, state: 'open' }], expelled: [], domesticRaids: [] } } });
  // the viewer's tag (people/ui ownTag: a holding's owner)
  fs.holdings.forEach(h => { h.ownerCitizen = new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0, ...Array(24).fill(0)]); });
  const m = SCR.s1VillageModel(fs);
  assert.equal(SCR.viewerTag(fs), tag);
  assert.deepEqual(m.destinations, [{ kind: 'holding', p: 1, q: 0, site: 2, gen: 1 }, { kind: 'vault', p: 0, q: 1, tile: 9, gen: 2 }]);
  assert.equal(m.caravans[0].arriveBell, 103);
  assert.deepEqual(m.forts.map(f => [f.tile, f.troops, f.room]), [[33, 170, 1830]]);
  assert.equal(m.spearmen, 300);
  assert.deepEqual(m.nation.stances.map(s => s.stance), ['war', 'ally', 'pass', 'war', 'war']);
  assert.deepEqual(m.nation.proposals.map(x => [x.id, x.voted, x.closesIn]), [[7, false, 20]], 'its own nation\'s open proposals');
  const html = String(SCR.renderS1Village(fs));
  for (const f of ['s1-caravan', 's1-fort', 's1-propose']) assert.match(html, new RegExp(`data-form="${f}"`));
  assert.match(html, /data-act="s1-vote"[^>]*data-id="7"[^>]*data-yes="1"/);
  const voted = SCR.s1VillageModel({ ...fs, citizen: { ...fs.citizen, voted: [0, 0, 7, 0] } });
  assert.equal(voted.nation.proposals[0].voted, true);
  assert.match(String(SCR.proposalText(m.nation.proposals[0])), /通行を許す/);
});

test('a caravan is sent along the fastest road, and a raid taken home, as SendCaravan and RaidCaravan', async () => {
  const saved = { ...FS };
  const sent = [];
  const V = JSON.parse(readFileSync(new URL('./fixtures/s1-addresses-v1.json', import.meta.url), 'utf8'));
  io.setPin({ programId: V.program, cluster: 'localnet', seasonId: V.seasonId, rulesetHash: rulesetFor(3) });
  const wallet = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
  try {
    const provinces = new Map();
    for (const c of CAR.landsWanted({ p: 0, q: 0 }, { p: 1, q: 0 })) provinces.set(`${c.p},${c.q}`, { province: prov(c.p, c.q) });
    Object.assign(FS, world({ provinces }), { wallet: { address: wallet }, session: { publicKey: V.program, sign: async () => new Uint8Array(64) }, notice: null, inFlight: 0 });
    C.useTransport({ submit: async req => { sent.push(req); return { ok: false, code: 'Stop' }; } });
    await C.FORMS['s1-caravan']({ elements: { dst: { value: '0' }, c1: { value: '120' }, c2: { value: '0' } } });
    assert.equal(sent.length, 1);
    const q = sent[0];
    assert.equal(q.name, 'SendCaravan');
    assert.equal(q.fields.seq, 4, 'the Citizen\'s next caravan');
    assert.equal(q.fields.fee, CAR.CARAVAN_FEE);
    assert.deepEqual([q.fields.dst_kind, q.fields.dst_p, q.fields.dst_q, q.fields.dst_at, q.fields.dst_gen], [1, 1, 0, 2, 1]);
    const plan = CAR.fastestPath({ p: 0, q: 0, tile: 30 }, { p: 1, q: 0, tile: 20 }, [...provinces.values()].map(e => CAR.landOfProvince(e.province)));
    assert.equal(q.fields.steps, plan.dirs.length);
    assert.deepEqual([...q.fields.path], [...CAR.pack(plan.dirs)]);
    assert.equal(new DataView(q.fields.cargo.buffer).getUint32(4, true), 120);
    const A = io.pinned().addresses;
    assert.deepEqual(q.accounts.path_province, plan.provinces.map(p => A.of('Province', p)));
    // nothing to carry, or more than the village has: refused before anything is built
    await C.FORMS['s1-caravan']({ elements: { dst: { value: '0' } } });
    await C.FORMS['s1-caravan']({ elements: { dst: { value: '0' }, c1: { value: '5000' } } });
    assert.equal(sent.length, 1);
    // a raid won by the host of the village at (1, 0): taken home
    const raider = hostId({ p: 1, q: 0, site: 2, gen: 1, seq: 3 });
    const c = { ownerTag: '77', seq: 1, faction: 2, runs: [], raided: false, provinces: [{ p: 0, q: 0 }, { p: 1, q: 0 }, { p: 1, q: -1 }] };
    FS.provinces.set('1,0', { province: prov(1, 0, { caravans: [{ id: SCR.caravanId(77n, 1), raidOff: 0, firstBell: 99, tiles: [40], raider }] }) });
    FS.s1 = { ...FS.s1, caravans: { moving: [c], vaults: [] } };
    await C.ACTIONS['s1-raid']({ p: '1', q: '0', slot: '0', choice: 'take' });
    const r = sent[1];
    assert.equal(r.name, 'RaidCaravan');
    assert.equal(r.fields.choice, 0);
    assert.equal(r.accounts.caravan, A.of('Caravan', { ownerTag: 77n, seq: 1 }));
    assert.equal(r.accounts.path_province[0], A.of('Province', { p: 1, q: 0 }), 'the raid\'s Province first');
    assert.ok(r.accounts.path_province.includes(A.of('Province', { p: 1, q: -1 })), 'the old route\'s others after');
    await C.ACTIONS['s1-raid']({ p: '1', q: '0', slot: '0', choice: 'burn' });
    assert.equal(sent[2].fields.choice, 1);
    assert.equal(sent[2].accounts.path_province.length, 1);
  } finally {
    C.useTransport(null);
    Object.assign(FS, saved);
  }
});

test('the structure and raid numbers the panels offer by are structure.rs\'s and caravan.rs\'s', () => {
  const st = readFileSync(new URL('../../permutation-rules/src/frontier/structure.rs', import.meta.url), 'utf8');
  const cv = readFileSync(new URL('../../permutation-rules/src/frontier/caravan.rs', import.meta.url), 'utf8');
  const c = (src, n) => src.match(new RegExp(`pub const ${n}: [^=]+= ([^;]+);`))[1].replace(/_/g, '');
  for (const [kind, name] of [[1, 'KIND_TOWER'], [2, 'KIND_PALISADE'], [3, 'KIND_FORT']]) {
    assert.equal(Number(c(st, name)), kind);
    assert.deepEqual([...SCR.STRUCTURE_COST[kind]], JSON.parse(st.match(new RegExp(`${name} => (\\[[^\\]]+\\])`))[1]), `${name} cost`);
    assert.equal(SCR.STRUCTURE_MAX[kind], Number(st.match(new RegExp(`${name} => (\\d+),`))[1]), `${name} max`);
  }
  assert.equal(SCR.PROVINCE_STRUCTURES, Number(c(st, 'PROVINCE_STRUCTURES')));
  assert.equal(SCR.PROVINCE_FORTS, Number(c(st, 'PROVINCE_FORTS')));
  assert.equal(SCR.FORT_MAX_TROOPS, Number(c(st, 'FORT_MAX_TROOPS')));
  assert.equal(SCR.RAID_NONE, Number(c(cv, 'RAID_NONE')));
  assert.equal(SCR.RAID_SETTLED, Number(c(cv, 'RAID_SETTLED')));
  assert.equal(SCR.RAID_DECIDE_BELLS, Number(c(cv, 'RAID_DECIDE_BELLS')));
});
