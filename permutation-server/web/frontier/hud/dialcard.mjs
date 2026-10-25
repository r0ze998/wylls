// The turn dial is a button (the second review: it was the largest thing on the
// HUD, it did nothing, and a press on it fell through to the tile under it).
// A press opens a small card of bell metal under it:
//
//   ターン 42 · 次のターンまで 9:22
//   the one sentence that ties the bell to the turn (the glossary's own)
//   what the next bell brings the viewer, from the records the page holds:
//   the viewer's own marches that arrive, a warning for a village an enemy
//   may reach, the village request that is decided. Nothing is invented: with
//   nothing due, the card says so.
//
// Pure: the model from the store, the markup from the model.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { countdown, bellStart } from '../clock.mjs';
import { unitCount, BUILDINGS, TIERS } from '../fi18n.mjs';
import { UNIT_ORDER, QUEUE_KIND, hostsIn, queueItem, buildItemOf } from '../fland.mjs';
import { DEPART_STAMINA } from '../fmarch.mjs';
import { holdingName } from '../people/ui.mjs';
import { icon } from './icons.mjs';
import { TERMS } from './glossary.mjs';
import { took, exploreResultTurn } from './orderparts.mjs';

/**
 * What the next bell brings: `[{icon, text, tone?, go?: {p, q, tile}}]`. `hostInfo(id)` names a host (hud/inspect.mjs
 * hostInfoOf); `decides` `{turn, after}` when a village request is decided by a bell (screens/join.mjs waitClock).
 * From the records the page holds, nothing more:
 *   a warning for a village an enemy may reach
 *   the viewer's marches that arrive at the next turn
 *   the viewer's marches that arrived this turn: their seal opens once this turn has ended, and the result follows
 *     (the card missed these: a march at its destination, its result due, and the card said nothing was due)
 *   hosts that form up, a host whose rest ends or whose stamina is back to what a march takes, a host that dissolves
 *   an exploration whose result is drawn from this turn's seed
 *   buildings that are done before the toll (by the clock, said with the time)
 *   the village request that is decided
 */
