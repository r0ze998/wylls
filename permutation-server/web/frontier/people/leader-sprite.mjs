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
//   * a sheet is fetched only when a figure may move and is in view, and only
//     after the stills in view have come (the stills are the first picture;
//     the sheets never stand in their way); until a sheet has arrived the
//     still stands (same size, same place: no shift);
//   * a flourish (the chosen leader's attack) begins when its sheet is here,
//     a moment after the press (`FLOURISH_LEAD`: the page's own re-render is
//     over), never on a clock that ran while the sheet was on its way; while
//     it plays the player looks on every animation frame, and a look that
//     comes late shows the next picture, never one further on, so a busy
//     page slows the flourish and loses none of it. The sheet is asked
//     for as soon as a banner that would play it is looked at (`data-flourish`
//     on the banner: hover, focus or press), so it is here at the press;
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
/** A flourish begins this many seconds after it is first seen on the page: the press's own re-render is over by then. */
export const FLOURISH_LEAD = 0.15;
/** A flourish answers a press: a sheet that has not come this many seconds after it is let go, and the figure breathes on. */
export const FLOURISH_PATIENCE = 4;
/** A pointer rests this long (ms) on a banner before its flourish is fetched (a pointer that only crosses the row fetches nothing). */
export const WARM_DWELL = 120;

/** The frame of a stage clip `t` seconds on the clock: a loop wraps (offset by `phase`), a one-shot begun at `start` ends on its last picture. */
export function spriteFrame(clip, t, { start = 0, phase = 0 } = {}) {
  const c = typeof clip === 'string' ? STAGE_CLIPS[clip] : clip;
  if (!c || !Number.isFinite(t)) return 0;
  return motionSpriteFrame(c, c.loop ? (t + phase) / c.duration : (t - start) / c.duration);
}

/**
 * What a figure shows at clock time `t`: `{clip, frame, ended}`. `clip` null is the still (reduced motion, effects
 * off, `motion: 'still'`, or a figure that is not live now). A flourish plays from `start` for its length, then
 * `ended` is true and the figure breathes again; with no `start` yet (its sheet is on its way, or the press is a
 * moment old) the figure breathes and waits.
 */
