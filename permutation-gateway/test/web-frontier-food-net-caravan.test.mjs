// food-net-caravan (owner 2026-11-25 21:22; page only, no rule changed):
//  Q-LP17-2  the food rate of the first village is shown NET of the land upkeep, with the land's part beside it —
//            "−32.27/h (land −72.27)" — in the top bar, its hover text, the resource popovers and the village's
//            ledger. The number is the program's: TerritoryPlayer::upkeep_per_hour through the page's mirror
//            (flocalplay-territory.mjs decodeTerritoryPlayer), checked here against the Rust constants (×30) and the
//            kernel mirror territory-rules.mjs.
//  Q-LP17-4  under the fog a caravan's destinations are the viewer's own places, the viewer's NATION's villages and
//            storehouses, and the villages and storehouses IN SIGHT NOW — not every village of the provinces the
//            page has read. A ① request's published place stays (fix-loop8 LP8-3). The send checks the chosen place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as LF from '../../permutation-server/web/frontier/landfood.mjs';
import * as T from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import * as K from '../../permutation-server/web/frontier/territory-rules.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import { holdingModel, renderLedger } from '../../permutation-server/web/frontier/screens/holding.mjs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import * as FOG from '../../permutation-server/web/frontier/map/fog.mjs';
import * as CAR from '../../permutation-server/web/frontier/fcaravan.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const rust = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

// ------------------------------------------------------------------ Q-LP17-2: net food
/** A territory summary record (frontier-abi territory_player layout: CITIZEN_TAG @84, TILES @92, EXCESS_SUM @96). */
function summaryBytes({ tiles = 0, excess = 0n } = {}) {
  const b = new Uint8Array(320), v = new DataView(b.buffer);
  b.set([...'PSFXWTU1'].map(c => c.charCodeAt(0))); b[18] = 1;
  v.setBigUint64(84, 77n, true); v.setUint32(92, tiles, true); v.setBigUint64(96, excess, true);
  return b;
}
const RUST_UPKEEP = (() => {
  const m = /flat: (\d+),\s+per_rank: (\d+),\s+per_distance: (\d+),\s+free_distance: (\d+),/.exec(rust('frontier-abi/src/world_index/territory.rs'));
  assert.ok(m, 'TERRITORY_V1 upkeep curve in frontier-abi');
  return { flat: Number(m[1]), perRank: Number(m[2]), perDistance: Number(m[3]), freeDistance: Number(m[4]) };
})();
const store = (value, perHour, cap) => ({ value: value * 1000, frac: 0, rate: perHour * 1000, cap: cap * 1000, t0: 0 });
const village = (p, q, site, order, food = 40) => ({ p, q, site, order, tier: 0, stores: [store(11, food, 2000), store(300, 30, 2000), store(0, 0, 2000)] });
const landOf = (tiles, excess = 0n) => ({ world: 'w', citizen: 'c', player: T.decodeTerritoryPlayer(summaryBytes({ tiles, excess })), at: 0 });

