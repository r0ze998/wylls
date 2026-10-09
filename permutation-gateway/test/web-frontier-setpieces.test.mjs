// The set pieces (UX-DESIGN §8.3; permutation-server/web/frontier/fx/stage.mjs,
// fx/battle.mjs, fx/pieces.mjs, fx/idle.mjs and the staging of
// people/battle.mjs): the battle's choreography inside its 7.0 s (contact
// frames with a hit-stop that does not lengthen it, formations by stance,
// figures by troops on a log scale, who falls when, the verdict from the
// fates), the bell (the banner carried by #bell-toll with a visible state in
// every motion level, this turn's own results in order on the bus), own
// actions (busy, sent, landed, refused), seal and depart (the sealed ribbon
// rests without keeping a frame loop awake and goes at the turn), moments,
// idle life, and the secrecy rule (another nation's departure draws no
// route). What it looks like is judged from the demo switch's frame strips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../permutation-server/web/frontier/fx/clock.mjs';
import { createBus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { createEngine } from '../../permutation-server/web/frontier/fx/engine.mjs';
import { installEffects } from '../../permutation-server/web/frontier/fx/effects.mjs';
import { installStage, playMoment, resultKind, orderResults, RESULT_ORDER, TOLL_BANNER_SECS, TOLL_BANNER_AT, TOLL_CLEAR, MOMENTS_AT_ONCE } from '../../permutation-server/web/frontier/fx/stage.mjs';
import { PIECES, SEAL_PX } from '../../permutation-server/web/frontier/fx/pieces.mjs';
import { stageBattle, verdictTitle, BATTLE_FAR_R } from '../../permutation-server/web/frontier/fx/battle.mjs';
import { paintWater, paintClouds, paintSmoke, installIdle, IDLE_MIN_R } from '../../permutation-server/web/frontier/fx/idle.mjs';
import { SAMPLES, DEMO_SCENES } from '../../permutation-server/web/frontier/fx/demo.mjs';
import * as B from '../../permutation-server/web/frontier/people/battle.mjs';
import * as M from '../../permutation-server/web/frontier/people/moments.mjs';
import { RADIUS } from '../../permutation-server/web/map.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const WEB = fileURLToPath(new URL('../../permutation-server/web/frontier/', import.meta.url));

/** A context whose every method does nothing; it counts the calls and keeps the texts it was asked to draw with their size on screen. */
function recCtx(zoom = 1) {
  const calls = new Map(), texts = [];
  const noop = () => {};
  let scale = 1;
  const stack = [];
  const ctx = new Proxy({}, {
    get: (o, k) => {
      if (k in o) return o[k];
      if (k === 'calls') return calls;
      if (k === 'texts') return texts;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop: noop });
      if (k === 'save') return () => { stack.push(scale); };
      if (k === 'restore') return () => { scale = stack.pop() ?? 1; };
      if (k === 'scale') return sx => { scale *= sx; };
      if (k === 'fillText') return text => { const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(o.font ?? '')?.[1] ?? '0'); texts.push({ text: String(text), px: px * scale * zoom, alpha: o.globalAlpha ?? 1 }); };
      return (...a) => { calls.set(k, (calls.get(k) ?? 0) + 1); return undefined; };
    },
    set: (o, k, v) => { o[k] = v; return true; },
  });
  return ctx;
}
function handClock() {
  let ms = 1000;
  const c = createClock({ now: () => ms });
  c.now();
  return { c, tick: d => { ms += d; } };
}

/** A page just large enough for the engine and the set pieces: elements with a style, classes, a dataset, children and a 2D context that does nothing. */
function fakePage() {
  const made = [];
  const doc = { head: null, body: null, defaultView: null };
  const el = tag => {
    const vars = new Map(), attrs = new Map(), classes = new Set();
    const e = {
      tag, id: '', hidden: false, dataset: {}, children: [], parent: null, textContent: '', ownerDocument: doc, vars, classes,
      get className() { return [...classes].join(' '); }, set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
      classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)), contains: c => classes.has(c) },
      style: { setProperty: (k, v) => vars.set(k, v), getPropertyValue: k => vars.get(k) ?? '', removeProperty: k => vars.delete(k) },
      setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: k => attrs.get(k) ?? null,
      append(...kids) { for (const k of kids) { k.parent = e; e.children.push(k); } },
      replaceChildren(...kids) { e.children.length = 0; e.append(...kids); },
      after(k) { k.parent = e.parent; const list = e.parent?.children ?? []; list.splice(list.indexOf(e) + 1, 0, k); },
      remove() { const list = e.parent?.children ?? []; const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); e.parent = null; },
      getBoundingClientRect: () => ({ left: 280, top: 52, width: 800, height: 848 }),
      offsetLeft: 280, offsetTop: 52, clientWidth: 800, clientHeight: 848, width: 0, height: 0,
      getContext: () => (e.ctx ??= recCtx()),
      querySelector: () => null,
    };
    made.push(e);
    return e;
  };
  Object.assign(doc, { createElement: el, createElementNS: (_, t) => el(t), getElementById: id => made.find(e => e.id === id && e.parent) ?? null, querySelector: sel => (sel.startsWith('#') ? doc.getElementById(sel.slice(1)) : null) });
  doc.head = el('head'); doc.body = el('body');
  const main = el('main'); doc.body.append(main);
  const canvas = el('canvas'); canvas.id = 'frontier-map'; main.append(canvas);
  const toll = el('p'); toll.id = 'bell-toll'; toll.className = 'bell-toll'; main.append(toll);
  const chip = el('span'); chip.id = 'bell-chip'; doc.body.append(chip);
  return { doc, main, canvas, toll };
}

