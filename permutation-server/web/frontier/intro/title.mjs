// The first impression (design session: "no impact, no world when the game
// opens"; UX design 7.1 and 11.9): a title scene the first time a device
// opens the Frontier (and on demand: More → "show the title", ?intro=1 for
// the demo). It is an opaque scene of its own, not a card over the game: the
// frontier's rings drawn in brass on bell metal, the Engine's bell with the
// six sigils, the title, the six leaders and three lines of the world; the
// live line says the season is real ("Season 7 · turn 1,034 · 1,055
// villages"). Nothing of the game behind it shows or can be reached until
// its one button is pressed (app.mjs: the page is marked `data-title="up"`,
// the nation choice does not open, the dock and the map are inert). The
// button says where it leads for this viewer: choose a nation, back to the
// village, or into the Frontier (the spectator and practice pages: start
// watching, start practising). Escape, Enter or the button close it. The
// page loads underneath, so the game is there the moment it closes.
//
// Also here: the bell toll's words — when a bell turns, its turn's number
// rings across the top of the map for a moment.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { FACTION_FILL, FACTION_DARK, sigilPath } from '../people/avatar.mjs';
import { leaderSvg, LEADERS } from '../people/leaders.mjs';
import { icon } from '../hud/icons.mjs';

export const INTRO_KEY = 'ps-fintro:v1';
/** The leaders appear one by one (ms apart) after the title. */
export const LEADER_STAGGER_MS = 220;

/** Whether the title should open: never seen on this device, or asked for. */
export function shouldOpen({ storage, search = '' } = {}) {
  const q = new URLSearchParams(search);
  if (q.get('intro') === '1') return true;
  if (q.get('intro') === '0') return false;
  try { return !storage?.getItem(INTRO_KEY); } catch { return false; }
}
export function markSeen(storage) { try { storage?.setItem(INTRO_KEY, '1'); } catch { /* private mode */ } }

/**
 * The Frontier's emblem: the six sigils on a ring around the bell (SVG).
 * `size` px; decorative unless `title` is given.
 */
export function emblemSvg({ size = 96, title = null } = {}) {
  const a11y = title ? `role="img" aria-label="${String(title).replace(/[<>&"]/g, '')}"` : 'aria-hidden="true" focusable="false"';
  const ring = Array.from({ length: 6 }, (_, f) => {
    const a = -Math.PI / 2 + (f * Math.PI) / 3, x = 50 + Math.cos(a) * 34, y = 50 + Math.sin(a) * 34;
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})"><circle r="9.5" fill="#fffaf0" stroke="${FACTION_DARK[f]}" stroke-width="1.8"/><path d="${sigilPath(f, 5.4)}" fill="${FACTION_FILL[f]}"/></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" class="emblem" ${a11y}>
    <circle cx="50" cy="50" r="46" fill="none" stroke="#d9b44a" stroke-width="1.4" opacity=".85"/>
    <circle cx="50" cy="50" r="34" fill="none" stroke="#d9b44a" stroke-width="0.8" stroke-dasharray="2 3" opacity=".7"/>
    <path d="M50 30 C41 30 38 38 38 46 L37 56 L33 61 L67 61 L63 56 L62 46 C62 38 59 30 50 30 Z" fill="#d9b44a" stroke="#7a5a14" stroke-width="1.4"/>
    <path d="M44 62 C44 66 56 66 56 62 Z" fill="#7a5a14"/><circle cx="50" cy="27.5" r="2.6" fill="#7a5a14"/>
    ${ring}
  </svg>`;
}

/** The live line: season, turn, villages and nations (from what the page already has). */
export function liveLine({ seasonId = null, bell = null, holdings = 0, factions = 6 } = {}) {
  const parts = [];
  if (seasonId !== null && seasonId !== undefined) parts.push(L`第${fmtNum(Number(seasonId))}季`);
  if (Number.isInteger(bell)) parts.push(L`ターン ${fmtNum(bell)}`);
  if (holdings > 0) parts.push(L`${fmtNum(holdings)} の村`);
  parts.push(L`${fmtNum(factions)} つの国`);
  return parts.join(' · ');
}

/**
 * The scene's backdrop, drawn here (no picture file): the frontier as it
 * grows — rings of province hexes around the Concord, each nation's wedge
 * in a breath of its colour — and the bell's rings spreading over it, in
 * thin brass on bell metal. Decorative; presentation attributes only (the
 * page's CSP allows no style attribute). A whole SVG document: it is used
 * as an image (`sceneUrl`).
 */
export function sceneSvg() {
  const { width: W, height: H, cx, cy } = SCENE, R = 62, RINGS = 5;
  const corner = (x, y, i) => `${(x + Math.cos(Math.PI / 6 + (i * Math.PI) / 3) * R).toFixed(1)} ${(y + Math.sin(Math.PI / 6 + (i * Math.PI) / 3) * R).toFixed(1)}`;
  const hexes = [];
  for (let q = -RINGS; q <= RINGS; q++) for (let r = Math.max(-RINGS, -q - RINGS); r <= Math.min(RINGS, -q + RINGS); r++) {
    const d = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    const x = cx + R * Math.sqrt(3) * (q + r / 2), y = cy + R * 1.5 * r;
    const path = `M${Array.from({ length: 6 }, (_, i) => corner(x, y, i)).join('L')}Z`;
    if (d === 0) { hexes.push(`<path d="${path}" fill="#c9a24a" fill-opacity=".1" stroke="#f0d48a" stroke-opacity=".5" stroke-width="1.4"/>`); continue; }
    // the wedge of the nation whose sigil stands at that side of the emblem (the first at the top, then clockwise)
    const turn = ((Math.atan2(y - cy, x - cx) * 180) / Math.PI + 90 + 30 + 360) % 360;
    const f = Math.floor(turn / 60) % 6;
    const fade = Math.max(0, 1 - (d - 1) / RINGS);
    hexes.push(`<path d="${path}" fill="${FACTION_FILL[f]}" fill-opacity="${(0.04 + 0.15 * fade).toFixed(3)}" stroke="#d9b862" stroke-opacity="${(0.06 + 0.26 * fade).toFixed(3)}" stroke-width="1"/>`);
  }
  const tolls = [150, 250, 370, 510, 670, 850, 1050].map((r, i) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f0d48a" stroke-opacity="${(0.34 - i * 0.042).toFixed(3)}" stroke-width="${i < 2 ? 1.4 : 1}"${i % 2 ? ' stroke-dasharray="2 7"' : ''}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><g>${hexes.join('')}</g><g>${tolls}</g></svg>`;
}
/** Where the bell stands in the art (the stylesheet puts this point on the emblem's centre), and the art's size. */
export const SCENE = Object.freeze({ width: 1600, height: 1000, cx: 800, cy: 318 });
/**
 * The art as a CSS image (a data: URL of the SVG; the page's CSP allows `img-src data:`): the page hands it to the
 * stylesheet through `--intro-art` on the title's element, and the scene paints it as a background — a picture, not
 * markup, so it never takes the pointer and never counts as content beyond the screen's edge.
 */