test('the land upkeep is the program\'s number (×30 constants), charged to the first village only', () => {
  assert.deepEqual({ ...T.TERRITORY_V1.upkeep }, RUST_UPKEEP, 'the page\'s mirror holds the Rust curve');
  assert.equal(RUST_UPKEEP.flat, 990, 'upkeep ×30 (#235): 0.99 food per hour a tile');
  const home = village(65, -128, 3, 1), second = village(64, -127, 5, 2);
  // loop-play17: 73 tiles near home = 72.27 food per hour (the card's own line)
  const fs = { holdings: [home, second], ownLand: landOf(73) };
  assert.equal(LF.landUpkeepMilli(fs, home), 73 * RUST_UPKEEP.flat);
  assert.equal(LF.landUpkeepMilli(fs, home), K.upkeepPerHour(RUST_UPKEEP, Array(73).fill(0)), 'the kernel mirror\'s answer for 73 tiles within the free distance');
  assert.equal(LF.landUpkeepMilli(fs, second), 0, 'another village of the viewer pays no land upkeep');
  assert.equal(LF.landUpkeepMilli(fs, { ...home }), 73 * 990, 'the village is told by its place, not by the object (the strip settles a copy)');
  // tiles beyond the free distance: the record's Σ excess × per_distance (two tiles at distance 5: excess 2 each)
  const far = { holdings: [home], ownLand: landOf(3, 4n) };
  assert.equal(LF.landUpkeepMilli(far, home), K.upkeepPerHour(RUST_UPKEEP, [0, 5, 5]));
  assert.equal(LF.landUpkeepMilli(far, home), 3 * 990 + 4 * 480);
  // no record yet, no tile, no territory world: nothing changes
  for (const ownLand of [undefined, { player: null }, landOf(0)]) assert.equal(LF.landUpkeepMilli({ holdings: [home], ownLand }, home), 0);
  assert.equal(LF.landUpkeepMilli(fs, null), 0);
  // a world whose holdings carry no order (one village): that village pays
  assert.equal(LF.landUpkeepMilli({ holdings: [{ ...home, order: undefined }], ownLand: landOf(10) }, home), 9900);
});

test('a food row becomes net, with the village\'s and the land\'s parts; nothing else moves', () => {
  const food = { resource: 'Food', value: 11, cap: 2000, perHour: 40 };
  assert.deepEqual(LF.withLand(food, 72_270), { resource: 'Food', value: 11, cap: 2000, perHour: -32.27, villagePerHour: 40, landPerHour: 72.27 });
  assert.deepEqual(LF.withLand({ ...food, perHour: 112 }, 72_000), { resource: 'Food', value: 11, cap: 2000, perHour: 40, villagePerHour: 112, landPerHour: 72 });
  assert.equal(LF.withLand(food, 0), food, 'no land: the same row');
  const wood = { resource: 'Wood', value: 1, cap: 2, perHour: 30 };
  assert.equal(LF.withLand(wood, 72_270), wood, 'the land takes food only (TERRITORY_V1.upkeepResource 0)');
  assert.equal(T.TERRITORY_V1.upkeepResource, 0);
  assert.equal(LF.withLand({ ...food, perHour: 40 }, 270).perHour, 39.73, 'thousandths, never 39.730000000000004');
});

test('the words: "+40/h (land −72)" in English, 「+40/時（土地 −72）」 in Japanese', () => {
  try {
    setLang('ja');
    const owner = LF.withLand({ resource: 'Food', perHour: 112 }, 72_000), lp17 = LF.withLand({ resource: 'Food', perHour: 40 }, 72_270);
    assert.equal(`${LF.signedNet(owner.perHour)}/時${LF.landPart(owner)}`, '+40/時（土地 −72）');
    assert.equal(`${LF.signedNet(lp17.perHour)}${LF.landPart(lp17)}`, '−32.27（土地 −72.27）');
    assert.equal(LF.landSplit(lp17), '（村 +40 · 土地 −72.27）');
    assert.equal(LF.landPart({ resource: 'Food', perHour: 40 }), '', 'no land part: no words');
    setLang('en');
    assert.equal(`${LF.signedNet(owner.perHour)}/h${LF.landPart(owner)}`, '+40/h (land −72)', 'the owner\'s own example');
    assert.equal(LF.landPart(lp17), ' (land −72.27)');
    assert.equal(LF.landSplit(lp17), ' (village +40 · land −72.27)');
  } finally { setLang('ja'); }
});

