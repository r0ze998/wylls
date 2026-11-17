// Explore (web design §7.5; contract §5.10 Explore/SettleExplore, I-56): a
// Scout host picks one or two passable tiles next to it that nobody has
// explored; the finds are rolled from the bell's seed (≈ 11–21 minutes
// later). The first three explorations of a citizen always give Works; the
// rest do with chance ½ (M1 has no goods). The result is usually settled
// for the player; the page offers the settle button once the seed exists.
// The targets are the six tiles around the scout: they are picked on the
// board (the lit tiles; the action bar's card names them by direction:
// hud/hand.mjs), never from a list of tile numbers. This card keeps the
// state of the exploration: what waits, when its result is due.
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum } from '../../lang.mjs';
import { exploreTargets, ticketTimes, holdingByRef } from '../fland.mjs';
import { DIRECTIONS, TILE_OFFSETS } from '../fgeo.mjs';
import { dueHtml } from './shell.mjs';
import { icon } from '../hud/icons.mjs';
import { cardHead, chip, ring } from './parts.mjs';
import { holdingName } from '../people/ui.mjs';

/** Up to two chosen tiles. */
export const toggleTile = (chosen, tile) => (chosen.includes(tile) ? chosen.filter(t => t !== tile) : chosen.length < 2 ? [...chosen, tile] : chosen);

/** The direction (0–5, fgeo DIRECTIONS) from tile `from` to its neighbour `to` in one province, or -1. */
export function directionOf(from, to) {
  const a = TILE_OFFSETS[from], b = TILE_OFFSETS[to];
  return a && b ? DIRECTIONS.findIndex(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r) : -1;
}

/** A village's own mark, as the controller writes it (holdingRef): place, site, generation. */
const refOf = h => (h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : '');
/** The pinned world with its generation, as the controller marks it (providerWorld). */
const worldOf = FS => { const pin = FS.pin ?? null; return pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null; };
/**
 * (2026-11-17, ⑦) How the last answer about the seed went for THIS village's pending exploration, in THIS world
 * (controller exploreSeedMarks, `FS.exploreSeedMarks`: one mark per village): 'ready' | 'waiting' | 'failed' with its
 * code; null when no answer stands for this village, this exploration and this world.
 */
export function seedReadOf(FS, h) {
  const m = h ? FS.exploreSeedMarks?.get?.(refOf(h)) ?? null : null;
  return m && h.explore?.state > 0 && m.bell === Number(h.explore.bell) && m.world === worldOf(FS) ? { state: m.state, code: m.code ?? null } : null;
}
/** Whether the person's own check under way is THIS village's, this exploration's and this world's (corrected: a check of the village left behind is not shown as this one's). */
export function seedCheckingOf(FS, h) {
  const c = FS.exploreSeedCheck ?? null;
  return !!c && c.state === 'loading' && !!h && h.explore?.state > 0 && c.ref === refOf(h) && c.bell === Number(h.explore.bell) && c.world === worldOf(FS);
}
/**
 * The viewer's OTHER villages with an exploration waiting: `[{i, name, bell, due}]` (`due`: the second its result is
 * about due, or null without the season's clock). The village in hand is the card's own; these had no place anywhere.
 */
export function otherExplorations(FS) {
  const active = activeHolding(FS) ?? null;
  return (FS.holdings ?? []).map((o, i) => ({ o, i })).filter(({ o }) => o !== active && o?.explore?.state > 0)
    .map(({ o, i }) => ({ i, name: holdingName(o), bell: Number(o.explore.bell), due: FS.clock ? ticketTimes(FS.clock, o.explore.bell).resultAbout : null }));
}

