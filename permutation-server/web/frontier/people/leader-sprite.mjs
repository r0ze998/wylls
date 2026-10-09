// The one small sprite player for the leaders on stage (the title, the nation
// choice, the first-village banner, the leader's line cards). A screen writes
//
//   leaderFigure(faction, { motion: 'idle' | 'attack' | 'still', once, when })
//
// into its markup (a canvas of one stage cell: people/leader-art.mjs
// stageFigure) and this module paints every such canvas that is on the page:
//
//   * time comes from the effects clock when it exists (`globalThis.__fxNow`,
//     fx/clock.mjs: the demo switch freezes and steps it), else from the page;
//   * the frame is a pure function of that time (`figurePose`), so a page
//     that is rendered again shows the same pose, and six leaders breathe a
//     little apart (`PHASE_STEP`);
//   * the player holds the pictures: a file is fetched once a page, however
//     often the markup around a figure is written again (the servers send
//     `no-store`: a picture named in markup would be fetched again each time
//     and the figure would blink). A canvas that has just come onto the page
//     is painted in the same task, before the next paint;
//   * an icon or a bust in markup (an SVG <image data-art>: leader-art.mjs
//     artImage) gets its picture from the player too, as a data URL;
//   * a sheet is fetched only when a figure may move and is in view; until it
//     has arrived the still stands (same size, same place: no shift);
//   * a figure out of view, in a hidden part of the page or in a background
//     tab is not moved, and with no moving figure the loop stops;
//   * reduced motion (fx/motion.mjs: the system's setting or the player's
//     own) is a complete mode: every figure is its still, the flourish does
//     not play, no sheet is fetched.
//
// Nothing here invents an actor: a figure is a picture of a nation's leader
// beside that leader's name or line.
import { motionSpriteFrame } from '../leader-motion-data.mjs';
import { motion as motionLevel } from '../fx/motion.mjs';
import { STAGE_CELL, STAGE_CLIPS, STAGE_FOOT, leaderStageUrl, leaderStillUrl, stageFigure, heldArt, holdArt, onArtWanted } from './leader-art.mjs';
import { NATION_KEYS } from '../palette.mjs';

