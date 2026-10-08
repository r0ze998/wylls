// Sound (UX-DESIGN §8.4): every sound is synthesised with WebAudio when it is
// played; there are no audio files (the servers have no audio content type
// and nothing may be downloaded).
//
//   bell     the Engine's bell: a struck bronze bell. Inharmonic partials in
//            the tuning of a cast bell (hum an octave under the strike note,
//            a minor-third tierce, the nominal an octave over), each low
//            partial a pair a fraction of a hertz apart so the tail beats,
//            the high partials gone in a second and the hum ringing for ten.
//   seal     the wax seal coming down: a short low thunk with a brass tick.
//   clash    one hit of steel: a noise crack over ringing inharmonic partials
//            (pitch varies with the seed, so a volley is not one sample).
//   tick     a soft press: every button answers with it.
//   shimmer  a reveal: a rising spray of high partials and air.
//   drum     incoming: two low strokes.
//
// Nothing sounds before the first user gesture (browsers refuse it and a
// game that speaks first is rude); the context is created on that gesture.
// Mute is remembered on this device (`ps-ffx:v1`). The master level is modest
// and limited. `globalThis.__fxAudio = {toggle(), muted, play(name)}` is the
// handle the speaker button uses.
//
// Each sound is a function over any BaseAudioContext, so `render(name)` can
// build it into an OfflineAudioContext. That is how the bell was tuned: it
// was rendered in Chromium and measured, not judged from the code. Measured
// (44.1 kHz, strike note 196 Hz): partials at 98, 196, 235, 294, 392, 492,
// 590, 797, 1044, 1315, 1604 and 2078 Hz; in the first 93 ms the nominal
// (392 Hz) leads at -21 dB and the spectrum rolls off to -52 dB at 2 kHz;
// the level falls 14 dB in the first 2 s, 29 dB by 4 s and 43 dB by 6.5 s;
// the spectral centroid sinks from 354 Hz at the strike to 108 Hz at 6 s
// (the bright partials die first, the hum is left); the paired partials make
// the tail swell and sink by 5 to 7 dB without dropping out; peak 0.41 of
// full scale through the master chain.
import { hashSeed, rng } from './rand.mjs';

export const MUTE_KEY = 'ps-ffx:v1';
export const SOUND_NAMES = Object.freeze(['bell', 'seal', 'clash', 'tick', 'shimmer', 'drum']);
/** Seconds each sound lasts (its tail included): the offline render length and the voice's lifetime. */
export const SOUND_SECS = Object.freeze({ bell: 9, seal: 0.6, clash: 0.7, tick: 0.12, shimmer: 1.8, drum: 1.6 });
/** The shortest gap between two plays of one sound, in ms (a volley must not stack into noise). */
const MIN_GAP = { bell: 1500, seal: 180, clash: 55, tick: 45, shimmer: 250, drum: 600 };
const MASTER = 0.5;

/**
 * The bell's partials: [ratio to the strike note, level, seconds to fall 60 dB, beat in Hz (0 = single)].
 * Ratios after the five named partials of a cast bell (hum 0.5, prime 1, tierce 1.2, quint 1.5,
 * nominal 2) and the upper ones a bell-founder cannot tune (2.5, 3, 4, 5.3, 6.7, 8.2 and above).
 */
export const BELL_PARTIALS = Object.freeze([
  [0.5, 0.42, 11.0, 0.35],
  [1.0, 0.80, 8.0, 0.55],
  [1.2, 0.62, 6.0, 0.8],
  [1.5, 0.24, 4.2, 0],
  [2.0, 1.00, 4.6, 1.1],
  [2.51, 0.32, 2.6, 0],
  [3.01, 0.46, 2.1, 1.7],
  [4.07, 0.42, 1.4, 0],
  [5.33, 0.30, 0.95, 0],
  [6.71, 0.22, 0.62, 0],
  [8.21, 0.15, 0.4, 0],
  [10.6, 0.09, 0.24, 0],
  [13.2, 0.05, 0.15, 0],
]);
/** The bell's strike note in Hz (G3: a town bell, heavy but present on small speakers through its nominal at 392). */
export const BELL_HZ = 196;

