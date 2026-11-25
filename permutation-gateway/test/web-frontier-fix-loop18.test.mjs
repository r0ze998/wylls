// fix-loop18 (loop-play18's low findings, page text and buttons only; no rule changed):
//  LP18-2  with one village the caravan form's default destination was the sending village itself ("The caravan would
//          leave from where it goes"). The form's only start is not listed as a destination, and where nothing of the
//          viewer's own is left to choose first the field starts on "(choose a destination)", which sends nothing.
//  LP18-3  the "destination list has changed" toast offered "Try again", which could only repeat the refusal.
//  LP18-4  a province with no tile left kept an open "Claim a tile". The button is shut, with the reason beside it,
//          once the page knows the province is full; the press's own answer stays for a race (without "Try again").
//  LP18-7  a falling store's hover text says "Empty in …", as a rising one says "Full in …".
//  LP18-8  with the net food at 0 or below the claim card says another tile cannot be paid from what the village makes.
//  LP18-9  the release line said "It stops once your first village has food again." — the rule (#243, frontier-abi
//          settle_upkeep) is: unpaid ends on a turn the store pays in full; with the store taken every unpaid turn that
//          is when one turn's food covers one turn's upkeep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import * as LF from '../../permutation-server/web/frontier/landfood.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import { wideClaimModel, ownLandBlock, provinceFull } from '../../permutation-server/web/frontier/screens/holding.mjs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import * as FOG from '../../permutation-server/web/frontier/map/fog.mjs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { statusOf, renderStatus } from '../../permutation-server/web/frontier/hud/status.mjs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const rust = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ the caravan form (LP18-2, LP18-3)
const ALL = (1n << 61n) - 1n;
const bstore = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => bstore(1000)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [],
  ownerCitizen: new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0, ...Array(24).fill(0)]) });
const prov = (p, q, extra = {}) => ({ p, q, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 2, sites: [5, 6], camp: { state: 1, tile: 7 }, keep: { tile: 8, holder: 1 }, resolvedNext: 10, structures: [], forts: [], caravans: [], ...extra });
const s1World = (extra = {}) => ({ mode: 'play', nowBell: 100, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 0, caravans: 4, voted: [0, 0, 0, 0] },
  holdings: [holding(0, 0, 0, 30)], activeHolding: 0, provinces: new Map(), s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [], sightings: [] }, nations: null }, ...extra });
