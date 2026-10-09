// The sprite player for the leaders on stage (people/leader-sprite.mjs): the frame is a pure function of the
// clock; the player holds the pictures (one fetch a file, however often the markup is written again); reduced
// motion is a complete mode (a still, no flourish, no sheet fetched); a figure out of view asks for nothing and
// one that is not looked at is its still; a flourish plays once per name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spriteFrame, figurePose, createSpritePlayer, PHASE_STEP } from '../../permutation-server/web/frontier/people/leader-sprite.mjs';
import { STAGE_CLIPS, STAGE_CELL, leaderStageUrl, leaderStillUrl } from '../../permutation-server/web/frontier/people/leader-art.mjs';

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
  assert.deepEqual(figurePose({ motion: 'attack', t: 3, start: 3, live: false }), { clip: null, frame: 0, ended: false }, 'a flourish out of sight is not over: another figure of the same name may be playing it');
  // reduced motion and effects off: a still frame instead of a loop, and the flourish is over at once
  for (const level of ['reduced', 'off']) {
    assert.deepEqual(figurePose({ motion: 'idle', level, t: 0.9 }), { clip: null, frame: 0, ended: false });
    assert.deepEqual(figurePose({ motion: 'attack', level, t: 0.3, start: 0 }), { clip: null, frame: 0, ended: true });
  }
});

/** A page of figures for the player: canvases with just enough DOM (attributes, a 2D context that records, a box, a holder that may be looked at). */
function page(specs) {
  const make = s => {
    const attrs = new Map(Object.entries({ 'data-leader': s.leader ?? 'aster', 'data-motion': s.motion ?? 'idle', ...(s.once ? { 'data-once': s.once } : {}), ...(s.when ? { 'data-when': s.when } : {}), ...(s.shadow === false ? { 'data-shadow': '0' } : {}) }));
    const el = { spec: s, draws: [], clears: 0, shadows: 0 };
    const g = { save() {}, restore() {}, beginPath() {}, fill() {}, clearRect() { el.clears++; }, ellipse() { el.shadows++; }, drawImage(...a) { el.draws.push(a); } };
    return Object.assign(el, {
      getAttribute: k => attrs.get(k) ?? null,
      getContext: kind => (kind === '2d' ? g : null),
      getBoundingClientRect: () => s.box ?? { left: 10, top: 10, right: 110, bottom: 135, width: 100, height: 125 },
      closest: sel => (sel === '[data-nation]' && s.holder ? s.holder : null),
    });
  };
  const hosts = specs.map(make);
  return { hosts, doc: { hidden: false, defaultView: { innerWidth: 1440, innerHeight: 900 }, querySelectorAll: sel => (sel === 'canvas.lfig' ? hosts : []) } };
}
/** What a canvas shows now: the picture's URL and the frame it was cut at (null when nothing was painted). */
const on = el => { const d = el.draws.at(-1); return d ? { url: d[0].url, frame: d[1] / STAGE_CELL.w } : null; };
/** A loader that answers at once with a picture that remembers its URL (`fail`: URLs that cannot be had). */
const instant = (asked = [], fail = []) => (url, done) => { asked.push(url); done(fail.includes(url) ? null : { url }); };

