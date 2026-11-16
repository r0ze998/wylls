// The village a bar card SHOWS and the village its order ACTS ON, after a chip (2026-11-16). SOURCE ONLY — NOT run:
// all new test runs are paused. hud/hand.mjs draws the card of the subject's own village (villageModel → holdingModel
// with activeHolding: sub.holdingIndex), while controller.mjs's build / train / muster / harvest act on activeHolding(FS).
// Path: village A open; a host of A selected on village B's tile (selectHost opens A); the chip of B's own host there,
// then the 「村」 chip (or a second tap on the tile) → handHost(null): the subject is village B, and the open village
// stayed A — B's card, orders for A. app.mjs handHost now opens the subject's village, as selectHost does.
// KEY-FREE, pure data (hud/subject.mjs) plus app.mjs read as text; no request, nothing stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { subjectOf } from '../../permutation-server/web/frontier/hud/subject.mjs';

const village = (p, q, site, tile) => ({ p, q, site, gen: 0, tile, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n),
  stores: [], reserve: Array(8).fill(0), queue: [], transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const A = village(2, 0, 2, 20), B = village(2, 0, 4, 33);   // two villages of the viewer in one province
const host = (o, seq) => ({ id: hostId({ p: o.p, q: o.q, site: o.site, gen: 0, seq }), unit: 0, state: 1, tile: B.tile, troops: 100000, staminaValue: 120, staminaBell: 0, readyBell: 0, pendOp: 0, fromBell: 1 });
const aOnB = host(A, 1), bHome = host(B, 1);   // A's host on B's tile; B's own host at home
const FS0 = () => ({ mode: 'play', holdings: [A, B], activeHolding: 0, nowBell: 2, chain: { now: () => 1000 }, citizen: { faction: 0 },
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 1, entries: [aOnB, bHome], ticketCohorts: [] } }]]),
  selected: { kind: 'tile', p: 2, q: 0, idx: B.tile } });

test('the precondition: with A open, the 「村」 chip on B\'s tile makes village B the subject', () => {
  const FS = { ...FS0(), hand: { host: null, pop: null } };
  const sub = subjectOf(FS);
  assert.equal(sub.kind, 'village'); assert.equal(sub.holdingIndex, 1);
  assert.equal(FS.activeHolding, 0, 'the open village is A: before the fix, B\'s card took A\'s orders');
});

test('a chip of B\'s own host there: the subject is that host, of village B', () => {
  const sub = subjectOf({ ...FS0(), hand: { host: String(bHome.id), pop: null } });
  assert.equal(sub.kind, 'host'); assert.equal(sub.holdingIndex, 1);
});

test('app.mjs handHost opens the subject\'s village (pinned as text); the village orders still read activeHolding', () => {
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const at = a.indexOf('function handHost(id) {'), hh = a.slice(at, a.indexOf('\n}\n', at));
  assert.match(hh, /FS\.hand = \{ host: id \?\? null, pop: null \};[\s\S]*const sub = hand\.subjectOf\(FS\);\n\s+if \(sub && Number\.isInteger\(sub\.holdingIndex\) && sub\.holdingIndex >= 0 && sub\.holdingIndex !== \(FS\.activeHolding \?\? 0\)\) \{ FS\.activeHolding = sub\.holdingIndex; invalidate\('rail'\); \}/);
  assert.match(a, /'hand-host': d => handHost\(d\.host \|\| null\),/);
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(c, /build: d => homeAction\(\(\) => \{\n\s+const h = activeHolding\(FS\), item = num\(d\.item\);/, 'the order reads the open village: why the chip must open the subject\'s');
  assert.match(c, /return act\('Train', \{ v: \{ holding: activeHolding\(FS\) \}/);
});

test('the village plate (home) and the rail (holding-go) that open another village put away a village card of a different village (pinned as text)', () => {
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const at = a.indexOf('function dropOtherVillageCard(i) {'), d = a.slice(at, a.indexOf('\n}\n', at));
  assert.match(d, /const sub = hand\.subjectOf\(FS\);\n\s+if \(sub\?\.kind === 'village' && sub\.holdingIndex !== i\) \{ endPick\(\); FS\.hand = null; FS\.selected = null; FS\.inspectOpen = false; invalidate\('map'\); \}/);
  const home = a.slice(a.indexOf('  home: () => {'), a.indexOf("\n  'holding-go':"));
  assert.match(home, /FS\.activeHolding = i;\n\s+dropOtherVillageCard\(i\);/);
  const hg = a.slice(a.indexOf("  'holding-go': d => {"), a.indexOf('\n  },', a.indexOf("  'holding-go': d => {")));
  assert.match(hg, /FS\.activeHolding = i;\n\s+dropOtherVillageCard\(i\);/);
});

// (2026-11-16, review of 7d45ddbd / f03d3378 — SOURCE ONLY, NOT run) the village switches above do not reach an order
// already being drafted, waiting or in flight: each fixes its own village when it is made (pinned as text).
test('orders fix their village when made; the waiting sends compare their own card and village (pinned as text)', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const fn = name => { const at = c.indexOf(name); return c.slice(at, c.indexOf('\n}\n', at)); };
  // a march draft and its waiting send: the draft's own village; the driver compares the draft itself
  assert.match(fn('function marchNow('), /const h = c\.holding \? holdingByRef\(FS\.holdings, c\.holding\) : activeHolding\(FS\);/);
  assert.match(c, /const same = FS\.compose === card, now = same \? marchNow\(card\)/);
  // the local muster wait: frozen village; the open muster card of that same village, else withdrawn — a cancel when
  // the card was closed, never silent; the send is for the frozen village (musterOrder refuses another)
  assert.match(fn('function musterNow('), /const problems = !sameHolding\(h, activeHolding\(FS\)\) \? \['HoldingMismatch'\]/);
  assert.match(c, /sameCard: n\.open && sameHolding\(card\.holding, n\.holding\)/);
  assert.match(c, /const t = why === 'changed' && FS\.hand\?\.pop !== 'muster' \? MUSTER_WITHDRAWN\.cancel : MUSTER_WITHDRAWN\[why\];/);
  assert.match(fn('function musterOrder('), /if \(holding && !sameHolding\(h, holding\)\) return failed\(\{ code: 'NotOwner' \}\);/);
  // an order in flight: its village and its record's tile are taken at the press
  assert.match(c, /return act\('Train', \{ v: \{ holding: activeHolding\(FS\) \}/);
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(a, /if \(r\?\.ok && FS\.hand\?\.pop && FS\.hand\.pop === from\)/, 'handOrder closes only the card it was given from');
  // the switch helpers touch neither the draft nor a waiting send
  const d = a.slice(a.indexOf('function dropOtherVillageCard(i) {'), a.indexOf('\n}\n', a.indexOf('function dropOtherVillageCard(i) {')));
  assert.doesNotMatch(d, /compose|pendingDriver|musterDriver|musterWait/);
});
