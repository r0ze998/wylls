// Materials drawn by code (UX design sections 2 and 11.12: no downloaded
// asset; a texture is a canvas the page paints once). Each is a small PNG
// kept as a data: URL (the page's CSP allows `img-src data:`) and handed to
// the stylesheet through a custom property on the root element, so a rule
// reads `background-image: var(--tex-paper, none)` and the page is whole
// without them (tests, a browser without a canvas).
//
//   --tex-paper   a tile of paper grain: fibres, specks, faint stains
//   --tex-deckle  a sheet with an uneven edge, for `border-image` (nine slices)
//   --tex-cloth   a tile of plain weave: warp and weft threads with slubs
//   --tex-metal   a tile of brushed bell metal: fine horizontal grain
//   --tex-stamp   a tile of worn ink, used as a mask on stamped words
//
// Everything is seeded: the same picture on every load.

/** The paper's colour: the deckle's fill and the sheet's `background-color` must be the same (frontier.css --paper-sheet). */
export const PAPER = '#f3ead3';
/** The deckle image's size, its slice and the slice's size on screen (frontier.css uses the last two). */
export const DECKLE = Object.freeze({ px: 320, slice: 20, css: 10 });

/** A small seeded generator (mulberry32): `rnd()` in [0, 1). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How far the sheet's edge stands in from the image's edge at `t` (0–1 along
 * one side between its corners), in image px: a sum of a few whole waves, so
 * the side repeats without a seam. Pure (the test reads it).
 */
export function deckleOffset(t, side = 0) {
  const waves = [[2, 1.5, 0.3], [5, 1.1, 1.7], [11, 0.8, 4.1], [23, 0.55, 2.2], [37, 0.35, 5.3]];
  let v = 3.2;
  for (const [n, amp, ph] of waves) v += Math.sin(t * n * Math.PI * 2 + ph + side * 1.9) * amp;
  return Math.max(0.6, v);
}

const canvasOf = (doc, w, h) => { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; };

/** Draw `fn(dx, dy)` nine times so that what crosses an edge of a `size` tile comes back in at the other side. */
function tiled(size, fn) { for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) fn(dx, dy); }

