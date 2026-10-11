// The sprite player for the leaders on stage (people/leader-sprite.mjs): the frame is a pure function of the
// clock; the player holds the pictures (one fetch a file, however often the markup is written again); reduced
// motion is a complete mode (a still, no flourish, no sheet fetched); a figure out of view asks for nothing and
// one that is not looked at is its still; the stills come before any sheet; a flourish plays once per name, begins
// when its sheet is here (a moment after the press), is looked at on every frame and loses no picture to a busy page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spriteFrame, figurePose, createSpritePlayer, PHASE_STEP, FLOURISH_LEAD, FLOURISH_PATIENCE } from '../../permutation-server/web/frontier/people/leader-sprite.mjs';
import { STAGE_CLIPS, STAGE_CELL, leaderStageUrl, leaderStillUrl } from '../../permutation-server/web/frontier/people/leader-art.mjs';

test('the frame from the time: idle loops through its four pictures in two seconds; the flourish ends on its last picture', () => {
  const idle = STAGE_CLIPS.idle, attack = STAGE_CLIPS.attack;
  assert.deepEqual([0, 0.49, 0.5, 1, 1.5, 1.99, 2, 2.5, 4].map(t => spriteFrame('idle', t)), [0, 0, 1, 2, 3, 3, 0, 1, 0]);
  assert.equal(spriteFrame(idle, 0.2, { phase: 0.37 }), 1, 'a phase moves a loop on');
  assert.equal(spriteFrame(idle, -0.1), 3, 'a clock before zero still gives a frame of the loop');
  // a one-shot samples both ends: 8 pictures over 0.8 s, then it holds the last (the stance)
  assert.deepEqual([0, 0.05, 0.06, 0.4, 0.75, 0.8, 5].map(t => spriteFrame('attack', t)), [0, 0, 1, 4, 7, 7, 7]);
  assert.equal(spriteFrame(attack, 10.4, { start: 10 }), 4, 'from its own start');
  assert.equal(spriteFrame(attack, 9, { start: 10 }), 0, 'before it began: the first picture');
  assert.equal(spriteFrame('idle', NaN), 0); assert.equal(spriteFrame('walk', 1), 0, 'a clip the stage does not have');
});