/** An engine with the vocabulary and the set pieces, mounted on a fake page, with frames stepped by hand. */
function staged(motion = 'full') {
  const page = fakePage();
  const queue = [];
  const raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame, docWas = globalThis.document;
  globalThis.requestAnimationFrame = fn => { queue.push(fn); return queue.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = page.doc;
  const { c: clock, tick } = handClock();
  const bus = createBus();
  let level = motion;
  const sounds = [];
  const audio = () => ({ play: (name, o) => { sounds.push([name, o?.delay ?? 0]); return true; } });
  const fx = installEffects(createEngine({ clock, motion: () => level, bus, audio }));
  const stage = installStage(fx, { bus });
  let invalidated = 0;
  const map = { view: { x: 0, y: 0, zoom: 1.3 }, lod: 'tile', art: {}, size: () => ({ width: 800, height: 848 }), invalidate: () => { invalidated++; } };
  fx.mount({ map, canvas: page.canvas });
  const frames = n => { for (let i = 0; i < n && queue.length; i++) queue.shift()(0); };
  return { ...page, fx, bus, clock, tick, frames, map, sounds, stage, queue, setMotion: v => { level = v; }, invalidated: () => invalidated,
    run(ms, step = 50) { for (let t = 0; t < ms; t += step) { tick(step); frames(1); } },
    done() { fx.unmount(); stage.off(); globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = caf; if (docWas === undefined) delete globalThis.document; else globalThis.document = docWas; } };
}

const scene = (name, at = { q: 16, r: -7 }) => { const d = DEMO_SCENES[name](at); return { p: 2, q: 0, bell: 43, tiles: [{ idx: 7, hex: at, attackers: d.attackers, defenders: d.defenders }] }; };

// ================================================================== the battle's choreography
test('battle: four contact frames inside the melee and at the fates; the hit-stop holds the pose 70 ms and gives the time back, so the scene still ends at 7.0 s', () => {
  assert.equal(B.PHASE.end, 7.0);
  assert.equal(B.BATTLE_HITS.length, 4);
  assert.ok(B.BATTLE_HITS.slice(0, 3).every(h => h > B.PHASE.melee && h < B.PHASE.fates), 'three exchanges in the melee');
  assert.equal(B.BATTLE_HITS[3], B.PHASE.fates, 'the blow that decides it opens the fates');
  assert.ok(B.HIT_STOP >= 0.06 && B.HIT_STOP <= 0.08, 'a hit-stop of 60 to 80 ms');
  for (const h of B.BATTLE_HITS) {
    assert.equal(B.poseTime(h), h);
    assert.equal(B.poseTime(h + B.HIT_STOP * 0.9), h, 'held on the contact frame');
    assert.ok(Math.abs(B.poseTime(h + 0.3) - (h + 0.3)) < 1e-9, 'caught up well before the next');
  }
  let prev = -1;
  for (let t = 0; t <= 7; t += 0.005) { const p = B.poseTime(t); assert.ok(p >= prev - 1e-9 && p <= t + 1e-9, `the pose never runs ahead or back (${t})`); prev = p; }
  assert.equal(B.poseTime(7), 7);
  assert.equal(B.poseTime(1), 1, 'no hold outside the contacts');
  assert.deepEqual(B.LOSS_BY_HIT.at(-1), 1, 'the last number shown is the record\'s own total');
});

test('battle: figures by troops on a log scale; formations by stance', () => {
  assert.deepEqual([30, 100, 400, 1000, 5000, 20000, 1e6].map(B.figuresFor), [1, 1, 3, 4, 5, 7, 9]);
  for (let n = 100; n < 1e6; n *= 1.7) assert.ok(B.figuresFor(n * 1.7) >= B.figuresFor(n), 'never fewer for more');
  const wedge = B.formation('assault', 6), line = B.formation('brace', 5), wings = B.formation('flank', 6), block = B.formation('hold', 6);
  assert.equal(wedge.filter(f => f.fx === Math.max(...wedge.map(g => g.fx))).length, 1, 'a wedge has one point');
  assert.deepEqual([1, 2, 3], [0, 1, 2].map(r => wedge.filter(f => Math.abs(f.fx - (wedge[0].fx - r * 0.5)) < 1e-9).length), 'and widens behind it');
  assert.equal(new Set(line.map(f => f.fx)).size, 1, 'a braced line is one rank');
  assert.ok(Math.max(...line.map(f => f.fy)) - Math.min(...line.map(f => f.fy)) < Math.max(...block.map(f => f.fy)) - Math.min(...block.map(f => f.fy)) + 1.2, 'shoulder to shoulder');
  assert.ok(wings.every(f => Math.abs(f.fy) > 0.5), 'the flank leaves the middle empty');
  assert.equal(wings.filter(f => f.fy > 0).length, 3);
  assert.equal(new Set(block.map(f => f.fx)).size, 2, 'a block of two ranks');
  for (const pose of ['hold', 'assault', 'flank', 'brace']) for (let n = 1; n <= 9; n++) assert.equal(B.formation(pose, n).length, n);
});

test('battle plan: a side is its groups; archers stand apart behind the line; a destroyed group has lost every figure by the last contact, a survivor in proportion, unknown losses none', () => {
  const plan = B.battlePlan(scene('win'));
  assert.equal(plan.tiles.length, 1);
  const [A, D] = plan.tiles[0].sides;
  assert.equal(plan.tiles[0].fight, true);
  assert.deepEqual(A.groups.map(g => [g.unit, g.pose, g.ranged, g.n]), [['spearman', 'assault', false, 4], ['archer', 'assault', true, 2]]);
  assert.ok(Math.max(...A.groups[1].figs.map(f => f.fx)) < Math.min(...A.groups[0].figs.map(f => f.fx)), 'the archers are behind every spearman');
  assert.deepEqual([A.before, A.after, A.loss, A.fate], [1220, 1050, 170, 'Stays']);
  assert.deepEqual(D.groups.map(g => [g.kind, g.pose]), [['resident', 'hold'], ['garrison', 'brace']]);
  for (const g of D.groups) { assert.ok(g.figs.every(f => f.fall >= 0 && f.fall <= 3), 'everyone of a destroyed group falls'); assert.ok(g.figs.some(f => f.fall === 3) || g.n < 2); }
  assert.ok(A.groups[0].figs.filter(f => f.fall >= 0).length <= 1, '140 of 900 lost: at most one of four figures');
  assert.ok(D.kb.every((k, j) => k > A.kb[j]), 'the side that lost more is thrown back further');
  // unknown losses: nobody falls, the loss is not a number
  const s = scene('win'); s.tiles[0].defenders = s.tiles[0].defenders.map(x => ({ ...x, after: null, fate: 'Stays' }));
  const D2 = B.battlePlan(s).tiles[0].sides[1];
  assert.equal(D2.loss, null); assert.ok(D2.groups.every(g => g.figs.every(f => f.fall === -1)));
  // a very large host is still at most SIDE_FIGURES_MAX figures a side
  const big = scene('win'); big.tiles[0].attackers = [0, 1, 2, 3].map(f => ({ id: `x${f}`, faction: f, unit: 0, stance: 1, before: 500000, after: 400000, fate: 'Stays', kind: 'arrival' }));
  assert.equal(B.battlePlan(big).tiles[0].sides[0].groups.reduce((n, g) => n + g.n, 0), B.SIDE_FIGURES_MAX);
  // nobody to fight: arrivals on an empty tile are not a fight
  const lone = scene('win'); lone.tiles[0].defenders = [];
  assert.equal(B.battlePlan(lone).tiles[0].fight, false);
});

test('battle verdict: from the fates only', () => {
  assert.deepEqual(B.battleVerdict(scene('win')), { kind: 'taken', winner: 0, side: 'attackers', camp: false, tile: 7 });
  assert.deepEqual(B.battleVerdict(scene('camp')), { kind: 'cleared', winner: 0, side: 'attackers', camp: true, tile: 7 });
  assert.deepEqual(B.battleVerdict(scene('held')), { kind: 'held', winner: 0, side: 'defenders', camp: false, tile: 7 });
  const both = scene('win'); both.tiles[0].defenders = both.tiles[0].defenders.map(x => ({ ...x, after: 100, fate: 'Stays' }));
  assert.equal(B.battleVerdict(both).kind, 'standoff');
  const none = scene('win'); none.tiles[0].attackers = none.tiles[0].attackers.map(x => ({ ...x, after: 0, fate: 'Destroyed' }));
  assert.equal(B.battleVerdict(none).kind, 'ruin');
  const unknown = scene('win'); unknown.tiles[0].attackers[0].fate = null;
  assert.equal(B.battleVerdict(unknown).kind, 'none');
  const lone = scene('win'); lone.tiles[0].defenders = [];
  assert.equal(B.battleVerdict(lone).kind, 'arrived');
});

test('battle titles: the viewer\'s own words, a nation\'s name for a spectator, none when nothing was decided; English has no Japanese', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const t = (name, f) => verdictTitle(scene(name), f);
    assert.equal(t('win', 0).title, lang === 'ja' ? '勝利' : 'Victory');
    assert.equal(t('win', 2).title, lang === 'ja' ? '壊滅' : 'Destroyed');
    assert.equal(t('held', 0).title, lang === 'ja' ? '撃退' : 'Repelled');
    assert.equal(t('held', 4).title, lang === 'ja' ? '壊滅' : 'Destroyed', 'the Destroyed host decides the word, not the one that turned back unhurt');
    assert.equal(t('camp', 0).title, lang === 'ja' ? '野営地を制圧' : 'Camp cleared');
    assert.equal(t('others', null).title, lang === 'ja' ? 'ダンマールの勝利' : 'Dunmar wins');
    assert.equal(t('win', 0).tone, 'win'); assert.equal(t('win', 2).tone, 'loss'); assert.equal(t('others', 0).tone, 'brass');
    assert.equal(t('win', 0).color, '#c1504a', 'in the colour of the nation that holds the tile');
    assert.equal(t('win', 2).color, '#c1504a', 'also for the side that lost');
    for (const name of ['win', 'camp', 'held', 'others']) for (const f of [null, 0, 2, 4]) {
      const v = t(name, f);
      if (lang === 'en') assert.doesNotMatch(`${v.title} ${v.sub}`, /[぀-ヿ一-鿿]/, `${name}/${f}`);
    }
  }
  setLang('ja');
  const both = scene('win'); both.tiles[0].defenders = both.tiles[0].defenders.map(x => ({ ...x, after: 100, fate: 'Stays' }));
  assert.equal(verdictTitle(both, 0), null);
  const lone = scene('win'); lone.tiles[0].defenders = [];
  assert.equal(verdictTitle(lone, 0), null, 'nobody stood against the arrivals: nothing to announce');
});