function paperTile(doc) {
  const S = 256, c = canvasOf(doc, S, S), g = c.getContext('2d'), rnd = seeded(41);
  // faint stains: large soft pools, a little darker or lighter
  for (let i = 0; i < 9; i++) {
    const x = rnd() * S, y = rnd() * S, r = 40 + rnd() * 70, dark = rnd() < 0.6;
    tiled(S, (dx, dy) => {
      const k = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      k.addColorStop(0, dark ? 'rgba(120,92,40,.055)' : 'rgba(255,252,240,.09)'); k.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = k; g.fillRect(0, 0, S, S);
    });
  }
  // fibres: short hairs lying every way
  g.lineCap = 'round';
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI, l = 5 + rnd() * 16, bend = (rnd() - 0.5) * 6, dark = rnd() < 0.55;
    g.strokeStyle = dark ? `rgba(96,72,30,${(0.05 + rnd() * 0.07).toFixed(3)})` : `rgba(255,253,244,${(0.1 + rnd() * 0.12).toFixed(3)})`;
    g.lineWidth = 0.5 + rnd() * 0.7;
    tiled(S, (dx, dy) => {
      g.beginPath(); g.moveTo(x + dx, y + dy);
      g.quadraticCurveTo(x + dx + Math.cos(a) * l / 2 - Math.sin(a) * bend, y + dy + Math.sin(a) * l / 2 + Math.cos(a) * bend, x + dx + Math.cos(a) * l, y + dy + Math.sin(a) * l);
      g.stroke();
    });
  }
  // specks
  const img = g.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = rnd();
    if (n < 0.5) continue;
    const dark = rnd() < 0.5, a = Math.round((n - 0.5) * (dark ? 26 : 30));
    // (over what is drawn: only where the tile is still nearly clear)
    if (d[i + 3] < 24) { d[i] = dark ? 90 : 255; d[i + 1] = dark ? 70 : 252; d[i + 2] = dark ? 30 : 240; d[i + 3] = Math.max(d[i + 3], a); }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function deckleSheet(doc) {
  const { px: S, slice } = DECKLE, cv = canvasOf(doc, S, S), g = cv.getContext('2d'), rnd = seeded(7);
  const mid = S - 2 * slice;
  const off = (s, side) => deckleOffset(Math.min(1, Math.max(0, (s - slice) / mid)), side);
  // (inside a corner's slice a side keeps one offset, so the four sides meet at plain corners; these are worn round)
  const c = [0, 1, 2, 3].map(side => off(0, side)), R = 5;
  const edge = () => {
    g.beginPath();
    const step = 2;
    g.moveTo(c[3] + R, c[0]);
    for (let s = c[3] + R; s <= S - c[1] - R; s += step) g.lineTo(s, off(s, 0));                                    // top, left to right
    g.quadraticCurveTo(S - c[1], c[0], S - c[1], c[0] + R);
    for (let s = c[0] + R; s <= S - c[2] - R; s += step) g.lineTo(S - off(s, 1), s);                                // right, downward
    g.quadraticCurveTo(S - c[1], S - c[2], S - c[1] - R, S - c[2]);
    for (let s = S - c[1] - R; s >= c[3] + R; s -= step) g.lineTo(s, S - off(s, 2));                                // bottom, right to left
    g.quadraticCurveTo(c[3], S - c[2], c[3], S - c[2] - R);
    for (let s = S - c[2] - R; s >= c[0] + R; s -= step) g.lineTo(off(s, 3), s);                                    // left, upward
    g.quadraticCurveTo(c[3], c[0], c[3] + R, c[0]);
    g.closePath();
  };
  edge(); g.fillStyle = PAPER; g.fill();
  // the edge has taken more ink and wear than the middle: a soft darker band just inside it, then a hair line
  g.save(); edge(); g.clip();
  g.lineJoin = 'round';
  for (const [w, a] of [[14, 0.05], [8, 0.07], [4, 0.1]]) { edge(); g.strokeStyle = `rgba(120,88,36,${a})`; g.lineWidth = w; g.stroke(); }
  edge(); g.strokeStyle = 'rgba(86,62,24,.55)'; g.lineWidth = 1.6; g.stroke();
  // a little grain on the band, as on the sheet
  for (let i = 0; i < 2600; i++) {
    const side = Math.floor(rnd() * 4), s = rnd() * S, inn = rnd() * slice;
    const x = side === 0 || side === 2 ? s : side === 1 ? S - inn : inn, y = side === 0 ? inn : side === 2 ? S - inn : s;
    g.fillStyle = rnd() < 0.5 ? 'rgba(90,70,30,.07)' : 'rgba(255,252,240,.1)';
    g.fillRect(x, y, 1, 1);
  }
  g.restore();
  return cv.toDataURL('image/png');
}

function clothTile(doc) {
  const S = 96, c = canvasOf(doc, S, S), g = c.getContext('2d'), rnd = seeded(113);
  const T = 3;   // a thread's width in image px (1.5 css px)
  // plain weave: each crossing shows the warp (lighter, a vertical highlight) or the weft (darker, a horizontal one)
  for (let y = 0; y < S; y += T) {
    const weft = 0.75 + rnd() * 0.5;
    for (let x = 0; x < S; x += T) {
      const over = ((x / T) + (y / T)) % 2 === 0;
      g.fillStyle = over ? `rgba(255,255,255,${(0.07 * weft).toFixed(3)})` : `rgba(0,0,0,${(0.085 * weft).toFixed(3)})`;
      g.fillRect(x, y, T, T);
      // the thread's own round: a hair of shade at one side of each crossing
      g.fillStyle = 'rgba(0,0,0,.07)';
      if (over) g.fillRect(x + T - 1, y, 1, T); else g.fillRect(x, y + T - 1, T, 1);
    }
  }
  // warp threads differ a little, and a few carry a slub
  for (let x = 0; x < S; x += T) {
    const k = rnd();
    if (k < 0.3) { g.fillStyle = `rgba(0,0,0,${(0.03 + rnd() * 0.04).toFixed(3)})`; g.fillRect(x, 0, T, S); }
    else if (k > 0.8) { g.fillStyle = `rgba(255,255,255,${(0.03 + rnd() * 0.04).toFixed(3)})`; g.fillRect(x, 0, T, S); }
  }
  for (let i = 0; i < 10; i++) {
    const x = Math.floor(rnd() * (S / T)) * T, y = rnd() * S, l = 8 + rnd() * 18;
    g.fillStyle = 'rgba(255,255,255,.1)';
    tiled(S, (dx, dy) => g.fillRect(x + dx, y + dy, T, l));
  }
  return c.toDataURL('image/png');
}

