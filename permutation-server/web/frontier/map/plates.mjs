// The village is the hero (UX brief §11.6).
//
// One nameplate per village, and nothing else stacked on it: the village's
// name in the serif, its tier as a small chip, and under them the garrison and
// the hosts that stand there as two icon badges in one pill style. The plate
// hangs on a thin brass leader above the village and never covers its sprite.
// The owner's name is not on the map (the inspector has it). The viewer's own
// village is drawn larger than the others (`HERO`), its hosts stand in front
// of it and not on it, and a building going up is a ring on its scaffold, not
// a label.
//
// What a plate may say follows the survey (map/survey.mjs), through the tile
// model (map/sprites.mjs model): a village that is surveyed but not in sight
// has its name and tier; its garrison and the hosts on it are told only where
// the viewer has them in sight.
//
// Every label here asks the frame's label pass for its place
// (map/labelpass.mjs): it keeps clear of the HUD and of the labels before it,
// and a tile whose pile is put away for an effect shows none.
import { RADIUS } from '../../map.mjs';
import { L, fmtNum, lang } from '../../lang.mjs';
import { FACTION_COLORS, TIERS, factionName } from '../fi18n.mjs';
import { wedgeOf } from '../fgeo.mjs';
import { placeName } from '../people/identity.mjs';
import { pillSize, statusMark, unitPill } from '../people/units.mjs';
import { SIGILS } from './layers.mjs';
import { YOU } from './chart.mjs';
import { upright } from './tilt.mjs';
import { NATION_INK, NATION_ON } from '../palette.mjs';
import { paintGlyph } from './glyphs.mjs';
import { OPEN_PASS } from './labelpass.mjs';
import { VILLAGE } from './village.mjs';
import { rowScale } from './tilt.mjs';

/**
 * The viewer's own village (world px on its tile; RADIUS is a hex's corner radius). Villages are drawn by code
 * (map/village.mjs), so none is ever stretched:
 *   scale     how much larger than another village it is drawn. At the hero zoom a town is then some 180 px wide on
 *             a desktop: wider than its own tile, its palisade reaching a quarter of the way into the tiles on
 *             either side, and no taller than the tile (the houses in front stay clear).
 *   at        where the middle of its ground stands from the tile's centre: a little up, so the ground in front stays clear
 *   hosts     where the groups of hosts stand (units of RADIUS and of the tokens' row: people/units.mjs): outside the
 *             palisade, either side of the gate road and then in front of it (the second review: they stood on the houses)
 *   scaffold  where a building going up stands, and its ring: outside the wall on the left, over the road (not on the houses)
 *   standard  where the viewer's standard stands (map/ownland.mjs STANDARD_AT is this): beside the ring, to the right
 *   top       the top of a town's tallest roof above the tile's centre (`villageTop` gives it for every tier)
 */
export const HERO = Object.freeze({
  scale: 1.65,
  at: Object.freeze({ x: 0, y: -RADIUS * 0.12 }),
  hosts: Object.freeze([[[0.7, 0.76]], [[0.72, 0.76], [-0.68, 0.76]], [[0.72, 0.76], [-0.68, 0.76], [0.04, 0.79]]]),
  scaffold: Object.freeze({ x: -RADIUS * 1.16, y: -RADIUS * 0.1 }),
  standard: Object.freeze({ x: RADIUS * 1.36, y: -RADIUS * 0.3 }),
  top: RADIUS * (VILLAGE.top[1] * 1.65 + 0.12),
});
/** Any other village: how large it is drawn (it keeps inside its own tile), where its ground's middle stands, and a town's top above the tile's centre. */
export const VILLAGE_SCALE = 1.04;
export const VILLAGE_AT = Object.freeze({ x: 0, y: -RADIUS * 0.04 });
export const VILLAGE_TOP = RADIUS * (VILLAGE.top[1] * VILLAGE_SCALE + 0.04);
/** How a village tile `u` (`{hero, tier}`) is drawn: its scale and where the middle of its ground stands from the tile's centre (world px). */
export const villagePlace = u => (u?.hero ? { scale: HERO.scale, x: HERO.at.x, y: HERO.at.y } : { scale: VILLAGE_SCALE, x: VILLAGE_AT.x, y: VILLAGE_AT.y });
/** The top of village tile `u`'s tallest roof above the tile's centre (world px): a plate's leader starts there. */
export function villageTop(u) {
  const pl = villagePlace(u), t = Math.max(0, Math.min(3, u?.tier ?? 1));
  return RADIUS * VILLAGE.top[t] * pl.scale - pl.y;
}
/** Plates: other villages are named from this many screen px of hex radius (cities and strongholds from the lower one); badges from PLATE_BADGES_R; at most PLATE_MAX a frame. */
export const PLATE_MIN_R = 26;
/** A plate of another's village that would be moved down by more than this (screen px) is left out. */
export const PLATE_DROP = 6;
export const PLATE_ALL_R = 38;
export const PLATE_BADGES_R = 48;
export const PLATE_MAX = 48;

