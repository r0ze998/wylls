// test-gaps-8 (tests only) for #298 (fix-lp28-paid-again, owner r0ze 2026-11-28 00:14, Q-LP28-1 (b)): an unpaid land that
// a coming payment pays while production covers upkeep. verify-pr298 and loop-play29 checked by hand: the live text at each
// bell of loop-play29 world D (EN cycle 497–509, JA cycle 617–633) on the village card AND the "While you wait" panel, the
// loop-play28 fixture in Japanese at every bell (the PR's own test did bell 360 only), the plural P = 2 wording and the panel
// time (verify-pr298 extra.test.mjs, never committed), the grace boundary (verify-pr298 V5 `<` → `<=`, caught only by the
// #285 suite), and that the card and the panel never disagree (loop-play28 BREAK-3 was exactly that disagreement).
//
// LP29 is the loop-play29 hz.jsonl log (evidence/loop-play29/logs, one read every 5 s through the page's own modules): per
// row the page's inputs to projectHorizon (store settled to now, production, the land record, the food checkpoint) and the
// card text (`.hp-own-land-horizon` innerText) and the wait panel's upkeep line as they were on screen. The panel's time
// ("Paid: in about 6 min") depends on the wall clock at the read, so only the text before it is compared. Kept: the first
// read of each (bell, paid, P) whose replay matches the logged text; 3 of 58 window reads were not (617/619: the real-time
// minutes rounded at another rate; 630 second read: the store's carried fraction is not in the log).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { BELL_SECS } from '../../permutation-server/web/frontier/clock.mjs';
import { projectHorizon, alignLandClock, holdHorizon, horizonStatusLines, horizonHudLine, paidAgainCase } from '../../permutation-server/web/frontier/landhorizon.mjs';
import * as WP from '../../permutation-server/web/frontier/hud/waitpanel.mjs';

afterEach(() => setLang('ja'));
const strip = s => String(s).replace(/<[^>]*>/g, '');
const cut = s => s.replace(/(Paid: |Tiles start to go: |払われるのは：|手放し始めるまで：).*/, '$1');
const JA = /[぀-ヿ一-鿿]/;

function landFS({ bell, nowTs, tiles, up, since, genesisTs = 0, rate = 60 }) {
  return { mode: 'play', clock: { genesisTs }, chain: { now: () => nowTs, rate }, nowBell: bell, season: null, citizen: { faction: 0 },
    holdings: [{ p: -68, q: -60, site: 0, gen: 0, tier: 1, state: 2, transit: [], reserve: [0, 0, 0, 0, 0, 0], queue: [] }], activeHolding: 0,
    provinces: new Map(), marches: [], ui: {},
    ownLand: { citizen: 'x', player: { tiles, upkeepMilliPerHour: up, unpaid: since != null, unpaidSince: since } } };
}
function panelOf(FS, h) {
  const t = WP.waitModel(FS, { horizon: h }).timers.find(x => x.id === 'upkeep');
  return t ? { kind: t.kind, at: t.at, text: strip(WP.timerLine(FS, t)) } : null;
}

