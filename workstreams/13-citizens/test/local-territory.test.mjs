// (ws13-territory, 2026-11-25) ⑬'s local resident and PLAYER TERRITORY (#209): what it reads about its own land (the
// same reader as the read-only MCP tool get_territory_status — own tiles and summary always, another tile's owner only
// in its sight), the tile of its next village's site claimed before the wide claim, a village claimed only on its own
// tile, growth tiles at its own pace (never before troops: loop-play15 LP15-5), and the same limits as every other
// order (one claim a turn — the world's —, one action a turn, the journal's signature before the submit).
// KEY-FREE: the world's bytes are made by ③'s test fixture; the send port is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localCandidates, localRule, noteOutcome, settled, storesAt, LOCAL_LIMITS } from '../resident/local/brain.mjs';
import { freshState, enterWorld } from '../resident/local/journal.mjs';
import { localStep } from '../resident/local/runner.mjs';
import { checkStep, wideSteps } from '../resident/local/plan.mjs';
import { claimOrder, wideMem } from '../resident/local/wide.mjs';
import { TERRITORY_CLAIM, TERRITORY_LIMITS, territoryMem, villageSite, growthTile, growthHolds, noteTile, createTerritoryEyes, territorySeen } from '../resident/local/territory.mjs';
import { createTerritoryReader, claimNow, wideDisc, tileInSight, sightAnchors, captureFacts, provinceTiles, reachOf } from '../../03-composability/mcp/src/local-play-territory.mjs';
import { fakeTerritoryWorld, captureBytes, provinceRecord, playerRecord, PROGRAM, WALLET, OTHER, SEASON_ID } from '../../03-composability/mcp/test/territory-fixture.mjs';
import { territoryClaimIntent, claimCostV1, tileUpkeepV1 } from '../../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { wideClaimIntent, settlerCost } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { localActIntent } from '../../../permutation-gateway/src/frontier/local-play-act.mjs';
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';

const NOW = 1_800_000_000, BELL = 50;
const PROD = [40, 30, 20, 15, 0, 15, 5, 0];
const RIM = { p: -64, q: -64, site: 5, tile: 7 };   // ring 128
const A = { p: '-65', q: '-64' };   // ring 129, 1 province from home: my nation holds its keep → all of it in my sight
const B = { p: '-65', q: '-65' };   // ring 130, 2 provinces from home: another nation's keep → mostly out of my sight
function village({ stores = [500, 500, 300, 200, 0, 200, 0, 0], reserve = 0, production = PROD } = {}) {
  return { p: RIM.p, q: RIM.q, site: RIM.site, tile: RIM.tile, tier: 0, flags: 0, walls: 0, hostSeq: 0, lastOwnerAction: NOW,
    stores: stores.map((v, i) => ({ value: BigInt(v * 1000), rate: BigInt(production[i] * 1000), cap: 9_000_000n, t0: BigInt(NOW), frac: 0n })),
    production: production.map(x => BigInt(x * 1000)), upkeep: Array(8).fill(0n), queue: [], reserve: [reserve, 0, 0, 0, 0, 0, 0, 0], transit: [] };
}
/** A fake world: A in my sight (sites on tiles 5, 20, 50 — 50 has another nation's village), B out of it (sites 5, 40). */
function world({ mine = {}, others = {}, player = null, aSites = [{ tile: 5 }, { tile: 20 }, { tile: 50, state: 1, faction: 2 }] } = {}) {
  const w = fakeTerritoryWorld();
  const me = w.tagOf(WALLET), other = w.tagOf(OTHER);
  w.capture(A.p, A.q, captureBytes({ sites: aSites, keepTile: 30, keepHolder: 3 }));
  w.capture(B.p, B.q, captureBytes({ sites: [{ tile: 5 }, { tile: 40 }], keepTile: 30, keepHolder: 1 }));
  for (const c of [A, B]) {
    const k = `${c.p},${c.q}`, owners = {}, dist = {};
    for (const t of mine[k] ?? []) { owners[t] = me; dist[t] = 1; }
    for (const t of others[k] ?? []) { owners[t] = other; dist[t] = 1; }
    if (Object.keys(owners).length) w.record(c.p, c.q, provinceRecord({ owners, dist }));
  }
  const n = Object.values(mine).reduce((x, l) => x + l.length, 0);
  if (player || n) w.player(WALLET, playerRecord({ tag: me, tiles: n, faction: 3, ...(player ?? {}) }));
  return w;
}
const HOME = { p: RIM.p, q: RIM.q, site: RIM.site, tile: RIM.tile, tier: 0 };
const readerOf = w => createTerritoryReader({ herald: 'http://herald.test', addresses: w.addresses, programId: w.programId, getJson: w.getJson, read: w.read });
const viewOf = (w, { bell = BELL, villages = [] } = {}) => readerOf(w).view({ wallet: WALLET, home: HOME, faction: 3, villages, bell });
function wideLand(o = {}) {
  return { bell: BELL, villages: [], bound: 0, need: settlerCost(1), slot: 2, border: [], targets: [{ ...A, free: [0, 1] }, { ...B }], host: null, expedition: null, ...o };
}
function obsOf(raw, territory, { wl = wideLand(), ...extra } = {}) {
  return { bell: BELL, nowSecs: NOW, genesisTs: NOW - 30000, seasonId: SEASON_ID, programVersion: 1, joined: true, faction: 3, wide: true, holding: { ...RIM },
    province: { resolvedNext: BELL - 1 }, landStage: 'final', settled: settled(raw, NOW), stores: storesAt(raw, NOW, RESOURCE_ORDER).map(s => ({ resource: s.resource, value: s.value, perHour: s.perHour, cap: s.cap })),
    wideLand: wl, territory, ...extra };
}
function mem(goal = 'village-first') { const st = freshState({ wallet: WALLET, goal, nation: 3 }); enterWorld(st, 'w'); st.lastTouchBell = BELL; return st; }
const byId = (c, id) => c.candidates.find(x => x.id === id);
const tiles = c => c.candidates.filter(x => x.kind === 'tile');

