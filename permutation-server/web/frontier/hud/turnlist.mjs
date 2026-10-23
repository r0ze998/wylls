// This turn, in one list (UX design 14.2): what the player has ordered this
// turn, what the next toll resolves, and after the toll what happened to the
// player's own orders, each with 見る. It opens from the dial and from the
// action bar; on a phone it stands as a sheet at the foot of the screen.
//
//   orders     `FS.orders` (controller.mjs: every order the page placed, answered: accepted or refused)
//   next       what the next toll brings (hud/dialcard.mjs nextBellItems): marches that arrive, marches whose seal
//              opens, hosts that form up or are rested, an exploration's result, buildings done before it, a warning
//   happened   the notifications of this turn (hud/feed.mjs): the seal of a march opened, a clash resolved, a
//              building finished, a village changed
//
// Nothing is invented: each line is a record the page holds. Pure: the model from the store, the markup from it.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { BUILDINGS, TIERS, unitCount, clientText } from '../fi18n.mjs';
import { UNIT_ORDER, buildItemOf } from '../fland.mjs';
import { icon } from './icons.mjs';
import { tileName } from './place.mjs';
import { KIND_ICON, lineText } from './feed.mjs';
import { took, exploreResultWords } from './orderparts.mjs';

/** A mark per kind of order (hud/icons.mjs). */
export const ORDER_ICON = Object.freeze({ harvest: 'grain', build: 'hammer', walls: 'wall', promote: 'tierup', train: 'helmet', muster: 'ranks', garrison: 'shield', dissolve: 'disband', explore: 'scout', march: 'march',
  // (orders of the prototype rule "banners": given only in a sample world that serves it; each line says 試作)
  'banner-raise': 'flag', 'banner-dress': 'flag', 'banner-tend': 'eye', 'banner-take': 'flag', 'banner-pull': 'disband', 'banner-strike': 'disband' });

/** An order in one line, as the list says it: what was ordered, and what it waits for. `now`: chain seconds. */
export function orderText(FS, o, now = FS.chain?.now?.() ?? 0) {
  const who = Number.isInteger(o.unit) && Number.isFinite(o.troops ?? o.n) ? unitCount(UNIT_ORDER[o.unit], o.troops ?? o.n) : L`軍勢`;
  const left = Number.isFinite(o.doneAt) && o.doneAt > now ? L`あと ${took(o.doneAt - now)}` : L`完成`;
  switch (o.kind) {
    case 'harvest': return L`収穫を蔵に納めました`;
    case 'build': return L`${BUILDINGS[buildItemOf(o.item)?.resource] ?? ''}を建設中（${left}）`;
    case 'walls': return L`城壁を工事中（${left}）`;
    case 'promote': return L`${TIERS[o.to] ?? ''}へ昇格中（${left}）`;
    case 'train': return L`${who} を訓練しました`;
    case 'muster': return L`${who} を編成 — 次のターンに整列します`;
    case 'garrison': return L`守備隊を ${fmtNum(o.n ?? 0)} 増やしました`;
    case 'dissolve': return L`${who} を解散 — このターンの決着のあと控えに戻ります`;
    case 'explore': return L`斥候を探索に出しました（${fmtNum((o.tiles ?? []).length)} マス）— ${exploreResultWords(Number.isInteger(o.resultTurn) ? o.resultTurn : null)}`;
    case 'march': {
      // (the destination is the viewer's own sealed order: this list is the viewer's alone)
      const to = o.home ? L`村` : o.dest && Number.isInteger(o.dest.tile) ? tileName(FS, o.dest.p, o.dest.q, o.dest.tile) : null;
      return to ? L`${who} が${to}へ出発 — ターン ${fmtNum(o.arriveBell ?? 0)} に着きます` : L`${who} が出発 — ターン ${fmtNum(o.arriveBell ?? 0)} に着きます`;
    }
    // (the prototype rule "banners": the order was taken by the sample world; what it did is told from its record)
    case 'banner-raise': return L`試作：旗を立てる命令を出しました`;
    case 'banner-dress': return L`試作：旗の土地を広げる命令を出しました`;
    case 'banner-tend': return L`試作：旗の見回りを命じました`;
    case 'banner-take': return L`試作：旗を取る命令を出しました`;
    case 'banner-pull': return L`試作：旗を倒す命令を出しました`;
    case 'banner-strike': return L`試作：旗を取り下げる命令を出しました`;
    default: return '';
  }
}
/** What a refused order did not do, in one line. */
const REFUSED_TEXT = { harvest: () => L`収穫`, build: () => L`建設`, walls: () => L`城壁`, promote: () => L`昇格`, train: () => L`訓練`, muster: () => L`編成`, garrison: () => L`守備隊`, dissolve: () => L`解散`, explore: () => L`探索`, march: () => L`進軍`,
  'banner-raise': () => L`試作：旗を立てる命令`, 'banner-dress': () => L`試作：旗を広げる命令`, 'banner-tend': () => L`試作：見回り`, 'banner-take': () => L`試作：旗を取る命令`, 'banner-pull': () => L`試作：旗を倒す命令`, 'banner-strike': () => L`試作：旗の取り下げ` };