// ------------------------------------------------------------------ small graph helpers
const noiseBuffers = new WeakMap();
function noise(ac) {
  let b = noiseBuffers.get(ac);
  if (b) return b;
  const len = Math.floor(ac.sampleRate * 1.5);
  b = ac.createBuffer(1, len, ac.sampleRate);
  const d = b.getChannelData(0), r = rng(hashSeed('fx-noise'));
  for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  noiseBuffers.set(ac, b);
  return b;
}

const rooms = new WeakMap();
/** A small hall: a convolver over a decaying, darkening noise tail made here (no file). */
function room(ac) {
  let c = rooms.get(ac);
  if (c) return c;
  const secs = 2.4, len = Math.floor(ac.sampleRate * secs);
  const b = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch), r = rng(hashSeed(`fx-room-${ch}`));
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const k = i / len;
      // early part bright, tail dark: a one-pole lowpass whose corner falls with time
      const a = 0.55 - 0.45 * k;
      lp += a * ((r() * 2 - 1) - lp);
      d[i] = lp * Math.exp(-5.2 * k) * (i < 400 ? i / 400 : 1);
    }
  }
  c = ac.createConvolver();
  c.buffer = b;
  rooms.set(ac, c);
  return c;
}

/** A gain whose level follows points [[seconds after t0, level], …]: linear to the first, exponential after. */
function shaped(ac, t0, points) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.00001, t0);
  points.forEach(([dt, v], i) => {
    const at = t0 + dt, val = Math.max(0.00001, v);
    if (i === 0) g.gain.linearRampToValueAtTime(val, at); else g.gain.exponentialRampToValueAtTime(val, at);
  });
  return g;
}
function tone(ac, type, f, t0, stop, dest) {
  const o = ac.createOscillator();
  o.type = type; o.frequency.setValueAtTime(f, t0);
  o.connect(dest); o.start(t0); o.stop(stop);
  return o;
}
function burst(ac, t0, secs, dest, offset = 0) {
  const s = ac.createBufferSource();
  s.buffer = noise(ac);
  s.connect(dest); s.start(t0, offset % 1.2, secs + 0.05);
  return s;
}
function filter(ac, type, f, q, dest) {
  const n = ac.createBiquadFilter();
  n.type = type; n.frequency.value = f; n.Q.value = q;
  n.connect(dest);
  return n;
}