test('the top bar, its hover text and the popovers show the net food of the first village', () => {
  const home = village(65, -128, 3, 1), second = village(64, -127, 5, 2, 20);
  const fs = { holdings: [home, second], ownLand: landOf(73) };
  const of = h => LF.landUpkeepMilli(fs, h);
  try {
    setLang('en');
    const tokens = hud.resourceModel(home, 0, { land: of(home) });
    const food = tokens.find(r => r.resource === 'Food');
    assert.deepEqual([food.perHour, food.villagePerHour, food.landPerHour, food.fullIn], [-32.27, 40, 72.27, null], 'net; a store that falls is never "full in"');
    assert.equal(tokens.find(r => r.resource === 'Wood').landPerHour, undefined);
    // (fix-loop18 LP18-7: a falling store now says when it is empty at this rate)
    assert.equal(hud.resourceTitle(food), 'Food 11 / 2,000 · −32.27 per hour (village +40 · land −72.27) · Empty in 20:28');
    const strip = String(hud.renderStrip(tokens));
    assert.match(strip, /<span class="res-rate res-rate-land">−32\.27\/h \(land −72\.27\)<\/span>/);
    assert.match(strip, /<span class="res-rate">\+30\/h<\/span>/, 'wood as before');
    // without the land (no record, another village): exactly as before
    assert.deepEqual(hud.resourceModel(home, 0), hud.resourceModel(home, 0, { land: 0 }));
    assert.match(hud.resourceTitle(hud.resourceModel(home, 0)[0]), /^Food 11 \/ 2,000 · \+40 per hour · Full in /);
    assert.doesNotMatch(String(hud.renderStrip(hud.resourceModel(second, 0, { land: of(second) }))), /land/);
    // the popovers: the paying village's row and the sum are net; the other village's row is its own
    const b = hud.resourceBreakdown(fs.holdings, 'Food', 0, of);
    assert.deepEqual([b.perHour, b.villagePerHour, b.landPerHour], [-12.27, 60, 72.27]);
    assert.deepEqual(b.rows.map(r => [r.perHour, r.landPerHour ?? null]), [[-32.27, 72.27], [20, null]]);
    const pop = String(hud.renderBreakdown(b));
    assert.match(pop, /Total 22 · −12\.27 per hour \(land −72\.27\)/);
    assert.match(pop, /−32\.27 per hour \(land −72\.27\)/);
    assert.match(pop, /\+20 per hour/);
    assert.match(pop, /(&quot;|")Land(&quot;|") is the upkeep of your land\. It is paid from your first village(&#39;|')s food every turn\./);
    assert.doesNotMatch(String(hud.renderBreakdown(hud.resourceBreakdown(fs.holdings, 'Wood', 0, of))), /res-land-note|\(land −/, 'no land note on another resource');
    const all = String(hud.renderAllBreakdowns(hud.allBreakdowns(fs.holdings, 0, of)));
    assert.match(all, /−12\.27 per hour \(land −72\.27\)/);
    assert.deepEqual(hud.resourceBreakdown(fs.holdings, 'Food', 0), { resource: 'Food', name: 'Food', total: 22, perHour: 60, rows: b.rows.map((r, i) => ({ holding: r.holding, value: 11, cap: 2000, perHour: i ? 20 : 40, fullIn: r.holding === home ? hud.resourceModel(home, 0)[0].fullIn : hud.resourceModel(second, 0)[0].fullIn, state: 'ok' })) }, 'no landOf: as before');
    setLang('ja');
    const ja = hud.resourceModel(home, 0, { land: of(home) });
    assert.equal(hud.resourceTitle(ja[0]), '食料 11 / 2,000 · 毎時 −32.27（村 +40 · 土地 −72.27） · 空になるまで 20:28');
    assert.match(String(hud.renderStrip(ja)), /−32\.27\/時（土地 −72\.27）/);
    assert.match(String(hud.renderBreakdown(hud.resourceBreakdown(fs.holdings, 'Food', 0, of))), /「土地」は、あなたの土地の維持費です。最初の村の食料から、ターンごとに払われます。/);
  } finally { setLang('ja'); }
  // the page hands the land to all three surfaces
  const app = web('frontier/app.mjs');
  assert.ok(app.includes("hud.resourceModel(settledHolding(hud.activeHolding(FS), now ?? 0), now ?? 0, { land: landUpkeepMilli(FS, hud.activeHolding(FS)) })"));
  assert.ok(app.includes('hud.allBreakdowns(FS.holdings ?? [], now, h => landUpkeepMilli(FS, h))'));
  assert.ok(app.includes('hud.resourceBreakdown(FS.holdings ?? [], FS.resOpen, now, h => landUpkeepMilli(FS, h))'));
});

test('the village ledger: the first village\'s food row is net, with one line saying so', () => {
  const full8 = (food, cap = 2000) => [store(11, food, cap), ...Array.from({ length: 7 }, () => store(5, 0, 2000))];
  const h = { p: 65, q: -128, site: 3, order: 1, tile: 30, gen: 1, state: 2, tier: 0, faction: 1, stores: full8(40), production: Array(8).fill(0), upkeep: Array(8).fill(0), reserve: Array(8).fill(0), queue: [], transit: [], buildings: Array(8).fill(0), lastActionTs: 0, shieldUntil: 0, finalTs: 0, flags: 0 };
  const fs = { mode: 'play', nowBell: 100, chain: { now: () => 0 }, citizen: { faction: 1 }, holdings: [h], activeHolding: 0, provinces: new Map(), ownLand: landOf(73), season: { genesisTs: 0, dormantAfterSecs: 10 ** 9, releaseAfterSecs: 10 ** 9, shieldSecs: 0 } };
  const m = holdingModel(fs);
  assert.deepEqual([m.stores[0].perHour, m.stores[0].landPerHour, m.stores[0].value], [-32.27, 72.27, 11], 'the amount is the record\'s; the rate is net');
  assert.equal(m.have[0], 11);
  try {
    setLang('en');
    assert.match(String(renderLedger(m.stores)), /<td class="ledger-rate"><span class="ledger-net ledger-net-neg">−32\.27\/h<span class="ledger-land"> \(land −72\.27\)<\/span><\/span><\/td>/);
    setLang('ja');
    assert.match(String(renderLedger(m.stores)), /−32\.27\/時<span class="ledger-land">（土地 −72\.27）<\/span>/);
    // a full store still shows what the land takes
    const fullRow = String(renderLedger([LF.withLand({ resource: 'Food', value: 2000, cap: 2000, perHour: 112 }, 72_000)]));
    assert.match(fullRow, /満杯/); assert.match(fullRow, /<span class="ledger-net">\+40\/時<span class="ledger-land">（土地 −72）<\/span>/);
  } finally { setLang('ja'); }
  // no land record: the row as it was
  const plain = holdingModel({ ...fs, ownLand: undefined });
  assert.equal(plain.stores[0].perHour, 40);
  assert.match(String(renderLedger(plain.stores)), /<td class="ledger-rate">\+40\/時<\/td>/);
  const src = web('frontier/screens/holding.mjs');
  assert.ok(src.includes('id="hp-land-food"'), 'the resources card says the food rate is after the land upkeep');
  // Q-LP17-3: the unpaid warning's words are kept as they are
  assert.ok(src.includes('L`土地の維持費（本拠地の食料）が払えていません。新しいマスは取れません。あと ${fmtNum(land.turnsLeft)} ターン払えないままだと、遠いマスから1ターンに1つずつ手放されます。`'));
});

// ------------------------------------------------------------------ Q-LP17-4: caravan destinations
const ALL = (1n << 61n) - 1n;
const bstore = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => bstore(1000)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [],
  ownerCitizen: new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0, ...Array(24).fill(0)]) });