test('battle painter: every phase draws; loss numbers are at least 24 px on screen and end on the record\'s total; a scene the effects layer has taken is left to it', () => {
  setLang('ja');
  const play = B.startBattle(scene('win'), 0);
  for (const zoom of [0.8, 1.3, 2.1]) {
    const ctx = recCtx(zoom);
    for (const at of [0.3, 1.5, 2.3, ...B.BATTLE_HITS.map(h => h + 0.03), ...B.BATTLE_HITS.map(h => h + 0.3), 5, 6, 6.9]) assert.equal(B.paintBattle(ctx, play, { zoom, at, lossText: n => `−${n} 兵`, fateText: f => f, numText: n => String(n), nameText: () => 'N' }), true, `at ${at}`);
    const losses = ctx.texts.filter(x => /^−\d/.test(x.text) && x.alpha > 0.9);
    assert.ok(losses.length >= 8, 'a number over each side after each contact');
    for (const x of losses) assert.ok(x.px >= 8, x.text);
    // settled numbers (0.3 s after each contact): 26 px for the running total, 32 px for the final
    const settled = recCtx(zoom);
    for (const h of B.BATTLE_HITS) B.paintBattle(settled, play, { zoom, at: h + 0.3, lossText: n => `−${n} 兵`, numText: n => String(n) });
    const nums = settled.texts.filter(x => /^−\d/.test(x.text));
    assert.equal(nums.length, 8);
    for (const x of nums) assert.ok(x.px >= 24, `${x.text} at ${x.px.toFixed(1)} px`);
    assert.deepEqual(nums.map(x => x.text), ['−43', '−195', '−85', '−390', '−128', '−585', '−170 兵', '−780 兵'], 'the running total, then the record\'s own');
    assert.ok(B.battleScale(zoom) * zoom >= 40, 'figures are at least 40 px tall on screen');
  }
  assert.equal(B.paintBattle(recCtx(), play, { zoom: 2, at: 7.2 }), false, 'over after 7.0 s');
  // taken by the effects layer: the map's own call draws nothing and still says it is playing
  const taken = B.startBattle(scene('win'), 0); taken.staged = true;
  const quiet = recCtx();
  assert.equal(B.paintBattle(quiet, taken, { zoom: 2, now: 3 }), true);
  assert.equal(quiet.calls.size, 0);
  assert.equal(B.paintBattle(quiet, taken, { zoom: 2, at: 3, top: true }), true);
  assert.ok(quiet.calls.size > 0);
  assert.equal(B.paintBattle(quiet, taken, { zoom: 2, now: 9 }), false);
});

