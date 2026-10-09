import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOTION_LEADERS, LEADER_MOTIONS, motionSelection, motionSpriteUrl, motionSpriteFrame, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE, LEADER_SPRITE_ANCHOR, LEADER_SHEET_2X_FROM, LEADER_BREATH, motionSheetSet, motionInSet } from '../../permutation-server/web/frontier/leader-motion-data.mjs';

let lifecycle = 0;
async function fixture(t) {
  const previous = globalThis.Image, requests = [], draws = [], transforms = [], stack = [];
  globalThis.Image = class {
    constructor() { requests.push(this); }
    load(width, height) { this.width = width; this.height = height; this.onload?.(); }
    fail() { this.onerror?.(); }
  };
  t.after(() => { if (previous === undefined) delete globalThis.Image; else globalThis.Image = previous; });
  const consumer = await import(`../../permutation-server/web/frontier/people/leader-motion.mjs?lifecycle=${++lifecycle}`);
  const ctx = {
    globalAlpha: 1, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    translate(...values) { transforms.push(['translate', ...values]); }, scale(...values) { transforms.push(['scale', ...values]); },
    drawImage(...values) { draws.push(values); }, beginPath() {}, ellipse() {}, stroke() {},
  };
  const find = suffix => requests.find(image => image.src.endsWith(suffix));
  return { consumer, requests, draws, transforms, ctx, find };
}

test('all six map identities retain the accepted colors and local motion paths', () => {
  assert.deepEqual(MOTION_LEADERS.map(leader => leader.colorName), ['赤', '水色', '黄色', '紫', '白', 'オレンジ']);
  assert.equal(motionSelection('missing', 'missing').leader.key, 'aster');
  for (const leader of MOTION_LEADERS) for (const motion of LEADER_MOTIONS) assert.ok(motionSpriteUrl(leader.key, motion.key).endsWith(`/motion-v1/sprite/${leader.key}_${motion.key}.webp`));
});

test('oneshot actions keep their final image while walk and idle wrap', () => {
  for (const motion of LEADER_MOTIONS) {
    assert.equal(motionSpriteFrame(motion, 0), 0);
    assert.equal(motionSpriteFrame(motion, 1), motion.loop ? 0 : motion.frames - 1);
    assert.equal(motionSpriteFrame(motion, 20), motion.loop ? 0 : motion.frames - 1);
    assert.equal(motionSpriteFrame(motion, .999), motion.frames - 1);
    assert.equal(motionSpriteFrame(motion, NaN), 0);
  }
  const walk = LEADER_MOTIONS.find(motion => motion.key === 'walk');
  const attack = LEADER_MOTIONS.find(motion => motion.key === 'attack');
  assert.equal(motionSpriteFrame(walk, 1, false), 0, 'stopping a full walk cycle keeps the GLB endpoint pose');
  assert.equal(motionSpriteFrame(attack, .9, true), 6, 'forcing replay does not change inclusive one-shot sampling');
});

test('the motion consumer crops every accepted action frame, flips at the feet and preserves alpha', async t => {
  const { consumer: C, draws, transforms, requests, ctx, find } = await fixture(t);
  for (const leader of MOTION_LEADERS) for (const motion of LEADER_MOTIONS) {
    C.paintLeaderMotion(ctx, 50, 80, 35, { leader: leader.key, motion: motion.key });
    const sheet = find(`/${leader.key}_${motion.key}.webp`); sheet.load(motion.frames * 256, 256);
    for (let frame = 0; frame < motion.frames; frame++) {
      const share = motion.loop ? (frame + .1) / motion.frames : frame / (motion.frames - 1);
      assert.equal(C.paintLeaderMotion(ctx, 50, 80, 35, { leader: leader.key, motion: motion.key, share, alpha: .5, face: -1, own: true }), true);
      assert.deepEqual(draws.at(-1).slice(0, 5), [sheet, frame * 256, 0, 256, 256]);
      const width = 35 * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
      assert.deepEqual(draws.at(-1).slice(5), [-width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width]);
      assert.equal(ctx.globalAlpha, 1);
      assert.deepEqual(transforms.slice(-2), [['translate', 50, 80], ['scale', -1, 1]]);
    }
  }
  const count = requests.length;
  C.paintLeaderMotion(ctx, 50, 80, 35);
  assert.equal(requests.length, count, 'all frames share one decoded atlas');
});

