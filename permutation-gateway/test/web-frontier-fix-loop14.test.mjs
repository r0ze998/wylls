// fix-loop14 (loop-play14 LP14-3 … LP14-15): the page-side fixes, each pinned with what main did.
// Nothing here signs, sends or holds a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as UI from '../../permutation-server/web/frontier/hud/worldgoals.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const text = m => String(m).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ------------------------------------------------------------------ LP14-3: a flag keep the viewer's nation lost
const VIEWER = 3, TAKER = 0, OTHER = 1;
const HOME = { p: 2, q: 0, tile: 7 };
const SITES = Array.from({ length: 12 }, (_, j) => 7 + 2 * j);
const terrainOf = () => ({ sites: SITES, terrain: Array(61).fill(0), names: ['Grassland'] });
const rec = (p, q, over = {}) => ({ p, q, owners: Array(12).fill(7), sites: Array(12).fill(0), hosts: Array(7).fill(0), clash: false, dormant: false, opened: true, resolvedNext: 0,
  occupiers: Array(12).fill(7), siegeStates: Array(12).fill(0), siteKinds: Array(12).fill(3), keepTile: null, keepTroops: 0, immune: Array(12).fill(false), ...over });
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; }, m }; };
const homeSight = () => S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] });
const sv = anchors => { const s = S.buildSurvey({ ringsOpen: 3, anchors }); s.rev = Math.random(); s.ownHosts = new Set(); s.faction = VIEWER; return s; };
const KEEP = 30;
const KNOWN = () => { const h = tileHex(-2, 0, KEEP); return [{ q: h.q, r: h.r, radius: 2, level: S.L2, kind: 'explored' }]; };
const liveKeep = (holder, asOfBell = 100) => ({ p: -2, q: 0, tile: KEEP, holder, troops: 288, heartland: false, contender: OTHER, progress: 12, requiredBells: 72, asOfBell });
// (flag-keeps-v2: the viewer's nation's own starting flag keep — no timer in its hands; captured, and timed, once another nation holds it)
const flag = holder => ({ p: -2, q: 0, nation: VIEWER, holder, since: 92, captured: holder !== VIEWER, from: holder === VIEWER ? null : 92, longAt: holder === VIEWER ? null : 236, contender: OTHER, progress: 12, required: 72 });
const answer = holder => ({
  ok: true, v: 1, kind: 'world-goals', ruleset: 'flag-keeps-v2', testOnly: true, season: { programId: 'P', seasonId: '11' }, effects: { money: 'none', chain: 'none' }, bell: 100, error: null,
  goals: [{ id: 'flag-keeps', kind: 'hegemony', live: true }],
  flagKeeps: { round: 1, postedBell: 0, seed: '07'.repeat(32), hash: 'ab'.repeat(32), need: 1, holdBells: 144, flags: [flag(holder)], progress: [{ nation: holder, held: 1, own: holder === VIEWER ? 1 : 0, captured: holder === VIEWER ? 0 : 1, capturedLong: 0, need: 1, reachAt: holder === VIEWER ? null : 236 }] },
  achievements: [],
});
/** A fogged page with a village. `keeps`: the page's keep map (empty = a `--wide` rim keep the page does not hold). */
function world({ keeps = new Map(), events = [], storage = memStore(), anchors = [], holder = TAKER, bell = 100 } = {}) {
  const survey = sv([...homeSight(), ...anchors]);
  const overviews = new Map([[2, { ring: 2, bell, provinces: [rec(2, 0, { control: VIEWER }), rec(-2, 0, { keepTile: KEEP, keepTroops: 288, control: holder })] }]]);
  F.createFogger({ storage })({ active: true, survey, overviews, viewer: VIEWER, terrainOf, memKey: 'w' });
  F.viewKeeps(keeps);
  return { season: { seasonId: '11' }, pin: { programId: 'P' }, citizen: { faction: VIEWER }, wallet: { address: 'W' }, survey, overviews, holdings: [{ p: 2, q: 0, site: 0 }], conquest: { keeps, events } };
}
const run = f => { setLang('ja'); try { return f(); } finally { F.resetFogNow(); setLang('ja'); } };
const taken = (from, to, bell, seq = String(bell)) => ({ kind: 'keep_taken', seq, bell, p: -2, q: 0, from, to });