test('battle on the page: staged above the dimmed map with sparks, dust, shake and sound at each contact; a faster speed shortens all of it; reduced motion shows the field as it was left; off shows the title and the losses only', () => {
  // full motion
  let s = staged('full');
  try {
    const play = B.startBattle(scene('win'), 0);
    const h = stageBattle(s.fx, play, { focus: true, viewerFaction: 0 });
    assert.equal(play.staged, true);
    assert.equal(h.dur, 7);
    assert.equal(h.title.title, '勝利');
    assert.deepEqual(s.fx.playing().slice(0, 2), ['battle-dim', 'battle'], 'the dim is drawn first, the scene over it');
    assert.ok(s.fx.playing().includes('banner') && s.fx.playing().includes('glow'), 'the verdict and the aftermath are scheduled');
    assert.ok(s.fx.particles.count > 150, 'sparks and dust for four contacts');
    const clashes = s.sounds.filter(x => x[0] === 'clash').map(x => x[1]);
    assert.deepEqual(clashes.map(d => Math.round(d * 100) / 100), B.BATTLE_HITS.map(t => Math.round(t * 100) / 100), 'a clash at each contact frame');
    assert.ok(s.sounds.some(x => x[0] === 'drum') && s.sounds.some(x => x[0] === 'shimmer'));
    // the shake comes with the contact, on the world layer
    s.run(B.BATTLE_HITS[0] * 1000 + 40, 20);
    assert.notEqual(`${s.canvas.vars.get('--fx-sx')}${s.canvas.vars.get('--fx-sy')}`, '0.00px0.00px');
    s.run(7600);
    assert.equal(s.queue.length, 0, 'everything ended: no frame loop');
  } finally { s.done(); }
  // a camp that was destroyed burns; a faster speed shortens the scene
  s = staged('full');
  try {
    const play = B.startBattle(scene('camp'), 0, B.BATTLE_SPEEDS.fast);
    const h = stageBattle(s.fx, play, { viewerFaction: 0 });
    assert.ok(Math.abs(h.dur - 2.8) < 1e-9);
    assert.ok(s.fx.playing().includes('burn'));
    assert.equal(h.title.title, '野営地を制圧');
  } finally { s.done(); }
  // reduced
  s = staged('reduced');
  try {
    const play = B.startBattle(scene('held'), 0);
    stageBattle(s.fx, play, { viewerFaction: 0 });
    assert.equal(s.fx.particles.count, 0, 'no particles');
    assert.deepEqual(s.fx.playing(), ['battle', 'banner']);
    s.run(300);
    assert.equal(s.canvas.vars.get('--fx-sx') ?? '0.00px', '0.00px', 'no shake');
    const top = s.fx.top.ctx;
    assert.ok(top.texts.some(x => x.text === '撃退') === false, 'the title is a DOM banner, not canvas text');
    assert.ok(top.texts.some(x => /^−/.test(x.text)), 'the losses are shown');
  } finally { s.done(); }
  // off
  s = staged('off');
  try {
    const play = B.startBattle(scene('win'), 0);
    stageBattle(s.fx, play, { viewerFaction: 0 });
    assert.deepEqual(s.fx.playing(), ['label', 'label', 'banner']);
    assert.equal(B.battleLive(play, 1), false, 'the map keeps its own tokens on the tile');
  } finally { s.done(); }
  assert.ok(BATTLE_FAR_R > 10 && BATTLE_FAR_R < 25);
});