test('pending, failed and malformed action sheets keep a decoded idle pose without repeated requests', async t => {
  // (rewritten on 2026-10-10 for the two sets of sheets: a sheet that failed is still never asked for again, and the
  // other set's sheet of that action is asked for once as its stand-in; until one of them is here the idle pose stands)
  const { consumer: C, draws, requests, ctx, find } = await fixture(t);
  let redraws = 0; C.onLeaderMotionLoad(() => redraws++);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'attack' }), false);
  assert.deepEqual(requests.map(r => r.src.split('/motion-v1/')[1]), ['sprite/ember_attack.webp', 'sprite/ember_idle.webp'], 'a small figure asks for the package\'s own sheets');
  const idle = find('/sprite/ember_idle.webp'); idle.load(1024, 256);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'attack', share: .9 }), true);
  assert.equal(draws.at(-1)[0], idle);
  const attack = find('/sprite/ember_attack.webp'); attack.load(256, 2048); // wrong orientation
  assert.equal(C.leaderMotionStatus('ember', 'attack'), 'failed');
  assert.equal(C.leaderMotionStatus('ember', 'idle'), 'ready');
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'attack' }), true);
  assert.equal(draws.at(-1)[0], idle);
  assert.ok(find('/sprite@2x/ember_attack.webp'), 'the other set\'s sheet is asked for in its place');
  C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'hit' }); find('/sprite/ember_hit.webp').fail();
  C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'hit' });
  const count = requests.length;
  for (let i = 0; i < 3; i++) { C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'hit' }); C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'attack' }); }
  assert.equal(draws.at(-1)[0], idle); assert.equal(requests.length, count, 'nothing is asked for twice'); assert.equal(redraws, 3);
  assert.equal(new Set(requests.map(r => r.src)).size, requests.length);
  // the stand-in arrives: the action plays from it, with that set's cell
  const big = find('/sprite@2x/ember_attack.webp'); big.load(4096, 512);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'attack', share: 1 }), true);
  assert.deepEqual(draws.at(-1).slice(0, 5), [big, 7 * 512, 0, 512, 512]);
});

// ------------------------------------------------------------------ the two sets of sheets (2026-10-10; DECISIONS ZQ3)
/** The fixture's context with a transform of `k` device px a unit (a real canvas says its own). */
const scaled = (ctx, k) => Object.assign(ctx, { getTransform: () => ({ a: k, b: 0, c: 0, d: k, e: 0, f: 0 }) });

test('the set of sheets is chosen by the size drawn times the device pixel ratio', () => {
  assert.equal(LEADER_SHEET_2X_FROM, 205);
  assert.equal(motionSheetSet(LEADER_SHEET_2X_FROM - 0.01), '1x'); assert.equal(motionSheetSet(LEADER_SHEET_2X_FROM), '2x');
  for (const px of [0, 60, 204]) assert.equal(motionSheetSet(px), '1x');
  for (const px of [205, 256, 512, 2000]) assert.equal(motionSheetSet(px), '2x');
  for (const odd of [NaN, undefined, null, -5]) assert.equal(motionSheetSet(odd), '1x');
  // the 2x idle has eight frames across the same two seconds; nothing else differs
  const idle = LEADER_MOTIONS.find(m => m.key === 'idle');
  assert.deepEqual(motionInSet(idle, '2x'), { ...idle, frames: 8 }); assert.equal(motionInSet(idle, '2x'), motionInSet(idle, '2x'));
  for (const m of LEADER_MOTIONS) { assert.equal(motionInSet(m, '1x'), m); if (m.key !== 'idle') assert.equal(motionInSet(m, '2x'), m); }
  for (const l of MOTION_LEADERS) for (const m of LEADER_MOTIONS) assert.ok(motionSpriteUrl(l.key, m.key, '2x').endsWith(`/motion-v1/sprite@2x/${l.key}_${m.key}.webp`));
  assert.ok(motionSpriteUrl('aster', 'idle', 'nonsense').endsWith('/motion-v1/sprite/aster_idle.webp'));
});

