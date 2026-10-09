// The six characters, one for each nation: the look of every player of that
// nation (people and AI citizens alike, with no mark), and the one way their
// pictures reach a screen. The pictures are the owner's six characters
// (people/leader-art.mjs says where each file is):
//
//   0 Aster    · A Wardens of Stone — red coat, gold epaulettes
//   1 Borealis · B Tide              — sky-cyan coat and hood, brass mask and goggles
//   2 Cinder   · C Flame             — yellow cape over bronze plate, grey hair and beard
//   3 Dunmar   · D Verdant           — purple hooded mantle, a silver circlet
//   4 Ember    · E Lumen             — white surveyor's coat, white hair, goggles at the collar
//   5 Fjordal  · F Iron              — orange coat with a white fur collar, chestnut hair
//
// The six are the players (owner decision of 2026-10-09, DECISIONS ZP1): a
// character has no name and no title of its own; choosing a nation is
// choosing your character, and a player's own name stays the player's. A
// nation is shown by its name, its sigil, its doctrine and its character.
// ("leader" in the names of these files and functions is from the day the
// six were drawn as the nations' leaders: it now reads "a nation's character".)
//
//   leaderSvg(f, {size})      the character at any size: the hexagon icon up to 64 px, above that the
//                             portrait card (the bust before a cloth of the nation's colour, 4 : 5)
//   leaderHex(f, {size})      the hexagon icon (people/leader-art.mjs)
//   leaderFigure(f, {motion}) the character standing, breathing where motion is allowed (people/leader-sprite.mjs)
//   playerFace(f, {size, own}) a player's face: that player's nation's character (people/faces.mjs)
//
// Markup carries attributes only (no style: the page's CSP). The flat
// vector busts this file used to draw are gone from every screen.
import { L } from '../../lang.mjs';
import { sigilPath, shade } from './avatar.mjs';
import { NATION_FILL, NATION_DEEP, NATION_ON } from '../palette.mjs';
import { leaderHex, leaderKey, leaderPortraitUrl, artImage } from './leader-art.mjs';

export { leaderHex, leaderKey, leaderHexUrl, leaderPortraitUrl, leaderStillUrl, leaderStageUrl, leaderHexImage, onLeaderArtLoad, STAGE_CELL, STAGE_CLIPS } from './leader-art.mjs';
export { leaderFigure, startLeaderSprites } from './leader-sprite.mjs';

/** The six characters in faction order: `{faction, key}` (the file key of the nation's pictures). No names, no titles. */
export const CHARACTERS = Object.freeze([0, 1, 2, 3, 4, 5].map(faction => Object.freeze({ faction, key: leaderKey(faction) })));

/** One-line doctrine pitch per faction (join cards, standings). */
export const DOCTRINE_PITCH = Object.freeze([
  () => L`城壁が安く、長槍兵は迎撃に強い。本拠を落とすには時間がかかる。`,
  () => L`隊商が速く、軽騎兵で動き回る。街道の道標を多く持てる。`,
  () => L`到着したターンの一撃が重い突撃歩兵。角笛で戦を告げる。`,
  () => L`補給の消耗が半分。側撃に強い森番が遠くまで行く。`,
  () => L`進軍が速い。工兵が道を倍に延ばし、探索で周りも見える。`,
  () => L`兵の維持費が安い重騎兵。奪った自由都市は城壁を残す。`,
]);

/** Up to this many CSS px a portrait is the hexagon icon (drawn for 64 and 128 px); above it, the portrait card. */
export const HEX_UP_TO = 64;

/**
 * The portrait card (viewBox 240 × 300), in the language of the hexagon icons: the bust from the latest model on a
 * deep ground of the nation's dye with a brighter halo behind the head, in a rim of the nation's colour with a
 * charcoal edge and a fine gold bevel, the sigil badge at the corner. Until the picture has loaded the ground and
 * the sigil stand alone (no flat stand-in face).
 */
function portraitCard(f, { size, a11y }) {
  const fill = NATION_FILL[f], deep = NATION_DEEP[f], id = `L${f}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300" width="${size}" height="${Math.round(size * 1.25)}" class="leader leader-card-art" data-leader="${leaderKey(f)}" ${a11y}>
    <defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(deep, 0.1)}"/><stop offset="1" stop-color="${shade(deep, -0.42)}"/></linearGradient>
    <radialGradient id="${id}l" cx=".5" cy=".36" r=".62"><stop offset="0" stop-color="${fill}" stop-opacity=".62"/><stop offset=".6" stop-color="${fill}" stop-opacity=".16"/><stop offset="1" stop-color="${fill}" stop-opacity="0"/></radialGradient>
    <clipPath id="${id}c"><rect x="8" y="8" width="224" height="284" rx="12"/></clipPath></defs>
    <rect x="1.5" y="1.5" width="237" height="297" rx="18" fill="#14110a"/>
    <g clip-path="url(#${id}c)"><rect width="240" height="300" fill="url(#${id}g)"/><rect width="240" height="300" fill="url(#${id}l)"/>
    <path d="M0 300 L120 150 L240 300 Z M0 0 L70 0 L0 110 Z M240 0 L170 0 L240 110 Z" fill="#fff" opacity=".035"/>
    ${artImage(leaderPortraitUrl(f), 'x="-30" y="4" width="300" height="300" preserveAspectRatio="xMidYMid slice"')}</g>
    <rect x="6" y="6" width="228" height="288" rx="14" fill="none" stroke="${fill}" stroke-width="7"/><rect x="10.2" y="10.2" width="219.6" height="279.6" rx="10.5" fill="none" stroke="#f0d48a" stroke-width="1.5" opacity=".9"/>
    <g transform="translate(206 34)"><circle r="20" fill="${fill}" stroke="#14110a" stroke-width="3.5"/><circle r="17.6" fill="none" stroke="#f0d48a" stroke-width="1.6"/><path d="${sigilPath(f, 10.5)}" fill="${NATION_ON[f]}"/></g>
  </svg>`;
}

/**
 * A nation's character as inline SVG markup, `size` px wide: the hexagon icon (square) up to `HEX_UP_TO` px, the
 * portrait card (height 1.25 ×) above it; `shape: 'hex' | 'card'` asks for one of them at any size. Decorative
 * (beside the nation's or the player's name) unless `title` names it. An invalid faction reads as Aster.
 */
export function leaderSvg(faction, { size = 160, title = null, shape = 'auto', sigil = false } = {}) {
  const f = Number.isInteger(faction) && faction >= 0 && faction < 6 ? faction : 0;
  if (shape === 'hex' || (shape !== 'card' && size <= HEX_UP_TO)) return leaderHex(f, { size, title, sigil });
  const a11y = title ? `role="img" aria-label="${String(title).replace(/[<>&"]/g, '')}"` : 'aria-hidden="true" focusable="false"';
  return portraitCard(f, { size, a11y });
}