// (1,0): another nation's village on tile 5 and a nation-mate's on tile 6
const others = () => new Map([['0,0', { province: prov(0, 0, { siteMirror: [{ state: 1, faction: 1 }, { state: 0 }] }) }], ['1,0', { province: prov(1, 0, { siteMirror: [{ state: 1, faction: 2 }, { state: 1, faction: 1 }] }) }]]);
const dstSelect = h => /<select name="dst"[^>]*>(.*?)<\/select>/s.exec(String(h))?.[1] ?? null;
const options = sel => [...sel.matchAll(/<option value="(-?\d+)"([^>]*)>([^<]*)<\/option>/g)].map(m => ({ value: Number(m[1]), selected: /\bselected\b/.test(m[2]), disabled: /\bdisabled\b/.test(m[2]), key: /data-key="([^"]*)"/.exec(m[2])?.[1] ?? null, text: m[3] }));

test('LP18-2: one village — the sending village is not a destination, and nothing is chosen by default', () => {
  FOG.resetFogNow();
  try {
    for (const lang of ['ja', 'en']) {
      setLang(lang);
      const fs = s1World({ provinces: others() });
      const m = SCR.s1VillageModel(fs);
      assert.equal(m.sources.length, 1);
      assert.equal(SCR.placeKey(m.destinations[0]), 'holding:0:0:s0', 'the model still names the village (its index is what the form sends)');
      const sel = dstSelect(SCR.renderS1Village(fs));
      assert.ok(sel, 'the form is shown: other players\' places can be chosen');
      const opts = options(sel);
      assert.deepEqual(opts[0], { value: -1, selected: true, disabled: true, key: null, text: lang === 'en' ? '(choose a destination)' : '（行き先を選んでください）' });
      assert.equal(opts.filter(o => o.selected).length, 1, 'only the asking line is selected');
      assert.ok(!opts.some(o => o.key === 'holding:0:0:s0'), 'no option names the sending village');
      assert.deepEqual(opts.slice(1).map(o => o.key), ['holding:1:0:s0', 'holding:1:0:s1'], 'the other places keep their own index');
      assert.deepEqual(opts.slice(1).map(o => o.value), [1, 2]);
      assert.doesNotMatch(sel, lang === 'en' ? /<optgroup label="Your places">/ : /<optgroup label="あなたの場所">/, 'no empty group of the viewer\'s own places');
      assert.doesNotMatch(String(SCR.renderS1Village(fs)), /season|シーズン/i);
    }
  } finally { setLang('ja'); FOG.resetFogNow(); }
});

test('LP18-2: two villages — the other village is the first choice as before, and the sending one is not listed', () => {
  FOG.resetFogNow();
  setLang('ja');
  const fs = s1World({ holdings: [holding(0, 0, 0, 30), holding(1, 0, 2, 20)] });
  const opts = options(dstSelect(SCR.renderS1Village(fs)));
  assert.deepEqual(opts.map(o => [o.value, o.key, o.selected]), [[1, 'holding:1:0:s2', true]]);
  // a storehouse of the viewer's is a second start: then the village in hand is a real destination (from the storehouse) and stays listed
  const withVault = s1World({ holdings: [holding(0, 0, 0, 30), holding(1, 0, 2, 20)], citizen: { faction: 1, vaults: 1, towers: 0, palisades: 0, forts: 0, caravans: 4, voted: [0, 0, 0, 0] } });
  withVault.s1.caravans.vaults = [{ p: 0, q: 0, tile: 40, ownerTag: '5', faction: 1, gen: 1, stores: [0, 0, 0, 0, 0, 0, 0, 0], cap: 5000 }];
  const m = SCR.s1VillageModel(withVault);
  if (m.sources.length > 1) {
    const o2 = options(dstSelect(SCR.renderS1Village(withVault)));
    assert.ok(o2.some(o => o.key === 'holding:0:0:s0'), 'two starts: the village stays a destination');
    assert.ok(!o2.some(o => o.value === -1), 'and a first choice of the viewer\'s own exists');
  }
});

test('LP18-2: the asking line sends nothing ("choose where it goes"), and the source keeps the pinned lines', async () => {
  const saved = { ...FS };
  const sent = [];
  try {
    FOG.resetFogNow();
    setLang('ja');
    Object.assign(FS, s1World({ provinces: others() }), { wallet: { address: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' }, notice: null, inFlight: 0 });
    C.useTransport({ submit: async req => { sent.push(req); return { ok: false, code: 'Stop' }; } });
    const keys = SCR.s1VillageModel(FS).destinations.map(SCR.placeKey);
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '-1' }, places: { value: keys.join('|') }, picked: { value: '' }, c1: { value: '5' } } });
    assert.equal(sent.length, 0);
    assert.match(String(typeof FS.notice?.text === 'function' ? FS.notice.text() : FS.notice?.text ?? ''), /出発地と行き先を選んでください/);
    assert.equal(FS.notice?.retry, false, 'no "Try again": it would send the same empty choice');
  } finally { for (const k of Object.keys(FS)) delete FS[k]; Object.assign(FS, saved); }
  const src = web('frontier/screens/s1.mjs');
  assert.ok(src.includes('const dstListed = d => !(soleSrc && !d.other && samePlace(soleSrc, d));'));
  assert.ok(src.includes('<option value="-1" selected disabled>${L`（行き先を選んでください）`}</option>'));
  assert.ok(src.includes('<select name="dst" data-plan="${pl?.dst ?? \'\'}">${dstAsk}${otherDst.length'));
});

test('LP18-3: the "destination list has changed" toast has no "Try again"', async () => {
  const saved = { ...FS };
  const sent = [];
  try {
    FOG.resetFogNow();
    Object.assign(FS, s1World({ provinces: others() }), { wallet: { address: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' }, notice: null, inFlight: 0 });
    C.useTransport({ submit: async req => { sent.push(req); return { ok: false, code: 'Stop' }; } });
    // the list as drawn named another place at index 1: nothing is sent
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '1' }, places: { value: 'holding:0:0:s0|holding:9:9:s1' }, c1: { value: '5' } } });
    assert.equal(sent.length, 0);
    assert.equal(FS.notice?.retry, false);
    assert.equal(FS.notice?.code, 'S1Refused');
    for (const lang of ['ja', 'en']) {
      setLang(lang);
      const st = statusOf({ notice: { ...FS.notice, text: () => L`行き先の一覧が変わりました（見えなくなった場所は行き先から外れます）。隊商は送っていません。行き先を選び直してください。` }, lastAct: { name: 's1-caravan' } }, { canRetry: true });
      assert.equal(st.state, 'refused');
      assert.equal(st.retry, false);
      const out = String(renderStatus(st));
      assert.doesNotMatch(out, /data-act="notice-retry"/);
      assert.match(out, lang === 'en' ? /The destination list has changed .* No caravan was sent\. Choose the destination again\./ : /行き先の一覧が変わりました/);
    }
    // (another refusal of the same form keeps its button: the mark is this toast's alone)
    setLang('ja');
    assert.equal(statusOf({ notice: { ok: false, code: 'S1Refused', text: 'x' }, lastAct: { name: 's1-caravan' } }, { canRetry: true }).retry, true);
  } finally { setLang('ja'); for (const k of Object.keys(FS)) delete FS[k]; Object.assign(FS, saved); }
  const src = web('frontier/controller.mjs');
  assert.ok(src.includes("return Promise.resolve(failed({ code: 'S1Refused', retry: false, text: L`行き先の一覧が変わりました（見えなくなった場所は行き先から外れます）。隊商は送っていません。行き先を選び直してください。` }));"));
});