test('what a figure shows: breathing, a flourish that plays once and gives way to breathing, a still in reduced motion', () => {
  assert.deepEqual(figurePose({ motion: 'idle', t: 0.5 }), { clip: 'idle', frame: 1, ended: false });
  assert.deepEqual(figurePose({ motion: 'idle', t: 0.5, phase: PHASE_STEP * 2 }), { clip: 'idle', frame: 2, ended: false });
  assert.deepEqual(figurePose({ motion: 'attack', t: 10.4, start: 10 }), { clip: 'attack', frame: 4, ended: false });
  assert.deepEqual(figurePose({ motion: 'attack', t: 10.4 }), { clip: 'idle', frame: spriteFrame('idle', 10.4), ended: false }, 'a flourish that has not begun (its sheet is on its way): the figure breathes and waits');
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
  assert.deepEqual(asked.map(a => a.url), [leaderStillUrl(0), leaderStillUrl(4)], 'the stills first: no sheet is asked for while a still in view is on its way');
  assert.equal(on(hosts[0]), null, 'nothing is painted before a picture is here (the canvas keeps its place: no shift)');
  const give = (i, ok = true) => asked[i].done(ok ? { url: asked[i].url } : null);
  give(0);
  assert.equal(frames.length, 1, 'an arrival wakes the loop once');
  player.tick();
  assert.deepEqual(on(hosts[0]), { url: leaderStillUrl(0), frame: 0 }, 'a still is painted as soon as it has come');
  assert.equal(asked.length, 2, 'the other still is not here yet: still no sheet');
  give(1);
  player.tick();
  assert.deepEqual(asked.slice(2).map(a => a.url), [leaderStageUrl(0, 'idle'), leaderStageUrl(4, 'idle')], 'every still has come and is painted: now the sheets');
  assert.deepEqual(on(hosts[0]), { url: leaderStillUrl(0), frame: 0 }, 'the still stands until the sheet has come');
  assert.deepEqual(hosts[0].draws.at(-1).slice(1), [0, 0, 288, 360, 0, 0, 288, 360], 'one cell, unscaled');
  assert.equal(hosts[0].shadows, 1, 'on its shadow');
  give(2); give(3, false);
  assert.equal(player.tick(), 1, 'a sheet that cannot be had leaves its figure a still for good');
  assert.deepEqual(on(hosts[0]), { url: leaderStageUrl(0, 'idle'), frame: 0 });
  assert.deepEqual(on(hosts[1]), { url: leaderStillUrl(4), frame: 0 });
  t = 1; player.tick(); assert.deepEqual(on(hosts[0]), { url: leaderStageUrl(0, 'idle'), frame: 2 });
  assert.deepEqual(hosts[0].draws.at(-1).slice(1), [2 * 288, 0, 288, 360, 0, 0, 288, 360], 'the frame is cut from the row');
  const n = hosts[0].draws.length; player.tick(); assert.equal(hosts[0].draws.length, n, 'the same frame paints nothing');
  t = 1.99; player.tick(); assert.equal(on(hosts[0]).frame, 3);
  assert.equal(hosts[0].clears, hosts[0].draws.length, 'each frame replaces the last');
  // the markup is written again (new canvases): they are painted from what the player holds, and nothing is fetched
  const again = page([{ leader: 'aster' }, { leader: 'ember' }]);
  doc.querySelectorAll = again.doc.querySelectorAll;
  player.tick();
  assert.deepEqual(on(again.hosts[0]), { url: leaderStageUrl(0, 'idle'), frame: 3 });
  assert.equal(asked.length, 4, 'one fetch a file, however often the page is rendered');
  // six in a row do not breathe as one: the white leader is four phase steps on
  const two = page([{ leader: 'aster' }, { leader: 'ember' }]);
  createSpritePlayer({ doc: two.doc, now: () => 0.2, level: () => 'full', load: instant(), frame: () => {} }).tick();
  assert.equal(on(two.hosts[0]).frame, 0);
  assert.equal(on(two.hosts[1]).frame, spriteFrame('idle', 0.2, { phase: 4 * PHASE_STEP }));
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
    assert.equal(player.warm(2, 'attack'), false, 'and no flourish is fetched ahead for a banner that is looked at');
    assert.deepEqual(asked, [leaderStillUrl(0), leaderStillUrl(2)]);
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
  /** Go to `to` in looks a sixtieth of a second apart, as a page that keeps its frames does. */
  const run = to => { while (t < to - 1e-9) { t = Math.min(to, t + 1 / 60); player.tick(); } };
  show(spec); player.tick();
  assert.deepEqual(hosts.map(h => on(h).url), [leaderStageUrl(4, 'idle'), leaderStageUrl(4, 'idle')], 'just pressed: the figure breathes on for a moment (the page is rendering itself again)');
  assert.equal(player.plays.get('pick-4').start, null);
  run(5 + FLOURISH_LEAD - 0.02);
  assert.equal(player.plays.get('pick-4').start, null, 'not yet');
  run(5 + FLOURISH_LEAD + 0.02);
  const start = player.plays.get('pick-4').start;
  assert.ok(start >= 5 + FLOURISH_LEAD - 1e-9 && start <= 5 + FLOURISH_LEAD + 0.02 + 1e-9, 'it begins a moment after the press');
  assert.deepEqual(hosts.map(on), [{ url: leaderStageUrl(4, 'attack'), frame: 0 }, { url: leaderStageUrl(4, 'attack'), frame: 0 }]);
  run(start + 0.4); assert.deepEqual(hosts.map(h => on(h).frame), [4, 4], 'both at the same picture');
  // (a third figure of the same name that cannot be seen, a desktop's banner on a phone, does not end it for the others)
  show([...spec, { leader: 'ember', motion: 'attack', once: 'pick-4', box: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } }]);
  run(start + 0.5); assert.deepEqual(hosts.map(on), [{ url: leaderStageUrl(4, 'attack'), frame: spriteFrame('attack', 0.5) }, { url: leaderStageUrl(4, 'attack'), frame: spriteFrame('attack', 0.5) }, null]);
  // the page is rendered again in the middle of it: the new canvases go on from where the old ones were
  show(spec); run(start + 0.6); assert.deepEqual(on(hosts[0]), { url: leaderStageUrl(4, 'attack'), frame: spriteFrame('attack', 0.6) });
  run(start + 0.9); assert.deepEqual(hosts.map(h => on(h).url), [leaderStageUrl(4, 'idle'), leaderStageUrl(4, 'idle')], 'over: breathing');
  show(spec); t = 9; player.tick(); assert.equal(on(hosts[0]).url, leaderStageUrl(4, 'idle'), 'rendered again later: it does not play again');
  // another nation is chosen (the name leaves the page), then this one again: it plays again
  show([{ leader: 'ember', motion: 'idle', when: 'look', holder }]); t = 10; player.tick(); assert.equal(player.plays.size, 0);
  show(spec); t = 11; player.tick(); run(11 + FLOURISH_LEAD + 0.05); assert.equal(on(hosts[0]).url, leaderStageUrl(4, 'attack'));
});

