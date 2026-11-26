// loop-play2 (2026-11-18) B10 and B11.
//   B10: a host that had arrived was missing from the Hosts list until its seal was opened (it is in no province
//        record the page holds until then), while the list showed the other hosts and said nothing of it.
//   B11: the notices kept the words of the language they were made in: after 日本語 was pressed the list still said
//        "Turn 85 in brief: 1 keep" while everything around it switched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { setLang, lang, inEachLang, L } from '../../permutation-server/web/lang.mjs';
import * as hostScreen from '../../permutation-server/web/frontier/screens/host.mjs';
import * as FEED from '../../permutation-server/web/frontier/hud/feed.mjs';
import * as W from '../../permutation-server/web/frontier/hud/words.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const FIX = new URL('fixtures/frontier/', import.meta.url);
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('season.json', FIX), 'utf8')).bytes_b64, 'base64'));
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }), { seasonId: 1 });
const flat = x => [x].flat(Infinity).map(String).join('');
const text = x => flat(x).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const JP = /[぀-ヿ㐀-鿿]/;
const inLang = (l, fn) => { const was = lang(); setLang(l); try { return fn(); } finally { setLang(was); } };

// ------------------------------------------------------------------ B10
const id = (seq, site = 3) => hostId({ p: 2, q: 0, site, gen: 1, seq });
/** A village at (2,0) site 3 with hosts 7 and 8 in its province record (as web-frontier-cards.test.mjs builds it). */
function world() {
  const holding = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, FINAL_TS: 0, RESERVE: [400, 0, 0, 0, 0, 0, 100, 0],
    STORES: [1220, 815, 662, 305, 122, 90, 40, 20].map(v => ({ VALUE: BigInt(v * 1000), RATE: 0n, CAP: BigInt(6_000_000), T0: 0n })) });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 41, SITE_COUNT: 1, SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n, SITE_MIRROR: [{ STATE: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: id(7), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600_000, STAMINA_VALUE: 112, STAMINA_BELL: 42, READY_BELL: 0 },
      { ID: id(8), FACTION: 0, UNIT: 6, TILE: 30, STATE: 1, TROOPS: 100_000, STAMINA_VALUE: 120, STAMINA_BELL: 42, READY_BELL: 0 }] });
  return { mode: 'play', tab: 'host', season: SEASON, nowBell: 42, chain: { now: () => 1_000 }, citizen: { faction: 0, vigilStartMin: 0, exploresFloorLeft: 3 }, land: { stage: 'final' },
    holdings: [holding], provinces: new Map([['2,0', { province }]]), view: { fog: true }, ui: { dismissed: ['onboarding'] }, marches: [], chronicle: [], incoming: [], feed: [] };
}

