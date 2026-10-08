// Explore (web design §7.5; contract §5.10 Explore/SettleExplore, I-56): a
// Scout host picks one or two passable tiles next to it that nobody has
// explored; the finds are rolled from the bell's seed (≈ 11–21 minutes
// later). The first three explorations of a citizen always give Works; the
// rest do with chance ½ (M1 has no goods). The result is usually settled
// for the player; the page offers the settle button once the seed exists.
// The targets are the six tiles around the scout, so the card shows them as
// they lie on the map (east, north-east, …), never as tile numbers.
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum } from '../../lang.mjs';
import { exploreTargets, ticketTimes } from '../fland.mjs';
import { DIRECTIONS, TILE_OFFSETS } from '../fgeo.mjs';
import { timeHtml } from './shell.mjs';
import { icon } from '../hud/icons.mjs';
import { cardHead, chip, ring } from './parts.mjs';

/** Up to two chosen tiles. */
export const toggleTile = (chosen, tile) => (chosen.includes(tile) ? chosen.filter(t => t !== tile) : chosen.length < 2 ? [...chosen, tile] : chosen);

/** The six directions' names, in fgeo's order (E, NE, NW, W, SW, SE). */
const DIR_TEXT = [() => L`東`, () => L`北東`, () => L`北西`, () => L`西`, () => L`南西`, () => L`南東`];

/** The direction (0–5, fgeo DIRECTIONS) from tile `from` to its neighbour `to` in one province, or -1. */
export function directionOf(from, to) {
  const a = TILE_OFFSETS[from], b = TILE_OFFSETS[to];
  return a && b ? DIRECTIONS.findIndex(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r) : -1;
}

/** The targets around the scout as a rose of six hexes: the ones that can be explored are buttons. */
function rose(host, targets, chosen) {
  const at = new Map(targets.map(t => [directionOf(host.tile, t), t]));
  return html`<div class="rose" role="group" aria-label="${L`探索する場所（2つまで）`}"><span class="rose-hex rose-c" aria-hidden="true">${icon('scout')}</span>
    ${DIR_TEXT.map((name, d) => (at.has(d)
      ? html`<button type="button" class="rose-hex rose-d${d}" data-act="explore-tile" data-tile="${at.get(d)}" aria-pressed="${chosen.includes(at.get(d)) ? 'true' : 'false'}">${name()}</button>`
      : html`<span class="rose-hex rose-d${d} rose-off" aria-hidden="true"></span>`))}</div>`;
}

export function render(FS) {
  const h = activeHolding(FS);
  const rec = h?.explore;
  const floor = FS.citizen?.exploresFloorLeft ?? 0;
  const pending = rec && rec.state !== 0;
  const draft = FS.explore;
  let targets = [];
  if (draft?.host) targets = exploreTargets(draft.host.province, draft.host);
  const times = pending && FS.clock ? ticketTimes(FS.clock, rec.bell) : null;
  return html`<section class="vcard" aria-labelledby="explore-title">
    ${cardHead({ id: 'explore-title', ic: 'scout', title: L`探索`, side: pending ? chip(L`結果待ち`, 'info') : '' })}
    ${pending ? html`<div class="wait-row">${ring(FS.exploreSeedReady ? 1 : null)}<p>${L`探索の結果を待っています。`}${times ? html` ${Lh`結果は ${timeHtml(times.resultAbout)} ごろに出ます。`}` : ''}</p></div>
      <div class="actions"><button type="button" class="btn${FS.exploreSeedReady ? ' primary' : ''}" data-act="settle-explore" ${raw(FS.exploreSeedReady ? '' : 'disabled')}>${L`結果を受け取る`}</button><span class="muted">${L`ふつうは自動で受け取ります。`}</span></div>` : ''}
    ${draft?.host && !pending ? html`<p>${L`斥候のまわりから、調べる場所を2つまで選んでください。`}</p>
      ${targets.length ? rose(draft.host, targets, draft.tiles) : html`<p class="muted">${L`隣に探索できるマスがありません`}</p>`}
      <div class="actions"><button type="button" class="btn primary" data-act="explore-send" ${raw(draft.tiles.length ? '' : 'disabled')}>${icon('scout')}${L`探索に出す`}</button></div>` : ''}
    ${!draft?.host && !pending ? html`<p class="muted">${L`斥候の軍勢の「探索」を押すと、調べる場所を選べます。`}</p>` : ''}
    <p class="foot-note">${floor > 0 ? L`はじめの探索はあと ${floor} 回、必ず功績 4 を得ます。` : L`探索のたびに半々の確率で功績 4 を得ます。`}</p>
  </section>`;
}
