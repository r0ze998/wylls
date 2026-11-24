// loop-play15 (first play-through with player territory, #209):
//  LP15-1  a refused tile claim spoke of other things — "one tile a turn" (program Cooldown 29) read "The host is resting
//          or short of stamina.", unpaid land upkeep (NotEligible 43) read as a refund sentence. The claim's own sentences.
//  LP15-4  once a village of the player stood in a wide province, the card dropped that province's row and with it the
//          only "Claim a tile" button there; with three villages the whole list went. Those provinces stay, tile-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wideClaimModel } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const cell = (p, q) => ({ key: `${p},${q}`, p: String(p), q: String(q), ring: 129, territory: { siteTiles: [3, 9], keepTile: 59 }, villages: [], keep: null });
const home = { p: -66, q: -62, site: 8, order: 1 };
const world = (slots = []) => {
  const cells = [cell(-66, -63), cell(-67, -62), cell(-67, -63)];
  return { localPlay: { wideLand: { scale: 60, targets: cells.map(c => ({ p: c.p, q: c.q })) } }, holdings: [home], ui: {}, citizen: { faction: 0 },
    wideLandNow: () => ({ cells, byKey: new Map(cells.map(c => [c.key, c])) }),
    ...(slots.length ? { wideStatus: 'ready', wideHoldings: { slots } } : {}) };
};
const slot = (n, p, q) => ({ inventorySlot: n, status: 'captured-unverified', holding: { p: BigInt(p), q: BigInt(q), site: 0 } });
const have = [2000, 2000, 2000, 500, 0, 2000, 0, 0];

test('LP15-4: the province of the player\'s own wide village stays on the card as a tile-only row', () => {
  const before = wideClaimModel(world(), { holding: home, have });
  assert.deepEqual(before.own, [], 'no wide village yet: no own row');
  assert.ok(before.targets.some(t => t.p === '-66' && t.q === '-63' && t.territory));
  const after = wideClaimModel(world([slot(2, -66, -63)]), { holding: home, have });
  assert.ok(!after.targets.some(t => t.p === '-66' && t.q === '-63'), 'no second village in that province');
  assert.deepEqual(after.own.map(t => [t.p, t.q, t.territory, t.own]), [['-66', '-63', true, true]]);
  assert.equal(after.full, false);
});

test('LP15-4: with three villages the tile rows stay (own provinces and the others)', () => {
  const full = wideClaimModel(world([slot(2, -66, -63), slot(3, -67, -62)]), { holding: home, have });
  assert.equal(full.full, true);
  assert.deepEqual(full.own.map(t => `${t.p},${t.q}`).sort(), ['-66,-63', '-67,-62']);
  assert.deepEqual(full.targets.filter(t => t.territory).map(t => `${t.p},${t.q}`), ['-67,-63']);
  const src = web('frontier/screens/holding.mjs');
  assert.match(src, /w\.own\.length \? html`<ul class="build-list">\$\{w\.own\.map\(/);
  assert.match(src, /w\.full \? html`<p class="muted">\$\{L`村はもう3つあります。`\}<\/p>\$\{w\.targets\.some\(t => t\.territory\)/);
});

test('LP15-4: a world without player land keeps the old card (no own rows, nothing when no target is left)', () => {
  const w = world([slot(2, -66, -63)]);
  w.wideLandNow = () => null;
  const m = wideClaimModel(w, { holding: home, have });
  assert.deepEqual(m.own, []);
  assert.equal(m.territory, false);
  const none = { ...w, localPlay: { wideLand: { scale: 60, targets: [{ p: '-66', q: '-63' }] } } };
  assert.equal(wideClaimModel(none, { holding: home, have }), null);
});

test('LP15-1: a refused tile claim is answered in the claim\'s own words (turn limit, unpaid upkeep, ore), in both languages', () => {
  const src = web('frontier/controller.mjs');
  assert.match(src, /const territoryRefusalText = pc => \(pc === 29 \? L`このターンはもう1マス取りました。/);
  assert.match(src, /: pc === 43 \? L`土地の維持費（本拠地の食料）が払えていないので、新しいマスは取れません。/);
  assert.match(src, /: pc === 21 \? L`鉱石が足りません。/);
  assert.equal((src.match(/territoryRefused\(ans\);/g) ?? []).length, 2, 'the tile button and the first press of "Found a village here"');
  // (the program's numbers: frontier-abi error.rs Cooldown 29, NotEligible 43, Insufficient 21 — wide_territory.rs territory_err)
  const errs = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/errors.json', import.meta.url), 'utf8'));
  const byName = Object.fromEntries((errs.errors ?? errs).map(e => [e.name, e.code]));
  assert.deepEqual([byName.Cooldown, byName.NotEligible, byName.Insufficient], [29, 43, 21]);
  setLang('en');
  try {
    assert.equal(L`このターンはもう1マス取りました。マスは1ターンに1つです。次のターンにもう一度押してください。`, 'You already claimed a tile this turn. It is one tile a turn: press again next turn.');
    assert.match(L`土地の維持費（本拠地の食料）が払えていないので、新しいマスは取れません。本拠地に食料が戻ると、また取れます。払えないまま24ターンたつと、遠いマスから1ターンに1つずつ手放されます。`, /^Your land upkeep \(food from your first village\) is unpaid/);
    assert.match(L`鉱石が足りません。1マスは鉱石 10 で、持っているマス1つごとに 2% 高くなります（本拠地の蔵から払います）。`, /^Not enough ore\./);
    assert.equal(L`あなたの村がある州`, 'your village stands here');
  } finally { setLang('ja'); }
});

// (verify-pr223) "Claim a tile" is off while the first village has less than the base price in ore: the card says why
test('verify-pr223: a tile button that is off for lack of ore says so on the card, in both languages', () => {
  const ore = 3;   // resources.mjs RESOURCE_ORDER: Food, Wood, Stone, Ore
  assert.equal(wideClaimModel(world(), { holding: home, have: have.map((v, i) => (i === ore ? 9 : v)) }).tileShort, true);
  assert.equal(wideClaimModel(world(), { holding: home, have: have.map((v, i) => (i === ore ? 10 : v)) }).tileShort, false);
  const src = web('frontier/screens/holding.mjs');
  assert.match(src, /\$\{w\.territory && w\.tileShort \? html`<p class="muted"><span class="blocked">\$\{L`鉱石が 10 に足りないので、いまは「1マス取る」を押せません。`\}<\/span><\/p>` : ''\}/);
  setLang('en');
  try { assert.equal(L`鉱石が 10 に足りないので、いまは「1マス取る」を押せません。`, 'You have less than 10 ore, so "Claim a tile" cannot be pressed for now.'); } finally { setLang('ja'); }
});

// (verify-pr223, merge of #221) the own-village rows are a LOCAL wide world's: the devnet page's wallet-paid tile claim
// has not been played with them, so a devnet territory world keeps #221's card
test('verify-pr223: a devnet territory world gets no own-village rows', () => {
  const l = world([slot(2, -66, -63)]);
  const d = { ...l, localPlay: null, devnetWideLand: l.localPlay.wideLand, devnetTerritory: true };
  assert.equal(wideClaimModel(l, { holding: home, have }).own.length, 1);
  assert.deepEqual(wideClaimModel(d, { holding: home, have })?.own ?? [], []);
  assert.match(web('frontier/screens/holding.mjs'), /const own = territory && local \? claimTargets\(/);
});