function metalTile(doc) {
  const S = 128, c = canvasOf(doc, S, S), g = c.getContext('2d'), rnd = seeded(271);
  // brushed, barely: faint horizontal hairs of uneven length (seen as a sheen, never as stripes)
  for (let i = 0; i < 300; i++) {
    const y = Math.floor(rnd() * S) + 0.5, x = rnd() * S, l = 8 + rnd() * 40, light = rnd() < 0.5;
    g.strokeStyle = light ? `rgba(240,225,180,${(0.008 + rnd() * 0.014).toFixed(3)})` : `rgba(0,0,0,${(0.014 + rnd() * 0.026).toFixed(3)})`;
    g.lineWidth = 1;
    tiled(S, dx => { g.beginPath(); g.moveTo(x + dx, y); g.lineTo(x + dx + l, y); g.stroke(); });
  }
  // and a fine grain over it
  const img = g.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 6 || rnd() < 0.6) continue;
    const light = rnd() < 0.5;
    d[i] = light ? 240 : 0; d[i + 1] = light ? 225 : 0; d[i + 2] = light ? 180 : 0; d[i + 3] = Math.round(2 + rnd() * (light ? 7 : 12));
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function stampTile(doc) {
  const S = 96, c = canvasOf(doc, S, S), g = c.getContext('2d'), rnd = seeded(907);
  // ink that took a little unevenly: solid, with a few thin patches (the word must stay easy to read)
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 46; i++) {
    const x = rnd() * S, y = rnd() * S, r = 0.5 + rnd() * 1.5, a = 0.12 + rnd() * 0.26;
    g.fillStyle = `rgba(0,0,0,${a.toFixed(2)})`;
    tiled(S, (dx, dy) => { g.beginPath(); g.ellipse(x + dx, y + dy, r * (1 + rnd()), r, rnd() * Math.PI, 0, Math.PI * 2); g.fill(); });
  }
  const img = g.getImageData(0, 0, S, S), d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = Math.max(0, Math.min(255, d[i] - Math.round(rnd() * 26)));
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

const MAKERS = Object.freeze({ '--tex-paper': paperTile, '--tex-deckle': deckleSheet, '--tex-cloth': clothTile, '--tex-metal': metalTile, '--tex-stamp': stampTile });
/** The custom properties this module sets (the stylesheet's names). */
export const TEXTURES = Object.freeze(Object.keys(MAKERS));

let cache = null;
/**
 * Paint the materials once and hand them to the stylesheet (a DOM page only).
 * Returns the names that were set; nothing (and no error) without a canvas.
 */
export function mountTextures(doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root?.style?.setProperty || !doc.createElement) return [];
  if (!cache) {
    cache = new Map();
    for (const [name, make] of Object.entries(MAKERS)) {
      try { const url = make(doc); if (/^data:image\/png/.test(url)) cache.set(name, url); } catch { /* no canvas here: the flat colour stands */ }
    }
  }
  for (const [name, url] of cache) root.style.setProperty(name, `url("${url}")`);
  return [...cache.keys()];
}