/** Seconds between the breaths of two neighbouring leaders (six in a row do not move as one). */
export const PHASE_STEP = 0.37;

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
  // (a flourish is over at once only where nothing may move; a figure that is merely out of sight does not end it for the others that carry its name)
  if (level !== 'full' || motion === 'still' || !live) return { clip: null, frame: 0, ended: motion === 'attack' && level !== 'full' };
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
 * A player over `doc`. `now()` seconds, `level()` the motion level, `load(url, done)` fetches a picture and gives
 * `done` something a canvas can draw (default: an Image; null when it cannot be had), `frame(fn)` asks for the
 * next animation frame (default: requestAnimationFrame), `every` the least milliseconds between two looks of the
 * running loop (the clips change 4 to 10 times a second: the page's player looks 15 times). `tick()` paints every
 * figure once and says how many are moving or waiting for a picture; `kick()` starts the loop if something may move.
 */
export function createSpritePlayer({ doc = globalThis.document, now = clockNow, level = motionLevel, load = null, frame = null, hold = holdArt, heldNow = heldArt, every = 0 } = {}) {
  const pictures = new Map();   // url → {img, state: 'loading' | 'ready' | 'failed'}
  const plays = new Map();      // once-name (or the canvas itself) → {start, done}
  const shown = new WeakMap();  // canvas → what is painted on it now
  let looping = false;
  const win = doc?.defaultView ?? globalThis;
  const nextFrame = frame ?? (fn => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : win.setTimeout?.(fn, 50)));
  const fetchPicture = load ?? ((url, done) => {
    if (typeof win.Image !== 'function') { done(null); return; }
    const img = new win.Image();
    img.onload = () => done(img); img.onerror = () => done(null);
    img.src = url;
  });
  const picture = url => {
    let rec = pictures.get(url);
    if (rec) return rec;
    rec = { img: null, state: 'loading' };
    pictures.set(url, rec);
    fetchPicture(url, img => { rec.img = img; rec.state = img ? 'ready' : 'failed'; kick(); });
    return rec;
  };
  const inView = el => {
    const r = el.getBoundingClientRect?.();
    if (!r) return true;
    if (!(r.width > 0 && r.height > 0)) return false;
    const vw = win.innerWidth ?? 1e9, vh = win.innerHeight ?? 1e9;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  };
  const looked = el => {
    // (the thing that holds it: an ancestor that names a nation, or the nation's banner beside it in the same list item)
    const holder = el.closest?.('[data-nation]') ?? el.parentElement?.parentElement?.querySelector?.('[data-nation]') ?? null;
    if (!holder) return true;
    try { return holder.getAttribute('aria-pressed') === 'true' || !!holder.matches?.(':hover, :focus-visible'); } catch { return false; }
  };

  /** Paint one figure: the frame of its sheet when that has come, else its still; returns whether it moves or waits. */
  function paint(el, f, pose, seen) {
    // (a figure that cannot be seen asks for nothing: no picture is fetched for a part of the page that is put away)
    if (!seen) return false;
    const still = picture(leaderStillUrl(f));
    let src = null, at = 0, what = '', busy = false;
    if (pose.clip) {
      const sheet = picture(leaderStageUrl(f, pose.clip));
      if (sheet.state === 'ready') { src = sheet.img; at = pose.frame; what = `${pose.clip}:${at}`; busy = true; }
      else if (sheet.state === 'loading') busy = true;
    }
    if (!src) { if (still.state === 'ready') { src = still.img; what = 'still'; } else if (still.state === 'loading') busy = true; }
    if (!src || shown.get(el) === `${f}:${what}`) return busy;
    const g = el.getContext?.('2d');
    if (!g) return busy;
    const { w, h } = STAGE_CELL;
    g.clearRect(0, 0, w, h);
    if (el.getAttribute('data-shadow') !== '0') {
      g.save();
      g.globalAlpha = 0.34; g.fillStyle = '#000';
      g.beginPath(); g.ellipse?.(w * STAGE_FOOT[0], h * STAGE_FOOT[1] - 7, 74, 9, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    g.drawImage(src, at * w, 0, w, h, 0, 0, w, h);
    shown.set(el, `${f}:${what}`);
    return busy;
  }

  /** Give every `<image data-art>` in view its picture (a data URL held by the page); returns how many still wait. */
  const asked = new Set();
  function fill() {
    let waiting = 0;
    for (const im of doc?.querySelectorAll ? [...doc.querySelectorAll('image[data-art]')] : []) {
      const url = im.getAttribute('data-art'), data = heldNow(url);
      if (data) { im.setAttribute('href', data); im.removeAttribute('data-art'); continue; }
      if (data === null && asked.has(url) && !waitingFor.has(url)) continue;   // it cannot be had: the place stays empty
      if (!inView(im.closest?.('svg') ?? im)) continue;
      waiting++;
      if (!asked.has(url)) { asked.add(url); waitingFor.add(url); Promise.resolve(hold(url)).then(() => { waitingFor.delete(url); kick(); }); }
    }
    return waiting;
  }
  const waitingFor = new Set();

  /** Paint every figure once and fill every picture; returns how many figures are moving or waiting for a picture. */
  function tick() {
    const hosts = doc?.querySelectorAll ? [...doc.querySelectorAll('canvas.lfig')] : [];
    const lv = level(), t = now(), named = new Set();
    let moving = 0;
    fill();
    for (const el of hosts) {
      const f = Math.max(0, NATION_KEYS.indexOf(el.getAttribute('data-leader')));
      const motion = el.getAttribute('data-motion') ?? 'idle', name = el.getAttribute('data-once');
      const seen = inView(el), live = seen && (el.getAttribute('data-when') !== 'look' || looked(el));
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
      if (paint(el, f, pose, seen)) moving++;
    }
    // a flourish's name is forgotten once nothing on the page carries it: chosen again later, it plays again
    for (const key of [...plays.keys()]) if (typeof key === 'string' ? !named.has(key) : !hosts.includes(key)) plays.delete(key);
    return moving;
  }
  let lastLook = -Infinity;
  const wallMs = () => globalThis.performance?.now?.() ?? Date.now();
  function loop() {
    looping = false;
    if (doc?.hidden) return;
    // (between two looks the loop only waits: a frame of a clip lasts 80 ms at the least)
    if (every > 0 && wallMs() - lastLook < every) { looping = true; nextFrame(loop); return; }
    lastLook = wallMs();
    if (tick() > 0) { looping = true; nextFrame(loop); }
  }
  /** Something may have changed (new markup, a hover, a picture arrived): look once now, and keep going if anything moves. */
  function kick() {
    if (looping) return;
    looping = true;
    nextFrame(loop);
  }
  return { tick, kick, pictures, plays, get looping() { return looping; } };
}

let player = null;
/**
 * Start the page's player (once): it wakes when figures appear or change, when the pointer or the focus moves
 * over a nation's banner, when the tab comes back and when the motion setting changes.
 */
export function startLeaderSprites(doc = globalThis.document) {
  if (player || !doc?.querySelectorAll || !doc.addEventListener) return player;
  player = createSpritePlayer({ doc, every: 66 });
  const wake = () => player.kick();
  try {
    const win = doc.defaultView ?? globalThis;
    if (typeof win.MutationObserver === 'function' && doc.documentElement) {
      // (new markup: a canvas that has just come onto the page is painted in the same task, before the next paint)
      new win.MutationObserver(() => { player.tick(); wake(); }).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed', 'data-motion', 'data-title', 'data-sheet', 'data-drawer', 'data-look'] });
    }
    for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout', 'visibilitychange']) doc.addEventListener(type, wake, { passive: true });
    win.addEventListener?.('scroll', wake, { passive: true, capture: true });
    win.addEventListener?.('resize', wake, { passive: true });
    win.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', wake);
    // (the player's own "effects" setting has no event: a slow look catches it and anything else that was missed)
    win.setInterval?.(wake, 1500);
  } catch { /* a page without these: figures stay unpainted stills */ }
  wake();
  return player;
}

onArtWanted(() => startLeaderSprites());

/**
 * A leader standing, for a screen's markup (options as people/leader-art.mjs stageFigure). Writing one starts the
 * player on a page; without a page (tests) it is the canvas's markup and nothing else happens.
 */
export function leaderFigure(faction, opts = {}) {
  startLeaderSprites();
  return stageFigure(faction, opts);
}