// ------------------------------------------------------------------ the sounds: (ac, {dry, wet}, t0, {seed, level}) → nothing
const BUILD = {
  bell(ac, { dry, wet }, t0, { level = 1, hz = BELL_HZ } = {}) {
    const mix = ac.createGain();
    mix.gain.value = 0.2 * level;
    mix.connect(dry);
    const send = ac.createGain(); send.gain.value = 0.34; mix.connect(send); send.connect(wet);
    for (const [ratio, amp, t60, beat] of BELL_PARTIALS) {
      const f = hz * ratio;
      // the low partials bloom a moment after the strike; the high ones are there at once
      const attack = ratio < 1 ? 0.045 : ratio < 2.2 ? 0.012 : 0.004;
      // a pair a fraction of a hertz apart: the tail swells and sinks (about 7 dB), it never drops out
      const voices = beat ? [[f, amp * 0.8], [f + beat, amp * 0.3]] : [[f, amp]];
      for (const [vf, va] of voices) {
        const g = shaped(ac, t0, [[attack, va], [attack + t60, va * 0.001]]);
        g.connect(mix);
        tone(ac, 'sine', vf, t0, t0 + attack + t60 + 0.05, g);
      }
    }
    // the clapper: a hard bright crack and the thud of its mass
    const crack = shaped(ac, t0, [[0.002, 0.5], [0.05, 0.0005]]);
    crack.connect(mix);
    burst(ac, t0, 0.06, filter(ac, 'bandpass', hz * 14, 0.9, crack));
    const thud = shaped(ac, t0, [[0.004, 0.55], [0.16, 0.0005]]);
    thud.connect(mix);
    const o = tone(ac, 'sine', hz * 0.72, t0, t0 + 0.2, thud);
    o.frequency.exponentialRampToValueAtTime(hz * 0.42, t0 + 0.14);
  },

  seal(ac, { dry, wet }, t0, { level = 1 } = {}) {
    const mix = ac.createGain(); mix.gain.value = 0.55 * level; mix.connect(dry);
    const send = ac.createGain(); send.gain.value = 0.08; mix.connect(send); send.connect(wet);
    // the body: a low thump that drops as the seal seats
    const body = shaped(ac, t0, [[0.003, 1], [0.24, 0.0008]]);
    body.connect(mix);
    const o = tone(ac, 'sine', 168, t0, t0 + 0.3, body);
    o.frequency.exponentialRampToValueAtTime(58, t0 + 0.09);
    const b2 = shaped(ac, t0, [[0.003, 0.35], [0.12, 0.0008]]);
    b2.connect(mix);
    const o2 = tone(ac, 'triangle', 320, t0, t0 + 0.16, b2);
    o2.frequency.exponentialRampToValueAtTime(120, t0 + 0.07);
    // the knock of the matrix on the table, then wax giving way
    const click = shaped(ac, t0, [[0.001, 0.6], [0.022, 0.0008]]);
    click.connect(mix);
    burst(ac, t0, 0.03, filter(ac, 'lowpass', 2400, 0.7, click), 0.31);
    const wax = shaped(ac, t0 + 0.012, [[0.035, 0.16], [0.17, 0.0008]]);
    wax.connect(mix);
    burst(ac, t0 + 0.012, 0.2, filter(ac, 'bandpass', 520, 1.1, wax), 0.57);
    // the brass of the matrix rings for an instant
    for (const [f, a, d] of [[2140, 0.05, 0.16], [3370, 0.035, 0.11], [5120, 0.02, 0.07]]) {
      const g = shaped(ac, t0, [[0.002, a], [d, 0.0003]]);
      g.connect(mix);
      tone(ac, 'sine', f, t0, t0 + d + 0.02, g);
    }
  },

  clash(ac, { dry, wet }, t0, { level = 1, seed = 0 } = {}) {
    const r = rng(hashSeed(`clash|${seed}`));
    const mix = ac.createGain(); mix.gain.value = 0.46 * level; mix.connect(dry);
    const send = ac.createGain(); send.gain.value = 0.16; mix.connect(send); send.connect(wet);
    // the crack of contact
    const crack = shaped(ac, t0, [[0.001, 0.9], [0.07 + r() * 0.03, 0.0006]]);
    crack.connect(mix);
    burst(ac, t0, 0.12, filter(ac, 'highpass', 900, 0.5, filter(ac, 'bandpass', 3000 + r() * 1400, 0.8, crack)), r());
    // steel: inharmonic partials of a struck bar, each with its own short ring
    const base = 820 * (0.82 + r() * 0.5);
    for (const [ratio, amp, d] of [[1, 0.3, 0.3], [1.47, 0.22, 0.24], [2.09, 0.2, 0.2], [2.56, 0.16, 0.16], [3.39, 0.13, 0.12], [4.12, 0.1, 0.09], [5.4, 0.07, 0.06]]) {
      const g = shaped(ac, t0, [[0.0015, amp], [d * (0.8 + r() * 0.5), 0.0004]]);
      g.connect(mix);
      const o = tone(ac, 'sine', base * ratio * (1 + (r() - 0.5) * 0.02), t0, t0 + d * 1.4 + 0.03, g);
      o.frequency.exponentialRampToValueAtTime(base * ratio * 0.985, t0 + d);
    }
    // the weight behind it
    const thud = shaped(ac, t0, [[0.003, 0.7], [0.1, 0.0006]]);
    thud.connect(mix);
    const o = tone(ac, 'sine', 132, t0, t0 + 0.13, thud);
    o.frequency.exponentialRampToValueAtTime(64, t0 + 0.08);
  },

  tick(ac, { dry }, t0, { level = 1 } = {}) {
    const mix = ac.createGain(); mix.gain.value = 0.24 * level; mix.connect(dry);
    const g = shaped(ac, t0, [[0.0015, 0.7], [0.045, 0.0006]]);
    g.connect(mix);
    const o = tone(ac, 'sine', 1180, t0, t0 + 0.06, g);
    o.frequency.exponentialRampToValueAtTime(860, t0 + 0.035);
    const g2 = shaped(ac, t0, [[0.0015, 0.22], [0.03, 0.0006]]);
    g2.connect(mix);
    tone(ac, 'triangle', 2360, t0, t0 + 0.04, g2);
    const click = shaped(ac, t0, [[0.0008, 0.3], [0.008, 0.0006]]);
    click.connect(mix);
    burst(ac, t0, 0.012, filter(ac, 'lowpass', 3200, 0.7, click), 0.83);
  },

  shimmer(ac, { dry, wet }, t0, { level = 1, seed = 0 } = {}) {
    const r = rng(hashSeed(`shimmer|${seed}`));
    const mix = ac.createGain(); mix.gain.value = 0.36 * level; mix.connect(dry);
    const send = ac.createGain(); send.gain.value = 0.55; mix.connect(send); send.connect(wet);
    // a rising spray of partials (a pentatonic run two octaves up), each a small bell of glass
    const notes = [1318.5, 1568, 1760, 2093, 2637, 3136, 3520];
    notes.forEach((f, i) => {
      const at = t0 + i * 0.052 + r() * 0.012;
      const d = 0.55 - i * 0.04;
      const g = shaped(ac, at, [[0.012, 0.16 - i * 0.012], [d, 0.0004]]);
      g.connect(mix);
      tone(ac, 'sine', f, at, at + d + 0.03, g);
      const g2 = shaped(ac, at, [[0.008, 0.045], [d * 0.5, 0.0003]]);
      g2.connect(mix);
      tone(ac, 'sine', f * 2.76, at, at + d * 0.5 + 0.03, g2);
    });
    // air: a band of noise sweeping upward under it
    const air = shaped(ac, t0, [[0.16, 0.11], [0.75, 0.0006]]);
    air.connect(mix);
    const bp = filter(ac, 'bandpass', 2600, 1.4, air);
    bp.frequency.setValueAtTime(2600, t0); bp.frequency.exponentialRampToValueAtTime(8200, t0 + 0.6);
    burst(ac, t0, 0.8, bp, 0.11);
  },

  drum(ac, { dry, wet }, t0, { level = 1 } = {}) {
    const mix = ac.createGain(); mix.gain.value = 0.5 * level; mix.connect(dry);
    const send = ac.createGain(); send.gain.value = 0.22; mix.connect(send); send.connect(wet);
    for (const [dt, vol] of [[0, 1], [0.46, 0.78]]) {
      const at = t0 + dt;
      // the head: low and falling; a second partial so small speakers carry it too
      const g = shaped(ac, at, [[0.004, vol], [0.62, 0.0008]]);
      g.connect(mix);
      const o = tone(ac, 'sine', 92, at, at + 0.7, g);
      o.frequency.exponentialRampToValueAtTime(47, at + 0.16);
      const g2 = shaped(ac, at, [[0.004, vol * 0.4], [0.3, 0.0008]]);
      g2.connect(mix);
      const o2 = tone(ac, 'sine', 176, at, at + 0.34, g2);
      o2.frequency.exponentialRampToValueAtTime(101, at + 0.12);
      // the beater on the skin
      const slap = shaped(ac, at, [[0.002, vol * 0.5], [0.05, 0.0008]]);
      slap.connect(mix);
      burst(ac, at, 0.07, filter(ac, 'lowpass', 620, 0.8, slap), dt + 0.2);
    }
  },
};

