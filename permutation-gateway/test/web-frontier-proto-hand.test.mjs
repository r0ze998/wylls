// The hand and the words of the prototype rule "banners" (Standing Ground: a DESIGN tried in the sample world,
// not in the program; PROTOTYPE-SPEC sections 1, 5 to 8, with the lead's three amendments).
//
//   the switch (amendment A): the prototype is on exactly while a sample world's season record carries
//     `sample.proto.claims`; without it nothing of it is drawn, said, asked or sent, and the hand, the plate, this
//     turn's list and the notices are what they were;
//   the label: the fixed chip is the record's own label and nothing else; every line the prototype adds says 試作;
//   counts are said in turns (amendment B), with the clock time at the sample world's own pace;
//   the plate, the bar's first button of a host (the count, the lit button, the reasons), the card with what becomes
//     land, the price and the wait, the orders' bodies (minTiles, maxWorks), every refusal as one sentence;
//   the preview route (amendment C): asked for the place in hand, cached, never a rule of the page's own;
//   what happened: lines from PROTO_LAND records only; the threat with 軍勢を送る; the score with its note;
//   the province card; the guided first minutes;
//   the truth of the words: 領土 / territory only for the prototype's score, nothing called a chain record.
// The records are a small fixture of this file, shaped as PROTOTYPE-SPEC section 6 says and as the world track's sample
// world really serves them (its examples of 2026-10-10: the holder's key is "p,q,site", a refusal's `need` is an object,
// the viewer's own record lists what each host may do now, a record of the world's first state says `premise`).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { setLang, EN_GROUPS, EN } from '../../permutation-server/web/lang.mjs';
import { FS as STORE } from '../../permutation-server/web/frontier/fstate.mjs';
import { setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { parseEnvelope } from '../../permutation-server/web/frontier/herald.mjs';
import * as controller from '../../permutation-server/web/frontier/controller.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import * as feed from '../../permutation-server/web/frontier/hud/feed.mjs';
import * as turnlist from '../../permutation-server/web/frontier/hud/turnlist.mjs';
import * as marchcard from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { popOf } from '../../permutation-server/web/frontier/hud/subject.mjs';
import { NO_GO } from '../../permutation-server/web/frontier/hud/insets.mjs';
import * as protoHud from '../../permutation-server/web/frontier/hud/proto.mjs';
import * as pm from '../../permutation-server/web/frontier/proto/hand-model.mjs';
import * as orders from '../../permutation-server/web/frontier/proto/orders.mjs';

afterEach(() => { setLang('ja'); orders.enable(false); });
const WEB = new URL('../../permutation-server/web/', import.meta.url);
const read = f => readFileSync(new URL(f, WEB), 'utf8');
const flat = x => [x].flat(Infinity).map(String).join('');
const text = x => flat(x).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }), { seasonId: 1 });
const id = seq => hostId({ p: 2, q: 0, site: 3, gen: 1, seq });

const LABEL = { ja: '試作ルール：旗（設計のみ・プログラム未実装）', en: 'Prototype rule: banners (design only, not in the program)' };
const NOTE = { ja: 'この得点は試作の計算です。チェーンの記録ではありません。', en: 'This score is computed by the prototype. It is not a chain record.' };
const CLAIMS = { rule: 'standing-ground', version: 'design-2026-10-10-r2', label: LABEL, scoreNote: NOTE, numbers: { FALL_LOOSE: 36, FALL_FIRM: 72, PATCH_MAX: 12, WALK_PAY: 2, KEEP_SHARE: 24 }, reduced: ['no keeps'] };
const seasonRecord = (claims = CLAIMS) => ({ cluster: 'localnet', sample: { world: 'sample', rate: 30, ...(claims ? { proto: { claims } } : {}) } });

// The village stands on tile 30 (site 3) of province (2,0); VILLAGE = its land; OPEN = an open tile well away from it;
// POLE = the pole of the viewer's banner; FOE = the pole of a banner of nation 2.
const VILLAGE = [30, ...pm.tilesBeside(30)];
const far = t => pm.tileSteps(t, 30) >= 3 && pm.tilesBeside(t).length === 6;
const POLE = Array.from({ length: 61 }, (_, t) => t).find(far);
const PATCH = [POLE, ...pm.tilesBeside(POLE)];
const FOE = Array.from({ length: 61 }, (_, t) => t).find(t => far(t) && pm.tileSteps(t, POLE) >= 3);
const FOE_PATCH = [FOE, ...pm.tilesBeside(FOE)];
const OPEN = Array.from({ length: 61 }, (_, t) => t).find(t => far(t) && !PATCH.includes(t) && !FOE_PATCH.includes(t) && pm.tilesBeside(t).every(x => !PATCH.includes(x) && !FOE_PATCH.includes(x)));

function land({ banners = true, rising = [], contested = null, frayed = false, dressedToday = false, resolvedNext = 41 } = {}) {
  const claim = new Array(61).fill(0xff);
  for (const t of VILLAGE) claim[t] = 3;
  const list = [];
  if (banners) {
    for (const t of PATCH) claim[t] = 16;
    for (const t of FOE_PATCH) claim[t] = 17;
    list.push({ slot: 0, pole: POLE, nation: 0, holder: '2,0,3', tiles: [...PATCH], raisedTurn: 30, tendedTurn: 30, firm: true, border: [], frayed, walkDue: 462, strikeAt: 534, dressedToday, elbowLockedUntil: null, contested });
    list.push({ slot: 1, pole: FOE, nation: 2, holder: '2,0,7', tiles: [...FOE_PATCH], raisedTurn: 20, tendedTurn: 20, firm: false, border: [0], frayed: false, walkDue: 164, strikeAt: 236, dressedToday: false, elbowLockedUntil: null, contested: null });
  }
  const counted = [VILLAGE.length + (banners && !frayed ? PATCH.length : 0), 0, banners ? FOE_PATCH.length : 0, 0, 0, 0];
  const paid = [...counted]; paid[0] += 61 - paid.reduce((a, x) => a + x, 0);
  return { resolvedNext, day: 0, claim, banners: list, trails: [], counted, paid, holderNation: 0, heartland: true, rising, villages: [{ site: 3, tile: 30, nation: 0, holder: '2,0,3', tiles: VILLAGE.length }], openedTurn: 30, ceiling: 24 };
}
const ME = { holder: '2,0,3', nation: 0, tiles: 16, paidTiles: 16, villageTiles: 7, bannerTiles: 9, banners: [{ p: 2, q: 0, slot: 0, pole: POLE, tiles: 7, frayed: false }], bannersHeld: 1, cap: 5, perProvince: 2, nextPrice: 8, works: 12, worksSpent: 0, exploreLeftToday: 2, walkPaidToday: false, elbowUsed: false, ledger: 640, perTurn: 16, shareOfNation: 0.024 };
const STANDINGS = { turn: 42, unit: 'tile-turn', note: NOTE, nations: [0.172, 0.169, 0.168, 0.165, 0.164, 0.162].map((share, nation) => ({ nation, tilesNow: 60 - nation, paidNow: 60 - nation, tileTurns: 1000 - nation, share })), check: { sum: 1, expected: 1 } };

/** A town with its hosts: a Spearman host and Scouts in the village, a host on open ground, one on the viewer's pole, one on the other nation's. `proto`: the prototype's records, or null for the world as it was. */
function world({ proto = true, landRec = land(), me = ME, standings = STANDINGS, nowBell = 42 } = {}) {
  const base = [40, 30, 20, 15, 0, 15, 5, 0].map(b => BigInt(Math.floor((b * 150) / 100) * 1000));
  const holding = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, FINAL_TS: 0, RESERVE: [400, 0, 0, 0, 0, 0, 100, 0], PRODUCTION: base, QUEUE: [], TRANSIT: [],
    STORES: [1220, 815, 662, 305, 122, 90, 40, 20].map((v, i) => ({ VALUE: BigInt(v * 1000), RATE: base[i], CAP: 10_000_000n, T0: 0n })) });
  const host = (seq, unit, tile, troops) => ({ ID: id(seq), FACTION: 0, UNIT: unit, TILE: tile, STATE: 1, TROOPS: troops * 1000, STAMINA_VALUE: 120, STAMINA_BELL: 42, READY_BELL: 0, FROM_BELL: 40 });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 41, SITE_COUNT: 4, SITES: Uint8Array.of(0, 0, 0, 30, ...new Array(8).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 0 }, { STATE: 0 }, { STATE: 0 }, { STATE: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 8 }, () => ({ STATE: 0 }))],
    ENTRIES: [host(7, 0, 30, 600), host(8, 6, 30, 100), host(9, 0, OPEN, 300), host(10, 0, POLE, 500), host(11, 0, FOE, 500)] });
  const FS = { mode: 'play', tab: 'map', season: SEASON, nowBell, chain: { now: () => 1_000, rate: 30 }, sample: { world: 'sample', rate: 30 }, record: seasonRecord(proto ? CLAIMS : null), citizen: { faction: 0, vigilStartMin: 0, exploresFloorLeft: 3 }, land: { stage: 'final' },
    holdings: [holding], provinces: new Map([['2,0', { province }]]), view: { fog: true, lod: 'tile' }, ui: { dismissed: ['onboarding'] }, marches: [], chronicle: [], incoming: [], feed: [], orders: [] };
  if (proto) { FS.proto = pm.emptyState(CLAIMS); FS.proto.lands.set('2,0', landRec); FS.proto.me = me; FS.proto.standings = standings; }
  return { FS, holding, province };
}
const select = (FS, tile, host = null) => { FS.selected = { kind: 'tile', p: 2, q: 0, idx: tile }; FS.hand = { host: host === null ? null : String(host), pop: null }; return hand.handModel(FS); };
const firstButton = m => m.buttons[0];

// ------------------------------------------------------------------ the switch
test('the switch: on only for a sample world on a localnet record that carries the prototype with its label', () => {
  assert.equal(pm.claimsOf(null), null);
  assert.equal(pm.claimsOf(seasonRecord(null)), null, 'a sample world without the boot parameter');
  assert.equal(pm.claimsOf({ ...seasonRecord(), cluster: 'devnet' }), null, 'never on a real cluster');
  assert.equal(pm.claimsOf({ cluster: 'localnet', sample: { world: 'other', proto: { claims: CLAIMS } } }), null);
  assert.equal(pm.claimsOf(seasonRecord({ ...CLAIMS, label: undefined })), null, 'no label, no prototype: the chip has nothing else to be drawn from');
  assert.equal(pm.claimsOf(seasonRecord()), CLAIMS);
  // the controller's switch follows the season record, both ways, and the routes follow it
  const keep = { record: STORE.record, mode: STORE.mode, proto: STORE.proto };
  try {
    STORE.mode = 'play'; STORE.record = seasonRecord(null); STORE.proto = undefined;
    assert.equal(controller.syncProto(), null); assert.ok(!STORE.proto); assert.equal(orders.enabled(), false);
    STORE.record = seasonRecord();
    const P = controller.syncProto();
    assert.equal(P.claims, CLAIMS); assert.equal(STORE.proto, P); assert.equal(orders.enabled(), true); assert.ok(P.lands instanceof Map);
    assert.equal(controller.syncProto(), P, 'the records it holds stay while the prototype stays on');
    STORE.mode = 'spectate';
    assert.equal(controller.syncProto(), null, 'the play page only');
    STORE.mode = 'play'; STORE.record = seasonRecord(null);
    assert.equal(controller.syncProto(), null); assert.equal(STORE.proto, null); assert.equal(orders.enabled(), false);
  } finally { Object.assign(STORE, keep); orders.enable(false); }
});

test('off: the three routes are not called, and every piece of the prototype draws nothing', async () => {
  let called = 0;
  orders.configure({ herald: 'http://h', fetch: async () => { called++; throw new Error('must not be called'); } });
  orders.enable(false);
  for (const r of [await orders.standings(), await orders.preview({ host: '1', p: 2, q: 0, tile: 3 }), await orders.land('raise', { host: '1', p: 2, q: 0 }, { fetch: async () => { called++; throw new Error('no'); } })]) assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'Off' });
  assert.equal(called, 0);
  const { FS } = world({ proto: false });
  assert.equal(FS.proto, undefined);
  for (const [name, got] of Object.entries({ chip: protoHud.chipText(FS), plate: protoHud.plateLines(FS), pop: protoHud.bannerPop(FS, { kind: 'host', host: {} }), place: protoHud.placeLine(FS, { ok: true, tiles: [1], size: 1, waitTurns: 1 }),
    march: protoHud.marchLine(FS, { arrive: 47, answer: { ok: true, size: 9, waitTurns: 1 } }), ticker: protoHud.ticker(FS), prov: protoHud.provinceCard(FS, 2, 0), tile: protoHud.tileCard(FS, 2, 0, POLE), legend: protoHud.legend(FS),
    explore: protoHud.exploreLine(FS), guide: protoHud.guideCard(FS) })) assert.equal(flat(got), '', name);
  assert.equal(protoHud.bannerButton(FS, { unit: 0, p: 2, q: 0, tile: OPEN, id: '1' }), null);
  assert.equal(protoHud.guideNext(FS), null);
  assert.deepEqual(protoHud.turnItems(FS), []);
  assert.equal(pm.boardModel(FS), null);
  assert.equal(pm.guideModel(FS), null);
  assert.equal(controller.wantPreview({ host: '1', p: 2, q: 0, tile: 3 }), undefined);
});

test('off: the hand, the plate, this turn\'s list and the notices are as they were (no button, no card, no word of the prototype)', () => {
  const { FS } = world({ proto: false });
  // a host on open ground: the bar of wave 5, the same four buttons
  const m = select(FS, OPEN);
  assert.deepEqual(m.buttons.map(b => b.id), ['march', 'return', 'dissolve', 'next']);
  assert.doesNotMatch(flat(hand.renderHand(m)), /proto|試作|旗を/);
  // the card 旗 cannot stand open
  FS.hand = { host: String(id(9)), pop: 'banner' };
  assert.equal(popOf(FS), null);
  assert.equal(hand.renderPop(FS, hand.handModel(FS)), '');
  assert.deepEqual([...hand.POPS], ['build', 'train', 'muster', 'promote', 'explore', 'dissolve', 'march'], 'the cards of the basic game');
  // the village's cards and the Scout's card carry no line of it
  const v = select(FS, 30);
  FS.hand = { host: null, pop: 'muster' };
  assert.doesNotMatch(flat(hand.renderPop(FS, hand.handModel(FS))), /proto|試作|旗/);
  assert.equal(v.kind, 'village');
  // the plate
  const plate = flat(hud.renderPlate(FS));
  assert.doesNotMatch(plate, /proto|試作|あなたの土地|旗/);
  assert.match(plate, /plate-main/);
  // this turn's list and the notices: an order and a notice of the basic game read as before
  FS.orders = [{ id: 'o1', kind: 'muster', turn: 42, unit: 0, troops: 300, tile: { p: 2, q: 0, tile: 31 }, state: 'accepted' }];
  FS.feed = [{ id: 'bd:1', kind: 'build', bell: 42, p: 2, q: 0, text: '伐採場が完成しました' }];
  const list = turnlist.turnModel(FS, { next: protoHud.turnItems(FS) });
  assert.deepEqual(list.orders.map(o => o.text), ['槍兵 300 を編成 — 次のターンに整列します']);
  assert.deepEqual(list.happened.map(o => o.text), ['伐採場が完成しました']);
  assert.doesNotMatch(flat(turnlist.renderTurnList(list)), /proto|試作|軍勢を送る/);
  assert.doesNotMatch(flat(feed.renderToast(FS.feed[0])), /proto-send|試作/);
  assert.equal(feed.bellSummary(FS.feed, 42).text, 'ターン 42 のまとめ：完成 1');
  // the page's own markup: the chip and the score are in the page hidden, and only script shows them
  const page = read('frontier/index.html');
  assert.match(page, /<p class="hud-proto-chip" id="proto-chip" role="note" data-proto-chip hidden><\/p>/, 'hidden until script shows it; `data-proto-chip` tells the board the page carries the label');
  assert.match(page, /<div class="proto-score" id="proto-score" hidden><\/div>/);
  assert.match(page, /<link rel="stylesheet" href="proto-hand\.css">/);
  assert.match(read('frontier/proto-hand.css'), /\.hud-proto-chip\[hidden\], \.proto-score\[hidden\] \{ display: none !important; \}/);
  // a key the prototype's dictionary shares with another has the same English there: no word of the basic game is changed by it
  const say = v => (typeof v === 'function' ? `${v(1, 1, 1)} | ${v(2, 2, 2)}` : v);
  for (const [k, v] of Object.entries(EN_GROUPS['frontier-proto-hand'])) for (const [group, dict] of Object.entries(EN_GROUPS)) if (group !== 'frontier-proto-hand' && k in dict) assert.equal(say(v), say(dict[k]), `${k}: the same English as in ${group}`);
});

test('the herald\'s envelope carries the prototype\'s part only when the world sent one', () => {
  const bytes = toBase64(encodeAccount('Province', { SEASON_ID: 1n, P: 2, Q: 0, RESOLVED_NEXT: 41 }));
  const env = { v: 1, key: 'pv:2,0', bytes, bell: 41, slot: 5, seq: 9 };
  const plain = parseEnvelope(env, { seasonId: 1, p: 2, q: 0 });
  assert.ok(!('proto' in plain), 'no key at all on a world without the prototype');
  const rec = land();
  assert.equal(parseEnvelope({ ...env, proto: { land: rec } }, { seasonId: 1, p: 2, q: 0 }).proto.land, rec);
});