// ================================================================== the bell
test('the bell: the banner is carried by #bell-toll and is visible in every motion level; the bell sounds; afterwards the element is handed back', () => {
  for (const level of ['full', 'reduced', 'off']) {
    const s = staged(level);
    try {
      setLang('ja');
      s.bus.emit('bell', { turn: 43, home: { p: 2, q: 0, tile: 7 } });
      assert.ok(s.sounds.some(x => x[0] === 'bell'), 'the bell');
      s.run(900);
      assert.ok(s.toll.classList.contains('fx-banner-host') && s.toll.classList.contains('fx-banner'), level);
      // (wave 2: the title is two parts and the dash between them, so a narrow map breaks it between the parts, never inside a word)
      const title = s.toll.children.find(k => k.classes.has('fx-banner-title'));
      assert.deepEqual(title.children.map(k => k.textContent), ['鐘が鳴りました', ' — ', 'ターン 43']);
      assert.equal(s.toll.hidden, false);
      assert.ok(Number(s.toll.vars.get('--fx-o')) > 0.9, `${level}: fully visible`);
      assert.ok(Number(s.toll.vars.get('--fx-to')) > 0.9);
      // (wave 2: placed by the stage the HUD leaves free, in client px: its left edge, its width and its middle line)
      assert.equal(s.toll.vars.get('--fx-l'), '280.0px', 'placed over the map by its measured box');
      assert.equal(s.toll.vars.get('--fx-w'), '800.0px');
      const cy = parseFloat(s.toll.vars.get('--fx-cy'));
      assert.ok(cy > 52 && cy < 52 + 848 * 0.3, `under the top of the free stage (${cy})`);
      if (level === 'full') assert.ok(s.fx.playing().includes('toll'));
      else assert.ok(!s.fx.playing().includes('chip') || level === 'reduced');
      s.run((TOLL_BANNER_SECS + 0.5) * 1000);
      assert.equal(s.toll.classList.contains('fx-banner-host'), false, 'handed back');
      assert.equal(s.toll.hidden, true, 'and hidden: no frame of its resting style shows');
      assert.equal(s.toll.children.length, 0);
      assert.equal(s.toll.textContent, '鐘が鳴りました — ターン 43');
      assert.equal(s.toll.vars.size, 0);
    } finally { s.done(); }
  }
  setLang('en');
  const s = staged('full');
  try {
    s.bus.emit('bell', { turn: 1234 });
    s.run(600);
    assert.equal(s.toll.children.find(k => k.classes.has('fx-banner-title')).children.map(k => k.textContent).join(''), 'The bell has tolled — Turn 1,234');
  } finally { s.done(); setLang('ja'); }
  // the stylesheet gives the carried banner a visible state of its own (no animation needed)
  const css = readFileSync(`${WEB}fx/fx.css`, 'utf8');
  const rule = /#bell-toll\.fx-banner-host\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  for (const v of ['--fx-o: 1', '--fx-band: 1', '--fx-to: 1', 'animation: none']) assert.ok(rule.includes(v), v);
  assert.doesNotMatch(css, /@keyframes|animation:(?!\s*none)|transition:/, 'no CSS animation in the effects sheet');
});

test('the turn\'s own results: arrivals, then battles, then warnings, played after the toll and published as turn:results; nothing twice', () => {
  assert.deepEqual(RESULT_ORDER, ['arrival', 'battle', 'incoming']);
  assert.equal(resultKind({ id: 'rv:9', kind: 'march' }), 'arrival');
  assert.equal(resultKind({ id: 'st:9', kind: 'march' }), null, 'a march that can be settled is not one of the three');
  assert.equal(resultKind({ id: 'cl:2,0,39', kind: 'battle' }), 'battle');
  assert.equal(resultKind({ id: 'in:44,2,0', kind: 'incoming' }), 'incoming');
  assert.equal(resultKind({ id: 'bd:x', kind: 'build' }), null);
  assert.deepEqual(orderResults([{ result: 'incoming', id: 1 }, { result: 'battle', id: 2 }, { result: 'arrival', id: 3 }, { result: 'battle', id: 4 }]).map(x => x.id), [3, 2, 4, 1]);
  const s = staged('full');
  try {
    const got = [];
    s.bus.on('turn:results', p => got.push(p));
    s.bus.emit('bell', { turn: 43 });
    const fresh = [
      { id: 'in:44,2,0', kind: 'incoming', p: 2, q: 0, tile: 7, text: 'w' },
      { id: 'cl:2,0,42', kind: 'battle', p: 2, q: 0, tile: 7, battle: { p: 2, q: 0, bell: 42 }, text: 'b' },
      { id: 'bd:1', kind: 'build', p: 2, q: 0, text: 'x' },
      { id: 'rv:77', kind: 'march', p: 3, q: 0, tile: 12, faction: 0, text: 'a' },
    ];
    s.bus.emit('feed', { turn: 43, fresh });
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].items.map(x => x.kind), ['arrival', 'battle', 'incoming']);
    assert.deepEqual(got[0].items[0], { id: 'rv:77', kind: 'arrival', p: 3, q: 0, tile: 12, text: 'a', battle: null });
    assert.equal(got[0].turn, 43);
    // (wave 2: not before the banner has faded under a tenth of its opacity; it was 0.9 s before its end)
    assert.ok(Math.abs(got[0].startsIn - TOLL_CLEAR) < 1e-6 && TOLL_CLEAR >= TOLL_BANNER_AT + TOLL_BANNER_SECS - 0.05, 'they start when the toll\'s banner has gone');
    assert.ok(['unseal', 'swords', 'alarm'].every(n => s.fx.playing().includes(n)));
    s.bus.emit('feed', { turn: 43, fresh });
    assert.equal(got.length, 1, 'the same results are not played twice');
    s.bus.emit('feed', { turn: 43, fresh: [{ id: 'rv:78', kind: 'march', p: 3, q: 0, tile: 13 }] });
    assert.deepEqual(got[1].items.map(x => x.id), ['rv:77', 'rv:78', 'cl:2,0,42', 'in:44,2,0'], 'the turn\'s list, in order');
    assert.deepEqual(got[1].fresh.map(x => x.id), ['rv:78']);
    s.bus.emit('bell', { turn: 44 });
    s.bus.emit('feed', { turn: 44, fresh: [{ id: 'cl:2,0,43', kind: 'battle', p: 2, q: 0, tile: 7 }] });
    assert.deepEqual(got[2].items.map(x => x.id), ['cl:2,0,43'], 'a new turn starts a new list');
    // the last 30 s
    const before = s.fx.playing().length;
    s.bus.emit('turn:urgent', { turn: 44, secondsLeft: 30 });
    assert.equal(s.fx.playing().length, before + 1);
    assert.ok(s.sounds.some(x => x[0] === 'tick'));
  } finally { s.done(); }
});