const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", Georgia, serif';
const SANS = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
/** The plate's material: bell metal with a brass hairline (the HUD's own, UX brief §6). */
const METAL = 'rgba(15,32,29,.94)', METAL_2 = 'rgba(22,44,39,.94)', BRASS = '#c9a24a', BRASS_HI = '#f0d48a', IVORY = '#f4efe0', INK_2 = '#a9b8b1';
// (the nations' inks and the colour of a mark on each nation's fill: palette.mjs)

/** A village's own name, without its tier (「ラマール」; the tier is the chip beside it). */
export const villageName = t => placeName(t.p, t.pq ?? t.q, t.site)[lang() === 'en' ? 'en' : 'ja'];

function sigil(g, shape, x, y, r) {
  const pts = n => Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [x + Math.cos(a) * r, y + Math.sin(a) * r]; });
  g.beginPath();
  if (shape === 'circle' || shape === 'ring') g.arc(x, y, r * 0.86, 0, Math.PI * 2);
  else if (shape === 'cross') { const w = r * 0.36; [[-w, -r], [w, -r], [w, -w], [r, -w], [r, w], [w, w], [w, r], [-w, r], [-w, w], [-r, w], [-r, -w], [-w, -w]].forEach(([px, py], i) => (i ? g.lineTo(x + px, y + py) : g.moveTo(x + px, y + py))); g.closePath(); }
  else { const c = shape === 'triangle' ? pts(3) : shape === 'square' ? pts(4).map(([px, py]) => [x + ((px - x) - (py - y)) * 0.62, y + ((py - y) + (px - x)) * 0.62]) : shape === 'diamond' ? pts(4) : pts(6); c.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); }
}

/**
 * What a village's plate says: `{name, tier, chips: [{text, tone}], badges: [{glyph, text, tone}]}`.
 * `v` `{p, q, site, tier, owner, provisional, shield, garrison (whole troops or null), hosts (whole troops of the
 * owner's hosts standing there, or 0)}`; `badges` false leaves the second row out.
 */
export function plateModel(v, { badges = true } = {}) {
  const chips = [{ text: TIERS[v.tier] ?? TIERS[0], tone: 'tier' }];
  if (v.provisional) chips.push({ text: L`仮`, tone: 'you' });
  const row = [];
  if (badges) {
    if (Number.isFinite(v.garrison) && v.garrison !== null) row.push({ glyph: 'shield', text: fmtNum(v.garrison), tone: v.shield ? 'shield' : 'plain' });
    else if (v.shield) row.push({ glyph: 'shield', text: '', tone: 'shield' });
    if (v.hosts > 0) row.push({ glyph: 'banner', text: fmtNum(v.hosts), tone: 'plain' });
  }
  return { name: villageName(v), chips, badges: row };
}

/**
 * The size of a plate (world px at `k` = 1 / zoom): `{w, h, row1, row2, parts…}`. `own`: the viewer's own village
 * (a little larger); `small`: from afar.
 */
