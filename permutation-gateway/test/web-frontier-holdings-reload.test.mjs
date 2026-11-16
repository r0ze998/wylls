// The open village after the viewer's villages are read again (2026-11-16). SOURCE ONLY — NOT run: all new test runs
// are paused. controller.mjs applyMeResult replaces FS.holdings (FS.holdings = me.holdings) and keeps FS.activeHolding,
// a POSITION; fstate.mjs activeHolding falls back to position 0 when the position is out of range. The bar's card
// subject is found by TILE in the new list (hud/subject.mjs subjectOf). So a village lost (or one put before the open
// one) between two reads shifts the positions: the card shows one village and the village orders (controller.mjs
// build / train / muster / harvest: activeHolding(FS)) go to another. Not fixable in app.mjs (the old card stays
// pressable until refresh() redraws at its end; a press handler cannot tell a bar press from the village screen's):
// the contract proposed for controller.mjs is in docs/integration/CLAUDE-VILLAGE-CARD-TARGET-20261116.md — applied there on
// claude/village-card-target-20261116 (the open village kept by identity).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { activeHolding } from '../../permutation-server/web/frontier/fstate.mjs';
import { subjectOf } from '../../permutation-server/web/frontier/hud/subject.mjs';

const village = (p, q, site, tile, order) => ({ p, q, site, gen: 0, tile, order, faction: 0, state: 2, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n),
  stores: [], reserve: Array(8).fill(0), queue: [], transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const A = village(2, 0, 2, 20, 1), B = village(3, 0, 1, 10, 2), C = village(4, 0, 3, 30, 3);
const FS0 = holdings => ({ mode: 'play', holdings, activeHolding: 2, nowBell: 2, chain: { now: () => 1000 }, citizen: { faction: 0 },
  provinces: new Map(), selected: { kind: 'tile', p: C.p, q: C.q, idx: C.tile }, hand: null });

test('before: C open, C\'s card in the bar — the same village', () => {
  const FS = FS0([A, B, C]);
  assert.equal(subjectOf(FS).holding, C); assert.equal(activeHolding(FS), C);
});

test('after B is lost: the card still shows C, by its tile', () => {
  const FS = FS0([A, C]);
  assert.equal(subjectOf(FS).holding, C); assert.equal(subjectOf(FS).holdingIndex, 1);
});

// (2026-11-16, claude/village-card-target-20261116: fixed in controller.mjs applyMeResult — the open village is kept by
// identity; pinned as text below. SOURCE ONLY, NOT run: all new test runs are paused.)
const src = () => readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const fnOf = (c, head) => { const at = c.indexOf(head); return c.slice(at, c.indexOf('\n}\n', at)); };

test('adoptHoldings keeps the open village by its identity (p, q, site, gen) across a reordered, shrunk or grown list', () => {
  const fn = fnOf(src(), 'function adoptHoldings(list) {');
  assert.match(fn, /const open = activeHolding\(FS\), openRef = open \? \{ p: open\.p, q: open\.q, site: open\.site, gen: open\.gen \} : null;\n\s+FS\.holdings = list;/);
  assert.match(fn, /const at = FS\.holdings\.indexOf\(holdingByRef\(FS\.holdings, openRef\)\);\n\s+if \(at >= 0\) \{ if \(at !== FS\.activeHolding\) \{ FS\.activeHolding = at;/);
  assert.match(fn, /else \{ FS\.activeHolding = 0; redraw = true; \}/, 'the open village gone: position 0, drawn again');
});

test('one rule after any adoption (a viewer change too): a village card of another village than the open one is put away; a host kept', () => {
  const fn = fnOf(src(), 'function adoptHoldings(list) {');
  assert.match(fn, /const sub = subjectOf\(FS\);\n\s+if \(sub\?\.kind === 'village' && sub\.holdingIndex !== \(FS\.activeHolding \?\? 0\)\) \{ FS\.hand = null; FS\.selected = null; FS\.inspectOpen = false; redraw = true; \}/);
  assert.doesNotMatch(fn, /FS\.compose|pendingDriver|musterDriver|FS\.explore/, 'a draft, a waiting send and an exploration keep their own village');
});

test('both writers of the list go through it, and redraw before any later press (pinned as text)', () => {
  const c = src();
  const am = c.slice(c.indexOf('export function applyMeResult(me) {'), c.indexOf("\n    return 'found';", c.indexOf('export function applyMeResult(me) {')) + 30);
  assert.match(am, /const redrawNow = adoptHoldings\(me\.holdings\);/);
  assert.match(am, /if \(redrawNow\) flush\(\);\n\s+return 'found';/);
  assert.doesNotMatch(am, /FS\.holdings = me\.holdings;/);
  assert.match(c, /FS\.citizen=me\.citizen; const redrawNow=adoptHoldings\(me\.holdings\); FS\.land=landState\(me\.citizen\); if \(redrawNow\) flush\(\);/, 'cq-outpost adopts the same way');
  assert.equal((c.match(/FS\.holdings\s*=\s*me\.holdings/g) ?? []).length, 0, 'no other adoption of the answer\'s list');
  assert.match(c, /import \{ FS, invalidate, flush, activeHolding \} from '\.\/fstate\.mjs';\nimport \{ subjectOf \} from '\.\/hud\/subject\.mjs';/);
});

test('a viewer change: the list emptied (resetViewer), then the new viewer\'s — a village card of its village at another position than the open one is put away (the rule by hand)', () => {
  const FS = FS0([A, C]); FS.activeHolding = 0;   // (after resetViewer and a new list: nothing to re-find, position 0)
  const sub = subjectOf(FS);
  assert.equal(sub.kind, 'village'); assert.notEqual(sub.holdingIndex, FS.activeHolding, 'the card would show C and order for A');
});

test('after B is lost, as the adoption now resolves it: the open village is C again — the card and the orders agree', () => {
  // (the adoption's rule, applied by hand on the same data: the identity's new position)
  const FS = FS0([A, C]);
  const at = FS.holdings.findIndex(h => h.p === C.p && h.q === C.q && h.site === C.site && h.gen === C.gen);
  FS.activeHolding = at;
  assert.equal(activeHolding(FS), subjectOf(FS).holding);
});

test('fstate activeHolding still falls back to 0 out of range (the adoption no longer leaves it there)', () => {
  const s2 = readFileSync(new URL('../../permutation-server/web/frontier/fstate.mjs', import.meta.url), 'utf8');
  assert.match(s2, /fs\.activeHolding < hs\.length \? fs\.activeHolding : 0;/);
});
