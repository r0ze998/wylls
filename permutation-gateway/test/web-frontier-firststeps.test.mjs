// The first session's waits and firsts (hud/firststeps.mjs and its wiring; the first-session review of 2026-11-13,
// after the natural trial): the forming host's phase read from the real turn pipeline (clock.mjs) — the trial's own
// timeline replayed —, the while-waiting suggestion, the guide holding the muster step until the host stands, the
// march answer of the local-play contract (FS.localMarch), the first-host milestone said once, the idle muster read
// as done, the order list's line, and the English of every new sentence.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { bellEnd } from '../../permutation-server/web/frontier/clock.mjs';
import { KEEP_4_M1, STANDINGS_BEFORE, keepAt, recordAt } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import * as F from '../../permutation-server/web/frontier/hud/firststeps.mjs';
import * as M from '../../permutation-server/web/frontier/hud/milestones.mjs';
import { waitText, hostWaits } from '../../permutation-server/web/frontier/hud/keephand.mjs';
import { orderText } from '../../permutation-server/web/frontier/hud/turnlist.mjs';
import { conquestGuide, conquestObjective } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { hostRows } from '../../permutation-server/web/frontier/screens/host.mjs';

afterEach(() => setLang('ja'));
const CJK = /[぀-ヿ㐀-鿿]/;
// (the local-march contract's reasons, in its order: docs/integration/CLAUDE-LOCAL-MARCH-CONTRACT-SPEC-20261113.md, flocalplay-march.mjs
// LOCAL_MARCH_REASONS. Written out here so this test runs where that module is not merged yet)
const LOCAL_MARCH_REASONS = Object.freeze(['LocalMarchNoCapability', 'LocalMarchNotReady', 'LocalMarchGate', 'LocalMarchWideHolding', 'LocalMarchHeld', 'open']);
// (the play screen's banned machinery words: web-frontier-cards.test.mjs BANNED_EN)
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;

// ------------------------------------------------------------------ fixtures (the conquest-hand test's shapes)
const T0 = 1_794_539_760;   // the trial's turn 0 began 12:16:00
const at = (mm, ss = 0) => T0 + (mm - 16) * 60 + ss;   // 12:mm:ss
const CLOCK = { genesisTs: T0, drand: { genesis: T0 - 3000, period: 3 }, margin: 30, window: () => 600, endBell: 999, continuous: false };
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n),
  stores: Array.from({ length: 8 }, () => ({ value: 0n, rate: 0n, cap: 1_000_000n, t0: 0n })), reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const HID = hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 });
const entry = (extra = {}) => ({ id: HID, unit: 0, state: 1, tile: 20, troops: 100000, staminaValue: 120, staminaBell: 0, readyBell: 0, pendOp: 0, fromBell: 1, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const world = ({ bell = 0, now = at(20, 30), entries = [entry({ state: 2, fromBell: 1 })], resolvedNext = 0, formingBells = [], extra = {} } = {}) => ({
  mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: [HOME()], nowBell: bell, clock: CLOCK, chain: { now: () => now }, land: { stage: 'final' },
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext, entries, ticketCohorts: [] } }]]), formingBells, marches: [], orders: [], ui: { dismissed: [] },
  conquest: { status: 'ready', keeps: new Map([['4,-1', keepAt(KEEP_4_M1, bell)]]), history: new Map([['4,-1', recordAt(KEEP_4_M1, bell)]]), standings: STANDINGS_BEFORE, final: null, events: [] }, ...extra });
const rowOf = FS => hostRows(FS)[0];
const A = bellEnd(T0, 0);   // the turn-0 anchor (posted at the turn's end, 12:26:00)
const item = facts => [{ host: String(HID), bell: 0, facts }];

// ------------------------------------------------------------------ the forming host's phase, from the real pipeline
test('the trial timeline reads as the pipeline\'s real phases, with a countdown only where the pipeline names a time', () => {
  const open = world();
  assert.deepEqual(F.formingPhase(open, rowOf(open)), { phase: 'turnEnding', until: A }, '12:20:30: the muster turn still runs');
  // the turn has ended but the page holds no herald facts of it: nothing is guessed
  const noFacts = world({ bell: 1, now: at(26, 5) });
  assert.deepEqual(F.formingPhase(noFacts, rowOf(noFacts)), { phase: 'unknown', until: null });
  const key = world({ bell: 1, now: at(26, 5), formingBells: item({ anchor: null, archive: null, seed: false, resolvedNext: 0 }) });
  assert.deepEqual(F.formingPhase(key, rowOf(key)), { phase: 'awaitingKey', until: null }, 'no anchor yet: no countdown');
  const draw = world({ bell: 1, now: at(30), formingBells: item({ anchor: { a: A }, seed: false, resolvedNext: 0 }) });
  assert.deepEqual(F.formingPhase(draw, rowOf(draw)), { phase: 'fairDraw', until: A + 600 });
  const seed = world({ bell: 1, now: at(36, 30), formingBells: item({ anchor: { a: A }, seed: false, resolvedNext: 0 }) });
  assert.equal(F.formingPhase(seed, rowOf(seed)).phase, 'awaitingSeed');
  const proc = world({ bell: 1, now: at(37, 12), formingBells: item({ anchor: { a: A }, seed: true, resolvedNext: 0 }) });
  assert.deepEqual(F.formingPhase(proc, rowOf(proc)), { phase: 'processing', until: null });
  const settled = world({ bell: 2, now: at(37, 40), formingBells: item({ anchor: { a: A }, seed: true, resolvedNext: 1 }) });
  assert.equal(F.formingPhase(settled, rowOf(settled)).phase, 'stood');
  // a facts item of another host or turn is not this host's
  const other = world({ bell: 1, now: at(30), formingBells: [{ host: '1', bell: 0, facts: { anchor: { a: A } } }] });
  assert.equal(F.formingPhase(other, rowOf(other)).phase, 'unknown');
});

