// fix-loop32: loop-play32's non-design findings on the walletless demo.
//   BREAK-1  the player's own defensive clashes (a castle host attacked, pushed back, lost) are told and listed
//   BREAK-3  the six-step guide's last step is the flag castle in the demo's goal world
//   BREAK-4  a camp cleared by holding (attackers_hold) stays "Victory" after "Verify in this browser"
//   BREAK-6  the zoomed-out host flag of Ember (white) is readable
//   BREAK-7  the demo's map markers sit in the page's <main>, under the drawer
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import { factsOf, onboardingState, ARRIVAL_STEPS, GOAL_STEPS, demoCastles, holdsRivalCastle } from '../../permutation-server/web/frontier/onboarding.mjs';
import { objectiveModel, render } from '../../permutation-server/web/frontier/screens/onboarding.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { outcomeRows, rowsWithOutcome, summaryOf, verdictOf, NEUTRAL } from '../../permutation-server/web/frontier/screens/report.mjs';
import { SpriteArt } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { NATION_FILL, NATION_ON } from '../../permutation-server/web/frontier/palette.mjs';
import EN from '../../permutation-server/web/lang/en-frontier-play.mjs';

afterEach(() => setLang('ja'));
const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TERRITORY = { territory: { mode: 'arrival-control', authority: 'local-preview' } };

// (BREAK-1, the own-clash watch in the demo: web-frontier-fix-loop32-ownclash.test.mjs — its closure reaches the herald reader)

// ------------------------------------------------------------------ BREAK-3
const home = { p: 2, q: 0, site: 1, gen: 0, tile: 20, state: 2, tier: 0, flags: 0, faction: 0, production: baseProduction(0).map((v, i) => i === 0 ? v + 12000n : v), reserve: Array(8).fill(0), queue: [], transit: [{ state: 1 }] };
const CASTLES = [{ nation: 0, p: 1, q: 0, tile: 30 }, { nation: 1, p: 0, q: 1, tile: 30 }, { nation: 2, p: -1, q: 1, tile: 30 }];
const owners = who => { const o = Array(61).fill(null); o[30] = who; return o; };
const world = ({ goal = { kind: 'flag-castles', need: 3, holdBells: 20, castles: CASTLES }, demo = true, holder = 2, ownHolder = 0 } = {}) => ({
  mode: 'play', sample: { ...TERRITORY, landClaim: true, ...(demo ? { demo: {} } : {}), ...(goal ? { goal } : {}) },
  season: { programVersion: 2 }, citizen: { faction: 0, explores: 0, arrivals: 1 }, holdings: [home], land: { stage: 'final' },
  provinces: new Map([['2,0', { province: { p: 2, q: 0, entries: [], resolvedNext: 10 } }],
    ['1,0', { province: { p: 1, q: 0, entries: [], resolvedNext: 10 }, sampleTerritory: { owners: owners(ownHolder), history: [], changes: [] } }],
    ['-1,1', { province: { p: -1, q: 1, entries: [], resolvedNext: 10 }, sampleTerritory: { owners: owners(holder), history: [], changes: [] } }]]),
  nowBell: 10, chain: { now: () => 1000 }, ui: { dismissed: [] }, ownLand: { player: { tiles: 0 } },
});
const stage = fs => onboardingState(factsOf(fs));

