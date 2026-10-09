// The one small sprite player for the leaders on stage (the title, the nation
// choice, the first-village banner, the leader's line cards). A screen writes
//
//   leaderFigure(faction, { size, motion: 'idle' | 'attack' | 'still', once, when })
//
// into its markup (a still: people/leader-art.mjs stageFigureSvg) and this
// module moves every such figure that is on the page:
//
//   * time comes from the effects clock when it exists (`globalThis.__fxNow`,
//     fx/clock.mjs: the demo switch freezes and steps it), else from the page;
//   * the frame is a pure function of that time (`figurePose`), so a page
//     that is rendered again shows the same pose, and six leaders breathe a
//     little apart (`PHASE_STEP`);
//   * the sheet is fetched only when a figure may move and is in view; until
//     it has arrived the still stays (same size, same place: no shift);
//   * a figure out of view, in a hidden part of the page or in a background
//     tab is not touched, and with no moving figure the loop stops;
//   * reduced motion (fx/motion.mjs: the system's setting or the player's
//     own) is a complete mode: every figure is its still, the flourish does
//     not play, no sheet is fetched.
//
// Nothing here invents an actor: a figure is a picture of a nation's leader
// beside that leader's name or line.
import { motionSpriteFrame } from '../leader-motion-data.mjs';
import { motion as motionLevel } from '../fx/motion.mjs';
import { STAGE_CELL, STAGE_CLIPS, leaderStageUrl, stageFigureSvg } from './leader-art.mjs';
import { NATION_KEYS } from '../palette.mjs';

/** Seconds between the breaths of two neighbouring leaders (six in a row do not move as one). */
export const PHASE_STEP = 0.37;
const SVG = 'http://www.w3.org/2000/svg';

/** The frame of a stage clip `t` seconds on the clock: a loop wraps (offset by `phase`), a one-shot begun at `start` ends on its last picture. */
export function spriteFrame(clip, t, { start = 0, phase = 0 } = {}) {
  const c = typeof clip === 'string' ? STAGE_CLIPS[clip] : clip;
  if (!c || !Number.isFinite(t)) return 0;
  return motionSpriteFrame(c, c.loop ? (t + phase) / c.duration : (t - start) / c.duration);
}

/**
 * What a figure shows at clock time `t`: `{clip, frame, ended}`. `clip` null is the still (reduced motion, effects
 * off, `motion: 'still'`, or a figure that is not live now). A flourish plays from `start` for its length, then
 * `ended` is true and the figure breathes again.
 */
export function figurePose({ motion = 'idle', level = 'full', t = 0, start = null, done = false, phase = 0, live = true } = {}) {
  if (level !== 'full' || motion === 'still' || !live) return { clip: null, frame: 0, ended: motion === 'attack' };
  if (motion === 'attack' && !done) {
    const from = start ?? t, c = STAGE_CLIPS.attack;
    if (t - from < c.duration) return { clip: 'attack', frame: spriteFrame(c, t, { start: from }), ended: false };
    return { clip: 'idle', frame: spriteFrame('idle', t, { phase }), ended: true };
  }
  return { clip: 'idle', frame: spriteFrame('idle', t, { phase }), ended: false };
}

const clockNow = () => {
  try { const t = globalThis.__fxNow?.(); if (Number.isFinite(t)) return t; } catch { /* a clock that throws: the page's own time */ }
  return (globalThis.performance?.now?.() ?? Date.now()) / 1000;
};

/**
 * A player over `doc`. `now()` seconds, `level()` the motion level, `load(url, done)` fetches a sheet (default: an
 * Image), `frame(fn)` asks for the next animation frame (default: requestAnimationFrame). `tick()` moves every
 * figure once and says how many are moving; `kick()` starts the loop if something may move.
 */