test('a figure drawn large on the device is painted from the 2x sheet: lazily, with its own cell and its eight idle frames', async t => {
  const { consumer: C, draws, requests, ctx, find } = await fixture(t);
  // height 35 → a cell 110 units wide: 110 device px on a plain screen, 220 on a dense one
  const width = 35 * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  assert.equal(C.leaderCellWidth(35), width); assert.equal(C.contextScale(ctx), 1); assert.equal(C.contextScale(scaled({}, 2)), 2);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 35, { leader: 'aster' }), false);
  assert.deepEqual(requests.map(r => r.src.split('/motion-v1/')[1]), ['sprite/aster_idle.webp'], 'small: the package\'s sheet, and only that');
  find('/sprite/aster_idle.webp').load(1024, 256);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 35, { leader: 'aster', share: 0.6 }), true);
  assert.deepEqual(draws.at(-1).slice(1, 5), [2 * 256, 0, 256, 256], 'four frames: the third at 0.6 of the loop');
  // the same figure on a screen of ratio 2: the 2x sheet is asked for; the 1x one stands until it is here
  scaled(ctx, 2);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 35, { leader: 'aster', share: 0.6 }), true);
  assert.deepEqual(requests.map(r => r.src.split('/motion-v1/')[1]), ['sprite/aster_idle.webp', 'sprite@2x/aster_idle.webp']);
  assert.equal(draws.at(-1)[0], find('/sprite/aster_idle.webp'));
  const fine = find('/sprite@2x/aster_idle.webp'); fine.load(4096, 512);
  assert.equal(C.leaderMotionStatus('aster', 'idle', '2x'), 'ready');
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 35, { leader: 'aster', share: 0.6 }), true);
  assert.deepEqual(draws.at(-1).slice(0, 5), [fine, 4 * 512, 0, 512, 512], 'eight frames: the fifth at 0.6 of the loop');
  assert.deepEqual(draws.at(-1).slice(5), [-width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width], 'the same place and size on the board');
  // `px` says the size on the device where the context cannot
  const n = requests.length;
  C.paintLeaderMotion(scaled(ctx, 1), 0, 0, 35, { leader: 'borealis', px: 400 });
  assert.deepEqual(requests.slice(n).map(r => r.src.split('/motion-v1/')[1]), ['sprite@2x/borealis_idle.webp']);
  // a sheet of the wrong size for its set is refused
  find('/sprite@2x/borealis_idle.webp').load(1024, 256);
  assert.equal(C.leaderMotionStatus('borealis', 'idle', '2x'), 'failed');
});