// ------------------------------------------------------------------ the label
test('the label: the chip is the record\'s own label and nothing else; every line the prototype adds says 試作', () => {
  const { FS } = world();
  assert.equal(protoHud.chipText(FS), LABEL.ja);
  setLang('en');
  assert.equal(protoHud.chipText(FS), LABEL.en);
  FS.proto.claims = { ...CLAIMS, label: { ja: '別の言葉', en: 'Other words' } };
  assert.equal(protoHud.chipText(FS), 'Other words', 'from the record, not from the page');
  FS.proto.claims = CLAIMS;
  // the source has no copy of the label
  for (const f of ['frontier/hud/proto.mjs', 'frontier/proto/hand-model.mjs', 'frontier/app.mjs', 'frontier/controller.mjs', 'frontier/index.html', 'lang/en-frontier-proto-hand.mjs']) {
    assert.doesNotMatch(read(f), /設計のみ・プログラム未実装|design only, not in the program/, f);
    assert.doesNotMatch(read(f), /この得点は試作の計算です|This score is computed by the prototype/, `${f}: the note under the score is the record's too`);
  }
  setLang('ja');
  // each piece carries the tag
  const tagged = { plate: protoHud.plateLines(FS), ticker: protoHud.ticker(FS), prov: protoHud.provinceCard(FS, 2, 0), tile: protoHud.tileCard(FS, 2, 0, POLE), legend: protoHud.legend(FS), explore: protoHud.exploreLine(FS), guide: protoHud.guideCard(FS),
    place: protoHud.placeLine(FS, { ok: true, tiles: [1, 2, 3], size: 3, waitTurns: 1 }), march: protoHud.marchLine(FS, { arrive: 47, answer: { ok: true, size: 9, waitTurns: 1 } }), bar: hand.renderHand(select(FS, OPEN)) };
  for (const [name, got] of Object.entries(tagged)) assert.match(flat(got), /<span class="proto-tag">試作<\/span>/, name);
  for (const pop of ['banner']) { FS.hand = { host: String(id(10)), pop }; FS.selected = { kind: 'tile', p: 2, q: 0, idx: POLE }; assert.match(flat(hand.renderPop(FS, hand.handModel(FS))), /proto-tag/); }
  for (const x of protoHud.turnItems({ ...FS, proto: { ...FS.proto, lands: new Map([['2,0', land({ rising: [{ host: String(id(9)), nation: 0, tile: OPEN, sinceTurn: 40, canRaiseAtTurn: 41, tiles: 7 }] })]]) } })) assert.match(x.text, /^試作：/);
  assert.match(feed.lineText({ proto: true, text: 'x' }), /^試作：/);
  assert.match(flat(feed.renderToast({ id: 'pl:1', kind: 'proto', proto: true, bell: 42, p: 2, q: 0, text: 'x' })), /旗（試作）/);
  // the legend's entry is the specified sentence, and it repeats the label
  assert.match(text(protoHud.legend(FS)), /旗の土地・国の共有地・村の土地の色分けは、設計中の「旗のルール」の試作です。/);
  assert.ok(text(protoHud.legend(FS)).includes(LABEL.ja));
  setLang('en');
  assert.match(text(protoHud.legend(FS)), /The colours for banner land, the nation's commons and village land belong to the banner rule, a design being tried here\./);
});

// ------------------------------------------------------------------ turns and the clock
test('counts are said in turns, with the clock time at the sample world\'s pace', () => {
  const { FS } = world();
  assert.equal(pm.turnWallSecs(FS), 20, '600 chain seconds at 30 times the pace');
  assert.equal(pm.clockOf(FS, 27), '（約9分）');
  assert.equal(pm.clockOf(FS, 1), '（約20秒）');
  assert.equal(pm.aboutTime(4.5 * 3600), '約4時間30分');
  assert.equal(pm.clockOf({ ...FS, sample: { world: 'sample', rate: 30, paused: true } }, 27), '', 'a stopped clock has no time to say');
  const threatened = world({ landRec: land({ contested: { nation: 2, host: '999', sinceTurn: 41, canTakeAtTurn: 68 } }) }).FS;
  assert.equal(pm.threatsOf(threatened)[0].text, 'あなたの旗が狙われています。あと27ターン（約9分）で取られます');
  setLang('en');
  assert.equal(pm.threatsOf(threatened)[0].text, 'Your banner is under threat: it can be taken in 27 turns (about 9 min real time)');
  assert.equal(pm.clockOf(FS, 1), ' (about 20 s real time)');
  setLang('ja');
  // amendment B: nowhere does the page's own text count in tolls
  for (const f of ['frontier/hud/proto.mjs', 'frontier/proto/hand-model.mjs']) {
    const strings = [...read(f).matchAll(/L`([^`]*)`/g)].map(m => m[1]);
    assert.ok(strings.length > 20, f);
    for (const s of strings) assert.doesNotMatch(s, /鐘[^`]{0,8}回/, s);
  }
  for (const [ja, en] of Object.entries(EN_GROUPS['frontier-proto-hand'])) { const t = typeof en === 'function' ? `${en(1, 1, 1)} ${en(2, 2, 2)}` : en; assert.doesNotMatch(t, /\btolls?\b/i, ja); }
  // a count runs in settled turns: it is done when the province has settled that far, and says so when the province lags
  assert.deepEqual(pm.countTo({ nowBell: 42 }, 42, 41), { left: 1, done: false, lag: false });
  assert.deepEqual(pm.countTo({ nowBell: 42 }, 41, 41), { left: 0, done: true, lag: false });
  assert.deepEqual(pm.countTo({ nowBell: 44 }, 43, 41), { left: 2, done: false, lag: true }, 'the province is two turns behind the clock');
});

// ------------------------------------------------------------------ the plate
test('the plate: the land, the banners held, the next price, and the personal line of the score', () => {
  const { FS } = world();
  const t = text(protoHud.plateLines(FS));
  assert.equal(t, '試作 あなたの土地 16マス（村7・旗9） 旗 1/5 · この州 1/2 つぎの旗：功績 8 あなたの名で 16マス（毎ターン+16、国の2.4%）');
  assert.match(text(protoHud.plateLines(world({ me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 1, q: 1, slot: 0 }] } }).FS)), /旗 3\/5 · この州 2\/2/);
  assert.match(flat(hud.renderPlate(FS)), /class="plate-proto" data-proto-tiles="16"/, 'on the plate, under its one press home');
  setLang('en');
  assert.equal(text(protoHud.plateLines(FS)), 'Prototype Your land 16 tiles (village 7, banners 9) Banners 1/5 · this province 1/2 Next banner: 8 Works Your score: +16 a turn (1 per tile) · 2.4% of your nation’s total so far');
  setLang('ja');
  const fresh = world({ me: { ...ME, tiles: 7, paidTiles: 7, perTurn: 7, banners: [], nextPrice: 0, shareOfNation: 0.011 } }).FS;
  assert.equal(text(protoHud.plateLines(fresh)), '試作 あなたの土地 7マス 旗 0/5 つぎの旗：無料 あなたの名で 7マス（毎ターン+7、国の1.1%）');
  // (before a turn has been counted in the viewer's name the record's share is 0: the plate does not say 「国の0.0%」 of seven tiles)
  assert.equal(text(protoHud.plateLines(world({ me: { ...ME, tiles: 7, paidTiles: 7, perTurn: 7, banners: [], nextPrice: 0, shareOfNation: 0 } }).FS)), '試作 あなたの土地 7マス 旗 0/5 つぎの旗：無料 あなたの名で 7マス（毎ターン+7）');
  // the count follows its record a tile at a time (visual): the record's own number stays in the markup
  FS.proto.plateShown = 12;
  assert.match(flat(protoHud.plateLines(FS)), /class="plate-proto counting" data-proto-tiles="16"/);
  assert.match(text(protoHud.plateLines(FS)), /あなたの土地 12マス（村7・旗5）.*あなたの名で 16マス/);
  assert.equal(protoHud.plateLines(world({ me: null }).FS), '', 'nothing before the viewer\'s record has come');
});

// ------------------------------------------------------------------ the bar's first button and the card
const rising = (at, tiles = 9) => [{ host: String(id(9)), nation: 0, tile: OPEN, sinceTurn: 40, canRaiseAtTurn: at, tiles }];
test('a fighting host\'s bar: first the count, then 旗を立てる（+9マス）; the province that lags says so', () => {
  let FS = world({ landRec: land({ rising: rising(42) }) }).FS;
  let b = firstButton(select(FS, OPEN));
  assert.deepEqual({ id: b.id, word: b.word, figure: b.figure, hint: b.hint, why: b.why, proto: b.proto }, { id: 'banner', word: '旗', figure: 'あと1ターン', hint: 'あと1ターンで旗を立てられます', why: null, proto: true });
  assert.deepEqual(hand.handModel(FS).buttons.map(x => x.id), ['banner', 'march', 'return', 'dissolve', 'next'], 'first on the bar; the rest as it was');
  FS = world({ landRec: land({ rising: rising(43) }), nowBell: 44 }).FS;
  b = firstButton(select(FS, OPEN));
  assert.deepEqual({ figure: b.figure, hint: b.hint }, { figure: '集計待ち', hint: '集計を待っています' });
  FS = world({ landRec: land({ rising: rising(41) }) }).FS;
  b = firstButton(select(FS, OPEN));
  assert.deepEqual({ word: b.word, figure: b.figure, tone: b.tone, hint: b.hint }, { word: '旗を立てる', figure: '+9マス', tone: 'go', hint: '旗を立てる（+9マス）' });
  assert.match(flat(hand.renderHand(hand.handModel(FS))), /class="hand-btn hand-banner hand-proto tone-go"[^>]*data-act="hand-pop"[^>]*data-pop="banner"/);
  setLang('en');
  b = firstButton(select(FS, OPEN));
  assert.deepEqual({ word: b.word, figure: b.figure }, { word: 'Raise the banner', figure: '+9 tiles' });
  assert.equal(firstButton(select(world({ landRec: land({ rising: rising(42) }) }).FS, OPEN)).hint, 'A banner can rise after 1 more turn');
  setLang('ja');
  // Scouts never raise: no button of it away from the viewer's banners
  assert.equal(protoHud.bannerButton(FS, { unit: 6, p: 2, q: 0, tile: OPEN, id: String(id(8)) }), null);
  // no record of a count: the world's own answer for the tile says why (the preview route), in the button's place
  FS = world().FS;
  b = firstButton(select(FS, OPEN));
  assert.equal(b.figure, '…', 'asked, no answer yet');
  FS.proto.previews.set(pm.previewKey(FS, { host: String(id(9)), p: 2, q: 0, tile: OPEN }), { at: 0, answer: { ok: false, code: 'PerProvince' } });
  b = firstButton(select(FS, OPEN));
  assert.equal(b.why, 'この州の旗は2本までです：次の旗は別の州へ');
  assert.match(flat(hand.renderHand(hand.handModel(FS))), /aria-disabled="true"[^>]*>[\s\S]*?この州の旗は2本までです：次の旗は別の州へ/);
});

test('the card: what becomes land, the price in Works, the wait; the order carries minTiles and maxWorks', () => {
  const FS = world({ landRec: land({ rising: rising(41) }) }).FS;
  FS.proto.previews.set(pm.previewKey(FS, { host: String(id(9)), p: 2, q: 0, tile: OPEN }), { at: 0, answer: { ok: true, tiles: [1, 2, 3, 4, 5, 6, 7], trail: [8, 9], size: 9, price: 8, waitTurns: 1 } });
  select(FS, OPEN); FS.hand.pop = 'banner';
  const m = hand.handModel(FS);
  assert.equal(m.pop, 'banner');
  const card = hand.renderPop(FS, m), t = text(card);
  assert.match(t, /土地になるマス \+9マス（旗のまわり 7・歩いた跡 2）/);
  assert.match(t, /費用 功績 8（手持ち 12）/);
  assert.match(t, /待ち いま立てられます/);
  assert.match(t, /設計中のルールの試作です。プログラムにはまだなく、チェーンには何も送りません。/);
  assert.match(flat(card), new RegExp(`data-act="proto-raise" data-host="${id(9)}" data-p="2" data-q="0" data-min="9" data-max="8" >`), 'the confirm can be pressed, with what was shown');
  // before the count is done the confirm says why in place
  const early = world({ landRec: land({ rising: rising(42) }) }).FS;
  select(early, OPEN); early.hand.pop = 'banner';
  const c2 = hand.renderPop(early, hand.handModel(early));
  assert.match(flat(c2), /data-act="proto-raise"[^>]*aria-disabled="true"/);
  assert.match(text(c2), /待ち あと1ターン（約20秒）/);
  assert.match(text(c2), /あと1ターンで旗を立てられます/);
  // a refusal of the world for this place stands on the card with its number
  const short = world({ landRec: land({ rising: rising(41) }) }).FS;
  short.proto.previews.set(pm.previewKey(short, { host: String(id(9)), p: 2, q: 0, tile: OPEN }), { at: 0, answer: { ok: false, code: 'WorksShort', need: 4 } });
  select(short, OPEN); short.hand.pop = 'banner';
  assert.match(text(hand.renderPop(short, hand.handModel(short))), /功績があと4足りません/);
});

test('on the viewer\'s banner: walk it (+2 Works if today\'s first), widen it by a picked tile, strike it; greyed with the reason while an enemy stands on it', () => {
  let FS = world().FS;
  let b = firstButton(select(FS, POLE, id(10)));
  assert.deepEqual({ word: b.word, figure: b.figure, hint: b.hint }, { word: '見回る', figure: '功績 +2', hint: '見回る（今日の最初なら功績 +2）' });
  FS.hand.pop = 'banner';
  let card = hand.renderPop(FS, hand.handModel(FS));
  assert.match(text(card), /あなたの旗 試作 7マス.*あなたの旗（しっかり立っています・3日に1回の見回り）/);
  assert.match(flat(card), new RegExp(`data-act="proto-tend" data-host="${id(10)}" data-p="2" data-q="0" data-slot="0"`));
  assert.match(flat(card), /data-act="proto-dress-pick"[^>]*data-slot="0"  aria-pressed="false">/);
  assert.match(flat(card), /data-act="proto-strike-ask" data-on="1" >/);
  // a tile picked on the board: the confirm carries it
  FS.hand.tile = 12;
  assert.match(flat(hand.renderPop(FS, hand.handModel(FS))), /data-act="proto-dress"[^>]*data-slot="0" data-tile="12"/);
  // striking asks first, with what is given up
  FS.hand = { ...FS.hand, tile: undefined, strike: true };
  card = hand.renderPop(FS, hand.handModel(FS));
  assert.match(text(card), /この旗を取り下げます。7マスは、誰のものでもない土地に戻ります。.*取り下げる（−7マス）/);
  assert.match(flat(card), /data-act="proto-strike" data-p="2" data-q="0" data-slot="0" >/);
  // the day's first walk is paid once
  FS = world({ me: { ...ME, walkPaidToday: true } }).FS;
  assert.equal(firstButton(select(FS, POLE, id(10))).figure, '7マス');
  // an enemy on the pole: the count on the card, widening and striking greyed with the one reason
  FS = world({ landRec: land({ contested: { nation: 2, host: '999', sinceTurn: 41, canTakeAtTurn: 68 } }) }).FS;
  b = firstButton(select(FS, POLE, id(10)));
  assert.deepEqual({ figure: b.figure, tone: b.tone }, { figure: '狙われ中', tone: 'bad' });
  FS.hand.pop = 'banner';
  card = hand.renderPop(FS, hand.handModel(FS));
  assert.match(text(card), /あなたの旗が狙われています。あと27ターン（約9分）で取られます/);
  assert.match(flat(card), /data-act="proto-dress-pick"[^>]*aria-disabled="true"/);
  assert.match(flat(card), /data-act="proto-strike-ask"[^>]*aria-disabled="true"/);
  assert.match(text(card), /敵が立っているあいだは、取り下げも広げることもできません/);
  // where the land could take one more tile: open ground next to the patch, within two steps of the pole, beside a host of the viewer's
  const tiles = pm.dressTiles(FS, 2, 0, FS.proto.lands.get('2,0').banners[0], [{ p: 2, q: 0, tile: POLE }, { p: 2, q: 0, tile: pm.tilesBeside(POLE).find(t => pm.tilesBeside(t).length === 6) }]);
  assert.ok(tiles.length > 0);
  for (const x of tiles) { assert.equal(FS.proto.lands.get('2,0').claim[x.tile], 0xff); assert.ok(pm.tileSteps(x.tile, POLE) === 2); }
  assert.deepEqual(pm.dressTiles(FS, 2, 0, FS.proto.lands.get('2,0').banners[0], []), [], 'no host of the viewer\'s beside: nothing is lit');
});

