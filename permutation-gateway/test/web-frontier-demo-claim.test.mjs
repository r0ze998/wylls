// The walletless demo's single-tile claim (demo-claim-1, owner Q-WD-4 default: the real one-tile claim in the demo).
// The demo must not invent numbers: its judge (web/frontier/sampleland.mjs judgeTileClaim) is the kernel's
// (frontier-abi judge_claim + permutation-rules may_claim, TERRITORY_V1), checked here
//   - against the Rust source's TERRITORY_V1 (the parameters, read from frontier-abi territory.rs);
//   - on the kernel's committed claim vectors (permutation-rules/vectors/territory-preview.json): the same inputs under
//     V1 give what territory-rules.mjs mayClaim — itself pinned to those vectors — gives;
//   - on a table of V1 cases (costs, reach, pace, unpaid, owners, keep tile) with the program's error numbers;
// and the in-page world (screens/liveworld.mjs `landClaim`) charges, records and refuses exactly so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { judgeTileClaim, V1_CLAIM_PARAMS, CLAIM_REFUSAL_CODE, sampleClaimRows, nextClaimOre } from '../../permutation-server/web/frontier/sampleland.mjs';
import { mayClaim } from '../../permutation-server/web/frontier/territory-rules.mjs';
import { claimCostV1, tileUpkeepV1, TERRITORY_V1 } from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { ERRORS } from '../../permutation-server/web/frontier/abi.mjs';
import { resolveTerritory, createTerritory } from '../screens/territory.mjs';
import EN from '../../permutation-server/web/lang/en-frontier-play.mjs';

const rust = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');