test('LP14-3 (--wide: the keep is not in the page\'s keep map): a flag keep the viewer\'s nation lost is told with who took it and when, not "not seen yet"', () => run(() => {
  // main: no entry in the keep map and the judge's holder is no longer the viewer's nation → 「まだ見ていません」
  const never = UI.seenFlag(world(), flag(TAKER));
  assert.equal(never.seen, 'never', 'without the capture record: its place only (as on main)');
  const FS = world({ events: [taken(VIEWER, TAKER, 92)] });
  const f = UI.seenFlag(FS, flag(TAKER));
  assert.deepEqual([f.seen, f.holder, f.lostAt], ['memory', TAKER, 92]);
  // no live fact: no timer, no siege, no since
  assert.deepEqual([f.since, f.longAt, f.contender, f.progress, f.required], [null, null, null, 0, 0]);
  const s = text(UI.render(FS, { read: 'ok', goals: answer(TAKER) }));
  assert.match(s, /州 -2,0 · 持ち主 アステル · あなたの国が失ったとき（第92ターン）の持ち主です/);
  assert.doesNotMatch(s, /まだ見ていません|包囲中|満たすまで/);
  assert.match(String(UI.render(FS, { read: 'ok', goals: answer(TAKER) })), /data-seen="memory" data-lost-at="92"/);
  setLang('en');
  assert.match(text(UI.render(FS, { read: 'ok', goals: answer(TAKER) })), /Province -2,0 · held by Aster · holder when your nation lost it \(turn 92\)/);
}));

test('LP14-3: the capture is the viewer\'s knowledge only when its nation took part; a later capture among others stays hidden; a regained keep is not "lost"', () => run(() => {
  // the keep changed hands again among other nations afterwards (out of sight): the last thing the viewer saw is still its own loss
  const again = world({ events: [taken(VIEWER, TAKER, 92), taken(TAKER, OTHER, 97)] });
  assert.deepEqual([UI.seenFlag(again, flag(OTHER)).holder, UI.seenFlag(again, flag(OTHER)).lostAt], [TAKER, 92], 'the judge\'s live holder (OTHER) is not told');
  // a capture between two other nations alone tells the viewer nothing
  assert.equal(UI.seenFlag(world({ events: [taken(TAKER, OTHER, 97)] }), flag(OTHER)).seen, 'never');
  assert.equal(UI.lostFlag(world({ events: [taken(TAKER, OTHER, 97)] }), flag(OTHER)), null);
  // regained: the judge's holder is the viewer's nation → live (LP13-11's rule), and the old loss is not the last word
  const back = world({ events: [taken(VIEWER, TAKER, 92), taken(TAKER, VIEWER, 99)], holder: VIEWER });
  assert.equal(UI.lostFlag(back, flag(VIEWER)), null);
  assert.equal(UI.seenFlag(back, flag(VIEWER)).seen, 'live');
  // the events not read yet (null): nothing is assumed
  assert.equal(UI.lostFlag({ citizen: { faction: VIEWER }, conquest: { events: null } }, flag(TAKER)), null);
}));

test('LP14-3 (a world whose keep map remembers the keep): the memory of the viewer\'s nation holding it does not outlive the loss; a later sight does', () => run(() => {
  const storage = memStore();
  // turn 80: the viewer's nation holds it (its own keeps are always known → remembered as its own)
  world({ storage, keeps: new Map([['-2,0', liveKeep(VIEWER, 80)]]), anchors: KNOWN(), holder: VIEWER, bell: 80 });
  // turn 92: lost; the keep is out of sight (surveyed only)
  const keeps = new Map([['-2,0', liveKeep(TAKER, 100)]]);
  const stale = world({ storage, keeps, anchors: KNOWN() });
  const main = UI.seenFlag(stale, flag(TAKER));
  assert.deepEqual([main.seen, main.holder, main.lostAt], ['memory', VIEWER, undefined], 'main: 「持ち主 ダンマール（あなたの国）· 前に見たときの持ち主です」 after the loss');
  const FS = world({ storage, keeps, anchors: KNOWN(), events: [taken(VIEWER, TAKER, 92)] });
  const f = UI.seenFlag(FS, flag(TAKER));
  assert.deepEqual([f.seen, f.holder, f.lostAt], ['memory', TAKER, 92]);
  assert.doesNotMatch(text(UI.render(FS, { read: 'ok', goals: answer(TAKER) })), /あなたの国）/);
}));

