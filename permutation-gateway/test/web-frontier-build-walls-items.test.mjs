// A walls order needs a free wall item in the village's site mirror (proc/holding.rs build_as → wall_item: two items;
// an item is free once its turn — the effective bell — is ≤ the province's resolved_next; both waiting → QueueFull).
// The page checked only the village's queue slots and the 1,200 cap, so a third walls order was offered while two
// waited for their turn, and only the send was refused (2026-11-16). Nothing is built, signed or sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOffers, wallItemsBusy } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { buildCards } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { whyText } from '../../permutation-server/web/frontier/hud/orderparts.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 0n, frac: 0n });
const holding = (extra = {}) => ({ p: 2, q: 3, site: 1, gen: 4, tier: 1, faction: 1, walls: 200, flags: 0, queue: [], stores: Array.from({ length: 8 }, () => store(5000)), ...extra });
const have = Array(8).fill(5000);
const mirror = (i0, i1, extra = {}) => ({ state: 1, gen: 4, wallItem0Bell: i0[0], wallItem0Delta: i0[1], wallItem1Bell: i1[0], wallItem1Delta: i1[1], ...extra });
const wallsOf = offers => offers.find(o => o.kind === 'walls');

test('the program writes each walls order into one of two site-mirror items, freed once its turn is resolved', () => {
  const src = read('permutation-frontier/src/proc/holding.rs');
  const at = src.indexOf('fn wall_item('), body = src.slice(at, at + 2000);
  assert.ok(at >= 0);
  assert.match(body, /\(SM::WALL_ITEM0_BELL, SM::WALL_ITEM0_DELTA\),\s*\(SM::WALL_ITEM1_BELL, SM::WALL_ITEM1_DELTA\),/);
  assert.match(body, /if idl > 0 && ib <= resolved_next \{/, 'an item whose turn is resolved is folded and freed');
  assert.match(body, /if w\.u32\(o \+ dl\)\? == 0 \{/, 'a free item has no delta');
  assert.match(body, /Err\(FrontierError::QueueFull\.into\(\)\)\s*\}/, 'both busy: QueueFull');
  const b = src.slice(src.indexOf('pub(crate) fn build_as('), src.indexOf('fn tier_next_item('));
  assert.ok(b.indexOf('h.enqueue(') < b.indexOf('wall_item(&pl, &hh, province, done_at'), 'after the village queue');
  // and the page reads the same four fields from the province's site mirror
  assert.match(read('permutation-server/web/frontier/abi.mjs'), /\["WALL_ITEM0_BELL",44,4,"u32"\],\["WALL_ITEM0_DELTA",48,4,"u32"\],\["WALL_ITEM1_BELL",52,4,"u32"\],\["WALL_ITEM1_DELTA",56,4,"u32"\]/);
});

test('wallItemsBusy: both items waiting for their turn, and only then', () => {
  assert.equal(wallItemsBusy(mirror([12, 100], [13, 100]), 10), true, 'both ahead of the resolved turn');
  assert.equal(wallItemsBusy(mirror([12, 100], [13, 100]), 12), false, 'one resolved: folded, free');
  assert.equal(wallItemsBusy(mirror([12, 100], [0, 0]), 10), false, 'one empty');
  assert.equal(wallItemsBusy(mirror([0, 0], [0, 0]), 10), false);
  assert.equal(wallItemsBusy(null, 10), false, 'no mirror: the program decides');
});

test('the walls offer is held back while both items wait, with the other reasons beside it; buildings are not', () => {
  const free = buildOffers(holding(), { now: 1000, have, mirror: mirror([12, 100], [0, 0]), resolvedNext: 10 });
  assert.deepEqual(wallsOf(free).blocks, []);
  const busy = buildOffers(holding(), { now: 1000, have, mirror: mirror([12, 100], [13, 100]), resolvedNext: 10 });
  assert.deepEqual(wallsOf(busy).blocks, ['WallsBusy']);
  assert.ok(busy.filter(o => o.kind === 'building').every(o => o.blocks.length === 0), 'buildings use no wall item');
  const poor = buildOffers(holding(), { now: 1000, have: Array(8).fill(0), mirror: mirror([12, 100], [13, 100]), resolvedNext: 10 });
  assert.deepEqual(wallsOf(poor).blocks, ['WallsBusy', 'Insufficient']);
  assert.deepEqual(wallsOf(buildOffers(holding(), { now: 1000, have })).blocks, [], 'without a mirror: as before');
});

test('buildCards takes the village\'s own site mirror (its province, its site, its generation) only', () => {
  const prov = (m, extra = {}) => ({ p: 2, q: 3, resolvedNext: 10, siteMirror: [mirror([0, 0], [0, 0]), m], ...extra });
  const stores = have.map(value => ({ value }));
  const cardsOf = province => wallsOf(buildCards(holding(), stores, { now: 1000, faction: 1, province }));
  assert.deepEqual(cardsOf(prov(mirror([12, 100], [13, 100]))).blocks, ['WallsBusy']);
  assert.deepEqual(cardsOf(prov(mirror([12, 100], [13, 100]), { resolvedNext: 13 })).blocks, []);
  assert.deepEqual(cardsOf(prov(mirror([12, 100], [13, 100], { gen: 5 }))).blocks, [], 'another generation: not this village\'s items');
  assert.deepEqual(cardsOf(prov(mirror([12, 100], [13, 100]), { p: 9 })).blocks, [], 'another province');
  assert.deepEqual(cardsOf(null).blocks, []);
});

test('the reason, in both languages', () => {
  assert.equal(whyText('WallsBusy'), '城壁の工事は 2 つ先までです。前の工事が仕上がり、そのターンが決着してからです');
  setLang('en');
  try {
    const e = whyText('WallsBusy');
    assert.doesNotMatch(e, /[぀-ヿ㐀-鿿]/);
    assert.doesNotMatch(e, /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i);
    assert.match(e, /two works on the walls/);
  } finally { setLang('ja'); }
});