// ------------------------------------------------------------------ the claim card (LP18-4, LP18-8, LP18-9)
function summaryBytes({ tiles = 0, excess = 0n, unpaidSince = null, tag = 77n } = {}) {
  const b = new Uint8Array(320), v = new DataView(b.buffer);
  b.set([...'PSFXWTU1'].map(c => c.charCodeAt(0))); b[18] = 1; b[19] = unpaidSince === null ? 0 : 1;
  v.setBigUint64(84, tag, true); v.setUint32(92, tiles, true); v.setBigUint64(96, excess, true); v.setUint32(120, unpaidSince ?? 0, true);
  return b;
}
const store = (value, perHour, cap) => ({ value: value * 1000, frac: 0, rate: perHour * 1000, cap: cap * 1000, t0: 0 });
const cell = (p, q) => ({ key: `${p},${q}`, p: String(p), q: String(q), ring: 129, territory: { siteTiles: [3, 9], keepTile: 59 }, villages: [], keep: null });
const home = { p: -66, q: -62, site: 8, order: 1, tier: 0, stores: [store(298, 40, 2000), store(300, 30, 2000), store(0, 0, 2000), store(500, 10, 2000)] };
const ME = '77', OTHER = '901';
const cardWorld = (extra = {}) => {
  const cells = [cell(-66, -63), cell(-67, -62), cell(-67, -63)];
  return { localPlay: { wideLand: { scale: 60, targets: cells.map(c => ({ p: c.p, q: c.q })) } }, holdings: [home], ui: {}, citizen: { faction: 0 }, nowBell: 110, chain: { now: () => 0 },
    wideLandNow: () => ({ cells, byKey: new Map(cells.map(c => [c.key, c])) }), ...extra };
};
const have = [2000, 2000, 2000, 500, 0, 2000, 0, 0];
const ownLand = o => ({ world: 'w', citizen: 'c', at: 1, player: o === null ? null : T.decodeTerritoryPlayer(summaryBytes(o)) });
/** 61 owners: every claimable tile (not a site 3 / 9, not the keep 59) owned by `tag`, except `free`. */
const owners = (tag, free = []) => Array.from({ length: 61 }, (_, i) => ([3, 9, 59].includes(i) || free.includes(i) ? null : tag));
const tilesNow = map => () => ({ rev: 1, owners: new Map(Object.entries(map)), known: null, ownTag: ME });

test('LP18-4: provinceFull — every tile but the village sites and the keep has an owner the page keeps', () => {
  const terr = { siteTiles: [3, 9], keepTile: 59 };
  assert.equal(provinceFull(terr, owners(ME)), true, 'all 58 claimable tiles the viewer\'s own (loop-play18: 48 with 12 sites)');
  assert.equal(provinceFull(terr, owners(ME, [17])), false, 'one free tile');
  assert.equal(provinceFull(terr, owners(ME, [17]), i => i === 17), true, 'the tile this page just claimed (before the next read)');
  assert.equal(provinceFull(terr, owners(ME).map((t, i) => (i === 20 ? OTHER : t))), true, 'another player\'s tile in sight counts');
  assert.equal(provinceFull(terr, null), false, 'no owners read: not known');
  assert.equal(provinceFull(null, owners(ME)), false, 'not a territory province');
  assert.equal(provinceFull(terr, owners(ME).slice(0, 60)), false, 'a malformed read is not "full"');
});