test('on another nation\'s pole: the count, then 旗を取る / 旗を倒す; only pulling down, with the reason, where it cannot be taken', () => {
  const stand = at => land({ rising: [], contested: null, resolvedNext: 41 });
  let rec = stand(); rec.banners[1].contested = { nation: 0, host: String(id(11)), sinceTurn: 41, canTakeAtTurn: 53 };
  let FS = world({ landRec: rec }).FS;
  let b = firstButton(select(FS, FOE, id(11)));
  assert.deepEqual({ word: b.word, figure: b.figure, hint: b.hint }, { word: '旗を取る', figure: 'あと12ターン', hint: 'あと12ターンで、この旗を取るか倒せます' });
  FS.hand.pop = 'banner';
  let card = hand.renderPop(FS, hand.handModel(FS));
  assert.match(text(card), /シンダーの旗 試作 7マス.*あと12ターン（約4分）で、この旗を取るか倒せます/);
  assert.match(flat(card), /data-act="proto-take"[^>]*aria-disabled="true"/);
  assert.match(flat(card), /data-act="proto-pull"[^>]*aria-disabled="true"/);
  rec = stand(); rec.banners[1].contested = { nation: 0, host: String(id(11)), sinceTurn: 29, canTakeAtTurn: 41 };
  FS = world({ landRec: rec }).FS;
  b = firstButton(select(FS, FOE, id(11)));
  assert.deepEqual({ word: b.word, tone: b.tone }, { word: '旗を取る', tone: 'go' });
  FS.hand.pop = 'banner';
  card = hand.renderPop(FS, hand.handModel(FS));
  assert.match(flat(card), new RegExp(`data-act="proto-take" data-host="${id(11)}" data-p="2" data-q="0" data-slot="1" >`));
  assert.match(flat(card), /data-act="proto-pull"[^>]*data-slot="1" >/);
  // two banners in this province already: taking is not offered, pulling down is, and the card says why
  FS = world({ landRec: rec, me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 5 }] } }).FS;
  b = firstButton(select(FS, FOE, id(11)));
  assert.equal(b.word, '旗を倒す');
  FS.hand.pop = 'banner';
  card = hand.renderPop(FS, hand.handModel(FS));
  assert.doesNotMatch(flat(card), /proto-take/);
  assert.match(flat(card), /data-act="proto-pull"/);
  assert.match(text(card), /ここでは取れません（この州の旗は2本までです：次の旗は別の州へ）/);
});

test('the world\'s own judgement of each host (`hosts` of the viewer\'s record) lights the bar and the cards; the page judges nothing', () => {
  const acts = x => ({ host: String(id(9)), p: 2, q: 0, tile: OPEN, unit: 0, stands: true, raise: null, onPole: null, fell: null, tend: [], dress: [], ...x });
  const withActs = (list, landRec = land()) => world({ me: { ...ME, hosts: list }, landRec }).FS;
  // it may raise now: lit, with the patch and the price the world names; no preview is asked for it
  let FS = withActs([acts({ raise: { ok: true, tiles: [1, 2, 3, 4, 5, 6, 7], trail: [6, 7], size: 7, price: 8, waitTurns: 0 } })]);
  let s = pm.hostSituation(FS, { id: id(9), unit: 0, p: 2, q: 0, tile: OPEN });
  assert.deepEqual({ mode: s.mode, count: s.count, size: s.size }, { mode: 'rising', count: { left: 0, done: true, lag: false }, size: 7 });
  let b = firstButton(select(FS, OPEN));
  assert.deepEqual({ word: b.word, figure: b.figure, tone: b.tone }, { word: '旗を立てる', figure: '+7マス', tone: 'go' });
  FS.hand.pop = 'banner';
  let card = hand.renderPop(FS, hand.handModel(FS));
  assert.match(text(card), /土地になるマス \+7マス（旗のまわり 5・歩いた跡 2）.*費用 功績 8（手持ち 12）.*待ち いま立てられます/);
  assert.match(flat(card), /data-act="proto-raise"[^>]*data-min="7" data-max="8" >/);
  assert.deepEqual(pm.risingOwn(FS).map(x => x.text), ['旗を立てられます（+7マス）']);
  // it must stand longer: the count from the world's own `need`, and what it will raise
  FS = withActs([acts({ raise: { ok: false, code: 'StandLonger', need: { tolls: 2, atTurn: 43 }, tiles: [1, 2, 3, 4, 5], trail: [], size: 5, price: 0, waitTurns: 2, atTurn: 43 } })]);
  b = firstButton(select(FS, OPEN));
  assert.deepEqual({ word: b.word, figure: b.figure, hint: b.hint }, { word: '旗', figure: 'あと2ターン', hint: 'あと2ターンで旗を立てられます' });
  FS.hand.pop = 'banner';
  card = hand.renderPop(FS, hand.handModel(FS));
  assert.match(text(card), /土地になるマス \+5マス.*待ち あと2ターン（約40秒）/);
  assert.match(flat(card), /data-act="proto-raise"[^>]*aria-disabled="true"/);
  // it cannot: the world's reason in the button's place
  FS = withActs([acts({ raise: { ok: false, code: 'NotOpen', need: { why: 'village' } } })]);
  assert.equal(firstButton(select(FS, OPEN)).why, 'ここは村の土地です');
  // on its own banner: the walk the world refuses is not promised; the tiles it may add are the world's
  const own = x => acts({ host: String(id(10)), tile: POLE, raise: { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 } }, onPole: { slot: 0, nation: 0, holder: '2,0,3' }, ...x });
  FS = withActs([own({ tend: [{ slot: 0, ok: false, code: 'NotArrivedSince', need: { since: 45 }, paysToday: true }], dress: [{ slot: 0, tiles: [], code: null }] })]);
  b = firstButton(select(FS, POLE, id(10)));
  assert.deepEqual({ word: b.word, figure: b.figure, hint: b.hint }, { word: 'あなたの旗', figure: '7マス', hint: '見回りは、前の見回りのあとに着いた軍勢でします' });
  FS.hand.pop = 'banner';
  card = hand.renderPop(FS, hand.handModel(FS));
  assert.match(flat(card), /data-act="proto-tend"[^>]*aria-disabled="true"/);
  assert.match(text(card), /見回りは、前の見回りのあとに着いた軍勢でします/);
  assert.match(flat(card), /data-act="proto-dress-pick"[^>]*aria-disabled="true"/);
  assert.match(text(card), /この軍勢のそばに、広げられるマスがありません/);
  FS = withActs([own({ tend: [{ slot: 0, ok: true, code: null, need: null, paysToday: true }], dress: [{ slot: 0, tiles: [12, 13], code: null }] })]);
  s = pm.hostSituation(FS, { id: id(10), unit: 0, p: 2, q: 0, tile: POLE });
  assert.deepEqual({ mode: s.mode, mine: s.mine, tiles: s.dress.tiles }, { mode: 'own', mine: true, tiles: [12, 13] });
  b = firstButton(select(FS, POLE, id(10)));
  assert.deepEqual({ word: b.word, figure: b.figure }, { word: '見回る', figure: '功績 +2' });
  FS.hand.pop = 'banner';
  card = flat(hand.renderPop(FS, hand.handModel(FS)));
  assert.match(card, /data-act="proto-tend"[^>]*data-slot="0" >/);
  assert.match(card, /data-act="proto-dress-pick"[^>]*data-slot="0"  aria-pressed="false">/);
  FS = withActs([own({ tend: [{ slot: 0, ok: true, code: null, need: null, paysToday: false }], dress: [{ slot: 0, tiles: [], code: 'DressedToday' }] })]);
  assert.equal(firstButton(select(FS, POLE, id(10))).figure, '7マス', 'today\'s walk is paid already: no +2 is promised');
  FS.hand.pop = 'banner';
  assert.match(text(hand.renderPop(FS, hand.handModel(FS))), /この旗は、今日はもう広げました（1日1回）/);
  // on another nation's pole: the world's count, and why only pulling down is left
  const foe = x => acts({ host: String(id(11)), tile: FOE, onPole: { slot: 1, nation: 2, holder: '2,0,7' }, fell: { slot: 1, ok: false, code: 'StandLonger', need: { tolls: 12, atTurn: 53 }, tolls: 36, atTurn: 53, canTake: true, onlyPull: null, ...x } });
  FS = withActs([foe()]);
  b = firstButton(select(FS, FOE, id(11)));
  assert.deepEqual({ word: b.word, figure: b.figure }, { word: '旗を取る', figure: 'あと12ターン' });
  FS = withActs([foe({ ok: true, code: null, need: null, canTake: false, onlyPull: 'place' })]);
  b = firstButton(select(FS, FOE, id(11)));
  assert.deepEqual({ word: b.word, tone: b.tone }, { word: '旗を倒す', tone: 'go' });
  FS.hand.pop = 'banner';
  card = hand.renderPop(FS, hand.handModel(FS));
  assert.doesNotMatch(flat(card), /proto-take/);
  assert.match(flat(card), /data-act="proto-pull"[^>]*data-slot="1" >/);
  assert.match(text(card), /ここでは取れません（わたしたちの土地にも国境にも接していません）/);
  FS = withActs([foe({ code: 'TooFew', need: { troops: 500, have: 300 } })]);
  assert.equal(firstButton(select(FS, FOE, id(11))).why, '兵が足りません：500人以上の軍勢が要ります');
});

// ------------------------------------------------------------------ refusals
test('every refusal of the rule is one plain sentence with the number it needs, in both languages', () => {
  const JP = /[぀-ヿ一-鿿]/;
  for (const code of [...pm.REFUSALS, ...pm.OWN_CODES]) {
    setLang('ja');
    const ja = pm.refusalText(code, { need: 3, why: 'heartland', turn: 99, cap: 5, held: 5, perProvince: 2 });
    setLang('en');
    const en = pm.refusalText(code, { need: 3, why: 'heartland', turn: 99, cap: 5, held: 5, perProvince: 2 });
    assert.match(ja, JP, code); assert.doesNotMatch(en, JP, code);
    assert.ok(!/[A-Z][a-z]+[A-Z]/.test(ja) && !ja.includes(code), `${code}: no identifier in the sentence`);
    assert.doesNotMatch(en, /Unknown error/, code);
  }
  setLang('ja');
  assert.equal(pm.refusalText('StandLonger', { need: 2 }), 'あと2ターン立たせてください');
  assert.equal(pm.refusalText('WorksShort', { need: 4 }), '功績があと4足りません');
  // as the world really answers: `need` is an object that names its numbers
  assert.equal(pm.refusalText('StandLonger', { need: { tolls: 3, atTurn: 45 } }), 'あと3ターン立たせてください');
  assert.equal(pm.refusalText('WorksShort', { need: { works: 8, have: 4, short: 4 } }), '功績があと4足りません');
  assert.equal(pm.refusalText('TooFew', { need: { troops: 500, have: 300 } }), '兵が足りません：500人以上の軍勢が要ります');
  assert.equal(pm.refusalText('CapReached', { need: { cap: 5, held: 5 } }), '旗は 5/5 本：村の段階が上がると増えます');
  assert.equal(pm.refusalText('PerProvince', { need: { perProvince: 2 } }), 'この州の旗は2本までです：次の旗は別の州へ');
  assert.equal(pm.refusalText('PatchTooSmall', { need: { tiles: 3, have: 2 } }), '土地にできるマスが少なすぎます（3マスから）');
  assert.equal(pm.refusalText('NotOpen', { need: { why: 'village' } }), 'ここは村の土地です');
  assert.equal(pm.refusalText('NotOpen', { need: { why: 'banner', slot: 1 } }), 'ここはもう旗の土地です');
  assert.equal(pm.refusalText('NotOpen', { need: { why: 'impassable' } }), '山や水のマスには旗を立てられません');
  assert.equal(pm.refusalText('NotOpen', { need: { why: 'enemy' } }), '敵の軍勢が立っています');
  assert.equal(pm.refusalText('SiteOrCamp', { need: { why: 'site' } }), '村を置く場所には旗を立てられません');
  assert.equal(pm.refusalText('SiteOrCamp', { need: { why: 'camp' } }), '野営地やそのとなりには旗を立てられません');
  assert.equal(pm.refusalText('NotHere', { need: { why: 'touch' } }), 'わたしたちの土地に接していません');
  assert.equal(pm.refusalText('NotHere', { need: { why: 'town' } }), '町になってから');
  assert.equal(pm.refusalText('TooFar', { need: { reach: 2 } }), '旗から遠すぎます（旗から2マスまで）');
  assert.equal(pm.refusalText('ElbowLocked', { need: { turn: 474 } }), 'ターン 474 までは取り下げられません');
  assert.equal(pm.takeStopText('place'), 'わたしたちの土地にも国境にも接していません');
  assert.equal(pm.takeStopText('perProvince', { perProvince: 2 }), 'この州の旗は2本までです：次の旗は別の州へ');
  assert.equal(pm.takeStopText('town'), '町になってから');
  assert.equal(pm.refusalText('PerProvince', { perProvince: 2 }), 'この州の旗は2本までです：次の旗は別の州へ');
  assert.equal(pm.refusalText('TooFew', { need: 500 }), '兵が足りません：500人以上の軍勢が要ります');
  assert.equal(pm.refusalText('NotHere', { why: 'heartland' }), '他国の中核地です');
  assert.equal(pm.refusalText('NotHere', { why: 'must touch our land' }), 'わたしたちの土地に接していません');
  assert.equal(pm.refusalText('NotHere', { why: 'needs a Town' }), '町になってから');
  assert.equal(pm.refusalText('NotSurveyed'), 'まだ測量していません（進軍して着けば測量は要りません）');
  assert.equal(pm.refusalText('CapReached', { cap: 5, held: 5 }), '旗は 5/5 本：村の段階が上がると増えます');
  assert.equal(pm.refusalText('ElbowLocked', { turn: 474 }), 'ターン 474 までは取り下げられません');
  assert.equal(pm.refusalText('Contested'), '敵が立っているあいだは、取り下げも広げることもできません');
  assert.equal(pm.refusalText('ExploreLimit'), '今日はここまでです（このマスは未探索のまま残ります）');
  setLang('en');
  assert.equal(pm.refusalText('StandLonger', { need: 2 }), 'Let it stand 2 more turns');
  assert.equal(pm.refusalText('StandLonger', { need: 1 }), 'Let it stand 1 more turn');
  assert.equal(pm.refusalText('WorksShort', { need: 4 }), '4 Works short');
  assert.equal(pm.refusalText('PerProvince', { perProvince: 2 }), 'At most 2 banners in a province; raise the next one in another');
  assert.equal(pm.refusalText('NotHere', { why: 'needs a Town' }), 'Needs a Town');
});

// ------------------------------------------------------------------ the routes
test('the three routes: the order\'s body, the preview\'s query, and nowhere else are they named', async () => {
  assert.deepEqual(orders.orderBody('raise', { host: id(9), p: 2, q: 0, minTiles: 9, maxWorks: 8 }), { op: 'raise', province: [2, 0], p: 2, q: 0, host: String(id(9)), minTiles: 9, maxWorks: 8 });
  assert.deepEqual(orders.orderBody('dress', { host: '5', p: 2, q: -1, slot: 3, tile: 12 }), { op: 'dress', province: [2, -1], p: 2, q: -1, host: '5', slot: 3, tile: 12 });
  assert.deepEqual(orders.orderBody('strike', { p: 2, q: 0, slot: 0, reason: 'own' }), { op: 'strike', province: [2, 0], p: 2, q: 0, slot: 0, reason: 'own' });
  assert.equal(orders.previewQuery({ host: '77', p: 2, q: -1, tile: 5 }), 'host=77&p=2&q=-1&tile=5');
  assert.equal(orders.previewQuery({ p: 2, q: 0, tile: 5, troops: 300 }), 'troops=300&p=2&q=0&tile=5', 'a host that does not exist yet: no host, its number of troops');
  const calls = [];
  const fake = body => async (url, init = {}) => { calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => body }; };
  orders.configure({ herald: 'http://h/', fetch: fake({ ok: true, tiles: [1], trail: [], size: 1, price: 0, waitTurns: 1 }) });
  orders.enable(true); setRelay('http://h/gw');
  assert.equal((await orders.preview({ host: '77', p: 2, q: 0, tile: 5 })).size, 1);
  assert.equal((await orders.standings()).ok, true);
  assert.deepEqual((await orders.land('raise', { host: '77', p: 2, q: 0, minTiles: 7, maxWorks: 0 }, { fetch: fake({ ok: false, code: 'StandLonger', need: 2, error: 'x' }) })), { ok: false, code: 'StandLonger', need: 2, error: 'x', httpStatus: 200 });
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['GET http://h/h/proto/preview?host=77&p=2&q=0&tile=5', 'GET http://h/h/proto/standings', 'POST http://h/gw/f/proto/land']);
  assert.deepEqual(calls[2].body, { op: 'raise', province: [2, 0], p: 2, q: 0, host: '77', minTiles: 7, maxWorks: 0 });
  assert.equal((await orders.land('fray', { p: 2, q: 0, slot: 0 })).code, 'BadOp', 'the keeper\'s acts are not this page\'s to send');
  setRelay('');
  // the one place that names the routes
  const files = dir => readdirSync(new URL(dir, WEB), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(`${dir}${e.name}/`) : e.name.endsWith('.mjs') ? [`${dir}${e.name}`] : []));
  for (const f of files('frontier/')) if (f !== 'frontier/proto/orders.mjs') assert.doesNotMatch(read(f).replace(/^\s*\/\/.*$|^\s*\*.*$|\/\*\*?.*$/gm, ''), /\/proto\/(land|standings|preview)/, f);
});

