// The hand's own press gates (round 17, 2026-11-14), on top of the drawer's (app.mjs makePressGate, drawerPress). The
// hand's bar and its card (the forts' list, the muster, …) are written by renderHand, outside the drawer: a write between
// a pointer's down and up replaces the pressed button and the browser makes no click. In a ×30 two-person world presses
// on a fort's row and on the muster's gather were lost. Now each of the two has a gate of its own: while a pointer is down
// on it, its write waits and runs right after the release (bounded by the gate's own hold limit). Nothing else changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePressGate } from '../../permutation-server/web/frontier/app.mjs';

const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');

test('a gate holds a write while pressed and gives it back on release; a long press holds nothing', () => {
  let t = 0; const g = makePressGate({ maxHoldMs: 2000, now: () => t });
  let ran = 0; const redraw = () => { ran++; };
  assert.equal(g.hold(redraw), false, 'no press: the write runs now');
  g.down(); t = 100;
  assert.equal(g.hold(redraw), true, 'pressed: held');
  assert.equal(g.up(), redraw, 'released: the held write is given back (the page runs it after the click)');
  assert.equal(g.up(), null, 'once');
  g.down(); t = 100 + 2000;
  assert.equal(g.hold(redraw), false, 'held longer than the limit: never frozen');
  assert.equal(g.up(), null);
  assert.equal(ran, 0, 'the gate itself runs nothing');
});

test('the hand\'s bar and card each have their own gate, fed by the same pointer listeners as the drawer\'s', () => {
  assert.match(app, /const handPress = makePressGate\(\), handPopPress = makePressGate\(\);/);
  assert.match(app, /if \(e\.target\?\.closest\?\.\('#hand'\)\) handPress\.down\(\); if \(e\.target\?\.closest\?\.\('#hand-pop'\)\) handPopPress\.down\(\);/);
  assert.match(app, /for \(const g of \[handPress, handPopPress\]\) \{ const redraw = g\.up\(\); if \(redraw\) setTimeout\(redraw, 0\); \}/, 'released: after the click');
  // the drawer's gate is unchanged
  assert.match(app, /const drawerPress = makePressGate\(\);/);
  assert.match(app, /if \(drawerPress\.hold\(\(\) => renderDrawer\(markupOf\)\)\) return drawerOf\(FS\);/);
});

test('renderHand: a pressed bar or card is not written, and stays marked as not written so the release writes it', () => {
  const fn = app.slice(app.indexOf('function renderHand()'), app.indexOf('function measureHand()'));
  assert.match(fn, /if \(bar !== handLast\.bar && !handPress\.hold\(\(\) => renderHand\(\)\)\) \{ keepState\(handEl, \(\) => setHtml\(handEl, hand\.renderHand\(model\)\)\); handLast\.bar = bar; \}/);
  assert.match(fn, /if \(pop !== handLast\.pop && !handPopPress\.hold\(\(\) => renderHand\(\)\)\) \{ keepState\(handPopEl, \(\) => setHtml\(handPopEl, pop \? hand\.renderPop\(FS, model\) : ''\)\); handLast\.pop = pop;/);
  assert.equal((fn.match(/setHtml\(handEl,/g) ?? []).length, 1, 'the bar is written in one place only');
  assert.equal((fn.match(/setHtml\(handPopEl, pop/g) ?? []).length, 1, 'the card is written in one place only (its clearing when the hand goes is not a press target)');
});
