// The sprite player for the leaders on stage (people/leader-sprite.mjs): the frame is a pure function of the
// clock; reduced motion is a complete mode (a still, no flourish, no sheet fetched); a figure out of view or
// not looked at is left as its still; a flourish plays once per name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spriteFrame, figurePose, createSpritePlayer, PHASE_STEP } from '../../permutation-server/web/frontier/people/leader-sprite.mjs';
import { STAGE_CLIPS, STAGE_CELL, leaderStageUrl } from '../../permutation-server/web/frontier/people/leader-art.mjs';

test('the frame from the time: idle loops through its eight pictures in two seconds; the flourish ends on its last picture', () => {
  const idle = STAGE_CLIPS.idle, attack = STAGE_CLIPS.attack;
  assert.deepEqual([0, 0.24, 0.25, 0.5, 1, 1.75, 1.99, 2, 2.25, 4].map(t => spriteFrame('idle', t)), [0, 0, 1, 2, 4, 7, 7, 0, 1, 0]);
  assert.equal(spriteFrame(idle, 0.1, { phase: 0.37 }), 1, 'a phase moves a loop on');
  assert.equal(spriteFrame(idle, -0.1), 7, 'a clock before zero still gives a frame of the loop');
  // a one-shot samples both ends: 8 pictures over 0.8 s, then it holds the last (the stance)
  assert.deepEqual([0, 0.05, 0.06, 0.4, 0.75, 0.8, 5].map(t => spriteFrame('attack', t)), [0, 0, 1, 4, 7, 7, 7]);
  assert.equal(spriteFrame(attack, 10.4, { start: 10 }), 4, 'from its own start');
  assert.equal(spriteFrame(attack, 9, { start: 10 }), 0, 'before it began: the first picture');
  assert.equal(spriteFrame('idle', NaN), 0); assert.equal(spriteFrame('walk', 1), 0, 'a clip the stage does not have');
});

test('what a figure shows: breathing, a flourish that plays once and gives way to breathing, a still in reduced motion', () => {
  assert.deepEqual(figurePose({ motion: 'idle', t: 0.5 }), { clip: 'idle', frame: 2, ended: false });
  assert.deepEqual(figurePose({ motion: 'idle', t: 0.5, phase: PHASE_STEP * 2 }), { clip: 'idle', frame: 4, ended: false });
  assert.deepEqual(figurePose({ motion: 'attack', t: 10.4, start: 10 }), { clip: 'attack', frame: 4, ended: false });
  assert.deepEqual(figurePose({ motion: 'attack', t: 10.8, start: 10 }), { clip: 'idle', frame: spriteFrame('idle', 10.8), ended: true }, 'over: it breathes again');
  assert.deepEqual(figurePose({ motion: 'attack', t: 10.1, start: 10, done: true }), { clip: 'idle', frame: spriteFrame('idle', 10.1), ended: false }, 'a flourish already played does not play again');
  assert.deepEqual(figurePose({ motion: 'still', t: 3 }), { clip: null, frame: 0, ended: false });
  assert.deepEqual(figurePose({ motion: 'idle', t: 3, live: false }), { clip: null, frame: 0, ended: false }, 'out of view or not looked at: the still');
  // reduced motion and effects off: a still frame instead of a loop, and the flourish is over at once
  for (const level of ['reduced', 'off']) {
    assert.deepEqual(figurePose({ motion: 'idle', level, t: 0.9 }), { clip: null, frame: 0, ended: false });
    assert.deepEqual(figurePose({ motion: 'attack', level, t: 0.3, start: 0 }), { clip: null, frame: 0, ended: true });
  }
});