export function render(FS) {
  const h = activeHolding(FS);
  const rec = h?.explore;
  const floor = FS.citizen?.exploresFloorLeft ?? 0;
  const pending = rec && rec.state !== 0;
  const draft = FS.explore?.holding && !holdingByRef(h ? [h] : [],FS.explore.holding) ? null : FS.explore;
  let targets = [];
  if (draft?.host) targets = exploreTargets(draft.host.province, draft.host);
  const times = pending && FS.clock ? ticketTimes(FS.clock, rec.bell) : null;
  // (2026-11-17, ⑦: the seed read for this village's exploration, the person's own check, and the other villages)
  const seed = pending ? seedReadOf(FS, h) : null, checking = pending && seedCheckingOf(FS, h);
  const now = FS.chain?.now?.() ?? null;
  const seedNote = !pending || FS.exploreSeedReady ? '' : html`${checking ? html`<p class="muted" role="status">${L`結果が出たか、確かめています…`}</p>`
    : seed?.state === 'failed' ? html`<p class="notice error" role="alert">${L`結果が出たかどうかを、読み込めませんでした（${seed.code}）。まだ出ていない、という意味ではありません。`}</p>`
    : seed?.state === 'waiting' ? html`<p class="muted" role="status">${L`いま確かめたところ、結果はまだ出ていません。`}</p>` : ''}
    ${FS.mode === 'play' && !checking ? html`<div class="actions"><button type="button" class="btn small" data-act="explore-check">${icon('return')}${L`結果が出たか確かめる`}</button></div>` : ''}`;
  const others = otherExplorations(FS);
  const othersNote = others.length ? html`<div class="explore-others"><p class="muted">${L`ほかの村の探索（結果待ち）`}</p><ul class="list">${others.map(x => html`<li>${icon('scout')}<strong>${x.name}</strong> <span class="muted">${
    x.due === null || now === null ? L`結果待ち` : x.due > now ? Lh`結果は${dueHtml(x.due, now)}に出ます。` : L`結果が出るころを過ぎています。`}</span>
    ${FS.mode === 'play' ? html`<button type="button" class="btn small" data-act="explore-village" data-i="${x.i}">${L`この村の探索を見る`}</button>` : ''}</li>`)}</ul>
    <p class="muted">${L`結果を受け取れるのは、その村を選んでいるときです。`}</p></div>` : '';
  return html`<section class="vcard" aria-labelledby="explore-title">
    ${cardHead({ id: 'explore-title', ic: 'scout', title: L`探索`, side: pending ? chip(L`結果待ち`, 'info') : '' })}
    ${pending ? html`<div class="wait-row">${ring(FS.exploreSeedReady ? 1 : null)}<p>${L`探索の結果を待っています。`}${times ? html` ${Lh`結果は${dueHtml(times.resultAbout, FS.chain?.now?.() ?? null)}に出ます。`}` : ''}</p></div>
      <div class="actions"><button type="button" class="btn${FS.exploreSeedReady ? ' primary' : ''}" data-act="settle-explore" ${raw(FS.exploreSeedReady ? '' : 'disabled')}>${L`結果を受け取る`}</button><span class="muted">${L`ふつうは自動で受け取ります。`}</span></div>` : ''}
    ${draft?.host && !pending ? html`<p>${L`地図で、斥候のとなりの光っているマスを 2 つまで押して選びます。`}</p>
      <p class="muted">${targets.length ? L`選んだマス：${draft.tiles.length}` : L`隣に探索できるマスがありません`}</p>
      <div class="actions"><button type="button" class="btn primary" data-act="explore-send" ${raw(draft.tiles.length && !(FS.inFlight > 0) ? '' : 'disabled')}>${icon('scout')}${L`探索に出す`}</button></div>` : ''}
    ${!draft?.host && !pending ? html`<p class="muted">${L`斥候の軍勢の「探索」を押すと、地図で調べるマスを選べます。`}</p>` : ''}
    ${seedNote}${othersNote}
    <p class="foot-note">${floor > 0 ? L`はじめの探索はあと ${floor} 回、必ず功績 4 を得ます。` : L`探索のたびに半々の確率で功績 4 を得ます。`}</p>
  </section>`;
}
