// fix-lp28-paid-again (owner r0ze 2026-11-28 00:14, Q-LP28-1 (b); loop-play28 BREAK-3, stills 024–026), page only:
// an unpaid land that a coming payment pays while production now covers upkeep. Before, the village card said only
// "supported indefinitely" (fix-landhorizon G3: paidAgainCase returned nothing once `sustainable`) and the "While you
// wait" panel counted down to the let-go from the chain record alone. Now both say: unpaid now; the payment in P turn(s)
// pays it; after that this production supports the land indefinitely. A release that really comes keeps its countdown.
//
// The fixture is the loop-play28 world D read log (evidence/loop-play28/logs/hz.jsonl): 55 tiles, upkeep 54.45 food/h,
// unpaid since bell 347, a Farm lifted production 52 → 64 food/h; the page's reads at bells 359–362, as horizonFromFS
// made them (alignLandClock + projectHorizon + holdHorizon).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { BELL_SECS } from '../../permutation-server/web/frontier/clock.mjs';
import { projectHorizon, alignLandClock, holdHorizon, horizonStatusLines, horizonHudLine, paidAgainCase } from '../../permutation-server/web/frontier/landhorizon.mjs';
import * as WP from '../../permutation-server/web/frontier/hud/waitpanel.mjs';

afterEach(() => setLang('ja'));
const RATE = 60;
const strip = s => String(s).replace(/<[^>]*>/g, '');

// bell, chain now, page store (milli-food, settled to now), production, land paidTo, unpaidSince, food t0 (hz.jsonl)
const READS = [
  [359, 1785849213, 534, 52000, 1785848528, 347, 1785849176],
  [360, 1785849815, 1651, 64000, 1785849176, 347, 1785849728],
  [361, 1785850452, 3174, 64000, 1785849728, 347, 1785850376],
  [362, 1785851064, 5705, 64000, 1785850928, null, 1785850928],
];
const hist = (() => { const a = Array(64).fill(0); a[2] = 55; return a; })();
function read([bell, now, stock, prod, paidTo, since, ft0], over = {}) {
  const clock = alignLandClock(paidTo, ft0);
  const p = projectHorizon({ stockMilli: stock, productionMilliPerHour: prod, upkeepMilliPerHour: 54450, paidTo: clock.paidTo, unpaidSince: since, nowTs: now, nowBell: bell, tiles: 55, hist, ...over });
  return { ...holdHorizon(p, { consistent: clock.consistent, key: `t|55|54450|${over.unpaidSince ?? since ?? '-'}|${p.productionMilliPerHour}`, bell }), rate: RATE };
}
const G = 1785849176 - 359 * BELL_SECS;   // a genesis that puts bell 359 where the log has it (display only)
function waitFS(bell, since, nowTs) {
  const holding = { p: -68, q: -60, site: 0, gen: 0, tier: 1, state: 2, transit: [], reserve: [0, 0, 0, 0, 0, 0], queue: [] };
  return { mode: 'play', clock: { genesisTs: G }, chain: { now: () => nowTs, rate: RATE }, nowBell: bell, season: null, citizen: { faction: 0 },
    holdings: [holding], activeHolding: 0, provinces: new Map(), marches: [], ui: {},
    ownLand: { citizen: 'x', player: { tiles: 55, upkeepMilliPerHour: 54450, unpaid: since != null, unpaidSince: since } } };
}
const upkeepLine = (FS, h) => {
  const m = WP.waitModel(FS, { horizon: h });
  const t = m.timers.find(x => x.id === 'upkeep');
  return t ? { kind: t.kind, text: strip(WP.timerLine(FS, t)), at: t.at } : null;
};