/** A page of figures for the player: just enough DOM (attributes, one child list, a box, a holder that may be looked at). */
function page(specs) {
  const make = s => {
    const attrs = new Map(Object.entries({ 'data-leader': s.leader ?? 'aster', 'data-motion': s.motion ?? 'idle', ...(s.once ? { 'data-once': s.once } : {}), ...(s.when ? { 'data-when': s.when } : {}) }));
    const still = { cls: 'lfig-still', attrs: new Map(), setAttribute(k, v) { this.attrs.set(k, v); }, removeAttribute(k) { this.attrs.delete(k); } };
    const el = {
      spec: s, still, kids: [still], writes: 0,
      getAttribute: k => attrs.get(k) ?? null,
      querySelector(sel) { return this.kids.find(k => `.${k.cls}` === sel) ?? null; },
      append(k) { this.kids.push(k); k.parent = this; },
      getBoundingClientRect: () => s.box ?? { left: 10, top: 10, right: 110, bottom: 135, width: 100, height: 125 },
      closest: sel => (sel === '[data-nation]' && s.holder ? s.holder : null),
    };
    return el;
  };
  const hosts = specs.map(make);
  const doc = {
    hidden: false, defaultView: { innerWidth: 1440, innerHeight: 900 },
    querySelectorAll: sel => (sel === 'svg.lfig' ? hosts : []),
    createElementNS: () => { const img = { cls: '', attrs: new Map(), parent: null, setAttribute(k, v) { if (k === 'class') this.cls = v; this.attrs.set(k, String(v)); img.parent && img.parent.writes++; }, getAttribute(k) { return this.attrs.get(k) ?? null; }, remove() { const i = this.parent.kids.indexOf(this); if (i >= 0) this.parent.kids.splice(i, 1); } }; return img; },
  };
  return { doc, hosts };
}
const sheetOf = el => el.kids.find(k => k.cls === 'lfig-sheet') ?? null;

test('the player: fetches a sheet only for a figure that may move, shows the still until it has come, then steps the frame by the clock', () => {
  const { doc, hosts } = page([{ leader: 'aster' }, { leader: 'ember' }]);
  let t = 0; const asked = [], frames = [];
  const player = createSpritePlayer({ doc, now: () => t, level: () => 'full', load: (url, done) => asked.push({ url, done }), frame: fn => frames.push(fn) });
  assert.equal(player.tick(), 2, 'both wait for their sheets');
  assert.deepEqual(asked.map(a => a.url), [leaderStageUrl(0, 'idle'), leaderStageUrl(4, 'idle')]);
  assert.equal(sheetOf(hosts[0]), null, 'the still stands meanwhile');
  assert.equal(hosts[0].still.attrs.get('visibility'), undefined);
  asked[0].done(true); asked[1].done(false);
  assert.equal(frames.length, 1, 'an arrival wakes the loop once');
  assert.equal(player.tick(), 1, 'a sheet that failed leaves its figure a still for good');
  const img = sheetOf(hosts[0]);
  assert.deepEqual([img.attrs.get('href'), img.attrs.get('width'), img.attrs.get('height'), img.attrs.get('x')], [leaderStageUrl(0, 'idle'), String(STAGE_CELL.w * 8), String(STAGE_CELL.h), '0']);
  assert.equal(hosts[0].still.attrs.get('visibility'), 'hidden', 'the still makes way for the sheet');
  assert.equal(sheetOf(hosts[1]), null); assert.equal(asked.length, 2, 'no second request for a sheet that failed');
  t = 0.5; player.tick(); assert.equal(img.attrs.get('x'), String(-2 * STAGE_CELL.w));
  const writes = hosts[0].writes; player.tick(); assert.equal(hosts[0].writes, writes, 'the same frame writes nothing');
  t = 1.99; player.tick(); assert.equal(img.attrs.get('x'), String(-7 * STAGE_CELL.w));
  // six in a row do not breathe as one: the white leader is four phase steps on
  const two = page([{ leader: 'aster' }, { leader: 'ember' }]);
  const p2 = createSpritePlayer({ doc: two.doc, now: () => 0.1, level: () => 'full', load: (url, done) => done(true), frame: () => {} });
  p2.tick();
  assert.equal(sheetOf(two.hosts[0]).attrs.get('x'), '0');
  assert.equal(sheetOf(two.hosts[1]).attrs.get('x'), String(-spriteFrame('idle', 0.1, { phase: 4 * PHASE_STEP }) * STAGE_CELL.w));
  assert.notEqual(sheetOf(two.hosts[1]).attrs.get('x'), '0');
});

test('reduced motion is a complete mode: every figure is its still, nothing is fetched, the loop does not run', () => {
  for (const level of ['reduced', 'off']) {
    const { doc, hosts } = page([{ leader: 'aster' }, { leader: 'cinder', motion: 'attack', once: 'pick-2' }]);
    const asked = [], frames = [];
    const player = createSpritePlayer({ doc, now: () => 1.3, level: () => level, load: url => asked.push(url), frame: fn => frames.push(fn) });
    assert.equal(player.tick(), 0);
    assert.deepEqual(asked, [], `${level}: no sheet is fetched`);
    assert.ok(hosts.every(h => sheetOf(h) === null && h.still.attrs.get('visibility') === undefined));
    player.kick(); assert.equal(frames.length, 1); frames.pop()(); assert.equal(frames.length, 0, 'one look, then the loop rests');
    assert.equal(player.plays.get('pick-2').done, true, 'the flourish does not wait for motion to come back');
  }
  // a figure that was moving goes back to its still when motion is turned down
  const { doc, hosts } = page([{ leader: 'dunmar' }]);
  let level = 'full';
  const player = createSpritePlayer({ doc, now: () => 0.6, level: () => level, load: (url, done) => done(true), frame: () => {} });
  player.tick(); assert.ok(sheetOf(hosts[0]));
  level = 'reduced'; player.tick();
  assert.equal(sheetOf(hosts[0]), null); assert.equal(hosts[0].still.attrs.get('visibility'), undefined);
});