test('the preview is the world\'s answer, held by the place and the settled turn; the page asks, it does not judge', async () => {
  const keep = { proto: STORE.proto, citizen: STORE.citizen };
  const { FS } = world();
  try {
    Object.assign(STORE, { proto: FS.proto, citizen: FS.citizen });
    let asked = 0;
    orders.configure({ herald: '', fetch: async url => { asked++; return { ok: true, status: 200, json: async () => (String(url).includes('tile=5') ? { ok: true, tiles: [5, 6, 7], trail: [], size: 3, price: 0, waitTurns: 1 } : { ok: false, code: 'NotOpen' }) }; } });
    orders.enable(true);
    const x = { host: '77', p: 2, q: 0, tile: 5 };
    assert.equal(controller.wantPreview(x), undefined, 'asked: no answer yet');
    assert.equal(controller.wantPreview(x), undefined);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(asked, 1, 'one request for a place, however often the page is drawn');
    assert.equal(controller.wantPreview(x).size, 3);
    assert.deepEqual(pm.previewLine(STORE, controller.wantPreview(x)), { ok: true, size: 3, wait: 1, price: 0, text: '+3マス・1ターン' });
    controller.wantPreview({ host: '77', p: 2, q: 0, tile: 9 });
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(pm.previewLine(STORE, pm.previewOf(STORE, { host: '77', p: 2, q: 0, tile: 9 })), { ok: false, code: 'NotOpen', text: 'ここはもう誰かの土地です' });
    // a new settled turn asks again
    STORE.proto.lands.get('2,0').resolvedNext = 42;
    assert.equal(controller.wantPreview(x), undefined);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(asked, 3);
    // a route that cannot be reached is "not known", never a refusal of the rule
    orders.configure({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    controller.wantPreview({ host: '77', p: 2, q: 0, tile: 20 });
    await new Promise(r => setTimeout(r, 5));
    assert.equal(pm.previewOf(STORE, { host: '77', p: 2, q: 0, tile: 20 }), null);
    assert.equal(pm.previewLine(STORE, null), null);
  } finally { Object.assign(STORE, keep); orders.enable(false); orders.configure({ fetch: (...a) => globalThis.fetch(...a) }); }
});

test('the lines of a place: forming a host where a banner can rise, and the march\'s order before the seal', () => {
  const { FS } = world();
  assert.equal(text(protoHud.placeLine(FS, { ok: true, tiles: [1, 2, 3, 4, 5, 6, 7], trail: [], size: 7, price: 0, waitTurns: 1 })), '試作 ここに立てば旗を立てられます：+7マス・1ターン（約20秒）');
  assert.equal(text(protoHud.placeLine(FS, { ok: false, code: 'NotSurveyed' })), '試作 ここでは旗を立てられません：まだ測量していません（進軍して着けば測量は要りません）');
  assert.equal(text(protoHud.placeLine(FS, undefined)), '試作 旗を立てられるか確かめています…');
  assert.equal(protoHud.placeLine(FS, null), '', 'not known: nothing is claimed');
  // the muster card carries it for the tile in hand
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 30 }; FS.hand = { host: null, pop: 'muster', tile: OPEN };
  const m = hand.handModel(FS), place = hand.musterPlace(FS, m);
  assert.deepEqual(place, { p: 2, q: 0, tile: OPEN, troops: 400 });
  FS.proto.previews.set(pm.previewKey(FS, place), { at: 0, answer: { ok: true, tiles: [1, 2, 3, 4, 5, 6, 7], trail: [], size: 7, price: 0, waitTurns: 1 } });
  assert.match(text(hand.renderPop(FS, m)), /試作 ここに立てば旗を立てられます：\+7マス・1ターン（約20秒）/);
  // the march: the host arrives at the order's turn, stands from the turn after it, stands the turns the world says, and the province settles a turn behind
  // (rewritten at the integration of 2026-10-10. The line said 49 for an arrival in 47 with one turn of standing; played
  // on the sample world's records the banner could be raised from turn 50: the host's standing counts from the turn
  // AFTER its arrival. The spec's own example, 「旗はターン 49 から」, was a turn early)
  assert.equal(text(protoHud.marchLine(FS, { arrive: 47, answer: { ok: true, tiles: [1, 2, 3, 4, 5, 6, 7], trail: [8, 9], size: 9, price: 0, waitTurns: 1 } })), '試作 到着：ターン 47・旗はターン 50 から・+9マス');
  assert.equal(text(protoHud.marchLine(FS, { arrive: 47, answer: { ok: true, tiles: [1, 2, 3], trail: [], size: 3, price: 8, waitTurns: 12 } })), '試作 到着：ターン 47・旗はターン 61 から・+3マス 功績 8');
  // a march onto a tile an enemy host holds is an attack, and is said as that
  assert.equal(text(protoHud.marchLine(FS, { arrive: 52, answer: { ok: false, code: 'NotOpen', need: { why: 'enemy' } } })), '試作 到着：ターン 52・敵の軍勢が立っています。勝てば、このマスに立ちます');
  assert.equal(text(protoHud.marchLine(FS, { arrive: 47, answer: { ok: false, code: 'NotHere', why: 'heartland' } })), '試作 到着：ターン 47・ここでは旗を立てられません：他国の中核地です');
  assert.equal(protoHud.marchLine(FS, { arrive: null, answer: { ok: true, size: 9, waitTurns: 1 } }), '');
  setLang('en');
  assert.equal(text(protoHud.marchLine(FS, { arrive: 47, answer: { ok: true, tiles: [], trail: [], size: 9, price: 0, waitTurns: 1 } })), 'Prototype Arrives on turn 47 · banner from turn 50 · +9 tiles');
  assert.equal(text(protoHud.placeLine(FS, { ok: true, tiles: [], trail: [], size: 7, price: 0, waitTurns: 1 })), 'Prototype A host standing here can raise a banner: +7 tiles after 1 turn (about 20 s real time)');
  // (a reason said after the colon loses its capital; a reason that begins with a name the page capitalises keeps it)
  assert.equal(text(protoHud.placeLine(FS, { ok: false, code: 'PerProvince', need: { perProvince: 2 } })), 'Prototype No banner can rise here: at most 2 banners in a province; raise the next one in another');
  assert.equal(text(protoHud.placeLine(FS, { ok: false, code: 'Scouts' })), 'Prototype No banner can rise here: Scouts cannot raise or take banners');
  // the order card itself (hud/marchcard.mjs) reads the same cache: its module says so
  // (rewritten 2026-10-11, the phone and the new village: the call gained the card's own forecast — what the rules say
  // of an attack is now part of the line — and whether another march of the viewer's arrives in that province in the
  // same turn; the cache it reads the world's answer from is the same)
  { const src = read('frontier/hud/marchcard.mjs');
    assert.match(src, /FS\.proto && w && c\.route && protoFights\(c\.host\) && !c\.home \? protoMarchLine\(FS, \{ arrive: w\.value, dest: c\.dest, forecast: c\.forecast \?\? null, crowd: protoOwnArrivalAt\(FS, c\.dest, w\.value, c\.host\.id\), shift: [^}]+, answer: protoPreviewOf\(FS, \{ host: String\(c\.host\.id\), p: c\.dest\.p, q: c\.dest\.q, tile: c\.dest\.tile \}\) \}\) : ''/); }
  // a march onto the viewer's own banner land (to walk it, to win its pole back) is said as that, not as a refusal
  setLang('ja');
  assert.equal(text(protoHud.marchLine(FS, { arrive: 47, dest: { p: 2, q: 0, tile: POLE }, answer: { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 } } })), '試作 到着：ターン 47・あなたの旗の土地です');
  setLang('en');
  assert.equal(typeof marchcard.render, 'function');
});

// ------------------------------------------------------------------ what happened
const rec = (seq, op, x = {}) => ({ seq: String(seq), chainSlot: 1, kind: 'PROTO_LAND', proto: true, op, turn: 41, p: 2, q: 0, slot: 0, pole: POLE, nation: 0, holder: '2,0,3', tiles: [...PATCH], from: null, works: 0, by: '2,0,3', host: String(id(10)), ...x });
test('what happened is told from PROTO_LAND records and from nothing else; the first read of the log is not news', () => {
  const { FS } = world();
  const page = [{ seq: 5, slot: 1, sig: 's', body_b64: 'AAAA' }, rec(7, 'RAISE'), { seq: 8, kind: 'PROTO_LAND', proto: false, op: 'RAISE' }, { seq: 9, kind: 'OTHER', proto: true }];
  assert.deepEqual(pm.landRecords(page).map(r => r.seq), ['7'], 'only records that say they are the prototype\'s');
  FS.proto.log = pm.mergeLog([], pm.landRecords(page));
  FS.proto.log = pm.mergeLog(FS.proto.log, pm.landRecords(page));
  assert.equal(FS.proto.log.length, 1, 'a record is kept once');
  assert.deepEqual(pm.freshNews(FS), { records: [], items: [] }, 'what was in the log when the page came is not news');
  FS.proto.log = pm.mergeLog(FS.proto.log, [rec(10, 'RAISE', { tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), rec(11, 'RAISE', { holder: '2,0,9', by: '2,0,9', host: '999', slot: 4, tiles: [1, 2, 3] }), rec(12, 'RAISE', { nation: 2, holder: '2,0,7', by: '2,0,7', host: '998', slot: 5, tiles: [1, 2, 3, 4] }),
    rec(13, 'TEND'), rec(14, 'WALK', { works: 2, tiles: [] }), rec(15, 'FRAY', { by: 'keeper', host: null }), rec(16, 'PULL', { nation: 0, from: 0, fromHolder: '2,0,3', by: '2,0,7', host: '998' }), rec(17, 'HEARTH', { slot: null, site: 3, premise: true }),
    rec(18, 'TAKE', { nation: 2, holder: '2,0,7', from: 0, fromHolder: '2,0,3', by: '2,0,7', host: '998' }), rec(19, 'RAISE', { nation: 2, holder: '2,0,7', by: 'script', host: null, slot: 6, premise: true })]);
  // (a banner that was taken is no longer in the viewer's record when the record of its fall is read: the page remembers it was the viewer's)
  FS.proto.me = { ...ME, banners: [] };
  const { records, items } = pm.freshNews(FS);
  assert.equal(records.length, 8, 'every new record goes to the board\'s moments; what the world wrote when it began (premise) is no news');
  assert.deepEqual(items.map(x => x.text), ['+9マス あなたの土地になりました', `同じ国の${pm.holderName('2,0,9')}が旗を立てました（+3マス）`, 'シンダーがわたしたちの州に旗を立てました（4マス）', '旗を見回りました', '今日最初の見回り：功績 +2',
    'あなたの旗がほつれました：いまは得点になりません。見回れば戻ります', 'あなたの旗が倒されました（−7マス）', 'あなたの旗がシンダーに取られました']);
  assert.ok(items.every(x => x.kind === 'proto' && x.proto === true && x.id.startsWith('pl:') && x.bell === 42 && x.settled === 41), 'told in the clock\'s turn; the record\'s own turn is the settled one');
  assert.ok(pm.holderName('2,0,9').length > 0 && pm.holderName('keeper') === '');
  assert.deepEqual(items[0].banner, { p: 2, q: 0, slot: 0 });
  assert.deepEqual(pm.freshNews(FS), { records: [], items: [] }, 'told once');
  setLang('en');
  assert.equal(pm.newsOf(FS, rec(20, 'RAISE', { tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).text, '+9 tiles are now yours');
  assert.equal(pm.newsOf(FS, rec(21, 'PULL', { nation: 0, from: 0, fromHolder: '2,0,3', by: '2,0,7', host: '998' })).text, 'Your banner was pulled down (−7 tiles)');
  assert.equal(pm.newsOf(FS, rec(22, 'TAKE', { nation: 0, from: 2, fromHolder: '2,0,7', slot: 1 })).text, 'You took a banner of Cinder (+7 tiles)');
  setLang('ja');
  // in this turn's list and in the list of notices each says 試作; the toast says it in its heading
  FS.feed = feed.pushFeed([], items);
  const list = turnlist.turnModel(FS, { next: [] });
  assert.ok(list.happened.length === 8 && list.happened.every(x => x.text.startsWith('試作：')));
  assert.match(flat(feed.renderCentre(FS.feed, 'all')), /試作：\+9マス あなたの土地になりました/);
  assert.equal(feed.bellSummary(FS.feed, 42).text, 'ターン 42 のまとめ：旗（試作） 8');
  // the page never tells of an order from the order's own answer: the controller says only that it was given
  const src = read('frontier/controller.mjs');
  assert.match(src, /raise: \(\) => L`旗を立てる命令を出しました（試作）。記録を待っています`/);
  assert.doesNotMatch(src, /あなたの土地になりました/);
});

test('a banner under threat: the line with its count, 見る and 軍勢を送る; said once while it stands', () => {
  const FS = world({ landRec: land({ contested: { nation: 2, host: '999', sinceTurn: 41, canTakeAtTurn: 68 } }) }).FS;
  const t = pm.threatsOf(FS);
  assert.deepEqual({ p: t[0].p, q: t[0].q, slot: t[0].slot, tile: t[0].tile, nation: t[0].nation, left: t[0].left }, { p: 2, q: 0, slot: 0, tile: POLE, nation: 2, left: 27 });
  const next = protoHud.turnItems(FS);
  assert.deepEqual(next.map(x => ({ text: x.text, send: x.send })), [{ text: '試作：あなたの旗が狙われています。あと27ターン（約9分）で取られます', send: { p: 2, q: 0, tile: POLE } }]);
  const item = { id: t[0].id, kind: 'proto', proto: true, bell: 42, p: 2, q: 0, tile: POLE, text: t[0].text, send: { p: 2, q: 0, tile: POLE } };
  const toast = flat(feed.renderToast(item));
  assert.match(toast, new RegExp(`data-act="proto-send" data-p="2" data-q="0" data-tile="${POLE}"`));
  assert.match(toast, /data-act="feed-go"/);
  FS.feed = [item];
  const list = turnlist.turnModel(FS, { next });
  assert.equal(list.happened.length, 0, 'the standing threat is in "next", not said twice');
  assert.match(flat(turnlist.renderTurnList(list)), /data-act="proto-send"/);
  // another nation's banner about to rise on our ground
  const foe = world({ landRec: land({ rising: [{ host: '555', nation: 2, tile: OPEN, sinceTurn: 41, canRaiseAtTurn: 50, tiles: 7 }] }) }).FS;
  assert.deepEqual(pm.risingFoes(foe).map(x => x.text), ['わたしたちの州にシンダーの旗が立ちそうです：あと9ターン（約3分）']);
  const th = pm.threatsOf(foe);
  assert.deepEqual({ kind: th[0].kind, tile: th[0].tile, nation: th[0].nation, left: th[0].left }, { kind: 'rise', tile: OPEN, nation: 2, left: 9 }, 'a threat like the other: answered by a march that wins the tile');
  assert.deepEqual(protoHud.turnItems(foe).map(x => x.send), [{ p: 2, q: 0, tile: OPEN }]);
  const g = pm.guideModel(foe);
  assert.equal(g.current, 'answer'); assert.equal(g.title, '敵の旗を防ぐ'); assert.match(g.text, /何もしなければ、旗が立ちます。$/);
});

// ------------------------------------------------------------------ the score and the province card
test('the score: six nations by share of tile-turns, the record\'s own note under them, never called a chain record', () => {
  const { FS } = world();
  const m = pm.standingsModel(FS);
  assert.deepEqual(m.rows.map(r => r.nation), [0, 1, 2, 3, 4, 5]);
  assert.equal(pm.pctText(m.rows[0].share), '17.2');
  assert.ok(m.rows[0].mine && !m.rows[1].mine);
  const t = text(protoHud.ticker(FS));
  assert.match(t, /^領土の得点 試作 1 アステル 17\.2% 2 ボレアリス 16\.9%/);
  assert.ok(t.endsWith(NOTE.ja), 'the note stands under the ticker');
  assert.match(flat(protoHud.ticker(FS)), /aria-label="領土の得点（試作）：アステル 17\.2% · /);
  // shares given as percentages read the same
  FS.proto.standings = { ...STANDINGS, nations: STANDINGS.nations.map(n => ({ ...n, share: n.share * 100 })) };
  assert.equal(pm.pctText(pm.standingsModel(FS).rows[0].share), '17.2');
  setLang('en');
  assert.match(text(protoHud.ticker(FS)), /^Territory score Prototype 1 Aster 17\.2%/);
  assert.ok(text(protoHud.ticker(FS)).endsWith(NOTE.en));
  assert.equal(protoHud.ticker(world({ standings: null }).FS), '');
});

test('the province card: 61 segments by nation, the counts, the viewer\'s nation against the ceiling and the viewer\'s banners', () => {
  const { FS } = world();
  const card = protoHud.provinceCard(FS, 2, 0);
  assert.equal((flat(card).match(/<rect /g) ?? []).length, 61);
  assert.match(text(card), /アステル 54 · シンダー 7/);
  assert.match(text(card), /あなたの国 14マス · あなた 1\/2本/);
  // in another nation's province: the ceiling, and that the prototype has no keeps
  const abroad = land(); abroad.holderNation = 2; abroad.counted = [13, 0, 20, 0, 0, 0]; abroad.paid = [13, 0, 48, 0, 0, 0];
  const far = world({ landRec: abroad, me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }] } }).FS;
  const c2 = text(protoHud.provinceCard(far, 2, 0));
  assert.match(c2, /シンダー 48 · アステル 13/);
  assert.match(c2, /あなたの国 13\/24 · あなた 2\/2本/);
  assert.match(c2, /この州で点になるのは24マスまでです。試作では砦がありません。/);
  // a tile: village land (a record now), a banner, the commons
  assert.match(text(protoHud.tileCard(FS, 2, 0, VILLAGE[1])), /村の土地 7マス（あなたの土地）/);
  assert.match(text(protoHud.tileCard(FS, 2, 0, PATCH[1])), /あなたの旗（しっかり立っています・3日に1回の見回り）/);
  assert.match(text(protoHud.tileCard(FS, 2, 0, FOE)), /シンダーの旗/);
  assert.match(text(protoHud.tileCard(FS, 2, 0, OPEN)), /国の共有地（まだ誰の旗もありません）/);
  // the viewer's own banner can be struck from here, after asking; never while an enemy stands on it
  assert.match(flat(protoHud.tileCard(FS, 2, 0, POLE)), /data-act="proto-strike-tile" data-p="2" data-q="0" data-slot="0" data-on="1" >/);
  FS.proto.ask = '2,0,0';
  assert.match(flat(protoHud.tileCard(FS, 2, 0, POLE)), /data-act="proto-strike" data-p="2" data-q="0" data-slot="0" >/);
  const held = world({ landRec: land({ contested: { nation: 2, host: '999', sinceTurn: 41, canTakeAtTurn: 68 } }) }).FS;
  assert.match(flat(protoHud.tileCard(held, 2, 0, POLE)), /data-act="proto-strike-tile"[^>]*aria-disabled="true"/);
  // the Scout's card
  assert.equal(text(protoHud.exploreLine(FS)), '試作 今日の探索：あと2マス');
  assert.equal(text(protoHud.exploreLine(world({ me: { ...ME, exploreLeftToday: 0 } }).FS)), '試作 今日はここまでです（このマスは未探索のまま残ります）');
});

// ------------------------------------------------------------------ the guide
test('the guided first minutes: one step at a time from the records; the threat comes first while it stands', () => {
  const me0 = { ...ME, tiles: 7, paidTiles: 7, banners: [] };
  let FS = world({ me: me0, landRec: land({ banners: false }) }).FS;
  let g = pm.guideModel(FS);
  assert.deepEqual(g.steps.map(s => `${s.id}:${s.status}`), ['land:done', 'form:current', 'raise:todo', 'second:todo', 'march:todo', 'walk:todo']);
  assert.deepEqual(g.go, { act: 'proto-guide', data: { go: 'form' }, label: '編成する' });
  let n = protoHud.guideNext(FS);
  assert.deepEqual({ kind: n.kind, kicker: n.kicker, title: n.title, act: n.act }, { kind: 'guide', kicker: '旗のガイド（試作） 2/6', title: '軍勢を編成する', act: 'proto-guide' });
  // a host counting, then ready
  FS = world({ me: me0, landRec: land({ banners: false, rising: rising(42, 7) }) }).FS;
  g = pm.guideModel(FS);
  assert.equal(g.current, 'raise'); assert.equal(g.text, 'あと1ターンで旗を立てられます'); assert.deepEqual(g.go.data, { go: 'host', host: String(id(9)) });
  FS = world({ me: me0, landRec: land({ banners: false, rising: rising(41, 7) }) }).FS;
  assert.equal(pm.guideModel(FS).go.label, '旗を立てる');
  // one banner: the second; two at home: the next land is where you march
  FS = world().FS;
  assert.equal(pm.guideModel(FS).current, 'second');
  FS = world({ me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }] } }).FS;
  g = pm.guideModel(FS);
  assert.equal(g.current, 'march');
  assert.equal(g.text, 'この州の旗は2本です。つぎの土地は、進軍した先です。歩いた跡も一緒に土地になります。');
  // a banner away, under threat: the answer, with 軍勢を送る
  FS = world({ me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] }, landRec: land({ contested: { nation: 2, host: '999', sinceTurn: 41, canTakeAtTurn: 68 } }) }).FS;
  g = pm.guideModel(FS);
  assert.equal(g.current, 'answer');
  assert.deepEqual(g.go, { act: 'proto-send', data: { p: 2, q: 0, tile: POLE }, label: '軍勢を送る' });
  assert.match(g.text, /何もしなければ、旗は取られます。$/);
  // (the merge of 2026-10-11) a host that can only pull the banner down: the step ends as the threat's own sentence says, and never says "taken"
  FS = world({ me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] }, landRec: land({ contested: { nation: 2, host: '999', sinceTurn: 41, canTakeAtTurn: 68, onlyPull: 'place' } }) }).FS;
  g = pm.guideModel(FS);
  assert.equal(g.current, 'answer');
  assert.match(g.text, /で倒されます。軍勢を送って、そのマスを取り返しましょう。何もしなければ、旗は倒されます。$/);
  assert.doesNotMatch(g.text, /取られます/);
  // then the walk; all done: no guide
  FS = world({ me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] } }).FS;
  assert.equal(pm.guideModel(FS).current, 'walk');
  FS.proto.me = { ...FS.proto.me, walkPaidToday: true };
  assert.equal(pm.guideModel(FS), null);
  assert.equal(protoHud.guideNext(FS), null);
});