test('LP14-3: before the first village nothing is told (verify-pr198\'s rule stands), and without the fog everything is', () => run(() => {
  const FS = world({ events: [taken(VIEWER, TAKER, 92)] });
  F.resetFogNow();
  assert.equal(UI.seenFlag({ ...FS, holdings: [], localPlay: { on: true } }, flag(TAKER)).lostAt, undefined);
  assert.equal(UI.seenFlag({ ...FS, localPlay: null }, flag(TAKER)).seen, 'live');
}));

// ------------------------------------------------------------------ LP14-4: the clash report's check
test('LP14-4: the check accepts the kernel the page loaded for a coexist world (the one alias), and only when the caller names it', async () => {
  const { verifyClash } = await import('../../permutation-server/web/frontier/screens/report.mjs');
  const { COEXIST_LANE } = await import('../../permutation-server/web/frontier/flocalplay-lane.mjs');
  const season = { rulesetHash: Uint8Array.from(Buffer.from(COEXIST_LANE.rulesetHash, 'hex')) };
  const kernel = { rulesetHash: () => COEXIST_LANE.kernelRulesetHash };
  const herald = { bellRegion: async () => ({ ok: false, code: 'NoBellRecord' }) };
  const main = await verifyClash({ p: 0, q: 0, bell: 5, clash: { report: {}, inputs: null }, herald, kernel, clock: {}, season });
  assert.deepEqual(main.steps.kernel, { ok: false, why: 'RulesetMismatch' }, 'main: every clash of a --coexist world stopped here → 「確かめられませんでした」');
  const fixed = await verifyClash({ p: 0, q: 0, bell: 5, clash: { report: {}, inputs: null }, herald, kernel, clock: {}, season, kernelRuleset: COEXIST_LANE.kernelRulesetHash });
  assert.deepEqual(fixed.steps.kernel, { ok: true });
  // a kernel of any other hash is still refused, and a malformed name is ignored (the Season's own hash stands)
  const other = await verifyClash({ p: 0, q: 0, bell: 5, clash: { report: {}, inputs: null }, herald, kernel: { rulesetHash: () => 'ff'.repeat(32) }, clock: {}, season, kernelRuleset: COEXIST_LANE.kernelRulesetHash });
  assert.equal(other.steps.kernel.why, 'RulesetMismatch');
  const bad = await verifyClash({ p: 0, q: 0, bell: 5, clash: { report: {}, inputs: null }, herald, kernel, clock: {}, season, kernelRuleset: 'not-a-hash' });
  assert.equal(bad.steps.kernel.why, 'RulesetMismatch');
  // the page passes flocalplay-lane.mjs's answer, the same one it loads the kernel by
  const app = read('permutation-server/web/frontier/app.mjs');
  assert.match(app, /kernel: seasonKernel, clock: FS\.clock, season: FS\.season,\s+kernelRuleset: FS\.season\?\.rulesetHash \? kernelRulesetFor\(FS\.season\.rulesetHash\) : null \}\);/);
});

test('LP14-4: a record that does not say what was left of a side is checked on open; a whole record waits for the press', async () => {
  const { outcomeUnknown } = await import('../../permutation-server/web/frontier/screens/report.mjs');
  const arrival = fate => ({ present: 1, hostId: 1n, faction: 2, unit: 0, troops: 316_000, stamina: 100, stance: 1, retreat: 0, fate, troopsAfter: fate ? 242_000 : 0, tile: 26 });
  const rep = fate => ({ p: -1, q: 1, bell: 20, clash: { report: {}, inputs: { arrivals: [arrival(fate)] } }, before: null, after: null });
  assert.equal(outcomeUnknown(rep(0)), true, '「316 → —」: no fate written, nothing after');
  assert.equal(outcomeUnknown(rep(1)), false, 'the program wrote what was left');
  assert.equal(outcomeUnknown({ ...rep(0), verify: { result: 'unchecked' } }), false, 'checked once: not again by itself');
  assert.equal(outcomeUnknown({ p: 0, q: 0, bell: 1, error: 'NoRecord' }), false);
  const app = read('permutation-server/web/frontier/app.mjs');
  assert.match(app, /if \(r\.ok && FS\.report === open && reportWorld\(\) === world && reportScreen\.outcomeUnknown\(open, mineOf\(FS\.holdings\)\)\) verifyReport\(\);/);
});