// ================================================================== own actions; seal and depart
test('own actions: a ring turns while it is tracked; landed bursts in the nation\'s colour with a sound; refused beats red; the pending ring goes either way', () => {
  const s = staged('full');
  try {
    const a = { id: 'Build#1', name: 'Build', faction: 0, tile: { p: 2, q: 0, tile: 7 } };
    s.bus.emit('action:busy', a);
    // (fix pass 2: the ring is said on the map too, on a small tag over the tile)
    assert.deepEqual(s.fx.playing(), ['pending', 'waiting']);
    s.bus.emit('action:sent', a);
    assert.ok(s.fx.playing().includes('ripple'));
    s.run(400);
    s.bus.emit('action:landed', a);
    assert.ok(!s.fx.playing().includes('pending') && !s.fx.playing().includes('waiting'), 'the ring and its tag are gone');
    assert.ok(['flash', 'mark', 'burst', 'pip'].every(n => s.fx.playing().includes(n)));
    assert.ok(s.sounds.some(x => x[0] === 'confirm'));
    s.run(2500);
    assert.equal(s.queue.length, 0);
    const b = { id: 'Train#2', name: 'Train', faction: 0, tile: { p: 2, q: 0, tile: 7 } };
    s.bus.emit('action:busy', b);
    s.bus.emit('action:refused', b);
    // (fix pass 2: the refusal is named on the map; the pending ring and its tag are gone)
    assert.deepEqual(s.fx.playing(), ['pulse', 'mark', 'tag', 'pip']);
    assert.ok(s.sounds.some(x => x[0] === 'refuse'));
    // an action with no tile (joining): the sound only
    s.run(2500);
    s.bus.emit('action:landed', { id: 'Join#3', name: 'Join', faction: 0, tile: null });
    assert.deepEqual(s.fx.playing(), []);
  } finally { s.done(); }
  // reduced motion: states, no particles, no shake
  const r = staged('reduced');
  try {
    r.bus.emit('action:refused', { id: 'x', name: 'Build', faction: 0, tile: { p: 2, q: 0, tile: 7 } });
    assert.equal(r.fx.particles.count, 0);
    assert.deepEqual(r.fx.playing(), ['pulse', 'mark', 'tag', 'pip']);
  } finally { r.done(); }
});

test('seal and depart: the route draws on while the order is sent, the seal stamps at 56 px, the column sets off, and the sealed ribbon rests for the owner until the turn without keeping a frame loop awake', () => {
  assert.equal(SEAL_PX, 56);
  const s = staged('full');
  try {
    const a = { id: 'Depart#1', name: 'Depart', faction: 0, unit: 0, tile: { p: 2, q: 0, tile: 7 }, dest: { p: 2, q: 0, tile: 32 }, route: { p: 2, q: 0, tile: 7, dirs: [0, 0, 1] } };
    s.bus.emit('action:busy', a);
    assert.deepEqual(s.fx.playing(), ['route', 'pending', 'waiting']);
    s.run(900);
    s.bus.emit('march:sealed', a);
    assert.deepEqual(s.fx.playing(), ['sealed', 'route', 'stamp', 'walker', 'pip'], 'the waiting ribbon and ring gave way to the seal');
    assert.ok(s.sounds.some(x => x[0] === 'seal'));
    s.run(5000);
    assert.deepEqual(s.fx.playing(), ['sealed'], 'the ribbon rests');
    assert.equal(s.queue.length, 0, 'and wakes no frame loop');
    assert.equal(s.fx.live().live, 0);
    // it is drawn with the map's own paint (on the ground: props stand on it)
    const ground = recCtx(1.3);
    assert.ok(s.fx.paintGround(ground, { zoom: 1.3 }) >= 1);
    assert.ok(ground.texts.some(x => x.text === '封印済み · あなたにだけ見えます'), 'marked as shown only to its owner');
    // the turn: it goes
    s.bus.emit('bell', { turn: 44 });
    assert.ok(!s.fx.playing().includes('sealed'));
    // refused: no seal, the ribbon goes, the tile beats red
    const b = { ...a, id: 'Depart#2' };
    s.bus.emit('action:busy', b);
    s.bus.emit('action:refused', b);
    assert.ok(!s.fx.playing().includes('route') && !s.fx.playing().includes('sealed') && s.fx.playing().includes('pulse'));
  } finally { s.done(); }
});

// ================================================================== moments
test('moments: what happened between two looks, never at the first sight of a province', () => {
  const prov = (extra = {}) => new Map([['2,0', { province: { p: 2, q: 0, sites: [22, 39, 3, 7], siteMirror: [{ state: 0 }, { state: 0 }, { state: 0 }, { state: 1, faction: 0 }], entries: [{ id: 5n, state: 1, tile: 7, faction: 0, unit: 0, troops: 400000 }], camp: { state: 1, tile: 32 }, ...extra }, inputs: null }]]);
  const s0 = M.momentSnapshot({ provinces: prov() });
  assert.deepEqual(M.detectMoments(null, s0, 0), [], 'the first look is not news');
  assert.deepEqual(M.detectMoments(M.momentSnapshot({}), s0, 0), [], 'nor is the first sight of a province: no muster, no village, no camp');
  // a new host in a known province: mustered
  const s1 = M.momentSnapshot({ provinces: prov({ entries: [{ id: 5n, state: 1, tile: 7, faction: 0, unit: 0, troops: 400000 }, { id: 6n, state: 1, tile: 7, faction: 0, unit: 2, troops: 300000 }] }) });
  assert.deepEqual(M.detectMoments(s0, s1, 3).map(m => [m.kind, m.tile, m.faction, m.unit]), [['muster', 7, 0, 2]]);
  // it sets out: only that it left and from where
  const s2 = M.momentSnapshot({ provinces: prov({ entries: [{ id: 5n, state: 3, tile: 7, faction: 0, unit: 0, troops: 400000 }] }) });
  const dep = M.detectMoments(s0, s2, 3);
  assert.deepEqual(dep.map(m => m.kind), ['depart']);
  assert.deepEqual(Object.keys(dep[0]).sort(), ['faction', 'id', 'kind', 'p', 'q', 't0', 'tile'], 'no destination, no heading');
  // the camp is gone; a site changes hands; a site is lost; a village is founded
  const s3 = M.momentSnapshot({ provinces: prov({ camp: { state: 0, tile: 32 }, siteMirror: [{ state: 1, faction: 3 }, { state: 0 }, { state: 0 }, { state: 1, faction: 2 }] }) });
  assert.deepEqual(M.detectMoments(s0, s3, 3).map(m => [m.kind, m.tile, m.from ?? null, m.to ?? null]), [['camp', 32, null, null], ['village', 22, null, 3], ['village', 7, 0, 2]]);
  const s4 = M.momentSnapshot({ provinces: prov({ siteMirror: [{ state: 0 }, { state: 0 }, { state: 0 }, { state: 0 }] }) });
  assert.deepEqual(M.detectMoments(s0, s4, 3).map(m => [m.kind, m.from, m.to]), [['village', 0, null]]);
  // harvest and built carry the tile of their site once the province is known
  const a = M.momentSnapshot({ life: new Map([['2,0,3', { harvest: 40 }]]), constructions: [{ p: 2, q: 0, site: 3, name: 'Farm' }], provinces: prov() });
  const b = M.momentSnapshot({ life: new Map([['2,0,3', { harvest: 41 }]]), constructions: [], provinces: prov() });
  assert.deepEqual(M.detectMoments(a, b, 5).map(m => [m.kind, m.tile, m.label ?? null]), [['harvest', 7, null], ['built', 7, 'Farm']]);
  // a revealed arrival carries its nation
  const c = M.momentSnapshot({ provinces: new Map([['2,0', { province: prov().get('2,0').province, inputs: { arrivals: [{ present: 1, tile: 9, hostId: 8n, faction: 4 }] } }]]) });
  assert.deepEqual(M.detectMoments(s0, c, 5).map(m => [m.kind, m.tile, m.faction]), [['arrive', 9, 4]]);
  assert.deepEqual(M.detectMoments(M.momentSnapshot({}), c, 5), [], 'arrivals of a province seen for the first time are not news either');
});