test('the flourish begins when its sheet is here, not when the press was: a slow network delays it and loses none of it; a sheet that never comes is let go', () => {
  for (const late of [0.4, 0.9, 2.5]) {
    let t = 20; const asked = [];
    const { doc, hosts } = page([{ leader: 'cinder', motion: 'attack', once: 'pick-2' }]);
    const load = (url, done) => { if (url === leaderStageUrl(2, 'attack')) asked.push(done); else done({ url }); };
    const player = createSpritePlayer({ doc, now: () => t, level: () => 'full', load, frame: () => {} });
    const seen = [];
    const run = to => { while (t < to - 1e-9) { t = Math.min(to, t + 1 / 60); player.tick(); const o = on(hosts[0]); if (o?.url === leaderStageUrl(2, 'attack') && seen.at(-1) !== o.frame) seen.push(o.frame); } };
    player.tick();
    assert.equal(asked.length, 1, 'the flourish\'s sheet is asked for at once');
    run(20 + late);
    assert.deepEqual(seen, [], `${late} s: nothing of the flourish before its sheet`);
    assert.equal(on(hosts[0]).url, leaderStageUrl(2, 'idle'), 'the figure breathes while it waits');
    assert.ok(player.tick() > 0 && player.urgent, 'and the player goes on looking, on every frame');
    asked[0]({ url: leaderStageUrl(2, 'attack') });
    run(20 + late + 1.2);
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7], `${late} s late: every picture of the flourish, in order`);
    assert.equal(on(hosts[0]).url, leaderStageUrl(2, 'idle'), 'then it breathes');
    assert.equal(player.urgent, false, 'and the player looks at its slow pace again');
  }
  // the sheet cannot be had, or comes later than a press is remembered: no flourish, the figure breathes on, nothing waits
  for (const how of ['failed', 'never']) {
    let t = 30; let give = null;
    const { doc, hosts } = page([{ leader: 'aster', motion: 'attack', once: 'pick-0' }]);
    const load = (url, done) => { if (url !== leaderStageUrl(0, 'attack')) done({ url }); else if (how === 'failed') done(null); else give = done; };
    const player = createSpritePlayer({ doc, now: () => t, level: () => 'full', load, frame: () => {} });
    player.tick(); t = 30 + (how === 'failed' ? 0.05 : FLOURISH_PATIENCE + 0.1); player.tick();
    assert.equal(player.plays.get('pick-0').done, true, how);
    give?.({ url: leaderStageUrl(0, 'attack') }); t += 0.3; player.tick();
    assert.equal(on(hosts[0]).url, leaderStageUrl(0, 'idle'), `${how}: it breathes`);
    assert.equal(player.urgent, false);
  }
});

