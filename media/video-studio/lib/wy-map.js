/* Wylls video studio: an isometric hex world drawn with the game's own tile art.
 *
 * Geometry follows the client (map.mjs RADIUS 44 / FLATTEN 0.76; sprites.mjs
 * ART_SIZES @2x: tile 176x208, anchor 88,124): pointy-top axial hexes, r grows
 * downward, tile radius R = 88 world px at zoom 1.
 *
 *   const world = WYMap.build({ rings: 7, seed: 3 });
 *   WYMap.draw(ctx, world, { x: 0, y: 0, zoom: 0.6, W: 1920, H: 1080 }, { t, appear, fog, wash, borders });
 *
 * world.tiles: { q, r, ring, x, y, terrain, owner (0..5 | -1 neutral | -2 concord), keep, village, camp, freecity }
 * Everything is deterministic from the seed.
 */
(function () {
  'use strict';
  const R = 88, FLAT = 0.76, SQ3 = Math.sqrt(3);
  const HEX_W = SQ3 * R, ROW_H = 1.5 * R * FLAT;
  const LIFT = 0.24 * Math.sqrt(1 - FLAT * FLAT) * R; // anchor to top face
  const ART = () => (window.WY ? WY.ART : '../../../../permutation-server/web/frontier/art/');
  // the client's old sprite keys by nation index (sprites.mjs ART_FACTIONS)
  const ART_FACTIONS = ['ember', 'tide', 'lumen', 'iron', 'stone', 'verdant'];
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

  const px = (q, r) => ({ x: HEX_W * (q + r / 2), y: ROW_H * r });
  const ringOf = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(-q - r)) / 2;
  function hash(a, b = 0, c = 0) { let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return (h >>> 0) / 4294967296; }
  function vnoise(x, y, s) { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi; const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf); const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }

  const cache = {};
  function img(path) { if (!cache[path]) cache[path] = window.WY ? WY.img(ART() + path) : Object.assign(new Image(), { src: ART() + path }); return cache[path]; }

  /** Build a six-nation world: wedges by angle around The Concord. */
  function build({ rings = 7, seed = 7, concord = 1, sea = true } = {}) {
    const tiles = []; const byKey = new Map();
    for (let q = -rings; q <= rings; q++) for (let r = -rings; r <= rings; r++) {
      const ring = ringOf(q, r); if (ring > rings) continue;
      const p = px(q, r);
      // nation wedge by angle (nation 0 at the east, counter-clockwise like the client's wedges)
      const ang = Math.atan2(-(p.y / FLAT), p.x); // screen-up positive
      let w = Math.floor((((ang + Math.PI / 6) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 3));
      const n1 = vnoise(p.x / 260, p.y / 200, seed), n2 = vnoise(p.x / 120 + 9, p.y / 90, seed + 1);
      const edge = ring >= rings - (n1 > 0.55 ? 0 : 1) && sea;
      let terrain = n2 > 0.72 ? 'mountain' : n2 > 0.6 ? 'hills' : n1 > 0.58 ? 'forest' : n1 < 0.33 ? 'plains' : 'grassland';
      if (edge || (ring >= rings - 2 && n1 < 0.22 && sea)) terrain = 'water';
      let owner = ring <= concord ? -2 : terrain === 'water' ? -1 : w;
      const t = { q, r, ring, x: p.x, y: p.y, terrain, owner, variant: 1 + Math.floor(hash(q, r, seed) * 3), keep: false, village: null, camp: false, freecity: false };
      tiles.push(t); byKey.set(q + ',' + r, t);
    }
    // features: per wedge, villages near ring 3-4, a keep per wedge at ring 4, camps between wedges, free cities at outer ring
    for (const t of tiles) {
      if (t.owner < 0 || t.terrain === 'water' || t.terrain === 'mountain') continue;
      const h = hash(t.q, t.r, seed + 5);
      if (t.ring >= 2 && t.ring <= rings - 2 && h < 0.16) t.village = h < 0.04 ? 'town' : 'hamlet';
    }
    // keep: tile in each wedge at ring 3 nearest the wedge centre angle
    for (let n = 0; n < 6; n++) {
      const a = (n * Math.PI) / 3; let best = null, bd = 1e9;
      for (const t of tiles) { if (t.owner !== n || t.ring !== Math.max(2, Math.round(rings * 0.45)) || t.terrain === 'water') continue; const ta = Math.atan2(-(t.y / FLAT), t.x); let d = Math.abs(((ta - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI); if (d < bd) { bd = d; best = t; } }
      if (best) { best.keep = true; best.village = 'city'; best.terrain = best.terrain === 'mountain' ? 'hills' : best.terrain; }
    }
    // camps & free cities on wedge seams
    for (const t of tiles) {
      if (t.terrain === 'water' || t.ring < 3) continue;
      const nb = DIRS.map(([dq, dr]) => byKey.get(t.q + dq + ',' + (t.r + dr))).filter(Boolean);
      const seam = nb.some(o => o.owner >= 0 && o.owner !== t.owner && t.owner >= 0);
      const h = hash(t.q, t.r, seed + 9);
      if (seam && !t.village && h < 0.22) t.camp = true;
      if (seam && !t.village && !t.camp && t.ring === rings - 2 && h > 0.85) { t.freecity = true; t.owner = -1; }
    }
    const world = { tiles, byKey, rings, seed, get: (q, r) => byKey.get(q + ',' + r), px, keeps: tiles.filter(t => t.keep) };
    world.sorted = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);
    return world;
  }

  /** the top face polygon of a hex at world (x,y), in screen space after camera */
  function hexPath(ctx, sx, sy, rad, k = 1) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; const x = sx + Math.cos(a) * rad * k, y = sy + Math.sin(a) * rad * FLAT * k; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath();
  }
  const cornerXY = (sx, sy, rad, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return [sx + Math.cos(a) * rad, sy + Math.sin(a) * rad * FLAT]; };
  // edge i of the polygon goes corner i -> i+1; neighbour across it:
  const EDGE_NB = [[0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0]];

  /**
   * Draw the world. cam = { x, y, zoom, W, H } (x,y: world point at screen centre)
   * opts:
   *   appear(tile) -> 0..1   tile drop-in (default 1)
   *   fog(tile)    -> 0..1   cloud cover (default 0)
   *   wash(tile)   -> 0..1   nation colour wash strength (default .28)
   *   borders      -> 0..1   nation border strength (default 1)
   *   owner(tile)  -> int    override owner (for capture animations)
   *   features     -> bool   villages/keeps/camps (default true)
   *   paper        -> bool   draw the parchment sheet & table under (default true)
   *   t            -> time for subtle water shimmer
   */
  function draw(ctx, world, cam, opts = {}) {
    const { W, H } = cam; const z = cam.zoom;
    const appear = opts.appear || (() => 1), fog = opts.fog || (() => 0), wash = opts.wash || (() => 0.2), ownerOf = opts.owner || (t => t.owner);
    const borders = opts.borders ?? 1, features = opts.features ?? true;
    const S = (wx, wy) => [W / 2 + (wx - cam.x) * z, H / 2 + (wy - cam.y) * z];
    const rad = R * z;
    if (opts.background !== false) {
      // table and lamp light
      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, '#4a3424'); g.addColorStop(1, '#170f09');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    const tw = 176 * z, th = 208 * z, ax = 88 * z, ay = 124 * z;
    // pass 1: terrain sprites back to front
    for (const t of world.sorted) {
      const a = appear(t); if (a <= 0.001) continue;
      const [sx, sy0] = S(t.x, t.y); if (sx < -tw || sx > W + tw || sy0 < -th || sy0 > H + th) continue;
      const drop = (1 - (WY?.ease?.outBack ? WY.ease.outBack(a) : a)) * -120 * z;
      const sy = sy0 + drop;
      ctx.globalAlpha = Math.min(1, a * 1.6);
      const im = img(`terrain/@2x/${t.terrain}_${t.variant}.webp`);
      if (im.complete && im.naturalWidth) ctx.drawImage(im, sx - ax, sy - ay, tw, th);
      // nation wash on top face
      const o = ownerOf(t);
      if (o >= 0 && t.terrain !== 'water') {
        const n = WY.NATIONS[o]; const k = wash(t) * Math.min(1, a);
        if (k > 0.001) { hexPath(ctx, sx, sy - LIFT * z, rad, 0.98); ctx.fillStyle = n.land; ctx.globalAlpha = k; ctx.fill(); }
      } else if (o === -2) { hexPath(ctx, sx, sy - LIFT * z, rad, 0.98); ctx.fillStyle = '#f3ead2'; ctx.globalAlpha = 0.35 * a; ctx.fill(); }
      ctx.globalAlpha = 1;
    }
    // pass 2: borders between different owners
    if (borders > 0) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const t of world.sorted) {
        const o = ownerOf(t); if (o < 0 || t.terrain === 'water') continue;
        const a = appear(t); if (a < 0.6) continue;
        const [sx, sy] = S(t.x, t.y); const cy = sy - LIFT * z;
        for (let e = 0; e < 6; e++) {
          const [dq, dr] = EDGE_NB[e]; const nb = world.get(t.q + dq, t.r + dr);
          if (nb && ownerOf(nb) === o && nb.terrain !== 'water') continue;
          const [x1, y1] = cornerXY(sx, cy, rad * 0.93, e), [x2, y2] = cornerXY(sx, cy, rad * 0.93, (e + 1) % 6);
          ctx.globalAlpha = borders * Math.min(1, (a - 0.6) / 0.4);
          ctx.strokeStyle = WY.NATIONS[o].ink; ctx.lineWidth = Math.max(1.5, 7 * z); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          ctx.strokeStyle = WY.NATIONS[o].land; ctx.lineWidth = Math.max(1, 4 * z); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    // pass 3: features
    if (features) {
      for (const t of world.sorted) {
        const a = appear(t); if (a < 0.7) continue;
        const [sx, sy] = S(t.x, t.y); const o = ownerOf(t);
        ctx.globalAlpha = Math.min(1, (a - 0.7) / 0.3);
        let path = null;
        if (t.village && o >= 0) path = `holdings/@2x/${t.keep ? 'stronghold_w' : t.village === 'town' ? 'town_o' : 'hamlet_o'}_${ART_FACTIONS[o]}.webp`;
        else if (t.freecity) path = 'specials/@2x/freecity_town.webp';
        else if (t.camp) path = 'specials/@2x/barbarian_1.webp';
        else if (t.owner === -2) path = t.q === 0 && t.r === 0 ? 'specials/@2x/concord_plaza_1.webp' : 'specials/@2x/concord_paving.webp';
        if (path) { const im = img(path); if (im.complete && im.naturalWidth) ctx.drawImage(im, sx - ax, sy - ay, tw, th); }
        if (t.keep && o >= 0) drawPennant(ctx, sx, sy - 70 * z, z, o, opts.t || 0);
        ctx.globalAlpha = 1;
      }
    }
    // pass 4: fog clouds
    for (const t of world.sorted) {
      const f = fog(t); if (f <= 0.01) continue;
      const [sx, sy] = S(t.x, t.y);
      const im = img(`fog/@2x/cloud_${1 + (Math.abs(t.q * 7 + t.r * 3) % 3)}.webp`);
      ctx.globalAlpha = Math.min(1, f);
      const s = 1.25 + 0.15 * (1 - f);
      if (im.complete && im.naturalWidth) ctx.drawImage(im, sx - ax * s, sy - ay * s - (1 - f) * 30 * z, tw * s, th * s);
      ctx.globalAlpha = 1;
    }
  }

  /** a nation pennant on a pole with its sigil (screen coords) */
  function drawPennant(ctx, x, y, z, f, t) {
    const n = WY.NATIONS[f]; const s = Math.max(0.35, z) * 1.0;
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.strokeStyle = '#2a1d10'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(0, -46); ctx.stroke();
    const wv = Math.sin(t * 4 + f) * 4;
    ctx.beginPath(); ctx.moveTo(2, -46); ctx.quadraticCurveTo(28, -44 + wv, 52, -36 + wv); ctx.quadraticCurveTo(28, -26 - wv, 2, -18); ctx.closePath();
    ctx.fillStyle = n.fill; ctx.fill(); ctx.strokeStyle = n.ink; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.translate(20, -32); ctx.fillStyle = n.on; ctx.fill(new Path2D(WY.sigilPath(f, 6)));
    ctx.restore();
  }

  /** world -> screen for a camera */
  const toScreen = (cam, wx, wy) => [cam.W / 2 + (wx - cam.x) * cam.zoom, cam.H / 2 + (wy - cam.y) * cam.zoom];

  /** a march: dashed curved arrow from tile a to tile b, drawn up to progress k (0..1). sealed: shows a seal glyph instead of the head */
  function drawMarch(ctx, cam, a, b, k, { color = '#ffd24d', sealed = false, width = 6, lift = 0.25, dash = true } = {}) {
    const [x1, y1] = toScreen(cam, a.x, a.y - LIFT), [x2, y2] = toScreen(cam, b.x, b.y - LIFT);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.hypot(x2 - x1, y2 - y1) * lift;
    const pt = u => [(1 - u) * (1 - u) * x1 + 2 * (1 - u) * u * mx + u * u * x2, (1 - u) * (1 - u) * y1 + 2 * (1 - u) * u * my + u * u * y2];
    const steps = 60; ctx.save(); ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = width + 5; if (dash) ctx.setLineDash([width * 2.4, width * 1.8]);
    const stroke = () => { ctx.beginPath(); for (let i = 0; i <= steps * k; i++) { const [x, y] = pt(i / steps); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); };
    stroke(); ctx.strokeStyle = color; ctx.lineWidth = width; stroke(); ctx.setLineDash([]);
    if (k > 0.02) {
      const [hx, hy] = pt(k), [px0, py0] = pt(Math.max(0, k - 0.02)); const ang = Math.atan2(hy - py0, hx - px0);
      if (sealed) drawSeal(ctx, hx, hy, width * 3.2);
      else { ctx.translate(hx, hy); ctx.rotate(ang); ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(width * 2.6, 0); ctx.lineTo(-width * 1.4, -width * 1.8); ctx.lineTo(-width * 0.6, 0); ctx.lineTo(-width * 1.4, width * 1.8); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
    return pt;
  }
  /** a red wax seal with a W (screen coords) */
  function drawSeal(ctx, x, y, r, { color = '#a8222c', glyph = 'W' } = {}) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(r * 0.08, r * 0.15, r * 1.05, r * 1.0, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2, rr = r * (0.94 + 0.08 * Math.sin(i * 2.7)); i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath();
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r); g.addColorStop(0, '#e0525c'); g.addColorStop(1, color); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(80,10,15,.6)'; ctx.lineWidth = r * 0.08; ctx.beginPath(); ctx.arc(0, 0, r * 0.68, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffe2c8'; ctx.globalAlpha = 0.92; ctx.font = `900 ${r * 0.95}px Cinzel, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(glyph, 0, r * 0.06);
    ctx.restore();
  }
  /** a clash burst at a tile (screen), k: 0..1 local progress */
  function drawClash(ctx, cam, tile, k, color = '#ffd24d') {
    const [x, y] = toScreen(cam, tile.x, tile.y - LIFT); const z = cam.zoom;
    ctx.save(); ctx.translate(x, y);
    const e = 1 - Math.pow(1 - k, 3);
    ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = color; ctx.lineWidth = 10 * z * (1 - k) + 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 220 * z * e, 220 * z * e * FLAT, 0, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + 0.2; const r0 = 40 * z * e, r1 = (90 + (i % 3) * 40) * z * e; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * FLAT); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1 * FLAT); ctx.stroke(); }
    ctx.globalAlpha = Math.max(0, 1 - k * 2.5); const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 160 * z); g.addColorStop(0, 'rgba(255,240,200,.95)'); g.addColorStop(1, 'rgba(255,200,80,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 160 * z, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  window.WYMap = { R, FLAT, HEX_W, ROW_H, LIFT, px, build, draw, drawMarch, drawSeal, drawClash, drawPennant, hexPath, toScreen, ART_FACTIONS };
})();
