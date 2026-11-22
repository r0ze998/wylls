// devnet-p17 (devnet gap P17): the wide village screen's card 「この遠方の村への命令」 (permutation-server/web/frontier/
// screens/wideholding.mjs wideActsCard) — when it shows (a devnet page whose gateway carries all four wide village acts;
// never in local play, never with an older gateway), the notice above it, its four forms, the two-press preview in SOL
// (the roster's rent on a first muster) and the result read back, in Japanese and English. Key-free: no wallet, no key,
// no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, wideActsCard, wideActsOn, wideActResultLines, wideActLabel } from '../../permutation-server/web/frontier/screens/wideholding.mjs';
import { devnetLane } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { wideVillageCost, wideVillageResult } from '../../permutation-server/web/frontier/fdevnet-wide-village.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const ACTS = ['WideHarvest', 'WideBuild', 'WideTrain', 'WideMuster'];
const DP = { lane: devnetLane('1', { extra: ACTS }) };
const text = h => (Array.isArray(h) ? h.map(text).join('') : String(h ?? ''));
const store = r => ({ resource: r, value: '1000000', cap: '5000000', rate: '0', t0: '1', frac: '0' });
const economy = (o = {}) => ({ tier: 0, state: 2, flags: 0, faction: 1, order: 2, walls: 0, foundedTs: '1', lastOwnerAction: '1', shieldUntil: '0', finalTs: '1',
  foodShortfall: '0', escrow: '0', wallsCommittedBefore: '0', stores: ['Food', 'Wood', 'Stone', 'Ore', 'Gold', 'Science', 'Horses', 'Arms'].map(store),
  production: Array(8).fill('0'), upkeep: Array(8).fill('0'), queue: [{ index: 0, kind: 0, arg: 0, doneAt: '0', delta: '0', inUse: false }], reserve: [0, 0, 0, 0, 0, 0, 0, 0], ...o });
const holding = (o = {}) => ({ kind: 'WideHolding', wide: true, readOnly: true, executable: false, inventorySlot: 2, world: 'ab'.repeat(32), season: '1', p: 130n, q: -60n, ring: 130n, site: 2, generation: 1,
  ownerCitizen: 'C1tizen', hostIdentity: 1, openTransits: 0, capture: { address: 'Addr', slot: 10n, archiveSequence: 3, postState: 'transaction' },
  currentness: { capturedSlot: 10n, latestSlot: 12n, slotsBehind: 2n, current: 'unverified', age: 'unknown' }, economy: economy(o) });
const FSof = (over = {}, econ = {}) => ({ mode: 'play', tab: 'holding', devnetPlay: DP, wideStatus: 'ready', wideSelect: { inventorySlot: 2 },
  wideHoldings: { slots: [{ inventorySlot: 2, status: 'captured-unverified', holding: holding(econ) }] }, nowBell: 40, ...over });
const M = (econ = {}) => ({ kind: 'wide', holding: holding(econ) });

test('shown only on a devnet page whose gateway carries all four wide village acts; never in local play; the notice says which acts it sends', () => {
  setLang('ja');
  assert.equal(wideActsOn(FSof()), true);
  assert.equal(wideActsOn(FSof({ devnetPlay: null })), false);
  assert.equal(wideActsOn(FSof({ devnetPlay: { lane: devnetLane('1') } })), false, 'an older gateway: no card');
  assert.equal(wideActsOn(FSof({ devnetPlay: { lane: devnetLane('1', { extra: ['WideHarvest', 'WideBuild', 'WideTrain'] }) } })), false, 'three of four: no card');
  assert.equal(wideActsOn(FSof({ localPlay: { address: 'x' } })), false);
  const page = text(render(FSof()));
  assert.match(page, /id="wide-acts"/); assert.match(page, /この遠方の村への命令/);
  assert.match(page, /命令は、下の「この遠方の村への命令」だけが送ります（収穫・建設・訓練・編成）/);
  assert.doesNotMatch(page, /読み取り専用：この村には命令を送れません/);
  assert.match(page, /訓練と編成は「この遠方の村への命令」から送ります/);
  // without the card: the read-only notice, as before
  const ro = text(render(FSof({ devnetPlay: null })));
  assert.doesNotMatch(ro, /id="wide-acts"/); assert.match(ro, /読み取り専用：この村には命令を送れません/);
});