// ------------------------------------------------------------------ what the independent check of 2026-10-11 found
test('a host that could raise its own banner is not offered its own tile for widening (the world would take it, and its banner could not rise there)', () => {
  const beside = pm.tilesBeside(OPEN).find(t => t !== POLE) ?? pm.tilesBeside(OPEN)[0];
  const acts = dress => ({ host: String(id(9)), p: 2, q: 0, tile: OPEN, unit: 0, stands: true, raise: { ok: true, tiles: [OPEN], trail: [], size: 5, price: 0, waitTurns: 0 }, onPole: null, fell: null, tend: [], dress });
  const row = { id: id(9), unit: 0, p: 2, q: 0, tile: OPEN };
  // the only tile the world offers is the one the host stands on: no widening is offered at all
  let FS = world({ me: { ...ME, hosts: [acts([{ slot: 0, tiles: [OPEN], code: null }])] } }).FS;
  assert.equal(pm.hostSituation(FS, row).widen, null);
  select(FS, OPEN, id(9)); FS.hand.pop = 'banner';
  assert.doesNotMatch(flat(hand.renderPop(FS, hand.handModel(FS))), /proto-widen/);
  // another tile beside it is offered, and only that one
  FS = world({ me: { ...ME, hosts: [acts([{ slot: 0, tiles: [OPEN, beside], code: null }])] } }).FS;
  assert.deepEqual(pm.hostSituation(FS, row).widen.dress.tiles, [beside]);
  select(FS, OPEN, id(9)); FS.hand.pop = 'banner';
  assert.match(flat(hand.renderPop(FS, hand.handModel(FS))), /data-act="proto-widen"/);
});

test('the raise card says when the place was chosen for more tiles than the world gives now, and why', () => {
  const raise = { ok: true, tiles: [OPEN, 1, 2], trail: [], size: 3, price: 0, waitTurns: 0 };
  const FS = world({ me: { ...ME, hosts: [{ host: String(id(9)), p: 2, q: 0, tile: OPEN, unit: 0, stands: true, raise, tend: [], dress: [] }] } }).FS;
  const card = () => { select(FS, OPEN, id(9)); FS.hand.pop = 'banner'; return text(hand.renderPop(FS, hand.handModel(FS))); };
  assert.equal(pm.promiseShort(FS, 2, 0, OPEN, 3), null, 'nothing was promised here');
  assert.doesNotMatch(card(), /この場所を選んだとき/);
  // five were promised, two of them have become banner land since (PATCH is the viewer's banner in this fixture)
  FS.proto.promised = new Map([[`2,0,${OPEN}`, { size: 5, tiles: [OPEN, 1, 2, PATCH[1], PATCH[2]], turn: 42 }]]);
  assert.deepEqual(pm.promiseShort(FS, 2, 0, OPEN, 3), { was: 5, now: 3, toLand: 2, other: 0 });
  assert.match(card(), /この場所を選んだときは \+5マス でした。そのうち2マスは、先に立った旗の土地になりました。/);
  // the tiles are still open ground: the world gives fewer for another reason, and the card does not blame a banner
  FS.proto.promised = new Map([[`2,0,${OPEN}`, { size: 5, tiles: [OPEN, ...pm.tilesBeside(OPEN).slice(0, 4)], turn: 42 }]]);
  assert.deepEqual(pm.promiseShort(FS, 2, 0, OPEN, 3), { was: 5, now: 3, toLand: 0, other: 2 });
  assert.match(card(), /そのうち2マスは、いまは土地にできません/);
  assert.equal(pm.promiseShort(FS, 2, 0, OPEN, 5), null, 'what was promised is given: nothing is said');
  setLang('en');
  assert.match(card(), /When you chose this place it was \+5 tiles\. 2 of them cannot be taken now/);
});

test('the order card says its wait in the clock the prototype\'s lines use; with the prototype off, in the game\'s minutes as before', () => {
  const src = read('frontier/hud/marchcard.mjs');
  assert.match(src, /const awayLine = !FS\.proto \? \(away !== null \? L`約 \$\{fmtNum\(away\)\} 分後` : ''\) : awayWall !== null \? L`\$\{protoAbout\(awayWall\)\}後` : '';/);
  assert.match(src, /const awayWall = w && Number\.isInteger\(FS\.nowBell\) && wallTurn !== null \? Math\.max\(1, w\.value - FS\.nowBell\) \* wallTurn : null;/, 'in whole turns: the words change at a toll, not every second');
  assert.equal(pm.turnWallSecs({ sample: { rate: 30 } }), 20); assert.equal(pm.aboutTime(16), '約16秒');
});

test('a standing threat\'s notice stays first while the threat stands; a threat that is gone is said once, and the tile that was won is the guide\'s next step', () => {
  const alarm = { id: 'th:1', kind: 'proto', proto: true, alarm: true, own: true, at: Date.now() - 200_000, text: 'あと12ターン' };
  const later = [1, 2, 3].map(i => ({ id: `n${i}`, kind: 'build', at: Date.now(), text: `n${i}` }));
  assert.deepEqual(feed.liveToasts([...later, alarm]).map(x => x.id), ['n1', 'n2', 'n3'], 'without the standing set an old notice has timed out');
  assert.deepEqual(feed.liveToasts([...later, alarm], { standing: new Set(['th:1']) }).map(x => x.id), ['th:1', 'n1', 'n2'], 'a standing alarm is first, however old');
  assert.deepEqual(feed.liveToasts([...later, alarm], { standing: new Set(['th:1']), dismissed: new Set(['th:1']) }).map(x => x.id), ['n1', 'n2', 'n3'], 'unless the player put it away');
  // another nation's count on our ground that is gone, with a host of the viewer's on the tile
  const was = { id: 'rf:2,0,999:44', kind: 'rise', p: 2, q: 0, tile: OPEN, nation: 2, left: 5, done: false, text: '' };
  let FS = world({ me: { ...ME, hosts: [{ host: String(id(9)), p: 2, q: 0, tile: OPEN, unit: 0, raise: { ok: false, code: 'StandLonger', need: { tolls: 1, atTurn: 42 }, size: 5 }, tend: [], dress: [] }] } }).FS;
  let line = pm.threatGone(FS, was);
  assert.equal(line.won, true); assert.equal(line.text, 'シンダーの旗を止めました。このマスは、あなたの軍勢が押さえています'); assert.equal(line.proto, true);
  FS = world().FS;
  // (rewritten 2026-10-11: the line said only 「シンダーの旗は立たずに終わりました」 — a count that vanished with no reason
  // given, the owner's finding for a new hamlet. The roster of that province is on the page and nobody of that nation
  // stands on the tile: that is what the line says now; the bare sentence is kept for a province whose roster the page
  // does not hold)
  assert.equal(pm.threatGone(FS, { ...was, tile: 5 }).text, 'シンダーの軍勢は、そのマスにいなくなりました。旗は立ちません');
  { const G = world().FS; G.provinces = new Map(); assert.equal(pm.threatGone(G, { ...was, tile: 5 }).text, 'シンダーの旗は立たずに終わりました'); }
  // their banner did rise on that tile: its own record tells it, and nothing is said here
  assert.equal(pm.threatGone(FS, { ...was, tile: FOE }), null);
  // a banner of the viewer's that was under threat and is free again
  assert.equal(pm.threatGone(FS, { id: 'th:x', kind: 'take', p: 2, q: 0, slot: 0, tile: POLE, nation: 2 }).text, 'あなたの旗は守られました。狙っていた軍勢はいなくなりました');
  // the guide: the tile that was won, while a host of the viewer's counts there; gone once nothing stands to raise
  const all = { ...ME, walkPaidToday: true, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] };
  FS = world({ me: { ...all, hosts: [{ host: String(id(9)), p: 2, q: 0, tile: OPEN, unit: 0, raise: { ok: true, size: 5, price: 4, tiles: [], trail: [] }, tend: [], dress: [] }] } }).FS;
  FS.proto.guide = { threat: true, walked: true, won: { p: 2, q: 0, tile: OPEN } };
  const g = pm.guideModel(FS);
  assert.equal(g.current, 'won'); assert.equal(g.title, '勝ち取ったマスに旗'); assert.deepEqual(g.go, { act: 'proto-guide', data: { go: 'host', host: String(id(9)) }, label: '旗を立てる' });
  assert.match(text(protoHud.guideCard(FS)), /勝ち取ったマスに旗/);
  FS.proto.me = all;
  assert.equal(pm.guideModel(FS), null);
});

test('the step of walking is named by what its button opens, and the card it opens says why', () => {
  const me = { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] };
  // a host that the world lets walk a banner now
  let FS = world({ me: { ...me, hosts: [{ host: String(id(10)), p: 2, q: 0, tile: POLE, unit: 0, raise: null, tend: [{ slot: 0, ok: true, paysToday: true }], dress: [] }] } }).FS;
  assert.equal(pm.guideModel(FS).go.label, '見回る');
  // none: a new host is formed (the reserve has troops), and the text says who may walk
  FS = world({ me }).FS;
  let g = pm.guideModel(FS);
  assert.equal(g.go.label, '編成する'); assert.match(g.text, /^見回れるのは、旗の土地に新しく立った軍勢です。/);
  // no troops in reserve: training comes first
  FS.holdings = [{ ...FS.holdings[0], reserve: [0, 0, 0, 0, 0, 0, 0, 0] }];
  g = pm.guideModel(FS);
  assert.equal(g.go.label, '訓練する'); assert.match(g.text, /まず村で兵を訓練し/);
  assert.equal(flat(protoHud.whyLine(FS)), '');
  FS.hand = { protoWhy: 'walk' };
  assert.match(text(protoHud.whyLine(FS)), /^試作 旗の土地に新しく立った軍勢が見回れます$/);
  delete FS.proto;
  assert.equal(flat(protoHud.whyLine(FS)), '', 'nothing with the prototype off');
});

test('a phone: the guide\'s step as one line while the hand or a sheet has the foot of the screen; the raise card as a low sheet with the rest behind くわしく', () => {
  const me0 = { ...ME, tiles: 7, paidTiles: 7, banners: [] };
  const FS = world({ me: me0, landRec: land({ banners: false }) }).FS;
  const strip = protoHud.guideStrip(FS);
  assert.match(flat(strip), /class="proto-strip" data-act="proto-guide" data-go="form"/);
  assert.match(text(strip), /^旗のガイド（試作） 2\/6 軍勢を編成する 編成する$/);
  assert.equal(flat(protoHud.guideStrip(world({ proto: false }).FS)), '');
  // the card: the brief line is in the markup, the long part closed until it is asked for
  const R = world({ me: { ...ME, hosts: [{ host: String(id(9)), p: 2, q: 0, tile: OPEN, unit: 0, raise: { ok: true, tiles: [1, 2, 3, 4, 5, 6, 7], trail: [], size: 7, price: 0, waitTurns: 0 }, tend: [], dress: [] }] } }).FS;
  select(R, OPEN, id(9)); R.hand.pop = 'banner';
  let card = flat(hand.renderPop(R, hand.handModel(R)));
  assert.match(card, /<p class="proto-brief"><strong class="pb-gain num">\+7マス<\/strong>/); assert.match(card, /<div class="proto-full">/); assert.match(card, /data-act="proto-more" aria-expanded="false"/);
  R.hand.more = true;
  card = flat(hand.renderPop(R, hand.handModel(R)));
  assert.match(card, /<div class="proto-full open">/); assert.match(card, /設計中のルールの試作です。/);
  const css = read('frontier/proto-hand.css');
  assert.match(css, /\.proto-full:not\(\.open\) \{ display: none; \}/); assert.match(css, /\.proto-brief \{ display: none;/, 'a wide screen shows the whole card and no brief line');
});

// ------------------------------------------------------------------ the phone and the new village (2026-10-11, second pass)
/** A world whose village is a new hamlet: provisional (`final: false`: its final time has not come), nothing in reserve unless given, no host. */
function hamlet({ final = true, reserve = [0, 0, 0, 0, 0, 0, 0, 0], entries = [], landRec = land({ banners: false }), me = { ...ME, tiles: 7, paidTiles: 7, banners: [], cap: 3, hosts: [] } } = {}) {
  const w = world({ me, landRec });
  const holding = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: final ? 2 : 1, FACTION: 0, TIER: 0, FINAL_TS: final ? 0 : 5_000, RESERVE: reserve, QUEUE: [], TRANSIT: [] });
  const host = (seq, faction, tile, troops, gen = 1) => ({ ID: hostId({ p: 2, q: 0, site: faction === 0 ? 3 : 7, gen, seq }), FACTION: faction, UNIT: 0, TILE: tile, STATE: 1, TROOPS: troops * 1000, STAMINA_VALUE: 120, STAMINA_BELL: 42, READY_BELL: 0, FROM_BELL: 40 });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 41, SITE_COUNT: 4, SITES: Uint8Array.of(0, 0, 0, 30, ...new Array(8).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 0 }, { STATE: 0 }, { STATE: 0 }, { STATE: 1, FACTION: 0, TIER: 0 }, ...Array.from({ length: 8 }, () => ({ STATE: 0 }))], ENTRIES: entries.map(e => host(...e)) });
  w.FS.holdings = [holding]; w.FS.provinces = new Map([['2,0', { province }]]);
  return w.FS;
}
const foeRising = (left = 9) => [{ host: '999', nation: 2, holder: '2,0,7', tile: OPEN, sinceTurn: 40, canRaiseAtTurn: 41 + left, tiles: 5, patch: [OPEN], trail: [] }];

