// The wait for the village is a view, not an empty chart (UX brief §7.3,
// §11.10). Between joining a nation and the first village the map shows:
//
//   the home wedge    outlined in the nation's colour (map/chart.mjs
//                     paintWedge), with the nation's standard standing in it
//                     and a tag under the standard: the nation's sigil and
//                     name, and 「あなたの国の土地」
//   the candidates    every site of an open request, numbered and named as
//                     the drawer's list names them (「1 エルウェル」), all of
//                     them in the free part of the picture; a row of that
//                     list flies to its site (`wylls:fly-to`)
//   the countdown     on the first candidate still open, where the village
//                     will be placed unless another request comes first: how
//                     long until the result is due; with no request yet, the
//                     time to the next turn, under the standard
//
// Nothing pretends the village exists: a candidate is a dashed ring and a
// name, and the words say "decided", not "yours". Times come from the page
// (`wait` of the map's source: chain seconds), never from a clock of this
// file. Pure layout first; the painters are context-tolerant.
import { FLATTEN, RADIUS, project } from '../../map.mjs';
import { L, fmtNum, lang } from '../../lang.mjs';
import { tileHex } from '../fgeo.mjs';
import { FACTION_COLORS, factionName } from '../fi18n.mjs';
import { placeName } from '../people/identity.mjs';
import { provincePixel, SIGILS } from './layers.mjs';
import { fxNow } from './chart.mjs';
import { upright } from './tilt.mjs';
import { NATION_INK, NATION_ON } from '../palette.mjs';
import { paintGlyph } from './glyphs.mjs';
import { paintStandard } from './ownland.mjs';
import { OPEN_PASS } from './labelpass.mjs';
import { leaderHexImage, onLeaderArtLoad } from '../people/leaders.mjs';

// (the leader's icon beside the line under the standard: when the picture arrives, the map draws once more)
onLeaderArtLoad(() => { try { globalThis.__wyllsMap?.invalidate?.(); } catch { /* no map on this page */ } });

const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", Georgia, serif';
const SANS = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
const METAL = 'rgba(15,32,29,.94)', BRASS = '#c9a24a', BRASS_HI = '#f0d48a', IVORY = '#f4efe0', INK_2 = '#a9b8b1';
// (the nations' inks and the colour of a mark on each nation's fill: palette.mjs)

/** The standard of the wait view: its height unit is at least this many world px, and never smaller than this many px on screen (it is the hero of an empty land). */
export const WAIT_STANDARD = Object.freeze({ unit: RADIUS * 2.2, screen: 44 });
export const waitUnit = zoom => Math.max(WAIT_STANDARD.unit, WAIT_STANDARD.screen / zoom);

/** Where a candidate site `{p, q, tile}` is (world px): its tile, or its province's middle while the terrain is on its way. */
export function candidatePoint(c) {
  const h = Number.isInteger(c?.tile) ? tileHex(c.p, c.q, c.tile) : null;
  return h ? project(h.q, h.r) : provincePixel(c.p, c.q);
}
/** The name a village on candidate `c` `{p, q, site}` would carry: what the drawer's list says. */
export const candidateName = c => placeName(c.p, c.q, c.site)[lang() === 'en' ? 'en' : 'ja'];
/** A candidate's label on the map: its number in the list and its name (「1 エルウェル」). */
export const candidateLabel = (c, i) => `${fmtNum(i + 1)} ${candidateName(c)}`;

/** The box (world px) around every candidate with room for its ring and label: `{x0, y0, x1, y1}`, or null. */
export function candidatesBox(candidates) {
  const pts = (candidates ?? []).filter(c => Number.isInteger(c?.p) && Number.isInteger(c?.q)).map(candidatePoint);
  if (!pts.length) return null;
  // (room for a site's painted disc, two tiles about it, its ring and its label)
  const m = RADIUS * 3.4;
  return { x0: Math.min(...pts.map(p => p.x)) - m, y0: Math.min(...pts.map(p => p.y)) - m * 0.95, x1: Math.max(...pts.map(p => p.x)) + m, y1: Math.max(...pts.map(p => p.y)) + m * 0.72 };
}

