// The turn dial is a button (the second review: it was the largest thing on the
// HUD, it did nothing, and a press on it fell through to the tile under it).
// A press opens a small card of bell metal under it:
//
//   ターン 42 · 次の鐘まで 9:22
//   the one sentence that ties the bell to the turn (the glossary's own)
//   what the next bell brings the viewer, from the records the page holds:
//   the viewer's own marches that arrive, a warning for a village an enemy
//   may reach, the village request that is decided. Nothing is invented: with
//   nothing due, the card says so.
//
// Pure: the model from the store, the markup from the model.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { countdown } from '../clock.mjs';
import { unitCount } from '../fi18n.mjs';
import { holdingName } from '../people/ui.mjs';
import { icon } from './icons.mjs';
import { TERMS } from './glossary.mjs';

/**
 * What the next bell brings: `[{icon, text}]`. `hostInfo(id)` names a host (hud/inspect.mjs hostInfoOf);
 * `decides` `{turn, after}` when a village request is decided by a bell (screens/join.mjs waitClock).
 */
export function nextBellItems(FS, { hostInfo = null, decides = null } = {}) {
  if ((FS.mode ?? 'play') !== 'play' || !Number.isInteger(FS.nowBell)) return [];
  const next = FS.nowBell + 1, out = [];
  for (const w of FS.incoming ?? []) if (w.bell === next && w.holding) out.push({ icon: 'alert', tone: 'warn', text: L`${holdingName(w.holding)}に来襲の恐れがあります` });
  for (const h of FS.holdings ?? []) for (const t of h.transit ?? []) {
    if (!(t.state >= 1 && t.state <= 3) || t.arriveBell !== next) continue;
    const info = hostInfo?.(t.hostId) ?? null;
    const who = info?.unit ? unitCount(info.unit, info.troops ?? 0) : L`軍勢`;
    out.push({ icon: 'seal', text: info?.dest ? L`あなたの${who}が${info.dest}に着きます` : L`あなたの${who}が行き先に着きます` });
  }
  if (decides && decides.turn === next) out.push({ icon: 'home', text: L`村の場所が決まります（鐘のあと約 ${fmtNum(decides.after)} 分）` });
  return out;
}

/** The card: `chip` the dial's own model (clock.mjs bellChip), `items` nextBellItems. */
export function renderDialCard(chip, items = []) {
  const running = chip && chip.bell !== null && !chip.beforeGenesis && !chip.ended;
  const head = !chip || (chip.bell === null && !chip.beforeGenesis) ? html`<strong>${L`ターン —`}</strong>`
    : chip.beforeGenesis ? html`<strong>${L`開始まで`}</strong><span class="dial-pop-left"><span class="num" data-dial-left>${countdown(chip.secondsLeft)}</span></span>`
      : html`<strong>${L`ターン ${fmtNum(chip.bell)}`}</strong>${chip.ended ? html`<span class="dial-pop-left">${L`終了`}</span>` : html`<span class="dial-pop-left">${L`次の鐘まで`} <span class="num" data-dial-left>${countdown(chip.secondsLeft)}</span></span>`}`;
  return html`<p class="dial-pop-now">${icon('bell')}${head}</p>
    <p class="dial-pop-what">${TERMS.bell.text()}</p>
    ${running ? html`<h4 class="dial-pop-h">${L`次の鐘で`}</h4>${items.length
      ? html`<ul class="dial-pop-list">${items.map(x => html`<li class="${x.tone === 'warn' ? 'warn' : ''}">${icon(x.icon)}<span>${x.text}</span></li>`)}</ul>`
      : html`<p class="dial-pop-none">${L`次の鐘であなたに届くものは、いまはありません。`}</p>`}` : ''}
    <p class="dial-pop-acts"><button type="button" class="btn small" data-act="dial-close">${L`閉じる`}</button></p>`;
}
