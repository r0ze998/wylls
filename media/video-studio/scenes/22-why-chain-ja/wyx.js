/* Local helpers for scenes 20–24 (copied into each scene folder; lib/ is untouched).
 *   X.bg(stage, opts)          background canvas: night gradient, slow hex lattice, glow
 *   X.overlay(stage)           vignette + moving grain (render(t))
 *   X.lines(parent, lines, o)  multi-line text with per-char reveal; render(t, a, b)
 *   X.box(parent, css, html)   absolutely placed div
 *   X.num(v, d)                grouped number
 */
(function () {
  'use strict';
  const X = (window.X = {});
  const E = WY.ease;

  X.box = (parent, css = {}, html = '') => { const n = WY.el('div', { class: 'wy-abs' }, parent); if (html) n.innerHTML = html; Object.assign(n.style, css); return n; };
  X.num = (v, d = 0) => WY.count(v, d);

  /** background: radial night + hex lattice + glow, drawn once per parameter set (cheap per frame: only a CSS translate) */
  X.bg = (stage, { tint = '#12261f', edge = '#05090a', hex = 0.06, hexSize = 64, glow = 'rgba(201,162,74,.10)', z = 0 } = {}) => {
    const W = WY.W, H = WY.H, s = hexSize, hw = Math.sqrt(3) * s, rh = 1.5 * s;
    const PW = W + Math.ceil(hw) * 2, PH = H + Math.ceil(rh) * 4;
    const wrap = WY.el('div', { class: 'wy-abs' }, stage); Object.assign(wrap.style, { width: W + 'px', height: H + 'px', overflow: 'hidden', zIndex: z });
    const base = WY.canvas(wrap, W, H); const gb = base.getContext('2d', { willReadFrequently: true });
    const lat = WY.canvas(wrap, PW, PH); const gl = lat.getContext('2d', { willReadFrequently: true });
    let key = '';
    function paint(gx, gy, hexA, glowA) {
      const gr = gb.createRadialGradient(W * gx, H * gy, 0, W * gx, H * gy, Math.max(W, H) * 0.8);
      gr.addColorStop(0, tint); gr.addColorStop(1, edge); gb.fillStyle = gr; gb.fillRect(0, 0, W, H);
      if (glowA > 0) { const r = gb.createRadialGradient(W * gx, H * gy, 0, W * gx, H * gy, Math.min(W, H) * 0.6); r.addColorStop(0, glow); r.addColorStop(1, 'rgba(0,0,0,0)'); gb.globalAlpha = glowA; gb.fillStyle = r; gb.fillRect(0, 0, W, H); gb.globalAlpha = 1; }
      gl.clearRect(0, 0, PW, PH);
      if (hexA > 0.001) {
        gl.strokeStyle = `rgba(240,212,138,${hexA})`; gl.lineWidth = 1.2;
        for (let row = 0; row * rh < PH + rh; row++) for (let col = -1; col * hw < PW + hw; col++) {
          const cx = col * hw + (row % 2 ? hw / 2 : 0), cy = row * rh;
          const d = Math.hypot(cx - hw - W * gx, cy - 2 * rh - H * gy) / Math.max(W, H);
          const a = Math.max(0, 1 - d * 1.4); if (a < 0.05) continue;
          gl.globalAlpha = a; gl.beginPath();
          for (let i = 0; i < 6; i++) { const an = Math.PI / 6 + (i * Math.PI) / 3; const x = cx + Math.cos(an) * s * 0.96, y = cy + Math.sin(an) * s * 0.96; i ? gl.lineTo(x, y) : gl.moveTo(x, y); }
          gl.closePath(); gl.stroke();
        }
        gl.globalAlpha = 1;
      }
    }
    return {
      canvas: base, wrap,
      render(t, { hexA = hex, gx = 0.5, gy = 0.45, glowA = 1, shift = 0 } = {}) {
        const k = [gx.toFixed(3), gy.toFixed(3), hexA.toFixed(3), glowA.toFixed(2)].join();
        if (k !== key) { key = k; paint(gx, gy, hexA, glowA); }
        const ox = (t * 6 + shift) % hw, oy = (t * 3) % (rh * 2);
        lat.style.transform = `translate(${-hw - ox}px, ${-2 * rh - oy}px)`;
      },
    };
  };

  X.overlay = (stage, { z = 70, vig = 1 } = {}) => {
    const v = WY.el('div', { class: 'wy-vignette' }, stage); v.style.zIndex = z; v.style.opacity = vig;
    const gr = WY.el('div', { class: 'wy-grain' }, stage); gr.style.zIndex = z + 1;
    return { render(t) { const k = Math.floor(t * 24); gr.style.transform = `translate(${((k * 37) % 100) - 50}px, ${((k * 61) % 100) - 50}px)`; } };
  };

  /**
   * lines: [{ t: 'text', css: {...} } | 'text'] ; o: { x, y, w, align, css (shared), gap, stagger, dur, rise, blur }
   * render(t, a, b): chars reveal from a, leave from b.
   */
  X.lines = (parent, lines, o = {}) => {
    const root = X.box(parent, Object.assign({ left: (o.x ?? 0) + 'px', top: (o.y ?? 0) + 'px', width: (o.w ?? WY.W) + 'px', textAlign: o.align || 'center' }, o.rootCss || {}));
    const all = [];
    lines.forEach((ln, i) => {
      const spec = typeof ln === 'string' ? { t: ln } : ln;
      const d = WY.el('div', {}, root); Object.assign(d.style, o.css || {}, spec.css || {}); if (i && o.gap) d.style.marginTop = o.gap + 'px';
      d.textContent = spec.t;
      const sp = spec.html ? (d.innerHTML = spec.html, []) : WY.split(d);
      all.push({ d, sp, delay: spec.delay ?? i * (o.lineDelay ?? 0.18) });
    });
    return {
      node: root, lines: all,
      render(t, a, b = 1e9) {
        const vis = t > a - 0.05 && t < b + 1.6;
        root.style.display = vis ? '' : 'none'; if (!vis) return;
        for (const L of all) {
          if (L.sp.length) WY.revealChars(L.sp, t - a - L.delay, { stagger: o.stagger ?? 0.03, dur: o.dur ?? 0.6, rise: o.rise ?? 34, blur: o.blur ?? 10, ease: E.outCubic, out: b - a - L.delay });
          else { const k = WY.env(t, a + L.delay, b, 0.5, 0.4); L.d.style.opacity = k; L.d.style.transform = `translateY(${(1 - k) * 20}px)`; }
        }
      },
    };
  };

  /** simple fade/slide envelope applied to a node */
  X.show = (n, t, a, b, { fi = 0.5, fo = 0.4, dy = 24, dx = 0, s0 = 1, blur = 0 } = {}) => {
    const k = WY.env(t, a, b, fi, fo, E.outCubic);
    n.style.display = k <= 0.001 ? 'none' : '';
    n.style.opacity = k;
    n.style.transform = `translate(${(1 - k) * dx}px, ${(1 - k) * dy}px) scale(${s0 + (1 - s0) * k})`;
    if (blur) n.style.filter = k < 0.99 ? `blur(${(1 - k) * blur}px)` : 'none';
    return k;
  };
})();