test('a finer sheet that has been asked for serves a smaller figure too: nothing is fetched twice for one figure', async t => {
  const { consumer: C, draws, requests, ctx, find } = await fixture(t);
  // the page asks ahead for the size of the hero frame (2x), then the opening's first frames draw the figure small
  assert.equal(C.leaderMotionPick('cinder', 'idle', 420), null);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'cinder' }), false, 'on its way: nothing is drawn, and the 1x sheet is not asked for');
  assert.deepEqual(requests.map(r => r.src.split('/motion-v1/')[1]), ['sprite@2x/cinder_idle.webp']);
  const fine = find('/sprite@2x/cinder_idle.webp'); fine.load(4096, 512);
  const set = [];
  ctx.imageSmoothingQuality = 'low';
  const draw = ctx.drawImage; ctx.drawImage = (...a) => { set.push(ctx.imageSmoothingQuality); draw.call(ctx, ...a); };
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'cinder' }), true);
  assert.equal(draws.at(-1)[0], fine); assert.equal(requests.length, 1);
  assert.deepEqual(set, ['high'], 'a 512 px frame drawn small is reduced with the better filter');
  assert.deepEqual(C.leaderMotionPick('cinder', 'idle', 30), { image: fine, set: '2x' });
  // a 2x sheet that failed: the package's own stands in, at any size
  C.leaderMotionPick('dunmar', 'idle', 600); find('/sprite@2x/dunmar_idle.webp').fail();
  assert.equal(C.leaderMotionPick('dunmar', 'idle', 600), null);
  find('/sprite/dunmar_idle.webp').load(1024, 256);
  assert.deepEqual(C.leaderMotionPick('dunmar', 'idle', 600), { image: find('/sprite/dunmar_idle.webp'), set: '1x' });
  assert.deepEqual(C.leaderMotionPick('dunmar', 'idle', 30), { image: find('/sprite/dunmar_idle.webp'), set: '1x' });
  // (added 2026-10-10 after the review) a figure drawn small first (its 1x sheet is here), then large (the 2x sheet
  // is asked for), then small again before the 2x sheet has come: the 1x sheet goes on being drawn. It returned
  // nothing there, and the figure left the screen until the 2x sheet arrived.
  assert.equal(C.leaderMotionPick('ember', 'idle', 100), null);
  const coarse = find('/sprite/ember_idle.webp'); coarse.load(1024, 256);
  assert.deepEqual(C.leaderMotionPick('ember', 'idle', 100), { image: coarse, set: '1x' });
  assert.deepEqual(C.leaderMotionPick('ember', 'idle', 420), { image: coarse, set: '1x' }, 'closer in: the 2x sheet is asked for, the 1x one stands until it is here');
  const asked = requests.length;
  assert.equal(C.leaderMotionStatus('ember', 'idle', '2x'), 'pending');
  assert.deepEqual(C.leaderMotionPick('ember', 'idle', 100), { image: coarse, set: '1x' }, 'out again while the 2x sheet is on its way: the 1x sheet that is here is drawn');
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember' }), true);
  assert.equal(draws.at(-1)[0], coarse); assert.equal(requests.length, asked, 'and nothing more is fetched');
  const sharp = find('/sprite@2x/ember_idle.webp'); sharp.load(4096, 512);
  assert.deepEqual(C.leaderMotionPick('ember', 'idle', 100), { image: sharp, set: '2x' }, 'once it is here the finer sheet serves the smaller figure too');
});

test('a standing figure breathes: a little taller and narrower about its feet on a slow sine; the frames themselves are the package\'s', async t => {
  const { consumer: C, transforms, ctx, find } = await fixture(t);
  assert.deepEqual(LEADER_BREATH, { rise: 0.03, narrow: 0.012, secs: 2 });
  assert.equal(C.leaderBreath(0), 0); assert.ok(Math.abs(C.leaderBreath(1) - 1) < 1e-12); assert.ok(Math.abs(C.leaderBreath(2)) < 1e-12);
  assert.ok(Math.abs(C.leaderBreath(0.5) - 0.5) < 1e-12); assert.equal(C.leaderBreath(NaN), 0);
  C.paintLeaderMotion(ctx, 5, 9, 30, { leader: 'aster' }); find('/sprite/aster_idle.webp').load(1024, 256);
  transforms.length = 0;
  C.paintLeaderMotion(ctx, 5, 9, 30, { leader: 'aster' });
  assert.deepEqual(transforms, [['translate', 5, 9]], 'no breath asked for: the frame as it is');
  transforms.length = 0;
  C.paintLeaderMotion(ctx, 5, 9, 30, { leader: 'aster', breath: 1, face: -1 });
  assert.deepEqual(transforms, [['translate', 5, 9], ['scale', -1, 1], ['scale', 1 - LEADER_BREATH.narrow, 1 + LEADER_BREATH.rise]], 'about the feet: after the move to them');
});
