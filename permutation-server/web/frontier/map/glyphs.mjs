// The map's small icons, drawn on the canvas in the same hand as the HUD's
// (art/ui/icons.svg: a 24-px grid, 1.75-px round strokes, a light tone where a
// shape needs weight). The paths below are the sprite's own, copied by name:
// a badge on the map and a button in the HUD show the same picture. A canvas
// cannot use the sprite's <symbol>s, so the path data lives here too; when an
// icon of the sprite changes, change it here (the test compares the two).
//
// `paintGlyph(g, name, x, y, size, {colour, weight, tone})` draws one centred
// at (x, y), `size` px square, in the units of the context. Without Path2D
// (the node tests) nothing is drawn and nothing throws.

/** name → [[path data, tone (fill-opacity of the same colour, 0 = stroke only)], …] and circles [[cx, cy, r]]. */
export const GLYPHS = Object.freeze({
  home: { paths: [['M6 10.5V20h12v-9.5', 0.18], ['M3.5 12L12 4.5l8.5 7.5', 0], ['M10 20v-5h4v5', 0]] },
  swords: { paths: [['M4.5 4.5l10.8 10.8M4.5 4.5v3M4.5 4.5h3', 0], ['M19.5 4.5L8.7 15.3M19.5 4.5v3M19.5 4.5h-3', 0], ['M13.3 17.5l4.2-4.2M16.3 16.3l3.2 3.2', 0], ['M10.7 17.5l-4.2-4.2M7.7 16.3l-3.2 3.2', 0]] },
  eye: { paths: [['M2.5 12c2.5-4.2 5.7-6.3 9.5-6.3s7 2.1 9.5 6.3c-2.5 4.2-5.7 6.3-9.5 6.3S5 16.2 2.5 12Z', 0.18]], circles: [[12, 12, 2.8]] },
  shield: { paths: [['M12 3.5l7.5 2.5v5.5c0 4.3-2.9 7.6-7.5 9.3-4.6-1.7-7.5-5-7.5-9.3V6Z', 0.18], ['M12 7.5v9', 0]] },
  banner: { paths: [['M6 3v18.5', 0], ['M6 5h13l-3 3.8 3 3.7H6Z', 0.18]] },
  hammer: { paths: [['M13.5 4l6.5 6.5-3 3L10.5 7Z', 0.18], ['M13 10L4.5 18.5l1.8 1.8L14.8 11.8', 0]] },
  bell: { paths: [['M5 17.5h14c-1.4-1.3-2.2-2.9-2.2-5v-2.2a4.8 4.8 0 0 0-9.6 0v2.2c0 2.1-.8 3.7-2.2 5Z', 0.18], ['M12 5.5V3.5', 0], ['M10.2 20a2 2 0 0 0 3.6 0', 0]] },
  hourglass: { paths: [['M6.5 4h11M6.5 20h11', 0], ['M8 4v3.5l4 4.5 4-4.5V4', 0], ['M8 20v-3.5l4-4.5 4 4.5V20', 0.22]] },
  check: { paths: [['M5 12.5l4.5 4.5L19 7.5', 0]] },
});

const made = new Map();
function pathsOf(name) {
  if (typeof Path2D === 'undefined') return null;
  let v = made.get(name);
  if (v === undefined) {
    const G = GLYPHS[name];
    try { v = G ? G.paths.map(([d, tone]) => ({ path: new Path2D(d), tone })) : null; } catch { v = null; }
    made.set(name, v);
  }
  return v;
}

/**
 * One icon centred at (x, y), `size` units square. `colour`: its stroke (and
 * the tone's colour); `weight`: the stroke on the 24-px grid (the sprite's
 * 1.75; a small badge on a busy map wants a little more); `tone`: a factor on
 * the sprite's tones. Returns whether it was drawn.
 */
export function paintGlyph(g, name, x, y, size, { colour = '#f4efe0', weight = 1.75, tone = 1, alpha = 1 } = {}) {
  const P = g?.save ? pathsOf(name) : null;
  if (!P) return false;
  const k = size / 24;
  g.save();
  g.translate(x - size / 2, y - size / 2);
  g.scale(k, k);
  g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = weight;
  g.strokeStyle = colour; g.fillStyle = colour;
  for (const { path, tone: t } of P) {
    if (t > 0 && tone > 0) { g.globalAlpha = alpha * Math.min(1, t * tone); g.fill(path); }
    g.globalAlpha = alpha; g.stroke(path);
  }
  for (const [cx, cy, r] of GLYPHS[name].circles ?? []) { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); }
  g.restore();
  return true;
}
