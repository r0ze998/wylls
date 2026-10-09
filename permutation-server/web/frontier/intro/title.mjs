// The first impression (design session: "no impact, no world when the game
// opens"; UX design 7.1 and 11.9): a title scene the first time a device
// opens the Frontier (and on demand: More → "show the title", ?intro=1 for
// the demo). It is an opaque scene of its own, not a card over the game: a
// picture drawn by code (intro/scene.mjs: the bell's tower large on the chart
// at dusk, the six nations' standards round it, the bell's ring spreading),
// and over its foot the title, one line, one sentence, the six leaders standing; the
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
import { FACTION_FILL, FACTION_DARK, FACTION_MARK, sigilPath } from '../people/avatar.mjs';
import { leaderFigure, LEADERS } from '../people/leaders.mjs';
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
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})"><circle r="9.5" fill="#fffaf0" stroke="${FACTION_DARK[f]}" stroke-width="1.8"/><path d="${sigilPath(f, 5.4)}" fill="${FACTION_MARK[f]}"/></g>`;
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

/** A line cut into its sentences (each keeps its stop and the space after it): a narrow screen breaks the line between them, never inside one. */
export const sentences = text => String(text).match(/[^\u3002.!?]+[\u3002.!?]?\s*/g) ?? [String(text)];

/**
 * The title scene's markup. `mode` 'play' | 'spectate' | 'practice'; `stage` as `ctaText`. The picture is a canvas
 * the page paints (intro/scene.mjs: the bell's tower on the chart at dusk, the six standards round it); over its
 * dark foot stand the wordmark, one line, one sentence of what the game is, the six leaders standing in a row,
 * the live line and the one button. (The second review: the first five seconds showed an emblem and a paragraph,
 * no picture of the game; in English the tagline broke with one orphan word and its ornaments drifted apart.)
 */
export function render({ mode = 'play', live = '', stage = null } = {}) {
  // the six stand in a row and breathe (a still each in reduced motion): the nation's name and its sigil under each
  const leaders = LEADERS.map((l, i) => html`<li class="intro-leader intro-leader-${i}"><span class="intro-fig">${raw(leaderFigure(l.faction, { size: 190 }))}</span><span class="intro-nation"><svg class="intro-sigil" viewBox="-8 -8 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="${sigilPath(l.faction, 6)}" fill="${FACTION_FILL[l.faction]}" stroke="#0a1412" stroke-width="1.2"/></svg>${factionName(l.faction)}</span></li>`);
  return html`<canvas class="intro-scene" aria-hidden="true"></canvas><div class="intro-veil" aria-hidden="true"></div>
    <div class="intro-card">
      <h2 class="intro-title" id="intro-title" data-name>Wylls</h2>
      <p class="intro-tagline"><span class="intro-orn" aria-hidden="true"></span><span class="intro-tag">${sentences(L`六つの国。十分ごとの鐘。封じられた進軍。`).map(x => html`<span class="nowrap">${x.trimEnd()}</span>${/\s$/.test(x) ? ' ' : raw('<wbr>')}`)}</span><span class="intro-orn intro-orn-r" aria-hidden="true"></span></p>
      <p class="intro-lore">${L`十分ごとに鐘が鳴り、封をして送り出した進軍がいっせいに着いて、同じ州の軍勢とぶつかる。`}</p>
      <ol class="intro-leaders">${leaders}</ol>
      ${live ? html`<p class="intro-live"><span class="intro-dot" aria-hidden="true"></span>${live}</p>` : ''}
      <button type="button" class="btn primary intro-go" data-act="intro-close">${ctaText(mode, stage)}${icon('next')}</button>
    </div>`;
}

/** The bell toll's banner: the bell tolled, the turn that begins (the page puts the bell icon beside it). */
export const tollText = bell => L`鐘が鳴りました — ターン ${fmtNum(bell)}`;