export function plateSize(g, m, k, { own = false, small = false } = {}) {
  // (`small`: a plate from afar is tighter, but its type never goes under 12 px: the name a little smaller, the chip and the numbers as they are)
  const u = k * (small ? 0.9 : 1);
  const nameSize = (own ? 15 : 14) * u, chipSize = 12 * k, numSize = 12 * k;
  g.font = `600 ${nameSize}px ${SERIF}`;
  const nameW = g.measureText?.(m.name)?.width ?? m.name.length * nameSize;
  g.font = `600 ${chipSize}px ${SANS}`;
  const chips = m.chips.map(c => ({ ...c, w: (g.measureText?.(c.text)?.width ?? c.text.length * chipSize) + 10 * u }));
  g.font = `700 ${numSize}px ${SANS}`;
  const badges = m.badges.map(b => ({ ...b, w: 14 * u + (b.text ? 4 * u + (g.measureText?.(b.text)?.width ?? b.text.length * numSize * 0.6) : 0) }));
  const pad = 8 * u, sig = 16 * u, h1 = (own ? 26 : 24) * u, h2 = badges.length ? 20 * u : 0;
  const w1 = pad + sig + 6 * u + nameW + chips.reduce((a, c) => a + 5 * u + c.w, 0) + pad;
  const w2 = badges.length ? badges.reduce((a, b) => a + b.w, 0) + (badges.length - 1) * 11 * u + 2 * 10 * u : 0;
  return { u, w: Math.max(w1, w2), w1, w2, h: h1 + h2 - (h2 ? 1 * u : 0), h1, h2, pad, sig, nameW, nameSize, chipSize, numSize, chips, badges };
}

/**
 * One nameplate: its lower middle hangs `leader` screen px above the anchor (ax, ay) (the top of the village's
 * sprite, world px), moved by (dx, dy) when the label pass nudged it; the leader still runs to the anchor.
 */