test('a new village: while it is provisional the guide says so and offers no button that cannot be pressed', () => {
  // provisional, nothing in reserve: the truth, and the one thing that can be done meanwhile
  let FS = hamlet({ final: false });
  assert.equal(pm.villageFinal(FS), false);
  let g = pm.guideModel(FS);
  assert.equal(g.current, 'form'); assert.equal(g.title, '村の確定を待つ');
  assert.equal(g.text, 'あなたの村は、まだ仮の村です。軍勢を編成できるのは、村が確定してからです。それまでに、槍兵を訓練しておけます。');
  assert.deepEqual(g.go, { act: 'proto-guide', data: { go: 'form' }, label: '訓練する' });
  // provisional, troops trained: nothing to press (the button said 編成する and opened a card whose own button was dead)
  FS = hamlet({ final: false, reserve: [100, 0, 0, 0, 0, 0, 0, 0] });
  g = pm.guideModel(FS);
  assert.equal(g.go, null); assert.match(g.text, /^あなたの村は、まだ仮の村です。軍勢を編成できるのは、村が確定してからです。確定したら、/);
  assert.equal(hand.handModel(Object.assign(FS, { selected: { kind: 'tile', p: 2, q: 0, idx: 30 }, hand: { host: null, pop: null } })).buttons.find(b => b.id === 'muster').why, '村が確定してからです', 'the bar says the same of its own button');
  const n = protoHud.guideNext(FS);
  assert.equal(n.label, ''); assert.deepEqual(n.data, { go: 'steps' }, 'the one prompt opens the list of steps, never a dead order');
  assert.doesNotMatch(text(protoHud.guideStrip(FS)), /編成する/);
  // final: the steps as for any village
  FS = hamlet({ reserve: [100, 0, 0, 0, 0, 0, 0, 0] });
  assert.equal(pm.villageFinal(FS), true);
  assert.deepEqual(pm.guideModel(FS).go, { act: 'proto-guide', data: { go: 'form' }, label: '編成する' });
  setLang('en');
  FS = hamlet({ final: false });
  assert.equal(pm.guideModel(FS).title, 'Waiting for the village to be confirmed');
  assert.equal(pm.guideModel(FS).text, 'Your village is still provisional. A host can be formed only once the village is confirmed. Until then you can train Spearmen.');
});

test('a threat the viewer is outnumbered by: the numbers are said, the other steps are not held back, and a banner that can rise comes first', () => {
  // a host of 500 of another nation counts on our ground; the hamlet has one host of 100 counting toward its first banner
  const mine = [{ host: String(id(9)), p: 2, q: 0, tile: POLE, unit: 0, raise: { ok: false, code: 'StandLonger', need: { tolls: 1, atTurn: 42 }, size: 5, atTurn: 42 }, tend: [], dress: [] }];
  let FS = hamlet({ entries: [[9, 0, POLE, 100], [1, 2, OPEN, 500]], landRec: land({ banners: false, rising: foeRising() }), me: { ...ME, tiles: 7, paidTiles: 7, banners: [], cap: 3, hosts: mine } });
  assert.deepEqual(pm.hostOn(FS, 2, 0, OPEN, 2), { unit: 0, troops: 500 });
  assert.deepEqual(pm.strengthOf(FS), { host: 100, reserve: 0, best: 100 });
  const t = pm.threatsOf(FS)[0];
  assert.deepEqual(t.foe, { unit: 0, troops: 500 });
  let g = pm.guideModel(FS);
  assert.equal(g.threat.outnumbered, true);
  assert.equal(g.current, 'raise', 'the banner the hamlet is counting toward stays the step');
  assert.deepEqual(g.steps.map(s => `${s.id}:${s.status}`), ['land:done', 'form:done', 'raise:current', 'second:todo', 'march:todo', 'answer:todo', 'walk:todo']);
  assert.equal(g.steps.find(s => s.id === 'answer').name, '敵の旗を防ぐ');
  // nothing else left to do: the threat is the step, with the numbers and where to look before sealing
  FS = hamlet({ entries: [[9, 0, POLE, 100], [1, 2, OPEN, 500]], landRec: land({ banners: false, rising: foeRising() }), me: { ...ME, walkPaidToday: true, cap: 3, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }], hosts: [] } });
  g = pm.guideModel(FS);
  assert.equal(g.current, 'answer');
  assert.equal(g.text, 'わたしたちの州にシンダーの旗が立ちそうです：あと9ターン（約3分）。立っているのはシンダーの槍兵 500です。あなたのいちばん大きい軍勢は100人です。数で下回っています。送るなら、命令の紙の予測を先に確かめましょう。何もしなければ、旗が立ちます。');
  assert.deepEqual(g.go, { act: 'proto-send', data: { p: 2, q: 0, tile: OPEN }, label: '軍勢を送る' }, 'the order card (with the forecast) is one press away: no dead button');
  // not outnumbered (a town's 600 in the village): the threat comes first, in the sentence it had
  FS = world({ landRec: land({ rising: foeRising() }) }).FS;
  FS.provinces.get('2,0').province.entries.push({ id: 1n, faction: 2, unit: 0, tile: OPEN + 1, state: 1, troops: 500_000 });
  FS.proto.lands.get('2,0').rising[0].tile = OPEN + 1;
  g = pm.guideModel(FS);
  assert.equal(g.threat.outnumbered, false); assert.equal(g.current, 'answer');
  assert.match(g.text, /。軍勢を送って、そのマスを取りましょう。何もしなければ、旗が立ちます。$/);
  // a banner that can rise this moment comes before the threat, whichever step it belongs to (it did only at the step of the march)
  FS = world({ me: { ...ME, tiles: 7, paidTiles: 7, banners: [] }, landRec: land({ banners: false, rising: [...rising(41, 7), ...foeRising()] }) }).FS;
  g = pm.guideModel(FS);
  assert.equal(g.current, 'raise'); assert.equal(g.go.label, '旗を立てる');
  // a threat whose host the page cannot count is answered as before
  FS = world({ me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }] }, landRec: land({ contested: { nation: 2, host: '999', sinceTurn: 41, canTakeAtTurn: 68 } }) }).FS;
  FS.provinces.get('2,0').province.entries = FS.provinces.get('2,0').province.entries.filter(e => e.tile !== POLE);
  g = pm.guideModel(FS);
  assert.equal(g.threat.foe, null); assert.equal(g.current, 'answer');
  setLang('en');
  FS = hamlet({ entries: [[9, 0, POLE, 100], [1, 2, OPEN, 500]], landRec: land({ banners: false, rising: foeRising() }), me: { ...ME, walkPaidToday: true, cap: 3, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }], hosts: [] } });
  assert.equal(pm.guideModel(FS).text, 'A banner of Cinder is about to rise in a province of ours: 9 turns (about 3 min real time). The host standing there is 500 Spearmen of Cinder. Your largest host is 100 strong. You are outnumbered. If you send a host, read the forecast on the order card first. If nothing is done the banner rises.');
});

test('what became of a count that vanished is said from the records: the host thinned below the rule\'s floor, or gone from the tile', () => {
  const was = { id: 'rf:2,0,999:44', kind: 'rise', p: 2, q: 0, tile: OPEN, nation: 2, left: 5, done: false, text: '' };
  // the host still stands there with 475: the record's own table asks 500 of a host on another nation's ground
  let FS = hamlet({ entries: [[1, 2, OPEN, 475]] });
  FS.proto.claims = { ...CLAIMS, numbers: { ...CLAIMS.numbers, FLOOR_ABROAD: 500 } };
  let line = pm.threatGone(FS, was);
  assert.equal(line.text, 'シンダーの軍勢は475人に減りました。ここに旗を立てるには500人が要るので、旗の数えは消えました');
  assert.equal(line.why, 'floor'); assert.equal(line.won, false); assert.equal(line.proto, true);
  assert.equal(pm.threatOutcome(FS, was), 'ended');
  // the record's table does not carry the number: nothing is made up
  FS.proto.claims = CLAIMS;
  assert.equal(pm.threatGone(FS, was).text, 'シンダーの旗は立たずに終わりました');
  // their banner rose after all: its own record tells it; the guide's list names the step by what happened
  FS = world().FS;
  assert.equal(pm.threatOutcome(FS, { ...was, tile: FOE }), 'rose');
  assert.equal(pm.stepName('answer', { outcome: 'rose' }), '敵の旗が立った');
  assert.equal(pm.stepName('answer', { outcome: 'stopped' }), '敵の旗を止めた');
  assert.equal(pm.stepName('answer', { outcome: 'ended' }), '敵の旗は立たなかった');
  FS.proto.guide = { threat: true, walked: false, answer: 'rose' };
  FS.proto.me = { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] };
  assert.match(text(protoHud.guideCard(FS)), /敵の旗が立った/);
  assert.doesNotMatch(text(protoHud.guideCard(FS)), /旗を守る/, 'a banner that rose is not ticked off as defended');
  setLang('en');
  FS = hamlet({ entries: [[1, 2, OPEN, 475]] });
  FS.proto.claims = { ...CLAIMS, numbers: { ...CLAIMS.numbers, FLOOR_ABROAD: 500 } };
  assert.equal(pm.threatGone(FS, was).text, 'Cinder’s host is down to 475. A banner here needs 500, so its count is gone');
});

test('the order card says what the rules forecast of an attack, in one line under the arrival', () => {
  const { FS } = world();
  const enemy = { ok: false, code: 'NotOpen', need: { why: 'enemy' } };
  assert.equal(text(protoHud.marchLine(FS, { arrive: 52, answer: enemy, forecast: { key: 'k', pending: true } })), '試作 到着：ターン 52・敵の軍勢が立っています。勝てば、このマスに立ちます 予測を計算しています…');
  let line = protoHud.marchLine(FS, { arrive: 52, answer: enemy, forecast: { key: 'k', ok: true, runs: 12, troops: { min: 0, max: 0, start: 100 }, fates: { Destroyed: 12 }, certain: true } });
  assert.equal(text(line), '試作 到着：ターン 52・敵の軍勢が立っています。勝てば、このマスに立ちます 予測：12回試して、このマスに残れた回はありません');
  assert.match(flat(line), /class="mc-proto no"/);
  line = protoHud.marchLine(FS, { arrive: 52, answer: enemy, forecast: { key: 'k', ok: true, runs: 12, troops: { min: 400, max: 480, start: 600 }, fates: { Stays: 12 }, certain: true } });
  assert.equal(text(line), '試作 到着：ターン 52・敵の軍勢が立っています。勝てば、このマスに立ちます 予測：12回試して、12回ともこのマスに残りました');
  assert.doesNotMatch(flat(line), /class="mc-proto no"/);
  assert.match(text(protoHud.marchLine(FS, { arrive: 52, answer: enemy, forecast: { key: 'k', ok: true, runs: 12, troops: { min: 0, max: 300, start: 500 }, fates: { Stays: 5, Destroyed: 7 }, certain: true } })), /予測：12回試して、このマスに残れたのは5回です$/);
  // a forecast that could not be made claims nothing; a place where a banner can rise says no forecast
  assert.equal(text(protoHud.marchLine(FS, { arrive: 52, answer: enemy, forecast: { key: 'k', ok: false, why: 'NoWasm' } })), '試作 到着：ターン 52・敵の軍勢が立っています。勝てば、このマスに立ちます');
  assert.doesNotMatch(text(protoHud.marchLine(FS, { arrive: 47, answer: { ok: true, tiles: [], trail: [], size: 9, price: 0, waitTurns: 1 }, forecast: { key: 'k', ok: true, runs: 12, fates: { Stays: 12 } } })), /予測/);
  assert.equal(flat(protoHud.forecastLine(null)), '');
  setLang('en');
  assert.match(text(protoHud.marchLine(FS, { arrive: 52, answer: enemy, forecast: { key: 'k', ok: true, runs: 12, fates: { Destroyed: 12 } } })), /Forecast: in none of 12 runs did your host hold the tile$/);
});

test('the guide\'s march on a phone: the widest place among the world\'s answers is one press; the page picks a number, it judges nothing', async () => {
  // the world's answers for every tile (the preview route with no tile)
  const all = [{ tile: 3, ok: false, code: 'NotSurveyed' }, { tile: 44, ok: true, size: 7, trail: [], steps: 5 }, { tile: 47, ok: true, size: 10, trail: [45, 44, 43], steps: 6 }, { tile: 48, ok: true, size: 10, trail: [46, 45], steps: 7 }, { tile: 50, ok: true, tiles: [1, 2, 3], steps: 2 }];
  assert.deepEqual(pm.widestPlace(all), { tile: 47, size: 10, steps: 6 }, 'the most tiles, then the nearest');
  assert.equal(pm.widestPlace([{ tile: 3, ok: false, code: 'NotSurveyed' }]), null);
  assert.equal(pm.widestPlace(null), null);
  assert.equal(orders.previewQuery({ host: '77', p: 1, q: 1 }), 'host=77&p=1&q=1', 'no tile: every tile of the province');
  assert.equal(orders.previewQuery({ host: '77', p: 1, q: 1, tile: 5 }), 'host=77&p=1&q=1&tile=5');
  // the request, through the controller, kept like any preview
  const asked = [];
  const { FS } = world({ me: { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }] } });
  for (const k of Object.keys(STORE)) delete STORE[k];
  Object.assign(STORE, FS);
  orders.configure({ fetch: async url => { asked.push(String(url)); return { ok: true, status: 200, json: async () => ({ ok: true, all }) }; } });
  orders.enable(true);
  let got = null;
  assert.equal(controller.wantPlaces({ host: String(id(9)), p: 2, q: -1 }, a => { got = a; }), undefined);
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(got, all); assert.match(asked[0], /\/h\/proto\/preview\?host=\d+&p=2&q=-1$/);
  assert.deepEqual(controller.wantPlaces({ host: String(id(9)), p: 2, q: -1 }), all, 'held: not asked twice');
  assert.equal(asked.length, 1);
  orders.configure({ fetch: (...a) => globalThis.fetch(...a) });
  // the bar's line: the button only for the host in hand, and only while the answer is of the settled turn the page holds
  STORE.proto.lands.set('2,-1', { ...land({ banners: false }), resolvedNext: 41 });
  select(STORE, OPEN, id(9));
  let m = hand.handModel(STORE);
  assert.match(text(m.note), /^試作 この州の旗は2本です。.+ 行き先のマスを押します：つぎの旗は、進軍した先に立てられます$/, 'no answer yet: the line alone');
  STORE.proto.marchBest = { host: String(id(9)), p: 2, q: -1, tile: 47, size: 10, r: 41 };
  m = hand.handModel(STORE);
  assert.match(flat(m.note), /<button type="button" class="btn small primary an-best" data-act="proto-march-best" data-p="2" data-q="-1" data-tile="47">/);
  assert.match(text(m.note), /いちばん広く取れるマスを選ぶ（\+10マス）$/);
  STORE.proto.marchBest = { ...STORE.proto.marchBest, r: 40 };
  assert.doesNotMatch(flat(hand.handModel(STORE).note), /an-best/, 'an answer of an older settled turn is not offered');
  STORE.proto.marchBest = { ...STORE.proto.marchBest, r: 41, host: '1' };
  assert.doesNotMatch(flat(hand.handModel(STORE).note), /an-best/, 'nor another host\'s');
  setLang('en');
  STORE.proto.marchBest = { host: String(id(9)), p: 2, q: -1, tile: 47, size: 10, r: 41 };
  assert.match(text(hand.handModel(STORE).note), /Pick the widest place \(\+10 tiles\)$/);
  const app = read('frontier/app.mjs');
  assert.match(app, /'proto-march-best': d => protoMarchBest\(\{ p: num\(d\.p\), q: num\(d\.q\), tile: num\(d\.tile\) \}\)/);
  assert.match(app, /const w = pm\.widestPlace\(all\);/, 'the page keeps the widest of the world\'s answers and nothing of its own');
});