// ------------------------------------------------------------------ what it reads (the MCP tool's reader)

test('TR1 the view: my own tiles, the next claim\'s price, my upkeep, this turn\'s claim — from my own record and the reachable provinces\' records', async () => {
  const w = world({ mine: { '-65,-64': [5, 6] }, others: { '-65,-64': [8] }, player: { lastClaimBell: BELL, claimsInBell: 1 } });
  const v = await viewOf(w);
  assert.equal(v.on, true);
  assert.equal(v.own.tiles, 2);
  assert.deepEqual(v.own.list.map(x => `${x.p},${x.q},${x.tile}`), ['-65,-64,5', '-65,-64,6']);
  assert.equal(v.own.listComplete, true);
  assert.equal(v.own.nextClaimOre, claimCostV1(2));   // 10 + 2 % per tile owned, rounded down → 10
  assert.equal(claimCostV1(5), 11);
  assert.equal(v.own.upkeepMilliFoodPerHour, 66);     // 2 tiles × 0.033 food/h
  assert.equal(v.own.unpaid, false);
  assert.equal(v.own.claimsThisTurn, 1);
  assert.deepEqual(claimNow(v, { ore: 200 }), { ok: false, why: ['this turn\'s claim is used (1 a turn)'] });
  // (the next turn the same record no longer blocks: the claim counter is of its own turn)
  assert.equal((await viewOf(w, { bell: BELL + 1 })).own.claimsThisTurn, 0);
  // reads: herald route captures (≤ 4 a request) and the relay's read-only account read (≤ 16 a call) — nothing else
  assert.ok(w.calls.route > 0 && w.calls.read > 0);
});

