/* Local helpers for scenes 25-29 (copied into each folder; do not import across folders).
 *
 *   const b = K.text(stage, '最初の案', { x, y, w, font, color, align }, { a: 5, b: 15 });
 *   b.render(t)   // chars rise + unblur from a, whole block lifts out at b
 *
 *   K.bg(stage)   // night gradient + hex grid canvas; returns { render(t, alpha) }
 *   K.overlay(stage) // vignette + grain on top
 *   K.rr(ctx, x, y, w, h, r)  // rounded-rect path
 */
(function () {
  'use strict';
  const E = () => WY.ease;

  /** split every text node under root into inline-block spans (chars, or words for Latin) */
  function splitDeep(root, mode) {
    const out = [];
    const walk = n => {
      for (const c of [...n.childNodes]) {
        if (c.nodeType === 3) {
          const frag = document.createDocumentFragment();
          const parts = mode === 'words' ? c.textContent.split(/(\s+)/) : [...c.textContent];
          for (const p of parts) {
            if (!p) continue;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); continue; }
            const s = document.createElement('span'); s.className = 'wy-ch'; s.textContent = p; frag.appendChild(s); out.push(s);
          }
          c.replaceWith(frag);
        } else if (c.nodeType === 1 && c.tagName !== 'BR') {
          if (c.classList.contains('whole')) out.push(c); else walk(c);
        }
      }
    };
    walk(root);
    return out;
  }

  /** a text block with a reveal at a and an exit at b */
  function text(stage, html, style = {}, { a = 0, b = 1e9, stagger = 0.028, dur = 0.7, rise = 28, blur = 8, mode = 'chars', outDur = 0.55, outRise = -18, z = 20 } = {}) {
    const n = WY.el('div', { class: 'wy-abs' }, stage);
    n.innerHTML = html;
    WY.css(n, Object.assign({ whiteSpace: 'nowrap', zIndex: z }, style));
    const spans = splitDeep(n, mode);
    return {
      node: n,
      render(t) {
        if (t < a - 0.05 || t > b + outDur + 0.05) { n.style.visibility = 'hidden'; return; }
        n.style.visibility = 'visible';
        const k = t - a;
        spans.forEach((s, i) => {
          const p = E().outCubic(WY.clamp((k - i * stagger) / dur));
          s.style.opacity = p;
          s.style.transform = `translateY(${(1 - p) * rise}px)`;
          s.style.filter = p < 0.98 ? `blur(${(1 - p) * blur}px)` : 'none';
        });
        const q = E().inCubic(WY.clamp((t - b) / outDur));
        n.style.opacity = 1 - q;
        n.style.transform = `translateY(${q * outRise}px)`;
        n.style.filter = q > 0.01 ? `blur(${q * 8}px)` : 'none';
      },
    };
  }

  /** night background with a slowly drifting hex lattice */
  function bg(stage, { top = '#0f201a', bottom = '#060c0a', grid = 'rgba(240,212,138,0.05)', r = 46, z = 0 } = {}) {
    const c = WY.canvas(stage, WY.W, WY.H); c.style.zIndex = z;
    const g = c.getContext('2d');
    return {
      canvas: c, ctx: g,
      render(t, { alpha = 1, dx = 0, dy = 0, glowX = WY.W / 2, glowY = WY.H * 0.45, glow = 0.35 } = {}) {
        const W = WY.W, H = WY.H;
        const lg = g.createLinearGradient(0, 0, 0, H); lg.addColorStop(0, top); lg.addColorStop(1, bottom);
        g.fillStyle = lg; g.fillRect(0, 0, W, H);
        const rg = g.createRadialGradient(glowX, glowY, 0, glowX, glowY, W * 0.6);
        rg.addColorStop(0, `rgba(60,110,90,${glow})`); rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg; g.fillRect(0, 0, W, H);
        if (alpha <= 0) return;
        const hw = Math.sqrt(3) * r, rh = 1.5 * r;
        g.strokeStyle = grid; g.lineWidth = 1.2; g.globalAlpha = alpha;
        const ox = ((dx % hw) + hw) % hw, oy = ((dy % (rh * 2)) + rh * 2) % (rh * 2);
        g.beginPath();
        for (let row = -2; row * rh < H + rh * 2; row++) {
          for (let col = -2; col * hw < W + hw * 2; col++) {
            const cx = col * hw + (row & 1 ? hw / 2 : 0) + ox - hw, cy = row * rh + oy - rh * 2;
            for (let i = 0; i < 6; i++) { const an = Math.PI / 6 + i * Math.PI / 3; const x = cx + Math.cos(an) * r, y = cy + Math.sin(an) * r; i ? g.lineTo(x, y) : g.moveTo(x, y); }
            g.closePath();
          }
        }
        g.stroke(); g.globalAlpha = 1;
      },
    };
  }

  // (no blended grain layer: it doubles software capture time on this machine)
  function overlay(stage, { z = 45, vignette = 0.6 } = {}) {
    const v = WY.el('div', { class: 'wy-vignette' }, stage); v.style.zIndex = z;
    v.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,${vignette}) 100%)`;
    return { render(t) {} };
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /** a DOM element that pops in at a and out at b (scale + fade) */
  function pop(n, t, a, b, { from = 0.85, outDur = 0.4, ease } = {}) {
    const k = (ease || E().outBack)(WY.clamp((t - a) / 0.6));
    const q = E().inCubic(WY.clamp((t - b) / outDur));
    n.style.opacity = Math.min(1, WY.clamp((t - a) / 0.3)) * (1 - q);
    n.style.transform = `scale(${from + (1 - from) * k - q * 0.05})`;
    n.style.visibility = t < a || t > b + outDur ? 'hidden' : 'visible';
  }

  /** after clearRect: Chrome may skip repainting a canvas that only got cleared, leaving a stale frame in the capture */
  function touch(ctx) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(0,0,0,0.01)'; ctx.fillRect(0, 0, 1, 1); ctx.restore(); }

  window.K = { text, bg, overlay, rr, pop, splitDeep, touch };
})();