test('the tile that was won is a step from the turn its clash is settled; a host formed for the walk is waited for, not trained again', () => {
  const all = { ...ME, walkPaidToday: true, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] };
  // the turn of the clash: the host is on the tile, and the world still says it is on the march
  let FS = world({ me: { ...all, hosts: [{ host: String(id(9)), p: 2, q: 0, tile: OPEN, unit: 0, raise: { ok: false, code: 'InTransit', need: null }, tend: [], dress: [] }] } }).FS;
  FS.proto.guide = { threat: true, walked: true, won: { p: 2, q: 0, tile: OPEN } };
  let g = pm.guideModel(FS);
  assert.equal(g.current, 'won'); assert.equal(g.title, '勝ち取ったマスに旗'); assert.equal(g.go, null);
  assert.equal(g.text, 'あなたの軍勢が、そのマスを押さえました。到着したターンの集計が済むと、旗の数えが始まります。');
  assert.equal(g.total, 8, 'the list does not shrink for that turn and grow again');
  // a host formed on banner land for the walk, taking its place
  const me = { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] };
  FS = world({ me: { ...me, hosts: [{ host: String(id(12)), p: 2, q: 0, tile: POLE, unit: 0, raise: { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 } }, tend: [{ slot: 0, ok: false, code: 'NotResident', need: null, paysToday: true }], dress: [] }] } }).FS;
  FS.holdings = [{ ...FS.holdings[0], reserve: [0, 0, 0, 0, 0, 0, 0, 0] }];
  assert.equal(pm.walkerSoon(FS).host, String(id(12)));
  g = pm.guideModel(FS);
  assert.equal(g.current, 'walk'); assert.equal(g.text, '見回りの軍勢が整列しています。整列がすむと、見回れます。');
  assert.deepEqual(g.go, { act: 'proto-guide', data: { go: 'host', host: String(id(12)) }, label: '軍勢を見る' }, 'not 訓練する: a host for the walk is forming already');
  // a host that walked the banner last (it may not walk it again) is no such host
  FS.proto.me = { ...me, hosts: [{ host: String(id(12)), p: 2, q: 0, tile: POLE, unit: 0, raise: null, tend: [{ slot: 0, ok: false, code: 'NotArrivedSince', need: { since: 43 }, paysToday: true }], dress: [] }] };
  assert.equal(pm.walkerSoon(FS), null); assert.equal(pm.guideModel(FS).go.label, '訓練する');
});

test('a phone: a standing threat\'s notice comes before the turn\'s own card; no card of the hand reaches the label; the reasons stay in sight', () => {
  const strip = [{ id: 'turn:50', markup: 'S' }], toasts = [{ id: 'n:a', alarm: false, markup: 'A' }, { id: 'n:th', alarm: true, markup: 'T' }, { id: 'n:b', alarm: false, markup: 'B' }];
  assert.deepEqual(feed.stackOrder(strip, toasts).map(x => x.id), ['turn:50', 'n:a', 'n:th', 'n:b'], 'a wide screen: as it was');
  assert.deepEqual(feed.stackOrder(strip, toasts, { alarmsFirst: true }).map(x => x.id), ['n:th', 'turn:50', 'n:a', 'n:b'], 'a phone shows one: the threat that stands');
  assert.deepEqual(feed.stackOrder([], [], { alarmsFirst: true }), []);
  const app = read('frontier/app.mjs'), css = read('frontier/proto-hand.css');
  assert.match(app, /feed\.stackOrder\(stripItem, toasts, \{ alarmsFirst: phone\(\) \}\)/);
  // the card of a host is brought clear of its card once the camera rests (a pan worked out in mid-flight left the pole under the HUD)
  assert.match(app, /whenStill\(\(\) => \{ if \(FS\.hand\?\.pop === 'banner'\) clearOfCard\(at\); \}\)/);
  // the label: no card of the hand may reach up to it on a phone (the training card stood over the chip and the guide's line)
  assert.match(css, /body\[data-proto="banners"\] \.hand-pop\[data-mode="card"\] \{ max-height: calc\(var\(--vvh\) - var\(--strip\) - 134px - var\(--tabs\) - var\(--hand-h, 130px\)\); \}/);
  assert.match(css, /body\[data-proto="banners"\] \.hand-pop\[data-pop="train"\] \.pop-line\.pop-why \{ display: block;/, 'why training cannot be ordered stays in sight (a hamlet short of stores)');
  // the line that says why the guide opened the training card stands first on it
  const me = { ...ME, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }, { p: 2, q: -1, slot: 0 }] };
  const FS = world({ me }).FS;
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 30 }; FS.hand = { host: null, pop: 'train', protoWhy: 'walk' };
  const card = flat(hand.renderPop(FS, hand.handModel(FS)));
  assert.ok(card.indexOf('旗の土地に新しく立った軍勢が見回れます') > 0 && card.indexOf('旗の土地に新しく立った軍勢が見回れます') < card.indexOf('class="unit-toks"'), 'before the list, not after the order');
  // a banner with no tile to add says what such a tile is (the record's own numbers)
  const W = world({ me: { ...ME, hosts: [{ host: String(id(10)), p: 2, q: 0, tile: POLE, unit: 0, raise: null, tend: [{ slot: 0, ok: true, paysToday: true }], dress: [{ slot: 0, tiles: [], code: null }] }] } }).FS;
  W.proto.claims = { ...CLAIMS, numbers: { ...CLAIMS.numbers, REACH: 2, DENY_FACTOR: 2 } };
  select(W, POLE, id(10)); W.hand.pop = 'banner';
  assert.match(text(hand.renderPop(W, hand.handModel(W))), /この軍勢のそばに、広げられるマスがありません。広げられるのは、旗の土地のとなりにある、斥候が調べた空きマスです（旗から2マスまで。敵の軍勢のとなりのマスは、その2倍の兵が要ります）/);
});

test('two marches of the viewer\'s into one province in one turn: said on the order card before the seal, and the page\'s own card names the next free turn', () => {
  const { FS } = world();
  FS.marches = [{ dest: { p: 1, q: 1, tile: 48 }, entry: { host: String(id(9)), arriveBell: 52 } }];
  assert.equal(pm.ownArrivalAt(FS, { p: 1, q: 1, tile: 35 }, 52), true, 'another tile of the same province, the same turn');
  assert.equal(pm.ownArrivalAt(FS, { p: 1, q: 1, tile: 35 }, 53), false);
  assert.equal(pm.ownArrivalAt(FS, { p: 2, q: 0, tile: 35 }, 52), false);
  assert.equal(pm.ownArrivalAt(FS, { p: 1, q: 1, tile: 35 }, 52, id(9)), false, 'the host\'s own march is not "another"');
  const enemy = { ok: false, code: 'NotOpen', need: { why: 'enemy' } }, wins = { key: 'k', ok: true, runs: 12, fates: { Stays: 12 } };
  // the player set the same turn: a warning, in the order card's own line
  let line = protoHud.marchLine(FS, { arrive: 52, answer: enemy, forecast: wins, crowd: true });
  assert.match(text(line), /ターン 52 には、あなたの別の軍勢もこの州に着きます。見本の世界では、同じターンにひとつの州へ着けるのは、ひとり1軍勢です。到着のターンを変えてください$/);
  assert.match(flat(line), /class="mc-proto-fc mc-proto-warn"/);
  // the page's own card moved it a turn on, and says why
  line = protoHud.marchLine(FS, { arrive: 53, answer: enemy, forecast: wins, shift: { from: 52, to: 53 } });
  assert.match(text(line), /^試作 到着：ターン 53・敵の軍勢が立っています。勝てば、このマスに立ちます 予測：12回試して、12回ともこのマスに残りました あなたの別の軍勢がターン 52 にこの州へ着くので、到着を1ターン遅らせてあります（見本の世界では、同じターンにひとつの州へ着けるのは、ひとり1軍勢です）$/);
  assert.doesNotMatch(text(protoHud.marchLine(FS, { arrive: 53, answer: enemy, forecast: wins })), /別の軍勢/);
  // a march for land carries it too
  assert.match(text(protoHud.marchLine(FS, { arrive: 52, answer: { ok: true, tiles: [], trail: [], size: 9, price: 0, waitTurns: 1 }, crowd: true })), /^試作 到着：ターン 52・旗はターン 55 から・\+9マス ターン 52 には、あなたの別の軍勢もこの州に着きます。/);
  const app = read('frontier/app.mjs');
  assert.match(app, /while \(b < w\.max && pm\.ownArrivalAt\(FS, to, b, row\.id\)\) b\+\+;/, 'composeTo: the next turn of the window that is free');
  assert.match(app, /c\.protoShift = \{ from: c\.arriveBell, to: b \}; c\.arriveBell = b;/);
  setLang('en');
  assert.match(text(protoHud.marchLine(FS, { arrive: 53, answer: enemy, shift: { from: 52, to: 53 } })), /Another host of yours arrives in this province on turn 52, so this one is set a turn later \(the sample world lets one host of a player into a province a turn\)$/);
});

test('the guide\'s march sends a host that has raised its banner before one that still has something to do where it stands', () => {
  const hosts = [
    { host: 'a', p: 2, q: 0, tile: 1, unit: 0, raise: { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 } }, onPole: { slot: 0, nation: 0, holder: '2,0,3' }, tend: [{ slot: 0, ok: true, paysToday: true }], dress: [] },
    { host: 'b', p: 2, q: 0, tile: 2, unit: 0, raise: { ok: false, code: 'SiteOrCamp', need: { why: 'site' } }, onPole: null, tend: [], dress: [] },
    { host: 'c', p: 2, q: 0, tile: 3, unit: 0, raise: { ok: false, code: 'PerProvince' }, onPole: null, tend: [{ slot: 0, ok: false, code: 'NotResident', need: null }], dress: [] },
    { host: 'd', p: 2, q: 0, tile: 4, unit: 0, raise: { ok: false, code: 'StandLonger', need: { tolls: 1, atTurn: 43 }, size: 5 }, onPole: null, tend: [], dress: [] },
    { host: 'e', p: 2, q: 0, tile: 5, unit: 0, raise: { ok: true, size: 5, tiles: [], trail: [], price: 0 }, onPole: null, tend: [], dress: [] },
    { host: 'f', p: 2, q: 0, tile: 6, unit: 0, raise: null, onPole: { slot: 1, nation: 2, holder: '2,0,7' }, tend: [], dress: [] },
  ];
  const FS = world({ me: { ...ME, hosts } }).FS;
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'zz'].map(x => pm.marchRank(FS, x)), [0, 1, 2, 2, 2, 1, 1], 'on its own pole first (even when it could walk a banner); forming for a walk, counting or able to raise last; another nation\'s pole is no reason');
  assert.match(read('frontier/app.mjs'), /\.sort\(\(a, b\) => pm\.marchRank\(FS, a\.id\) - pm\.marchRank\(FS, b\.id\) \|\| Number\(a\.troops\) - Number\(b\.troops\)\)\[0\]/);
});

test('a phone: the banner\'s own card is low too, and is one button while a tile is picked for the widening; a threat that is being answered offers no second host', () => {
  const W = world({ me: { ...ME, hosts: [{ host: String(id(10)), p: 2, q: 0, tile: POLE, unit: 0, raise: null, tend: [{ slot: 0, ok: true, paysToday: true }], dress: [{ slot: 0, tiles: [OPEN], code: null }] }] } }).FS;
  select(W, POLE, id(10)); W.hand.pop = 'banner';
  let card = flat(hand.renderPop(W, hand.handModel(W)));
  assert.match(card, /<p class="proto-brief proto-brief-own"><span class="pb-sub">あなたの旗（しっかり立っています・3日に1回の見回り）<\/span>/);
  assert.match(card, /<div class="proto-full"><p class="pop-line proto-line">あなたの旗（しっかり立っています・3日に1回の見回り）<\/p><\/div>/, 'a wide screen shows the lines as before (the brief line is a phone\'s)');
  W.hand.more = true;
  card = flat(hand.renderPop(W, hand.handModel(W)));
  assert.match(card, /<span class="pb-sub"><\/span>/); assert.match(card, /<div class="proto-full open">/);
  // the brief line is the most pressing one: a banner under threat says that, not what it is
  const T = world({ landRec: land({ contested: { nation: 2, host: '999', sinceTurn: 41, canTakeAtTurn: 68 } }), me: { ...ME, hosts: [{ host: String(id(10)), p: 2, q: 0, tile: POLE, unit: 0, raise: null, tend: [{ slot: 0, ok: true, paysToday: true }], dress: [] }] } }).FS;
  select(T, POLE, id(10)); T.hand.pop = 'banner';
  assert.match(flat(hand.renderPop(T, hand.handModel(T))), /<span class="pb-sub tone-bad">あなたの旗が狙われています。あと27ターン（約9分）で取られます<\/span>/);
  const css = read('frontier/proto-hand.css');
  assert.match(css, /\.hand-pop\[data-pop="banner"\] \.proto-full:not\(\.open\) ~ \.proto-note \{ display: none; \}/);
  assert.match(css, /\.hand-pop\[data-pick="dress"\] :is\(\.proto-brief, \.proto-full, \.proto-note, \[data-act="proto-tend"\], \[data-act="proto-strike-ask"\], \[data-act="proto-widen"\]\) \{ display: none; \}/);
  // the notice of a threat that a host of the viewer's is marching against: no second 軍勢を送る, and the turn it arrives
  const app = read('frontier/app.mjs');
  assert.match(app, /if \(at !== null\) return \{ \.\.\.x, send: null, text: \(FS\.nowBell \?\? 0\) < at \? L`\$\{up\.text\}。あなたの軍勢が向かっています（ターン \$\{fmtNum\(at\)\} に到着）` : L`\$\{up\.text\}。あなたの軍勢が着きました。戦いの結果を待っています` \};/, 'on its way until its turn; arrived, and waiting to be told, from then');
  const toast = x => text(feed.renderToast({ id: 'th:1', kind: 'proto', proto: true, alarm: true, bell: 50, p: 2, q: 0, tile: OPEN, text: 'T', ...x }));
  assert.match(toast({ send: { p: 2, q: 0, tile: OPEN } }), /軍勢を送る/);
  assert.doesNotMatch(toast({ send: null }), /軍勢を送る/);
});

