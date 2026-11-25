// territory-card (owner 2026-11-25 08:56, Q-PDT-1 (a) and Q-PDT-2 (a); display only, no rule changed):
//  Q-PDT-1 (a)  the village card's wide-land section shows the viewer's OWN land — tiles owned, the next tile's price
//               (whole ore, the kernel's rounding), upkeep per hour (food), and while upkeep is unpaid a warning with the
//               turns left until tiles are let go. The numbers are the program's (permutation-rules frontier/territory.rs
//               claim_cost / unpaid_effect, frontier-abi world_index/territory.rs TERRITORY_V1, TerritoryPlayer::
//               upkeep_per_hour): checked here against the kernel mirror territory-rules.mjs, which answers the Rust
//               vectors (web-frontier-territory-rules.test.mjs), and against numbers worked from the Rust formulas.
//  Q-PDT-2 (a)  with three villages the "Claim a tile" rows stay (the rule caps villages, not land).
// FOG: only the record at the viewer's own Citizen's address is read; another Citizen's record is never shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import * as K from '../../permutation-server/web/frontier/territory-rules.mjs';
import { wideClaimModel, ownLandBlock } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { LAND_SUMMARY_SCHEMA, landSummaryOk, landOfSummary } from '../../permutation-server/web/frontier/fdevnet-territory.mjs';
import { createDevnetPlayAct, DEVNET_LAND_SUMMARY_SCHEMA } from '../src/frontier/devnet-play-act.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const rust = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

/** A territory summary record (frontier-abi territory_player layout: UNPAID @19, CITIZEN_TAG @84, TILES @92, EXCESS_SUM @96, UNPAID_SINCE @120). */
function summaryBytes({ tiles = 0, excess = 0n, unpaidSince = null, tag = 77n } = {}) {
  const b = new Uint8Array(320), v = new DataView(b.buffer);
  b.set([...'PSFXWTU1'].map(c => c.charCodeAt(0))); b[18] = 1; b[19] = unpaidSince === null ? 0 : 1;
  v.setBigUint64(84, tag, true); v.setUint32(92, tiles, true); v.setBigUint64(96, excess, true); v.setUint32(120, unpaidSince ?? 0, true);
  return b;
}
const view = (o, bell = 0) => T.ownLandView(T.decodeTerritoryPlayer(summaryBytes(o)), bell);

test('the JS numbers are the Rust numbers (TERRITORY_V1: 33 + 16 beyond 3, 10 ore + 2 %, 24 turns)', () => {
  const abi = rust('frontier-abi/src/world_index/territory.rs');
  assert.match(abi, /flat: 33,\s+per_rank: 0,\s+per_distance: 16,\s+free_distance: 3,/);
  assert.match(abi, /base: 10,\s+per_owned_bps: 200,/);
  assert.match(abi, /decay_after_bells: Some\(24\),/);
  assert.deepEqual(T.TERRITORY_V1.upkeep, { flat: 33, perRank: 0, perDistance: 16, freeDistance: 3 });
  assert.deepEqual(T.TERRITORY_V1.cost, { base: 10, perOwnedBps: 200 });
  assert.equal(T.TERRITORY_V1.decayAfterBells, 24);
  // the summary's fields where the Rust layout puts them
  for (const [name, at] of [['UNPAID', 19], ['CITIZEN_TAG', 84], ['TILES', 92], ['EXCESS_SUM', 96], ['UNPAID_SINCE', 120]]) assert.match(abi, new RegExp(`${name} @ ${at} :`));
});

test('next price: whole ore, rounded down as the kernel does (claim_cost), for every count up to 400', () => {
  // (worked from base + base × owned × bps / 10,000: the price rises by one ore every five tiles)
  for (const [tiles, ore] of [[0, 10], [1, 10], [4, 10], [5, 11], [9, 11], [10, 12], [49, 19], [50, 20], [61, 22], [100, 30], [399, 89]]) assert.equal(view({ tiles }).nextOre, ore, `${tiles} tiles`);
  for (let n = 0; n <= 400; n++) assert.equal(BigInt(view({ tiles: n }).nextOre), K.claimCost({ base: 10, perOwnedBps: 200 }, n), `kernel mirror at ${n}`);
  assert.equal(T.ownLandView(null, 5).nextOre, 10, 'no record yet: the first tile');
});