const prov = (p, q, extra = {}) => ({ p, q, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 2, sites: [5, 6], camp: { state: 1, tile: 7 }, keep: { tile: 8, holder: 1 }, resolvedNext: 10, structures: [], forts: [], caravans: [], ...extra });
const world = (extra = {}) => ({ mode: 'play', nowBell: 100, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 0, caravans: 4, voted: [0, 0, 0, 0] },
  holdings: [holding(0, 0, 0, 30), holding(1, 0, 2, 20)], activeHolding: 0, provinces: new Map(), s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [], sightings: [] }, nations: null }, ...extra });
/** The page's fog view with exactly `seen` ("p,q,tile") in sight now (L3); everything else surveyed before (L2). */
const fogWith = seen => FOG.createFogger({ storage: null })({ active: true, survey: { rev: 1, showAll: false, levelOf: (p, q, t) => (seen.includes(`${p},${q},${t}`) ? 3 : 2), province: () => ({ max: 2 }) } });
// provinces the page has read: (1,0) another nation's village on tile 5 and a NATION-MATE's on tile 6; (5,0) two other
// nations' villages on tiles 5 and 6; storehouses of nation 4 at (3,0) tile 9 and of the viewer's nation at (2,0) tile 3
const fogWorld = () => world({
  provinces: new Map([['0,0', { province: prov(0, 0, { siteMirror: [{ state: 1, faction: 1 }, { state: 0 }] }) }],
    ['1,0', { province: prov(1, 0, { siteMirror: [{ state: 1, faction: 2 }, { state: 1, faction: 1 }] }) }],
    ['5,0', { province: prov(5, 0, { siteMirror: [{ state: 1, faction: 6 }, { state: 1, faction: 3 }] }) }]]),
  s1: { caravans: { moving: [], vaults: [{ p: 3, q: 0, tile: 9, ownerTag: '9', faction: 4, gen: 2 }, { p: 2, q: 0, tile: 3, ownerTag: '8', faction: 1, gen: 1 }] }, structures: { structures: [], sightings: [] }, nations: null } });