test('TR2 fog: free / taken are said only for tiles in my sight; out of it a tile is `unseen` (its owner is not said); my own tiles and the layout always', async () => {
  const w = world({ mine: { '-65,-65': [12] }, others: { '-65,-64': [8], '-65,-65': [13, 44] } });
  const v = await viewOf(w);
  const a = v.provinces.find(x => x.p === A.p && x.q === A.q), b = v.provinces.find(x => x.p === B.p && x.q === B.q);
  // A: my nation holds its keep → the whole province is in sight: another player's tile is `taken`, the rest `free`
  assert.deepEqual(a.unseen, []);
  assert.deepEqual(a.taken, [8]);
  assert.equal(a.free.length, 61 - 1 /* keep */ - 1 /* taken */);
  assert.ok(!a.free.includes(30) && !a.taken.includes(30), 'the keep\'s tile is never claimable');
  assert.equal(a.sites[2].village, true);
  // B: only what my first home's own sight reaches is said; the other player's tiles 13 and 44 are NOT named out of sight
  const anchors = sightAnchors({ home: HOME, villages: [], faction: 3, caps: new Map([[`${A.p},${A.q}`, captureFacts(captureBytes({ keepHolder: 3 }))], [`${B.p},${B.q}`, captureFacts(captureBytes({ keepHolder: 1 }))]]) });
  for (const t of [13, 44]) {
    const seen = tileInSight(anchors, B.p, B.q, t);
    assert.equal(b.taken.includes(t), seen, `tile ${t} taken only if seen`);
    assert.equal(b.unseen.includes(t), !seen);
  }
  assert.ok(b.unseen.length > 30, 'most of B is out of my sight');
  assert.ok(b.taken.length + b.free.length + b.unseen.length + b.own.length === 60);
  assert.deepEqual(b.own, [12], 'my own tile is always said, in sight or not');
  assert.deepEqual(b.siteTiles, [5, 40], 'the layout (sites, the keep\'s tile) is always said');
  assert.equal(b.sites[1].village, null, 'whether an unseen site has a village is not said');
  // nothing about any other wallet's summary is read: only my own player record's address was asked
  const { territoryPlayerAddress } = await import('../../../permutation-server/web/frontier/flocalplay-territory.mjs');
  assert.ok(!w.calls.asked.includes(territoryPlayerAddress(w.addresses.season, PROGRAM, w.citizenOf(OTHER))));
});

test('TR3 unpaid upkeep: said with the turn it began and the turn tiles start to return; a claim cannot be asked', async () => {
  const w = world({ mine: { '-65,-64': [5] }, player: { unpaidSince: 40, excess: 2 } });
  const v = await viewOf(w);
  assert.equal(v.own.unpaid, true);
  assert.equal(v.own.unpaidSinceBell, 40);
  assert.equal(v.own.decayFromBell, 64);   // after 24 turns one tile returns per turn
  assert.equal(v.own.upkeepMilliFoodPerHour, 33 + 16 * 2);   // + 0.016 food/h per province beyond 3
  assert.equal(tileUpkeepV1(5), 33 + 32);
  const c = claimNow(v, { ore: 500 });
  assert.equal(c.ok, false);
  assert.match(c.why[0], /unpaid since turn 40.*refuses new claims/);
});

test('TR4 a world without player territory is said (on:false), an unreadable one is not guessed (on:null); reach follows my own tiles', async () => {
  const off = fakeTerritoryWorld();
  off.capture(A.p, A.q, captureBytes({ territory: false }));
  assert.equal((await viewOf(off)).on, false);
  const none = fakeTerritoryWorld();
  none.getJson = async () => { throw new Error('down'); };
  assert.equal((await readerOf(none).view({ wallet: WALLET, home: HOME, faction: 3, bell: BELL })).on, null);
  // reach: 3 provinces from the first home; beyond it, from a province where I own a tile (witness 'own')
  assert.deepEqual(reachOf({ p: '-64', q: '-64' }, { p: '-67', q: '-64' }), { kind: 'home' });
  assert.equal(reachOf({ p: '-64', q: '-64' }, { p: '-69', q: '-64' }), null);
  assert.deepEqual(reachOf({ p: '-64', q: '-64' }, { p: '-69', q: '-64' }, { ownAt: [{ p: '-67', q: '-64' }] }), { kind: 'own', p: '-67', q: '-64' });
  assert.deepEqual(reachOf({ p: '-64', q: '-64' }, { p: '-69', q: '-64' }, { lands: [{ p: '-68', q: '-64' }] }), { kind: 'nation', p: '-68', q: '-64' });
  assert.ok(wideDisc({ p: -64, q: -64 }).every(c => Math.max(Math.abs(Number(c.p)), Math.abs(Number(c.q)), Math.abs(Number(c.p) + Number(c.q))) >= 129));
});