test('moments on the page: each has its parts and a pip for the far view; an own harvest flies to the strip and says res:gain; another nation\'s departure draws no route, ribbon or column', () => {
  const s = staged('full');
  try {
    setLang('ja');
    const at = { p: 2, q: 0, tile: 7 };
    const gains = [];
    s.bus.on('res:gain', p => gains.push(p));
    const parts = kind => { s.fx.clear(); s.bus.emit('moment', { kind, ...at, faction: 3, id: kind, own: false, label: 'Farm', from: 0, to: 3 }); return s.fx.playing(); };
    const has = (kind, names) => { const list = parts(kind); return names.every(n => list.includes(n)); };
    // (wave 2: a moment's caption is a `tag` (a bell-metal tag on a leader), not a floating `label`; built and village take in the land round the tile)
    assert.ok(has('built', ['flash', 'glow', 'pillar', 'ripple', 'dust', 'burst', 'tag', 'pip']), 'built');
    assert.ok(has('muster', ['glow', 'forming', 'tag', 'pip']), 'muster');
    assert.ok(has('arrive', ['burst', 'flash', 'ripple', 'tag', 'pip']), 'arrive');
    assert.ok(has('camp', ['dust', 'burst', 'ripple', 'tag', 'pip']), 'camp');
    assert.ok(has('village', ['glow', 'raise', 'ripple', 'tag', 'pip']), 'village');
    // another nation's host set out: dust, a seal, a word, a pip, and nothing that could show where to
    const dep = parts('depart');
    assert.deepEqual([...new Set(dep)].sort(), ['dust', 'pip', 'stamp', 'tag']);
    for (const banned of ['route', 'sealed', 'walker']) assert.ok(!dep.includes(banned), banned);
    // harvest: another nation's stays on the map
    assert.ok(has('harvest', ['flash', 'burst', 'ripple', 'pip']), 'harvest');
    assert.equal(gains.length, 0, 'someone else\'s harvest does not count into the viewer\'s stores');
    // an own harvest with no strip on the page: the gain is said at once
    s.fx.clear();
    playMoment(s.fx, { kind: 'harvest', ...at, site: 3, faction: 0, own: true }, { bus: s.bus });
    assert.deepEqual(gains, [{ p: 2, q: 0, site: 3, tile: 7 }]);
    // one thing is not announced twice in a row
    s.fx.clear();
    s.bus.emit('moment', { kind: 'camp', p: 4, q: 1, tile: 3 });
    const n = s.fx.playing().length;
    s.bus.emit('moment', { kind: 'camp', p: 4, q: 1, tile: 3 });
    assert.equal(s.fx.playing().length, n);
    // a whole view resolving at once: the first few play in full, one after another; the rest leave their pip; the viewer's own always plays
    s.fx.clear(); s.run(9000, 500);
    for (let i = 0; i < 12; i++) s.bus.emit('moment', { kind: 'arrive', p: 5, q: 0, tile: i, faction: 2 });
    assert.equal(s.fx.playing().filter(n => n === 'tag').length, MOMENTS_AT_ONCE);
    assert.equal(s.fx.playing().filter(n => n === 'pip').length, 12, 'none is dropped without a trace');
    s.bus.emit('moment', { kind: 'built', p: 2, q: 0, tile: 9, own: true, label: 'Farm' });
    assert.ok(s.fx.playing().includes('pillar'));
    // every part exists on the engine
    for (const name of Object.keys(PIECES)) assert.ok(s.fx.has(name), name);
  } finally { s.done(); }
  // English labels
  setLang('en');
  const e = staged('off');
  try {
    for (const kind of ['built', 'muster', 'arrive', 'camp', 'village', 'depart']) {
      e.fx.clear();
      playMoment(e.fx, { kind, p: 2, q: 0, tile: 7, faction: 1, from: 0, to: 1, label: 'Farm' });
      assert.deepEqual(e.fx.playing(), ['tag'], `${kind}: with effects off, the caption only`);
    }
  } finally { e.done(); setLang('ja'); }
});