export const sceneUrl = () => `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(sceneSvg())}")`;

/**
 * The button's words: where it leads for this viewer. `stage` is the
 * viewer's stage on the game page once it is known ('none' | 'joined' |
 * 'ticket' | 'refugee' | 'provisional' | 'final'), null before.
 */
export function ctaText(mode = 'play', stage = null) {
  if (mode === 'spectate') return L`観戦をはじめる`;
  if (mode === 'practice') return L`練習をはじめる`;
  if (stage === 'none') return L`国を選ぶ`;
  if (stage === 'provisional' || stage === 'final') return L`村へ戻る`;
  if (stage) return L`辺境へ戻る`;
  return L`辺境へ入る`;
}

/** The title scene's markup. `mode` 'play' | 'spectate' | 'practice'; `stage` as `ctaText`. */
export function render({ mode = 'play', live = '', stage = null } = {}) {
  const leaders = LEADERS.map((l, i) => html`<li class="intro-leader intro-leader-${i}">${raw(leaderSvg(l.faction, { size: 80 }))}<span>${factionName(l.faction)}</span></li>`);
  return html`<div class="intro-veil" aria-hidden="true"></div>
    <div class="intro-card">
      <div class="intro-emblem"><span class="intro-toll" aria-hidden="true"></span>${raw(emblemSvg({ size: 132 }))}</div>
      <h2 class="intro-title" id="intro-title" data-name>Wylls</h2>
      <p class="intro-tagline">${L`六つの国。十分ごとの鐘。封じられた進軍。`}</p>
      <ol class="intro-leaders">${leaders}</ol>
      <div class="intro-lore">
        <p>${L`大協約の鐘を中心に、六つの国が辺境へ広がっていく。`}</p>
        <p>${L`十分ごとに鐘が鳴る。進軍は封をして送り出され、行き先を知るのは送った者だけ。`}</p>
        <p>${L`鐘が鳴ると、同じ州に着いた軍勢がいっせいにぶつかる。人が増えれば、雲海の向こうに新しい輪がひらく。`}</p>
      </div>
      ${live ? html`<p class="intro-live"><span class="intro-dot" aria-hidden="true"></span>${live}</p>` : ''}
      <button type="button" class="btn primary intro-go" data-act="intro-close">${ctaText(mode, stage)}${icon('next')}</button>
    </div>`;
}

/** The bell toll's banner: the bell tolled, the turn that begins (the page puts the bell icon beside it). */
export const tollText = bell => L`鐘が鳴りました — ターン ${fmtNum(bell)}`;
