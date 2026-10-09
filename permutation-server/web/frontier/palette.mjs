// The six nations' colours (UX design: the nation colours of the UI agree with
// the leaders' clothes). One table for the whole Frontier client: the map, the
// HUD, the banners and the portraits all read it, so a nation is the same
// colour as the coat of the person who leads it.
//
//   0 Aster     red          the marshal's coat
//   1 Borealis  sky cyan     the captain's coat and hood
//   2 Cinder    yellow       the herald's cape
//   3 Dunmar    purple       the hooded mantle
//   4 Ember     white        the surveyor's coat
//   5 Fjordal   orange       the jarl's coat
//
// `FILL` is the cloth itself (the values of leader-motion-data.mjs
// MOTION_LEADERS, lower case). Three of the six are light colours, so a mark
// can no longer be "ivory on the fill" or "the fill on ivory" for every
// nation; each use takes the column made for it:
//
//   FILL    the cloth: a banner, a pennon, a roof, a territory wash, a swatch
//   DARK    its trim: a frame, a pill that carries white text (white on it is at least 4.5:1)
//   LIGHT   its tint: a paper-like ground in the nation's hue
//   DEEP    the same dye in a deep tone: the ground behind a leader's picture (the hexagon icons' own grounds),
//           so that the coat, the brightest thing in the nation's colour, reads against it
//   INK     its outline against the land or parchment (darker than DARK)
//   ON      a mark drawn ON the fill: a sigil on a shield or a flag (at least 4.5:1 on FILL)
//   MARK    the nation's colour as a mark on ivory or parchment: a sigil in a badge,
//           a coloured word (at least 3:1 on ivory #fffaf0 and on the chart's parchment #e6d9b8)
//
// A nation is never told by colour alone: the sigil goes with it everywhere.
// The older pages one level up keep their own table (i18n.mjs CIV_COLORS).

export const NATION_KEYS = Object.freeze(['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal']);
export const NATION_FILL = Object.freeze(['#cc303b', '#31bedb', '#eac21b', '#a34cd8', '#edeee7', '#f19232']);
export const NATION_DARK = Object.freeze(['#81242c', '#237489', '#8c721c', '#69338c', '#5f6a68', '#9c581f']);
export const NATION_LIGHT = Object.freeze(['#f5d2d5', '#d3f0f5', '#f8efc4', '#eddbf7', '#f9faf4', '#fbe2c5']);
export const NATION_DEEP = Object.freeze(['#701c2c', '#145c77', '#986a0e', '#502269', '#344950', '#9c471c']);
export const NATION_INK = Object.freeze(['#5e1a20', '#17586a', '#6a5510', '#4e2470', '#434c4a', '#74400f']);
export const NATION_ON = Object.freeze(['#fffaf0', '#0e3a46', '#3b2f06', '#ffffff', '#333c3a', '#3d2206']);
export const NATION_MARK = Object.freeze(['#cc303b', '#127a92', '#8a6d00', '#a34cd8', '#6b7573', '#b05a0a']);

const ok = f => Number.isInteger(f) && f >= 0 && f < 6;
/** Every column of one nation, or null for anything that is not a nation (neutral camps, free cities). */
export const nationColors = f => (ok(f) ? { fill: NATION_FILL[f], dark: NATION_DARK[f], light: NATION_LIGHT[f], deep: NATION_DEEP[f], ink: NATION_INK[f], on: NATION_ON[f], mark: NATION_MARK[f] } : null);

/** WCAG 2.x relative luminance of #rrggbb, and the contrast of two colours (for the palette's own test). */
export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