/** The master chain of a context: dry and wet inputs into a modest, limited output. */
function chain(ac) {
  const out = ac.createGain(); out.gain.value = MASTER;
  let last = out;
  try {
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -12; lim.knee.value = 8; lim.ratio.value = 8; lim.attack.value = 0.004; lim.release.value = 0.25;
    out.connect(lim); last = lim;
  } catch { /* no compressor: the levels are safe without it */ }
  last.connect(ac.destination);
  const dry = ac.createGain(); dry.connect(out);
  const wet = ac.createGain(); wet.gain.value = 1;
  try { const rv = room(ac); wet.connect(rv); rv.connect(out); } catch { /* no convolver: dry only */ }
  return { dry, wet, out };
}

/**
 * Render one sound into a buffer (an OfflineAudioContext): `render('bell')` →
 * Promise<{sampleRate, data: Float32Array}> (mono mix). For tuning and tests
 * in a browser; rejects where there is no OfflineAudioContext.
 */
export async function render(name, { seconds = SOUND_SECS[name] ?? 1, sampleRate = 44100, seed = 0 } = {}) {
  const Off = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Off || !BUILD[name]) throw new Error('no offline audio');
  const ac = new Off(2, Math.ceil(seconds * sampleRate), sampleRate);
  BUILD[name](ac, chain(ac), 0.01, { seed });
  const buf = await ac.startRendering();
  const a = buf.getChannelData(0), b = buf.getChannelData(1);
  const data = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) data[i] = (a[i] + b[i]) / 2;
  return { sampleRate, data };
}