test('a new village to the end of its guide: the place for the walk is banner land, an attack that lost is said with what it did, and the outcome leads on a phone', () => {
  // the muster card for the walk: land of the viewer's own banner is said as that, whatever else the world says of raising a banner there
  const { FS } = world();
  assert.equal(text(protoHud.placeLine(FS, { ok: false, code: 'SiteOrCamp', need: { why: 'camp' }, p: 2, q: 0, tile: PATCH[1] })), '試作 あなたの旗の土地です：ここに新しく立った軍勢は、この旗を見回れます');
  assert.equal(text(protoHud.placeLine(FS, { ok: false, code: 'SiteOrCamp', need: { why: 'camp' }, p: 2, q: 0, tile: OPEN })), '試作 ここでは旗を立てられません：野営地やそのとなりには旗を立てられません', 'open ground beside a camp is still refused in the rule\'s sentence');
  assert.equal(text(protoHud.placeLine(FS, { ok: false, code: 'SiteOrCamp', need: { why: 'camp' }, p: 2, q: 0, tile: FOE_PATCH[1] })), '試作 ここでは旗を立てられません：野営地やそのとなりには旗を立てられません', 'another nation\'s banner land is not the viewer\'s');
  const app = read('frontier/app.mjs');
  // the walk step names a tile of that land on the card it opens (the card opened on the village's own tile: a host formed there with one press could walk nothing)
  assert.match(app, /const at = own\.flatMap\(b => b\.tiles\.filter\(t => t !== b\.tile && free\.has\(t\) && !taken\.has\(t\)\)\)\[0\];\s+if \(Number\.isInteger\(at\)\) \{ FS\.hand = \{ \.\.\.FS\.hand, tile: at \};/);
  // the guide's march in the first minute of a turn takes the host in hand all the same, with the reason on the map
  assert.match(app, /if \(selectHost\(at, \{ fly: true \}\)\) frameMarchGround\(at\);\s+mapNote\(\{ p: at\.p, q: at\.q, idx: at\.tile \}, \(\) => lag\.text\);/);
  // the viewer attacked, lost, and thinned the host below the floor: all of it in one line
  const was = { id: 'rf:2,0,999:44', kind: 'rise', p: 2, q: 0, tile: OPEN, nation: 2, left: 5, done: false, text: '' };
  const H = hamlet({ entries: [[1, 2, OPEN, 474]] });
  H.proto.claims = { ...CLAIMS, numbers: { ...CLAIMS.numbers, FLOOR_ABROAD: 500 } };
  H.nowBell = 61; H.marches = [{ dest: { p: 2, q: 0, tile: OPEN }, entry: { host: String(id(9)), arriveBell: 59 } }];
  const line = pm.threatGone(H, was);
  assert.equal(line.tried, true);
  assert.equal(line.text, 'あなたの軍勢は、そのマスを取れませんでした。それでも、シンダーの軍勢は474人に減りました。ここに旗を立てるには500人が要るので、旗の数えは消えました');
  H.marches = [{ dest: { p: 2, q: 0, tile: OPEN }, entry: { host: String(id(9)), arriveBell: 63 } }];
  assert.equal(pm.threatGone(H, was).tried, false, 'a march that has not arrived is no attempt');
  // on a phone the line of what became of the threat leads the stack, as the threat's notice did
  assert.match(app, /news\.push\(\{ \.\.\.line, own: true, lead: true \}\);/);
  assert.match(app, /alarm: \(!!x\.alarm && !!standing\?\.has\(x\.id\)\) \|\| !!x\.lead,/);
  // the standing notice of a threat the viewer is outnumbered by carries the numbers
  assert.match(app, /return force && force\.best < up\.foe\.troops \? \{ \.\.\.x, text: L`\$\{up\.text\}。\$\{pm\.threatNumbers\(up, force\)\}数で下回っています` \} : \{ \.\.\.x, text: up\.text \};/);
  setLang('en');
  assert.equal(pm.threatGone(Object.assign(H, { marches: [{ dest: { p: 2, q: 0, tile: OPEN }, entry: { host: '1', arriveBell: 59 } }] }), was).text, 'Your host did not take the tile. All the same, Cinder’s host is down to 474. A banner here needs 500, so its count is gone');
});

test('English on a phone and at 1440: nothing of the prototype is cut off, and the sample world\'s tag ends before the dial\'s bell', () => {
  const css = read('frontier/proto-hand.css');
  // the guide's line on a phone: the step's name under the guide's own (side by side it was cut to a letter or two)
  assert.match(css, /\.proto-strip \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto; grid-template-rows: auto auto;/);
  assert.match(css, /\.proto-strip \.ps-k \{ grid-column: 2; grid-row: 1;/); assert.match(css, /\.proto-strip \.ps-t \{ grid-column: 2; grid-row: 2;/); assert.match(css, /\.proto-strip \.ps-do \{ grid-column: 3; grid-row: 1 \/ 3;/);
  // the sample tag: smaller and on two lines when it must, wherever the prototype is on; in English with it off too
  // (rewritten at the merge of 2026-10-11: the old width, `+ 22px`, ended the tag before the dial's BELL but let it
  // slide 16 px under the dial's rim, which the kept place of the loss pass forbids (nothing of the page meets the
  // tag: the browser test "the kept place @ 390" failed on the merged page). `- 2px` ends it 8 px before the dial's
  // left edge, which is before the bell too; the two lines and the scope are as they were.)
  assert.match(css, /:is\(body\[data-proto="banners"\], html\[lang="en"\] body\) \.sample-tag \{ display: block; max-width: calc\(50vw - var\(--edge\) - var\(--target\) - 2px\);/);
  assert.match(css, /:is\(body\[data-proto="banners"\], html\[lang="en"\] body\) \.sample-tag > span \{ display: inline-block; white-space: nowrap; \}/);
  // the bar's first button in English, the resting sheet's plate line, the top bar's prompt: each scoped to the prototype's own pieces
  assert.match(css, /html\[lang="en"\] \.hand-btn\.hand-proto \.hand-word \{ white-space: normal;/);
  assert.match(css, /html\[lang="en"\] \.panel\[data-sheet="peek"\] \.plate-proto \{ flex-wrap: wrap; white-space: normal;/);
  assert.match(css, /html\[lang="en"\] body\[data-proto="banners"\] \.next-btn\[data-next="guide"\] \.next-kicker \{/);
  assert.doesNotMatch(css, /^html\[lang="en"\] \.next-btn\[data-next="guide"\]/m, 'the basic game\'s own guide in the top bar is not restyled');
  // every rule of this sheet that is not about a piece only the prototype draws is scoped to the prototype being on, or to English
  const basics = [...css.matchAll(/^\s*([^{}@/][^{}]*)\{/gm)].map(m => m[1].trim()).filter(sel => /(^|[\s,>~+])(\.feed|\.sample-tag|\.hand-pop\[data-mode|\.hand-pop\[data-pop="(train|muster)"\]|#hand)\b/.test(sel));
  for (const sel of basics) assert.match(sel, /data-proto="banners"|proto-|html\[lang="en"\]/, `scoped: ${sel}`);
  setLang('en');
  assert.equal(pm.stepName('march'), 'Banner after the march'); assert.equal(pm.stepName('won'), 'Banner on the won tile');
  const all = { ...ME, walkPaidToday: true, banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 3 }] };
  const FS = world({ me: all }).FS;
  FS.marches = [{ dest: { p: 2, q: -1, tile: 5 }, entry: { host: '1', arriveBell: 40 } }];
  assert.equal(pm.guideModel(FS).title, 'Arrived: the turn is being resolved');
  // no English of the prototype's guide is longer than the two-line strip and the top bar's prompt were measured for
  for (const id of pm.GUIDE_STEPS) assert.ok(pm.stepName(id).length <= 24, `${id}: ${pm.stepName(id)}`);
});

// ------------------------------------------------------------------ the orders through the controller
test('an order of the prototype: sent to the sample world only, answered in the rule\'s sentence, kept for this turn\'s list', async () => {
  const keep = { proto: STORE.proto, citizen: STORE.citizen, holdings: STORE.holdings, provinces: STORE.provinces, orders: STORE.orders, notice: STORE.notice, nowBell: STORE.nowBell, clock: STORE.clock, chain: STORE.chain };
  const realFetch = globalThis.fetch;
  const { FS } = world({ landRec: land({ rising: rising(41) }) });
  const posts = [];
  try {
    Object.assign(STORE, { proto: FS.proto, citizen: FS.citizen, holdings: FS.holdings, provinces: FS.provinces, orders: [], notice: null, nowBell: 42, clock: { genesisTs: 1_000 - 42 * 600 - 300 }, chain: FS.chain });
    orders.enable(true); setRelay('http://h/gw');
    let answer = { ok: false, code: 'StandLonger', error: 'StandLonger: the host has not stood here long enough', need: { tolls: 2, atTurn: 43 }, tiles: [1, 2, 3], size: 3, atTurn: 43 };
    globalThis.fetch = async (url, init = {}) => { posts.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => answer }; };
    const r = await controller.ACTIONS['proto-raise']({ host: String(id(9)), p: '2', q: '0', min: '9', max: '8' });
    assert.equal(posts[0].url, 'http://h/gw/f/proto/land');
    assert.deepEqual(posts[0].body, { op: 'raise', province: [2, 0], p: 2, q: 0, host: String(id(9)), minTiles: 9, maxWorks: 8 });
    assert.equal(r, undefined);
    assert.equal(STORE.notice.ok, false);
    assert.equal(STORE.notice.text(), 'あと2ターン立たせてください');
    assert.deepEqual({ kind: STORE.orders[0].kind, state: STORE.orders[0].state, code: STORE.orders[0].code, why: STORE.orders[0].why, tile: STORE.orders[0].tile }, { kind: 'banner-raise', state: 'refused', code: 'StandLonger', why: 'あと2ターン立たせてください', tile: { p: 2, q: 0, tile: OPEN } });
    assert.deepEqual(turnlist.turnModel(STORE, {}).orders.map(o => `${o.text} / ${o.why}`), ['試作：旗を立てる命令は送られていません / あと2ターン立たせてください']);
    // accepted: the page says only that the order was given; the land changes when the record comes
    answer = { ok: true, track: 'proto-1', landMs: 1, op: 'TEND', turn: 41, note: null };
    const ok = await controller.ACTIONS['proto-tend']({ host: String(id(10)), p: '2', q: '0', slot: '0' });
    assert.equal(ok.ok, true);
    assert.deepEqual(posts[1].body, { op: 'tend', province: [2, 0], p: 2, q: 0, host: String(id(10)), slot: 0 });
    assert.equal(STORE.notice.text(), '旗の見回りを命じました（試作）');
    assert.deepEqual(turnlist.turnModel(STORE, {}).orders.map(o => o.text), ['試作：旗を立てる命令は送られていません', '試作：旗の見回りを命じました']);
    assert.equal(STORE.proto.me.tiles, 16, 'nothing of the land changed by the answer');
    await controller.ACTIONS['proto-strike']({ p: '2', q: '0', slot: '0' });
    assert.deepEqual(posts[2].body, { op: 'strike', province: [2, 0], p: 2, q: 0, slot: 0, reason: 'own' });
    // the day's limit of explorations is answered on the basic game's own route: the notice says it in the rule's sentence (the prototype is on)
    const src = read('frontier/controller.mjs');
    assert.match(src, /if \(FS\.proto && r && !r\.text && pm\.REFUSALS\.includes\(r\.code\)\) return setNotice\(\{ ok: false, \.\.\.r, text: \(\) => pm\.refusalText\(r\.code, \{ need: r\.need \}\) \}\);/);
    assert.ok(pm.REFUSALS.includes('ExploreLimit'));
    // off: nothing leaves
    STORE.proto = null; orders.enable(false);
    await controller.ACTIONS['proto-raise']({ host: '1', p: '2', q: '0', min: '1', max: '0' });
    assert.equal(posts.length, 3);
    assert.equal(STORE.notice.text(), '旗の試作は、この世界では動いていません');
  } finally { globalThis.fetch = realFetch; Object.assign(STORE, keep); orders.enable(false); setRelay(''); await new Promise(r => setTimeout(r, 0)); }
});

// ------------------------------------------------------------------ for the board
test('the board\'s model: the records as served, and who is looking', () => {
  const { FS } = world();
  const m = pm.boardModel(FS);
  assert.deepEqual(Object.keys(m).sort(), ['label', 'lands', 'me', 'nation', 'own', 'ownHost', 'rule', 'standings', 'turn', 'turnSecs', 'version']);
  assert.equal(m.label, LABEL.ja); assert.equal(m.rule, 'standing-ground'); assert.equal(m.nation, 0); assert.equal(m.turn, 42); assert.equal(m.turnSecs, 20);
  assert.equal(m.lands, FS.proto.lands); assert.equal(m.me, ME); assert.ok(m.own.has('2,0,0') && !m.own.has('2,0,1'));
  assert.equal(m.ownHost(String(id(9))), true); assert.equal(m.ownHost('999'), false);
  // what a tile is
  const rec0 = FS.proto.lands.get('2,0');
  assert.deepEqual(pm.kindAt(rec0, 30), { kind: 'village', site: 3 });
  assert.equal(pm.kindAt(rec0, POLE).kind, 'banner'); assert.equal(pm.kindAt(rec0, POLE).slot, 0);
  assert.deepEqual(pm.kindAt(rec0, OPEN), { kind: 'open' });
  assert.deepEqual([...NO_GO.map(x => x[0])].filter(x => x.startsWith('proto')), ['proto-chip', 'proto-chip-map', 'proto-score'], 'the map keeps its labels out of the chip (the page\'s, or its own where the page shows none) and the score');
});

// ------------------------------------------------------------------ the truth of the words
test('the truth of the words: territory only for the prototype\'s score, no chain record claimed, British spelling', () => {
  const dict = EN_GROUPS['frontier-proto-hand'];
  assert.ok(Object.keys(dict).length > 150);
  for (const [ja, en] of Object.entries(dict)) {
    const t = typeof en === 'function' ? `${en(1, 1, 1)} ${en(2, 2, 2)}` : en;
    // 領土 / territory: the score's two lines only (village land and banner land, under the chip)
    if (/領土/.test(ja) || /territor/i.test(t)) assert.ok(['領土の得点', '領土の得点（試作）：{0}'].includes(ja), ja);
    // a chain is named only to say nothing goes there
    if (/チェーン/.test(ja) || /\bchain\b/i.test(t)) { assert.match(ja, /チェーンには何も送りません/); assert.match(t, /nothing is sent to a chain/i); }
    assert.doesNotMatch(t, /on chain|recorded|chain record/i, ja);
    assert.doesNotMatch(t, /\b(color|center|favor|honor|defense|neighbor)\b/i, `British spelling: ${t}`);
    assert.equal(EN[ja], en);
  }
  // "your land" / あなたの土地 is said of village land and banner land only: all of it in the prototype's own files
  const files = dir => readdirSync(new URL(dir, WEB), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(`${dir}${e.name}/`) : e.name.endsWith('.mjs') ? [`${dir}${e.name}`] : []));
  const OWN = new Set(['frontier/hud/proto.mjs', 'frontier/proto/hand-model.mjs']);
  // (the conquest client names 領土 where the chain's keeps and control decide it, and the arrival-control development world
  // where its own record does: those files may say 領土, never the prototype's "your land")
  const AUTHORITATIVE = new Set(['frontier/fi18n.mjs', 'frontier/controller.mjs', 'frontier/app.mjs', 'frontier/screens/onboarding.mjs', 'frontier/screens/territory.mjs', 'frontier/screens/conquest.mjs', 'frontier/screens/shell.mjs', 'frontier/hud/drawer.mjs']);
  for (const f of files('frontier/')) if (!OWN.has(f)) assert.doesNotMatch(read(f), AUTHORITATIVE.has(f) ? /L`[^`]*(あなたの土地 |あなたの名で)/ : /L`[^`]*(領土|あなたの土地 |あなたの名で)/, f);
  // and those files draw only under the switch: every exported renderer of hud/proto.mjs starts from FS.proto
  const src = read('frontier/hud/proto.mjs');
  for (const name of ['chipText', 'plateLines', 'bannerButton', 'bannerPop', 'placeLine', 'marchLine', 'ticker', 'provinceCard', 'tileCard', 'legend', 'exploreLine', 'guideNext', 'guideCard', 'turnItems']) {
    const at = src.search(new RegExp(`export (function ${name}\\(|const ${name} = )`));
    assert.ok(at >= 0, name);
    assert.match(src.slice(at, at + 420), /FS\.proto/, `${name} asks the switch first`);
  }
});

// ------------------------------------------------------------------ from the last play-through (the basic game's own words, with or without the prototype)
test('the harvest button says what an hour brings when nothing waits to be settled; an exploration\'s result is named by its true turn', async () => {
  const { exploreResultTurn, exploreResultWords } = await import('../../permutation-server/web/frontier/hud/orderparts.mjs');
  const { seasonClock } = await import('../../permutation-server/web/frontier/clock.mjs');
  const dialcard = await import('../../permutation-server/web/frontier/hud/dialcard.mjs');
  const { FS } = world({ proto: false });
  // right after any order the stores are settled: nothing has grown, and "+0" read as a dead button
  FS.chain = { now: () => 0 };
  let b = select(FS, 30).buttons.find(x => x.id === 'harvest');
  assert.equal(b.figure, '毎時 +186', 'the sum of what the stores gain in an hour (60 + 45 + 30 + 22 + 22 + 7, a town\'s base, each as the strip rounds it)');
  assert.match(b.hint, /いまは納めるものがありません（命令のたびに蔵は納められます）。蔵は毎時 \+186 増えています/);
  FS.chain = { now: () => 3_600 };
  b = select(FS, 30).buttons.find(x => x.id === 'harvest');
  assert.equal(b.figure, '+186', 'an hour later: what has grown, as before');
  // the result of an Explore of turn b is drawn from that turn's own seed: readable a window and a margin after the turn ends
  const clock = seasonClock(SEASON), turn = 42;
  const got = exploreResultTurn({ clock, nowBell: turn }, turn);
  const W = clock.window(turn), M = clock.margin;
  assert.equal(got, Math.floor(((turn + 1) * 600 + W + M) / 600), 'the turn in which that moment falls');
  assert.ok(got >= turn + 1, 'never the turn it was sent in');
  assert.equal(exploreResultWords(got), `結果はターン ${got} のはじめに出ます`);
  assert.equal(exploreResultTurn({ nowBell: 42 }, 42), null, 'without the season\'s clock no turn is named');
  assert.equal(exploreResultWords(null), '結果は、探索したターンの決着のあとに出ます');
  // the Scout's card, the order's line and this turn's list say it; none says "after the next bell" any more
  FS.clock = clock; FS.nowBell = turn; FS.chain = { now: () => clock.genesisTs + turn * 600 + 10 };
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 30 }; FS.hand = { host: String(id(8)), pop: 'explore' };
  assert.match(text(hand.renderPop(FS, hand.handModel(FS))), new RegExp(`結果はターン ${got} のはじめに出ます。`));
  assert.equal(turnlist.orderText(FS, { kind: 'explore', tiles: [1, 2], resultTurn: got }), `斥候を探索に出しました（2 マス）— 結果はターン ${got} のはじめに出ます`);
  for (const f of ['frontier/hud/hand.mjs', 'frontier/hud/turnlist.mjs', 'frontier/hud/dialcard.mjs', 'frontier/controller.mjs']) assert.doesNotMatch(read(f), /L`[^`]*結果は(次の)?鐘のあと/, f);
  // the dial's card speaks of it at the toll that brings it, not a toll sooner
  FS.holdings[0].explore = { state: 1, bell: turn, p: 2, q: 0 };
  assert.deepEqual(dialcard.nextBellItems(FS).filter(x => x.icon === 'scout').length, got === turn + 1 ? 1 : 0);
  FS.nowBell = got - 1;
  assert.deepEqual(dialcard.nextBellItems(FS).filter(x => x.icon === 'scout').map(x => x.text), ['探索の結果が、次のターンのはじめに出ます']);
});
