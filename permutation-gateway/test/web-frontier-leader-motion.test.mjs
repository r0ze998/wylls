import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOTION_LEADERS, LEADER_MOTIONS, motionSelection, motionSpriteUrl, motionSpriteFrame, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE, LEADER_SPRITE_ANCHOR } from '../../permutation-server/web/frontier/leader-motion-data.mjs';

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
  const { consumer: C, draws, requests, ctx, find } = await fixture(t);
  let redraws = 0; C.onLeaderMotionLoad(() => redraws++);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'attack' }), false);
  const idle = find('/ember_idle.webp'); idle.load(1024, 256);
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'attack', share: .9 }), true);
  assert.equal(draws.at(-1)[0], idle);
  const attack = find('/ember_attack.webp'); attack.load(256, 2048); // wrong orientation
  assert.equal(C.leaderMotionStatus('ember', 'attack'), 'failed');
  assert.equal(C.leaderMotionStatus('ember', 'idle'), 'ready');
  assert.equal(C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'attack' }), true);
  assert.equal(draws.at(-1)[0], idle);
  C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'hit' }); find('/ember_hit.webp').fail();
  const count = requests.length; C.paintLeaderMotion(ctx, 0, 0, 20, { leader: 'ember', motion: 'hit' });
  assert.equal(draws.at(-1)[0], idle); assert.equal(requests.length, count); assert.equal(redraws, 3);
});