test('the player holds the pictures: the still at once, the sheet when it has come, then the frame of the clock; one fetch a file', () => {
  const { doc, hosts } = page([{ leader: 'aster' }, { leader: 'ember' }]);
  let t = 0; const asked = [], frames = [];
  const player = createSpritePlayer({ doc, now: () => t, level: () => 'full', load: (url, done) => asked.push({ url, done }), frame: fn => frames.push(fn) });
  assert.equal(player.tick(), 2, 'both wait for their pictures');
  assert.deepEqual(asked.map(a => a.url), [leaderStillUrl(0), leaderStageUrl(0, 'idle'), leaderStillUrl(4), leaderStageUrl(4, 'idle')]);
  assert.equal(on(hosts[0]), null, 'nothing is painted before a picture is here (the canvas keeps its place: no shift)');
  const give = (i, ok = true) => asked[i].done(ok ? { url: asked[i].url } : null);
  give(0); give(2);
  assert.equal(frames.length, 1, 'an arrival wakes the loop once');
  player.tick();
  assert.deepEqual(on(hosts[0]), { url: leaderStillUrl(0), frame: 0 }, 'the still stands until the sheet has come');
  assert.deepEqual(hosts[0].draws.at(-1).slice(1), [0, 0, 288, 360, 0, 0, 288, 360], 'one cell, unscaled');
  assert.equal(hosts[0].shadows, 1, 'on its shadow');
  give(1); give(3, false);
  assert.equal(player.tick(), 1, 'a sheet that cannot be had leaves its figure a still for good');
  assert.deepEqual(on(hosts[0]), { url: leaderStageUrl(0, 'idle'), frame: 0 });
  assert.deepEqual(on(hosts[1]), { url: leaderStillUrl(4), frame: 0 });
  t = 0.5; player.tick(); assert.deepEqual(on(hosts[0]), { url: leaderStageUrl(0, 'idle'), frame: 2 });
  assert.deepEqual(hosts[0].draws.at(-1).slice(1), [2 * 288, 0, 288, 360, 0, 0, 288, 360], 'the frame is cut from the row');
  const n = hosts[0].draws.length; player.tick(); assert.equal(hosts[0].draws.length, n, 'the same frame paints nothing');
  t = 1.99; player.tick(); assert.equal(on(hosts[0]).frame, 7);
  assert.equal(hosts[0].clears, hosts[0].draws.length, 'each frame replaces the last');
  // the markup is written again (new canvases): they are painted from what the player holds, and nothing is fetched
  const again = page([{ leader: 'aster' }, { leader: 'ember' }]);
  doc.querySelectorAll = again.doc.querySelectorAll;
  player.tick();
  assert.deepEqual(on(again.hosts[0]), { url: leaderStageUrl(0, 'idle'), frame: 7 });
  assert.equal(asked.length, 4, 'one fetch a file, however often the page is rendered');
  // six in a row do not breathe as one: the white leader is four phase steps on
  const two = page([{ leader: 'aster' }, { leader: 'ember' }]);
  createSpritePlayer({ doc: two.doc, now: () => 0.1, level: () => 'full', load: instant(), frame: () => {} }).tick();
  assert.equal(on(two.hosts[0]).frame, 0);
  assert.equal(on(two.hosts[1]).frame, spriteFrame('idle', 0.1, { phase: 4 * PHASE_STEP }));
  assert.notEqual(on(two.hosts[1]).frame, 0);
  // a figure without a shadow
  const bare = page([{ leader: 'cinder', shadow: false }]);
  createSpritePlayer({ doc: bare.doc, now: () => 0, level: () => 'full', load: instant(), frame: () => {} }).tick();
  assert.equal(bare.hosts[0].shadows, 0);
});

test('reduced motion is a complete mode: every figure is its still, no sheet is fetched, the loop does not run', () => {
  for (const level of ['reduced', 'off']) {
    const { doc, hosts } = page([{ leader: 'aster' }, { leader: 'cinder', motion: 'attack', once: 'pick-2' }]);
    const asked = [], frames = [];
    const player = createSpritePlayer({ doc, now: () => 1.3, level: () => level, load: instant(asked), frame: fn => frames.push(fn) });
    assert.equal(player.tick(), 0);
    assert.deepEqual(asked, [leaderStillUrl(0), leaderStillUrl(2)], `${level}: the stills and nothing else`);
    assert.deepEqual(hosts.map(on), [{ url: leaderStillUrl(0), frame: 0 }, { url: leaderStillUrl(2), frame: 0 }]);
    // (the stills' arrival asked for one look; after it, and after any later wake, the loop rests: nothing moves)
    assert.equal(frames.length, 1); frames.pop()(); assert.equal(frames.length, 0, 'one look, then the loop rests');
    player.kick(); assert.equal(frames.length, 1); frames.pop()(); assert.equal(frames.length, 0);
    assert.equal(player.plays.get('pick-2').done, true, 'the flourish does not wait for motion to come back');
  }
  // a figure that was moving goes back to its still when motion is turned down
  const { doc, hosts } = page([{ leader: 'dunmar' }]);
  let level = 'full';
  const player = createSpritePlayer({ doc, now: () => 0.6, level: () => level, load: instant(), frame: () => {} });
  player.tick(); assert.equal(on(hosts[0]).url, leaderStageUrl(3, 'idle'));
  level = 'reduced'; player.tick();
  assert.deepEqual(on(hosts[0]), { url: leaderStillUrl(3), frame: 0 });
});