// ------------------------------------------------------------------ LP14-6: the first building's 60 seconds
test('LP14-6: only the six production buildings carry the first-building stamp and its 60 seconds; a workshop keeps its own time', async () => {
  const { buildOffers, buildSecs, ITEM_WALLS } = await import('../../permutation-server/web/frontier/hud/rulebook.mjs');
  const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 0n, frac: 0n });
  const holding = flags => ({ p: 2, q: 3, site: 1, gen: 4, tier: 0, faction: 1, walls: 0, flags, queue: [], stores: Array.from({ length: 8 }, () => store(5000)) });
  const offers = buildOffers(holding(2), { now: 1000, have: Array(8).fill(5000), s1: true, workshop: true });
  const six = offers.filter(o => o.kind === 'building' && o.item < ITEM_WALLS), shop = offers.find(o => o.item === 8);
  assert.equal(six.length, 6);
  assert.ok(six.every(o => o.intro === true && o.secs === 60));
  assert.deepEqual([shop.intro, shop.secs], [false, buildSecs(1)], 'main: {intro: true, secs: 60} — the row said "1:00 First building", the build took 90 minutes');
  // without the flag nothing is stamped
  assert.ok(buildOffers(holding(0), { now: 1000, have: Array(8).fill(5000), s1: true, workshop: true }).every(o => !o.intro));
  // the program's rule, as read
  assert.match(read('permutation-frontier/src/proc/holding.rs'), /let intro = x\.item < catalog::ITEM_WALLS && \{/);
});

// ------------------------------------------------------------------ LP14-7: a host that only stands is not an arrival
test('LP14-7: a CLASH record with no engagement and no arrival is not told; a real arrival nobody fought still is, once', async () => {
  const FEED = await import('../../permutation-server/web/frontier/hud/feed.mjs');
  setLang('ja');
  const base = { nowBell: 40, chain: { now: () => 0 }, holdings: [{ p: 2, q: 0, site: 3, state: 1, tier: 0, queue: [] }], incoming: [], chronicle: [], marches: [] };
  const s0 = FEED.snapshot(base);
  const zero = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
  const clash = (bell, fates) => ({ record: { name: 'CLASH', p: 2, q: 0, bell, engagements: 0, ...(fates ? { fates } : {}) } });
  // a host stands on a tile of the province: one record a turn, nothing arrived (live: bells 26, 44 of the coexist world)
  const still = FEED.diffFeed(s0, FEED.snapshot({ ...base, nowBell: 44, chronicle: [41, 42, 43].map(b => clash(b, zero)) }));
  assert.deepEqual(still, [], 'main: three lines 「…に軍勢が着きました。戦いはありませんでした」, one a turn');
  // an arrival that stays (fate 1 in its slot) and meets nobody: told
  const came = FEED.diffFeed(s0, FEED.snapshot({ ...base, nowBell: 44, chronicle: [clash(42, zero), clash(43, { ...zero, 0: 1 })] }));
  assert.equal(came.length, 1);
  assert.match(came[0].text, /に軍勢が着きました。戦いはありませんでした（ターン 43）$/);
  // a record without `fates` (an older herald) is told as before
  assert.equal(FEED.diffFeed(s0, FEED.snapshot({ ...base, nowBell: 44, chronicle: [clash(43, null)] })).length, 1);
  // and a fight is a fight
  const fight = FEED.diffFeed(s0, FEED.snapshot({ ...base, nowBell: 44, chronicle: [{ record: { name: 'CLASH', p: 2, q: 0, bell: 43, engagements: 2, fates: zero } }] }));
  assert.deepEqual(fight.map(x => x.kind), ['battle']);
});

// ------------------------------------------------------------------ LP14-12: the keep row's time on a fast clock
test('LP14-12: the way to a keep says real time on a faster TEST clock (as the World goals card does), the chain\'s minutes at 1×', async () => {
  const { keepRouteLine } = await import('../../permutation-server/web/frontier/screens/conquest.mjs');
  const { setTermsPace } = await import('../../permutation-server/web/frontier/seasonterms.mjs');
  const route = { hexes: 12, provinces: [{}, {}, {}], secs: 1440 };
  try {
    setLang('en');
    setTermsPace(() => 1);
    assert.equal(keepRouteLine(route), '12 tiles · 3 provinces · about 24 min');
    setTermsPace(() => 60);
    assert.equal(keepRouteLine(route), '12 tiles · 3 provinces · about 24 seconds of real time in this world', 'main: "about 24 min" at ×60');
    assert.equal(keepRouteLine({ hexes: 1, provinces: [{}], secs: 120 }), '1 tile · 1 province · about 2 seconds of real time in this world');
    setTermsPace(() => null);
    assert.equal(keepRouteLine(route), '12 tiles · 3 provinces · about 24 minutes of game time', 'a fast clock whose pace is not known yet: game time, said so');
    setLang('ja');
    setTermsPace(() => 60);
    assert.equal(keepRouteLine(route), '12 マス · 3 州 · この世界の実時間で約 24 秒');
  } finally { setTermsPace(() => 1); setLang('ja'); }
});

