/* Local helpers shared by videos 05, 06, 07, 10, 11 (copied into each scene folder).
 * Names and texts are taken verbatim from the client:
 *   nation names   permutation-server/web/i18n.mjs CIV_NAMES
 *   doctrines      permutation-server/web/frontier/fi18n.mjs:230 (EN: lang/en-frontier.mjs)
 *   one-liners     permutation-server/web/frontier/people/leaders.mjs DOCTRINE_PITCH (line breaks are ours)
 */
(function () {
  'use strict';
  const LK = (window.LK = {});
  LK.KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];
  LK.JA = ['アステル', 'ボレアリス', 'シンダー', 'ダンマール', 'エンバー', 'フィヨルダル'];
  LK.EN = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'];
  LK.DOC = ['石の守り手', '潮', '炎', '新緑', '光明', '鉄'];
  LK.DOC_EN = ['Wardens of Stone', 'Tide', 'Flame', 'Verdant', 'Lumen', 'Iron'];
  LK.PITCH = [
    ['城壁が安く、長槍兵は迎撃に強い。', '本拠を落とすには時間がかかる。'],
    ['隊商が速く、軽騎兵で動き回る。', '街道の道標を多く持てる。'],
    ['到着したターンの一撃が重い突撃歩兵。', '角笛で戦を告げる。'],
    ['補給の消耗が半分。', '側撃に強い森番が遠くまで行く。'],
    ['進軍が速い。工兵が道を倍に延ばし、', '探索で周りも見える。'],
    ['兵の維持費が安い重騎兵。', '奪った自由都市は城壁を残す。'],
  ];
  // the client's English doctrine one-liners (lang/en-frontier-play.mjs:363-367, 902), line breaks are ours
  LK.PITCH_EN = [
    ['Cheaper walls, and pikemen', 'who excel in Brace.', 'Its heartland is slow to take.'],
    ['Faster caravans and', 'roving light cavalry.', 'More Waystones on its roads.'],
    ['Shock infantry that hits hardest', 'on the turn it arrives.', 'Its war horn announces war.'],
    ['Half the supply attrition.', 'Rangers who are strong in Flank', 'and range far.'],
    ['Faster marches. Engineers build', 'roads twice as far, and exploring', 'also shows the tiles around.'],
    ['Heavy cavalry with cheaper upkeep.', 'Captured Free Cities', 'keep their walls.'],
  ];
  // spotlight / background tints that keep white text readable on every nation
  LK.BG = [
    ['#cc303b', '#5a1219', '#14070a'],
    ['#31bedb', '#0f4a5e', '#04141b'],
    ['#eac21b', '#6b4a08', '#160f03'],
    ['#a34cd8', '#3d1653', '#0e0614'],
    ['#c9d6d4', '#2c4149', '#070e11'],
    ['#f19232', '#6e3410', '#170a03'],
  ];

  /** A block of hand-broken lines, one span per character (for WY.revealChars). */
  LK.lines = (parent, lines, css = {}, lineCss = {}) => {
    const box = WY.el('div', { class: 'wy-abs' }, parent);
    WY.css(box, css);
    const spans = [];
    const rows = lines.map(l => {
      const d = WY.el('div', {}, box);
      WY.css(d, Object.assign({ whiteSpace: 'nowrap' }, lineCss));
      const row = [];
      for (const c of l) { const s = WY.el('span', { class: 'wy-ch', text: c }, d); spans.push(s); row.push(s); }
      return row;
    });
    return { box, spans, rows };
  };
  /** absolutely placed html */
  LK.div = (parent, html, css = {}) => { const n = WY.el('div', { class: 'wy-abs', html }, parent); WY.css(n, css); return n; };

  /** vignette + moving grain on top */
  LK.overlays = (stage, z = 45, { vignette = 0.6 } = {}) => {
    const v = WY.el('div', { class: 'wy-vignette' }, stage);
    WY.css(v, { zIndex: z, background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,${vignette}) 100%)` });
    const g = WY.el('div', { class: 'wy-grain' }, stage);
    WY.css(g, { zIndex: z + 1 });
    return { v, g, render(t) { const f = Math.floor(t * 24); g.style.transform = `translate(${((f * 37) % 120) - 60}px, ${((f * 53) % 120) - 60}px)`; } };
  };

  /** offscreen canvas with a faint hex lattice (for slow parallax backgrounds) */
  LK.hexLattice = (w, h, r = 60, color = 'rgba(255,255,255,0.06)', lw = 1.5) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.strokeStyle = color; g.lineWidth = lw;
    const hw = Math.sqrt(3) * r;
    for (let row = -1; row * r * 1.5 < h + r * 2; row++) for (let col = -1; col * hw < w + hw; col++) {
      const cx = col * hw + (row % 2 ? hw / 2 : 0), cy = row * r * 1.5;
      g.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); g.stroke();
    }
    return c;
  };

  /** A character's stage figure: still, idle strip (4 frames) and attack strip (8 frames), 288x360 cells. */
  LK.figure = key => {
    const still = WY.img(`${WY.ART}leaders3d/stage-v1/${key}.webp`);
    const idle = WY.img(`${WY.ART}leaders3d/stage-v1/${key}_idle.webp`);
    const attack = WY.img(`${WY.ART}leaders3d/stage-v1/${key}_attack.webp`);
    const PING = [0, 1, 2, 3, 2, 1];
    return {
      still, idle, attack,
      /** mode: 'still' | 'idle' | 'attack'; u = local time; draws with bottom-centre at (cx, by), height h */
      draw(ctx, u, cx, by, h, mode = 'idle', attackAt = null) {
        const w = h * 0.8;
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        if (attackAt !== null && u >= attackAt && u < attackAt + 0.8) {
          const i = Math.min(7, Math.floor((u - attackAt) * 10));
          if (attack.naturalWidth) ctx.drawImage(attack, i * 288, 0, 288, 360, cx - w / 2, by - h, w, h);
          return;
        }
        if (mode === 'idle' && idle.naturalWidth) {
          const i = PING[Math.floor(Math.max(0, u) * 6) % 6];
          ctx.drawImage(idle, i * 288, 0, 288, 360, cx - w / 2, by - h, w, h);
        } else if (still.naturalWidth) ctx.drawImage(still, cx - w / 2, by - h, w, h);
      },
    };
  };

  /** soft ground shadow ellipse */
  LK.shadow = (ctx, x, y, rx, ry, a = 0.5) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rx);
    g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.translate(x, y); ctx.scale(1, ry / rx); ctx.translate(-x, -y);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rx, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  };

  /** sprite-atlas VFX (vfx/first-v1, 8 columns, 24 fps); k = seconds since start */
  LK.vfx = (path, cell = 256, cols = 8, frames = null) => {
    const im = WY.img(WY.ART + path);
    return {
      im,
      draw(ctx, k, cx, cy, size, fps = 24) {
        if (!im.naturalWidth || k < 0) return;
        const n = frames || cols * Math.floor(im.naturalHeight / cell);
        const i = Math.floor(k * fps); if (i >= n) return;
        ctx.drawImage(im, (i % cols) * cell, Math.floor(i / cols) * cell, cell, cell, cx - size / 2, cy - size / 2, size, size);
      },
    };
  };

  /** rgba from hex */
  LK.rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

  /** a pill label (DOM html) */
  LK.pill = (text, { bg = 'rgba(10,24,19,.85)', fg = '#f0d48a', border = 'rgba(240,212,138,.7)', size = 26, font = 'var(--sans-jp)', weight = 700 } = {}) =>
    `<span style="display:inline-flex;align-items:center;padding:.28em .8em;border-radius:999px;border:1.5px solid ${border};background:${bg};color:${fg};font:${weight} ${size}px/1 ${font};letter-spacing:.06em">${text}</span>`;

  /** generic in/out envelope for a DOM node: fades + rises in at a, out at b */
  LK.show = (n, t, a, b, { rise = 24, fi = 0.5, fo = 0.4, blur = 0, x = 0, scale = 0 } = {}) => {
    const kin = WY.ease.outCubic(WY.clamp((t - a) / fi));
    const kout = WY.ease.inCubic(WY.clamp((t - (b - fo)) / fo));
    const k = kin * (1 - kout);
    n.style.opacity = k;
    n.style.visibility = k <= 0.001 ? 'hidden' : 'visible';
    const s = 1 + scale * (1 - kin);
    n.style.transform = `translate(${x * (1 - kin)}px, ${(1 - kin) * rise - kout * rise * 0.5}px) scale(${s})`;
    if (blur) n.style.filter = k < 0.99 ? `blur(${(1 - k) * blur}px)` : 'none';
    return k;
  };
})();