/** Seconds as the dial says them: `9:20`; an hour and more as `1:04:10`. */
export function clockText(secs) {
  const s = Math.max(0, Math.floor(secs)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * What the wait's countdown says. `wait` (the page's): `{now, nextTurnAt, resultAt | null, tollAt | null, share, first | null}` in chain
 * seconds; `first` the index of the candidate tried first. Returns `{text, glyph, at: 'candidate' | 'home', index}`
 * or null when the page gives no times.
 */
export function waitLine(wait) {
  if (!wait || !Number.isFinite(wait.now)) return null;
  if (Number.isFinite(wait.resultAt)) {
    // (the same clock as the drawer's and the dial's: it counts to the bell that decides the village, `tollAt`; the
    // result follows a minute or so after that toll)
    const left = (Number.isFinite(wait.tollAt) ? wait.tollAt : wait.resultAt) - wait.now;
    return { at: 'candidate', index: Number.isInteger(wait.first) ? wait.first : 0, glyph: 'bell', share: Number.isFinite(wait.share) ? wait.share : null, text: left > 0 ? L`村が決まる鐘まで ${clockText(Math.ceil(left))}` : L`まもなく村が決まります` };
  }
  if (Number.isFinite(wait.nextTurnAt)) return { at: 'home', index: null, glyph: 'bell', text: L`次のターンまで ${clockText(Math.max(0, wait.nextTurnAt - wait.now))}` };
  return null;
}

/**
 * The nation's words under its standard while the viewer waits (UX brief §11.10, §13): one line that says what the
 * wait is for. They are the nation's own words, with no named speaker (no leader names or titles: DECISIONS ZP3).
 * `state`: 'ticket' with a request in, else the request is still on its way. The line claims nothing that has not
 * happened. `{text}` or null without a nation.
 */
export function nationWords(faction, state = null) {
  if (!(Number.isInteger(faction) && faction >= 0 && faction < 6)) return null;
  return { text: state === 'ticket' ? L`村の場所はもうすぐ決まる。待つあいだに、戦い方を確かめておこう。` : L`まずは村の申し込みだ。通りしだい、候補地が地図に並ぶ。` };
}
/** (the name the map still asks by) */
export const leaderWords = nationWords;

/**
 * The surveyors' lines of the wait (UX brief §11.10: the wait is a view, something to look at): from the standard to
 * every candidate site, a thin dashed line of sepia ink with a small station mark at its end, as a chart has them
 * before the land is measured. The dashes drift slowly toward the sites. Decoration on the chart: it says nothing
 * that is not on the page already (these are the sites of the request).
 */
export function paintSurveyLines(g, from, candidates, { zoom = 1, now = fxNow(), still = false } = {}) {
  if (!from || !candidates?.length || !g?.save || RADIUS * zoom < 9) return 0;
  const k = 1 / zoom, drift = still ? 0 : (now / 1000) * 9;
  let n = 0;
  g.save();
  g.lineCap = 'round';
  for (const c of candidates) {
    if (!Number.isInteger(c?.p) || !Number.isInteger(c?.q)) continue;
    const to = candidatePoint(c), dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
    if (!(len > RADIUS * 2)) continue;
    const ux = dx / len, uy = dy / len, a = RADIUS * 0.9, b = len - RADIUS * 1.25;
    const x0 = from.x + ux * a, y0 = from.y + uy * a, x1 = from.x + ux * b, y1 = from.y + uy * b;
    g.setLineDash([]); g.strokeStyle = 'rgba(244,236,214,.55)'; g.lineWidth = 3.4 * k; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.setLineDash([9 * k, 6 * k]); g.lineDashOffset = -drift * k;
    g.strokeStyle = 'rgba(86,66,34,.78)'; g.lineWidth = 1.5 * k; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.setLineDash([]);
    // a station mark where the line reaches the site's ring: a small circle with a dot
    g.fillStyle = 'rgba(244,236,214,.9)'; g.strokeStyle = 'rgba(86,66,34,.85)'; g.lineWidth = 1.3 * k;
    g.beginPath(); g.arc(x1, y1, 3.6 * k, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = 'rgba(86,66,34,.9)'; g.beginPath(); g.arc(x1, y1, 1.1 * k, 0, Math.PI * 2); g.fill();
    n++;
  }
  g.restore();
  return n;
}

function sigil(g, shape, x, y, r) {
  const pts = n => Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [x + Math.cos(a) * r, y + Math.sin(a) * r]; });
  g.beginPath();
  if (shape === 'circle' || shape === 'ring') g.arc(x, y, r * 0.86, 0, Math.PI * 2);
  else if (shape === 'cross') { const w = r * 0.36; [[-w, -r], [w, -r], [w, -w], [r, -w], [r, w], [w, w], [w, r], [-w, r], [-w, w], [-r, w], [-r, -w], [-w, -w]].forEach(([px, py], i) => (i ? g.lineTo(x + px, y + py) : g.moveTo(x + px, y + py))); g.closePath(); }
  else { const c = shape === 'triangle' ? pts(3) : shape === 'square' ? pts(4).map(([px, py]) => [x + ((px - x) - (py - y)) * 0.62, y + ((py - y) + (px - x)) * 0.62]) : shape === 'diamond' ? pts(4) : pts(6); c.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); }
}