test('loop-play28 fixture: village card, compact line and wait panel at bells 359–362 (EN)', () => {
  setLang('en');
  const out = READS.map(r => {
    const h = read(r);
    const FS = waitFS(r[0], r[5], r[1]);
    return { bell: r[0], h, card: horizonStatusLines(h, RATE).join(' / '), hud: horizonHudLine(h, RATE), panel: upkeepLine(FS, h) };
  });
  const [b359, b360, b361, b362] = out;
  // 359: production 52 < 54.45 — the release really comes: countdown on both, as before
  assert.equal(b359.h.paidAgain, false);
  assert.match(b359.card, /^Upkeep is already unpaid\. If nothing changes, tiles start being let go in 12 turns/);
  assert.equal(b359.panel.kind, 'upkeepUnpaid');
  assert.match(b359.panel.text, /^Land upkeep is unpaid\. Tiles start to go: /);
  // 360, 361: the Farm is done, the chain still says unpaid, the projection pays it next turn — the (b) text, no countdown
  for (const b of [b360, b361]) {
    assert.equal(b.h.sustainable, true);
    assert.deepEqual(paidAgainCase(b.h), { now: false, paidIn: 1, sustainable: true });
    assert.equal(b.card, 'Upkeep is already unpaid. If nothing changes, the payment in 1 turn (about 10 minutes of game time, in this world about 10 seconds of real time) pays it, and after that this food production supports your current land indefinitely. / At the current distance you can support 9 more tiles (up to 64 tiles).');
    assert.equal(b.hud, 'Land upkeep is unpaid. Paid in 1 turn (about 10 minutes of game time, in this world about 10 seconds of real time). After that, this food production supports it indefinitely.');
    assert.equal(b.panel.kind, 'upkeepPaidAgain');
    assert.match(b.panel.text, /^Land upkeep is unpaid\. The payment in 1 turn pays it, and after that this food production supports the land indefinitely\. Paid: /);
    assert.doesNotMatch(b.panel.text, /Tiles start|let go/);
    assert.doesNotMatch(b.card, /let go/);
    assert.equal(b.panel.at, G + (b.bell + 1) * BELL_SECS, 'the panel times the payment turn, not the end of the grace');
  }
  // 362: paid on chain — the plain sustainable card and the paid upkeep line, no unpaid wording anywhere
  assert.equal(b362.card, 'Your current land can be supported indefinitely by this food production. At the current distance you can support 9 more tiles (up to 64 tiles).');
  assert.equal(b362.hud, 'Your current land can be supported indefinitely by this food production.');
  assert.equal(b362.panel.kind, 'upkeep');
  assert.equal(b362.panel.text, 'Upkeep of 55 land tiles: 54.45 food an hour (paid)');
  for (const b of out) for (const s of [b.card, b.hud, b.panel.text]) assert.doesNotMatch(s, /season/i);
});

test('loop-play28 fixture in Japanese (bell 360)', () => {
  setLang('ja');
  const h = read(READS[1]);
  assert.deepEqual(horizonStatusLines(h, RATE), [
    'すでに未払いです。このままなら、1 ターン（ゲーム内で約 10 分、この世界では実時間で約 10 秒） 後の支払いで払われ、その後は、いまの土地をこの食料の生産でずっと維持できます。',
    'いまの距離なら、あと 9 マスまで維持できます（最大 64 マス）。',
  ]);
  assert.equal(horizonHudLine(h, RATE), '土地は未払いです。1 ターン（ゲーム内で約 10 分、この世界では実時間で約 10 秒） 後の支払いで払われます。その後は、この食料の生産でずっと維持できます。');
  const p = upkeepLine(waitFS(360, 347, READS[1][1]), h);
  assert.match(p.text, /^土地の維持費は未払いです。1 ターン後の支払いで払われ、その後はこの食料の生産でずっと維持できます。払われるのは：/);
  for (const s of [...horizonStatusLines(h, RATE), p.text]) assert.doesNotMatch(s, /シーズン/);
});

test('the payment due now pays it (P = 0): "this payment", no time in the panel', () => {
  // the store already holds a turn's reserve and the land's settle is due: the next keeper pass pays it
  const r = [360, 1785849815, 20000, 64000, 1785849176, 347, 1785849176];
  const h = read(r);
  assert.deepEqual(paidAgainCase(h), { now: true, paidIn: 0, sustainable: true });
  setLang('en');
  assert.equal(horizonStatusLines(h, RATE)[0], 'This payment pays the land upkeep, and the land is no longer unpaid. After that, this food production supports your current land indefinitely.');
  assert.equal(horizonHudLine(h, RATE), 'This payment pays the land. After that, this food production supports it indefinitely.');
  const p = upkeepLine(waitFS(360, 347, r[1]), h);
  assert.equal(p.kind, 'upkeepPaidAgain');
  assert.equal(p.at, null);
  assert.equal(p.text, 'Land upkeep is unpaid. This payment pays it, and after that this food production supports the land indefinitely.');
  setLang('ja');
  assert.equal(horizonStatusLines(h, RATE)[0], '今の支払いで土地の維持費が払われ、未払いは終わります。その後は、いまの土地をこの食料の生産でずっと維持できます。');
});