test('a busy page slows the flourish and loses none of it: a look that comes late shows the next picture, never one further on', () => {
  let t = 40;
  const { doc, hosts } = page([{ leader: 'fjordal', motion: 'attack', once: 'pick-5' }]);
  const player = createSpritePlayer({ doc, now: () => t, level: () => 'full', load: instant(), frame: () => {} });
  const seen = [];
  const look = dt => { t += dt; player.tick(); const o = on(hosts[0]); if (o?.url === leaderStageUrl(5, 'attack') && seen.at(-1) !== o.frame) seen.push(o.frame); };
  player.tick();
  // (the gaps a reviewer measured right after a press: 150 to 350 ms between two animation frames, then an uneven second)
  for (const dt of [0.21, 0.16, 0.35, 0.15, 0.05, 0.095, 0.245, 0.3, 0.12, 0.2, 0.33, 0.07, 0.15, 0.15, 0.2, 0.2]) look(dt);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7], 'every picture is shown, in order, however the frames fall');
  assert.equal(on(hosts[0]).url, leaderStageUrl(5, 'idle'), 'and it ends');
  // looks that come only every third of a second: still one picture after another, the last one too
  const slow = page([{ leader: 'ember', motion: 'attack', once: 'pick-4' }]);
  const p2 = createSpritePlayer({ doc: slow.doc, now: () => t, level: () => 'full', load: instant(), frame: () => {} });
  const order = [];
  p2.tick();
  for (let i = 0; i < 12; i++) { t += 0.34; p2.tick(); const o = on(slow.hosts[0]); if (o?.url === leaderStageUrl(4, 'attack')) order.push(o.frame); }
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(p2.plays.get('pick-4').done, true);
  // a page that keeps its frames is not slowed: the eight pictures take the clip's own 0.8 s
  const quick = page([{ leader: 'aster', motion: 'attack', once: 'pick-0' }]);
  const p3 = createSpritePlayer({ doc: quick.doc, now: () => t, level: () => 'full', load: instant(), frame: () => {} });
  p3.tick(); const t0 = t; let began = null, over = null;
  while (over === null && t < t0 + 3) { t += 1 / 60; p3.tick(); const o = on(quick.hosts[0]); if (began === null && o?.url === leaderStageUrl(0, 'attack')) began = t; if (began !== null && o?.url === leaderStageUrl(0, 'idle')) over = t; }
  assert.ok(Math.abs(over - began - STAGE_CLIPS.attack.duration) < 0.03, `at 60 frames a second the flourish lasts ${(over - began).toFixed(3)} s`);
});

test('the loop: fifteen looks a second while the six only breathe, every animation frame while a flourish waits or plays; a banner looked at fetches its flourish ahead', () => {
  let t = 0, wall = 0; const frames = [], asked = [];
  const { doc, hosts } = page([{ leader: 'aster' }]);
  let specs = hosts;
  doc.querySelectorAll = sel => (sel === 'canvas.lfig' ? specs : []);
  const realNow = globalThis.performance.now;
  globalThis.performance.now = () => wall;
  try {
    const player = createSpritePlayer({ doc, now: () => t, level: () => 'full', load: instant(asked), frame: fn => frames.push(fn), every: 66 });
    const step = ms => { wall += ms; t += ms / 1000; frames.shift()?.(); };
    player.kick();
    // one second of animation frames at 60 a second, breathing only
    let looks = 0; const orig = doc.querySelectorAll; doc.querySelectorAll = sel => { if (sel === 'canvas.lfig') looks++; return orig(sel); };
    for (let i = 0; i < 60; i++) step(1000 / 60);
    assert.ok(looks >= 13 && looks <= 16, `breathing: about fifteen looks a second (${looks})`);
    // a nation is chosen: the flourish waits, then plays; every frame is a look
    specs = page([{ leader: 'aster', motion: 'attack', once: 'pick-0' }]).hosts;
    looks = 0;
    for (let i = 0; i < 60; i++) step(1000 / 60);
    assert.ok(looks >= 55, `a flourish: a look on every animation frame until it is over (${looks})`);
    assert.equal(player.plays.get('pick-0').done, true);
    looks = 0;
    for (let i = 0; i < 60; i++) step(1000 / 60);
    assert.ok(looks <= 16, `over: the slow pace again (${looks})`);
    // looked at before it is chosen: the sheet is fetched ahead, once
    assert.equal(player.warm(3, 'attack'), true);
    assert.equal(player.warm(3, 'attack'), true);
    assert.equal(asked.filter(u => u === leaderStageUrl(3, 'attack')).length, 1, 'one fetch');
    assert.equal(player.warm(9, 'attack'), false); assert.equal(player.warm(3, 'walk'), false);
  } finally { globalThis.performance.now = realNow; }
});