// ------------------------------------------------------------------ LP14-15: the W2 step's notice
test('LP14-15: a landed W2 step is told in the page\'s language, not with the planner\'s English log words', async () => {
  const { wideHostDoneText } = await import('../../permutation-server/web/frontier/controller.mjs');
  try {
    setLang('ja');
    const train = { kind: 'decision', name: 'WideTrain', n: 100, village: { p: '-64', q: '-65' } };
    assert.equal(wideHostDoneText(train), '広い土地の村（州 -64,-65）で槍兵 100 を訓練しました。');
    assert.equal(wideHostDoneText({ kind: 'decision', name: 'WideMuster', troops: 100, village: { p: '-64', q: '-65' } }), '広い土地の村（州 -64,-65）で槍兵 100 の軍勢の編成を命じました。');
    assert.equal(wideHostDoneText({ kind: 'decision', name: 'WideDepart', troops: 100, arrive: 293, to: { p: '-64', q: '-66', holder: 1 } }), '軍勢（兵 100）が州 -64,-66 の砦へ進軍しました。到着はターン 293 です。');
    assert.doesNotMatch([train].map(wideHostDoneText).join(''), /[A-Za-z]{3,}/, 'no English sentence on a Japanese page');
    setLang('en');
    assert.equal(wideHostDoneText(train), 'Trained 100 Spearmen at the wide-land village (province -64,-65).');
    assert.equal(wideHostDoneText({ name: 'Other' }), "The wide-land village's next step was sent.");
  } finally { setLang('ja'); }
  assert.doesNotMatch(read('permutation-server/web/frontier/controller.mjs'), /say: \(\) => d\.why/);
});

// ------------------------------------------------------------------ LP14-14: the board's signer line
test('LP14-14: the Japanese board names the local test wallet in Japanese; the English board keeps its English name; other wallets are untouched', async () => {
  const { toEnglish } = await import('../../workstreams/01-national-strategy/coop/tr.mjs');
  const { COOP_WALLET_NAME } = await import('../../permutation-server/web/frontier/hud/coopboard-local.mjs');
  const ui = read('workstreams/01-national-strategy/coop/coop-ui.mjs');
  assert.ok(ui.includes(`const LOCAL_TEST_WALLET = '${COOP_WALLET_NAME}';`), 'the board knows the name the page key gives itself');
  assert.match(ui, /\$\('who'\)\.textContent = `署名する人：\$\{short\(c\.address\)\}（\$\{walletWords\(c\.name\)\}）`;/);
  // (verify-pr217: the wallet chooser's row on the same board said the English name too — live, JA board; same words there)
  assert.ok(ui.includes('>${esc(walletWords(e.name))}${e.why'), 'the chooser row names the wallet with the same words');
  assert.equal(toEnglish('このページのテスト用の鍵（メモリのみ・協力の記録だけに署名）'), COOP_WALLET_NAME);
  const ja = '署名する人：GMqY…XsTU（このページのテスト用の鍵（メモリのみ・協力の記録だけに署名））';
  assert.doesNotMatch(ja.replace('GMqY…XsTU', ''), /[A-Za-z]/);
  assert.equal(toEnglish(ja), `Signer: GMqY…XsTU (${COOP_WALLET_NAME})`);
  assert.equal(toEnglish('署名する人：GMqY…XsTU（Phantom）'), 'Signer: GMqY…XsTU (Phantom)');
});

// ------------------------------------------------------------------ LP14-5 / LP14-8 / LP14-9 / LP14-11 / LP14-13 / LP14-15 (layout and wording, as written)
test('LP14-5: the keep line of a clash names the besieger with its count', () => {
  const src = read('permutation-server/web/frontier/screens/report.mjs');
  assert.ok(src.includes('いまの保持者 ${holder}。${factionName(stake.contender)}が包囲中：${fmtNum(stake.progress)}/${fmtNum(stake.required)} ターン（すべて満たすと奪取）`'));
  assert.ok(!src.includes('、奪取まで ${fmtNum(stake.progress)}'));
  const en = read('permutation-server/web/lang/en-frontier-play.mjs');
  assert.ok(en.includes("held now by {2}. {3} has besieged it for {4} of the {5} turns a capture takes'"));
  assert.ok(!en.includes('turns toward its capture'));
});