// ------------------------------------------------------------------ the brain: the site's tile, then the village

test('TB1 a wide claim is due but no site\'s tile is mine: the resident claims the SITE\'S TILE first (the page\'s own TerritoryClaim), not the village', async () => {
  const st = mem(), obs = obsOf(village(), await viewOf(world()));
  const c = localCandidates(obs, st);
  assert.equal(c.candidates.filter(x => x.kind === 'wideclaim').length, 0, 'no village claim without my own tile');
  const t = tiles(c).find(x => x.meta.purpose === 'site');
  assert.ok(t && !t.held, JSON.stringify(t?.held));
  assert.equal(t.order.name, TERRITORY_CLAIM);
  assert.deepEqual(t.order.fields, { tile: 5 });   // site 0 of A (the nearest target, a free site) stands on tile 5
  assert.deepEqual(t.order.v, { holding: { p: RIM.p, q: RIM.q, site: RIM.site }, target: { p: A.p, q: A.q } });   // within 3 of home: no witness
  assert.equal(localRule(c).choice, t.id);
  // the order is one the page's intent check and the relay's accept, byte for byte the shapes they know
  assert.equal(territoryClaimIntent(t.order.v, t.order.fields).name, TERRITORY_CLAIM);
  assert.equal(localActIntent({ name: t.order.name, subject: t.order.v, fields: t.order.fields }, { wallet: WALLET }).name, TERRITORY_CLAIM);
});

test('TB2 the site\'s tile is mine: the village claim names it with `territory: true` (the territory record, never a reach witness)', async () => {
  const st = mem(), obs = obsOf(village({ stores: [900, 900, 500, 200, 0, 300, 0, 0] }), await viewOf(world({ mine: { '-65,-64': [5] } })));
  const c = localCandidates(obs, st);
  const wc = c.candidates.find(x => x.kind === 'wideclaim');
  assert.ok(wc && !wc.held, JSON.stringify(wc?.held));
  assert.deepEqual(wc.order.v, { holding: { p: RIM.p, q: RIM.q, site: RIM.site }, target: { p: A.p, q: A.q }, territory: true });
  assert.deepEqual(wc.order.fields, { site: 0, slot: 2 });
  assert.equal(wideClaimIntent(wc.order.v, wc.order.fields).subject.territory, true);
  assert.equal(localRule(c).choice, wc.id);
  assert.equal(tiles(c).filter(x => x.meta.purpose === 'site').length, 0, 'no second site tile once one is mine');
});

test('TB3 which site: a site with a village next to it (ReservedSite), a site whose tile another player owns, a taken or tried site are passed over', async () => {
  // A's sites: 0 on tile 5, 1 on tile 20, 2 on tile 50 (another nation's village). Another player owns tile 5.
  const w = world({ others: { '-65,-64': [5] } });
  const st = mem(), v = await viewOf(w);
  const pick = villageSite(v, st, new Map([[`${A.p},${A.q}`, [0, 1]]]));
  assert.equal(pick.site, 1, 'site 0\'s tile is another player\'s: site 1');
  assert.equal(pick.tile, 20);
  assert.equal(pick.mine, false);
  // a tried site is not chosen again; then nothing is left in A
  wideMem(st).triedClaims.push(`${A.p},${A.q},1`);
  assert.match(villageSite(v, st, new Map([[`${A.p},${A.q}`, [0, 1]]])).why, /no free village site/);
  // crowded: a village on a site ≤ 3 tiles away (frontier-abi SITE_NEIGHBOUR_TILES) → the program refuses ReservedSite
  const near = world({ aSites: [{ tile: 30 - 9 }, { tile: 30 - 8, state: 1, faction: 2 }, { tile: 50 }] });   // tiles 21 and 22 are neighbours
  const nv = await viewOf(near);
  const a = nv.provinces.find(x => x.p === A.p);
  assert.equal(a.sites[0].crowded, true);
  assert.equal(villageSite(nv, mem(), new Map([[`${A.p},${A.q}`, [0, 2]]])).site, 2);
  // territory not read in a wide world: no claim on a guess
  const o = obsOf(village(), { on: null, why: 'territory not read: down' });
  assert.match(claimOrder(o, mem()).why, /not read/);
  // a world without territory: the claim of before (no `territory`)
  const off = claimOrder(obsOf(village(), { on: false }), mem());
  assert.equal(off.order.v.territory, undefined);
});