test('sustainable and paid: no unpaid line on the card, the compact line or the panel', () => {
  setLang('en');
  const r = [400, 1785874000, 50000, 64000, 1785873900, null, 1785873900];
  const h = read(r);
  assert.equal(h.sustainable, true);
  assert.equal(h.paidAgain, false);
  assert.equal(paidAgainCase(h), null);
  const all = [...horizonStatusLines(h, RATE), horizonHudLine(h, RATE), upkeepLine(waitFS(400, null, r[1]), h).text];
  for (const s of all) assert.doesNotMatch(s, /unpaid|let go|Tiles start/);
  assert.equal(upkeepLine(waitFS(400, null, r[1]), h).kind, 'upkeep');
});

test('unsustainable: the let-go countdown stays (card and panel)', () => {
  setLang('en');
  const r = [359, 1785849213, 534, 30000, 1785848528, 347, 1785848528];
  const h = read(r);
  assert.equal(h.sustainable, false);
  assert.equal(h.paidAgain, false);
  assert.match(horizonStatusLines(h, RATE)[0], /^Upkeep is already unpaid\. If nothing changes, tiles start being let go in 12 turns/);
  const p = upkeepLine(waitFS(359, 347, r[1]), h);
  assert.equal(p.kind, 'upkeepUnpaid');
  assert.match(p.text, /^Land upkeep is unpaid\. Tiles start to go: /);
});

test('the grace ends before the payment: the release comes first, the countdown stays', () => {
  setLang('en');
  // the bell-360 read with unpaid since 336: 0 turns of grace left, the payment is 1 turn away
  const r = [360, 1785849815, 1651, 64000, 1785849176, 336, 1785849728];
  const h = read(r);
  assert.equal(h.paidAgain, true);
  assert.equal(h.graceTurnsLeft, 0);
  assert.equal(paidAgainCase(h), null);
  assert.deepEqual(horizonStatusLines(h, RATE), ['Upkeep is already unpaid. Your farthest tiles are being let go.']);
  assert.equal(horizonHudLine(h, RATE), 'Land upkeep is unpaid, and tiles are already being let go.');
  assert.equal(upkeepLine(waitFS(360, 336, r[1]), h).kind, 'upkeepUnpaid');
});

test('the panel takes the projection only for the same unpaid record; none at all keeps the chain countdown', () => {
  setLang('en');
  const h = read(READS[1]);
  // a projection of another unpaid record (its grace differs from the chain record's): the countdown
  assert.equal(upkeepLine(waitFS(360, 340, READS[1][1]), h).kind, 'upkeepUnpaid');
  // no projection (no food read): the countdown, as before
  assert.equal(upkeepLine(waitFS(360, 347, READS[1][1]), null).kind, 'upkeepUnpaid');
  // horizon not given: read from FS (this FS has no village stores, so none) — no throw, the countdown
  assert.equal(WP.waitModel(waitFS(360, 347, READS[1][1])).timers.find(t => t.id === 'upkeep').kind, 'upkeepUnpaid');
});

test('production short but a payment pays it: the panel says the #285 compact line, not the countdown', () => {
  setLang('en');
  // production 54 < 54.45 food/h and a store that pays the next settle (#285 "paid again" with production below upkeep)
  const r = [360, 1785849815, 200000, 54000, 1785849176, 347, 1785849176];
  const h = read(r);
  const pa = paidAgainCase(h);
  assert.equal(pa?.sustainable, false);
  const p = upkeepLine(waitFS(360, 347, r[1]), h);
  assert.equal(p.kind, 'upkeepPaidAgain');
  assert.equal(p.text, horizonHudLine(h, RATE));
  assert.match(p.text, /^This payment pays the land\. Unpaid again in /);
});
