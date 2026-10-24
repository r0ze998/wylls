/* Local helpers for scenes 08/09/12/13/14 (copied per scene folder; lib/* is shared and not edited).
 *   FX.text(stage, ['line one', 'line [[gold]] two'], { x, y, w, size, font, align })  -> .render(t, a, b)
 *   FX.overlay(stage)                      vignette + moving grain -> .render(t)
 *   FX.capture(ctx, im, k, cx, cy, rad)    the game's capture VFX atlas (8 cols, 29 frames, 24 fps) on a hex of radius rad
 *   FX.hex(ctx, x, y, r, flat)             pointy-top hex path
 *   FX.rr(ctx, x, y, w, h, r)              rounded-rect path
 */
(function () {
  'use strict';
  const E = WY.ease, clamp = WY.clamp;

  let noiseURL = null;
  function noise() {
    if (noiseURL) return noiseURL;
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); const d = x.createImageData(256, 256); const r = WY.rng(77);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.floor(r() * 255); d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0); return (noiseURL = c.toDataURL());
  }
  /** vignette + a cheap raster grain (no blend modes, no SVG filters: renders are CPU bound) */
  function overlay(stage, { z = 45, vignette = true, grain = true, strength = 1, grainAlpha = 0.045 } = {}) {
    let v = null, g = null;
    if (vignette) { v = WY.el('div', { class: 'wy-vignette' }, stage); v.style.zIndex = z; v.style.opacity = strength; }
    if (grain) { g = WY.el('div', {}, stage); WY.css(g, { position: 'absolute', inset: '-128px', backgroundImage: `url(${noise()})`, opacity: grainAlpha, zIndex: z + 1, pointerEvents: 'none' }); }
    return { render(t) { if (g) { const f = Math.floor(t * 24); g.style.transform = `translate(${((f * 37) % 200) - 100}px,${((f * 53) % 200) - 100}px)`; } } };
  }

  /** A text block. lines: strings; [[...]] marks gold, {{...}} marks a nation colour given by o.accent. */
  function text(stage, lines, o = {}) {
    const n = WY.el('div', { class: 'wy-abs' }, stage);
    const size = o.size || 80;
    WY.css(n, {
      left: (o.x ?? 0) + 'px', top: (o.y ?? 0) + 'px', width: (o.w ?? WY.W) + 'px', textAlign: o.align || 'center',
      font: `${o.weight || 700} ${size}px/${o.lh || 1.15} ${o.font || 'var(--serif)'}`, color: o.color || '#fffaf0',
      letterSpacing: o.ls || '.01em', fontVariantNumeric: 'lining-nums', fontFeatureSettings: '"lnum" 1', zIndex: o.z ?? 20, textShadow: o.shadow ?? '0 4px 24px rgba(0,0,0,.75), 0 1px 3px rgba(0,0,0,.8)', visibility: 'hidden',
    });
    const spans = [];
    for (const line of lines) {
      const d = WY.el('div', {}, n); d.style.whiteSpace = 'nowrap';
      let mode = null;
      const chars = [...line];
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (c === '[' && chars[i + 1] === '[') { mode = 'gold'; i++; continue; }
        if (c === ']' && chars[i + 1] === ']') { mode = null; i++; continue; }
        if (c === '{' && chars[i + 1] === '{') { mode = 'acc'; i++; continue; }
        if (c === '}' && chars[i + 1] === '}') { mode = null; i++; continue; }
        const s = WY.el('span', { class: 'wy-ch', text: c }, d);
        if (mode === 'gold') s.style.color = o.gold || '#ffd24d';
        if (mode === 'acc') s.style.color = o.accent || '#ffd24d';
        if (o.small && /[A-Za-z0-9,.]/.test(c) && o.latin) s.style.fontFamily = o.latin;
        spans.push(s);
      }
    }
    return {
      node: n, spans,
      render(t, a, b) {
        if (t < a - 0.02 || t > b + 1.2) { n.style.visibility = 'hidden'; return; }
        n.style.visibility = 'visible';
        WY.revealChars(spans, t - a, { stagger: o.stagger ?? 0.016, dur: o.dur ?? 0.55, rise: o.rise ?? 28, blur: o.blur ?? 8, ease: E.outCubic, out: b - a });
      },
    };
  }

  /** simple fade/slide for any DOM node */
  function show(n, t, a, b, { fi = 0.45, fo = 0.4, dy = 24, dx = 0, s0 = 1, blur = 6 } = {}) {
    const k = WY.env(t, a, b, fi, fo, E.outCubic);
    n.style.visibility = k <= 0.001 ? 'hidden' : 'visible';
    n.style.opacity = k;
    const s = s0 + (1 - s0) * k;
    n.style.transform = `translate(${(1 - k) * dx}px,${(1 - k) * dy}px) scale(${s})`;
    n.style.filter = blur && k < 0.99 ? `blur(${(1 - k) * blur}px)` : 'none';
    return k;
  }

  function hex(ctx, x, y, r, flat = 1) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r * flat; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath();
  }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  /** capture VFX: k = seconds since start; centred on a hex top face (cx, cy) of radius rad */
  function capture(ctx, im, k, cx, cy, rad, { alpha = 1, glow = true } = {}) {
    if (k < 0 || !im.complete || !im.naturalWidth) return;
    const f = Math.floor(k * 24); if (f > 28) return;
    const s = rad / 79.7, size = 256 * s;
    const dx = cx - 128 * s, dy = cy - 142 * s;
    ctx.save(); ctx.globalAlpha = alpha;
    if (glow) { ctx.globalCompositeOperation = 'lighter'; ctx.filter = `blur(${Math.max(2, rad * 0.06)}px)`; WY.drawFrame(ctx, im, f, 256, 256, dx, dy, size, size, 8); WY.drawFrame(ctx, im, f, 256, 256, dx, dy, size, size, 8); ctx.filter = 'none'; }
    ctx.globalCompositeOperation = 'source-over';
    WY.drawFrame(ctx, im, f, 256, 256, dx, dy, size, size, 8);
    ctx.restore();
  }

  /** Wait for every image the map needs, then pre-render it once at `zoom` (the per-frame cost is one drawImage). */
  async function mapCache(world, { zoom = 1, opts = {}, pad = 40 } = {}) {
    const orig = WY.img, got = [];
    WY.img = src => { const im = orig(src); got.push(im); return im; };
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = 8;
    WYMap.draw(tmp.getContext('2d'), world, { x: 0, y: 0, zoom: 0.05, W: 8, H: 8 }, { ...opts, background: false });
    WY.img = orig;
    const settle = ims => Promise.all(ims.map(im => (im.complete && im.naturalWidth ? Promise.resolve() : new Promise(r => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); setTimeout(r, 8000); })).then(() => im.decode?.().catch(() => {}))));
    await settle(got);
    // renders run on a heavily loaded machine: retry any sprite that did not arrive, so the cache never freezes a gap
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bad = got.filter(im => !(im.complete && im.naturalWidth));
      if (!bad.length) break;
      console.warn('FX.mapCache: retrying', bad.length, 'images, attempt', attempt);
      for (const im of bad) im.src = im.src.split('?')[0] + '?retry=' + attempt;
      await new Promise(r => setTimeout(r, 400 * attempt));
      await settle(bad);
    }
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const t of world.tiles) { x0 = Math.min(x0, t.x - 88); x1 = Math.max(x1, t.x + 88); y0 = Math.min(y0, t.y - 160); y1 = Math.max(y1, t.y + 90); }
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const cw = Math.ceil((x1 - x0) * zoom), ch = Math.ceil((y1 - y0) * zoom);
    const make = o2 => {
      const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
      WYMap.draw(cv.getContext('2d'), world, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom, W: cw, H: ch }, { ...opts, ...o2, background: false });
      return cv;
    };
    let base = make({});
    // sanity check: the cache must contain terrain pixels; rebuild if the sprites were not drawable yet
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = base.getContext('2d'), probe = world.tiles.filter(t => t.terrain !== 'water').slice(0, 40);
      const filled = probe.filter(t => x.getImageData(Math.round((t.x - x0) * zoom), Math.round((t.y + 20 - y0) * zoom), 1, 1).data[3] > 200).length;
      if (filled >= probe.length * 0.8) break;
      console.warn('FX.mapCache: cache looks empty (' + filled + '/' + probe.length + '), rebuilding');
      await new Promise(r => setTimeout(r, 600));
      for (const im of got) if (!(im.complete && im.naturalWidth)) im.src = im.src.split('?')[0] + '?rb=' + attempt;
      await settle(got);
      base = make({});
    }
    return {
      get cv() { return base; }, make,
      /** draw a cache canvas (default the base) for camera cam {x,y,zoom,W,H} */
      draw(ctx, cam, cv = null, alpha = 1) {
        cv = cv || base;
        const s = cam.zoom / zoom;
        ctx.globalAlpha = alpha;
        ctx.drawImage(cv, cam.W / 2 + (x0 - cam.x) * cam.zoom, cam.H / 2 + (y0 - cam.y) * cam.zoom, cw * s, ch * s);
        ctx.globalAlpha = 1;
      },
    };
  }
  /** table background like WYMap.draw's */
  function table(ctx, W, H) { const gr = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75); gr.addColorStop(0, '#4a3424'); gr.addColorStop(1, '#170f09'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H); }

  /** count-up number text */
  const num = (v, d = 0) => WY.count(v, d);

  window.FX = { overlay, text, show, hex, rr, capture, num, mapCache, table };
})();