test('four forms, each its own first press (「費用を確認」); the muster offers the province\'s passable tiles once read', () => {
  setLang('ja');
  const h = text(wideActsCard(FSof({ wideActProvince: { p: '130', q: '-60', passable: [3, 17] } }), M({ reserve: [250] })));
  for (const a of ACTS) assert.match(h, new RegExp(`data-form="wide-act-preview" data-wide-act="${a}"`), a);
  assert.equal((h.match(/data-wide-preview=/g) ?? []).length, 4, 'one first press per act');
  assert.match(h, /<option value="-1">自動（通れる最初のマス）<\/option><option value="3">3<\/option><option value="17">17<\/option>/);
  assert.match(h, /name="wide_item"/); assert.doesNotMatch(h, /name="item"/, 'never `item`: a form\'s elements.item is the collection\'s item() method (P17 run 1: every Build read NaN)'); assert.match(h, /<option value="6">城壁<\/option>/); assert.match(h, /<option value="7">村の昇格<\/option>/);
  assert.doesNotMatch(h, /<option value="8">/, 'the workshop is not offered');
  assert.match(h, /控えの兵 250/); assert.match(h, /name="troops"[^>]*value="250"/);
  assert.doesNotMatch(h, /wide-act-send/, 'nothing to send before a preview');
});

test('the preview (first press): what the wallet pays in SOL — the fee, and the roster\'s rent on the province\'s first muster — and the send; a lag is said', () => {
  setLang('ja');
  const rent = 23_496_960n;
  const pv = { step: 'preview', name: 'WideMuster', fields: { unit: 0, troops: 100, tile: 17 }, village: { p: '130', q: '-60', site: 2 }, cost: wideVillageCost({ name: 'WideMuster', rosterRent: rent, rosterPresent: false }),
    rosterNew: true, warn: ['WideProvinceLag'], province: { resolvedNext: 30 }, wallet: 'w', at: Date.now() };
  const h = text(wideActsCard(FSof({ wideActPreview: pv }), M({ reserve: [250] })));
  assert.match(h, /最大 0\.02350196 SOL/); assert.match(h, /手数料（署名1つ）：0\.000005 SOL/); assert.match(h, /軍勢の名簿（3,248 バイト）の家賃 0\.02349696 SOL/);
  assert.match(h, /data-act="wide-act-send"/); assert.match(h, /data-act="wide-act-cancel"/); assert.match(h, /編成：槍兵 100（マス 17）/);
  assert.match(h, /30 ターンまで決着しています（いまはターン 40）/);
  assert.match(h, /data-wide-preview="WideHarvest" disabled/, 'no second preview while one stands');
  const harvest = text(wideActsCard(FSof({ wideActPreview: { ...pv, name: 'WideHarvest', fields: {}, cost: wideVillageCost({ name: 'WideHarvest' }), rosterNew: false, warn: [] } }), M()));
  assert.match(harvest, /最大 0\.000005 SOL/); assert.match(harvest, /<ul class="muted"><li>手数料（署名1つ）：0\.000005 SOL<\/li><\/ul>/, 'the fee alone: no roster line');
  // another wide village's preview is not this card's
  const other = text(wideActsCard(FSof({ wideActPreview: { ...pv, village: { p: '131', q: '-60', site: 2 } } }), M()));
  assert.doesNotMatch(other, /wide-act-send/);
  setLang('en');
  const en = text(wideActsCard(FSof({ wideActPreview: pv }), M({ reserve: [250] })));
  assert.match(en, /Your wallet pays at most 0\.02350196 SOL/); assert.match(en, /Orders to this far village/); assert.match(en, /rent of its host roster \(3,248 bytes\)/);
  setLang('ja');
});

test('the result read back: the record\'s own figures, before → after, in both languages', () => {
  setLang('ja');
  const res = wideVillageResult(economy(), economy({ reserve: [100, 0, 0, 0, 0, 0, 0, 0], lastOwnerAction: '9' }));
  const sent = { step: 'sent', name: 'WideTrain', fields: { unit: 0, n: 100 }, village: { p: '130', q: '-60', site: 2 }, signature: '5ig'.repeat(20), result: res };
  const h = text(wideActsCard(FSof({ wideActPreview: sent }), M()));
  assert.match(h, /訓練：槍兵 100/); assert.match(h, /チェーンに記録されました/); assert.match(h, /控えの槍兵：0 → 100/); assert.match(h, /data-wide-act-step="result"/);
  const waiting = text(wideActsCard(FSof({ wideActPreview: { ...sent, result: null } }), M()));
  assert.match(waiting, /遠方の村の記録を読み直しています/); assert.match(waiting, /data-wide-act-step="sent"/);
  assert.match(wideActResultLines({ changed: false, unread: true })[0], /まだ変わって見えません/);
  assert.match(wideActLabel('WideBuild', { item: 6 }), /建設：城壁/);
  setLang('en');
  assert.match(text(wideActsCard(FSof({ wideActPreview: sent }), M())), /Spearmen in reserve: 0 → 100|in reserve: 0 → 100/);
  setLang('ja');
});