const others = m => m.destinations.filter(d => d.other).map(d => `${d.kind}:${d.p},${d.q}:${d.kind === 'vault' ? d.tile : d.site}:f${d.faction}`);

test('without fog every read village and storehouse is listed, as before', () => {
  FOG.resetFogNow();
  assert.deepEqual(others(SCR.s1VillageModel(fogWorld())), ['holding:1,0:0:f2', 'holding:1,0:1:f1', 'vault:2,0:3:f1', 'vault:3,0:9:f4', 'holding:5,0:0:f6', 'holding:5,0:1:f3']);
  assert.equal(SCR.otherPlaceOffered(fogWorld(), { p: 5, q: 0, tile: 5, faction: 6 }), true);
});

test('under the fog: the viewer\'s own places, the nation\'s, and what is in sight now — nothing else', () => {
  try {
    // nothing of the others in sight: only the nation-mate's village and the nation's storehouse
    fogWith([]);
    const fs = fogWorld();
    const m = SCR.s1VillageModel(fs);
    assert.deepEqual(m.destinations.filter(d => !d.other).map(d => [d.kind, d.p, d.q]), [['holding', 0, 0], ['holding', 1, 0]], 'the viewer\'s own places are always listed');
    assert.deepEqual(others(m), ['holding:1,0:1:f1', 'vault:2,0:3:f1'], 'six nations\' villages were listed here (loop-play17 LP17-4)');
    // one other nation's village comes into sight (tile 5 of (5,0)); its neighbour on tile 6 does not
    fogWith(['5,0,5']);
    assert.deepEqual(others(SCR.s1VillageModel(fs)), ['holding:1,0:1:f1', 'vault:2,0:3:f1', 'holding:5,0:0:f6']);
    // another's storehouse in sight
    fogWith(['3,0,9', '1,0,5']);
    assert.deepEqual(others(SCR.s1VillageModel(fs)), ['holding:1,0:0:f2', 'holding:1,0:1:f1', 'vault:2,0:3:f1', 'vault:3,0:9:f4']);
    // "seen before" (L2) is not "visible now"
    fogWith([]);
    assert.equal(SCR.otherPlaceOffered(fs, { p: 5, q: 0, tile: 5, faction: 6 }), false);
    assert.equal(SCR.otherPlaceOffered(fs, { p: 5, q: 0, tile: 5, faction: 1 }), true, 'own nation: listed in or out of sight');
    assert.equal(SCR.otherPlaceOffered({ ...fs, citizen: null }, { p: 5, q: 0, tile: 5, faction: 1 }), false, 'no nation known: sight only');
    // the card: only those names, in both languages, and a line that says what the list holds
    const fogFs = { ...fs, localPlay: {} };
    const html = String(SCR.renderS1Village(fogFs));
    assert.doesNotMatch(html, /5, 0 · マス/, 'a hidden village\'s province and tile are not named');
    assert.doesNotMatch(html, /3, 0 · マス 9/);
    assert.match(html, /村（1, 0 · マス 6） · /);
    assert.match(html, /行き先に並ぶのは、あなたの場所、あなたの国の村と貯蔵庫、いま見えている村と貯蔵庫だけです。/);
    setLang('en');
    const en = String(SCR.renderS1Village(fogFs));
    assert.match(en, /The list shows only your own places, your nation(&#39;|')s villages and storehouses, and the villages and storehouses you can see now\./);
    assert.doesNotMatch(en, /season/i);
    setLang('ja');
    assert.doesNotMatch(String(SCR.renderS1Village(fs)), /行き先に並ぶのは/, 'a page without fog does not say it');
  } finally { setLang('ja'); FOG.resetFogNow(); }
});

test('the map\'s tile card hands over no hidden place; a place in sight or of the nation it does', () => {
  try {
    const fs = fogWorld();
    fogWith([]);
    assert.equal(SCR.s1PlaceAt(fs, { p: 5, q: 0, idx: 5 }), null, 'another nation\'s village out of sight');
    assert.equal(SCR.s1PlaceAt(fs, { p: 3, q: 0, idx: 9 }), null, 'another nation\'s storehouse out of sight');
    assert.deepEqual(SCR.s1PlaceAt(fs, { p: 1, q: 0, idx: 6 }), { kind: 'holding', p: 1, q: 0, site: 1, gen: null, tile: 6, other: true, faction: 1 }, 'a nation-mate\'s village');
    assert.deepEqual(SCR.s1PlaceAt(fs, { p: 0, q: 0, idx: 30 }), { kind: 'holding', p: 0, q: 0, site: 0, gen: 1, tile: 30 }, 'the viewer\'s own');
    assert.equal(SCR.s1PlanOffers(fs, { p: 5, q: 0, idx: 5 }).dst, false);
    fogWith(['5,0,5']);
    assert.deepEqual(SCR.s1PlaceAt(fs, { p: 5, q: 0, idx: 5 }), { kind: 'holding', p: 5, q: 0, site: 0, gen: null, tile: 5, other: true, faction: 6 });
    assert.equal(SCR.s1PlanOffers(fs, { p: 5, q: 0, idx: 5 }).dst, true);
    // a plan made while the place was in sight is "lost" once it is not: it is not put in the form
    const plan = { id: 1, role: 'dst', p: 5, q: 0, tile: 5, world: null, viewer: null };
    assert.equal(SCR.s1VillageModel({ ...fs, s1Plan: plan }).plan.lost, false);
    fogWith([]);
    assert.equal(SCR.s1VillageModel({ ...fs, s1Plan: plan }).plan.lost, true);
  } finally { FOG.resetFogNow(); }
});

test('a ① request\'s published place stays a destination whatever is in sight', () => {
  const src = web('frontier/screens/s1.mjs');
  const loop = src.slice(src.indexOf('for (const c of coopDestinations(FS)) {'), src.indexOf('const prov = h ? FS.provinces'));
  assert.ok(loop.includes('destinations.push({ ...c, tile: Number.isInteger(t) ? t : null'));
  assert.doesNotMatch(loop, /otherPlaceOffered|viewTile/);
});

test('the send: the chosen place is checked; a list that changed under the form sends nothing; an unchanged one sends as before', async () => {
  const saved = { ...FS };
  const sent = [];
  const V = JSON.parse(readFileSync(new URL('./fixtures/s1-addresses-v1.json', import.meta.url), 'utf8'));
  io.setPin({ programId: V.program, cluster: 'localnet', seasonId: V.seasonId, rulesetHash: rulesetFor(3) });
  try {
    FOG.resetFogNow();
    const provinces = new Map();
    for (const c of CAR.landsWanted({ p: 0, q: 0 }, { p: 1, q: 0 })) provinces.set(`${c.p},${c.q}`, { province: prov(c.p, c.q) });
    Object.assign(FS, world({ provinces }), { wallet: { address: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' }, session: { publicKey: V.program, sign: async () => new Uint8Array(64) }, notice: null, inFlight: 0 });
    C.useTransport({ submit: async req => { sent.push(req); return { ok: false, code: 'Stop' }; } });
    const keys = SCR.s1VillageModel(FS).destinations.map(SCR.placeKey);
    assert.deepEqual(keys.slice(0, 2), ['holding:0:0:s0', 'holding:1:0:s2']);
    assert.match(String(SCR.renderS1Village(FS)), new RegExp(`<input type="hidden" name="places" value="${keys.join('\\|').replace(/[.*+?^${}()[\]\\]/g, m => (m === '|' ? m : `\\${m}`))}">`), 'the form carries the keys it was drawn with');
    // the list as drawn named another place at index 1 (it has changed since): nothing is sent, and the page says so
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '1' }, places: { value: 'holding:0:0:s0|holding:9:9:s1' }, c1: { value: '120' } } });
    assert.equal(sent.length, 0);
    assert.match(String(FS.notice?.text ?? ''), /行き先の一覧が変わりました/);
    // the list unchanged: the caravan goes to the place chosen, as before
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '1' }, places: { value: keys.join('|') }, c1: { value: '120' } } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].name, 'SendCaravan');
    assert.deepEqual([sent[0].fields.dst_kind, sent[0].fields.dst_p, sent[0].fields.dst_q, sent[0].fields.dst_at], [1, 1, 0, 2]);
    // a form without the keys (an older markup, a script): the index alone, as before
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '1' }, c1: { value: '120' } } });
    assert.equal(sent.length, 2);
  } finally { for (const k of Object.keys(FS)) delete FS[k]; Object.assign(FS, saved); C.useTransport(null); }
  const en = web('lang/en-frontier-play.mjs');
  assert.ok(en.includes('"The destination list has changed (a place that goes out of sight leaves the list). No caravan was sent. Choose the destination again."'));
});