test('TB4 holds, each said: this turn\'s claim used, upkeep unpaid, the ore short, the first village not final', async () => {
  const held = async (w, o = {}, raw = village()) => tiles(localCandidates(obsOf(raw, await viewOf(w), o), mem())).find(x => x.meta.purpose === 'site').held ?? [];
  assert.match((await held(world({ player: { lastClaimBell: BELL, claimsInBell: 1 } })))[0], /this turn's claim is used/);
  assert.match((await held(world({ mine: { '-65,-65': [12] }, player: { unpaidSince: 45 } })))[0], /upkeep is unpaid/);
  assert.match((await held(world(), {}, village({ stores: [500, 500, 300, 4, 0, 200, 0, 0] })))[0], /costs 10 ore; my first home has 4/);
  assert.match((await held(world(), { landStage: 'provisional' })).join(' '), /not final yet/);
});

test('TB5 (live run1) while my landed village claim settles, no other site\'s tile is bought', async () => {
  // my tile 5 (site 0) is mine and my claim on site 0 landed last turn: site 0 is tried, the village is not in my record yet
  const st = mem();
  noteOutcome(st, { id: 'wideclaim:-65,-64,0', kind: 'wideclaim', site: '-65,-64,0', order: { name: 'WideClaim', v: { target: { p: A.p, q: A.q } }, fields: { site: 0, slot: 2 } } }, 'landed', { bell: BELL - 1 });
  const obs = obsOf(village({ stores: [900, 900, 500, 200, 0, 300, 0, 0] }), await viewOf(world({ mine: { '-65,-64': [5] } })));
  const c = localCandidates(obs, st);
  assert.equal(tiles(c).filter(x => x.meta.purpose === 'site').length, 0, 'no second site tile while the claim settles');
  assert.equal(c.candidates.filter(x => x.kind === 'wideclaim' && !x.held).length, 0);
  // the claim founded nothing (its wait is over, no village): the next site's tile is looked at again
  const later = { ...obs, bell: BELL + 20 };
  later.territory = await viewOf(world({ mine: { '-65,-64': [5] } }), { bell: BELL + 20 });
  const c2 = localCandidates(later, st);
  assert.deepEqual(tiles(c2).filter(x => x.meta.purpose === 'site').map(x => x.order.fields.tile), [20]);
});

// ------------------------------------------------------------------ growth, at the resident's own pace (LP15-5)

test('TG1 a growth tile is bought only from ore beyond the plan, the reserve and a training hundred — land does not come before troops', async () => {
  const w = world({ mine: { '-65,-64': [5] } });
  const v = await viewOf(w);
  const g = growthTile(v, mem());
  assert.equal(g.p, A.p);
  assert.ok(g.seen && !v.provinces[0].siteTiles.includes(g.tile), 'a free tile I see, next to my own, not a village site');
  // ore 60: not beyond plan + reserve + a training hundred (20) → held, with the reason
  const poor = localCandidates(obsOf(village({ stores: [900, 900, 500, 60, 0, 300, 0, 0] }), v), mem());
  const gp = tiles(poor).find(x => x.meta.purpose === 'growth');
  assert.ok(gp.held.some(h => /does not cover the tile .* training hundred/.test(h)), JSON.stringify(gp.held));
  // plenty of ore: offered, not held — and still below every build of the plan and the village claim
  const rich = localCandidates(obsOf(village({ stores: [900, 900, 500, 900, 0, 300, 0, 0] }), v), mem());
  const gr = tiles(rich).find(x => x.meta.purpose === 'growth');
  assert.ok(!gr.held, JSON.stringify(gr.held));
  assert.equal(territoryClaimIntent(gr.order.v, gr.order.fields).fields.tile, g.tile);
  assert.ok(gr.score < rich.candidates.find(x => x.kind === 'wideclaim').score);
  assert.notEqual(localRule(rich).choice, gr.id, 'the village claim comes first');
  // the pace itself (pure): one every 6 turns, a ceiling of 24, upkeep within 10 % of the first home's food
  const base = { bell: BELL, idleOre: 500, trainOre100: 20, foodPerHour: 40, addMilli: 33 };
  assert.deepEqual(growthHolds(v, mem(), base), []);
  const st = mem(); territoryMem(st).lastGrowthBell = BELL - 2;
  assert.match(growthHolds(v, st, base)[0], /one every 6 turns/);
  assert.match(growthHolds({ ...v, own: { ...v.own, tiles: TERRITORY_LIMITS.tilesMax } }, mem(), base)[0], /ceiling is 24/);
  assert.match(growthHolds({ ...v, own: { ...v.own, upkeepMilliFoodPerHour: 3990 } }, mem(), base)[0], /over 10 % of my first home's 40 food\/h/);
  assert.match(growthHolds(v, mem(), { ...base, idleOre: 25 })[0], /land does not come before troops/);
});

test('TG2 memory: a landing sets the pace; another player\'s tile is not asked again; "already yours" is mine and no failure; the turn\'s claim and ore only hold', async () => {
  const cand = (site, purpose) => ({ id: `tile:${site}`, kind: 'tile', site, meta: { purpose }, order: { name: TERRITORY_CLAIM, v: {}, fields: { tile: Number(site.split(',')[2]) } } });
  const st = mem();
  noteOutcome(st, cand('-65,-64,6', 'growth'), 'landed', { bell: 60 });
  assert.deepEqual([st.territory.claims, st.territory.lastClaimBell, st.territory.lastGrowthBell], [1, 60, 60]);
  noteOutcome(st, cand('-65,-64,9', 'growth'), 'failed', { bell: 61, programCode: 11 });   // SiteTaken
  assert.deepEqual(st.territory.triedTiles, ['-65,-64,9']);
  assert.equal(st.failures[TERRITORY_CLAIM].count, 1);
  noteOutcome(st, cand('-65,-64,5', 'site'), 'landed', { bell: 70 });
  assert.equal(st.failures[TERRITORY_CLAIM], undefined, 'a landing clears the hold');
  assert.equal(st.territory.lastGrowthBell, 60, 'a site tile is not growth');
  noteOutcome(st, cand('-65,-64,7', 'site'), 'failed', { bell: 71, programCode: 52 });   // AlreadyDone
  assert.deepEqual(st.territory.mineTiles, ['-65,-64,7']);
  assert.equal(st.failures[TERRITORY_CLAIM], undefined, '"already yours" holds nothing');
  for (const pc of [21, 29, 43]) noteOutcome(st, cand('-65,-64,10', 'growth'), 'failed', { bell: 72, programCode: pc });
  assert.deepEqual(st.territory.triedTiles, ['-65,-64,9'], 'ore, the turn\'s claim, unpaid upkeep pass with time: the tile stays a candidate');
  assert.equal(st.failures[TERRITORY_CLAIM].count, 3);
  noteTile(st, { site: '-65,-64,11' }, 'not-sent', { bell: 73 });
  assert.equal(st.territory.triedTiles.length, 1);
  // a tile the chain says is mine counts for the village's site even before the record shows it
  const v = await viewOf(world());
  assert.equal(villageSite(v, { territory: { triedTiles: [], mineTiles: ['-65,-64,5'] }, wide: null }, new Map([[`${A.p},${A.q}`, [0, 1]]])).mine, true);
});

// ------------------------------------------------------------------ the runner: one order, one action a turn

function harness(w, { raw = village(), st = mem(), bell = BELL, sendOutcome = () => ({ outcome: 'landed', code: null }), plan = null } = {}) {
  const store = { state: st, saves: 0, save() { this.saves++; } };
  const sent = [], logs = [];
  const eyes = createTerritoryEyes({ herald: 'http://herald.test', identity: { address: WALLET, programId: PROGRAM, seasonAddress: w.addresses.season }, read: w.read, getJson: w.getJson });
  const wide = { look: async () => wideLand() };
  const clock = { bell };
  const observe = async () => { const { wideLand: _w, territory: _t, ...o } = obsOf(raw, null); return { ...o, bell: clock.bell, wideInv: { villages: [], bound: 0 } }; };
  const send = async (order, { onSigned }) => { const sig = `sig${sent.length + 1}`; await onSigned(sig); sent.push({ order, sig, saved: st.journal[`b${clock.bell}`]?.signature }); return { ...sendOutcome(order), signature: sig }; };
  const step = () => localStep({ store, observe, send, follow: async () => null, bellNow: async () => clock.bell, log: (s, f) => logs.push({ s, ...f }), wide, territory: eyes, limits: LOCAL_LIMITS, plan });
  return { st, sent, logs, step, clock };
}

test('TS1 live shape: the site\'s tile is claimed (signature saved before the submit), the record then shows it, the next turn the village is claimed on it — one action a turn', async () => {
  const w = world();
  const h = harness(w, { raw: village({ stores: [900, 900, 500, 200, 0, 300, 0, 0] }) });
  const r1 = await h.step();
  assert.deepEqual([r1.did, r1.order, r1.outcome], ['act', TERRITORY_CLAIM, 'landed']);
  assert.equal(h.sent[0].saved, 'sig1', 'the signature is in the journal before the one submit');
  assert.deepEqual(h.sent[0].order.fields, { tile: 5 });
  assert.equal(h.st.journal[`b${BELL}`].kind, 'tile');
  assert.equal(h.st.territory.lastClaimBell, BELL);
  // same turn again: nothing more (one action per turn), whatever is still due
  const again = await h.step();
  assert.equal(again.did, 'blocked');
  assert.equal(h.sent.length, 1);
  // the chain now holds the tile (the record shows it) → the next turn's order is the village on it
  w.record(A.p, A.q, provinceRecord({ owners: { 5: w.tagOf(WALLET) }, dist: { 5: 1 } })).player(WALLET, playerRecord({ tag: w.tagOf(WALLET), tiles: 1, lastClaimBell: BELL, claimsInBell: 1 }));
  h.clock.bell = BELL + 1;
  const r2 = await h.step();
  assert.deepEqual([r2.did, r2.order], ['act', 'WideClaim']);
  assert.equal(h.sent[1].order.v.territory, true);
  assert.deepEqual(h.sent[1].order.fields, { site: 0, slot: 2 });
  assert.ok(h.logs.some(l => l.s === 'territory' && l.what === 'seen' && l.tiles === 1));
});

test('TS2 a refused tile: the chain\'s "another player\'s tile" moves the resident to another site; the turn\'s claim limit only waits', async () => {
  const w = world();
  // (site 0's tile is refused SiteTaken — another player took it out of my sight between my read and my send)
  const h = harness(w, { sendOutcome: () => ({ outcome: 'failed', code: 'LocalActSendRefused', programCode: 11 }) });
  await h.step();
  assert.deepEqual(h.st.territory.triedTiles, [`${A.p},${A.q},5`]);
  h.clock.bell = BELL + LOCAL_LIMITS.failureHoldMaxBells + 1;   // past the failure hold
  const h2 = harness(w, { st: h.st, bell: h.clock.bell });
  await h2.step();
  assert.deepEqual(h2.sent[0].order.fields, { tile: 20 }, 'the next free site\'s tile, never the refused one again');
  // the world's one claim a turn, refused by the program (Cooldown 29): the same tile stays a candidate
  const h3 = harness(world(), { sendOutcome: () => ({ outcome: 'failed', code: 'LocalActSendRefused', programCode: 29 }) });
  await h3.step();
  assert.deepEqual(h3.st.territory.triedTiles, []);
  assert.ok(h3.st.failures[TERRITORY_CLAIM].until > BELL);
});

test('TS3 the eyes read once per turn and memory change; an unread territory is never cached; the log\'s summary has no tile lists of others', async () => {
  const w = world({ mine: { '-65,-64': [5] } });
  const eyes = createTerritoryEyes({ herald: 'http://herald.test', identity: { address: WALLET, programId: PROGRAM, seasonAddress: w.addresses.season }, read: w.read, getJson: w.getJson });
  const st = mem(), o = { ...obsOf(village(), null), wideInv: { villages: [], bound: 0 } };
  const v1 = await eyes.look(o, st), n = w.calls.read;
  assert.equal(await eyes.look(o, st), v1);
  assert.equal(w.calls.read, n, 'the same turn and memory: no second read');
  territoryMem(st).claims += 1;
  await eyes.look(o, st);
  assert.ok(w.calls.read > n, 'my memory changed (a claim landed): read again');
  const s = territorySeen(v1);
  assert.deepEqual(Object.keys(s).sort(), ['claimsThisTurn', 'free', 'mine', 'nextClaimOre', 'on', 'provinces', 'tiles', 'unpaid', 'unseen', 'upkeepFoodPerHour']);
  // another world than my relay pins: not read
  const other = createTerritoryEyes({ herald: 'http://herald.test', identity: { address: WALLET, programId: PROGRAM, seasonAddress: OTHER }, read: w.read, getJson: w.getJson });
  assert.equal((await other.look(o, mem())).on, null);
});

// ------------------------------------------------------------------ ④ plans

test('TP1 a plan\'s WideClaim step waits while the site\'s tile is claimed first (the tile is the brain\'s own order, never a plan step)', async () => {
  const st = mem(), obs = obsOf(village({ stores: [900, 900, 500, 200, 0, 300, 0, 0] }), await viewOf(world()));
  assert.deepEqual(wideSteps(obs, st).map(s => s.name), ['WideClaim'], 'the claim is still due: the plan saves for it');
  const r = checkStep({ idx: 0, name: 'WideClaim', fields: {}, expect: {}, note: 'claim wide land' }, obs, st, { patience: 48 });
  assert.match(r.wait, /is not mine yet/);
  const mine = obsOf(village({ stores: [900, 900, 500, 200, 0, 300, 0, 0] }), await viewOf(world({ mine: { '-65,-64': [5] } })));
  const go = checkStep({ idx: 0, name: 'WideClaim', fields: {}, expect: {}, note: 'claim wide land' }, mine, st, { patience: 48 });
  assert.equal(go.go.order.v.territory, true);
});

test('TP2 with ④\'s plans on, the turn the site\'s tile can be asked is the brain\'s: the plan is not asked for a step and is not touched', async () => {
  const asked = { next: 0, intend: 0, settle: 0 };
  const plan = { holder: 'h', reconcile: async () => {}, next: async () => { asked.next++; return { wait: 'the plan\'s WideClaim step waits for the tile' }; }, intend: async () => { asked.intend++; }, signed: async () => {}, settle: async () => { asked.settle++; } };
  const w = world();
  const h = harness(w, { raw: village({ stores: [900, 900, 500, 200, 0, 300, 0, 0] }), plan });
  const r = await h.step();
  assert.deepEqual([r.did, r.order, r.outcome], ['act', TERRITORY_CLAIM, 'landed']);
  assert.deepEqual(asked, { next: 0, intend: 0, settle: 0 }, 'no plan step was taken, intended or settled for the tile');
  assert.ok(h.logs.some(l => l.s === 'decide' && l.by === 'ws13-territory'));
  // the tile mine: the next turn the plan is asked again (its WideClaim step goes on from there)
  w.record(A.p, A.q, provinceRecord({ owners: { 5: w.tagOf(WALLET) }, dist: { 5: 1 } })).player(WALLET, playerRecord({ tag: w.tagOf(WALLET), tiles: 1, lastClaimBell: BELL, claimsInBell: 1 }));
  h.clock.bell = BELL + 1;
  const r2 = await h.step();
  assert.equal(r2.did, 'plan-wait');
  assert.equal(asked.next, 1);
});