test('a figure moves only where it is seen: out of view, hidden, or on a banner nobody looks at, it stays a still', () => {
  const holder = { pressed: 'false', over: false, getAttribute: k => (k === 'aria-pressed' ? holder.pressed : null), matches: () => holder.over };
  const { doc, hosts } = page([
    { leader: 'aster', box: { left: 0, top: 1200, right: 100, bottom: 1325, width: 100, height: 125 } },   // below the screen
    { leader: 'borealis', box: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },           // display: none
    { leader: 'cinder', when: 'look', holder },                                                             // a banner at rest
  ]);
  const asked = [];
  const player = createSpritePlayer({ doc, now: () => 0.3, level: () => 'full', load: (url, done) => { asked.push(url); done(true); }, frame: () => {} });
  assert.equal(player.tick(), 0); assert.deepEqual(asked, []);
  holder.over = true;
  assert.equal(player.tick(), 1); assert.deepEqual(asked, [leaderStageUrl(2, 'idle')], 'looked at: it breathes');
  holder.over = false; player.tick(); assert.equal(sheetOf(hosts[2]), null, 'the pointer left: the still again');
  holder.pressed = 'true'; assert.equal(player.tick(), 1, 'the chosen banner\'s leader goes on breathing');
});

test('the flourish plays once per name, on every figure that carries the name, and again only after the name has left the page', () => {
  let t = 5;
  const holder = { getAttribute: () => 'true', matches: () => false };
  const spec = [{ leader: 'ember', motion: 'attack', once: 'pick-4', when: 'look', holder }, { leader: 'ember', motion: 'attack', once: 'pick-4' }];
  let { doc, hosts } = page(spec);
  const view = { doc };
  const player = createSpritePlayer({ doc: { get hidden() { return false; }, defaultView: doc.defaultView, querySelectorAll: s => view.doc.querySelectorAll(s), createElementNS: (...a) => view.doc.createElementNS(...a) }, now: () => t, level: () => 'full', load: (url, done) => done(true), frame: () => {} });
  player.tick();
  assert.deepEqual(hosts.map(h => sheetOf(h).attrs.get('href')), [leaderStageUrl(4, 'attack'), leaderStageUrl(4, 'attack')]);
  t = 5.4; player.tick(); assert.deepEqual(hosts.map(h => sheetOf(h).attrs.get('x')), [String(-4 * STAGE_CELL.w), String(-4 * STAGE_CELL.w)], 'both at the same picture');
  // the page is rendered again in the middle of it: the new figures go on from where the old ones were
  ({ doc, hosts } = page(spec)); view.doc = doc;
  t = 5.6; player.tick(); assert.equal(sheetOf(hosts[0]).attrs.get('x'), String(-spriteFrame('attack', 5.6, { start: 5 }) * STAGE_CELL.w));
  t = 5.9; player.tick(); assert.deepEqual(hosts.map(h => sheetOf(h).attrs.get('href')), [leaderStageUrl(4, 'idle'), leaderStageUrl(4, 'idle')], 'over: breathing');
  ({ doc, hosts } = page(spec)); view.doc = doc;
  t = 9; player.tick(); assert.equal(sheetOf(hosts[0]).attrs.get('href'), leaderStageUrl(4, 'idle'), 'rendered again later: it does not play again');
  // another nation is chosen (the name leaves the page), then this one again: it plays again
  ({ doc, hosts } = page([{ leader: 'ember', motion: 'idle', when: 'look', holder }])); view.doc = doc;
  t = 10; player.tick(); assert.equal(player.plays.size, 0);
  ({ doc, hosts } = page(spec)); view.doc = doc;
  t = 11; player.tick(); assert.equal(sheetOf(hosts[0]).attrs.get('href'), leaderStageUrl(4, 'attack'));
});