// (verify-pr244) The form is drawn again about once a second at ×60 while it is open (app.mjs keepState). The options'
// values are indexes, and a village coming into or leaving sight moves every index after it: the redraw put the person's
// choice on ANOTHER place, and the hidden `places` was drawn again with it, so the check above let it go there. The
// choice is now kept by its place (`data-key`), and the place chosen in the field (`picked`) is what the send checks.
test('a redraw keeps the chosen PLACE, not its index; a chosen place that left the list is refused at the send', async () => {
  const { keepState } = await import('../../permutation-server/web/frontier/app.mjs');
  const opt = (i, key, sel = false) => ({ tagName: 'OPTION', value: String(i), defaultSelected: sel, dataset: { key } });
  const build = keys => {
    const options = keys.map((k, i) => opt(i, k, i === 0));
    const select = { tagName: 'SELECT', name: 'dst', dataset: {}, options, value: '0', closest: s => (s === 'form[data-form]' ? { dataset: { form: 's1-caravan' } } : null), matches: () => false,
      get selectedOptions() { return options.filter(o => o.value === this.value); } };
    const picked = { tagName: 'INPUT', type: 'text', name: 'picked', dataset: {}, value: '', defaultValue: '', closest: select.closest, matches: () => false };
    return { select, picked, el: { querySelectorAll: s => (s === 'input, select, textarea' ? [select, picked] : []), contains: () => false } };
  };
  let cur = build(['holding:0:0:s0', 'holding:1:0:s1', 'holding:5:0:s0']);
  const el = { contains: () => false, querySelectorAll: s => cur.el.querySelectorAll(s) };
  cur.select.value = '2'; cur.picked.value = 'holding:5:0:s0';
  // the village at index 1 leaves sight: the chosen one is now at index 1
  keepState(el, () => { cur = build(['holding:0:0:s0', 'holding:5:0:s0']); }, null);
  assert.equal(cur.select.value, '1', 'the same place stays chosen');
  assert.equal(cur.picked.value, 'holding:5:0:s0', 'the place chosen is kept over the redraw');
  // a nearer village comes into sight in front of it
  keepState(el, () => { cur = build(['holding:0:0:s0', 'holding:2:0:s3', 'holding:5:0:s0']); }, null);
  assert.equal(cur.select.value, '2');
  // the chosen place leaves sight: the field falls back to its first choice, and `picked` still names the place chosen
  keepState(el, () => { cur = build(['holding:0:0:s0', 'holding:2:0:s3']); }, null);
  assert.equal(cur.select.value, '0');
  assert.equal(cur.picked.value, 'holding:5:0:s0');
  // the markup: every destination option names its place; the field for the chosen place is there, empty
  const html = String(SCR.renderS1Village(fogWorld()));
  // (fix-loop18 LP18-2: the village in hand is the form's only start here, so it is no longer listed as a destination)
  assert.match(html, /<optgroup label="あなたの場所"><option value="1" data-key="holding:1:0:s2" selected>/);
  assert.doesNotMatch(html, /<option value="0" data-key="holding:0:0:s0"/);
  assert.match(html, /<input type="text" name="picked" value="" hidden tabindex="-1" aria-hidden="true" autocomplete="off">/);
  const app = web('frontier/app.mjs');
  assert.ok(app.includes("if (dst) { if (dst.form?.elements?.picked) dst.form.elements.picked.value = dst.selectedOptions?.[0]?.dataset?.key ?? ''; return; }"), 'a change of the field writes the place chosen');
});