test('V1_CLAIM_PARAMS is frontier-abi TERRITORY_V1 (reach, sources, pace, owned tiles, unpaid, cost)', () => {
  const abi = rust('frontier-abi/src/world_index/territory.rs');
  const v1 = abi.slice(abi.indexOf('pub const TERRITORY_V1: TerritoryV1'));
  const num = re => Number(re.exec(v1)[1]);
  assert.equal(V1_CLAIM_PARAMS.reach.range, num(/reach: ReachRule \{\s+range: (\d+),/));
  assert.match(v1, /sources: SRC_HOME \| SRC_OWN \| SRC_NATION_LAND,/);
  assert.equal(V1_CLAIM_PARAMS.reach.sources, 1 | 2 | 8);
  assert.equal(V1_CLAIM_PARAMS.claimsPerTurn, num(/claims_per_turn: (\d+),/));
  assert.equal(V1_CLAIM_PARAMS.claimOwned, /claim_owned: true,/.test(v1));
  assert.equal(V1_CLAIM_PARAMS.unpaid.blockClaims, /block_claims: true,/.test(v1));
  assert.equal(Number(V1_CLAIM_PARAMS.cost.base), num(/cost: ClaimCost \{\s+base: (\d+),/));
  assert.equal(Number(V1_CLAIM_PARAMS.cost.perOwnedBps), num(/per_owned_bps: (\d+),/));
  assert.equal(TERRITORY_V1.costResource, num(/cost_resource: (\d+),/));
});

test('the refusal codes are proc/wide_territory.rs territory_err\'s, by the ABI error table', () => {
  const src = rust('permutation-frontier/src/proc/wide_territory.rs');
  const name = n => ERRORS.find(([, x]) => x === n)[0];
  const want = {
    BadTile: /TerritoryError::BadTile => F::(\w+)/, KeepTile: /TerritoryError::KeepTile => F::(\w+)/, NotOpen: /ClaimRefusal::NotOpen => F::(\w+)/,
    AlreadyYours: /ClaimRefusal::AlreadyYours => F::(\w+)/, Owned: /ClaimRefusal::Owned => F::(\w+)/, Range: /ClaimRefusal::Range => crate::CqError::(\w+)/,
    TurnLimit: /ClaimRefusal::TurnLimit => F::(\w+)/, UpkeepUnpaid: /ClaimRefusal::UpkeepUnpaid => F::(\w+)/, Insufficient: /ClaimRefusal::Insufficient => F::(\w+)/,
    Overflow: /ClaimRefusal::Overflow => F::(\w+)/,
  };
  const v2 = Object.fromEntries(JSON.parse(JSON.stringify(ERRORS)).map(([c, n]) => [n, c]));
  for (const [refusal, re] of Object.entries(want)) {
    const e = re.exec(src)?.[1];
    assert.ok(e, `territory_err maps ${refusal}`);
    const code = e === 'OutpostRule' ? 75 : v2[e] ?? name(e);
    assert.equal(CLAIM_REFUSAL_CODE[refusal], code, `${refusal} → ${e} (${code})`);
  }
});

test('the kernel\'s committed claim vectors: judgeTileClaim gives under V1 what mayClaim gives under V1, for every case\'s inputs', () => {
  const vec = JSON.parse(rust('permutation-rules/vectors/territory-preview.json'));
  assert.ok(vec.claims.length >= 10);
  for (const c of vec.claims) {
    // the vector's own params: territory-rules.mjs is pinned to the kernel's answer (web-frontier-territory-rules.test.mjs)
    const own = mayClaim({ reach: { range: c.range, sources: c.sources }, cost: c.cost, claimsPerTurn: c.perTurn, claimOwned: c.claimOwned, unpaid: { blockClaims: c.blockClaims } }, { ...c, open: true });
    assert.deepEqual(own.refused ? { refused: own.refused } : { ok: String(own.ok) }, c.result, 'territory-rules.mjs = the kernel on its vector');
    const check = { owner: c.owner, nearest: c.nearest, owned: c.owned, claimsThisTurn: c.claimsThisTurn, upkeepUnpaid: c.upkeepUnpaid, balance: c.balance };
    const v1 = mayClaim(V1_CLAIM_PARAMS, { ...check, open: true });
    const got = judgeTileClaim({ tile: 5, keepTile: 30, ...check });
    assert.deepEqual(got.ok ? { ok: BigInt(got.cost) } : { refused: got.refused }, v1.refused ? { refused: v1.refused } : { ok: v1.ok });
  }
});

test('a table of V1 cases: price, reach from the home / own tiles / the nation\'s land, one a turn, unpaid, owners, keep tile, tile range', () => {
  const base = { tile: 5, keepTile: 30, owner: 'nobody', nearest: { home: 0 }, owned: 0, claimsThisTurn: 0, upkeepUnpaid: false, balance: 1000 };
  const cases = [
    [{}, { cost: 10 }],
    [{ owned: 4 }, { cost: 10 }], [{ owned: 5 }, { cost: 11 }], [{ owned: 49 }, { cost: 19 }], [{ owned: 50 }, { cost: 20 }], [{ owned: 100 }, { cost: 30 }],
    [{ nearest: { home: 3 } }, { cost: 10 }], [{ nearest: { home: 4 } }, { refused: 'Range' }],
    [{ nearest: { home: 6, own: 3 } }, { cost: 10 }], [{ nearest: { home: 6, own: 4 } }, { refused: 'Range' }],
    [{ nearest: { home: 9, nationLand: 2 } }, { cost: 10 }], [{ nearest: { home: 9, nationKeep: 1 } }, { refused: 'Range' }],
    [{ claimsThisTurn: 1 }, { refused: 'TurnLimit' }],
    [{ upkeepUnpaid: true }, { refused: 'UpkeepUnpaid' }],
    [{ balance: 9 }, { refused: 'Insufficient' }], [{ balance: 10 }, { cost: 10 }], [{ owned: 5, balance: 10 }, { refused: 'Insufficient' }],
    [{ owner: 'other' }, { refused: 'Owned' }], [{ owner: 'claimer' }, { refused: 'AlreadyYours' }],
    // the kernel's order: the owner before the reach, the reach before the pace, the pace before unpaid, unpaid before the price
    [{ owner: 'other', nearest: { home: 9 } }, { refused: 'Owned' }], [{ nearest: { home: 9 }, claimsThisTurn: 1 }, { refused: 'Range' }],
    [{ claimsThisTurn: 1, upkeepUnpaid: true }, { refused: 'TurnLimit' }], [{ upkeepUnpaid: true, balance: 0 }, { refused: 'UpkeepUnpaid' }],
    [{ tile: 30 }, { refused: 'KeepTile' }], [{ tile: 61 }, { refused: 'BadTile' }], [{ tile: -1 }, { refused: 'BadTile' }], [{ tile: 60 }, { cost: 10 }],
  ];
  for (const [over, want] of cases) {
    const got = judgeTileClaim({ ...base, ...over });
    if (want.cost !== undefined) {
      assert.deepEqual(got, { ok: true, cost: want.cost }, JSON.stringify(over));
      assert.equal(want.cost, claimCostV1(over.owned ?? 0), 'the same price as the page\'s claimCostV1 (and the card\'s "next tile")');
    } else {
      assert.equal(got.ok, false, JSON.stringify(over));
      assert.equal(got.refused, want.refused, JSON.stringify(over));
      assert.equal(got.programCode, CLAIM_REFUSAL_CODE[want.refused]);
    }
  }
  assert.equal(nextClaimOre(7), claimCostV1(7));
  assert.deepEqual([0, 3, 4, 6].map(tileUpkeepV1), [990, 990, 1470, 2430], 'upkeep 990 + 480 per province beyond 3');
});

test('sampleClaimRows: reach ≤ 3, nearest first, the first free tile (no site, no keep, no owner, not already claimed), the witness', () => {
  const pr = (p, q, { sites = [], camp = null, nation = null } = {}) => ({ p, q, siteCount: sites.length, sites, camp: camp === null ? null : { tile: camp, state: 1 }, siteMirror: sites.map(() => (nation === null ? { state: 0 } : { state: 1, faction: nation })) });
  const free = () => Array(61).fill(255);
  const owned = (...ts) => { const o = free(); for (const [t, f] of ts) o[t] = f; return o; };
  const provinces = [
    { p: 0, q: 0, province: pr(0, 0, { sites: [0, 2], camp: 1 }), owners: owned([0, 1]) },          // home: tiles 0, 2 sites, 1 the keep's
    { p: 1, q: 0, province: pr(1, 0), owners: owned([0, 4], [1, 4]) },                                  // another nation's tiles 0, 1
    { p: 3, q: 0, province: pr(3, 0), owners: free() },                                                 // distance 3
    { p: 4, q: 0, province: pr(4, 0), owners: free() },                                                 // distance 4: out of reach…
    { p: 6, q: 0, province: pr(6, 0, { sites: [7], nation: 1 }), owners: free() },                      // …but a village of the nation 2 away
    { p: 9, q: 0, province: pr(9, 0), owners: free() },                                                 // 3 from the nation's land at 6,0
    { p: 10, q: 0, province: pr(10, 0), owners: free() },                                               // 4 from it: out
  ];
  const rows = sampleClaimRows({ provinces, home: { p: 0, q: 0 }, faction: 1, ownTiles: new Set(['0,0,3']) });
  const at = (p, q) => rows.find(r => r.p === p && r.q === q);
  assert.deepEqual(rows.map(r => `${r.p},${r.q}`), ['0,0', '1,0', '3,0', '4,0', '6,0', '9,0']);
  assert.equal(at(0, 0).tile, 4, 'home: 0 and 2 are sites, 1 the keep\'s, 3 claimed by this page');
  assert.equal(at(1, 0).tile, 2, 'tiles another nation owns are skipped');
  assert.equal(at(3, 0).witness, null, 'within 3 of the home: no witness');
  assert.deepEqual(at(4, 0).witness, { kind: 'nation', p: 6, q: 0 });
  assert.deepEqual(at(9, 0).witness, { kind: 'nation', p: 6, q: 0 });
  assert.equal(at(9, 0).upkeepMilli, tileUpkeepV1(9), 'upkeep is fixed at the distance to the home (the one village)');
  assert.equal(at(0, 0).mine, false, 'tile 3 is not the faction\'s in the read yet');
  const mine = sampleClaimRows({ provinces: provinces.map(x => (x.p === 4 ? { ...x, owners: owned([5, 1]) } : x)), home: { p: 0, q: 0 }, faction: 1, ownTiles: new Set(['4,0,5']) });
  assert.equal(mine.find(r => r.p === 4).mine, true);
});

const world = async opts => createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, territory: true, paused: true, nations: true, ...opts });
const claim = (live, body) => live.relay('POST', '/gw/f/sample/territory', body).then(r => r.body);