test('upkeep per hour: tiles × 33 + 16 × Σ(distance beyond 3) milli-food, the kernel\'s sum over the same tiles', () => {
  for (const distances of [[], [0], [1, 2, 3], [4], [3, 4, 7], Array(61).fill(2), [...Array(30).fill(1), ...Array(31).fill(5)]]) {
    const excess = distances.reduce((a, d) => a + BigInt(Math.max(0, d - 3)), 0n);
    const v = view({ tiles: distances.length, excess });
    assert.equal(v.upkeepMilliPerHour, K.upkeepPerHour(T.TERRITORY_V1.upkeep, distances), JSON.stringify(distances));
    assert.equal(v.tiles, distances.length);
  }
  assert.equal(view({ tiles: 61 }).upkeepMilliPerHour, 2013, 'a whole near province: 2.013 food an hour');
  assert.equal(T.ownLandView(null, 0).upkeepMilliPerHour, 0);
});

test('unpaid: the turns left are the kernel\'s grace (unpaid_effect releases once 24 turns passed), then one tile a turn', () => {
  const rule = { blockClaims: true, productionBps: 10_000, decayAfterBells: 24, decayEveryBells: 1 };
  for (let late = 0; late <= 40; late++) {
    const v = view({ tiles: 5, unpaidSince: 100 }, 100 + late), k = K.unpaidEffect(rule, 100, 100 + late);
    assert.equal(v.unpaid, true);
    assert.equal(v.turnsLeft, Math.max(0, 24 - late), `late ${late}`);
    assert.equal(v.letting, k.cellsReleased > 0, `late ${late}: letting go exactly when the kernel releases`);
    assert.equal(v.turnsLeft === 0, k.cellsReleased > 0);
  }
  assert.deepEqual([view({ tiles: 5 }, 999).unpaid, view({ tiles: 5 }, 999).turnsLeft, view({ tiles: 5 }, 999).letting], [false, null, false], 'paid: no warning');
  assert.equal(view({ tiles: 0, unpaidSince: 1 }, 500).letting, false, 'nothing left to let go');
  assert.equal(view({ tiles: 5, unpaidSince: 100 }, 90).turnsLeft, 24, 'a clock behind the record never counts above the grace');
});

// ---------------------------------------------------------------- the card
const cell = (p, q) => ({ key: `${p},${q}`, p: String(p), q: String(q), ring: 129, territory: { siteTiles: [3, 9], keepTile: 59 }, villages: [], keep: null });
const home = { p: -66, q: -62, site: 8, order: 1 };
const world = (slots = [], extra = {}) => {
  const cells = [cell(-66, -63), cell(-67, -62), cell(-67, -63)];
  return { localPlay: { wideLand: { scale: 60, targets: cells.map(c => ({ p: c.p, q: c.q })) } }, holdings: [home], ui: {}, citizen: { faction: 0 }, nowBell: 110,
    wideLandNow: () => ({ cells, byKey: new Map(cells.map(c => [c.key, c])) }),
    ...(slots.length ? { wideStatus: 'ready', wideHoldings: { slots } } : {}), ...extra };
};
const slot = (n, p, q) => ({ inventorySlot: n, status: 'captured-unverified', holding: { p: BigInt(p), q: BigInt(q), site: 0 } });
const have = [2000, 2000, 2000, 500, 0, 2000, 0, 0], ORE = 3;
const ownLand = o => ({ world: 'w', citizen: 'c', at: 1, player: o === null ? null : T.decodeTerritoryPlayer(summaryBytes(o)) });

test('Q-PDT-1: the card model carries the viewer\'s own land once it was read; unread, the old card', () => {
  assert.equal(wideClaimModel(world(), { holding: home, have }).land, null, 'not read yet: no line');
  const none = wideClaimModel(world([], { ownLand: ownLand(null) }), { holding: home, have }).land;
  assert.deepEqual([none.tiles, none.nextOre, none.upkeepMilliPerHour, none.unpaid], [0, 10, 0, false], 'no record yet: 0 tiles, the first price');
  const m = wideClaimModel(world([], { ownLand: ownLand({ tiles: 7, excess: 2n }) }), { holding: home, have });
  assert.deepEqual([m.land.tiles, m.land.nextOre, m.land.upkeepMilliPerHour, m.land.unpaid], [7, 11, 7 * 33 + 32, false]);
  const u = wideClaimModel(world([], { ownLand: ownLand({ tiles: 7, unpaidSince: 100 }) }), { holding: home, have }).land;
  assert.deepEqual([u.unpaid, u.turnsLeft, u.letting], [true, 14, false], 'bell 110, unpaid since 100: 14 turns left');
  // a world without player land: no land line whatever was read
  const w = world([], { ownLand: ownLand({ tiles: 7 }) }); w.wideLandNow = () => null;
  assert.equal(wideClaimModel(w, { holding: home, have }).land, null);
});