test('B10: a host that has arrived and is in no province record is still shown, as away (Marches), beside the hosts that are listed', () => {
  for (const l of ['ja', 'en']) inLang(l, () => {
    const FS = world();
    assert.equal(hostScreen.hostRows(FS).length, 2, 'the two hosts at home are listed');
    // the loop-play2 case: host 9 arrived on turn 40 (the page is at 42) and its seal is not open yet
    FS.marches = [{ entry: { host: String(id(9)), state: 'landed', arriveBell: 40 }, transit: null, facts: { pipeline: 'arrived' }, dest: { p: 2, q: 0, tile: 31 } }];
    assert.deepEqual(hostScreen.awayHosts(FS), [{ id: String(id(9)), dest: { p: 2, q: 0, tile: 31 }, arrive: 40 }]);
    const out = flat(hostScreen.render(FS));
    assert.match(out, /<div class="vcard hosts-away" role="status" data-hosts-away="1">/);
    assert.match(out, new RegExp(`data-away-host="${id(9)}"`));
    assert.match(out, /hosts-away[\s\S]*data-act="tab" data-tab="marches"/, 'the way to Marches');
    assert.equal((out.match(/class="vcard host-card/g) ?? []).length, 2, 'the listed hosts are as before');
    if (l === 'en') {
      assert.match(text(out), /1 more host is away on a march\. It is not in this list until its arrival is read\. See Marches for its arrival and result\./);
      assert.match(text(out), /Arrived \(turn 40\)\. See Marches for the result/);
      assert.doesNotMatch(text(out.split('hosts-away')[1]), JP, 'no Japanese in the English lines');
    } else {
      assert.match(text(out), /ほかに 1 の軍勢が進軍に出ています。到着が読めるまで、この一覧には出ません。到着と結果は「進軍」で確かめられます。/);
      assert.match(text(out), /到着しました（ターン 40）。結果は「進軍」で確かめられます/);
    }
    // still on the road: said as due
    FS.marches = [{ entry: { host: String(id(9)), state: 'landed', arriveBell: 45 }, transit: null, facts: null, dest: null }];
    assert.match(text(hostScreen.render(FS)), l === 'en' ? /A host on the march Due to arrive on turn 45/ : /進軍中の軍勢 ターン 45 に到着の予定/);
    // two marches: counted, each once
    FS.marches = [{ entry: { host: String(id(9)), arriveBell: 40 } }, { entry: null, transit: { hostId: id(10), arriveBell: 44 } }, { entry: { host: String(id(9)), arriveBell: 40 } }];
    assert.match(flat(hostScreen.render(FS)), /data-hosts-away="2"/);
    if (l === 'en') assert.match(text(hostScreen.render(FS)), /2 more hosts are away on a march\. They are not in this list/);
  });
});

test('B10: no away line for a march whose host IS listed, for another village\'s march, or with no march', () => {
  const FS = world();
  assert.doesNotMatch(flat(hostScreen.render(FS)), /hosts-away/, 'no march');
  // (a host with a row — one on the march that a province record still holds — is told by its own card)
  FS.marches = [{ entry: { host: String(id(7)), arriveBell: 44 } }];
  assert.deepEqual(hostScreen.awayHosts(FS), []);
  assert.doesNotMatch(flat(hostScreen.render(FS)), /hosts-away/);
  // another village's host (site 4): not this list's
  FS.marches = [{ entry: { host: String(id(9, 4)), arriveBell: 40 } }];
  assert.deepEqual(hostScreen.awayHosts(FS), []);
  assert.doesNotMatch(flat(hostScreen.render(FS)), /hosts-away/);
  // with no row at all the screen keeps its own line (round 43), and adds nothing
  const empty = world();
  empty.provinces.get('2,0').province.entries = [];
  empty.marches = [{ entry: { host: String(id(9)), arriveBell: 40 } }];
  const out = flat(hostScreen.render(empty));
  assert.match(text(out), /あなたの軍勢は進軍に出ています。到着と結果は「進軍」で確かめられます。/);
  assert.doesNotMatch(out, /hosts-away/);
});

// ------------------------------------------------------------------ B11
const snap = (o = {}) => ({ bell: 85, now: 0, keeps: new Map(), territory: new Map(), territoryKnown: new Set(), territorySeen: new Set(), marches: new Map(), builds: new Set(),
  pendingBuilds: new Set(), holdings: new Map(), clashes: new Set(), fights: new Map(), explored: new Map(), incoming: new Set(), ...o });
const taken = { kind: 'keep_taken', seq: 1, p: -2, q: 4, from: 1, to: 0, bell: 83, side: 'gain' };
const news = () => FEED.diffFeed(snap(), snap({ keeps: new Map([['keep_taken:1', taken]]), incoming: new Set(['86,2,0']) }));

test('B11: inEachLang says a thunk in every language and puts the language in hand back (also when it throws)', () => {
  inLang('en', () => {
    assert.deepEqual(inEachLang(() => L`閉じる`), { ja: '閉じる', en: 'Close' });
    assert.equal(lang(), 'en');
    assert.throws(() => inEachLang(() => { throw new Error('x'); }), /x/);
    assert.equal(lang(), 'en', 'put back after a throw');
  });
  assert.equal(lang(), 'ja');
});

test('B11: every notice diffFeed makes carries its words in every language, the facts of the moment it was made', () => {
  const items = inLang('en', news);
  assert.deepEqual(items.map(x => x.id), ['kp:keep_taken:1', 'in:86,2,0']);
  for (const x of items) {
    assert.equal(typeof x.text, 'string');
    assert.equal(x.text, x.words.en, 'text: the words of the language it was made in');
    assert.match(x.words.ja, JP);
    assert.doesNotMatch(x.words.en, JP);
  }
  // the loop-play2 lines, in both languages (the wording of each language as it was)
  assert.match(items[0].words.en, /took the keep of Province -2,4 from .+ \(turn 83\)/);
  assert.match(items[0].words.ja, /^州 -2,4 の砦を .+ が .+ から奪った（第83ターン）$/);
  assert.match(items[1].words.ja, /^ターン 86 に、.+へ敵が来るかもしれません$/);
  // made in Japanese: the same words
  const ja = news();
  assert.deepEqual(ja.map(x => x.words), items.map(x => x.words));
  assert.deepEqual(ja.map(x => x.text), items.map(x => x.words.ja));
});

test('B11: the list, the cards over the map and the turn\'s own list show a notice in the language in hand after a switch', () => {
  const feed = FEED.pushFeed([], inLang('en', news), 0);
  const sum = inLang('en', () => FEED.bellSummary(feed.map(x => ({ ...x, bell: 85 })), 85));
  assert.equal(sum.text, sum.words.en);
  assert.equal(sum.text, 'Turn 85 in brief: 1 attack warning · 1 keep');
  assert.equal(sum.words.ja, 'ターン 85 のまとめ：来襲の恐れ 1 · 砦 1');
  const all = FEED.pushFeed(feed, [sum], 0);
  // switched to Japanese (the loop-play2 case): no English is left in the notices
  const centre = text(FEED.renderCentre(all));
  assert.match(centre, /ターン 85 のまとめ：来襲の恐れ 1 · 砦 1/);
  assert.match(centre, /州 -2,4 の砦を .+ から奪った（第83ターン）/);
  assert.doesNotMatch(centre, /Turn 85 in brief|took the keep|attack warning/i);
  const toasts = text(FEED.renderToasts(all, { now: 1 }));
  assert.match(toasts, /州 -2,4 の砦を/);
  assert.doesNotMatch(toasts, /took the keep/);
  const strip = text(FEED.renderTurnStrip({ turn: 85, items: [{ ...all.find(x => x.id === 'kp:keep_taken:1'), kind: 'battle' }] }));
  assert.match(strip, /州 -2,4 の砦を/);
  // and back to English
  inLang('en', () => {
    const en = text(FEED.renderCentre(all));
    assert.match(en, /Turn 85 in brief: 1 attack warning · 1 keep/);
    assert.match(en, /took the keep of Province -2,4/);
    assert.doesNotMatch(en.replace(/州/g, ''), /まとめ|奪った|敵が来る/);
  });
  // a notice without words (an older one, or one from a producer that has none) keeps its text
  assert.equal(W.noticeText({ text: 'x' }), 'x');
  // the prototype's line says 試作 in the language in hand around the words in that language
  inLang('en', () => assert.doesNotMatch(FEED.lineText({ proto: true, text: 'あ', words: { ja: 'あ', en: 'a' } }), JP));
});

test('B11: worded / said / reworded', () => {
  const two = inLang('en', () => W.worded(() => [{ id: 'a', text: L`閉じる` }, null, { id: 'b', n: 1 }]));
  assert.deepEqual(two, [{ id: 'a', text: 'Close', words: { ja: '閉じる', en: 'Close' } }, null, { id: 'b', n: 1 }]);
  assert.deepEqual(W.worded(() => ({ id: 'c', text: L`閉じる` })), { id: 'c', text: '閉じる', words: { ja: '閉じる', en: 'Close' } });
  assert.equal(W.worded(() => null), null);
  // (a function that does not give the same notices in every language: the words are not guessed)
  let n = 0;
  assert.deepEqual(W.worded(() => [{ id: `x${n++}`, text: 't' }]), [{ id: 'x0', text: 't' }], 'the run in the language in hand (ja here), without words');
  assert.deepEqual(inLang('en', () => W.said(() => L`閉じる`)), { text: 'Close', words: { ja: '閉じる', en: 'Close' } });
  const x = { id: 'a', text: '閉じる', words: { ja: '閉じる', en: 'Close' } };
  assert.equal(W.reworded(x), x, 'already in the language in hand');
  inLang('en', () => assert.deepEqual(W.reworded(x), { ...x, text: 'Close' }));
});

test('B11: every producer of the notices keeps its words (the source says it)', () => {
  const app = src('app.mjs'), feed = src('hud/feed.mjs'), pm = src('proto/hand-model.mjs'), own = src('map/ownclash.mjs'), stage = src('fx/stage.mjs');
  assert.match(feed, /export const diffFeed = \(prev, next\) => worded\(\(\) => diffFeedNow\(prev, next\)\);/);
  assert.match(feed, /export const bellSummary = \(feed, bell\) => worded\(\(\) => bellSummaryNow\(feed, bell\)\);/);
  assert.match(feed, /<span class="toast-text">.*\$\{noticeText\(x\)\}/);
  assert.match(feed, /<span class="turn-text">\$\{noticeText\(x\)\}<\/span>/);
  assert.match(feed, /export const lineText = x => \(x\.proto \? L`試作：\$\{noticeText\(x\)\}` : noticeText\(x\)\);/);
  assert.match(pm, /item: worded\(\(\) => newsOf\(FS, r\)\)/, 'the prototype\'s record lines');
  assert.match(app, /const now = worded\(\(\) => pm\.threatsOf\(FS\)\);/, 'the threats');
  assert.match(app, /text: t\.text, \.\.\.\(t\.words \? \{ words: t\.words \} : \{\}\),/);
  assert.match(app, /const line = worded\(\(\) => pm\.threatGone\(FS, was\)\);/, 'what became of a threat');
  assert.match(app, /item = \{ \.\.\.item, tile: tile\.idx, \.\.\.said\(\(\) => \{/, 'a battle told from its report');
  assert.match(app, /item = \{ \.\.\.item, quiet: true, tile: scene\.tiles\[0\]\?\.idx \?\? null, \.\.\.said\(\(\) => L`/);
  assert.match(own, /\.\.\.said\(\(\) => ownClashText\(fs, \{ p, q, bell \}, part\)\)/, 'the own clash line of the keep board');
  assert.match(stage, /\.\.\.\(x\.words \? \{ words: x\.words \} : \{\}\)/, 'the turn\'s own results carry them to the strip');
  // on a switch every kept notice follows its words (the away notices are worded again from their items, as before)
  assert.match(app, /: reworded\(x\)\)\); \};/);
  assert.match(app, /onLangChange\(\(\) => \{ reword\(\); try \{ renderFeed\(\); \}/);
});

// ------------------------------------------------------------------ B11 round 2 (verify-pr63 R1)
// A standing threat's notice in a banner-prototype world is drawn with live words (app.mjs protoAlarmNow →
// proto/hand-model.mjs alarmNow): the count as it is now, "your host is on its way", "outnumbered". Round 1 kept the
// words the notice was told with, and renderToast drew those over the live text.
import * as pm from '../../permutation-server/web/frontier/proto/hand-model.mjs';
import { CLAIM } from '../../permutation-server/web/frontier/proto/board-model.mjs';
const HOME = { p: 2, q: 0, site: 3, gen: 1, tile: 30 }, ME_KEY = '2,0,3', POLE = 32;
const PROTO_CLAIMS = { rule: 'standing-ground', version: 'design-2026-10-10-r2', label: { ja: '試作', en: 'Prototype' }, numbers: { FALL_LOOSE: 36, FALL_FIRM: 72, WALK_PAY: 2 }, clockLag: 1 };
const CINDER_ON_POLE = { nation: 2, host: 'cinder-host', troops: 500, sinceTurn: 54, tolls: 36, canTakeAtTurn: 90, hasFloor: true, onlyPull: null };
/** The land record of province (2,0) with the viewer's banner (slot 1, pole 32) under Cinder's host (as test/web-frontier-proto-loss.test.mjs builds it). */
function protoLand(r) {
  const MINE = [32, 41, 40, 31, 23, 33, 15], claim = new Array(61).fill(CLAIM.OPEN);
  for (const t of MINE) claim[t] = CLAIM.BANNER0 + 1;
  return { resolvedNext: r, claim, trails: [], counted: [0, 0, 0, 0, 0, 0], paid: [0, 0, 0, 0, 0, 0], holderNation: 0, rising: [], villages: [{ site: 3, tile: 30, nation: 0, holder: ME_KEY, tiles: 1 }],
    banners: [{ slot: 1, pole: POLE, nation: 0, holder: ME_KEY, tiles: [...MINE], raisedTurn: 44, tendedTurn: 44, firm: true, border: [], frayed: false, walkDue: 476, strikeAt: 548, dressedToday: false, elbowLockedUntil: null, contested: CINDER_ON_POLE }] };
}
/** The page in a banner-prototype world at land turn r (the clock a turn ahead of it). */
function protoPage(r, { marches = [], foeRoster = false } = {}) {
  const FS = { nowBell: r + 1, chain: { rate: 30 }, sample: { world: 'sample', rate: 30 }, citizen: { faction: 0 }, holdings: [{ ...HOME }], provinces: new Map(), feed: [], orders: [], marches };
  FS.proto = pm.emptyState(PROTO_CLAIMS); FS.proto.lands.set('2,0', protoLand(r));
  FS.proto.me = { holder: ME_KEY, nation: 0, banners: [{ p: 2, q: 0, slot: 1 }], cap: 5, perProvince: 2, tiles: 20, villageTiles: 7, perTurn: 20, hosts: [] };
  if (foeRoster) FS.provinces.set('2,0', { province: { p: 2, q: 0, entries: [{ tile: POLE, faction: 2, state: 1, unit: 0, troops: 500_000 }] } });
  return FS;
}
/** The notice as app.mjs protoNews tells it the first time the threat is seen (worded threats, words carried). */
const toldNotice = t => ({ id: t.id, kind: 'proto', proto: true, own: true, alarm: true, bell: 63, p: t.p, q: t.q, tile: t.tile, text: t.text, words: t.words, send: { p: t.p, q: t.q, tile: t.tile } });
const toastOf = x => text(FEED.renderToast(x));

test('B11 round 2: the alarm notice of a banner-prototype world shows its LIVE words (count now, host on its way, arrived, outnumbered) in the language in hand', () => {
  // told in English at land turn 62: 28 turns left
  const [t0] = inLang('en', () => W.worded(() => pm.threatsOf(protoPage(62))));
  assert.match(t0.words.en, /28 turns/); assert.match(t0.words.ja, /あと28ターン/);
  const x = toldNotice(t0);
  // two turns later a host of the viewer's marches on the pole, arriving on turn 66; the count is 26 now
  const onWay = protoPage(64, { marches: [{ dest: { p: 2, q: 0, tile: POLE }, entry: { host: '1', arriveBell: 66 } }] });
  const [up] = inLang('en', () => W.worded(() => pm.threatsOf(onWay)));
  for (const l of ['en', 'ja']) inLang(l, () => {
    const shown = toastOf(pm.alarmNow(onWay, x, up));
    if (l === 'en') {
      assert.match(shown, /26 turns.*\. Your host is on its way \(arrives on turn 66\)/, 'the count now and the answer on its way');
      assert.doesNotMatch(shown, /28 turns/, 'not the words it was told with (R1)');
      assert.doesNotMatch(shown, JP);
    } else {
      assert.match(shown, /あと26ターン.*。あなたの軍勢が向かっています（ターン 66 に到着）/);
      assert.doesNotMatch(shown, /28ターン|Your host/);
    }
    assert.equal(pm.alarmNow(onWay, x, up).send, null, 'no second 軍勢を送る');
    const r = pm.alarmNow(onWay, x, up);
    assert.equal(r.words[l], r.text, 'the words drawn are the live text, in each language');
    // (round 1's shape — the live text over `text`, the told words kept — drew the told words: R1)
    assert.match(toastOf({ ...x, text: r.text }), l === 'en' ? /28 turns/ : /あと28ターン/);
  });
  // the arrival turn has come: arrived, waiting for the fight to be told
  onWay.nowBell = 66;
  inLang('en', () => assert.match(toastOf(pm.alarmNow(onWay, x, up)), /\. Your host has arrived: the clash is being resolved/));
  assert.match(toastOf(pm.alarmNow(onWay, x, up)), /。あなたの軍勢が着きました。戦いの結果を待っています/);
  // outnumbered: Cinder's 500 on the pole, nothing the viewer can field
  const outnumbered = protoPage(64, { foeRoster: true });
  const [o] = W.worded(() => pm.threatsOf(outnumbered));
  assert.match(toastOf(pm.alarmNow(outnumbered, x, o)), /あと26ターン.*。立っているのはシンダーの.*500.*数で下回っています/);
  inLang('en', () => assert.match(toastOf(pm.alarmNow(outnumbered, x, o)), /26 turns.*You are outnumbered/));
  // neither: the live count alone, in the language in hand
  const plain = protoPage(64), [p0] = W.worded(() => pm.threatsOf(plain));
  inLang('en', () => { const s = toastOf(pm.alarmNow(plain, x, p0)); assert.match(s, /26 turns/); assert.doesNotMatch(s, /28 turns/); assert.doesNotMatch(s, JP); });
  assert.match(toastOf(pm.alarmNow(plain, x, p0)), /あと26ターン/);
});

test('B11 round 2: a march notice names its tile in the language of each run (snapshot destNames), not the snapshot\'s', () => {
  const { FS } = { FS: world() };
  FS.provinces.get('2,0').province.camp = { state: 1, tile: 31 };
  const m = (pl, slot) => ({ entry: { host: '9', arriveBell: 41 }, dest: { p: 2, q: 0, tile: 31 }, facts: { pipeline: pl, slotPresent: slot } });
  // both snapshots taken in English (the camp is named "Barbarian camp" there)
  const [a, b] = inLang('en', () => { FS.marches = [m('open', false)]; const s0 = FEED.snapshot(FS); FS.marches = [m('open', true)]; return [s0, FEED.snapshot(FS, undefined, s0)]; });
  assert.deepEqual(b.marches.get('9').destNames, { ja: '蛮族の野営地', en: 'Barbarian camp' });
  const [seal] = inLang('en', () => FEED.diffFeed(a, b));
  assert.equal(seal.id, 'rv:9');
  assert.match(seal.words.ja, /^蛮族の野営地への進軍の封が開けられました$/, 'Japanese words with the Japanese name');
  assert.match(seal.words.en, /^The seal of your march to the barbarian camp was opened$/);
});