export function createSpritePlayer({ doc = globalThis.document, now = clockNow, level = motionLevel, load = null, frame = null } = {}) {
  const sheets = new Map();   // url → 'loading' | 'ready' | 'failed'
  const plays = new Map();    // once-name → {start, done}
  let looping = false;
  const win = doc?.defaultView ?? globalThis;
  const nextFrame = frame ?? (fn => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : win.setTimeout?.(fn, 50)));
  const fetchSheet = load ?? ((url, done) => {
    if (typeof win.Image !== 'function') { done(false); return; }
    const img = new win.Image();
    img.onload = () => done(true); img.onerror = () => done(false);
    img.src = url;
  });
  const sheet = url => {
    const s = sheets.get(url);
    if (s) return s;
    sheets.set(url, 'loading');
    fetchSheet(url, ok => { sheets.set(url, ok ? 'ready' : 'failed'); kick(); });
    return sheets.get(url);
  };
  const inView = el => {
    const r = el.getBoundingClientRect?.();
    if (!r) return true;
    if (!(r.width > 0 && r.height > 0)) return false;
    const vw = win.innerWidth ?? 1e9, vh = win.innerHeight ?? 1e9;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  };
  const looked = el => {
    const holder = el.closest?.('[data-nation]');
    if (!holder) return true;
    try { return holder.getAttribute('aria-pressed') === 'true' || !!holder.matches?.(':hover, :focus-visible'); } catch { return false; }
  };
  const still = el => { el.querySelector?.('.lfig-sheet')?.remove(); el.querySelector?.('.lfig-still')?.removeAttribute?.('visibility'); };

  function show(el, f, pose) {
    if (!pose.clip) { still(el); return false; }
    const url = leaderStageUrl(f, pose.clip), c = STAGE_CLIPS[pose.clip];
    // (until the sheet is here the still stays; a sheet that cannot load leaves the still for good)
    if (sheet(url) !== 'ready') { if (!el.querySelector?.('.lfig-sheet')) still(el); return sheets.get(url) === 'loading'; }
    let img = el.querySelector?.('.lfig-sheet');
    if (!img) {
      img = doc.createElementNS(SVG, 'image');
      img.setAttribute('class', 'lfig-sheet'); img.setAttribute('height', String(STAGE_CELL.h));
      el.append(img);
    }
    if (img.getAttribute('href') !== url) { img.setAttribute('href', url); img.setAttribute('width', String(STAGE_CELL.w * c.frames)); }
    const x = String(-pose.frame * STAGE_CELL.w);
    if (img.getAttribute('x') !== x) img.setAttribute('x', x);
    el.querySelector?.('.lfig-still')?.setAttribute?.('visibility', 'hidden');
    return true;
  }

  /** Move every figure once; returns how many are moving or waiting for their sheet. */
  function tick() {
    const hosts = doc?.querySelectorAll ? [...doc.querySelectorAll('svg.lfig')] : [];
    const lv = level(), t = now(), named = new Set();
    let moving = 0;
    for (const el of hosts) {
      const f = Math.max(0, NATION_KEYS.indexOf(el.getAttribute('data-leader')));
      const motion = el.getAttribute('data-motion') ?? 'idle', name = el.getAttribute('data-once');
      const live = inView(el) && (el.getAttribute('data-when') !== 'look' || looked(el));
      let play = null;
      if (motion === 'attack') {
        const key = name ?? el;
        if (name) named.add(name);
        play = plays.get(key);
        // (reduced motion: the flourish is over before it begins, so it does not play when motion comes back either)
        if (!play) { play = { start: t, done: lv !== 'full' }; plays.set(key, play); }
      }
      const pose = figurePose({ motion, level: lv, t, start: play?.start ?? null, done: !!play?.done, phase: f * PHASE_STEP, live });
      if (play && pose.ended) play.done = true;
      if (show(el, f, pose)) moving++;
    }
    // a flourish's name is forgotten once nothing on the page carries it: chosen again later, it plays again
    for (const key of [...plays.keys()]) if (typeof key === 'string' ? !named.has(key) : !hosts.includes(key)) plays.delete(key);
    return moving;
  }
  function loop() {
    looping = false;
    if (doc?.hidden) return;
    if (tick() > 0) { looping = true; nextFrame(loop); }
  }
  /** Something may have changed (new markup, a hover, a sheet arrived): look once now, and keep going if anything moves. */
  function kick() {
    if (looping) return;
    looping = true;
    nextFrame(loop);
  }
  return { tick, kick, sheets, plays, get looping() { return looping; } };
}

let player = null;
/**
 * Start the page's player (once): it wakes when figures appear or change, when the pointer or the focus moves
 * over a nation's banner, when the tab comes back and when the motion setting changes.
 */
export function startLeaderSprites(doc = globalThis.document) {
  if (player || !doc?.querySelectorAll || !doc.addEventListener) return player;
  player = createSpritePlayer({ doc });
  const wake = () => player.kick();
  try {
    const win = doc.defaultView ?? globalThis;
    if (typeof win.MutationObserver === 'function' && doc.documentElement) {
      // (new markup: the first look happens in the same task as the change, before the next paint)
      new win.MutationObserver(() => { player.tick(); wake(); }).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed', 'data-motion', 'data-title'] });
    }
    for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout', 'visibilitychange']) doc.addEventListener(type, wake, { passive: true });
    win.addEventListener?.('scroll', wake, { passive: true, capture: true });
    win.addEventListener?.('resize', wake, { passive: true });
    win.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', wake);
    // (the player's own "effects" setting has no event: a slow look catches it and anything else that was missed)
    win.setInterval?.(wake, 1500);
  } catch { /* a page without these: figures stay stills */ }
  wake();
  return player;
}

/**
 * A leader standing, for a screen's markup (options as people/leader-art.mjs stageFigureSvg). Writing one starts
 * the player on a page; without a page (tests) it is the still's markup and nothing else happens.
 */
export function leaderFigure(faction, opts = {}) {
  startLeaderSprites();
  return stageFigureSvg(faction, opts);
}