test('LP14-8 / LP14-9 / LP14-13: the layout rules', () => {
  const css = read('permutation-server/web/frontier/frontier.css');
  // LP14-8: drawer open, nothing in hand, 1100–1399: the map's keys stand above the dock's row
  assert.ok(css.includes('body[data-drawer="open"][data-doc=""]:not([data-hand="village"], [data-hand="host"]) .map-tools { bottom: calc(var(--dock-h) + 2 * var(--edge)); }'));
  // LP14-9: the guide pill's parts stand closer at that width
  assert.ok(css.includes('@media (min-width: 1100px) and (max-width: 1399px) { .strip-r .next-btn { gap: 5px; padding: 0 5px 0 3px; } .strip-r .next-kicker { padding-right: 5px; letter-spacing: .02em; } }'));
  // LP14-13: a milestone's banner steps back while a card of the bar is open
  assert.ok(css.includes('@media (min-width: 760px) { body:has(#hand-pop[data-mode="card"]:not([hidden])) .mile-banner { visibility: hidden; } }'));
});

test('LP14-11: once a nation is chosen the confirm line stays that nation\'s while the pointer rests on another banner', () => {
  const app = read('permutation-server/web/frontier/app.mjs');
  assert.ok(app.includes('function nationFocus(faction, picked = chosenNation()) {'));
  assert.ok(app.includes('const look = Number.isInteger(picked) ? picked : f;'));
  assert.ok(app.includes("panel.dataset.look = look === null ? '' : String(look);"));
  // the look is set before the "same nation as before" return, so a click on the banner under the pointer shows its line
  const body = app.slice(app.indexOf('function nationFocus('), app.indexOf('function mountNationFocus('));
  assert.ok(body.indexOf('panel.dataset.look') < body.indexOf('if (f === nationShown) return;'));
});

test('LP14-15: a build ring that would land on its own village\'s plate is left out', () => {
  const src = read('permutation-server/web/frontier/map/plates.mjs');
  assert.ok(src.includes('plateAt.set(key(u), { x: ax + lean - S.w / 2 + at.dx, y: ay - leader * k - S.h + at.dy, w: S.w, h: S.h });'));
  assert.ok(src.includes('if (move && pb && at.x + move.dx + rr > pb.x && at.x + move.dx - rr < pb.x + pb.w && at.y + move.dy + rr > pb.y && at.y + move.dy - rr < pb.y + pb.h) continue;'));
});

// ------------------------------------------------------------------ found with LP14-3: the remembered holder of a keep
test('keep memory: an overview record without `control` (read before the control record is laid over it) does not erase the remembered holder', () => run(() => {
  const mem = F.createFogMemory({ storage: memStore() });
  mem.use('w');
  const h = tileHex(-2, 0, KEEP);
  const survey = sv([...homeSight(), { q: h.q, r: h.r, radius: 0, level: S.L3, kind: 'host' }]);
  const whole = rec(-2, 0, { keepTile: KEEP, keepTroops: 288, control: OTHER, heartland: false });
  F.fogProvince(whole, { survey, mem, sites: SITES, viewer: VIEWER, bell: 90 });
  assert.deepEqual(mem.get('-2,0').k, { t: KEEP, n: 288, c: OTHER, h: false, b: 90 });
  const { control: _c, heartland: _h, ...bare } = whole;
  F.fogProvince(bare, { survey, mem, sites: SITES, viewer: VIEWER, bell: 91 });
  assert.deepEqual(mem.get('-2,0').k, { t: KEEP, n: 288, c: OTHER, h: false, b: 90 }, 'main: {c: null, h: null, b: 91} — live, world c3: 「持ち主なし · 前に見たときの持ち主です」');
  // a record that does say another holder is taken
  F.fogProvince({ ...whole, control: TAKER }, { survey, mem, sites: SITES, viewer: VIEWER, bell: 92 });
  assert.deepEqual([mem.get('-2,0').k.c, mem.get('-2,0').k.b], [TAKER, 92]);
}));