export function paintPlate(g, ax, ay, m, S, { k = 1, faction = 0, own = false, muted = false, leader = 13, dx = 0, dy = 0 } = {}) {
  if (!g?.save) return;
  const u = S.u, x0 = ax + dx - S.w / 2, y1 = ay + dy - leader * k, y0 = y1 - S.h;
  const col = FACTION_COLORS[faction] ?? '#8a8f86', ink = NATION_INK[faction] ?? '#3a3a34';
  const rim = own ? YOU : BRASS;
  g.save();
  g.globalAlpha = muted ? 0.8 : 1;
  g.lineJoin = 'round'; g.lineCap = 'round';
  // the leader: a brass hair from the plate to the village, with a small lozenge where it lands
  // (it leaves the plate straight above its anchor wherever the plate reaches that far; a plate nudged well aside is reached by a slanted hair)
  const half = (S.h2 ? Math.min(S.w1, S.w2) : S.w1) / 2 - 9 * u, lx = Math.max(ax + dx - half, Math.min(ax + dx + half, ax));
  g.strokeStyle = 'rgba(10,20,18,.6)'; g.lineWidth = 2.6 * k; g.beginPath(); g.moveTo(lx, y1); g.lineTo(ax, ay); g.stroke();
  g.strokeStyle = rim; g.lineWidth = 1 * k; g.beginPath(); g.moveTo(lx, y1); g.lineTo(ax, ay); g.stroke();
  const d = 2.8 * k;
  g.fillStyle = rim; g.strokeStyle = 'rgba(10,20,18,.8)'; g.lineWidth = 0.8 * k;
  g.beginPath(); g.moveTo(ax, ay - d); g.lineTo(ax + d, ay); g.lineTo(ax, ay + d); g.lineTo(ax - d, ay); g.closePath(); g.fill(); g.stroke();
  // the badges' row hangs under the name's row, a little narrower: one piece of metal
  const r1 = { x: ax + dx - S.w1 / 2, y: y0, w: S.w1, h: S.h1 }, r2 = S.h2 ? { x: ax + dx - S.w2 / 2, y: y0 + S.h1 - 1 * u, w: S.w2, h: S.h2 } : null;
  const rr = (r, rad) => { g.beginPath(); g.roundRect?.(r.x, r.y, r.w, r.h, rad); };
  // its cast shadow on the map
  // (each row casts its own: one shadow as wide as the name's row under both showed as a grey box either side of
  // the narrower badges' row, the "ghost" of the second review)
  g.fillStyle = 'rgba(4,10,9,.32)';
  rr({ ...r1, y: r1.y + 2 * k }, 7 * u); g.fill();
  if (r2) { rr({ ...r2, y: r2.y + 2 * k }, [0, 0, 8 * u, 8 * u]); g.fill(); }
  if (r2) { rr(r2, [0, 0, 8 * u, 8 * u]); g.fillStyle = METAL_2; g.fill(); g.strokeStyle = rim; g.globalAlpha *= 0.75; g.lineWidth = 1 * k; g.stroke(); g.globalAlpha = muted ? 0.8 : 1; }
  rr(r1, 7 * u); g.fillStyle = METAL; g.fill();
  g.strokeStyle = rim; g.lineWidth = (own ? 1.5 : 1) * k; g.stroke();
  // an inner highlight along the top edge
  g.strokeStyle = 'rgba(255,248,224,.16)'; g.lineWidth = 1 * k; g.beginPath(); g.moveTo(r1.x + 7 * u, r1.y + 1.5 * k); g.lineTo(r1.x + r1.w - 7 * u, r1.y + 1.5 * k); g.stroke();
  // the nation's sigil on its colour (a nation is never told by colour alone)
  const cy = r1.y + r1.h / 2, sx = r1.x + S.pad + S.sig / 2;
  g.beginPath(); g.arc(sx, cy, S.sig / 2, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.strokeStyle = ink; g.lineWidth = 1 * k; g.stroke();
  const shape = SIGILS[faction] ?? 'ring';
  sigil(g, shape, sx, cy, S.sig * 0.3);
  if (shape === 'ring') { g.strokeStyle = '#fff6e2'; g.lineWidth = 1.6 * k; g.stroke(); } else { g.fillStyle = NATION_ON[faction] ?? '#fff6e2'; g.fill(); }
  // the name, in the serif
  let x = sx + S.sig / 2 + 6 * u;
  g.font = `600 ${S.nameSize}px ${SERIF}`; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillStyle = own ? '#fff3cf' : IVORY; g.fillText(m.name, x, cy + 0.5 * u);
  x += S.nameW;
  // the chips: the tier, and 仮 for a village that is not final yet
  g.font = `600 ${S.chipSize}px ${SANS}`;
  for (const c of S.chips) {
    x += 5 * u;
    const ch = 17 * u, you = c.tone === 'you';
    g.beginPath(); g.roundRect?.(x, cy - ch / 2, c.w, ch, 4 * u);
    g.fillStyle = you ? 'rgba(243,213,138,.16)' : 'rgba(201,162,74,.16)'; g.fill();
    g.strokeStyle = you ? YOU : 'rgba(201,162,74,.6)'; g.lineWidth = 1 * k;
    if (you) g.setLineDash([3 * k, 2 * k]);
    g.stroke(); g.setLineDash([]);
    g.fillStyle = you ? YOU : BRASS_HI; g.fillText(c.text, x + 5 * u, cy + 0.5 * u);
    x += c.w;
  }
  // the badges: an icon and a number each, one style
  if (r2) {
    let bx = r2.x + 10 * u;
    const by = r2.y + r2.h / 2;
    g.font = `700 ${S.numSize}px ${SANS}`;
    for (const b of S.badges) {
      const tint = b.tone === 'shield' ? '#8fc0f0' : INK_2;
      paintGlyph(g, b.glyph, bx + 7 * u, by, 14 * u, { colour: tint, weight: 2, alpha: muted ? 0.8 : 1 });
      if (b.text) { g.fillStyle = '#e9e4d4'; g.fillText(b.text, bx + 18 * u, by + 0.5 * u); }
      bx += b.w + 11 * u;
    }
  }
  g.restore();
}

/**
 * Where a village's plate hangs: its anchor (ax, ay) on the top of the sprite (world px), the leader's length
 * (screen px) and `lean`: how far the plate stands to the side of its anchor (the viewer's own village has its
 * standard on the right: the plate keeps left of the pole).
 */
export function plateAnchor(u, S, k, row = 1) {
  // (`row`: how large the village's row is drawn on a tilted board: what stands there is that much taller on screen)
  const ax = u.x + (u.hero ? HERO.at.x : 0), ay = u.y - villageTop(u) * row;
  const pole = u.hero ? u.x + HERO.standard.x - 8 * k : Infinity;
  return { ax, ay, leader: u.hero ? 14 : 10, lean: Math.min(0, pole - (ax + S.w / 2)) };
}

/** A building going up: a brass ring that fills with the share of the time gone, a hammer in it (screen sized, `k` = 1 / zoom). */
export function paintBuildRing(g, x, y, k, share) {
  if (!g?.save) return;
  const r = 10.5 * k, s = Math.max(0.03, Math.min(1, share ?? 0));
  g.save();
  g.lineCap = 'round';
  g.fillStyle = 'rgba(4,10,9,.3)'; g.beginPath(); g.arc(x, y + 1.5 * k, r + 3 * k, 0, Math.PI * 2); g.fill();
  g.fillStyle = METAL; g.beginPath(); g.arc(x, y, r + 2.5 * k, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(201,162,74,.3)'; g.lineWidth = 3 * k; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = BRASS_HI; g.beginPath(); g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s); g.stroke();
  paintGlyph(g, 'hammer', x, y, r * 1.35, { colour: IVORY, weight: 2 });
  g.restore();
}

/** Where a building going up stands beside village tile `u` (world px), and where its ring floats. */
export function scaffoldAt(u) {
  const x = u.hero ? u.x + HERO.scaffold.x : u.x - RADIUS * 0.44, y = u.hero ? u.y + HERO.scaffold.y : u.y + RADIUS * 0.22;
  return { x, y, ring: { x, y: y - RADIUS * 0.62 }, rise: RADIUS * 0.62 };
}

/** How far above a village tile's centre the top of its plate stands, with nothing nudged (screen px at `zoom`): the page's own chip stands above that. */
export function plateRise(u, zoom, { rows = 2 } = {}) {
  const hero = !!u?.hero;
  return villageTop(u) * zoom * (u?.row ?? 1) + (hero ? 14 : 10) + (hero ? 26 : 24) + (rows > 1 ? 19 : 0);
}

/**
 * The labels of a tile view, in the order of their importance: the viewer's own villages' plates, the other
 * villages' (the nearest to `centre` first), the build rings, then the hosts' pills.
 *   tiles          the tile model's tiles (map/sprites.mjs)
 *   pills          `[{tok, s}]`: the host tokens of the frame
 *   constructions  `[{p, q, site, share}]`
 *   hostsOn        Map "P,Q,tile" → the whole troops of the owner's hosts standing on that village
 *   pass           the frame's label pass
 * Returns how many plates were drawn.
 */
export function paintPlates(g, { tiles = [], pills = [], constructions = [], hostsOn = null, zoom = 1, centre = null, pass = OPEN_PASS, t = 0 } = {}) {
  if (!g?.save) return 0;
  const r = RADIUS * zoom, k = 1 / zoom;
  const key = u => `${u.p},${u.pq},${u.idx}`;
  // the owner's hosts standing on each village: their strength is the plate's second badge (`hostsOn`), not a pill of their own
  const village = new Map();
  for (const u of tiles) if (u.state === 1 && u.owner < 6 && u.site !== undefined && !u.cloud) village.set(key(u), u);
  for (const { tok } of pills) {
    const v = Number.isInteger(tok.tile) ? village.get(`${tok.p},${tok.q},${tok.tile}`) : null;
    if (v && tok.faction === v.owner) tok.onVillage = true;
  }
  const onVillage = hostsOn ?? new Map();
  let list = [...village.values()].filter(u => u.hero || r >= PLATE_ALL_R || (r >= PLATE_MIN_R && u.tier >= 2));
  if (centre) list = list.map(u => ({ u, d: (u.hero ? -1e12 : 0) + (u.x - centre.x) ** 2 + (u.y - centre.y) ** 2 })).sort((a, b) => a.d - b.d).map(x => x.u);
  else list.sort((a, b) => (b.hero ? 1 : 0) - (a.hero ? 1 : 0));
  let n = 0;
  g.save();
  // (a plate that must step aside for the HUD never steps onto the viewer's own village: its sprite is taken first)
  for (const u of list) if (u.hero && !pass.hiddenAt(key(u))) {
    const w = RADIUS * 1.9, top = villageTop(u) * 0.86 * rowScale(g, u.x, u.y);
    pass.block(u.x, u.y, { x: u.x + HERO.at.x - w / 2, y: u.y - top, w, h: top + RADIUS * 0.3 });
  }
  // (nor onto any other village's houses: a plate the dial pushes aside goes beside its village, not down onto it)
  for (const u of list) if (!u.hero && !pass.hiddenAt(key(u))) {
    const w = RADIUS * 0.9, top = villageTop(u) * 0.8 * rowScale(g, u.x, u.y);
    pass.block(u.x, u.y, { x: u.x - w / 2, y: u.y - top, w, h: top + RADIUS * 0.2 });
  }
  for (const u of list) {
    if (n >= PLATE_MAX) break;
    if (pass.hiddenAt(key(u))) continue;
    const sight = u.lv === undefined || u.lv >= 3;
    const m = plateModel({ p: u.p, pq: u.pq, site: u.site, tier: u.tier, provisional: !!u.provisional, shield: u.shield, garrison: sight ? u.garrison ?? null : null, hosts: sight ? onVillage.get(key(u)) ?? 0 : 0 }, { badges: u.hero || r >= PLATE_BADGES_R });
    const S = plateSize(g, m, k, { own: !!u.hero, small: !u.hero && r < PLATE_BADGES_R });
    const { ax, ay, leader, lean } = plateAnchor(u, S, k, rowScale(g, u.x, u.y));
    const at = pass.place(u.x, u.y, { x: ax + lean - S.w / 2, y: ay - leader * k - S.h, w: S.w, h: S.h }, { keep: false, reach: u.hero ? 150 : undefined });
    if (!at) continue;
    // (another village's plate that the HUD pushes down would land on its own houses: a village half under the dial
    // goes without its name rather than wear it. Sideways it may step, and the viewer's own plate always stands)
    if (!u.hero && at.dy > PLATE_DROP * k) continue;
    upright(g, u.x, u.y, () => paintPlate(g, ax, ay, m, S, { k, faction: u.owner, own: !!u.hero, muted: !sight, leader, dx: lean + at.dx, dy: at.dy }));
    n++;
  }
  // a nation's Seat (the camp at the middle of its first province): the nation's sigil and name over it. Its markers
  // are in the nation's colour, and a nation is never told by colour alone
  if (r >= PLATE_ALL_R) for (const u of tiles) {
    if (!u.centre || u.ring !== 1 || u.cloud || (u.lv !== undefined && u.lv < 2) || pass.hiddenAt(key(u))) continue;
    const f = wedgeOf(u.p, u.pq);
    if (!(f >= 0 && f < 6)) continue;
    const m = { name: factionName(f), chips: [], badges: [] }, S = plateSize(g, m, k, { small: true });
    const ax = u.x, ay = u.y - RADIUS * 1.2 * rowScale(g, u.x, u.y);
    const at = pass.place(u.x, u.y, { x: ax - S.w / 2, y: ay - 8 * k - S.h, w: S.w, h: S.h }, { keep: false });
    if (at && at.dy <= PLATE_DROP * k) upright(g, u.x, u.y, () => paintPlate(g, ax, ay, m, S, { k, faction: f, leader: 8, dx: at.dx, dy: at.dy, muted: u.lv !== undefined && u.lv < 3 }));
  }
  // a building going up: its ring on the scaffold
  if (r >= PLATE_MIN_R) for (const c of constructions) {
    const u = tiles.find(x => x.p === c.p && x.pq === c.q && x.site === c.site && x.state === 1);
    if (!u || pass.hiddenAt(key(u)) || (u.lv !== undefined && u.lv < 3)) continue;
    const sc = scaffoldAt(u), at = { x: sc.x, y: sc.y - sc.rise * rowScale(g, u.x, u.y) }, rr = 13 * k;
    const move = pass.place(u.x, u.y, { x: at.x - rr, y: at.y - rr, w: rr * 2, h: rr * 2 }, { free: true });
    if (move) upright(g, u.x, u.y, () => paintBuildRing(g, at.x + move.dx, at.y + move.dy, k, c.share));
  }
  // the hosts' pills: those away from a village of their own nation (a village's plate carries its hosts)
  for (const { tok, s } of pills) {
    if (Number.isInteger(tok.tile) && pass.hiddenAt(`${tok.p},${tok.q},${tok.tile}`)) continue;
    if (tok.onVillage) {
      // (a host that has set out from its village: the faded figure and a seal over it, no number)
      if (tok.status === 'sealed') upright(g, tok.x, tok.y, () => statusMark(g, tok.x - s * 0.36, tok.y - s * 0.78 * rowScale(g, tok.x, tok.y), 7.5 * k, 'sealed', t));
      continue;
    }
    const { w, h } = pillSize(g, k, tok);
    const cy = tok.y - s * 1.08 * rowScale(g, tok.x, tok.y);
    const at = pass.place(tok.x, tok.y, { x: tok.x - w / 2, y: cy - h, w, h }, { keep: !!tok.own, reach: 60 });
    if (!at) continue;
    upright(g, tok.x, tok.y, () => unitPill(g, tok.x + at.dx, cy + at.dy, k, { faction: tok.faction, troops: tok.troops, n: tok.n ?? 1, own: !!tok.own, status: tok.status ?? null, text: tok.text ?? null, t, dashed: !!tok.dashed }));
  }
  g.restore();
  return n;
}