test('LP18-4: the full province\'s "Claim a tile" is shut with the reason; the others stay open; unknown owners count as free', () => {
  const full = cardWorld({ ownLand: ownLand({ tiles: 58 }), territoryTilesNow: tilesNow({ '-66,-63': owners(ME), '-67,-62': owners(ME, [5]) }) });
  const w = wideClaimModel(full, { holding: home, have });
  const row = k => w.targets.find(t => `${t.p},${t.q}` === k);
  assert.equal(row('-66,-63').noFree, true);
  assert.equal(row('-67,-62').noFree, false, 'a tile is left');
  assert.equal(row('-67,-63').noFree, false, 'nothing read of it (out of sight, or free): the button stays, the press answers');
  // the tile this page claimed since the read
  const just = cardWorld({ ownLand: ownLand({ tiles: 58 }), ui: { ownTiles: { '-67,-62,5': true } }, territoryTilesNow: tilesNow({ '-67,-62': owners(ME, [5]) }) });
  assert.equal(wideClaimModel(just, { holding: home, have }).targets.find(t => `${t.p},${t.q}` === '-67,-62').noFree, true);
  // no territory read at all (an older page state): as before
  assert.ok(wideClaimModel(cardWorld({ ownLand: ownLand({ tiles: 58 }) }), { holding: home, have }).targets.every(t => t.noFree === false));
  const src = web('frontier/screens/holding.mjs');
  assert.equal((src.match(/busy \|\| w\.tileOff \|\| t\.noFree \? 'disabled'/g) ?? []).length, 3, 'every "Claim a tile" button');
  assert.equal((src.match(/\$\{noFreeNote\(t\)\}/g) ?? []).length, 3, 'and every row says why');
  assert.ok(src.includes('const noFreeNote = t => (t.noFree ? html` <span class="blocked" data-nofree="1">${L`この州に取れるマスは残っていません。`}</span>` : \'\');'));
  // the page reads only what its fog admits: app.mjs hands the card the territory reader's kept state
  assert.ok(web('frontier/app.mjs').includes('FS.territoryTilesNow = () => territoryRef?.now?.() ?? null;'));
  // the race: the press's own answer stays, without "Try again"
  assert.ok(web('frontier/controller.mjs').includes("if (tile === null) return failed({ code: 'NoFreeTile', retry: false, text: L`この州に取れるマスは残っていません。` });"));
  setLang('en');
  try { assert.equal(L`この州に取れるマスは残っていません。`, 'No tile is left to claim in this province.'); } finally { setLang('ja'); }
});

test('LP18-8: net food at 0 or below — the card says another tile cannot be paid from what the village makes', () => {
  const FLAT = Number(/flat: (\d+),/.exec(rust('frontier-abi/src/world_index/territory.rs'))[1]);
  assert.equal(FLAT, 990);
  const at = (tiles, extra = {}) => wideClaimModel(cardWorld({ ownLand: ownLand({ tiles, ...extra }) }), { holding: home, have });
  assert.equal(at(7).foodStalled, null, '+33.07/h: no line');
  assert.equal(at(40).foodStalled, null, '40 tiles: 39.6 ≤ 40');
  assert.deepEqual(at(46).foodStalled, { perHour: -5.54 }, 'loop-play18: 46 tiles, −5.54/h');
  assert.equal(at(46, { unpaidSince: 100 }).foodStalled, null, 'unpaid has its own lines');
  assert.equal(at(0).foodStalled, null);
  assert.equal(wideClaimModel(cardWorld(), { holding: home, have }).foodStalled, null, 'no record read');
  // exactly zero: 40 food an hour against 40.00 of upkeep
  const zero = wideClaimModel({ ...cardWorld({ ownLand: ownLand({ tiles: 40 }) }), holdings: [{ ...home, stores: [store(298, 39.6, 2000), ...home.stores.slice(1)] }] }, { holding: { ...home, stores: [store(298, 39.6, 2000), ...home.stores.slice(1)] }, have });
  assert.deepEqual(zero.foodStalled, { perHour: 0 });
  const src = web('frontier/screens/holding.mjs');
  const line = '${w.foodStalled ? html`<p class="muted" id="hp-own-land-stalled"><span class="blocked">${L`食料の増え方はもう 0 以下です（${signedNet(w.foodStalled.perHour)}/時）。次の1マスの維持費は、本拠地が毎ターン作る食料では払えません。`}</span></p>` : \'\'}';
  assert.equal(src.split(line).length - 1, 1);
  assert.ok(src.indexOf(line) > src.indexOf('${ownLandBlock(w.land)}'), 'under the land lines');
  setLang('en');
  try {
    assert.equal(L`食料の増え方はもう 0 以下です（${LF.signedNet(-5.54)}/時）。次の1マスの維持費は、本拠地が毎ターン作る食料では払えません。`, 'Your food no longer grows (−5.54/h): the food your first village makes each turn cannot pay for another tile.');
  } finally { setLang('ja'); }
});

