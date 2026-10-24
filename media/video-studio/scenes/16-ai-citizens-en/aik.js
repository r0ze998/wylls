/* AI-citizen video kit (scenes 15–19). Local helper: not part of lib/.
 *
 *   AIK.css()                                 inject the styles once
 *   const bg = AIK.bg(stage, { hue })          night background with a slow hex lattice; bg.render(t)
 *   const fx = AIK.overlay(stage)              vignette + grain on top
 *   const k = AIK.text(stage, 'line one\n[[accent]] two', { x, y, w, size, font, align })
 *   k.render(t - start, outAt)                 chars rise in; leave at local time outAt (null = stay)
 *   AIK.card(...)                              a decision card styled after the council audit page (council.css)
 *
 * Every visual is set from t (render must be pure).
 */
(function () {
  'use strict';
  const { seg, env, ease: E, clamp, lerp } = WY;
  const AIK = {};

  AIK.css = () => {
    if (document.getElementById('aik-css')) return;
    const s = document.createElement('style'); s.id = 'aik-css';
    s.textContent = `
.aik-t { position:absolute; color:#fffaf0; white-space:nowrap; text-shadow:0 3px 14px rgba(0,0,0,.5); }
.aik-t .ln { display:block; }
.aik-t .acc { color:#f0d48a; }
.aik-t .gold { color:#ffd24d; }
.aik-t .teal { color:#9fe0d2; }
.aik-t .dim { color:rgba(255,250,240,.6); }
.aik-kicker { font:600 26px/1 var(--sans); letter-spacing:.32em; text-transform:uppercase; color:#c9a24a; }
/* council page tokens (permutation-server/web/frontier/council/council.css), scaled for video */
.cc { --ink:#1b2e28; --ink-2:#4c5852; --card:#fffdf6; --land:#e9e5d8; --accent:#1f6f67; --line-soft:#d5cfbd; --model-bg:#d4e8e4; --auto-bg:#ebe6d4; --warn-bg:#f6e7c6; --ok-bg:#e2efe9; --gold-bg:#f1e3b8; --gold-ink:#5a4306;
  font:500 25px/1.45 var(--sans-jp); color:var(--ink); }
.cc-page { background:var(--land); border-radius:18px; overflow:hidden; box-shadow:0 40px 120px rgba(0,0,0,.6), 0 0 0 2px rgba(201,162,74,.55); }
.cc-top { display:flex; align-items:center; gap:14px; padding:12px 24px; background:#243e38; color:#f4efe0; font-weight:650; }
.cc-top .mk { color:#9fd8c9; }
.cc-top .chip { background:rgba(255,255,255,.14); color:#f4efe0; }
.cc-banner { padding:9px 24px; background:var(--warn-bg); border-bottom:3px solid #c9a43f; font-weight:700; letter-spacing:.03em; font-size:22px; }
.cc-panel { background:var(--card); border:1.5px solid var(--line-soft); border-radius:16px; padding:18px 22px; }
.cc h2 { font:700 30px/1.3 var(--sans-jp); margin:0 0 8px; }
.cc .muted { color:var(--ink-2); }
.cc .small { font-size:19px; }
.cc .chip { display:inline-flex; align-items:center; min-height:36px; padding:0 14px; border-radius:18px; background:var(--auto-bg); color:var(--ink); font-size:20px; font-weight:600; white-space:nowrap; }
.cc .chip-model { background:var(--model-bg); color:#0e4a43; font-weight:700; }
.cc .chip-auto { background:var(--auto-bg); color:var(--ink-2); }
.cc .chip-sealed { background:var(--warn-bg); color:#6b4a10; }
.cc .chip-released { background:var(--ok-bg); color:#1c5a3a; }
.cc .chip-memory { background:#e8dcf0; color:#4a2a63; }
.cc .bellmark { color:var(--ink-2); font-size:20px; font-variant-numeric:tabular-nums; }
.cc .badge-ai { display:inline-block; padding:2px 12px; border-radius:12px; background:var(--accent); color:#fff; font-size:18px; font-weight:700; white-space:nowrap; }
.cc .badge-script { display:inline-block; padding:2px 12px; border-radius:12px; background:#dcdacf; color:#3b3f3c; border:1px solid #b3b0a3; font-size:18px; font-weight:700; }
.cc .decision { padding:18px 22px; border:2px solid var(--accent); border-radius:16px; background:#fff; }
.cc .dec-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; }
.cc .actor { font-weight:700; font-size:27px; }
.cc .sub { margin-top:14px; font-size:19px; font-weight:700; color:var(--ink-2); }
.cc .cands { display:grid; gap:7px; margin-top:8px; }
.cc .cand { display:flex; align-items:center; gap:10px; padding:7px 12px; border:1.5px solid var(--line-soft); border-radius:11px; background:#fff; font-size:21px; }
.cc .cand.chosen { border-color:var(--accent); background:#f1f8f6; box-shadow:inset 0 0 0 1px var(--accent); }
.cc .cand-id { font:700 19px var(--mono); color:var(--ink-2); min-width:40px; }
.cc .cand .chip { margin-left:auto; min-height:30px; font-size:17px; }
.cc .words { margin-top:6px; padding:10px 14px; background:#f1f8f6; border-left:5px solid var(--accent); border-radius:0 12px 12px 0; }
.cc .remembered { margin-top:6px; padding:10px 14px; background:#faf6e8; border-left:5px solid #c9a43f; border-radius:0 12px 12px 0; }
.cc .remembered li { list-style:none; padding:3px 0; }
.cc .caption { margin-top:8px; font-size:18px; color:var(--ink-2); }
.cc .ex { display:inline-block; margin-left:8px; padding:0 10px; border-radius:8px; border:1.5px dashed #a0522d; color:#8a3b12; background:#fff3e6; font:700 17px/1.6 var(--sans-jp); white-space:nowrap; vertical-align:middle; }
.cc .redact { display:inline-block; height:.8em; border-radius:5px; background:linear-gradient(90deg,#b9c9c4,#cfdcd8); vertical-align:middle; }
.cc .redact.gold { background:linear-gradient(90deg,#e0d2a6,#ece2c2); }
.aik-pill { display:inline-flex; align-items:center; gap:12px; padding:10px 22px; border-radius:999px; border:1.5px solid rgba(240,212,138,.7); background:rgba(10,24,19,.82); font:600 26px var(--sans-jp); color:#f0d48a; white-space:nowrap; }
.aik-node { position:absolute; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; border-radius:22px; padding:20px 26px;
  background:linear-gradient(180deg, rgba(27,58,47,.97), rgba(16,36,29,.98)); border:2px solid rgba(201,162,74,.8); box-shadow: inset 0 1px 0 rgba(255,240,200,.14), 0 24px 60px rgba(0,0,0,.5); color:#fffaf0; }
.aik-node .n { font:700 22px var(--mono); color:#c9a24a; letter-spacing:.1em; }
.aik-node .h { font:800 44px/1.25 var(--serif-jp); margin-top:6px; white-space:nowrap; }
.aik-node .s { font:500 24px/1.4 var(--sans-jp); color:rgba(255,250,240,.75); margin-top:8px; white-space:nowrap; }
`;
    document.head.appendChild(s);
  };

  /** Night background: deep green radial + a slowly drifting hex lattice on a canvas. */
  AIK.bg = (stage, { tint = '18,38,31', lattice = 0.07, z = 0 } = {}) => {
    const W = WY.W, H = WY.H;
    const c = WY.canvas(stage, W, H); c.style.zIndex = z; const g = c.getContext('2d');
    // pre-render a lattice tile big enough to pan over
    const lat = document.createElement('canvas'); lat.width = W + 400; lat.height = H + 400; const lg = lat.getContext('2d');
    const r = 46, hw = Math.sqrt(3) * r;
    lg.strokeStyle = 'rgba(240,212,138,1)'; lg.lineWidth = 1.2;
    for (let row = -1; row * r * 1.5 < lat.height + r; row++) for (let col = -1; col * hw < lat.width + hw; col++) {
      const cx = col * hw + (row % 2 ? hw / 2 : 0), cy = row * r * 1.5;
      lg.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? lg.lineTo(x, y) : lg.moveTo(x, y); } lg.closePath(); lg.stroke();
    }
    return {
      canvas: c,
      render(t, { glow = 0.5, lat: la = lattice, cx = 0.5, cy = 0.45 } = {}) {
        const gr = g.createRadialGradient(W * cx, H * cy, 0, W * cx, H * cy, Math.max(W, H) * 0.8);
        gr.addColorStop(0, `rgba(${tint},1)`); gr.addColorStop(0.55, '#0c1a15'); gr.addColorStop(1, '#050b09');
        g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, 0, W, H);
        if (la > 0) {
          g.globalAlpha = la;
          const ox = -200 + WY.drift(t, 3, 60, 0.05) - t * 6, oy = -200 + WY.drift(t, 7, 40, 0.05) - t * 3;
          g.drawImage(lat, ((ox % 160) - 160), ((oy % 138) - 138));
        }
        // breathing light
        g.globalAlpha = 0.18 * glow * (0.8 + 0.2 * Math.sin(t * 0.9));
        const gl = g.createRadialGradient(W * cx, H * cy, 0, W * cx, H * cy, H * 0.6);
        gl.addColorStop(0, 'rgba(255,220,150,1)'); gl.addColorStop(1, 'rgba(255,220,150,0)');
        g.fillStyle = gl; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
      },
    };
  };

  AIK.overlay = (stage, { z = 35 } = {}) => {
    const v = WY.el('div', { class: 'wy-vignette' }, stage); v.style.zIndex = z; v.style.opacity = 0.7;
    // no animated grain: a full-frame blended layer made every frame several times slower to render on the shared machine
    return { render() {} };
  };

  /** Kinetic text. `str`: lines split by \n; [[x]] = accent, {{x}} = gold, ((x)) = teal, <<x>> = dim. */
  AIK.text = (parent, str, { x = 0, y = 0, w = null, size = 96, font = null, weight = 800, align = 'center', lh = 1.25, color = null, z = 10, ls = '.02em', stagger = 0.032, dur = 0.7, rise = 46, blur = 12 } = {}) => {
    const n = WY.el('div', { class: 'aik-t' }, parent);
    WY.css(n, { left: x + 'px', top: y + 'px', font: `${weight} ${size}px/${lh} ${font || 'var(--serif-jp)'}`, textAlign: align, zIndex: z, letterSpacing: ls });
    if (w) n.style.width = w + 'px';
    if (color) n.style.color = color;
    const spans = [];
    for (const line of str.split('\n')) {
      const ln = WY.el('span', { class: 'ln' }, n);
      const re = /\[\[(.+?)\]\]|\{\{(.+?)\}\}|\(\((.+?)\)\)|<<(.+?)>>|([^[{(<]+|[[{(<])/g; let m;
      while ((m = re.exec(line))) {
        const cls = m[1] ? 'acc' : m[2] ? 'gold' : m[3] ? 'teal' : m[4] ? 'dim' : '';
        const txt = m[1] || m[2] || m[3] || m[4] || m[5];
        for (const ch of txt) {
          if (ch === ' ') { ln.appendChild(document.createTextNode(' ')); continue; }
          const s = WY.el('span', { class: 'wy-ch' + (cls ? ' ' + cls : ''), text: ch }, ln); spans.push(s);
        }
      }
    }
    n.style.opacity = 0;
    return {
      node: n, spans,
      render(k, outAt = null) {
        if (k < -0.05 || (outAt !== null && k > outAt + 1.6)) { n.style.opacity = 0; return; }
        n.style.opacity = 1;
        WY.revealChars(spans, k, { stagger, dur, rise, blur, out: outAt });
      },
    };
  };

  /** fade+lift helper for any node (used for cards, chips, rows) */
  AIK.pop = (n, k, { y = 30, s = 0.96, blur = 8, ease = E.outCubic } = {}) => {
    const e = ease(clamp(k));
    n.style.opacity = clamp(k * 1.4);
    n.style.transform = `translateY(${(1 - e) * y}px) scale(${lerp(s, 1, e)})`;
    n.style.filter = e < 0.98 && blur ? `blur(${(1 - e) * blur}px)` : 'none';
  };
  /** in/out envelope pop: in at a, out at b */
  AIK.show = (n, t, a, b, { fi = 0.6, fo = 0.45, y = 30, s = 0.96, blur = 8 } = {}) => {
    if (t < a - 0.01 || t > b + fo + 0.01) { n.style.opacity = 0; n.style.visibility = 'hidden'; return 0; }
    n.style.visibility = 'visible';
    const kin = clamp((t - a) / fi), kout = clamp((t - b) / fo);
    const e = E.outCubic(kin), q = E.inCubic(kout);
    n.style.opacity = clamp(kin * 1.4) * (1 - q);
    n.style.transform = `translateY(${(1 - e) * y - q * y * 0.6}px) scale(${lerp(s, 1, e) - q * 0.02})`;
    const b2 = (1 - e) * blur + q * blur;
    n.style.filter = b2 > 0.1 ? `blur(${b2}px)` : 'none';
    return e * (1 - q);
  };

  /** an absolutely placed html block */
  AIK.box = (parent, html, { x = 0, y = 0, w = null, z = 10, cls = '' } = {}) => {
    const n = WY.el('div', { class: 'wy-abs ' + cls, html }, parent);
    WY.css(n, { left: x + 'px', top: y + 'px', zIndex: z, opacity: 0 });
    if (w) n.style.width = w + 'px';
    return n;
  };

  /** status pill in the studio's colours; kind from WYKit.STATUS, text override allowed */
  AIK.status = (stage, kind, text, { x = 80, y = 64, lang = 'ja', size = 24 } = {}) => WYKit.status(stage, kind, lang, { x, y, size, text });

  /** a small "例" (illustrative) tag string */
  AIK.ex = (txt = '例') => `<span class="ex">${txt}</span>`;

  /** draw an animated camera shake offset */
  AIK.shake = (t, at, amp = 14, dur = 0.5) => { if (t < at || t > at + dur) return [0, 0]; const k = 1 - (t - at) / dur; return [Math.sin(t * 90) * amp * k, Math.cos(t * 77) * amp * k * 0.7]; };

  /** connector line on a canvas, drawn to progress k, with a moving pulse */
  AIK.wire = (g, pts, k, t, { color = 'rgba(240,212,138,.85)', width = 4, dash = [14, 10], pulse = true } = {}) => {
    if (k <= 0) return;
    const L = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); L.push(d); tot += d; }
    const lim = tot * clamp(k);
    g.save(); g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.setLineDash(dash); g.lineDashOffset = -t * 40;
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); let acc = 0, end = pts[0];
    for (let i = 1; i < pts.length; i++) {
      if (acc + L[i - 1] >= lim) { const u = (lim - acc) / L[i - 1]; end = [lerp(pts[i - 1][0], pts[i][0], u), lerp(pts[i - 1][1], pts[i][1], u)]; g.lineTo(end[0], end[1]); break; }
      g.lineTo(pts[i][0], pts[i][1]); acc += L[i - 1]; end = pts[i];
    }
    g.stroke(); g.setLineDash([]);
    if (pulse && k >= 1) {
      const u = (t * 0.6) % 1; let d = tot * u, p = pts[0];
      for (let i = 1; i < pts.length; i++) { if (d <= L[i - 1]) { const v = d / L[i - 1]; p = [lerp(pts[i - 1][0], pts[i][0], v), lerp(pts[i - 1][1], pts[i][1], v)]; break; } d -= L[i - 1]; }
      const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], 18); gr.addColorStop(0, 'rgba(255,240,200,.95)'); gr.addColorStop(1, 'rgba(255,220,150,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p[0], p[1], 18, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  };

  /** clear a 2D canvas and touch it, so the compositor always takes the new (possibly empty) frame */
  AIK.clear = (g, t = 0) => { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.clearRect(0, 0, g.canvas.width, g.canvas.height); g.fillStyle = `rgba(0,0,0,${(0.004 + 0.004 * ((t * 7.31) % 1)).toFixed(5)})`; g.fillRect(0, 0, 2, 2); };

  window.AIK = AIK;
})();