// ================================================================== idle life
test('idle life: glints on water, shadows that drift, smoke over villages that are drawn; nothing in reduced motion, far out, or under what the viewer has not surveyed', () => {
  const tiles = [
    { q: 0, r: 0, x: 0, y: 0, name: 'water', fog: 'clear' },
    { q: 1, r: 0, x: 76, y: 0, name: 'plains', fog: 'clear', site: 3, state: 1, owner: 2 },
    { q: 2, r: 0, x: 152, y: 0, name: 'plains', fog: 'distant', site: 4, state: 1, owner: 2 },
    { q: 3, r: 0, x: 228, y: 0, name: 'plains', fog: 'clear', site: 5, state: 0 },
    { q: 4, r: 0, x: 304, y: 0, name: 'water', fog: 'unopened', cloud: true },
    { q: 90, r: 0, x: 6840, y: 0, name: 'water', fog: 'clear' },
  ];
  const st = t => ({ t, zoom: 1.3, px: 1 / 1.3, tiles, mode: 'full', view: { x: 100, y: 0, zoom: 1.3 }, size: { width: 800, height: 600 }, invalidate() {} });
  assert.equal(paintWater(recCtx(), st(1)), 1, 'the one water tile in view that is drawn');
  assert.equal(paintSmoke(recCtx(), st(1)), 1, 'the one village in sight');
  let clouds = 0;
  for (let t = 0; t < 400; t += 20) clouds += paintClouds(recCtx(), st(t));
  assert.ok(clouds > 0, 'a shadow crosses the view sooner or later');
  // on an engine: painted through the tile painter's two passes, asking for the next frame itself
  const timers = [];
  const setT = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 1; };
  try {
    let level = 'full', invalidated = 0;
    const { c: clock } = handClock();
    const fx = createEngine({ clock, motion: () => level, bus: createBus() });
    const off = installIdle(fx);
    fx.mount({ map: { view: { x: 100, y: 0, zoom: 1.3 }, size: () => ({ width: 800, height: 600 }), invalidate: () => { invalidated++; } }, canvas: null });
    assert.equal(fx.paintGround(recCtx(), { zoom: 1.3, tiles }), 1);
    assert.ok(fx.paintOver(recCtx(), { zoom: 1.3, tiles }) >= 1);
    assert.equal(timers.length, 1, 'one frame asked for');
    assert.ok(timers[0] >= 90, 'at most about ten a second');
    assert.equal(fx.live().live, 0, 'idle life never counts as a live effect');
    level = 'reduced';
    assert.equal(fx.paintGround(recCtx(), { zoom: 1.3, tiles }) + fx.paintOver(recCtx(), { zoom: 1.3, tiles }), 0, 'off in reduced motion');
    level = 'full';
    const far = (IDLE_MIN_R - 2) / RADIUS;
    assert.equal(fx.paintGround(recCtx(), { zoom: far, tiles }) + fx.paintOver(recCtx(), { zoom: far, tiles }), 0, 'off when the land is small');
    assert.equal(timers.length, 1);
    off();
    assert.equal(fx.paintOver(recCtx(), { zoom: 1.3, tiles }), 0);
    void invalidated;
  } finally { globalThis.setTimeout = setT; }
});

// ================================================================== the wiring and the demo
test('the page reports real events on the bus; every set piece has a demo sample', () => {
  const app = readFileSync(`${WEB}app.mjs`, 'utf8'), ctl = readFileSync(`${WEB}controller.mjs`, 'utf8'), art = readFileSync(`${WEB}map/sprites.mjs`, 'utf8');
  for (const ev of ['bell', 'turn:urgent', 'feed', 'moment', 'battle']) assert.ok(app.includes(`fxEmit('${ev}'`), `app.mjs emits ${ev}`);
  for (const ev of ['action:busy', 'action:sent', 'action:landed', 'action:refused']) assert.ok(ctl.includes(`'${ev}'`), `controller.mjs emits ${ev}`);
  assert.match(ctl, /fxEmit\(r\.ok \? 'march:sealed' : 'action:refused', fxa\)/);
  // (integration: the map has flyTo, which centres above a phone's sheet; the ground pass comes through the map's `between` hook)
  assert.match(app, /mapRef\.flyTo\(\{ p, q, tile: scene\.tiles\[0\]\.idx, zoom: 2\.1 \}, 500\)/, 'the camera flies to a battle');
  assert.match(readFileSync(`${WEB}fx/index.mjs`, 'utf8'), /map\.between = \(ctx, \{ zoom \}\) => paintGround\(ctx, \{ zoom, tiles: map\.art\?\.tiles \?\? null \}\)/, 'the ground pass is the map\'s between hook');
  assert.match(art, /fxOver\(ctx, \{ zoom, tiles \}\)/);
  for (const n of ['battle', 'battle-camp', 'battle-held', 'battle-others', 'battle-fast', 'bell', 'turn', 'results', 'action', 'landed', 'refused', 'pending', 'seal', 'built', 'harvest', 'harvest-other', 'muster', 'arrive', 'camp', 'village', 'village-lost', 'depart', 'reveal']) {
    assert.ok(typeof SAMPLES[n]?.run === 'function', `a sample for ${n}`);
  }
  // the samples run on a page, in both languages, and add effects
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const s = staged('full');
    try {
      const c = { at: { q: 16, r: -7 }, origin: { x: 0, y: 0 } };
      const later = d => ({ ...s.fx, play: (n, a = {}) => s.fx.play(n, { ...a, delay: (a.delay ?? 0) + d }), add: spec => s.fx.add({ ...spec, delay: (spec.delay ?? 0) + d }), sound: () => false, shake: () => false, mounted: true });
      for (const [name, sample] of Object.entries(SAMPLES)) {
        if (!sample.run) continue;
        s.fx.clear();
        sample.run(c, s.fx, later);
        assert.ok(s.fx.playing().length >= 1, `${lang} ${name}`);
      }
    } finally { s.done(); }
  }
  setLang('ja');
});