test('BREAK-3 the demo\'s goal world: six steps, the sixth is "Take a flag castle" (not the tile claim), done while the nation holds a rival castle', () => {
  assert.deepEqual(GOAL_STEPS.slice(0, 5), ARRIVAL_STEPS.slice(0, 5));
  assert.equal(GOAL_STEPS.length, ARRIVAL_STEPS.length, 'still six steps and the end');
  const fs = world();
  assert.deepEqual(stage(fs).steps.map(s => s.id), GOAL_STEPS);
  assert.equal(stage(fs).current, 'castle', 'after the first march: the castle');
  // its own nation's castle does not count (Aster holds Aster's castle from the start)
  assert.equal(holdsRivalCastle(fs), false);
  fs.provinces.get('-1,1').sampleTerritory.owners = owners(0);
  assert.equal(holdsRivalCastle(fs), true);
  assert.equal(stage(fs).complete, true, 'Cinder\'s castle held: the guide is done and shows the goal card');
  assert.match(String(render(fs)), /data-demo-goal-guide/);
  // lost again: the guide points at the castles again
  fs.provinces.get('-1,1').sampleTerritory.owners = owners(3);
  assert.equal(stage(fs).current, 'castle');
});

test('BREAK-3 the castle step\'s card, pill and button: EN and JA, it marches (the composer or the hosts), never "season"; elsewhere the claim step as before', () => {
  const fs = world();
  setLang('ja');
  let o = objectiveModel(fs);
  assert.equal(o.id, 'castle');
  assert.equal(o.title, '旗の城を取る');
  assert.equal(`${o.n}/${o.total}`, '5/6');
  assert.match(o.text, /旗の城/);
  assert.ok(['compose', 'tab'].includes(o.go.act), o.go.act);
  assert.equal(guideTarget(fs), null, 'no map target of its own: the goal card has "March here"');
  setLang('en');
  o = objectiveModel(fs);
  assert.equal(o.title, 'Take a flag castle');
  assert.match(o.text, /flag castle/);
  assert.match(String(render(fs)), /Take a flag castle/);
  for (const ja of ['旗の城を取る', 'ほかの国の旗の城へ軍勢を進軍させて取りましょう（左上の目標カードの「ここへ進軍」）。城を取ると、勝利までの保持の時間が数え始めます。']) {
    assert.ok(EN[ja], `EN for ${ja}`);
    assert.doesNotMatch(EN[ja], /season/i);
  }
  assert.doesNotMatch(String(render(fs)), /season|View territory changes/i);
  // a territory world that is not the demo, or a demo world that lists no castles: the six steps as they were
  for (const w of [world({ demo: false }), world({ goal: { kind: 'flag-castles', need: 3, holdBells: 20 } }), world({ goal: null })]) {
    assert.equal(demoCastles(w), null);
    assert.deepEqual(stage(w).steps.map(s => s.id), ARRIVAL_STEPS);
    assert.equal(stage(w).current, 'claim');
  }
});

// (the world's record listing the castles, sample.goal.castles: web-frontier-demo-goal.test.mjs, the world test)

// ------------------------------------------------------------------ BREAK-4
// a camp of 500 met by an arrival of 500: the kernel leaves 402 in the camp's garrison but the attackers hold its tile
const campArgs = { residents: [], arrivals: [{ id: 9n, faction: 0, unit: 0, troops: 500000, posture: 1, retreatBps: 0, tile: 12 }], garrisons: [{ id: 18446744073709551615n, faction: NEUTRAL, troops: 500000, posture: 0, walls: 0, tile: 12 }] };
const campOut = hold => ({ fighters: [{ id: 9n, arrival: true, troops: 444000, stamina: 46, engaged: true, fate: { kind: 'Stays', tile: 12 } }], garrisons: [{ id: 18446744073709551615n, troops: 402000, attackersHold: hold, holders: hold ? 1 : 0, defenderPresent: true }] });
const mine = id => String(id) === '9';