test('Q-PDT-1: "Claim a tile" is off below the NEXT tile\'s price, and the card says which price', () => {
  const at = (tiles, ore) => wideClaimModel(world([], { ownLand: ownLand({ tiles }) }), { holding: home, have: have.map((v, i) => (i === ORE ? ore : v)) });
  assert.deepEqual([at(50, 19).tileOff, at(50, 19).tilePriceShort, at(50, 19).tilePrice, at(50, 19).tileShort], [true, true, 20, false]);
  assert.deepEqual([at(50, 20).tileOff, at(50, 20).tilePriceShort], [false, false]);
  assert.deepEqual([at(50, 9).tileOff, at(50, 9).tilePriceShort, at(50, 9).tileShort], [true, false, true], 'below 10: the old sentence');
  const unread = wideClaimModel(world(), { holding: home, have: have.map((v, i) => (i === ORE ? 10 : v)) });
  assert.deepEqual([unread.tileOff, unread.tilePrice], [false, 10], 'unread: the base price, as before');
  const src = web('frontier/screens/holding.mjs');
  assert.equal((src.match(/busy \|\| w\.tileOff \? 'disabled'/g) ?? []).length, 3, 'every "Claim a tile" button');
  assert.match(src, /\$\{ownLandBlock\(w\.land\)\}/);
});

test('Q-PDT-1: the land lines in Japanese and English — tiles, next price, upkeep, and the unpaid warning with the turns left', () => {
  const lines = (o, bell) => String(ownLandBlock(T.ownLandView(o === null ? null : T.decodeTerritoryPlayer(summaryBytes(o)), bell))).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(String(ownLandBlock(null)), '');
  try {
    setLang('ja');
    assert.equal(lines({ tiles: 7, excess: 2n }, 0), 'あなたの土地: 持っているマス 7 · 次の1マス: 鉱石 11 · 土地の維持費: 食料 0.263/時');
    assert.match(lines({ tiles: 7, unpaidSince: 100 }, 110), /払えていません。新しいマスは取れません。あと 14 ターン払えないままだと、遠いマスから1ターンに1つずつ手放されます。$/);
    assert.match(lines({ tiles: 7, unpaidSince: 100 }, 124), /遠いマスから1ターンに1つずつ手放されています。本拠地に食料が戻ると止まります。$/);
    setLang('en');
    assert.equal(lines(null, 0), 'Your land: tiles owned: 0 · next tile: 10 ore · land upkeep: 0 food per hour');
    assert.equal(lines({ tiles: 61 }, 0), 'Your land: tiles owned: 61 · next tile: 22 ore · land upkeep: 2.013 food per hour');
    assert.equal(lines({ tiles: 7, unpaidSince: 100 }, 110), 'Your land: tiles owned: 7 · next tile: 11 ore · land upkeep: 0.231 food per hour Your land upkeep (food from your first village) is unpaid. No new tile can be claimed. If it stays unpaid for 14 more turns, your farthest tiles are let go, one per turn.');
    assert.match(lines({ tiles: 7, unpaidSince: 100 }, 130), /is unpaid\. Your farthest tiles are being let go, one per turn\. It stops once your first village has food again\.$/);
    assert.match(lines({ tiles: 0, unpaidSince: 100 }, 130), /is unpaid\. No new tile can be claimed\. Once your first village has food again, you can claim again\.$/);
    for (const o of [null, { tiles: 7 }, { tiles: 7, unpaidSince: 100 }, { tiles: 0, unpaidSince: 1 }]) for (const b of [110, 124, 500]) {
      const t = lines(o, b);
      assert.ok(!/[぀-ヿ一-鿿]/.test(t), `no Japanese left in English: ${t}`);
      assert.ok(!/season/i.test(t), 'never "season"');
    }
  } finally { setLang('ja'); }
});