test('a figure is painted only where it is seen: out of view or hidden it asks for nothing; on a banner nobody looks at it is its still', () => {
  const holder = { pressed: 'false', over: false, getAttribute: k => (k === 'aria-pressed' ? holder.pressed : null), matches: () => holder.over };
  const { doc, hosts } = page([
    { leader: 'aster', box: { left: 0, top: 1200, right: 100, bottom: 1325, width: 100, height: 125 } },   // below the screen
    { leader: 'borealis', box: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },           // display: none
    { leader: 'cinder', when: 'look', holder },                                                             // a banner at rest
  ]);
  const asked = [];
  const player = createSpritePlayer({ doc, now: () => 0.3, level: () => 'full', load: instant(asked), frame: () => {} });
  assert.equal(player.tick(), 0); assert.deepEqual(asked, [leaderStillUrl(2)], 'only the banner\'s still: what cannot be seen fetches nothing');
  assert.deepEqual(hosts.map(on), [null, null, { url: leaderStillUrl(2), frame: 0 }]);
  holder.over = true;
  assert.equal(player.tick(), 1); assert.deepEqual(asked, [leaderStillUrl(2), leaderStageUrl(2, 'idle')], 'looked at: it breathes');
  assert.equal(on(hosts[2]).url, leaderStageUrl(2, 'idle'));
  holder.over = false; player.tick(); assert.deepEqual(on(hosts[2]), { url: leaderStillUrl(2), frame: 0 }, 'the pointer left: the still again');
  holder.pressed = 'true'; assert.equal(player.tick(), 1, 'the chosen banner\'s leader goes on breathing');
  // the figure below the screen comes into view: now it is painted
  hosts[0].spec.box = { left: 0, top: 700, right: 100, bottom: 825, width: 100, height: 125 };
  player.tick(); assert.equal(on(hosts[0]).url, leaderStageUrl(0, 'idle'));
});

test('the flourish plays once per name, on every figure that carries the name, and again only after the name has left the page', () => {
  let t = 5;
  const holder = { getAttribute: () => 'true', matches: () => false };
  const spec = [{ leader: 'ember', motion: 'attack', once: 'pick-4', when: 'look', holder }, { leader: 'ember', motion: 'attack', once: 'pick-4' }];
  let hosts = [];
  const show = specs => { hosts = page(specs).hosts; };
  const player = createSpritePlayer({ doc: { hidden: false, defaultView: { innerWidth: 1440, innerHeight: 900 }, querySelectorAll: sel => (sel === 'canvas.lfig' ? hosts : []) }, now: () => t, level: () => 'full', load: instant(), frame: () => {} });
  show(spec); player.tick();
  assert.deepEqual(hosts.map(on), [{ url: leaderStageUrl(4, 'attack'), frame: 0 }, { url: leaderStageUrl(4, 'attack'), frame: 0 }]);
  t = 5.4; player.tick(); assert.deepEqual(hosts.map(h => on(h).frame), [4, 4], 'both at the same picture');
  // (a third figure of the same name that cannot be seen, a desktop's banner on a phone, does not end it for the others)
  show([...spec, { leader: 'ember', motion: 'attack', once: 'pick-4', box: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } }]);
  t = 5.5; player.tick(); assert.deepEqual(hosts.map(on), [{ url: leaderStageUrl(4, 'attack'), frame: spriteFrame('attack', 5.5, { start: 5 }) }, { url: leaderStageUrl(4, 'attack'), frame: spriteFrame('attack', 5.5, { start: 5 }) }, null]);
  // the page is rendered again in the middle of it: the new canvases go on from where the old ones were
  show(spec); t = 5.6; player.tick(); assert.deepEqual(on(hosts[0]), { url: leaderStageUrl(4, 'attack'), frame: spriteFrame('attack', 5.6, { start: 5 }) });
  t = 5.9; player.tick(); assert.deepEqual(hosts.map(h => on(h).url), [leaderStageUrl(4, 'idle'), leaderStageUrl(4, 'idle')], 'over: breathing');
  show(spec); t = 9; player.tick(); assert.equal(on(hosts[0]).url, leaderStageUrl(4, 'idle'), 'rendered again later: it does not play again');
  // another nation is chosen (the name leaves the page), then this one again: it plays again
  show([{ leader: 'ember', motion: 'idle', when: 'look', holder }]); t = 10; player.tick(); assert.equal(player.plays.size, 0);
  show(spec); t = 11; player.tick(); assert.equal(on(hosts[0]).url, leaderStageUrl(4, 'attack'));
});