test('the in-page world: a claim charges the kernel\'s price in ore, records the tile and the summary; one a turn; refusals carry the program\'s codes', async () => {
  const live = await world({ landClaim: true, stage: 'holding' });
  assert.equal(live.herald('/h/season', new URL('http://x/h/season')).body.sample.landClaim, true);
  const s0 = live.summary(), [p, q] = s0.me.village;
  const terr = s0.territory.find(t => t.p === p && t.q === q);
  const sites = new Set(); const pv = live.province(p, q); for (let i = 0; i < pv.siteCount; i++) sites.add(pv.sites[i]);
  const tiles = [...Array(61).keys()].filter(t => terr.owners[t] === 255 && !sites.has(t) && t !== pv.camp?.tile);
  const ore0 = s0.me.stores[3];
  const a = await claim(live, { p, q, tile: tiles[0] });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.cost, 10);
  assert.equal(live.summary().me.stores[3], ore0 - 10, '10 ore from the first village');
  assert.equal(live.summary().land.tiles.length, 1);
  assert.equal(live.summary().territory.find(t => t.p === p && t.q === q).owners[tiles[0]], s0.me.nation, 'the map\'s read shows the tile');
  const sum = live.herald(`/h/world/wide/territory/player/${(await W.viewer({ keyless: true })).citizen}`, new URL('http://x/')).body.player;
  assert.equal(sum.tiles, 1);
  assert.equal(Number(sum.upkeepMilliPerHour), 990);
  assert.equal(sum.nextClaimCost, '10');
  // one a turn
  const b = await claim(live, { p, q, tile: tiles[1] });
  assert.deepEqual([b.ok, b.refused, b.programCode], [false, 'TurnLimit', 29]);
  live.advance();
  assert.deepEqual(await claim(live, { p, q, tile: tiles[0] }).then(r => [r.refused, r.programCode]), ['AlreadyYours', 52]);
  assert.deepEqual(await claim(live, { p, q, tile: pv.camp.tile }).then(r => [r.refused, r.programCode]), ['KeepTile', 57]);
  assert.deepEqual(await claim(live, { p, q, tile: 61 }).then(r => [r.refused, r.programCode]), ['BadTile', 1]);
  // (the demo map is rings 0-2: its farthest province is four from a rim home)
  const dist = (x, y) => (Math.abs(x.p - y.p) + Math.abs(x.q - y.q) + Math.abs(x.p + x.q - y.p - y.q)) / 2;
  const far = s0.territory.find(t => dist(t, { p, q }) === 4), mid = s0.territory.find(t => dist(t, { p, q }) === 2 && dist(t, far) === 2);
  assert.ok(far && mid);
  assert.deepEqual(await claim(live, { p: far.p, q: far.q, tile: 3 }).then(r => [r.refused, r.programCode]), ['Range', 75], 'four provinces from the home, no witness');
  assert.deepEqual(await claim(live, { p: far.p, q: far.q, tile: 3, witness: { kind: 'own', p: mid.p, q: mid.q } }).then(r => [r.refused, r.programCode]), ['Range', 75], 'an own-tile witness without a tile there (OutpostRule)');
  const c = await claim(live, { p, q, tile: tiles[1] });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.tiles, 2);
  assert.equal(c.upkeepMilliPerHour, 1980);
});

