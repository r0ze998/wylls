// The page must stay alive whatever a draw asks for: a render that asks to be drawn again on every draw is an endless
// chain of microtasks, and the tab stands still with its last picture (fstate.mjs, app.mjs). No browser, no keys.
// (The terrain a map frame makes anew: web-frontier-terrain-frame.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { invalidate, registerRenderers, flushState, FLUSH_STREAK, FLUSH_PACE_MS } from '../../permutation-server/web/frontier/fstate.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));

test('renders that settle are drawn in the next microtask, as ever: one draw for many asks, a second draw for an ask made while drawing', async () => {
  let calm = 0, twice = 0;
  registerRenderers([['t-calm', () => { calm++; }], ['t-twice', () => { if (++twice < 3) invalidate('t-twice'); }]]);
  invalidate('t-calm'); invalidate('t-calm'); invalidate('t-calm');
  assert.equal(calm, 0); await Promise.resolve(); assert.equal(calm, 1, 'one draw, in the microtask');
  invalidate('t-twice'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(twice, 3, 'a draw that asks again is drawn again at once, while it settles'); assert.equal(flushState().storm, false);
  await pause(5); assert.equal(flushState().streak, 0, 'the count is of one task only');
});

test('a render that asks to be drawn again on every draw does not hold the page: it is paced by a timer and named once', async () => {
  let draws = 0; const warned = [], warn = console.warn; console.warn = (...a) => { warned.push(a.join(' ')); };
  try {
    registerRenderers([['t-loop', () => { draws++; invalidate('t-loop'); }]]);
    invalidate('t-loop');
    // (before the fix this line never came back: the microtasks had no end, and no timer of the page ever ran)
    await pause(120);
    assert.ok(draws >= FLUSH_STREAK, `${draws} draws`); assert.ok(draws <= FLUSH_STREAK + 2 + Math.ceil(120 / FLUSH_PACE_MS) + 4, `${draws} draws in 120 ms: paced, not spun`);
    assert.equal(flushState().storm, true);
    assert.equal(warned.length, 1); assert.match(warned[0], /render loop: t-loop asked to be drawn again \d+ times without a pause/);
    // other work of the page runs between the paced draws: timers fire, promises settle
    const before = draws; let ticks = 0; const timer = setInterval(() => { ticks++; }, 5);
    await pause(80); clearInterval(timer);
    assert.ok(ticks >= 5, `${ticks} timer ticks in 80 ms`); assert.ok(draws - before <= Math.ceil(80 / FLUSH_PACE_MS) + 3);
    // a calm part is still drawn (by the same paced draw), and the loop ending ends the draws
    let calm = 0; registerRenderers([['t-calm2', () => { calm++; }], ['t-loop', () => { draws++; }]]);
    invalidate('t-calm2'); await pause(60); assert.equal(calm, 1);
    const settled = draws; await pause(60); assert.equal(draws, settled, 'no more draws once nothing asks');
  } finally { console.warn = warn; }
});

test('the page asks once for a home deadline that has run out, not on every draw', () => {
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /if \(left <= 0 && el\.dataset\.homeDue !== 'asked'\) \{ el\.dataset\.homeDue = 'asked'; invalidate\('panel'\); \}/);
  assert.doesNotMatch(app, /if \(left <= 0\) invalidate\('panel'\);/);
});