test('the send checks the place chosen in the field: not at the index any more → nothing sent, and the next press sends what the field shows', async () => {
  const saved = { ...FS };
  const sent = [];
  const V = JSON.parse(readFileSync(new URL('./fixtures/s1-addresses-v1.json', import.meta.url), 'utf8'));
  io.setPin({ programId: V.program, cluster: 'localnet', seasonId: V.seasonId, rulesetHash: rulesetFor(3) });
  try {
    FOG.resetFogNow();
    const provinces = new Map();
    for (const c of CAR.landsWanted({ p: 0, q: 0 }, { p: 1, q: 0 })) provinces.set(`${c.p},${c.q}`, { province: prov(c.p, c.q) });
    Object.assign(FS, world({ provinces }), { wallet: { address: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' }, session: { publicKey: V.program, sign: async () => new Uint8Array(64) }, notice: null, inFlight: 0 });
    C.useTransport({ submit: async req => { sent.push(req); return { ok: false, code: 'Stop' }; } });
    const keys = SCR.s1VillageModel(FS).destinations.map(SCR.placeKey);
    // the person chose a place that is no longer in the list (the redraw left the field on index 1, another place)
    const picked = { value: 'holding:9:9:s1' };
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '1' }, places: { value: keys.join('|') }, picked, c1: { value: '120' } } });
    assert.equal(sent.length, 0, 'the drawn list agrees with the field, but the place chosen is gone: nothing is sent');
    assert.match(String(FS.notice?.text ?? ''), /行き先の一覧が変わりました/);
    assert.equal(picked.value, '', 'the next press sends to what the field shows');
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '1' }, places: { value: keys.join('|') }, picked, c1: { value: '120' } } });
    assert.equal(sent.length, 1);
    // the place chosen is still at the index: sent
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '1' }, places: { value: keys.join('|') }, picked: { value: keys[1] }, c1: { value: '120' } } });
    assert.equal(sent.length, 2);
    assert.deepEqual([sent[1].fields.dst_kind, sent[1].fields.dst_p, sent[1].fields.dst_q, sent[1].fields.dst_at], [1, 1, 0, 2]);
  } finally { for (const k of Object.keys(FS)) delete FS[k]; Object.assign(FS, saved); C.useTransport(null); }
});
