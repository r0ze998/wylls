/* Shared toolkit for the flagship videos (01, 02, 03, 04, 30).
 * Loaded after lib/wy.js, wy-map.js and wy-kit.js. Everything is a pure function of t.
 */
(function () {
  'use strict';
  const TK = (window.TK = {});
  const E = WY.ease, seg = WY.seg, clamp = WY.clamp, lerp = WY.lerp;
  const BASE = new URL('.', document.currentScript.src).href;
  TK.ui = name => BASE + 'ui/' + name + '.jpg';
  TK.NAT_JA = ['アステル', 'ボレアリス', 'シンダー', 'ダンマール', 'エンバー', 'フィヨルダル'];
  TK.DOC_JA = ['石の守り手', '潮', '炎', '新緑', '光明', '鉄'];
  TK.DOC_EN = ['Wardens of Stone', 'Tide', 'Flame', 'Verdant', 'Lumen', 'Iron'];
  TK.KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];

  // ------------------------------------------------------------------ overlays
  /** grain + vignette + optional letterbox bars, pre-baked into 4 canvases (cheap to composite). render(t, { lb }) */
  TK.overlays = (stage, { z = 55, grain = 0.075, vig = 0.62 } = {}) => {
    const W = WY.W, H = WY.H;
    const r = WY.rng(99);
    const frames = [0, 1, 2, 3].map(i => {
      const c = WY.canvas(stage, W, H); c.style.zIndex = z; c.style.pointerEvents = 'none'; c.style.display = 'none';
      const g = c.getContext('2d');
      // grain: a 256 px noise tile, repeated with an offset per frame
      const tile = document.createElement('canvas'); tile.width = tile.height = 256; const tg = tile.getContext('2d'); const id = tg.createImageData(256, 256);
      for (let p = 0; p < id.data.length; p += 4) { const v = r() < 0.5 ? 0 : 255; id.data[p] = id.data[p + 1] = id.data[p + 2] = v; id.data[p + 3] = Math.floor(r() * 255 * grain); }
      tg.putImageData(id, 0, 0);
      g.save(); g.translate(-((r() * 256) | 0), -((r() * 256) | 0)); g.fillStyle = g.createPattern(tile, 'repeat'); g.fillRect(0, 0, W + 256, H + 256); g.restore();
      const vg = g.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.35, W / 2, H * 0.48, Math.hypot(W, H) * 0.56);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${vig})`); g.fillStyle = vg; g.fillRect(0, 0, W, H);
      return c;
    });
    const top = WY.el('div', { class: 'wy-abs' }, stage), bot = WY.el('div', { class: 'wy-abs' }, stage);
    for (const b of [top, bot]) WY.css(b, { width: W + 'px', height: '0px', background: '#000', zIndex: z + 2 });
    bot.style.top = 'auto'; bot.style.bottom = '0px';
    return {
      render(t, { lb = 0, on = true } = {}) {
        const f = Math.floor(t * 24) % 4;
        frames.forEach((c, i) => (c.style.display = on && i === f ? 'block' : 'none'));
        top.style.height = bot.style.height = Math.round(lb) + 'px';
        top.style.display = bot.style.display = lb > 0.5 ? 'block' : 'none';
      },
    };
  };
  /** hide the shared end card completely until it starts (opacity 0 still costs compositing) */
  TK.end = (stage, opts) => { const e = WYKit.endCard(stage, opts); return { node: e.node, render(k) { e.node.style.display = k < 0 ? 'none' : 'block'; e.render(k); } }; };
  { const st = document.createElement('style'); st.textContent = '.wy-ch{will-change:auto!important}'; document.head.appendChild(st); }

  // ------------------------------------------------------------------ kinetic type
  /**
   * A big line of type. lines: array of strings (one per visual line). Each char is a span.
   * render(t, a, b): enters at a, leaves at b.
   */
  TK.line = (stage, lines, { x = 0, y = 0, w = WY.W, size = 104, font = 'var(--serif-jp)', weight = 800, color = '#fffaf0', align = 'center', z = 30, lh = 1.3, ls = 0.04, shadow = '0 4px 30px rgba(0,0,0,.75), 0 0 2px rgba(0,0,0,.6)', style = 'rise', stagger = 0.045, html = null } = {}) => {
    const n = WY.el('div', { class: 'wy-abs' }, stage);
    WY.css(n, { left: x + 'px', top: y + 'px', width: w + 'px', textAlign: align, font: `${weight} ${size}px/${lh} ${font}`, color, zIndex: z, letterSpacing: ls + 'em', textShadow: shadow, opacity: 0, whiteSpace: 'nowrap' });
    const spans = [];
    (Array.isArray(lines) ? lines : [lines]).forEach((ln, i) => {
      const d = WY.el('div', {}, n);
      if (html && html[i]) { d.innerHTML = ln; return; }
      d.textContent = ln; spans.push(...WY.split(d));
    });
    const self = {
      node: n, spans,
      render(t, a, b, { out = 0.45 } = {}) {
        if (t < a - 0.05 || t > b + out + 0.05) { n.style.display = 'none'; return; }
        n.style.display = 'block'; n.style.opacity = 1;
        const k = t - a;
        spans.forEach((s, i) => {
          const p = E.outExpo(clamp((k - i * stagger) / 0.7));
          const q = E.inCubic(clamp((t - b - i * stagger * 0.4) / out));
          let o = clamp(p * 1.4) * (1 - q), y = 0, sc = 1, bl = 0;
          if (style === 'rise') { y = (1 - p) * 46 - q * 30; bl = (1 - p) * 12 + q * 10; }
          else if (style === 'slam') { sc = 1 + (1 - p) * 0.9; bl = (1 - p) * 14 + q * 10; }
          else if (style === 'drop') { y = -(1 - p) * 60 - q * 24; bl = (1 - p) * 10 + q * 10; }
          s.style.opacity = o; s.style.transform = `translateY(${y}px) scale(${sc})`;
          s.style.filter = bl > 0.3 ? `blur(${bl.toFixed(1)}px)` : 'none';
        });
        // slow tracking expansion while held
        n.style.letterSpacing = (ls + 0.025 * E.outCubic(clamp(k / 4))) + 'em';
      },
    };
    return self;
  };

  /** a plain block that fades/rises in and out (for sub-lines, footnotes, labels) */
  TK.block = (stage, html, css = {}, { z = 31 } = {}) => {
    const n = WY.el('div', { class: 'wy-abs', html }, stage);
    WY.css(n, Object.assign({ zIndex: z, opacity: 0 }, css));
    return {
      node: n,
      render(t, a, b, { rise = 18, fi = 0.45, fo = 0.35 } = {}) {
        if (t < a - 0.02 || t > b + fo + 0.02) { n.style.display = 'none'; return; }
        n.style.display = '';
        const i = E.outCubic(clamp((t - a) / fi)), o = E.inCubic(clamp((t - b) / fo));
        n.style.opacity = i * (1 - o); n.style.transform = `translateY(${(1 - i) * rise - o * rise * 0.5}px)`;
      },
    };
  };

  /** footnote line used for honesty notes */
  TK.note = (stage, text, { x = 80, y = WY.H - 70, size = 24, lang = 'ja', align = 'left', w = 1760 } = {}) =>
    TK.block(stage, text, { left: x + 'px', top: y + 'px', width: w + 'px', textAlign: align, font: `500 ${size}px/1.4 ${lang === 'ja' ? 'var(--sans-jp)' : 'var(--sans)'}`, color: 'rgba(255,250,240,.78)', textShadow: '0 2px 8px rgba(0,0,0,.9)' }, { z: 52 });

  // ------------------------------------------------------------------ map helpers
  const ART = p => WY.img(WY.ART + p);
  /** cloud-sea + table background in world space (drawn before the tiles) */
  TK.cloudSea = (ctx, cam, t, { from = 8, to = 14, tint = null, alpha = 1 } = {}) => {
    const { W, H } = cam, z = cam.zoom;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a3a48'); g.addColorStop(0.55, '#4d5b66'); g.addColorStop(1, '#1d262e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const tw = 176 * z * 1.35, th = 208 * z * 1.35;
    ctx.globalAlpha = alpha;
    for (let r = -to; r <= to; r++) for (let q = -to; q <= to; q++) {
      const ring = (Math.abs(q) + Math.abs(r) + Math.abs(-q - r)) / 2; if (ring < from || ring > to) continue;
      const p = WYMap.px(q, r);
      const dx = Math.sin(t * 0.15 + q * 1.7 + r) * 18;
      const sx = W / 2 + (p.x + dx - cam.x) * z, sy = H / 2 + (p.y - cam.y) * z;
      if (sx < -tw || sx > W + tw || sy < -th || sy > H + th) continue;
      const im = ART(`fog/@2x/cloud_${1 + (Math.abs(q * 7 + r * 3) % 3)}.webp`);
      if (im.complete && im.naturalWidth) ctx.drawImage(im, sx - tw / 2, sy - th * 0.6, tw, th);
    }
    ctx.globalAlpha = 1;
  };

  /** features pass (villages, keeps, camps, concord) with controllable pennants */
  TK.features = (ctx, world, cam, { appear = () => 1, owner = tl => tl.owner, pennant = null, t = 0 } = {}) => {
    const { W, H } = cam, z = cam.zoom;
    const tw = 176 * z, th = 208 * z, ax = 88 * z, ay = 124 * z;
    for (const tl of world.sorted) {
      const a = appear(tl); if (a < 0.7) continue;
      const sx = W / 2 + (tl.x - cam.x) * z, sy = H / 2 + (tl.y - cam.y) * z;
      if (sx < -tw || sx > W + tw || sy < -th * 2 || sy > H + th) continue;
      const o = owner(tl);
      ctx.globalAlpha = Math.min(1, (a - 0.7) / 0.3);
      let path = null;
      if (tl.village && o >= 0) path = `holdings/@2x/${tl.keep ? 'stronghold_w' : tl.village === 'town' ? 'town_o' : 'hamlet_o'}_${WYMap.ART_FACTIONS[o]}.webp`;
      else if (tl.freecity) path = 'specials/@2x/freecity_town.webp';
      else if (tl.camp) path = 'specials/@2x/barbarian_1.webp';
      else if (tl.owner === -2) path = tl.q === 0 && tl.r === 0 ? 'specials/@2x/concord_plaza_1.webp' : 'specials/@2x/concord_paving.webp';
      if (path) { const im = ART(path); if (im.complete && im.naturalWidth) ctx.drawImage(im, sx - ax, sy - ay, tw, th); }
      if (tl.keep && o >= 0) {
        const p = pennant ? pennant(tl) : { rise: 1, scale: 1 };
        if (p && p.rise > 0) {
          ctx.globalAlpha = Math.min(1, p.rise * 2);
          const lift = (1 - E.outBack(clamp(p.rise))) * 60 * z;
          TK.pennant(ctx, sx, sy - 70 * z + lift, z * (p.scale || 1), o, t);
        }
      }
      ctx.globalAlpha = 1;
    }
  };
  /** a bigger, nicer pennant: pole, cloth with sigil, gold finial */
  TK.pennant = (ctx, x, y, z, f, t) => {
    const n = WY.NATIONS[f]; const s = Math.max(0.3, z);
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(0, 40, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2a1d10'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(0, -58); ctx.stroke();
    ctx.fillStyle = '#f0d48a'; ctx.beginPath(); ctx.arc(0, -60, 5, 0, Math.PI * 2); ctx.fill();
    const wv = Math.sin(t * 4 + f) * 5, wv2 = Math.sin(t * 4 + f + 1.3) * 5;
    ctx.beginPath(); ctx.moveTo(2, -56); ctx.bezierCurveTo(24, -58 + wv, 44, -50 + wv2, 66, -46 + wv2); ctx.bezierCurveTo(46, -36 - wv, 26, -30 - wv2, 2, -22); ctx.closePath();
    ctx.fillStyle = n.fill; ctx.fill(); ctx.strokeStyle = n.ink; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.translate(24, -40 + wv * 0.3); ctx.fillStyle = n.on; ctx.strokeStyle = n.dark; ctx.lineWidth = 1; const p = new Path2D(WY.sigilPath(f, 7)); ctx.fill(p); ctx.stroke(p);
    ctx.restore();
  };

  /** request every tile/feature image a world can need, so the first map frame is complete */
  TK.preloadMap = world => {
    const P = new Set();
    for (const t of world.tiles) P.add(`terrain/@2x/${t.terrain}_${t.variant}.webp`);
    for (const k of WYMap.ART_FACTIONS) for (const v of ['stronghold_w', 'town_o', 'hamlet_o']) P.add(`holdings/@2x/${v}_${k}.webp`);
    for (const p of ['specials/@2x/freecity_town.webp', 'specials/@2x/barbarian_1.webp', 'specials/@2x/concord_plaza_1.webp', 'specials/@2x/concord_paving.webp', 'fog/@2x/cloud_1.webp', 'fog/@2x/cloud_2.webp', 'fog/@2x/cloud_3.webp']) P.add(p);
    for (const p of P) WY.img(WY.ART + p);
  };
  /** world -> screen (top face) */
  TK.scr = (cam, tl) => [cam.W / 2 + (tl.x - cam.x) * cam.zoom, cam.H / 2 + (tl.y - WYMap.LIFT - cam.y) * cam.zoom];

  /** quadratic march path between two tiles in screen space; returns point fn */
  TK.marchPath = (cam, a, b, lift = 0.25) => {
    const [x1, y1] = TK.scr(cam, a), [x2, y2] = TK.scr(cam, b);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.hypot(x2 - x1, y2 - y1) * lift;
    return u => [(1 - u) * (1 - u) * x1 + 2 * (1 - u) * u * mx + u * u * x2, (1 - u) * (1 - u) * y1 + 2 * (1 - u) * u * my + u * u * y2];
  };
  /** draw a dashed march along pt from u0..u1 with glow; head: 'seal' | 'arrow' | null */
  TK.drawMarch = (ctx, pt, u1, { u0 = 0, color = '#ffd24d', width = 6, head = 'arrow', t = 0, sealR = null, dashOff = true } = {}) => {
    if (u1 <= u0) return;
    const steps = 80; ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const path = () => { ctx.beginPath(); for (let i = 0; i <= steps; i++) { const u = u0 + (u1 - u0) * (i / steps); const [x, y] = pt(u); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } };
    ctx.setLineDash([width * 2.6, width * 1.7]); ctx.lineDashOffset = dashOff ? -t * width * 8 : 0;
    path(); ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = width + 6; ctx.stroke();
    path(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
    const [hx, hy] = pt(u1), [px0, py0] = pt(Math.max(0, u1 - 0.02));
    if (head === 'seal') {
      const r = sealR || width * 3.4;
      ctx.globalAlpha = 0.35; const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 2.6); g.addColorStop(0, 'rgba(255,120,90,.9)'); g.addColorStop(1, 'rgba(255,80,60,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, hy, r * 2.6, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      WYMap.drawSeal(ctx, hx, hy, r);
    } else if (head === 'arrow') {
      const ang = Math.atan2(hy - py0, hx - px0);
      ctx.translate(hx, hy); ctx.rotate(ang); ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(width * 2.8, 0); ctx.lineTo(-width * 1.5, -width * 1.9); ctx.lineTo(-width * 0.6, 0); ctx.lineTo(-width * 1.5, width * 1.9); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  };

  /** capture burst: hex outline traced in nation colour + light pillar + rays. k: 0..1 over ~1.6 s */
  TK.capture = (ctx, cam, tl, k, f) => {
    if (k <= 0 || k >= 1) return;
    const n = WY.NATIONS[f]; const [x, y] = TK.scr(cam, tl); const z = cam.zoom; const rad = WYMap.R * z;
    ctx.save();
    // light pillar
    const pa = Math.sin(Math.PI * clamp(k * 1.3)) * 0.85;
    const pg = ctx.createLinearGradient(x, y - 700 * z, x, y);
    pg.addColorStop(0, 'rgba(255,240,200,0)'); pg.addColorStop(1, 'rgba(255,236,190,' + pa + ')');
    ctx.fillStyle = pg;
    for (let i = 0; i < 6; i++) { const wdt = rad * (0.12 + i * 0.16); ctx.globalAlpha = 0.28; ctx.beginPath(); ctx.ellipse(x, y - 350 * z, wdt, 360 * z, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
    // traced hexes (3 rings expanding)
    for (let j = 0; j < 3; j++) {
      const kk = clamp((k - j * 0.12) / 0.6); if (kk <= 0) continue;
      const sc = 1 + j * 0.45 + E.outCubic(kk) * 0.25;
      ctx.globalAlpha = (1 - clamp((k - 0.55 - j * 0.1) / 0.35)) * 0.95;
      ctx.lineWidth = (9 - j * 2.5) * Math.max(0.6, z); ctx.strokeStyle = j ? n.fill : '#fff4d6'; ctx.shadowColor = n.fill; ctx.shadowBlur = 24;
      ctx.beginPath();
      const L = E.outCubic(kk) * 6;
      for (let i = 0; i <= Math.ceil(L); i++) {
        const u = Math.min(i, L); const i0 = Math.floor(u) % 6, fr = u - Math.floor(u);
        const c = m => { const a = Math.PI / 6 + (m * Math.PI) / 3; return [x + Math.cos(a) * rad * sc, y + Math.sin(a) * rad * sc * WYMap.FLAT]; };
        const [ax, ay] = c(i0), [bx, by] = c(i0 + 1);
        const px = ax + (bx - ax) * (u === Math.floor(u) ? 0 : fr), py = ay + (by - ay) * (u === Math.floor(u) ? 0 : fr);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // sparks
    const r = WY.rng(77);
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2, sp = 0.5 + r();
      const d = E.outCubic(k) * 260 * z * sp; const yy = y + Math.sin(a) * d * WYMap.FLAT - k * 140 * z * r();
      ctx.globalAlpha = (1 - k) * 0.9; ctx.fillStyle = i % 3 ? n.fill : '#fff4d6';
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, yy, (2 + r() * 3) * Math.max(0.6, z), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };

  /** turn medallion like the client's (gold ring, "ターン", number, countdown) drawn on canvas */
  TK.medallion = (ctx, x, y, r, { label = 'ターン', turn = 42, clock = '9:26', k = 1, glow = 0, lang = 'ja' } = {}) => {
    ctx.save(); ctx.translate(x, y);
    if (glow > 0) { const g = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 2.6); g.addColorStop(0, `rgba(255,214,120,${0.55 * glow})`); g.addColorStop(1, 'rgba(255,200,90,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 2.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = 'rgba(14,30,24,.92)'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(240,212,138,.35)'; ctx.lineWidth = r * 0.06; ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#f0d48a'; ctx.lineWidth = r * 0.07; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
    ctx.strokeStyle = '#c9a24a'; ctx.lineWidth = r * 0.03; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,250,240,.75)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${r * 0.2}px ${lang === 'ja' ? '"Noto Sans JP"' : 'Inter'}`; ctx.fillText(label, 0, -r * 0.45);
    ctx.fillStyle = '#fffaf0'; ctx.font = `700 ${r * 0.56}px Cinzel, serif`; ctx.fillText(String(turn), 0, r * 0.04);
    ctx.fillStyle = '#f0d48a'; ctx.font = `600 ${r * 0.2}px "JetBrains Mono", monospace`; ctx.fillText(clock, 0, r * 0.5);
    ctx.restore();
  };

  /** a DOM screenshot layer with Ken Burns + optional highlight ring. render(t,a,b,{from,to}) where from/to = {x,y,s} focus */
  TK.shot = (stage, src, { z = 5, label = null, lang = 'ja' } = {}) => {
    const W = WY.W, H = WY.H;
    const wrap = WY.el('div', { class: 'wy-fill' }, stage); wrap.style.zIndex = z; wrap.style.overflow = 'hidden'; wrap.style.background = '#000';
    const im = WY.el('img', { src }, wrap); WY.img(src);
    WY.css(im, { position: 'absolute', left: '0px', top: '0px', width: '1920px', height: '1080px', transformOrigin: '0 0' });
    const scrim = WY.el('div', { class: 'wy-fill' }, wrap); scrim.style.background = 'linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,.72) 100%)';
    const ring = WY.el('div', { class: 'wy-abs' }, wrap);
    WY.css(ring, { border: '4px solid #ffd24d', borderRadius: '50%', boxShadow: '0 0 0 2px rgba(0,0,0,.5), 0 0 40px rgba(255,210,77,.7)', opacity: 0 });
    let lab = null;
    if (label) {
      lab = WY.el('div', { html: label }, wrap);
      WY.css(lab, { position: 'absolute', right: '80px', top: '70px', padding: '8px 16px', borderRadius: '8px', background: 'rgba(8,16,13,.78)', border: '1px solid rgba(240,212,138,.5)', color: '#f0d48a', font: `600 22px ${lang === 'ja' ? 'var(--sans-jp)' : 'var(--sans)'}`, letterSpacing: '.02em' });
    }
    return {
      node: wrap, img: im,
      /** cam: {x,y,s} = image point at screen centre and scale */
      render(t, a, b, cam, { ring: rg = null, fade = 0.3 } = {}) {
        if (t < a || t > b) { wrap.style.display = 'none'; return; }
        wrap.style.display = 'block';
        wrap.style.opacity = Math.min(1, (t - a) / fade, (b - t) / fade);
        const s = cam.s, tx = W / 2 - cam.x * s, ty = H / 2 - cam.y * s;
        im.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
        if (rg) {
          const rx = tx + rg.x * s, ry = ty + rg.y * s, rr = rg.r * s;
          WY.css(ring, { left: rx - rr + 'px', top: ry - rr + 'px', width: rr * 2 + 'px', height: rr * 2 + 'px', opacity: rg.k });
          ring.style.transform = `scale(${1 + (1 - rg.k) * 0.4})`;
        } else ring.style.opacity = 0;
      },
    };
  };

  /** nation card for cast montage: full-frame colour field, portrait, names. render(t, a, b) */
  TK.castCard = (stage, f, { lang = 'ja', z = 20, mirror = false, W = WY.W, H = WY.H, portraitSize = 860 } = {}) => {
    const n = WY.NATIONS[f]; const portrait = H > W;
    const root = WY.el('div', { class: 'wy-fill' }, stage); root.style.zIndex = z; root.style.overflow = 'hidden';
    const bgc = f === 4 ? '#3d5560' : n.dark;
    root.style.background = `radial-gradient(ellipse at ${mirror ? 70 : 32}% 45%, ${f === 4 ? '#6f8c97' : n.fill} 0%, ${bgc} 42%, #0a0806 100%)`;
    // giant sigil watermark
    const sv = WY.el('svg', { viewBox: '-1.2 -1.2 2.4 2.4', width: 1300, height: 1300 }, root);
    WY.css(sv, { position: 'absolute', left: (portrait ? W / 2 - 650 : mirror ? -180 : W - 1120) + 'px', top: (portrait ? 120 : H / 2 - 650) + 'px', opacity: 0.16 });
    WY.el('path', { d: WY.sigilPath(f, 1), fill: 'none', stroke: f === 4 ? '#fff' : n.light, 'stroke-width': 0.035 }, sv);
    WY.el('path', { d: WY.sigilPath(f, 0.8), fill: 'none', stroke: f === 4 ? '#fff' : n.light, 'stroke-width': 0.012 }, sv);
    // streak lines
    const streak = WY.el('div', { class: 'wy-abs' }, root);
    WY.css(streak, { width: W * 2 + 'px', height: '6px', background: `linear-gradient(90deg, transparent, ${n.light}, transparent)`, top: H * 0.72 + 'px', left: -W / 2 + 'px', opacity: 0.0 });
    const img = WY.el('img', { src: `${WY.ART}leaders3d/portrait-v1/${TK.KEYS[f]}.webp` }, root); WY.img(`${WY.ART}leaders3d/portrait-v1/${TK.KEYS[f]}.webp`);
    const ps = portraitSize;
    WY.css(img, { position: 'absolute', width: ps + 'px', height: ps + 'px', left: (portrait ? (W - ps) / 2 : mirror ? W - ps - 120 : 120) + 'px', top: (portrait ? 330 : H - ps + 10) + 'px', });
    const txt = WY.el('div', { class: 'wy-abs' }, root);
    const crestHtml = WY.crest(f, portrait ? 110 : 96);
    const nm = lang === 'ja' ? TK.NAT_JA[f] : n.en;
    txt.innerHTML = `<div style="display:flex;align-items:center;gap:22px;${portrait ? 'justify-content:center' : ''}">${crestHtml}<div style="font:600 ${portrait ? 30 : 26}px var(--mono);color:rgba(255,250,240,.6);letter-spacing:.2em">${String(f + 1).padStart(2, '0')} / 06</div></div>
      <div style="font:900 ${lang === 'ja' ? (portrait ? 150 : 132) : (portrait ? 140 : 128)}px/1.05 ${lang === 'ja' ? 'var(--serif-jp)' : 'Cinzel, serif'};margin-top:18px;color:#fffaf0;text-shadow:0 6px 30px rgba(0,0,0,.6)">${nm}</div>
      <div style="font:600 ${portrait ? 44 : 36}px Cinzel, serif;letter-spacing:.32em;color:${f === 4 ? '#e9f2f4' : n.light};margin-top:10px">${lang === 'ja' ? n.en.toUpperCase() : TK.DOC_EN[f].toUpperCase()}</div>
      <div style="font:700 ${portrait ? 46 : 40}px var(--sans-jp);color:rgba(255,250,240,.88);margin-top:26px">${lang === 'ja' ? '教義 · ' + TK.DOC_JA[f] : 'Doctrine'}</div>`;
    WY.css(txt, portrait ? { left: '0px', width: W + 'px', top: '1230px', textAlign: 'center' } : { left: (mirror ? 140 : 1040) + 'px', top: '300px', width: '760px', textAlign: 'left' });
    return {
      node: root,
      render(t, a, b) {
        if (t < a || t >= b) { root.style.display = 'none'; return; }
        root.style.display = 'block';
        const k = t - a, d = b - a;
        // diagonal wipe in
        const w = E.outExpo(clamp(k / 0.32));
        const sk = 260;
        root.style.clipPath = mirror
          ? `polygon(${W - w * (W + sk)}px 0, ${W}px 0, ${W}px ${H}px, ${W - w * (W + sk) + sk}px ${H}px)`
          : `polygon(0 0, ${w * (W + sk)}px 0, ${w * (W + sk) - sk}px ${H}px, 0 ${H}px)`;
        const p = E.outExpo(clamp((k - 0.05) / 0.6));
        const dir = mirror ? -1 : 1;
        img.style.transform = `translate(${dir * (1 - p) * -120 + dir * k * -10}px, ${(1 - p) * 30}px) scale(${1.04 + k * 0.03})`;
        img.style.opacity = clamp(p * 1.5);
        const q = E.outExpo(clamp((k - 0.12) / 0.6));
        txt.style.transform = `translateX(${dir * (1 - q) * 90 + dir * k * 8}px)`; txt.style.opacity = q;
        sv.style.transform = `rotate(${k * 14 * dir}deg) scale(${1 + k * 0.04})`;
        streak.style.opacity = Math.max(0, 1 - k / 0.35) * 0.9; streak.style.transform = `translateX(${dir * k * 1800}px) rotate(-8deg)`;
      },
    };
  };

  /** Title: W tile + "Wylls" letters. render(t, a) */
  TK.title = (stage, { size = 200, z = 35, y = null, sub = null, subFont = 'italic 600 46px "Cormorant Garamond", serif' } = {}) => {
    const W = WY.W, H = WY.H;
    const root = WY.el('div', { class: 'wy-center' }, stage); root.style.zIndex = z;
    if (y !== null) WY.css(root, { justifyContent: 'flex-start', paddingTop: y + 'px' });
    const row = WY.el('div', {}, root); WY.css(row, { display: 'flex', alignItems: 'center', gap: size * 0.26 + 'px' });
    const tile = WY.el('div', { html: WY.logo(size, { word: false }) }, row);
    const word = WY.el('div', {}, row); WY.css(word, { font: `700 ${size * 0.8}px/1 Cinzel, serif`, letterSpacing: '.04em', color: '#fffaf0', textShadow: '0 8px 40px rgba(0,0,0,.6)' });
    const letters = [...'Wylls'].map(c => { const s = WY.el('span', { text: c }, word); s.style.display = 'inline-block'; return s; });
    let subN = null;
    if (sub) { subN = WY.el('div', { html: sub }, root); WY.css(subN, { font: subFont, color: '#f0d48a', marginTop: size * 0.32 + 'px', letterSpacing: '.06em' }); }
    const shine = WY.el('div', { class: 'wy-abs' }, root);
    WY.css(shine, { width: '220px', height: H + 'px', background: 'linear-gradient(90deg, transparent, rgba(255,245,220,.22), transparent)', top: '0px', mixBlendMode: 'screen' });
    return {
      node: root, letters, tile,
      render(t, a, b = 1e9, { gap = 0.3, subAt = 1.9 } = {}) {
        if (t < a || t > b + 0.5) { root.style.display = 'none'; return; }
        root.style.display = 'flex';
        const k = t - a; const out = E.inCubic(clamp((t - b) / 0.5));
        root.style.opacity = 1 - out;
        const tp = E.outBack(clamp(k / 0.45));
        tile.style.transform = `scale(${lerp(2.4, 1, E.outExpo(clamp(k / 0.4)))}) rotate(${(1 - tp) * -12}deg)`; tile.style.opacity = clamp(k / 0.12);
        letters.forEach((s, i) => {
          const p = clamp((k - 0.35 - i * gap) / 0.35);
          s.style.opacity = clamp(p * 3); s.style.transform = `translateY(${(1 - E.outExpo(p)) * -50}px) scale(${1 + (1 - E.outExpo(p)) * 0.8})`;
          s.style.filter = p < 1 ? `blur(${((1 - p) * 10).toFixed(1)}px)` : 'none';
        });
        row.style.transform = `scale(${1 + k * 0.012})`;
        if (subN) { const p = E.outCubic(clamp((k - subAt) / 0.6)); subN.style.opacity = p; subN.style.transform = `translateY(${(1 - p) * 20}px)`; }
        const sp = clamp((k - 1.9) / 0.9); shine.style.left = lerp(-300, W + 100, E.inOutCubic(sp)) + 'px'; shine.style.opacity = sp > 0 && sp < 1 ? 1 : 0;
      },
    };
  };

  /** expanding shock ring (DOM) for cuts */
  TK.ring = (stage, { color = 'rgba(255,214,120,.9)', z = 58 } = {}) => {
    const n = WY.el('div', { class: 'wy-abs' }, stage);
    WY.css(n, { width: '200px', height: '200px', borderRadius: '50%', border: `6px solid ${color}`, zIndex: z, opacity: 0, boxShadow: `0 0 60px ${color}` });
    return { render(t, at, x = WY.W / 2, y = WY.H / 2, dur = 0.9, max = 14) { const k = (t - at) / dur; if (k < 0 || k > 1) { n.style.opacity = 0; return; } WY.css(n, { left: x - 100 + 'px', top: y - 100 + 'px', opacity: (1 - k) * 0.9 }); n.style.transform = `scale(${0.4 + E.outCubic(k) * max})`; n.style.borderWidth = (6 * (1 - k) + 1) + 'px'; } };
  };
})();