test('the in-page world: a provisional village may not claim (NotFinal 24); no land is taken on arrival in a landClaim world', async () => {
  const live = await world({ landClaim: true, stage: 'provisional' });
  const [p, q] = live.summary().me.village;
  assert.deepEqual(await claim(live, { p, q, tile: 3 }).then(r => [r.ok, r.programCode]), [false, 24]);
  // arrival control off: a standing host takes no field
  const pv = live.province(p, q), st = createTerritory(pv);
  const free = st.owners.map((o, i) => (o === 255 ? i : -1)).filter(i => i >= 0);
  assert.ok(free.length);
  const r = resolveTerritory(st, pv, st.bell + 1, { arrival: false });
  assert.equal(r.changes.length, 0);
  const off = await world({ landUpkeep: true, stage: 'provisional' });
  assert.equal((await off.relay('POST', '/gw/f/sample/territory', { p, q, tile: 3 })), null, 'without landClaim the route is not there');
});

test('the page: the claim card and the second press, EN for every new line, and no "season"', () => {
  const h = web('frontier/screens/holding.mjs'), c = web('frontier/controller.mjs');
  assert.match(h, /const claimCard = wideClaimCard\(FS, m, actionBusy\) \|\| sampleClaimCard\(FS, m, actionBusy\)/);
  assert.match(c, /if \(!localPlay && landClaimOn\(FS\)\) return sampleTileClaim\(d\);/);
  assert.match(c, /if \(!\(fresh && d\.confirm\)\) \{/, 'the first press shows the cost, only the preview\'s own button claims');
  const keys = ['近くの州のマスを、村の画面の「1マス取る」で鉱石を払って1つずつ自分の土地にします。', 'マスを取る', '土地を養う', 'このマスの維持費: 食料 {0}/時', 'あなたのマス（州 {0},{1}）から', '州 {0},{1} のマスを1つ自分の土地にしました。'];
  for (const k of keys) assert.ok(EN[k], `EN for ${k}`);
  const rule = Object.keys(EN).find(k => k.startsWith('「1マス取る」はその州のマスを1つ、すぐ自分の土地にします（鉱石 {0}'));
  assert.ok(rule && EN[rule].includes('{7}'));
  assert.doesNotMatch([...keys, rule].map(k => EN[k]).join(' '), /season/i);
  assert.doesNotMatch(web('frontier/sampleland.mjs').replace(/\/\/.*$/gm, ''), /season/i);
});
