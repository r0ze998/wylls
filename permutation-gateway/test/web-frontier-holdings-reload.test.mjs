// The open village after the viewer's villages are read again (2026-11-16). SOURCE ONLY — NOT run: all new test runs
// are paused. controller.mjs applyMeResult replaces FS.holdings (FS.holdings = me.holdings) and keeps FS.activeHolding,
// a POSITION; fstate.mjs activeHolding falls back to position 0 when the position is out of range. The bar's card
// subject is found by TILE in the new list (hud/subject.mjs subjectOf). So a village lost (or one put before the open
// one) between two reads shifts the positions: the card shows one village and the village orders (controller.mjs
// build / train / muster / harvest: activeHolding(FS)) go to another. Not fixable in app.mjs (the old card stays
// pressable until refresh() redraws at its end; a press handler cannot tell a bar press from the village screen's):
// the contract proposed for controller.mjs is in docs/integration/CLAUDE-VILLAGE-CARD-TARGET-20261116.md.
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

test('after B is lost: the open village is still C (the orders go where the card shows)', { todo: 'controller.mjs applyMeResult keeps the position: position 2 is out of range and activeHolding falls back to A' }, () => {
  const FS = FS0([A, C]);
  assert.equal(activeHolding(FS), subjectOf(FS).holding);
});

test('the gap, pinned as text: applyMeResult replaces the list and does not touch the open village; activeHolding falls back to 0', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const at = c.indexOf('export function applyMeResult(me) {'), fn = c.slice(at, c.indexOf("\n    return 'found';", at));
  assert.match(fn, /FS\.holdings = me\.holdings;/);
  assert.doesNotMatch(fn, /activeHolding/, 'when this fails, the open village is re-resolved there: turn the todo above into a plain test');
  const s = readFileSync(new URL('../../permutation-server/web/frontier/fstate.mjs', import.meta.url), 'utf8');
  assert.match(s, /fs\.activeHolding < hs\.length \? fs\.activeHolding : 0;/);
});
