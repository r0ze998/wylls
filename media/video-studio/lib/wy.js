/* Wylls video studio runtime.
 *
 * A scene is one HTML page that draws a frame for any time t (seconds). The page
 * loads this script first, then registers itself:
 *
 *   WY.scene({ width: 1920, height: 1080, duration: 45, fps: 60,
 *              setup(stage) { ... },          // build DOM / canvases once (may be async)
 *              render(t) { ... },             // draw the frame at time t (pure: same t, same picture)
 *              audio(A) { ... } });           // optional: schedule music and sound (see wy-audio.js)
 *
 * Opened in a browser, the page plays in real time with a scrubber and sound.
 * Opened by render.mjs with ?render=1, the clock is virtual: render.mjs calls
 * WY.seek(t) for every frame and takes a screenshot, so the video is
 * frame-exact whatever the machine's speed. Anything time-based must read t
 * (or WY.now()), never Date.now() or performance.now(); in render mode those,
 * requestAnimationFrame and Math.random are replaced by deterministic versions.
 * CSS animations and a paused GSAP timeline (WY.tl) are seeked too.
 */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const RENDER = qs.has('render');
  const WY = (window.WY = {});
  WY.RENDER = RENDER;

  // ------------------------------------------------------------- deterministic clock
  let vnow = 0; // virtual ms
  const rafQ = new Map();
  let rafId = 1;
  if (RENDER) {
    performance.now = () => vnow;
    const D = Date;
    const T0 = D.UTC(2026, 9, 24, 3, 0, 0);
    Date.now = () => T0 + vnow;
    window.requestAnimationFrame = cb => { const id = rafId++; rafQ.set(id, cb); return id; };
    window.cancelAnimationFrame = id => rafQ.delete(id);
  }
  WY.now = () => vnow / 1000;

  // ------------------------------------------------------------- seeded random
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  WY.rng = seed => mulberry32(typeof seed === 'string' ? hashStr(seed) : seed >>> 0);
  function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  if (RENDER) Math.random = mulberry32(0x5eed);

  // ------------------------------------------------------------- math & easing
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  WY.clamp = clamp; WY.lerp = lerp;
  /** progress of t through [a, b], clamped to 0..1, optionally eased */
  WY.seg = (t, a, b, ease) => { const k = clamp((t - a) / (b - a)); return ease ? ease(k) : k; };
  /** in–hold–out envelope: 0 before a, rises over `fi`, 1 until b, falls over `fo` */
  WY.env = (t, a, b, fi = 0.4, fo = 0.4, ease = E.inOutCubic) => Math.min(ease(clamp((t - a) / fi)), ease(clamp((b - t) / fo)));
  WY.map = (x, a, b, c, d, ease) => { const k = clamp((x - a) / (b - a)); return lerp(c, d, ease ? ease(k) : k); };
  const E = (WY.ease = {
    linear: k => k,
    inQuad: k => k * k, outQuad: k => 1 - (1 - k) * (1 - k), inOutQuad: k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
    inCubic: k => k * k * k, outCubic: k => 1 - Math.pow(1 - k, 3), inOutCubic: k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    outQuart: k => 1 - Math.pow(1 - k, 4), inQuart: k => k ** 4, inOutQuart: k => (k < 0.5 ? 8 * k ** 4 : 1 - Math.pow(-2 * k + 2, 4) / 2),
    outQuint: k => 1 - Math.pow(1 - k, 5), inOutQuint: k => (k < 0.5 ? 16 * k ** 5 : 1 - Math.pow(-2 * k + 2, 5) / 2),
    outExpo: k => (k === 1 ? 1 : 1 - Math.pow(2, -10 * k)), inExpo: k => (k === 0 ? 0 : Math.pow(2, 10 * k - 10)),
    inOutExpo: k => (k === 0 ? 0 : k === 1 ? 1 : k < 0.5 ? Math.pow(2, 20 * k - 10) / 2 : (2 - Math.pow(2, -20 * k + 10)) / 2),
    outBack: k => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); },
    outBackSoft: k => { const c1 = 0.9, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); },
    inBack: k => { const c1 = 1.70158, c3 = c1 + 1; return c3 * k * k * k - c1 * k * k; },
    outElastic: k => (k === 0 ? 0 : k === 1 ? 1 : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
    outSine: k => Math.sin((k * Math.PI) / 2), inOutSine: k => -(Math.cos(Math.PI * k) - 1) / 2,
  });
  /** smooth value noise in 1D (deterministic), roughly -1..1 */
  WY.noise1 = (x, seed = 0) => {
    const h = n => { const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return lerp(h(i), h(i + 1), u);
  };
  /** organic drift for a camera or a float, sum of noises */
  WY.drift = (t, seed = 0, amp = 1, speed = 0.25) => amp * (0.6 * WY.noise1(t * speed, seed) + 0.4 * WY.noise1(t * speed * 2.3, seed + 9));

  // ------------------------------------------------------------- DOM helpers
  WY.el = (tag, attrs = {}, parent) => {
    const svgTags = /^(svg|g|path|circle|rect|line|polyline|polygon|text|tspan|defs|linearGradient|radialGradient|stop|clipPath|mask|filter|fe[A-Z]\w*|use|pattern|ellipse|image|symbol|marker)$/;
    const n = svgTags.test(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'class') n.setAttribute('class', v);
      else n.setAttribute(k, v);
    }
    if (parent) parent.appendChild(n);
    return n;
  };
  WY.$ = (s, r = document) => r.querySelector(s);
  WY.$$ = (s, r = document) => [...r.querySelectorAll(s)];
  /** set many style props quickly; numbers for opacity etc. */
  WY.css = (n, o) => { for (const k in o) n.style[k] = o[k]; return n; };
  /** transform shorthand */
  WY.tf = (n, { x = 0, y = 0, s = 1, sx, sy, r = 0, o, blur, z } = {}) => {
    n.style.transform = `translate3d(${x}px,${y}px,${z || 0}px) rotate(${r}deg) scale(${sx ?? s},${sy ?? s})`;
    if (o !== undefined) n.style.opacity = o;
    if (blur !== undefined) n.style.filter = blur > 0.01 ? `blur(${blur}px)` : 'none';
    return n;
  };

  /** Split text into spans for per-character / per-word animation. Returns the spans. */
  WY.split = (n, mode = 'chars') => {
    const text = n.textContent;
    n.textContent = '';
    const parts = mode === 'words' ? text.split(/(\s+)/) : [...text];
    const out = [];
    for (const p of parts) {
      if (/^\s+$/.test(p)) { n.appendChild(document.createTextNode(p)); continue; }
      const s = WY.el('span', { class: 'wy-ch', text: p }, n);
      out.push(s);
    }
    return out;
  };
  /** Standard text reveal: chars rise and unblur with a stagger. k = local time since start */
  WY.revealChars = (spans, k, { stagger = 0.035, dur = 0.6, rise = 40, blur = 10, ease = E.outCubic, out = null } = {}) => {
    spans.forEach((s, i) => {
      const p = ease(clamp((k - i * stagger) / dur));
      let o = p, y = (1 - p) * rise, b = (1 - p) * blur;
      if (out !== null) { const q = E.inCubic(clamp((k - out - i * stagger * 0.5) / (dur * 0.7))); o *= 1 - q; y -= q * rise * 0.6; b += q * blur; }
      s.style.opacity = o;
      s.style.transform = `translateY(${y}px)`;
      s.style.filter = b > 0.05 ? `blur(${b}px)` : 'none';
    });
  };
  /** Count a number up with grouping */
  WY.count = (v, digits = 0, locale = 'en-US') => Number(v).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

  // ------------------------------------------------------------- brand
  WY.NATIONS = [
    { key: 'aster', en: 'Aster', fill: '#cc303b', dark: '#81242c', light: '#f5d2d5', deep: '#701c2c', ink: '#5e1a20', on: '#fffaf0', mark: '#cc303b', land: '#cc303b', leader: 'marshal' },
    { key: 'borealis', en: 'Borealis', fill: '#31bedb', dark: '#237489', light: '#d3f0f5', deep: '#145c77', ink: '#17586a', on: '#0e3a46', mark: '#127a92', land: '#31bedb', leader: 'captain' },
    { key: 'cinder', en: 'Cinder', fill: '#eac21b', dark: '#8c721c', light: '#f8efc4', deep: '#986a0e', ink: '#6a5510', on: '#3b2f06', mark: '#8a6d00', land: '#eac21b', leader: 'herald' },
    { key: 'dunmar', en: 'Dunmar', fill: '#a34cd8', dark: '#69338c', light: '#eddbf7', deep: '#502269', ink: '#4e2470', on: '#ffffff', mark: '#a34cd8', land: '#a34cd8', leader: 'hooded' },
    { key: 'ember', en: 'Ember', fill: '#edeee7', dark: '#5f6a68', light: '#f9faf4', deep: '#344950', ink: '#434c4a', on: '#333c3a', mark: '#6b7573', land: '#58727e', leader: 'surveyor' },
    { key: 'fjordal', en: 'Fjordal', fill: '#f19232', dark: '#9c581f', light: '#fbe2c5', deep: '#9c471c', ink: '#74400f', on: '#3d2206', mark: '#b05a0a', land: '#f19232', leader: 'jarl' },
  ];
  WY.GOLD = '#ffd24d';
  /** the client's nation sigils (people/avatar.mjs sigilPath): circle, triangle, square, diamond, cross, hexagon */
  WY.sigilPath = (f, r = 1) => {
    const k = n => (n * r).toFixed(2);
    switch (f) {
      case 0: return `M ${k(-1)} 0 A ${k(1)} ${k(1)} 0 1 0 ${k(1)} 0 A ${k(1)} ${k(1)} 0 1 0 ${k(-1)} 0 Z`;
      case 1: return `M 0 ${k(-1.05)} L ${k(1)} ${k(0.8)} L ${k(-1)} ${k(0.8)} Z`;
      case 2: return `M ${k(-0.85)} ${k(-0.85)} H ${k(0.85)} V ${k(0.85)} H ${k(-0.85)} Z`;
      case 3: return `M 0 ${k(-1.1)} L ${k(1)} 0 L 0 ${k(1.1)} L ${k(-1)} 0 Z`;
      case 4: return `M ${k(-0.33)} ${k(-1)} H ${k(0.33)} V ${k(-0.33)} H ${k(1)} V ${k(0.33)} H ${k(0.33)} V ${k(1)} H ${k(-0.33)} V ${k(0.33)} H ${k(-1)} V ${k(-0.33)} H ${k(-0.33)} Z`;
      case 5: return `M ${k(-0.5)} ${k(-0.87)} H ${k(0.5)} L ${k(1)} 0 L ${k(0.5)} ${k(0.87)} H ${k(-0.5)} L ${k(-1)} 0 Z`;
      default: return `M ${k(-0.8)} 0 A ${k(0.8)} ${k(0.8)} 0 1 0 ${k(0.8)} 0 A ${k(0.8)} ${k(0.8)} 0 1 0 ${k(-0.8)} 0 Z`;
    }
  };
  /** the client's crest (hud.mjs): a shield in the nation's fill with its sigil. Returns an SVG string. */
  WY.crest = (f, size = 120) => {
    const n = WY.NATIONS[f] || { fill: '#d8cfb4', dark: '#5f6a68', on: '#fffaf0' };
    return `<svg viewBox="0 0 24 28" width="${Math.round((size * 24) / 28)}" height="${size}"><path d="M12 1.2l9.6 2.9v9.9c0 5.8-3.9 9.8-9.6 12.6C6.3 23.8 2.4 19.8 2.4 14V4.1Z" fill="${n.fill}" stroke="#f0d48a" stroke-width="1.3" stroke-linejoin="round"/><path d="M12 3.4l7.5 2.3v8.3c0 4.6-3 7.9-7.5 10.3Z" fill="${n.dark}" opacity=".28"/><g transform="translate(12 12.6)"><path d="${WY.sigilPath(f ?? 6, 5)}" fill="${n.on}" stroke="${n.dark}" stroke-width=".7"/></g></svg>`;
  };
  /** The Wylls wordmark: the client's red W tile + the name. Returns an HTML string. */
  WY.logo = (size = 96, { word = true, color = '#fffaf0' } = {}) =>
    `<div class="wy-logo" style="--s:${size}px;color:${color}"><div class="wy-logo-tile"><span>W</span></div>${word ? '<div class="wy-logo-word">Wylls</div>' : ''}</div>`;

  /** path (relative to a scene folder) to the game's art */
  WY.ART = '../../../../permutation-server/web/frontier/art/';
  WY.REPO = '../../../../';

  // ------------------------------------------------------------- sprite sheets
  const imgCache = new Map();
  const pending = [];
  /** preload an image; render waits for all of them before frame 0 */
  WY.img = src => {
    if (imgCache.has(src)) return imgCache.get(src);
    const im = new Image();
    im.decoding = 'sync';
    const p = new Promise(res => { im.onload = () => res(); im.onerror = () => { console.warn('WY: missing image', src); res(); }; });
    im.src = src;
    pending.push(p.then(() => im.decode?.().catch(() => {})));
    imgCache.set(src, im);
    return im;
  };
  /** draw frame `i` of a horizontal strip sheet onto ctx */
  WY.drawFrame = (ctx, im, i, fw, fh, dx, dy, dw, dh, cols) => {
    if (!im.complete || !im.naturalWidth) return;
    cols = cols || Math.max(1, Math.floor(im.naturalWidth / fw));
    const c = i % cols, r = Math.floor(i / cols);
    ctx.drawImage(im, c * fw, r * fh, fw, fh, dx, dy, dw ?? fw, dh ?? fh);
  };
  /** A leader motion sprite (motion-v2). motion: idle|walk|attack|hit|victory. Returns {draw(ctx,t,x,y,size)} */
  WY.leader = (key, motion = 'idle', hi = true) => {
    const frames = hi ? { idle: 8, walk: 8, attack: 8, hit: 4, victory: 12 } : { idle: 4, walk: 8, attack: 8, hit: 4, victory: 12 };
    const fw = hi ? 512 : 256;
    const im = WY.img(`${WY.ART}leaders3d/motion-v2/sprite${hi ? '@2x' : ''}/${key}_${motion}.webp`);
    const n = frames[motion];
    return {
      im, n, fw,
      frameAt: (t, fps = 12, loop = true) => (loop ? Math.floor(t * fps) % n : Math.min(n - 1, Math.floor(t * fps))),
      draw(ctx, i, cx, by, size) { WY.drawFrame(ctx, im, i, fw, fw, cx - size / 2, by - size, size, size); },
    };
  };

  // ------------------------------------------------------------- canvas helpers
  /** create a HiDPI-free canvas sized to the stage (or w,h) and absolutely placed */
  WY.canvas = (parent, w, h, cls = '') => {
    const c = WY.el('canvas', { class: 'wy-abs ' + cls }, parent);
    c.width = w; c.height = h;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    return c;
  };

  // ------------------------------------------------------------- scene lifecycle
  let scene = null;
  let resolveReady;
  const readyP = new Promise(r => (resolveReady = r));
  WY.tl = null; // optional paused GSAP timeline

  WY.scene = async def => {
    scene = Object.assign({ width: 1920, height: 1080, duration: 10, fps: 60, title: document.title }, def);
    WY.W = scene.width; WY.H = scene.height; WY.DUR = scene.duration;
    const stage = WY.el('div', { id: 'stage' });
    stage.style.width = scene.width + 'px';
    stage.style.height = scene.height + 'px';
    document.body.appendChild(stage);
    WY.stage = stage;
    if (window.gsap) { gsap.ticker.lagSmoothing(0); gsap.ticker.sleep?.(); }
    if (scene.setup) await scene.setup(stage);
    if (document.fonts) {
      // force-load every face we declare so the first frame never shows a fallback
      const faces = ['400 20px "Noto Sans JP"', '500 20px "Noto Sans JP"', '700 20px "Noto Sans JP"', '900 20px "Noto Sans JP"', '400 20px "Noto Serif JP"', '600 20px "Noto Serif JP"', '700 20px "Noto Serif JP"', '900 20px "Noto Serif JP"', '500 20px Cinzel', '700 20px Cinzel', '900 20px Cinzel', '500 20px "Cormorant Garamond"', '600 20px "Cormorant Garamond"', '700 20px "Cormorant Garamond"', '400 20px Inter', '500 20px Inter', '600 20px Inter', '700 20px Inter', '800 20px Inter', '400 20px "JetBrains Mono"', '600 20px "JetBrains Mono"'];
      await Promise.all(faces.map(f => document.fonts.load(f, '国村軍AaWylls0').catch(() => {})));
      await document.fonts.ready;
    }
    await Promise.all(pending);
    // images created during the first render are awaited too
    seekInternal(0);
    await Promise.all(pending);
    resolveReady({ width: scene.width, height: scene.height, duration: scene.duration, fps: scene.fps, title: scene.title, hasAudio: !!scene.audio });
    if (!RENDER) startPreview();
  };
  WY.ready = () => readyP;

  function seekInternal(t) {
    vnow = t * 1000;
    for (const a of document.getAnimations?.() || []) { try { a.pause(); a.currentTime = t * 1000; } catch (e) {} }
    if (WY.tl) WY.tl.seek(t, false);
    scene.render?.(t);
    if (RENDER && rafQ.size) { const q = [...rafQ.values()]; rafQ.clear(); for (const cb of q) cb(vnow); }
  }
  WY.seek = async t => { seekInternal(t); };

  // ------------------------------------------------------------- audio export (render mode)
  WY.renderAudio = async () => {
    if (!scene.audio || !window.WYAudio) return null;
    const buf = await WYAudio.render(scene.audio, scene.duration);
    return WYAudio.toWavBase64(buf);
  };

  // ------------------------------------------------------------- preview player
  function startPreview() {
    document.body.classList.add('wy-preview');
    const fit = () => {
      const s = Math.min((innerWidth - 24) / scene.width, (innerHeight - 70) / scene.height);
      WY.stage.style.transform = `scale(${s})`;
      WY.stage.style.left = (innerWidth - scene.width * s) / 2 + 'px';
      WY.stage.style.top = '12px';
    };
    addEventListener('resize', fit); fit();
    const bar = WY.el('div', { id: 'wy-bar' }, document.body);
    const play = WY.el('button', { text: '▶' }, bar);
    const range = WY.el('input', { type: 'range', min: 0, max: scene.duration, step: 1 / scene.fps, value: 0 }, bar);
    const lab = WY.el('span', { text: '0.00' }, bar);
    let playing = false, t = 0, t0 = 0, last = 0, actx = null, abuf = null, src = null;
    const realNow = () => performance.now();
    const stopAudio = () => { try { src?.stop(); } catch (e) {} src = null; };
    const startAudio = async () => {
      if (!scene.audio || !window.WYAudio) return;
      if (!actx) actx = new AudioContext({ sampleRate: 48000 });
      if (!abuf) abuf = await WYAudio.render(scene.audio, scene.duration);
      stopAudio();
      src = actx.createBufferSource(); src.buffer = abuf; src.connect(actx.destination); src.start(0, t);
    };
    const tick = () => {
      if (!playing) return;
      t = (realNow() - t0) / 1000;
      if (t >= scene.duration) { t = 0; t0 = realNow(); startAudio(); }
      range.value = t; lab.textContent = t.toFixed(2);
      seekInternal(t);
      requestAnimationFrame(tick);
    };
    play.onclick = () => { playing = !playing; play.textContent = playing ? '❚❚' : '▶'; if (playing) { t0 = realNow() - t * 1000; startAudio(); tick(); } else stopAudio(); };
    range.oninput = () => { t = +range.value; lab.textContent = t.toFixed(2); seekInternal(t); if (playing) { t0 = realNow() - t * 1000; startAudio(); } };
    addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); play.onclick(); } });
    const qt = parseFloat(qs.get('t'));
    if (!isNaN(qt)) { t = qt; range.value = t; seekInternal(t); }
  }
})();