/**
 * The page's sound: `createAudio({storage})`. Nothing is created until
 * `unlock()` runs inside a user gesture (`install(doc)` wires the first
 * pointer or key press to it, and a soft tick to every button press).
 */
export function createAudio({ storage = null, now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  let ac = null, nodes = null, muted = false, unlocked = false;
  const lastAt = new Map();
  const listeners = new Set();
  const store = () => { try { return storage ?? globalThis.localStorage ?? null; } catch { return null; } };
  try { muted = JSON.parse(store()?.getItem(MUTE_KEY) ?? 'null')?.muted === true; } catch { muted = false; }
  const save = () => { try { store()?.setItem(MUTE_KEY, JSON.stringify({ v: 1, muted })); } catch { /* a storage that refuses only costs the preference */ } };
  const tell = () => { for (const fn of listeners) { try { fn(muted); } catch { /* a listener's own fault */ } } };

  /** Create or resume the context: call from a user gesture. */
  function unlock() {
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) return false;
    try {
      if (!ac) { ac = new AC({ latencyHint: 'interactive' }); nodes = chain(ac); }
      if (ac.state === 'suspended') ac.resume?.()?.catch?.(() => {});
      unlocked = true;
    } catch { ac = null; nodes = null; unlocked = false; }
    return unlocked;
  }

  /**
   * Play a sound by name: `play('clash', {delay: 0.2, seed: 'c7', level: 0.8})`.
   * False when it did not sound (muted, before the first gesture, unknown, too soon after the last).
   */
  function play(name, { delay = 0, seed = 0, level = 1 } = {}) {
    if (muted || !unlocked || !ac || !BUILD[name]) return false;
    const t = now() + delay * 1000, last = lastAt.get(name) ?? -Infinity;
    if (t - last < (MIN_GAP[name] ?? 60)) return false;
    lastAt.set(name, t);
    try {
      if (ac.state === 'suspended') ac.resume?.()?.catch?.(() => {});
      BUILD[name](ac, nodes, ac.currentTime + 0.012 + Math.max(0, delay), { seed, level });
      return true;
    } catch (e) { globalThis.console?.warn?.('fx audio:', name, e); return false; }
  }

  function setMuted(v) {
    muted = !!v; save(); tell();
    // muting cuts what is ringing (a nine-second bell must stop when asked)
    try { if (nodes) nodes.out.gain.setTargetAtTime(muted ? 0 : MASTER, ac.currentTime, 0.03); } catch { /* no context yet */ }
    return muted;
  }

  /** Wire a document: the first gesture unlocks; every press of a control answers with a tick. */
  function install(doc = globalThis.document) {
    if (!doc?.addEventListener) return () => {};
    const CONTROL = 'button, [role="button"], a.tab, summary, .btn, input[type="checkbox"], input[type="radio"], select';
    const press = e => {
      unlock();
      const el = e.target?.closest?.(CONTROL);
      if (el && !el.disabled && el.getAttribute?.('aria-disabled') !== 'true') play('tick');
    };
    const key = e => { unlock(); if ((e.key === 'Enter' || e.key === ' ') && e.target?.closest?.(CONTROL)) play('tick'); };
    doc.addEventListener('pointerdown', press, { capture: true, passive: true });
    doc.addEventListener('keydown', key, { capture: true });
    return () => { doc.removeEventListener('pointerdown', press, { capture: true }); doc.removeEventListener('keydown', key, { capture: true }); };
  }

  return {
    play, unlock, install, render,
    /** Flip mute; returns the new state (true = muted). */
    toggle: () => setMuted(!muted),
    setMuted,
    get muted() { return muted; },
    get ready() { return unlocked; },
    names: SOUND_NAMES,
    /** Hear about mute changes (the speaker button's icon): returns the unsubscribe. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

let page = null;
/** The page's audio (made on first use) and the global handle `__fxAudio`. */
export function audio() {
  if (!page) {
    page = createAudio();
    try { if (globalThis.__fxAudio === undefined) globalThis.__fxAudio = page; } catch { /* a frozen global */ }
  }
  return page;
}