test('BREAK-4 a camp whose tile the attackers hold is cleared in the verified rows too: Victory stays Victory', () => {
  const rows = outcomeRows(campArgs, campOut(true), mine);
  const camp = rows.find(r => r.kind === 'camp');
  assert.deepEqual([camp.before, camp.after, camp.fate], [500, 0, 'Destroyed'], 'the world clears it (rules.mjs / clash_model.rs whole == 0 || attackers_hold)');
  const sum = summaryOf(rows);
  assert.deepEqual([sum.result, sum.foe], ['won', 'camp']);
  setLang('en');
  assert.match(verdictOf(sum).text, /^Victory/);
  // not held: the camp stays, and the report says so
  const held = summaryOf(outcomeRows(campArgs, campOut(false), mine));
  assert.deepEqual([held.result, held.foe], ['held', 'stays']);
  // a village's garrison is never cleared by attackers_hold (only a camp is)
  const vil = outcomeRows({ ...campArgs, garrisons: [{ ...campArgs.garrisons[0], id: 77n, faction: 3 }] }, { ...campOut(true), garrisons: [{ ...campOut(true).garrisons[0], id: 77n }] }, mine).find(r => r.kind === 'garrison');
  assert.deepEqual([vil.after, vil.fate], [402, null]);
});

test('BREAK-4 rowsWithOutcome (the record\'s rows with the recompute laid over): the same rule for a camp', () => {
  const rows = [{ id: 'camp', kind: 'camp', faction: NEUTRAL, before: 500, after: null, tile: 12, fate: null }];
  const o = { fighters: [], garrisons: [{ id: 18446744073709551615n - 1n, troops: 402000, attackersHold: true }] };
  assert.deepEqual(rowsWithOutcome(rows, o, { camp: { gen: 1 } }).map(r => [r.after, r.fate]), [[0, 'Destroyed']]);
  o.garrisons[0].attackersHold = false;
  assert.deepEqual(rowsWithOutcome(rows, o, { camp: { gen: 1 } }).map(r => [r.after, r.fate]), [[402, null]]);
});

// ------------------------------------------------------------------ BREAK-6
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('BREAK-6 the zoomed-out host flag writes its troops in the nation\'s "on" colour: every nation readable (≥ 3:1), Ember too', () => {
  const texts = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  ctx.fillText = (s) => texts.push({ s, color: ctx.fillStyle });
  const hosts = [0, 1, 2, 3, 4, 5].map(f => ({ cx: f * 100, cy: 0, h: { faction: f, troops: 375, stamina: 46 } }));
  SpriteArt.prototype.flags.call({}, ctx, hosts, 0.2);
  assert.equal(texts.length, 6);
  for (const [f, t] of texts.entries()) {
    assert.equal(t.s, '⚔375');
    assert.equal(t.color, NATION_ON[f]);
    assert.ok(contrast(NATION_FILL[f], t.color) >= 3, `nation ${f}: ${contrast(NATION_FILL[f], t.color).toFixed(2)}`);
  }
  assert.ok(contrast(NATION_FILL[4], '#fffaf0') < 1.2, 'what Ember had: ivory on white');
});

// ------------------------------------------------------------------ BREAK-7
test('BREAK-7 the demo\'s map markers (castle flags, camps, travelers) go in the page\'s <main id="frontier">; the goal card steps out of a wide report', () => {
  for (const [f, id] of [['goalhud.mjs', 'flags'], ['camphud.mjs', 'layer'], ['travelhud.mjs', 'marks']]) {
    const s = read(`../demo/src/${f}`);
    assert.match(s, new RegExp(`\\(doc\\.getElementById\\('frontier'\\) \\?\\? doc\\.body\\)\\.appendChild\\(${id}\\);`), f);
    assert.doesNotMatch(s, new RegExp(`doc\\.body\\.appendChild\\(${id}\\);`), f);
  }
  assert.match(read('../../permutation-server/web/frontier/index.html'), /<main id="frontier">/);
  // (only under a wide document — the report, a practice battle: hud/drawer.mjs WIDE. The nation picker is a 'stage'
  //  document, and the goal card stands beside it: hiding it there was caught by the Pages-host play, picker check)
  const hud = read('../demo/src/goalhud.mjs');
  assert.match(hud, /body\[data-doc="wide"\] #demo-goal\{visibility:hidden\}/);
  assert.doesNotMatch(hud, /data-doc="stage"/);
  assert.ok(L);
});