/**
 * The list's model: `{turn, orders: [{id, icon, text, refused, why, go}], next: [{icon, text, tone, go}], happened:
 * [{id, icon, text, go, battle}]}`. `next` is given (hud/dialcard.mjs nextBellItems, which needs the page's host
 * names); `go` = `{p, q, tile}` where 見る flies.
 */
export function turnModel(FS, { next = [], now = FS.chain?.now?.() ?? 0 } = {}) {
  const turn = FS.nowBell ?? null;
  const orders = (FS.orders ?? []).filter(o => o.turn === turn).map(o => {
    const go = o.kind === 'march' && o.tile ? o.tile : o.tile ?? null;
    if (o.state === 'refused') return { id: o.id, icon: ORDER_ICON[o.kind] ?? 'flag', refused: true, text: L`${REFUSED_TEXT[o.kind]?.() ?? ''}は送られていません`, why: o.why ?? (o.code ? clientText(o.code) : ''), go };
    return { id: o.id, icon: ORDER_ICON[o.kind] ?? 'flag', refused: false, text: orderText(FS, o, now), why: '', go };
  }).reverse();
  // (a threat that still stands is said once, among what the next toll holds, with its count as it is now)
  const standing = x => !!x.send && next.some(n => n.send && n.send.p === x.send.p && n.send.q === x.send.q && n.send.tile === x.send.tile);
  const happened = (FS.feed ?? []).filter(x => x.bell === turn && x.kind !== 'summary' && x.kind !== 'incoming' && !standing(x))
    .map(x => ({ id: x.id, icon: KIND_ICON[x.kind] ?? 'flag', text: lineText(x), send: x.send ?? null, go: Number.isInteger(x.p) ? { p: x.p, q: x.q, tile: Number.isInteger(x.tile) ? x.tile : (FS.holdings ?? []).find(h => h.p === x.p && h.q === x.q)?.tile ?? null } : null, battle: x.battle ?? null }));
  return { turn, orders, next, happened };
}

const see = (go, battle = null) => (battle ? html`<button type="button" class="btn small go" data-act="battle-play" data-p="${battle.p}" data-q="${battle.q}" data-bell="${battle.bell}">${L`見る`}${icon('chevron', 'go-ic')}</button>` : go && Number.isInteger(go.p) ? html`<button type="button" class="btn small go" data-act="turn-see" data-p="${go.p}" data-q="${go.q}" data-tile="${Number.isInteger(go.tile) ? go.tile : ''}">${L`見る`}${icon('chevron', 'go-ic')}</button>` : '');
// (`send`: a banner of the viewer's under threat, prototype rule "banners": the answer is a march that wins the tile)
const sendTo = s => (s && Number.isInteger(s.tile) ? html`<button type="button" class="btn small primary" data-act="proto-send" data-p="${s.p}" data-q="${s.q}" data-tile="${s.tile}">${L`軍勢を送る`}</button>` : '');
const row = (x, extra = '') => html`<li class="tl-row${x.refused ? ' refused' : ''}${x.tone === 'warn' ? ' warn' : ''}">${icon(x.icon)}<span class="tl-text">${x.text}${x.why ? html`<span class="tl-why">${x.why}</span>` : ''}</span><span class="tl-acts">${extra}${sendTo(x.send)}${see(x.go, x.battle ?? null)}</span></li>`;

/** The three parts of the list (a part with nothing to say is said in one quiet line, never left out: the player asked what the turn holds). */
export function renderTurnList(model) {
  if (!model || !Number.isInteger(model.turn)) return '';
  const battle = x => (x.battle ? html`<button type="button" class="btn small" data-act="report-open" data-p="${x.battle.p}" data-q="${x.battle.q}" data-bell="${x.battle.bell}">${L`報告`}</button>` : '');
  return html`<section class="turn-list" aria-label="${L`このターン`}">
    <h4 class="dial-pop-h">${L`このターンに出した命令`}<span class="tl-n num">${fmtNum(model.orders.length)}</span></h4>
    ${model.orders.length ? html`<ol class="tl">${model.orders.map(x => row(x))}</ol>` : html`<p class="dial-pop-none">${L`このターンは、まだ何も命じていません。`}</p>`}
    <h4 class="dial-pop-h">${L`次のターンで`}</h4>
    ${model.next.length ? html`<ul class="tl">${model.next.map(x => row(x))}</ul>` : html`<p class="dial-pop-none">${L`次のターンであなたに届くものは、いまはありません。`}</p>`}
    ${model.happened.length ? html`<h4 class="dial-pop-h">${L`このターンに起きたこと`}</h4><ul class="tl">${model.happened.map(x => row(x, battle(x)))}</ul>` : ''}
  </section>`;
}