test('Q-PDT-2: with three villages the "Claim a tile" rows remain, with the land line', () => {
  const full = wideClaimModel(world([slot(2, -66, -63), slot(3, -67, -62)], { ownLand: ownLand({ tiles: 12 }) }), { holding: home, have });
  assert.equal(full.full, true);
  assert.deepEqual(full.own.map(t => `${t.p},${t.q}`).sort(), ['-66,-63', '-67,-62'], 'the provinces of the two wide villages: tile rows');
  assert.deepEqual(full.targets.filter(t => t.territory).map(t => `${t.p},${t.q}`), ['-67,-63'], 'and the other provinces in reach');
  assert.deepEqual([full.land.tiles, full.land.nextOre, full.tileOff], [12, 12, false]);
  const src = web('frontier/screens/holding.mjs');
  assert.match(src, /w\.full \? html`<p class="muted">\$\{L`村はもう3つあります。`\}<\/p>\$\{w\.targets\.some\(t => t\.territory\) \? html`<ul class="build-list">\$\{w\.targets\.filter\(t => t\.territory\)\.map\(/);
  // with three villages there is no next village: the village cost line (and its "Short: …") is not shown
  assert.match(src, /\$\{w\.full \? '' : html`<p class="muted">\$\{L`費用（村の蔵から）`\}: \$\{cost\}/);
  // a devnet territory world with three villages keeps the rows of the other provinces too
  const l = world([slot(2, -66, -63), slot(3, -67, -62)]);
  const d = wideClaimModel({ ...l, localPlay: null, devnetWideLand: l.localPlay.wideLand, devnetTerritory: true }, { holding: home, have });
  assert.equal(d.full, true); assert.deepEqual(d.targets.filter(t => t.territory).map(t => `${t.p},${t.q}`), ['-67,-63']);
});

test('FOG: the page reads only the record of the viewer\'s own Citizen, and drops an answer of another tag', () => {
  const src = web('frontier/controller.mjs');
  assert.match(src, /const at = territoryPlayerAddress\(pin\.addresses\.season, pin\.programId, citizen\);\n\s+const j = await localAct\.postLocalAct\(g\.relay, localAct\.LOCAL_ACT_CONTEXT_PATH, \{ schema: OWN_LAND_READ, addresses: \[at\] \}\);/);
  assert.match(src, /if \(j\.accounts\[0\] && \(!player \|\| player\.citizenTag !== citizenTagOf\(citizen\)\)\) return;/);
  assert.match(src, /const citizen = viewerCitizen\(\), world = providerWorld\(\);\n\s+if \(FS\.ownLand && \(FS\.ownLand\.citizen !== citizen \|\| FS\.ownLand\.world !== world\)\) FS\.ownLand = undefined;/, 'another world or Citizen: the old answer is gone');
  assert.match(src, /schema: devnetTerritory\.LAND_SUMMARY_SCHEMA, wallet: FS\.wallet\.address \}/);
  assert.equal((src.match(/refreshOwnLand\(\{ force: true \}\)/g) ?? []).length, 2, 'after the tile button and after "Found a village here"');
  // a read that failed (an older devnet gateway: LocalActInvalid) is not asked again at every poll
  assert.match(src, /const OWN_LAND_RETRY_MS = 10_000, OWN_LAND_RETRY_DEVNET_MS = 300_000;/);
  assert.match(src, /if \(!force && Date\.now\(\) < ownLandRetryAt\) return;/);
  assert.match(src, /ownLandRetryAt = answered \? 0 : Date\.now\(\) \+ \(local \? OWN_LAND_RETRY_MS : OWN_LAND_RETRY_DEVNET_MS\);/);
  // display only: nothing in the refresh signs or sends
  const body = src.slice(src.indexOf('async function refreshOwnLand'), src.indexOf('// ------------------------------------------------------------------ ② rights'));
  assert.ok(!/(^|[^A-Za-z.])act\(|submitLocal|currentEphemeralWallet/.test(body), 'a read, never an act: no order, no submit, no wallet key');
});

// ---------------------------------------------------------------- the devnet gateway's land summary
const PROGRAM = encode(new Uint8Array(32).fill(0x61)), SEASON_ID = '3', A = seasonAddresses(PROGRAM, SEASON_ID);
const WALLET = encode(new Uint8Array(32).fill(0x21)), CITIZEN_AT = A.of('Citizen', { wallet: WALLET });
const TPLAYER_AT = T.territoryPlayerAddress(A.season, PROGRAM, CITIZEN_AT), TAG = BigInt(T.citizenTagOf(CITIZEN_AT));
const row = (bytes, owner = PROGRAM) => (bytes === null ? null : { owner, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
function gateway(tplayer) {
  const rpc = [], asked = [];
  const flow = createDevnetPlayAct({ cfg: { cluster: 'devnet', rpc: 'https://rpc.devnet.example', programId: PROGRAM, seasonId: SEASON_ID, devnetPlay: true, devnetPlayRulesetHash: rulesetFor(3) },
    rpc: async (method, params) => {
      rpc.push(method);
      if (method === 'getMultipleAccounts') { asked.push(params[0]); return { result: { context: { slot: 91 }, value: params[0].map(a => (a === TPLAYER_AT ? tplayer : null)) } }; }
      return { error: { code: -1 } };
    } });
  return { flow, rpc, asked };
}

test('devnet: the gateway\'s land summary is ONE read of the wallet\'s own record; the page\'s view of it gives the same numbers', async () => {
  assert.equal(LAND_SUMMARY_SCHEMA, DEVNET_LAND_SUMMARY_SCHEMA, 'the page asks with the gateway\'s schema');
  for (const [tplayer, want] of [
    [null, { player_present: false, tiles: 0, excess_sum: '0', unpaid: false, unpaid_since: null }],
    [row(summaryBytes({ tiles: 7, excess: 2n, tag: TAG })), { player_present: true, tiles: 7, excess_sum: '2', unpaid: false, unpaid_since: null }],
    [row(summaryBytes({ tiles: 3, unpaidSince: 100, tag: TAG })), { player_present: true, tiles: 3, excess_sum: '0', unpaid: true, unpaid_since: 100 }],
    // another program's account, or a record naming another Citizen: answered as absent
    [row(summaryBytes({ tiles: 9, tag: TAG }), encode(new Uint8Array(32).fill(4))), { player_present: false, tiles: 0, excess_sum: '0', unpaid: false, unpaid_since: null }],
    [row(summaryBytes({ tiles: 9, tag: TAG + 1n })), { player_present: false, tiles: 0, excess_sum: '0', unpaid: false, unpaid_since: null }]]) {
    const g = gateway(tplayer);
    const ctx = JSON.parse(JSON.stringify(await g.flow.context({ schema: DEVNET_LAND_SUMMARY_SCHEMA, wallet: WALLET })));
    assert.deepEqual(ctx, { schema: DEVNET_LAND_SUMMARY_SCHEMA, wallet: WALLET, context_slot: '91', ...want });
    assert.deepEqual(g.rpc, ['getMultipleAccounts'], 'one read, nothing sent'); assert.deepEqual(g.asked, [[TPLAYER_AT]]);
    assert.equal(landSummaryOk(ctx, WALLET), true); assert.equal(landSummaryOk(ctx, CITIZEN_AT), false, 'an answer for another wallet is refused');
    const v = T.ownLandView(landOfSummary(ctx), 110);
    assert.deepEqual([v.tiles, v.nextOre, v.upkeepMilliPerHour, v.unpaid, v.turnsLeft], [want.tiles, T.claimCostV1(want.tiles), want.tiles * 33 + 16 * Number(want.excess_sum), want.unpaid, want.unpaid ? 14 : null]);
  }
  const g = gateway(null);
  for (const bad of [{ schema: DEVNET_LAND_SUMMARY_SCHEMA }, { schema: DEVNET_LAND_SUMMARY_SCHEMA, wallet: 'x' }, { schema: DEVNET_LAND_SUMMARY_SCHEMA, wallet: WALLET, target: { p: '130', q: '-60' } }])
    await assert.rejects(g.flow.context(bad), e => e.code === 'LocalActInvalid');
  assert.deepEqual(g.rpc, [], 'a bad request reads nothing');
  for (const bad of [null, {}, { schema: LAND_SUMMARY_SCHEMA, wallet: WALLET, player_present: true, tiles: -1, excess_sum: '0', unpaid: false, unpaid_since: null },
    { schema: LAND_SUMMARY_SCHEMA, wallet: WALLET, player_present: true, tiles: 1, excess_sum: '0', unpaid: true, unpaid_since: null },
    { schema: LAND_SUMMARY_SCHEMA, wallet: WALLET, player_present: false, tiles: 4, excess_sum: '0', unpaid: false, unpaid_since: null }]) assert.equal(landSummaryOk(bad, WALLET), false);
});