export function nextBellItems(FS, { hostInfo = null, decides = null } = {}) {
  if ((FS.mode ?? 'play') !== 'play' || !Number.isInteger(FS.nowBell)) return [];
  const bell = FS.nowBell, next = bell + 1, out = [];
  const spaced = w => (/\d$/.test(w) ? `${w} ` : w);
  for (const w of FS.incoming ?? []) if (w.bell === next && w.holding) out.push({ icon: 'alert', tone: 'warn', text: L`${holdingName(w.holding)}に来襲の恐れがあります`, go: { p: w.holding.p, q: w.holding.q, tile: w.holding.tile ?? null } });
  for (const h of FS.holdings ?? []) for (const t of h.transit ?? []) {
    if (!(t.state >= 1 && t.state <= 3) || (t.arriveBell !== next && t.arriveBell !== bell)) continue;
    const info = hostInfo?.(t.hostId) ?? null;
    // (a count is set off from the particle that follows, as everywhere else: 「槍兵 400 が」)
    // (a host the page can no longer name — it has gone into its village — is said as 軍勢 by a sentence of its own: in English the
    // one word the page has for 軍勢 is the tab's name, and 「Your Hosts reach…」「The seal of your Hosts at…」 stood on this card)
    const named = !!info?.unit, who = named ? spaced(unitCount(info.unit, info.troops ?? 0)) : '';
    const m = (FS.marches ?? []).find(x => String(x.entry?.host ?? x.transit?.hostId ?? '') === String(t.hostId));
    const go = m?.dest && Number.isInteger(m.dest.tile) ? { p: m.dest.p, q: m.dest.q, tile: m.dest.tile } : null;
    if (t.arriveBell === next) out.push({ icon: 'seal', text: !named ? (info?.dest ? L`あなたの軍勢が${info.dest}に着きます` : L`あなたの軍勢が行き先に着きます`) : info?.dest ? L`あなたの${who}が${info.dest}に着きます` : L`あなたの${who}が行き先に着きます`, go });
    else out.push({ icon: 'seal', text: !named ? (info?.dest ? L`${info.dest}に着いた軍勢の封が開きます（結果はそのあと）` : L`行き先に着いた軍勢の封が開きます（結果はそのあと）`) : info?.dest ? L`${info.dest}に着いた${who}の封が開きます（結果はそのあと）` : L`行き先に着いた${who}の封が開きます（結果はそのあと）`, go });
  }
  const now = FS.chain?.now?.() ?? 0;
  for (const h of FS.holdings ?? []) {
    for (const env of FS.provinces?.values?.() ?? []) {
      let rows = [];
      try { rows = hostsIn(env.province, h, bell); } catch { rows = []; }
      for (const r of rows) {
        const who = spaced(unitCount(UNIT_ORDER[r.unit], r.troops)), go = { p: env.province.p, q: env.province.q, tile: r.tile };
        if (r.state === 2) out.push({ icon: 'ranks', text: L`${who}が整列し、動かせるようになります`, go });
        else if (r.state === 1 && r.pending === 5) out.push({ icon: 'disband', text: L`${who}が解散し、兵が控えに戻ります`, go });
        else if (r.state === 1 && !r.inTransit && !r.pending) {
          // (ready at the next turn and not before: its rest ends then, or its stamina is back to a march's then)
          const was = bell >= r.readyBell && r.stamina >= DEPART_STAMINA, will = next >= r.readyBell && r.stamina + 1 >= DEPART_STAMINA;
          if (!was && will) out.push({ icon: 'march', text: L`${who}がまた進軍できるようになります`, go });
        }
      }
    }
    // (an exploration's result is drawn from its own turn's seed, readable early in the turn after next: said at the toll that brings it, and not a toll sooner)
    if (h.explore?.state) { const rt = exploreResultTurn(FS, h.explore.bell); if (rt === null ? h.explore.bell === bell : rt === next) out.push({ icon: 'scout', text: L`探索の結果が、次のターンのはじめに出ます`, go: { p: h.explore.p, q: h.explore.q, tile: null } }); }
    const toll = FS.clock ? bellStart(FS.clock.genesisTs, next) : null;
    if (toll !== null) for (const q of h.queue ?? []) {
      const done = Number(q.doneAt ?? 0);
      if (!(done > now) || done > toll) continue;
      const name = q.kind === QUEUE_KIND.TIER_UP ? L`${TIERS[Number(h.tier ?? 0) + 1] ?? ''}への昇格` : BUILDINGS[buildItemOf(queueItem(q))?.resource] ?? L`建物`;
      out.push({ icon: 'hammer', text: L`${name}が終わります（あと ${took(done - now)}）`, go: { p: h.p, q: h.q, tile: h.tile } });
    }
  }
  if (decides && decides.turn === next) out.push({ icon: 'home', text: L`村の場所が決まります（ターンが変わったあと約 ${fmtNum(decides.after)} 分）` });
  return out;
}

/**
 * The card: `chip` the dial's own model (clock.mjs bellChip), `items` nextBellItems; `list` the markup of this turn's
 * list (hud/turnlist.mjs renderTurnList), which then stands in place of the plain list of the next bell.
 */
export function renderDialCard(chip, items = [], list = '') {
  const running = chip && chip.bell !== null && !chip.beforeGenesis && !chip.ended;
  const head = !chip || (chip.bell === null && !chip.beforeGenesis) ? html`<strong>${L`ターン —`}</strong>`
    : chip.beforeGenesis ? html`<strong>${L`開始まで`}</strong><span class="dial-pop-left"><span class="num" data-dial-left>${countdown(chip.secondsLeft)}</span></span>`
      : html`<strong>${L`ターン ${fmtNum(chip.bell)}`}</strong>${chip.ended ? html`<span class="dial-pop-left">${L`終了`}</span>` : html`<span class="dial-pop-left">${L`次のターンまで`} <span class="num" data-dial-left>${countdown(chip.secondsLeft)}</span></span>`}`;
  return html`<p class="dial-pop-now">${icon('bell')}${head}</p>
    <p class="dial-pop-what">${TERMS.bell.text()}</p>
    ${running && list ? list : running ? html`<h4 class="dial-pop-h">${L`次のターンで`}</h4>${items.length
      ? html`<ul class="dial-pop-list">${items.map(x => html`<li class="${x.tone === 'warn' ? 'warn' : ''}">${icon(x.icon)}<span>${x.text}</span></li>`)}</ul>`
      : html`<p class="dial-pop-none">${L`次のターンであなたに届くものは、いまはありません。`}</p>`}` : ''}
    <p class="dial-pop-acts"><button type="button" class="btn small" data-act="dial-close">${L`閉じる`}</button></p>`;
}