export function figurePose({ motion = 'idle', level = 'full', t = 0, start = null, done = false, phase = 0, live = true } = {}) {
  // (a flourish is over at once only where nothing may move; a figure that is merely out of sight does not end it for the others that carry its name)
  if (level !== 'full' || motion === 'still' || !live) return { clip: null, frame: 0, ended: motion === 'attack' && level !== 'full' };
  if (motion === 'attack' && !done && start !== null) {
    const c = STAGE_CLIPS.attack;
    if (t - start < c.duration) return { clip: 'attack', frame: spriteFrame(c, t, { start }), ended: false };
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
 * running loop (the breath changes twice a second: the page's player looks 15 times; while a flourish waits or plays
 * it looks on every frame). `tick()` paints every figure once and says how many are moving or waiting for a picture;
 * `kick()` starts the loop if something may move; `warm(faction, clip)` fetches a sheet ahead of its use (nothing
 * where motion is reduced).
 */
export function createSpritePlayer({ doc = globalThis.document, now = clockNow, level = motionLevel, load = null, frame = null, hold = holdArt, heldNow = heldArt, every = 0 } = {}) {
  const pictures = new Map();   // url → {img, state: 'loading' | 'ready' | 'failed'}
  const plays = new Map();      // once-name (or the canvas itself) → {seen, start, shown, done}
  const shown = new WeakMap();  // canvas → what is painted on it now
  let looping = false, urgent = false, stillsWait = false;
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
      // (a sheet that is not held yet is asked for once every still in view has come: the first picture is not kept waiting)
      const url = leaderStageUrl(f, pose.clip), sheet = pictures.get(url) ?? (stillsWait ? null : picture(url));
      if (!sheet) busy = true;
      else if (sheet.state === 'ready') { src = sheet.img; at = pose.frame; what = `${pose.clip}:${at}`; busy = true; }
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
    const lv = level(), t = now(), named = new Set(), stepped = new Set();
    let moving = 0, hurry = false;
    fill();
    const figs = hosts.map(el => ({ el, f: Math.max(0, NATION_KEYS.indexOf(el.getAttribute('data-leader'))), seen: inView(el) }));
    // the stills first: while one that is in view is still on its way, no sheet is asked for
    stillsWait = false;
    for (const { f, seen } of figs) if (seen && picture(leaderStillUrl(f)).state === 'loading') stillsWait = true;
    for (const { el, f, seen } of figs) {
      const motion = el.getAttribute('data-motion') ?? 'idle', name = el.getAttribute('data-once');
      const live = seen && (el.getAttribute('data-when') !== 'look' || looked(el));
      let play = null;
      if (motion === 'attack') {
        const key = name ?? el;
        if (name) named.add(name);
        play = plays.get(key);
        // (reduced motion: the flourish is over before it begins, so it does not play when motion comes back either)
        if (!play) { play = { seen: t, start: null, shown: -1, done: lv !== 'full' }; plays.set(key, play); }
        if (!play.done && lv === 'full' && live && !stepped.has(play)) {
          stepped.add(play);
          if (play.start === null) {
            // it begins when its sheet is here and the press is a moment old; a sheet that cannot be had, or comes far too late, is let go
            const sheet = picture(leaderStageUrl(f, 'attack'));
            if (sheet.state === 'failed' || t - play.seen > FLOURISH_PATIENCE) play.done = true;
            else if (sheet.state === 'ready' && t - play.seen >= FLOURISH_LEAD) play.start = t;
          }
          if (play.start !== null) {
            // a look shows the next picture at the most: when the page was busy and the clock ran on, the clip waited for it
            const c = STAGE_CLIPS.attack, per = c.duration / (c.frames - 1), next = play.shown + 1;
            const due = t - play.start >= c.duration ? c.frames : spriteFrame(c, t, { start: play.start });
            if (due > next) play.start = t - (next >= c.frames ? c.duration : Math.max(0, (next - 0.49) * per));   // (a hair inside the picture's own time)
            play.shown = Math.min(due, next);
          }
        }
      }
      const pose = figurePose({ motion, level: lv, t, start: play?.start ?? null, done: !!play?.done, phase: f * PHASE_STEP, live });
      if (play && pose.ended) play.done = true;
      const waits = !!play && !play.done && live;
      if (waits) hurry = true;
      if (paint(el, f, pose, seen) || waits) moving++;
    }
    urgent = hurry;
    // a flourish's name is forgotten once nothing on the page carries it: chosen again later, it plays again
    for (const key of [...plays.keys()]) if (typeof key === 'string' ? !named.has(key) : !hosts.includes(key)) plays.delete(key);
    return moving;
  }
  let lastLook = -Infinity;
  const wallMs = () => globalThis.performance?.now?.() ?? Date.now();
  function loop() {
    looping = false;
    if (doc?.hidden) return;
    // (between two looks the loop only waits: a breath's picture lasts half a second. A flourish is looked at on every frame)
    if (every > 0 && !urgent && wallMs() - lastLook < every) { looping = true; nextFrame(loop); return; }
    lastLook = wallMs();
    if (tick() > 0) { looping = true; nextFrame(loop); }
  }
  /** Something may have changed (new markup, a hover, a picture arrived): look once now, and keep going if anything moves. */
  function kick() {
    if (looping) return;
    looping = true;
    nextFrame(loop);
  }
  /** Fetch a nation's sheet ahead of its use (the flourish of a banner that is looked at); nothing where motion is reduced. */
  function warm(faction, clip = 'attack') {
    if (level() !== 'full' || !Number.isInteger(faction) || faction < 0 || faction >= NATION_KEYS.length || !STAGE_CLIPS[clip]) return false;
    picture(leaderStageUrl(faction, clip));
    return true;
  }
  return { tick, kick, warm, pictures, plays, get looping() { return looping; }, get urgent() { return urgent; } };
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
    // a banner whose choosing plays a flourish (`data-flourish` beside `data-nation`): the sheet is fetched while it is looked
    // at, so it is here at the press. Focus and press ask at once; a pointer must rest on it a moment
    const banner = e => e.target?.closest?.('[data-nation][data-flourish]') ?? null;
    const warm = b => { if (b) player.warm(Number(b.getAttribute('data-nation')), b.getAttribute('data-flourish')); };
    let rest = 0;
    doc.addEventListener('pointerover', e => {
      const b = banner(e);
      win.clearTimeout?.(rest);
      if (b) rest = win.setTimeout?.(() => { try { if (b.isConnected && b.matches(':hover')) warm(b); } catch { /* gone */ } }, WARM_DWELL);
    }, { passive: true });
    for (const type of ['focusin', 'pointerdown']) doc.addEventListener(type, e => warm(banner(e)), { passive: true });
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