test('the forming line says the phase and its countdown, never "next turn", in both languages', () => {
  const open = world();
  assert.match(F.formingLine(open, rowOf(open)), /このターンの終わり（あと 5:30）/);
  setLang('en');
  const lines = [
    world(),
    world({ bell: 1, now: at(26, 5), formingBells: item({ anchor: null, resolvedNext: 0 }) }),
    world({ bell: 1, now: at(30), formingBells: item({ anchor: { a: A }, resolvedNext: 0 }) }),
    world({ bell: 1, now: at(36, 30), formingBells: item({ anchor: { a: A }, resolvedNext: 0 }) }),
    world({ bell: 1, now: at(37, 12), formingBells: item({ anchor: { a: A }, seed: true, resolvedNext: 0 }) }),
    world({ bell: 1, now: at(26, 5) }),
  ].map(s => F.formingLine(s, rowOf(s)));
  assert.equal(lines[0], 'Forming up: 100 Spearmen. After this turn ends (in 5:30), its seals are opened, the draw comes out and the turn is resolved; then it stands.');
  assert.match(lines[1], /the key that opens its seals is awaited/);
  assert.match(lines[2], /closes in 6:00/);
  assert.match(lines[3], /Waiting for the draw that decides the turn \(due in/);
  assert.match(lines[4], /being resolved/);
  assert.match(lines[5], /once the turn it was formed in is resolved/);
  for (const l of lines) assert.match(l, /^Forming up: 100 Spearmen\. /, l);
  for (const l of lines) { assert.doesNotMatch(l, CJK, l); assert.doesNotMatch(l, /next turn|minutes?\b/i, l); assert.doesNotMatch(l, BANNED_EN, l); }
});

test('the wait line of the keep panel and the order list follow the forming phase', () => {
  const draw = world({ bell: 1, now: at(30), formingBells: item({ anchor: { a: A }, resolvedNext: 0 }) });
  const w = hostWaits(draw)[0];
  assert.ok(w && (w.why === 'settling' || w.why === 'forming'));
  assert.match(waitText(w, draw), /封が開けられています/);
  assert.doesNotMatch(waitText(w), /封が開けられています/, 'without FS the old sentence stands (other callers unchanged)');
  setLang('en');
  assert.equal(orderText(draw, { kind: 'muster', unit: 0, troops: 100 }), 'Forming up: 100 Spearmen — stands once this turn is resolved');
});

// ------------------------------------------------------------------ while it forms
test('while waiting: troops toward the keep first, then a free building slot', () => {
  assert.deepEqual(F.whileWaiting({ need: 180, troops: 100, canTrain: 300, freeSlots: 2, buildBlocked: false }), { kind: 'train', count: 80, short: 80 });
  assert.deepEqual(F.whileWaiting({ need: 180, troops: 100, reserve: 100, canTrain: 300, freeSlots: 2, buildBlocked: false }), { kind: 'build', free: 2 });
  assert.equal(F.whileWaiting({ need: 180, troops: 100, canTrain: 0, freeSlots: 0 }), null);
  setLang('en');
  assert.equal(F.whileWaitingLine({ kind: 'build', free: 1 }), 'While you wait: 1 building slot is free. Buildings raise what the village makes each hour.');
  assert.match(F.whileWaitingLine({ kind: 'build', free: 2 }), /2 building slots are free/);
  assert.match(F.whileWaitingLine({ kind: 'train', count: 80, short: 80 }, 0), /^While you wait: train 80 Spearmen more for a keep in reach\.$/);
});

// ------------------------------------------------------------------ the guide
test('the guide keeps "Form a host" current until the host stands, and leads somewhere useful meanwhile', () => {
  const forming = world();
  assert.equal(conquestGuide(forming).current, 'muster');
  const o = conquestObjective(forming);
  assert.match(o.text, /このターンの終わり（あと 5:30）/);
  assert.ok(['tab', 'cg-go'].includes(o.go.act));
  assert.notEqual(o.go.data.pop, 'muster', 'the press is not "form a host" again');
  const stood = world({ bell: 2, entries: [entry()], resolvedNext: 1 });
  assert.equal(conquestGuide(stood).current, 'march');
});

test('the march answer is the local-play contract\'s FS.localMarch alone; a closed world points at no march', () => {
  assert.equal(F.marchOpenFor({}), true, 'a chain world marches as before');
  assert.equal(F.marchOpenFor({ localPlay: {} }), false, 'local play with no answer yet: closed');
  for (const reason of LOCAL_MARCH_REASONS) {
    const FS = { localPlay: {}, localMarch: { open: reason === 'open', reason, capability: false, ready: false, held: [] } };
    assert.equal(F.marchOpenFor(FS), reason === 'open', reason);
    if (reason !== 'open') assert.ok(F.marchClosedText(FS).length > 0, reason);
  }
  assert.equal(F.marchOpenFor({ localPlay: {}, localMarch: { open: 'true' } }), false, 'only open === true opens');
  setLang('en');
  for (const reason of LOCAL_MARCH_REASONS.filter(r => r !== 'open')) {
    const t = F.marchClosedText({ localPlay: {}, localMarch: { open: false, reason } });
    assert.doesNotMatch(t, CJK, t); assert.doesNotMatch(t, /soon/i, t);
  }
  assert.match(F.marchClosedText({ localPlay: {}, localMarch: { open: false, reason: 'LocalMarchHeld' } }), /will not be sent again/);
  // the guide on a local world whose answer is closed: the host stands, the press opens training or the keeps — never a march
  const local = world({ bell: 2, entries: [entry()], resolvedNext: 1, extra: { localPlay: {}, localMarch: { open: false, reason: 'LocalMarchNotReady', capability: true, ready: false, held: [] } } });
  const o = conquestObjective(local);
  assert.equal(o.id, 'march');
  assert.match(o.text, /^Your host of 100 Spearmen stands\. Marching from this page is not available in this world now\. /);
  assert.doesNotMatch(o.text, CJK);
  assert.ok(o.go.data.pop === 'train' || o.go.data.pop === 'keeps' || o.go.act === 'tab');
  setLang('ja');
  assert.match(conquestObjective(local).text, /このページからの進軍はいま使えません/);
});

// ------------------------------------------------------------------ the first host, once
test('the first host is a milestone only once it stands in the record, said once, and not after a march', () => {
  const ids = FS => M.reachedMilestones(FS).map(m => m.id);
  assert.ok(!ids(world()).includes('first-host'), 'a forming host is not a formed one');
  const stood = world({ bell: 2, entries: [entry()], resolvedNext: 1 });
  const m = M.reachedMilestones(stood).find(x => x.id === 'first-host');
  assert.ok(m);
  assert.equal(m.troops, 100);
  // seen once: the next check finds nothing new (a reconnect reads the same stored record)
  const one = M.newMilestones({ v: 1, seen: {} }, M.reachedMilestones(stood), 2);
  assert.ok(one.fresh.some(x => x.id === 'first-host'));
  assert.equal(M.newMilestones(one.record, M.reachedMilestones(stood), 3).fresh.length, 0);
  // a page's first load records it quietly
  assert.equal(M.newMilestones(null, M.reachedMilestones(stood), 2).fresh.length, 0);
  // a viewer already marching gets no late banner
  assert.ok(!ids({ ...stood, marches: [{}] }).includes('first-host'));
  setLang('en');
  const banner = String(M.renderBanner(m, 0));
  assert.match(banner, /Your first host stands/);
  assert.match(banner, /100 Spearmen/);
});

test('the first host\'s next goal fits the world', () => {
  assert.equal(F.firstHostNext({ troops: 100, need: 180, marchOpen: true }), 'addTroops');
  assert.equal(F.firstHostNext({ troops: 200, need: 180, marchOpen: true }), 'seeKeeps');
  assert.equal(F.firstHostNext({ troops: 100, need: 180, marchOpen: false }), 'growToward');
  assert.equal(F.firstHostNext({ troops: 200, need: 180, marchOpen: false }), 'keepsOnly');
  assert.equal(F.firstHostNext({ troops: 100, need: null, marchOpen: false }), null);
  setLang('en');
  for (const n of ['seeKeeps', 'addTroops', 'growToward', 'keepsOnly']) {
    const t = F.firstHostNextLine(n, { unit: 0, need: 180 });
    assert.match(t, /^Next goal: /); assert.doesNotMatch(t, CJK, t); assert.doesNotMatch(t, /soon/i, t);
  }
});

// ------------------------------------------------------------------ the idle muster
test('"Form a host" with an empty reserve right after the first host reads as done', () => {
  assert.equal(F.musterIdleCode({ reserve: 0, hosts: 1 }), 'allFormed');
  assert.equal(F.musterIdleCode({ reserve: 0, hosts: 0 }), null);
  assert.equal(F.musterIdleCode({ reserve: 50, hosts: 1 }), null, 'troops left in reserve: not "all formed"');
  setLang('en');
  assert.equal(F.allFormedText(), 'Every reserve troop is in a host. Train more to form another');
  assert.match(F.musterRuleText(), /stands once this turn is resolved/);
});