test('LP18-9: the release line names the rule — it stops once a turn\'s food covers a turn\'s upkeep (settle_upkeep, #243)', () => {
  const lines = (o, bell) => text(ownLandBlock(T.ownLandView(T.decodeTerritoryPlayer(summaryBytes(o)), bell)));
  try {
    setLang('ja');
    assert.match(lines({ tiles: 7, unpaidSince: 100 }, 124), /遠いマスから1ターンに1つずつ手放されています。本拠地の毎ターンの食料が土地の維持費に足りるようになると止まります。$/);
    setLang('en');
    assert.match(lines({ tiles: 7, unpaidSince: 100 }, 124), /Your farthest tiles are being let go, one per turn\. It stops once your first village makes enough food for your land each turn\.$/);
    assert.doesNotMatch(lines({ tiles: 7, unpaidSince: 100 }, 124), /has food again/);
  } finally { setLang('ja'); }
  // the rule the words stand on (code wins): while unpaid the store must cover the period AND one turn's upkeep, a short
  // turn takes what the store holds — so the next turn has only that turn's production
  const abi = rust('frontier-abi/src/world_index/territory.rs');
  assert.match(abi, /let need = if pl\.unpaid_since\.is_some\(\) \{/);
  assert.match(abi, /charge\.max\(turn\)/);
  assert.match(abi, /if need <= available\.max\(0\) \{\s+pl\.remainder = rem;\s+pl\.unpaid_since = None;/);
  assert.match(abi, /let take = charge\.min\(have\);/);
});

// ------------------------------------------------------------------ the hover text (LP18-7)
test('LP18-7: a falling store says "Empty in …" where a rising one says "Full in …", in both languages', () => {
  const village = { p: 65, q: -128, site: 3, order: 1, tier: 0, stores: [store(298, 40, 2000), store(300, 30, 2000), store(0, 0, 2000)] };
  const landOf = tiles => ({ world: 'w', citizen: 'c', player: T.decodeTerritoryPlayer(summaryBytes({ tiles })), at: 0 });
  const tokens = tiles => hud.resourceModel(village, 0, { land: LF.landUpkeepMilli({ holdings: [village], ownLand: landOf(tiles) }, village) });
  const food46 = tokens(46).find(r => r.resource === 'Food');
  // loop-play18 still 037: 298 food at −5.54/h → 53.79 h
  assert.equal(food46.perHour, -5.54);
  assert.equal(food46.emptyIn, Math.ceil((298 / 5.54) * 3600));
  assert.equal(food46.fullIn, null);
  const food7 = tokens(7).find(r => r.resource === 'Food');
  assert.equal(food7.emptyIn, undefined, 'a rising store has no such field (its model is as before)');
  assert.ok(food7.fullIn > 0);
  assert.equal(tokens(46).find(r => r.resource === 'Wood').emptyIn, undefined);
  // an empty store that falls: nothing to count down
  const dry = { ...village, stores: [store(0, 40, 2000), ...village.stores.slice(1)] };
  assert.equal(hud.resourceModel(dry, 0, { land: 46 * 990 }).find(r => r.resource === 'Food').emptyIn, undefined);
  try {
    setLang('en');
    // (a token carries its resource's name in the language it was made in)
    assert.equal(hud.resourceTitle(tokens(46).find(r => r.resource === 'Food')), 'Food 298 / 2,000 · −5.54 per hour (village +40 · land −45.54) · Empty in 2 days');
    assert.match(hud.resourceTitle(tokens(7).find(r => r.resource === 'Food')), / · Full in 2 days$/);
    const soon = hud.resourceModel({ ...village, stores: [store(8, 40, 2000), ...village.stores.slice(1)] }, 0, { land: 48 * 990 }).find(r => r.resource === 'Food');
    assert.equal(hud.resourceTitle(soon), 'Food 8 / 2,000 · −7.52 per hour (village +40 · land −47.52) · Empty in 1 h 3 min');
    const pop = String(hud.renderBreakdown(hud.resourceBreakdown([village], 'Food', 0, h => LF.landUpkeepMilli({ holdings: [village], ownLand: landOf(46) }, h))));
    assert.match(pop, /<span class="muted">Empty in 2 days<\/span>/);
    assert.doesNotMatch(pop, /season/i);
    setLang('ja');
    assert.equal(hud.resourceTitle(food46), '食料 298 / 2,000 · 毎時 −5.54（村 +40 · 土地 −45.54） · 空になるまで 2日');
  } finally { setLang('ja'); }
});