// bell, chain now, store (milli-food, settled to now), production, upkeep (milli/h), tiles, land paidTo, unpaidSince,
// food t0, remainder, the page's rate, language, panel kind, card text, panel text up to its time
const LP29 = [
  [497, 1785932307.3787107, 4211, 40000, 44550, 45, 1785931928, 497, 1785931928, 0, 59.83270460882401, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 24 turns (about 4 hours of game time, in this world about 4 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [498, 1785932626.0976782, 1355, 40000, 44550, 45, 1785931928, 497, 1785932504, 0, 60.06915857072288, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 23 turns (about 4 hours of game time, in this world about 4 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [499, 1785933243.818903, 1011, 40000, 44550, 45, 1785932504, 497, 1785933152, 0, 60.19080090482903, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 22 turns (about 4 hours of game time, in this world about 4 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [500, 1785933855.0500593, 1678, 40000, 44550, 45, 1785933152, 497, 1785933704, 0, 60.22982432967904, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 21 turns (about 4 hours of game time, in this world about 3 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [501, 1785934459.657369, 1189, 40000, 44550, 45, 1785933704, 497, 1785934352, 0, 60.13847675568744, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 20 turns (about 3 hours of game time, in this world about 3 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [502, 1785935051.616816, 1634, 40000, 44550, 45, 1785934352, 497, 1785934904, 0, 59.46637786748055, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 19 turns (about 3 hours of game time, in this world about 3 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [503, 1785935686.2351995, 1489, 40000, 44550, 45, 1785934904, 497, 1785935552, 0, 59.84153803251259, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 18 turns (about 3 hours of game time, in this world about 3 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [504, 1785936293.1640475, 2100, 40000, 44550, 45, 1785936104, 497, 1785936104, 0, 59.77877918885703, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 17 turns (about 3 hours of game time, in this world about 3 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [505, 1785936910.0351245, 1755, 40000, 44550, 45, 1785936104, 497, 1785936752, 0, 59.76408912188729, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 16 turns (about 3 hours of game time, in this world about 3 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [506, 1785937524.0697157, 2177, 40000, 44550, 45, 1785937328, 497, 1785937328, 0, 59.75625737124885, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 15 turns (about 3 hours of game time, in this world about 3 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [507, 1785938133.7015176, 2267, 52000, 44550, 45, 1785937976, 497, 1785937976, 0, 59.847428430809614, 'en', "upkeepPaidAgain", "Upkeep is already unpaid. If nothing changes, the payment in 1 turn (about 10 minutes of game time, in this world about 10 seconds of real time) pays it, and after that this food production supports your current land indefinitely. At the current distance you can support 7 more tiles (up to 52 tiles).", "Land upkeep is unpaid. The payment in 1 turn pays it, and after that this food production supports the land indefinitely. Paid: "],
  [508, 1785938745.744361, 4276, 52000, 44550, 45, 1785937976, 497, 1785938528, 0, 60.150375939849624, 'en', "upkeepPaidAgain", "This payment pays the land upkeep, and the land is no longer unpaid. After that, this food production supports your current land indefinitely. At the current distance you can support 7 more tiles (up to 52 tiles).", "Land upkeep is unpaid. This payment pays it, and after that this food production supports the land indefinitely."],
  [508, 1785939038.876767, 8509, 52000, 44550, 45, 1785938528, null, 1785938528, 0, 59.77731958762887, 'en', "upkeep", "Your current land can be supported indefinitely by this food production. At the current distance you can support 7 more tiles (up to 52 tiles).", "Upkeep of 45 land tiles: 44.55 food an hour (paid)"],
  [509, 1785939355.9507167, 5959, 52000, 44550, 45, 1785938528, null, 1785939104, 0, 59.773375777268306, 'en', "upkeep", "Your current land can be supported indefinitely by this food production. At the current distance you can support 7 more tiles (up to 52 tiles).", "Upkeep of 45 land tiles: 44.55 food an hour (paid)"],
  [617, 1786004054.1690714, 2167, 52000, 54450, 55, 1786003904, 616, 1786003904, 0, 59.89389657395012, 'en', "upkeepUnpaid", "Upkeep is already unpaid. If nothing changes, tiles start being let go in 23 turns (about 4 hours of game time, in this world about 4 minutes of real time).", "Land upkeep is unpaid. Tiles start to go: "],
  [618, 1786004660.3261235, 1560, 52000, 54450, 55, 1786003904, 616, 1786004552, 0, 59.835551299408905, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 22 ターン（ゲーム内で約 4 時間、この世界では実時間で約 4 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [619, 1786005563.4541523, 6283, 52000, 54450, 55, 1786005128, 616, 1786005128, 0, 59.424572060547035, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 21 ターン（ゲーム内で約 4 時間、この世界では実時間で約 4 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [620, 1786005888.3057861, 2658, 52000, 54450, 55, 1786005704, 616, 1786005704, 0, 59.947742921466485, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 20 ターン（ゲーム内で約 3 時間、この世界では実時間で約 3 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [621, 1786006499.8841069, 2123, 52000, 54450, 55, 1786005704, 616, 1786006352, 0, 60.22485265712446, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 19 ターン（ゲーム内で約 3 時間、この世界では実時間で約 3 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [622, 1786007111.2352786, 2643, 52000, 54450, 55, 1786006352, 616, 1786006928, 0, 59.80987589120676, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 18 ターン（ゲーム内で約 3 時間、この世界では実時間で約 3 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [623, 1786007721.869091, 2094, 52000, 54450, 55, 1786006928, 616, 1786007576, 0, 59.79507317636577, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 17 ターン（ゲーム内で約 3 時間、この世界では実時間で約 3 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [624, 1786008332.703317, 2947, 52000, 54450, 55, 1786007576, 616, 1786008128, 0, 59.86520417602749, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 16 ターン（ゲーム内で約 3 時間、この世界では実時間で約 3 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [625, 1786008944.3773623, 2427, 52000, 54450, 55, 1786008128, 616, 1786008776, 0, 59.52085710034225, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 15 ターン（ゲーム内で約 3 時間、この世界では実時間で約 3 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [626, 1786009560.468435, 3351, 52000, 54450, 55, 1786008776, 616, 1786009328, 0, 59.85927124971094, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 14 ターン（ゲーム内で約 2 時間、この世界では実時間で約 2 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [627, 1786010162.6455302, 2686, 52000, 54450, 55, 1786009328, 616, 1786009976, 0, 59.71821702232842, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 13 ターン（ゲーム内で約 2 時間、この世界では実時間で約 2 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [628, 1786010486.0748332, 7366, 52000, 54450, 55, 1786009976, 616, 1786009976, 0, 60.10379767690914, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 12 ターン（ゲーム内で約 2 時間、この世界では実時間で約 2 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [629, 1786011104.0708673, 8320, 52000, 54450, 55, 1786010528, 616, 1786010528, 0, 59.449794123919354, 'ja', "upkeepUnpaid", "すでに未払いです。このままなら、土地の手放しは 11 ターン（ゲーム内で約 2 時間、この世界では実時間で約 2 分） 後に始まります。", "土地の維持費が払えていません。手放し始めるまで："],
  [630, 1786011709.3029838, 8622, 64000, 54450, 55, 1786011152, 616, 1786011152, 0, 59.34562604395244, 'ja', "upkeepPaidAgain", "すでに未払いです。このままなら、1 ターン（ゲーム内で約 10 分、この世界では実時間で約 10 秒） 後の支払いで払われ、その後は、いまの土地をこの食料の生産でずっと維持できます。 いまの距離なら、あと 9 マスまで維持できます（最大 64 マス）。", "土地の維持費は未払いです。1 ターン後の支払いで払われ、その後はこの食料の生産でずっと維持できます。払われるのは："],
  [631, 1786012318.4769688, 11100, 64000, 54450, 55, 1786011704, 616, 1786011704, 0, 59.236980613946194, 'ja', "upkeepPaidAgain", "今の支払いで土地の維持費が払われ、未払いは終わります。その後は、いまの土地をこの食料の生産でずっと維持できます。 いまの距離なら、あと 9 マスまで維持できます（最大 64 マス）。", "土地の維持費は未払いです。今の支払いで払われ、その後はこの食料の生産でずっと維持できます。"],
  [632, 1786012915.8796248, 11912, 64000, 54450, 55, 1786012352, null, 1786012352, 0, 59.01511203751954, 'ja', "upkeep", "いまの土地は、この食料の生産で維持できます。いまの距離なら、あと 9 マスまで維持できます（最大 64 マス）。", "土地 55 マスの維持費：毎時 食料 54.45（払えています）"],
  [633, 1786013544.9934633, 14746, 64000, 54450, 55, 1786012904, null, 1786012904, 0, 58.63698142515047, 'ja', "upkeep", "いまの土地は、この食料の生産で維持できます。いまの距離なら、あと 9 マスまで維持できます（最大 64 マス）。", "土地 55 マスの維持費：毎時 食料 54.45（払えています）"],

]

test('loop-play29 world D, live text at each bell: village card AND wait panel (EN 497–509, JA 617–633)', () => {
  holdHorizon(projectHorizon({}), { consistent: true, key: 'reset', bell: 0 });
  const seenKinds = new Set();
  for (const [bell, now, stock, prod, up, tiles, paidTo, since, ft0, rem, rate, lang, kind, card, panel] of LP29) {
    setLang(lang);
    const clock = alignLandClock(paidTo, ft0);
    const p = projectHorizon({ stockMilli: stock, productionMilliPerHour: prod, upkeepMilliPerHour: up, paidTo: clock.paidTo, remainder: rem, unpaidSince: since, nowTs: now, nowBell: bell, tiles });
    const h = { ...holdHorizon(p, { consistent: clock.consistent, key: `x|${tiles}|${up}|${since ?? '-'}|${p.productionMilliPerHour}`, bell }), rate };
    const where = `bell ${bell} (${since == null ? 'paid' : 'unpaid'})`;
    assert.equal(horizonStatusLines(h, rate).join(' '), card, `card at ${where}`);
    const FS = landFS({ bell, nowTs: now, tiles, up, since });
    const pn = panelOf(FS, h);
    assert.equal(pn.kind, kind, `panel kind at ${where}`);
    assert.equal(cut(pn.text), panel, `panel at ${where}`);
    seenKinds.add(kind);
    // the card and the panel tell the same story: (b) on both, the countdown on both, or paid on both
    const pa = paidAgainCase(h);
    if (kind === 'upkeepPaidAgain') {
      assert.ok(pa?.sustainable, where);
      assert.equal(pn.at, pa.now ? null : (bell + pa.paidIn) * BELL_SECS, `the panel times the payment turn at ${where}`);
      assert.doesNotMatch(card, /let go|手放し/, where);
      assert.doesNotMatch(pn.text, /Tiles start|手放し/, where);
      // a chain record of another unpaid spell (one bell older: its grace differs) keeps the chain's countdown — the
      // panel takes the card's projection only for the record it was made from
      assert.equal(panelOf(landFS({ bell, nowTs: now, tiles, up, since: since - 1 }), h).kind, 'upkeepUnpaid', `stale record at ${where}`);
    } else if (kind === 'upkeepUnpaid') {
      assert.equal(pa, null, where);
      assert.match(card, lang === 'en' ? /tiles start being let go in \d+ turns/ : /土地の手放しは \d+ ターン/, where);
    } else {
      assert.doesNotMatch(card + pn.text, /unpaid|未払い/, where);
    }
    assert.equal(JA.test(card + pn.text), lang === 'ja', `language at ${where}`);
    assert.doesNotMatch(card + pn.text, /season|シーズン/i, where);
  }
  assert.deepEqual([...seenKinds].sort(), ['upkeep', 'upkeepPaidAgain', 'upkeepUnpaid']);
  // the (b) rows themselves: P = 1 at 507 / 630, P = 0 at 508 / 631, as loop-play29 logged
  assert.deepEqual(LP29.filter(r => r[12] === 'upkeepPaidAgain').map(r => r[0]), [507, 508, 630, 631]);
});

// loop-play28 world D (the PR's own fixture; its test reads Japanese at bell 360 only)
const LP28 = [
  [359, 1785849213, 534, 52000, 1785848528, 347, 1785849176],
  [360, 1785849815, 1651, 64000, 1785849176, 347, 1785849728],
  [361, 1785850452, 3174, 64000, 1785849728, 347, 1785850376],
  [362, 1785851064, 5705, 64000, 1785850928, null, 1785850928],
];
const hist55 = (() => { const a = Array(64).fill(0); a[2] = 55; return a; })();
const G28 = 1785849176 - 359 * BELL_SECS;
function read28([bell, now, stock, prod, paidTo, since, ft0], over = {}) {
  const clock = alignLandClock(paidTo, ft0);
  const p = projectHorizon({ stockMilli: stock, productionMilliPerHour: prod, upkeepMilliPerHour: 54450, paidTo: clock.paidTo, unpaidSince: since, nowTs: now, nowBell: bell, tiles: 55, hist: hist55, ...over });
  return { ...holdHorizon(p, { consistent: clock.consistent, key: `t|55|54450|${since ?? '-'}|${p.productionMilliPerHour}`, bell }), rate: 60 };
}

test('loop-play28 fixture in Japanese at every bell (359–362): card, compact line and panel', () => {
  setLang('ja');
  const out = LP28.map(r => {
    const h = read28(r);
    return { h, card: horizonStatusLines(h, 60), hud: horizonHudLine(h, 60), panel: panelOf(landFS({ bell: r[0], nowTs: r[1], tiles: 55, up: 54450, since: r[5], genesisTs: G28 }), h) };
  });
  const [b359, b360, b361, b362] = out;
  assert.deepEqual(b359.card, ['すでに未払いです。このままなら、土地の手放しは 12 ターン（ゲーム内で約 2 時間、この世界では実時間で約 2 分） 後に始まります。']);
  assert.equal(b359.panel.kind, 'upkeepUnpaid');
  assert.match(b359.panel.text, /^土地の維持費が払えていません。手放し始めるまで：/);
  for (const b of [b360, b361]) {
    assert.deepEqual(b.card, [
      'すでに未払いです。このままなら、1 ターン（ゲーム内で約 10 分、この世界では実時間で約 10 秒） 後の支払いで払われ、その後は、いまの土地をこの食料の生産でずっと維持できます。',
      'いまの距離なら、あと 9 マスまで維持できます（最大 64 マス）。',
    ]);
    assert.equal(b.hud, '土地は未払いです。1 ターン（ゲーム内で約 10 分、この世界では実時間で約 10 秒） 後の支払いで払われます。その後は、この食料の生産でずっと維持できます。');
    assert.equal(b.panel.kind, 'upkeepPaidAgain');
    assert.match(b.panel.text, /^土地の維持費は未払いです。1 ターン後の支払いで払われ、その後はこの食料の生産でずっと維持できます。払われるのは：/);
    assert.doesNotMatch(b.panel.text + b.card.join(''), /手放し/);
  }
  assert.equal(b360.panel.at, G28 + 361 * BELL_SECS);
  assert.equal(b361.panel.at, G28 + 362 * BELL_SECS);
  assert.deepEqual(b362.card, ['いまの土地は、この食料の生産で維持できます。いまの距離なら、あと 9 マスまで維持できます（最大 64 マス）。']);
  assert.equal(b362.hud, 'いまの土地は、この食料の生産で維持できます。');
  assert.equal(b362.panel.kind, 'upkeep');
  assert.equal(b362.panel.text, '土地 55 マスの維持費：毎時 食料 54.45（払えています）');
  for (const b of out) for (const s of [...b.card, b.hud, b.panel.text]) assert.doesNotMatch(s, /シーズン|season/i);
});

// verify-pr298 extra (never committed): P ≥ 2 is not reachable with production ≥ upkeep (a turn's production covers a
// turn's reserve), so a projection with P = 2 is written by hand; the card and panel wording and the panel's time.
function synthetic(over) {
  const bell = 360, since = 347, now = G28 + bell * BELL_SECS + 30;
  const base = projectHorizon({ stockMilli: 0, productionMilliPerHour: 64000, upkeepMilliPerHour: 54450, tiles: 55, hist: hist55, paidTo: G28 + (bell - 1) * BELL_SECS, unpaidSince: since, nowTs: now, nowBell: bell });
  return { bell, since, now, h: { ...base, paidAgain: true, sustainable: true, unpaidAlready: false, turnsUntilPaid: 2, turnsUntilUnpaid: null, graceTurnsLeft: 24 - (bell - since), rate: 60, ...over } };
}

test('P = 2: the plural on the card and the panel, the panel timed at the payment turn (EN and JA)', () => {
  const { bell, since, now, h } = synthetic({});
  const FS = landFS({ bell, nowTs: now, tiles: 55, up: 54450, since, genesisTs: G28 });
  setLang('en');
  assert.equal(horizonStatusLines(h, 60)[0], 'Upkeep is already unpaid. If nothing changes, the payment in 2 turns (about 20 minutes of game time, in this world about 20 seconds of real time) pays it, and after that this food production supports your current land indefinitely.');
  assert.equal(horizonHudLine(h, 60), 'Land upkeep is unpaid. Paid in 2 turns (about 20 minutes of game time, in this world about 20 seconds of real time). After that, this food production supports it indefinitely.');
  const p = panelOf(FS, h);
  assert.equal(p.kind, 'upkeepPaidAgain');
  assert.match(p.text, /^Land upkeep is unpaid\. The payment in 2 turns pays it, and after that this food production supports the land indefinitely\. Paid: /);
  assert.equal(p.at, G28 + (bell + 2) * BELL_SECS);
  for (const s of [...horizonStatusLines(h, 60), p.text, horizonHudLine(h, 60)]) assert.doesNotMatch(s, JA);
  setLang('ja');
  assert.match(horizonStatusLines(h, 60)[0], /^すでに未払いです。このままなら、2 ターン（ゲーム内で約 20 分/);
  assert.match(panelOf(FS, h).text, /^土地の維持費は未払いです。2 ターン後の支払いで払われ、その後はこの食料の生産でずっと維持できます。払われるのは：/);
});

test('the grace boundary: grace = P pays first ((b) text); grace 1 < P 2 lets go first (countdown on both)', () => {
  setLang('en');
  const bell = 360, now = G28 + bell * BELL_SECS + 30;
  // grace 2 = P 2 (unpaid since bell 338): the payment lands in the grace's last turn — (b), as the #285 rule pays it
  const eq = synthetic({ graceTurnsLeft: 2 }).h;
  assert.deepEqual(paidAgainCase(eq), { now: false, paidIn: 2, sustainable: true });
  const pe = panelOf(landFS({ bell, nowTs: now, tiles: 55, up: 54450, since: 338, genesisTs: G28 }), eq);
  assert.equal(pe.kind, 'upkeepPaidAgain');
  assert.equal(pe.at, G28 + 362 * BELL_SECS);
  assert.match(horizonStatusLines(eq, 60)[0], /the payment in 2 turns .* pays it/);
  // grace 1 < P 2 (unpaid since bell 337): the release comes first
  const lt = synthetic({ graceTurnsLeft: 1 }).h;
  assert.equal(paidAgainCase(lt), null);
  assert.match(horizonStatusLines(lt, 60).join(' / '), /tiles start being let go in 1 turn/);
  const pl = panelOf(landFS({ bell, nowTs: now, tiles: 55, up: 54450, since: 337, genesisTs: G28 }), lt);
  assert.equal(pl.kind, 'upkeepUnpaid');
  assert.equal(pl.at, G28 + 361 * BELL_SECS, 'the countdown times the grace end');
  // and the reachable P = 1 case at grace 1 (unpaid since bell 337, the bell-360 read): (b), not the countdown
  const h1 = read28(LP28[1], { unpaidSince: 337 });
  assert.equal(h1.graceTurnsLeft, 1);
  assert.equal(h1.turnsUntilPaid, 1);
  assert.equal(panelOf(landFS({ bell, nowTs: LP28[1][1], tiles: 55, up: 54450, since: 337, genesisTs: G28 }), h1).kind, 'upkeepPaidAgain');
  assert.match(horizonStatusLines(h1, 60)[0], /^Upkeep is already unpaid\. If nothing changes, the payment in 1 turn /);
});

// The rule, written once here independently of paidAgainCase: an unpaid land shows the (b) text (card AND panel) iff a
// coming payment pays it (paidAgain), production then covers upkeep (sustainable), and the payment is not later than the
// grace (P = 0, or P ≤ grace left); otherwise a let-go countdown, or #285's compact line when production stays short.
test('sweep: the card and the panel agree with the rule and with each other on every unpaid read', () => {
  setLang('en');
  let b = 0, countdown = 0, short = 0, n = 0, edge = 0, late = 0;
  for (const since of [336, 337, 338, 340, 347, 359]) for (const back of [0, 1, 2]) for (const stock of [0, 534, 1651, 5000, 20000, 200000])
    for (const prod of [30000, 52000, 54000, 54450, 54460, 56000, 64000]) for (const off of [5, 300, 590]) {
      const bell = 360, now = G28 + bell * BELL_SECS + off;
      holdHorizon(projectHorizon({}), { consistent: true, key: 'reset', bell: 0 });
      const p = projectHorizon({ stockMilli: stock, productionMilliPerHour: prod, upkeepMilliPerHour: 54450, paidTo: G28 + (bell - back) * BELL_SECS, unpaidSince: since, nowTs: now, nowBell: bell, tiles: 55, hist: hist55 });
      const h = { ...p, rate: 60 };
      const card = horizonStatusLines(h, 60).join(' / ');
      const pn = panelOf(landFS({ bell, nowTs: now, tiles: 55, up: 54450, since, genesisTs: G28 }), h);
      const P = h.turnsUntilPaid, grace = h.graceTurnsLeft;
      const pays = h.paidAgain && P != null && (P === 0 || grace >= P);
      const where = JSON.stringify({ since, back, stock, prod, off, P, grace, s: h.sustainable });
      n++;
      if (h.paidAgain && P > 0 && grace === P) edge++;
      if (h.paidAgain && P > 0 && grace < P) late++;
      if (pays && h.sustainable) {
        b++;
        assert.equal(pn.kind, 'upkeepPaidAgain', where);
        assert.equal(pn.at, P === 0 ? null : G28 + (bell + P) * BELL_SECS, where);
        if (P === 0) {
          assert.match(card, /^This payment pays the land upkeep, and the land is no longer unpaid\. After that, this food production supports your current land indefinitely\./, where);
          assert.match(pn.text, /^Land upkeep is unpaid\. This payment pays it, and after that this food production supports the land indefinitely\.$/, where);
        } else {
          assert.match(card, new RegExp(`^Upkeep is already unpaid\\. If nothing changes, the payment in ${P} turns? \\(.*\\) pays it, and after that this food production supports your current land indefinitely\\.`), where);
          assert.match(pn.text, new RegExp(`^Land upkeep is unpaid\\. The payment in ${P} turns? pays it, and after that this food production supports the land indefinitely\\. Paid: `), where);
        }
      } else if (pays) {
        short++;
        assert.equal(pn.kind, 'upkeepPaidAgain', where);
        assert.equal(pn.text, horizonHudLine(h, 60), where);
        assert.doesNotMatch(card + pn.text, /supports (your current|the) land indefinitely/, where);
      } else {
        countdown++;
        assert.equal(pn.kind, 'upkeepUnpaid', where);
        assert.match(pn.text, /^Land upkeep is unpaid\. Tiles start to go: /, where);
        assert.match(card, /let go/, where);
        assert.doesNotMatch(card, /pays it/, where);
      }
    }
  // every branch was reached, including the boundary rows (grace = P)
  assert.ok(b >= 50 && countdown >= 50 && short >= 10 && edge >= 5 && late >= 5, JSON.stringify({ n, b, countdown, short, edge, late }));
});