/** Break `text` into lines no wider than `width` (the context's font set; Japanese breaks anywhere but before a closing mark, English at spaces). */
export function wrapText(g, text, width, size = 13) {
  const wide = t => g.measureText?.(t)?.width ?? t.length * size * 0.6;
  const words = /\s/.test(text.trim()) && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(text) ? text.split(/(?<=\s)/) : [...text];
  const out = [];
  let cur = '';
  for (const w of words) {
    if (cur && wide(cur + w) > width && !/^[\u3001\u3002\u300d\uff09,.!?)]/.test(w)) { out.push(cur.trimEnd()); cur = w; }
    else cur += w;
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

/** A line with an icon on a small plate of bell metal (the countdown): centred on (x, top + h / 2); returns its box (world px). */
function chip(g, x, top, text, k, { glyph = null, rim = BRASS, ink = IVORY, size = 12.5 } = {}) {
  g.font = `700 ${size * k}px ${SANS}`; g.textAlign = 'left'; g.textBaseline = 'middle';
  const tw = g.measureText?.(text)?.width ?? text.length * size * k * 0.6, ic = glyph ? 17 * k : 0, h = 24 * k, w = tw + ic + 20 * k;
  g.fillStyle = 'rgba(4,10,9,.3)'; g.beginPath(); g.roundRect?.(x - w / 2, top + 2 * k, w, h, h / 2); g.fill();
  g.fillStyle = METAL; g.beginPath(); g.roundRect?.(x - w / 2, top, w, h, h / 2); g.fill();
  g.strokeStyle = rim; g.lineWidth = 1 * k; g.stroke();
  if (glyph) paintGlyph(g, glyph, x - w / 2 + 10 * k + 7 * k, top + h / 2, 14 * k, { colour: BRASS_HI, weight: 2 });
  g.fillStyle = ink; g.fillText(text, x - w / 2 + 10 * k + ic, top + h / 2 + 0.5 * k);
  return { x: x - w / 2, y: top, w, h };
}

/** The box of the standard's pole and cloth for a foot at `at` (world px at `zoom`): labels keep clear of it. */
export function standardBox(at, zoom) {
  const u = waitUnit(zoom);
  return { x: at.x - u * 0.08, y: at.y - u * 1.62, w: u * 1.1, h: u * 1.62 };
}

/** The standard of the nation in its home wedge, on the board (under the labels): its foot at `at`. */
export function paintWaitStandard(g, at, { zoom = 1, faction = 0, now = fxNow(), still = false } = {}) {
  if (!at || !g?.save) return;
  paintStandard(g, at.x, at.y, { u: waitUnit(zoom), zoom, faction, now, still });
}

/**
 * The tag under the standard: the nation's sigil and name in the serif, 「あなたの国の土地」 under it, and (with no
 * request yet) the time to the next turn. `at`: the standard's foot (world px). Returns the boxes drawn.
 */
export function paintHomeTag(g, at, { zoom = 1, faction = 0, line = null, pass = OPEN_PASS, keep = true, say = null } = {}) {
  if (!at || !g?.save) return null;
  const k = 1 / zoom, name = factionName(faction), caption = L`あなたの国の土地`;
  g.save();
  g.font = `700 ${19 * k}px ${SERIF}`;
  const nw = g.measureText?.(name)?.width ?? name.length * 19 * k;
  g.font = `600 ${12.5 * k}px ${SANS}`;
  const cw = g.measureText?.(caption)?.width ?? caption.length * 12.5 * k;
  // the nation's words, under the caption: in the serif, on three lines at most (no speaker is named)
  const sayW = 238 * k;
  g.font = `600 ${13 * k}px ${SERIF}`;
  let lines = say?.text ? wrapText(g, L`「${say.text}」`, sayW, 13 * k).slice(0, 3) : [];
  const sig = 20 * k, extra = line?.at === 'home' ? 30 * k : 0, top = at.y + 12 * k;
  // (beside the line stands the nation's character: the hexagon icon, 36 px on the board, which is 30 px or more on the screen
  // at the tilt's far rows; below that the face is a blot of colour. Its place is kept whether or not the picture has come)
  const faceW = 36 * k, faceGap = 9 * k;
  const sizeOf = n => ({ w: Math.max(sig + 8 * k + nw, cw, n ? sayW + faceW + faceGap : 0) + 28 * k, h: 58 * k + (n ? (Math.max(2, n) * 19 + 12) * k : 0) });
  // where it may stand: under the standard, else beside its pole (left, then right of its cloth); with the leader's
  // line while there is room for that, else the name and the caption alone
  // (`keep` false: with candidate sites to read, the tag is left out where it has no room at all)
  let move = null, w = 0, h = 0;
  for (const n of lines.length ? [lines.length, 0] : [0]) {
    ({ w, h } = sizeOf(n));
    const u = waitUnit(zoom), spots = [[0, 0], [-(w / 2 + u * 0.16), -(h + 12 * k + u * 0.2)], [w / 2 + u * 1.1, -(h + 12 * k + u * 0.2)]];
    for (const [ox, oy] of spots) {
      const m = pass.place(at.x, at.y, { x: at.x - w / 2 + ox, y: top + oy, w, h: h + extra }, { keep: false, reach: 40 });
      if (m) { move = { dx: m.dx + ox, dy: m.dy + oy }; break; }
    }
    if (move) { if (!n) lines = []; break; }
  }
  if (!move && keep) { lines = []; ({ w, h } = sizeOf(0)); move = pass.place(at.x, at.y, { x: at.x - w / 2, y: top, w, h: h + extra }, { keep: true }); }
  if (!move) { g.restore(); return null; }
  upright(g, at.x, at.y, () => {
    const x = at.x + move.dx, y = top + move.dy;
    g.lineJoin = 'round';
    g.fillStyle = 'rgba(4,10,9,.32)'; g.beginPath(); g.roundRect?.(x - w / 2, y + 2 * k, w, h, 9 * k); g.fill();
    g.fillStyle = METAL; g.beginPath(); g.roundRect?.(x - w / 2, y, w, h, 9 * k); g.fill();
    g.strokeStyle = BRASS; g.lineWidth = 1 * k; g.stroke();
    g.strokeStyle = 'rgba(255,248,224,.16)'; g.beginPath(); g.moveTo(x - w / 2 + 9 * k, y + 1.5 * k); g.lineTo(x + w / 2 - 9 * k, y + 1.5 * k); g.stroke();
    // the sigil on the nation's colour, then its name
    const row = y + 20 * k, x0 = x - (sig + 8 * k + nw) / 2;
    g.beginPath(); g.arc(x0 + sig / 2, row, sig / 2, 0, Math.PI * 2); g.fillStyle = FACTION_COLORS[faction] ?? '#8a8f86'; g.fill(); g.strokeStyle = NATION_INK[faction] ?? '#3a3a34'; g.lineWidth = 1 * k; g.stroke();
    const shape = SIGILS[faction] ?? 'ring';
    sigil(g, shape, x0 + sig / 2, row, sig * 0.3);
    if (shape === 'ring') { g.strokeStyle = '#fff6e2'; g.lineWidth = 1.8 * k; g.stroke(); } else { g.fillStyle = NATION_ON[faction] ?? '#fff6e2'; g.fill(); }
    g.font = `700 ${19 * k}px ${SERIF}`; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = '#fff3cf'; g.fillText(name, x0 + sig + 8 * k, row + 0.5 * k);
    // a hair of brass, then the caption
    g.strokeStyle = 'rgba(201,162,74,.5)'; g.lineWidth = 1 * k; g.beginPath(); g.moveTo(x - w / 2 + 14 * k, y + 35 * k); g.lineTo(x + w / 2 - 14 * k, y + 35 * k); g.stroke();
    g.font = `600 ${12.5 * k}px ${SANS}`; g.textAlign = 'center';
    g.fillStyle = INK_2; g.fillText(caption, x, y + 46 * k);
    if (lines.length) {
      g.strokeStyle = 'rgba(201,162,74,.3)'; g.lineWidth = 1 * k; g.beginPath(); g.moveTo(x - w / 2 + 14 * k, y + 58 * k); g.lineTo(x + w / 2 - 14 * k, y + 58 * k); g.stroke();
      // the words stand to the right of the face, centred in what is left of the tag
      const rows = Math.max(2, lines.length), tx = x + (faceW + faceGap) / 2, pad = (rows - lines.length) * 19 / 2;
      g.font = `600 ${13 * k}px ${SERIF}`; g.textAlign = 'center'; g.fillStyle = IVORY;
      lines.forEach((t, i) => g.fillText(t, tx, y + (72 + pad + i * 19) * k));
      // the nation's character at the line's left (nothing until the picture has loaded)
      const face = leaderHexImage(faction);
      if (face && g.drawImage) { g.imageSmoothingQuality = 'high'; g.drawImage(face, x - w / 2 + 12 * k, y + (62 + (rows * 19 + 4) / 2) * k - faceW / 2, faceW, faceW); }
    }
    if (extra) chip(g, x, y + h + 6 * k, line.text, k, { glyph: line.glyph });
  });
  g.restore();
  return { x: at.x - w / 2, y: top, w, h: h + extra };
}

/**
 * The candidates' words: on each site its number and name on a small plate above its ring, and on the one tried
 * first the countdown under the ring. `candidates` `[{p, q, site, tile}]` in the list's order.
 */
export function paintCandidateLabels(g, candidates, { zoom = 1, line = null, pass = OPEN_PASS } = {}) {
  if (!candidates?.length || !g?.save || RADIUS * zoom < 9) return 0;
  const k = 1 / zoom;
  let n = 0, due = null;
  g.save();
  // (no word is moved onto a site's own ring: the rings are taken first)
  for (const c of candidates) {
    if (!Number.isInteger(c?.p) || !Number.isInteger(c?.q)) continue;
    const at = candidatePoint(c), rx = Math.max(RADIUS * 0.92, 15 * k);
    pass.block(at.x, at.y, { x: at.x - rx, y: at.y - rx * FLATTEN, w: rx * 2, h: rx * 2 * FLATTEN });
  }
  candidates.forEach((c, i) => {
    if (!Number.isInteger(c?.p) || !Number.isInteger(c?.q)) return;
    const at = candidatePoint(c), ry = Math.max(RADIUS * 0.92, 15 * k) * FLATTEN;
    const first = line?.at === 'candidate' && line.index === i;
    const name = candidateName(c), num = fmtNum(i + 1);
    g.font = `700 ${14 * k}px ${SERIF}`;
    const nw = g.measureText?.(name)?.width ?? name.length * 14 * k;
    const d = 18 * k, w = d + 7 * k + nw + 18 * k, h = 26 * k, top = at.y - ry - 9 * k - h;
    const move = pass.place(at.x, at.y, { x: at.x - w / 2, y: top, w, h }, { keep: true });
    upright(g, at.x, at.y, () => {
      const x = at.x + move.dx, y = top + move.dy;
      // a short brass leader down to the ring
      g.strokeStyle = 'rgba(10,20,18,.6)'; g.lineWidth = 2.6 * k; g.beginPath(); g.moveTo(x, y + h); g.lineTo(at.x, at.y - ry); g.stroke();
      g.strokeStyle = first ? BRASS_HI : BRASS; g.lineWidth = 1 * k; g.beginPath(); g.moveTo(x, y + h); g.lineTo(at.x, at.y - ry); g.stroke();
      g.fillStyle = 'rgba(4,10,9,.32)'; g.beginPath(); g.roundRect?.(x - w / 2, y + 2 * k, w, h, 8 * k); g.fill();
      g.fillStyle = METAL; g.beginPath(); g.roundRect?.(x - w / 2, y, w, h, 8 * k); g.fill();
      g.strokeStyle = first ? BRASS_HI : BRASS; g.lineWidth = (first ? 1.4 : 1) * k; g.stroke();
      // the number of the list, on brass
      const cx = x - w / 2 + 9 * k + d / 2, cy = y + h / 2;
      g.beginPath(); g.arc(cx, cy, d / 2, 0, Math.PI * 2); g.fillStyle = first ? BRASS_HI : BRASS; g.fill();
      g.font = `700 ${13 * k}px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#152522'; g.fillText(num, cx, cy + 0.5 * k);
      g.font = `700 ${14 * k}px ${SERIF}`; g.textAlign = 'left';
      g.fillStyle = IVORY; g.fillText(name, cx + d / 2 + 7 * k, cy + 0.5 * k);
    });
    if (first) due = { at, ry };
    n++;
  });
  // the countdown, under the ring of the site tried first: after the names, and left out where they leave it no room
  // (the page's own drawer says the same time)
  if (due) {
    const { at, ry } = due, cy = at.y + ry + 8 * k;
    g.font = `700 ${12.5 * k}px ${SANS}`;
    const tw = (g.measureText?.(line.text)?.width ?? line.text.length * 8 * k) + 37 * k;
    const mv = pass.place(at.x, at.y, { x: at.x - tw / 2, y: cy, w: tw, h: 24 * k }, { keep: false, reach: 60 });
    if (mv) upright(g, at.x, at.y, () => chip(g, at.x + mv.dx, cy + mv.dy, line.text, k, { glyph: line.glyph, rim: BRASS_HI }));
  }
  g.restore();
  return n;
}
