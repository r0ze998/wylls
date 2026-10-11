// The hand and the words of the prototype rule "banners" (PROTOTYPE-SPEC sections 1, 7 and 8; UX design 14).
//
// The banner rule is a DESIGN the sample world tries out: it is not in the program, and nothing of it reaches a
// chain. Whatever this module draws is drawn only while the season record carries `sample.proto.claims` (`FS.proto`,
// set by controller.mjs), and each piece says 試作 / Prototype on itself; the fixed chip beside the turn dial stands
// for as long as any of it does. With `FS.proto` absent every function here returns '' or null and the page says
// what it said before (the words of UX design 14).
//
// Pure: the reading of the records is proto/hand-model.mjs; here is the markup. app.mjs puts it in the page, and
// controller.mjs sends the orders (proto/orders.mjs).
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName, errorText } from '../fi18n.mjs';
import { leaderSvg } from '../people/leaders.mjs';
import { NATION_FILL } from '../palette.mjs';
import { icon } from './icons.mjs';
import * as pm from '../proto/hand-model.mjs';

const int = Number.isInteger;
/** The tag on every line the prototype adds. */
export const tagHtml = () => html`<span class="proto-tag">${pm.tag()}</span>`;

// ------------------------------------------------------------------ the chip beside the dial
/** The fixed chip's words: the season record's own label (`sample.proto.claims.label`), and nothing else. '' with the prototype off. */
export const chipText = FS => (FS.proto ? pm.labelText(FS.proto.claims) : '');

// ------------------------------------------------------------------ the plate
/**
 * The plate's lines: 試作 あなたの土地 16マス（村7・旗9） · 旗 1/5 · つぎの旗：功績 8, and the personal line of the
 * score. '' with the prototype off or before the viewer's record has come.
 */
export function plateLines(FS) {
  let m = FS.proto ? pm.plateModel(FS) : null;
  if (!m) return '';
  // (the count follows its record a tile at a time: app.mjs steps `plateShown`; the record's own number is in the data attribute)
  const shown = int(FS.proto.plateShown) ? FS.proto.plateShown : m.tiles, counting = shown !== m.tiles;
  const tiles = m.tiles;
  if (counting) m = { ...m, tiles: shown, banner: Math.max(0, shown - m.village) };
  const next = pm.plateNext(m);
  return html`<span class="plate-proto${counting ? ' counting' : ''}" data-proto-tiles="${tiles}">${tagHtml()}<span class="pp-land">${icon('flag')}<strong class="num" data-proto-land>${pm.plateLand(m)}</strong></span>
      <span class="pp-banners num">${pm.plateBanners(m)}</span>${next ? html`<span class="pp-next num">${next}</span>` : ''}
      <span class="pp-ledger num">${pm.plateLedger({ ...m, tiles })}</span></span>`;
}

// ------------------------------------------------------------------ the bar's first button of a host
/**
 * The banner button of a host's bar (hud/hand.mjs puts it first), or null: with the prototype off, or for a host
 * that has nothing to do with banners where it stands (a Scout away from the viewer's banners).
 *   the count is done      旗を立てる · +9マス                (lit)
 *   the count runs         旗 · あと1ターン                  「あと1ターンで旗を立てられます」
 *   the province lags      旗 · 集計待ち                     「集計を待っています」
 *   on another's pole      旗を取る · あと12ターン
 *   by a banner of yours   見回る · 功績 +2
 *   nowhere a banner rises 旗, off, with the world's reason
 */
export function bannerButton(FS, row, pop = null) {
  const s = FS.proto ? pm.hostSituation(FS, row) : null;
  if (!s || (!s.fighting && s.mode !== 'own')) return null;
  const b = { id: 'banner', icon: 'flag', word: L`旗`, act: 'hand-pop', data: { pop: 'banner' }, figure: '', tone: '', why: null, hint: '', pressed: pop === 'banner', proto: true };
  if (s.loading) return { ...b, figure: '…', hint: L`この州の記録を待っています` };
  if (s.mode === 'rising') {
    const c = s.count;
    if (c.done) return { ...b, word: L`旗を立てる`, figure: s.size ? L`+${fmtNum(s.size)}マス` : '', tone: 'go', hint: s.size ? L`旗を立てる（+${fmtNum(s.size)}マス）` : L`旗を立てる` };
    if (c.lag || c.left === null) return { ...b, figure: L`集計待ち`, tone: 'busy', hint: L`集計を待っています` };
    return { ...b, figure: L`あと${fmtNum(c.left)}ターン`, tone: 'busy', hint: L`あと${fmtNum(c.left)}ターンで旗を立てられます` };
  }
  if (s.mode === 'foe') {
    const c = s.count, word = s.noTake ? L`旗を倒す` : L`旗を取る`;
    if (s.refusal) { const why = pm.refusalText(s.refusal.code, { need: s.refusal.need }); return { ...b, word, why, hint: why }; }
    if (c.done) return { ...b, word, figure: factionName(s.banner.nation), tone: 'go', hint: s.noTake ? L`この旗を倒せます` : L`この旗を取るか倒せます` };
    if (c.lag || c.left === null) return { ...b, word, figure: L`集計待ち`, tone: 'busy', hint: L`集計を待っています` };
    return { ...b, word, figure: L`あと${fmtNum(c.left)}ターン`, tone: 'busy', hint: L`あと${fmtNum(c.left)}ターンで、この旗を取るか倒せます` };
  }
  if (s.mode === 'own') {
    const pay = pm.walkPay(FS), first = pay && (s.tend ? !!s.tend.paysToday : !pm.meOf(FS)?.walkPaidToday);
    const state = s.banner.contested ? L`狙われ中` : s.banner.frayed ? L`ほつれ` : null, tiles = L`${fmtNum((s.banner.tiles ?? []).length)}マス`;
    // (the world says this host cannot walk the banner now — it raised it, or walked it last —: the button is the banner's card, and promises no walk)
    if (s.tend && !s.tend.ok) return { ...b, word: s.mine ? L`あなたの旗` : L`同じ国の旗`, figure: state ?? tiles, tone: state ? 'bad' : '', hint: pm.refusalText(s.tend.code, { need: s.tend.need }) };
    return { ...b, word: L`見回る`, figure: state ?? (first ? L`功績 +${fmtNum(pay)}` : tiles), tone: state ? 'bad' : '', hint: first ? L`見回る（今日の最初なら功績 +${fmtNum(pay)}）` : L`見回る` };
  }
  const line = pm.previewLine(FS, s.preview);
  if (line === null) return { ...b, figure: s.preview === null ? '' : '…', hint: L`旗を立てられるか確かめています` };
  if (!line.ok) return { ...b, why: line.text, hint: line.text };
  return { ...b, figure: line.wait ? L`あと${fmtNum(line.wait)}ターン` : L`+${fmtNum(line.size)}マス`, tone: 'busy', hint: line.wait ? L`あと${fmtNum(line.wait)}ターンで旗を立てられます` : line.text };
}

// ------------------------------------------------------------------ the bar's card: 旗
const head = (title, sub = '') => html`<div class="pop-head"><strong class="pop-title">${title}</strong>${tagHtml()}${sub ? html`<span class="pop-sub">${sub}</span>` : ''}
  <button type="button" class="hand-tool pop-x" data-act="hand-pop" data-pop="" aria-label="${L`閉じる`}">${icon('close')}</button></div>`;
const designNote = () => html`<p class="pop-line pop-rule proto-note">${L`設計中のルールの試作です。プログラムにはまだなく、チェーンには何も送りません。`}</p>`;
const fact = (k, v, cls = '') => html`<li class="${cls}"><span class="pf-k">${k}</span><span class="pf-v num">${v}</span></li>`;
const lines = list => list.map(x => html`<p class="pop-line proto-line${x.tone ? ` tone-${x.tone}` : ''}${x.quiet ? ' quiet' : ''}">${x.text}</p>`);
const off = why => raw(why ? 'aria-disabled="true"' : '');
/**
 * An order of a host waits, like the basic game's own, while the page's copy of its province has not been settled
 * through the turn before this one (about the first minute of a turn): the world would answer NotResident. The
 * reason in the basic game's words, or null.
 */
const lagWhy = (FS, row) => { const pv = FS.provinces?.get?.(`${row.p},${row.q}`)?.province ?? null; return pv && int(pv.resolvedNext) && int(FS.nowBell) && pv.resolvedNext + 1 < FS.nowBell ? errorText('NotResident') : null; };

/** The wait of a count in words, with the clock beside it. */
function waitWords(FS, c) {
  if (c.done) return L`いま立てられます`;
  if (c.lag || c.left === null) return L`集計を待っています`;
  return L`あと${fmtNum(c.left)}ターン${pm.clockOf(FS, c.left)}`;
}

function raiseCard(FS, row, s) {
  const id = String(row.id), a = s.answer;
  const line = pm.previewLine(FS, a), me = pm.meOf(FS), parts = line?.ok ? pm.patchParts(a) : { flower: null, trail: null };
  const size = line?.ok ? line.size : s.size, price = line?.ok ? line.price : null;
  // (while the world has not said what it would take, the order waits for it: it carries the count and the price it was shown)
  const why = lagWhy(FS, row) ?? (line && !line.ok ? line.text : !s.count.done ? (s.count.lag || s.count.left === null ? L`集計を待っています` : L`あと${fmtNum(s.count.left)}ターンで旗を立てられます`) : line === null && a === undefined ? L`確かめています…` : null);
  const max = price ?? me?.nextPrice ?? 0;
  // (the place was chosen for more tiles than the world gives now — a banner raised first took some, an enemy host came near —: said, with the reason)
  const short = pm.promiseShort(FS, row.p, row.q, row.tile, size);
  // (a phone shows the card as a low sheet — what the banner brings, what it costs, the button — and keeps the board
  // above it in sight: the sentence, the table and the note of the design stand behind くわしく; a wide screen shows all)
  const more = !!FS.hand?.more, priceNow = price === null ? (me?.nextPrice !== undefined && me?.nextPrice !== null ? me.nextPrice : null) : price;
  return html`${head(L`旗を立てる`, pm.hostName(row))}
    <p class="proto-brief"><strong class="pb-gain num">${size ? L`+${fmtNum(size)}マス` : '…'}</strong><span class="pb-sub num">${priceNow === null ? '' : html`${pm.priceText(priceNow)} · `}${waitWords(FS, s.count)}</span>
      <button type="button" class="btn small pop-quiet pb-more" data-act="proto-more" aria-expanded="${more ? 'true' : 'false'}">${more ? L`とじる` : L`くわしく`}</button></p>
    <div class="proto-full${more ? ' open' : ''}">
    <p class="pop-line">${L`足もとに旗を立てると、まわりのマスがあなたの土地になります。`}</p>
    <ul class="proto-facts">
      ${fact(L`土地になるマス`, size ? (parts.trail ? L`+${fmtNum(size)}マス（旗のまわり ${fmtNum(parts.flower)}・歩いた跡 ${fmtNum(parts.trail)}）` : L`+${fmtNum(size)}マス`) : '…')}
      ${fact(L`費用`, price === null ? (me?.nextPrice !== undefined && me?.nextPrice !== null ? pm.priceText(me.nextPrice) : '…') : int(me?.works) && price > 0 ? L`${pm.priceText(price)}（手持ち ${fmtNum(me.works)}）` : pm.priceText(price))}
      ${fact(L`待ち`, waitWords(FS, s.count), s.count.done ? 'ok' : '')}
    </ul>
    ${designNote()}</div>
    <div class="pop-foot proto-foot"><button type="button" class="btn pop-quiet" data-act="hand-pop" data-pop="">${L`やめる`}</button>
      <button type="button" class="btn primary pop-go proto-go" data-act="proto-raise" data-host="${id}" data-p="${row.p}" data-q="${row.q}" data-min="${size ?? 0}" data-max="${max}" ${off(why)}>${icon('flag')}${size ? L`旗を立てる（+${fmtNum(size)}マス）` : L`旗を立てる`}</button></div>
    ${why ? html`<p class="pop-line pop-why">${why}</p>` : ''}
    ${short ? html`<p class="pop-line proto-short">${short.toLand && short.other ? L`この場所を選んだときは +${fmtNum(short.was)}マス でした。そのうち${fmtNum(short.toLand)}マスは先に立った旗の土地になり、${fmtNum(short.other)}マスはいまは土地にできません（敵の軍勢が近くにいると、そうなります）。`
      : short.toLand ? L`この場所を選んだときは +${fmtNum(short.was)}マス でした。そのうち${fmtNum(short.toLand)}マスは、先に立った旗の土地になりました。`
        : L`この場所を選んだときは +${fmtNum(short.was)}マス でした。そのうち${fmtNum(short.other)}マスは、いまは土地にできません（敵の軍勢が近くにいると、そうなります）。`}</p>` : ''}
    ${s.widen ? html`<div class="pop-foot proto-acts"><button type="button" class="btn pop-go" data-act="proto-widen" data-on="1" ${off(lagWhy(FS, row))}>${icon('plus')}${L`となりのあなたの旗を1マス広げる（1日1回）`}</button></div>` : ''}`;
}

function foeCard(FS, row, s) {
  const id = String(row.id), b = s.banner, c = s.count;
  const refused = s.refusal ? pm.refusalText(s.refusal.code, { need: s.refusal.need }) : null;
  const wait = refused ?? lagWhy(FS, row) ?? (c.done ? null : c.lag || c.left === null ? L`集計を待っています` : L`あと${fmtNum(c.left)}ターン${pm.clockOf(FS, c.left)}で、この旗を取るか倒せます`);
  const me = pm.meOf(FS);
  const noTake = s.noTake ? pm.takeStopText(s.noTake.stop, { cap: me?.cap, held: (me?.banners ?? []).length, perProvince: me?.perProvince }) : null;
  const data = html`data-host="${id}" data-p="${row.p}" data-q="${row.q}" data-slot="${b.slot}"`;
  return html`${head(L`${factionName(b.nation)}の旗`, L`${fmtNum((b.tiles ?? []).length)}マス`)}
    <p class="pop-line">${c.done ? (noTake ? L`この旗を倒せます。` : L`この旗を取るか倒せます。取ると、その土地があなたのものになります。`) : L`旗の立つマスに立ちつづけると、この旗を取るか倒せます。`}</p>
    ${wait ? html`<p class="pop-line proto-count${refused ? ' pop-why' : ''}">${icon(refused ? 'alert' : 'hourglass')}${wait}</p>` : ''}
    <div class="pop-foot">
      ${noTake ? '' : html`<button type="button" class="btn primary pop-go proto-go" data-act="proto-take" ${data} ${off(wait)}>${icon('flag')}${L`旗を取る`}</button>`}
      <button type="button" class="btn${noTake ? ' primary' : ''} pop-go" data-act="proto-pull" ${data} ${off(wait)}>${icon('disband')}${L`旗を倒す`}</button></div>
    ${noTake ? html`<p class="pop-line pop-why">${L`ここでは取れません（${noTake}）`}</p>` : ''}
    ${designNote()}`;
}

function ownCard(FS, row, s) {
  const id = String(row.id), b = s.banner, r = s.r;
  const pay = pm.walkPay(FS), first = pay && (s.tend ? !!s.tend.paysToday : !pm.meOf(FS)?.walkPaidToday);
  const data = html`data-host="${id}" data-p="${row.p}" data-q="${row.q}" data-slot="${b.slot}"`;
  const max = pm.numberOf(FS, 'PATCH_MAX'), n = (b.tiles ?? []).length;
  const held = b.contested ? pm.refusalText('Contested') : null;
  // (the world's own judgement of this host, where it serves it; else what the banner's record shows)
  const lag = lagWhy(FS, row);
  const tendWhy = lag ?? (s.tend && !s.tend.ok ? pm.refusalText(s.tend.code, { need: s.tend.need }) : null);
  // (no tile the world would add from where this host stands: said with what the rule asks of such a tile — the
  // record's own numbers —, so that the player knows what would open one: Scouts, or a larger host)
  const reach = pm.numberOf(FS, 'REACH'), deny = pm.numberOf(FS, 'DENY_FACTOR');
  const noTile = reach !== null && deny !== null ? L`この軍勢のそばに、広げられるマスがありません。広げられるのは、旗の土地のとなりにある、斥候が調べた空きマスです（旗から${fmtNum(reach)}マスまで。敵の軍勢のとなりのマスは、その${fmtNum(deny)}倍の兵が要ります）` : L`この軍勢のそばに、広げられるマスがありません`;
  const dressWhy = held ?? lag ?? (s.dress ? (s.dress.code ? pm.refusalText(s.dress.code) : s.dress.tiles?.length ? null : noTile)
    : b.dressedToday ? pm.refusalText('DressedToday') : max !== null && n >= max ? pm.refusalText('PatchFull') : null);
  const lockLeft = int(b.elbowLockedUntil) && int(r) && b.elbowLockedUntil > r ? b.elbowLockedUntil : null;
  const strikeWhy = held ?? (lockLeft !== null ? pm.refusalText('ElbowLocked', { turn: lockLeft }) : null);
  const picking = FS.hand?.pick?.kind === 'dress', picked = int(FS.hand?.tile);
  if (FS.hand?.strike && s.mine) {
    return html`${head(L`旗を取り下げる`, L`${fmtNum(n)}マス`)}
      <p class="pop-line">${L`この旗を取り下げます。${fmtNum(n)}マスは、誰のものでもない土地に戻ります。`}</p>
      <div class="pop-foot"><button type="button" class="btn pop-quiet" data-act="proto-strike-ask" data-on="">${L`やめる`}</button>
        <button type="button" class="btn primary pop-go pop-danger" data-act="proto-strike" data-p="${row.p}" data-q="${row.q}" data-slot="${b.slot}" ${off(strikeWhy)}>${icon('disband')}${L`取り下げる（−${fmtNum(n)}マス）`}</button></div>
      ${strikeWhy ? html`<p class="pop-line pop-why">${strikeWhy}</p>` : ''}${designNote()}`;
  }
  // (a phone shows this card low, like the raise's: the line that matters most — a threat, a walk that is due, else
  // what the banner is — with the rest and the note of the design behind くわしく; while a tile is being picked on
  // the board for the widening the card is the one button and its sentence. The card stood over the whole map, and
  // the tiles to pick from were under it)
  const said = pm.bannerLines(FS, row.p, row.q, b, r).filter(x => !x.quiet), lead = said.find(x => x.tone === 'bad') ?? said.find(x => x.tone === 'warn') ?? said[0] ?? null;
  const more = !!FS.hand?.more;
  return html`${head(s.mine ? L`あなたの旗` : L`同じ国の旗`, L`${fmtNum(n)}マス`)}
    <p class="proto-brief proto-brief-own">${more || !lead ? html`<span class="pb-sub"></span>` : html`<span class="pb-sub${lead.tone ? ` tone-${lead.tone}` : ''}">${lead.text}</span>`}
      <button type="button" class="btn small pop-quiet pb-more" data-act="proto-more" aria-expanded="${more ? 'true' : 'false'}">${more ? L`とじる` : L`くわしく`}</button></p>
    <div class="proto-full${more ? ' open' : ''}">${lines(said)}</div>
    <div class="pop-foot proto-acts">
      <button type="button" class="btn primary pop-go proto-go" data-act="proto-tend" ${data} ${off(tendWhy)}>${icon('eye')}${first ? L`見回る（今日の最初なら功績 +${fmtNum(pay)}）` : L`見回る`}</button>
      ${!s.mine ? '' : picked
        ? html`<button type="button" class="btn pop-go" data-act="proto-dress" ${data} data-tile="${FS.hand.tile}" ${off(dressWhy)}>${icon('plus')}${L`このマスを旗の土地にする`}</button>`
        : html`<button type="button" class="btn pop-go" data-act="proto-dress-pick" ${data} ${off(dressWhy)} aria-pressed="${picking ? 'true' : 'false'}">${icon('plus')}${L`旗の土地を1マス広げる（1日1回）`}</button>`}
      ${s.back ? html`<button type="button" class="btn pop-quiet" data-act="proto-widen" data-on="">${L`もどる`}</button>` : s.mine ? html`<button type="button" class="btn pop-quiet" data-act="proto-strike-ask" data-on="1" ${off(strikeWhy)}>${L`旗を取り下げる`}</button>` : ''}</div>
    ${picking && !picked ? html`<p class="pop-line pop-rule">${L`光っているマスを押して、広げるマスを選びます。`}</p>` : ''}
    ${tendWhy && !(picking && tendWhy !== lag) ? html`<p class="pop-line pop-why">${tendWhy}</p>` : ''}
    ${held ? html`<p class="pop-line pop-why">${held}</p>` : dressWhy && dressWhy !== tendWhy && s.mine && !picking ? html`<p class="pop-line quiet proto-dress-why">${dressWhy}</p>` : ''}
    ${designNote()}`;
}

function noneCard(FS, row, s) {
  const line = pm.previewLine(FS, s.preview);
  return html`${head(L`旗`, pm.hostName(row))}
    ${s.loading ? html`<p class="pop-line">${L`この州の記録を待っています`}</p>`
      : line === null ? html`<p class="pop-line">${s.preview === null ? L`ここに旗を立てられるかは、確かめられませんでした。` : L`旗を立てられるか確かめています…`}</p>`
        : line.ok ? html`<p class="pop-line">${line.wait ? L`ここに立ちつづけると、あと${fmtNum(line.wait)}ターン${pm.clockOf(FS, line.wait)}で旗を立てられます（${line.text}）。` : L`ここに旗を立てられます（${line.text}）。`}</p>`
          : html`<p class="pop-line pop-why">${L`ここには旗を立てられません：${line.text}`}</p>`}
    <p class="pop-line pop-rule">${L`旗は、軍勢が立っている誰のものでもない土地に立てられます。`}</p>
    ${designNote()}`;
}

/** The card 旗 above a host's bar (hud/hand.mjs renderPop), by where the host stands. '' with the prototype off. */
export function bannerPop(FS, model) {
  if (!FS.proto || model?.kind !== 'host') return '';
  const row = model.host, s = pm.hostSituation(FS, row);
  if (!s) return '';
  // (a host that could raise its own banner AND widen a banner of the viewer's beside it: its card is the raise, with
  // the widening one press away — the card of that banner, for as long as the player keeps it open)
  if (s.mode === 'rising' && s.widen && (FS.hand?.widen || FS.hand?.pick?.kind === 'dress')) return ownCard(FS, row, { ...s.widen, r: s.r, mode: 'own', back: true });
  if (s.mode === 'rising') return raiseCard(FS, row, s);
  if (s.mode === 'foe') return foeCard(FS, row, s);
  if (s.mode === 'own') return ownCard(FS, row, s);
  return noneCard(FS, row, s);
}

// ------------------------------------------------------------------ choosing where a host forms up, or where it marches
/**
 * The line a place gets while a host is being placed there (the new host's card; the march's order):
 * 「試作 ここに立てば旗を立てられます：+7マス・1ターン」, or why not. `a`: the preview's answer (undefined: asked,
 * no answer yet; null: could not be asked). '' with the prototype off.
 */
export function placeLine(FS, a) {
  if (!FS.proto) return '';
  const line = pm.previewLine(FS, a);
  if (line === null) return a === null ? '' : html`<p class="pop-line proto-place">${tagHtml()}<span>${L`旗を立てられるか確かめています…`}</span></p>`;
  // (land of a banner of the viewer's own: no second banner rises there, but a host newly formed there may walk it)
  // (whatever else the world says of raising a banner there — beside a camp, say —: the land record shows whose the tile is)
  if (!line.ok && int(a?.p) && int(a?.q)) {
    const land = pm.landOf(FS, a.p, a.q), k = land && int(a.tile) ? pm.kindAt(land, a.tile) : null;
    const b = k?.kind === 'banner' ? k.banner : a.code === 'NotOpen' && a.need?.why === 'banner' ? (land?.banners ?? []).find(x => x.slot === a.need.slot) ?? null : null;
    if (b && pm.isOwnBanner(FS, a.p, a.q, b)) return html`<p class="pop-line proto-place ok">${tagHtml()}${icon('flag')}<span>${L`あなたの旗の土地です：ここに新しく立った軍勢は、この旗を見回れます`}</span></p>`;
    // (the pole of another nation's banner: a host formed here may take that banner or pull it down — the place said only 「ここはもう旗の土地です」)
    if (b && b.pole === a.tile && int(b.nation) && b.nation !== pm.nationOf(FS)) return html`<p class="pop-line proto-place ok">${tagHtml()}${icon('flag')}<span>${L`${factionName(b.nation)}の旗が立つマスです。ここに立ちつづけると、その旗を取るか倒せます`}</span></p>`;
  }
  return html`<p class="pop-line proto-place${line.ok ? ' ok' : ' no'}">${tagHtml()}${icon('flag')}<span>${line.ok ? L`ここに立てば旗を立てられます：${line.text}${pm.clockOf(FS, line.wait)}` : L`ここでは旗を立てられません：${line.text}`}</span></p>`;
}

/**
 * The march's order, before the seal: 到着：ターン 47・旗はターン 49 から・+9マス (the host arrives at the turn
 * the order names, stands the turns the world says, and the province is settled a turn behind the clock). '' with
 * the prototype off, for a host that does not fight, or while no destination and arrival are chosen.
 */
export function marchLine(FS, { arrive = null, answer, dest = null, forecast = null, crowd = false, shift = null } = {}) {
  if (!FS.proto || !int(arrive)) return '';
  // (the sample world lets one host of a citizen into a province in a turn — its own list of what it does more simply
  // than the program says so —: a second march of the viewer's sealed for the same turn would be turned back at the
  // seal's opening. Said before the seal; where the page itself made the order card, it has moved the arrival a turn on)
  const own = crowd ? html`<span class="mc-proto-fc mc-proto-warn">${L`ターン ${fmtNum(arrive)} には、あなたの別の軍勢もこの州に着きます。見本の世界では、同じターンにひとつの州へ着けるのは、ひとり1軍勢です。到着のターンを変えてください`}</span>`
    : shift && int(shift.from) ? html`<span class="mc-proto-fc">${L`あなたの別の軍勢がターン ${fmtNum(shift.from)} にこの州へ着くので、到着を1ターン遅らせてあります（見本の世界では、同じターンにひとつの州へ着けるのは、ひとり1軍勢です）`}</span>` : '';
  // (a march onto land of a banner of the viewer's — to walk it, to win its pole back — is not a place to raise one: said as what it is)
  const land = dest ? pm.landOf(FS, dest.p, dest.q) : null, k = land && int(dest.tile) ? pm.kindAt(land, dest.tile) : null;
  if (k?.kind === 'banner' && pm.isOwnBanner(FS, dest.p, dest.q, k.banner)) return html`<p class="mc-proto ok">${tagHtml()}${icon('flag')}<span>${L`到着：ターン ${fmtNum(arrive)}・あなたの旗の土地です`}</span>${own}</p>`;
  // (a march onto the pole of another nation's banner — to take it or pull it down — was told 「ここはもう旗の土地です」,
  // as if the march were for nothing: said as what it is. How long the host must stand is the world's to say once it stands.)
  if (k?.kind === 'banner' && k.banner && k.banner.pole === dest.tile && int(k.banner.nation) && k.banner.nation !== pm.nationOf(FS)) return html`<p class="mc-proto ok">${tagHtml()}${icon('flag')}<span>${L`到着：ターン ${fmtNum(arrive)}・${factionName(k.banner.nation)}の旗が立つマスです。ここに立ちつづけると、その旗を取るか倒せます`}</span>${own}</p>`;
  const line = pm.previewLine(FS, answer);
  if (line === null) return answer === null ? '' : html`<p class="mc-proto">${tagHtml()}<span>${L`旗を立てられるか確かめています…`}</span></p>`;
  // (a march onto a tile an enemy host holds is an attack: said as that, not as a place where no banner can rise)
  // (and what the rules' own forecast of that fight says — hud/forecast.mjs, the same one the card keeps behind its
  // fold —, in one line beside it: a new hamlet's host sent against 500 was told only "if it wins")
  if (!line.ok && answer?.code === 'NotOpen' && answer?.need?.why === 'enemy') return html`<p class="mc-proto${forecastTone(forecast)}">${tagHtml()}${icon('flag')}<span>${L`到着：ターン ${fmtNum(arrive)}・敵の軍勢が立っています。勝てば、このマスに立ちます`}</span>${forecastLine(forecast)}${own}</p>`;
  if (!line.ok) return html`<p class="mc-proto no">${tagHtml()}${icon('flag')}<span>${L`到着：ターン ${fmtNum(arrive)}・ここでは旗を立てられません：${line.text}`}</span>${own}</p>`;
  // (the host stands from the turn after its arrival; then the turns it must stand; then the turn in which the
  // world has settled that count — the record's own `clockLag`)
  const from = arrive + 1 + (line.wait ?? 0) + pm.clockLag(FS);
  return html`<p class="mc-proto ok">${tagHtml()}${icon('flag')}<span>${L`到着：ターン ${fmtNum(arrive)}・旗はターン ${fmtNum(from)} から・+${fmtNum(line.size)}マス`}</span>${line.price > 0 ? html`<span class="mc-proto-price">${pm.priceText(line.price)}</span>` : ''}${own}</p>`;
}

/**
 * The rules' forecast of an attack (hud/forecast.mjs: the clash resolved by the program's own rules under several
 * seeds) as one line: in how many of the runs the host stayed on the tile. '' while there is none.
 */
export function forecastLine(fc) {
  if (!fc) return '';
  if (fc.pending) return html`<span class="mc-proto-fc">${L`予測を計算しています…`}</span>`;
  if (!fc.ok || !(fc.runs > 0)) return '';
  const stays = Number(fc.fates?.Stays ?? 0);
  return html`<span class="mc-proto-fc">${stays >= fc.runs ? L`予測：${fmtNum(fc.runs)}回試して、${fmtNum(fc.runs)}回ともこのマスに残りました` : stays > 0 ? L`予測：${fmtNum(fc.runs)}回試して、このマスに残れたのは${fmtNum(stays)}回です` : L`予測：${fmtNum(fc.runs)}回試して、このマスに残れた回はありません`}</span>`;
}
const forecastTone = fc => (fc?.ok && fc.runs > 0 && !(Number(fc.fates?.Stays ?? 0) > 0) ? ' no' : '');

// ------------------------------------------------------------------ the score
const crest = (f, size = 22) => raw(leaderSvg(f, { size, shape: 'hex', sigil: true }));
/**
 * The ticker of the six nations by share of all tile-turns, with the note under it (the record's own words, which say
 * that the score is the prototype's reckoning and no chain record). `open`: names stand beside the shares (wide screens
 * always; a phone on a press). '' with the prototype off or before the record has come.
 */
export function ticker(FS, { open = true } = {}) {
  const m = FS.proto ? pm.standingsModel(FS) : null;
  if (!m) return '';
  const all = L`領土の得点（試作）：${m.rows.map(r => `${factionName(r.nation)} ${pm.pctText(r.share)}%`).join(' · ')}`;
  return html`<button type="button" class="proto-ticker${open ? ' open' : ''}" data-act="proto-ticker" aria-expanded="${open ? 'true' : 'false'}" aria-label="${all}">
      <span class="pt-title">${L`領土の得点`}${tagHtml()}</span>
      <span class="pt-rows">${m.rows.map((r, i) => html`<span class="pt-row${r.mine ? ' mine' : ''}"><span class="pt-rank num">${i + 1}</span>${crest(r.nation)}<span class="pt-name">${factionName(r.nation)}</span><span class="pt-share num">${pm.pctText(r.share)}%</span></span>`)}</span>
    </button>
    ${open ? html`<p class="proto-note pt-how">${L`これまでの全マス・ターンに占める各国の割合です。持っているマスが毎ターン1点になるので、数字はゆっくり動きます。`}</p>` : ''}
    <p class="proto-note pt-note">${m.note}</p>`;
}

// ------------------------------------------------------------------ the province card and a tile's lines (the inspector)
/** The bar of 61 segments by nation with the counts: アステル 48・ヴォード 13 ／ あなたの国 13/24・あなた 2/2本. '' without the land record. */
export function provinceCard(FS, p, q) {
  const m = FS.proto ? pm.provinceCard(FS, p, q) : null;
  if (!m) return '';
  // (61 segments, one a tile: a nation's land under villages and banners in its colour, the commons of the province's own nation paler; drawn with presentation attributes, the page's CSP allows no style attribute)
  const seg = [];
  let at = 0;
  const one = (nation, commons) => { seg.push(`<rect x="${at * 10 + 1}" y="1" width="8" height="${commons ? 10 : 14}" rx="1.5" fill="${NATION_FILL[nation] ?? '#8a8a80'}"${commons ? ' fill-opacity=".42"' : ''} stroke="#0a1513" stroke-width=".8"/>`); at++; };
  for (const s of m.segments) {
    for (let i = 0; i < s.n - s.commons; i++) one(s.nation, false);
    for (let i = 0; i < s.commons; i++) one(s.nation, true);
  }
  const counts = m.counts.map(c => `${factionName(c.nation)} ${fmtNum(c.paid)}`).join(' · ');
  const mine = m.mine ? (m.mine.ceiling === null ? L`あなたの国 ${fmtNum(m.mine.counted)}マス` : L`あなたの国 ${fmtNum(m.mine.counted)}/${fmtNum(m.mine.ceiling)}`) : '';
  const you = m.banners.per === null ? L`あなた ${fmtNum(m.banners.here)}本` : L`あなた ${fmtNum(m.banners.here)}/${fmtNum(m.banners.per)}本`;
  return html`<section class="proto-prov" aria-label="${L`この州の土地（試作）`}">
    <h4 class="proto-h">${icon('flag')}${L`この州の土地`}${tagHtml()}</h4>
    <div class="ps-bar" role="img" aria-label="${counts}">${raw(`<svg viewBox="0 0 ${Math.max(610, at * 10)} 16" preserveAspectRatio="none" aria-hidden="true" focusable="false">${seg.join('')}</svg>`)}</div>
    <p class="ps-counts num">${counts}</p>
    <p class="ps-mine num">${mine ? `${mine} · ${you}` : you}</p>
    ${m.mine && m.mine.ceiling !== null ? html`<p class="proto-note">${L`この州で点になるのは${fmtNum(m.mine.ceiling)}マスまでです。試作では砦がありません。`}</p>` : ''}
  </section>`;
}

/** What the selected tile is under the banner rule, for the inspector: village land, a banner, the commons. '' with the prototype off. */
export function tileCard(FS, p, q, tile, { siteOwner: owner = null } = {}) {
  let siteOwner = owner;
  if (!FS.proto || !int(tile)) return '';
  const land = pm.landOf(FS, p, q);
  if (!land) return '';
  const k = pm.kindAt(land, tile), nation = pm.nationOf(FS);
  let body = '';
  if (k.kind === 'banner' && k.banner) {
    const own = pm.isOwnBanner(FS, p, q, k.banner), b = k.banner;
    const held = b.contested ? pm.refusalText('Contested') : null;
    const asked = FS.proto.ask === `${p},${q},${b.slot}`, n = (b.tiles ?? []).length;
    const at = html`data-p="${p}" data-q="${q}" data-slot="${b.slot}"`;
    body = html`${lines(pm.bannerLines(FS, p, q, b, land.resolvedNext))}
      ${!own ? '' : asked
        ? html`<p class="pop-line">${L`この旗を取り下げます。${fmtNum(n)}マスは、誰のものでもない土地に戻ります。`}</p>
          <div class="actions"><button type="button" class="btn small quiet" data-act="proto-strike-tile" ${at} data-on="">${L`やめる`}</button><button type="button" class="btn small primary" data-act="proto-strike" ${at} ${off(held)}>${L`取り下げる（−${fmtNum(n)}マス）`}</button></div>`
        : html`<div class="actions"><button type="button" class="btn small" data-act="proto-strike-tile" ${at} data-on="1" ${off(held)}>${L`旗を取り下げる`}</button></div>`}
      ${own && held ? html`<p class="muted">${held}</p>` : ''}`;
  } else if (k.kind === 'village') {
    const mine = (FS.holdings ?? []).some(h => h.p === p && h.q === q && h.site === k.site);
    const v = (land.villages ?? []).find(x => x.site === k.site) ?? null;
    const n = land.claim.filter(c => c === k.site).length;
    if (!int(siteOwner) && int(v?.nation)) siteOwner = v.nation;
    body = html`<p class="pop-line proto-line">${mine ? L`村の土地 ${fmtNum(n)}マス（あなたの土地）` : int(siteOwner) ? L`${factionName(siteOwner)}の村の土地 ${fmtNum(n)}マス` : L`村の土地 ${fmtNum(n)}マス`}</p>`;
  } else if (k.kind === 'open') {
    const holder = int(land.holderNation) ? land.holderNation : null;
    body = html`<p class="pop-line proto-line">${holder === nation ? L`国の共有地（まだ誰の旗もありません）` : holder !== null ? L`${factionName(holder)}の共有地（まだ誰の旗もありません）` : L`まだ誰の旗もありません`}</p>`;
  } else return provinceCard(FS, p, q);
  return html`<section class="proto-tile"><h4 class="proto-h">${icon('flag')}${L`このマスの土地`}${tagHtml()}</h4>${body}</section>${provinceCard(FS, p, q)}`;
}

// ------------------------------------------------------------------ the legend and the Scout's card
/** The legend's one entry. '' with the prototype off. */
export function legend(FS) {
  if (!FS.proto) return '';
  return html`<section class="vcard proto-legend-hud" aria-labelledby="proto-legend-t"><h3 id="proto-legend-t" class="proto-h">${icon('flag')}${L`旗の土地`}${tagHtml()}</h3>
    <p>${L`旗の土地・国の共有地・村の土地の色分けは、設計中の「旗のルール」の試作です。`}</p>
    <p class="proto-note">${pm.labelText(FS.proto.claims)}</p></section>`;
}

/** The Scout's card: 今日の探索：あと2マス. '' with the prototype off. */
export function exploreLine(FS) {
  const m = FS.proto ? pm.plateModel(FS) : null;
  if (!m || m.explore === null) return '';
  return html`<p class="pop-line proto-place${m.explore > 0 ? '' : ' no'}">${tagHtml()}<span>${m.explore > 0 ? L`今日の探索：あと${fmtNum(m.explore)}マス` : pm.refusalText('ExploreLimit')}</span></p>`;
}

/**
 * Why the guide opened the training card or the new host's card for the step of walking a banner (`FS.hand.protoWhy`):
 * one line of the prototype on that card. '' otherwise.
 */
export function whyLine(FS) {
  if (!FS.proto || FS.hand?.protoWhy !== 'walk') return '';
  return html`<p class="pop-line proto-place ok">${tagHtml()}${icon('flag')}<span>${L`旗の土地に新しく立った軍勢が見回れます`}</span></p>`;
}

// ------------------------------------------------------------------ the guide (PROTOTYPE-SPEC section 8)
/** The guide's step as the page's one "next thing" (hud/hud.mjs nextThing's shape), or null. */
export function guideNext(FS) {
  const g = FS.proto ? pm.guideModel(FS) : null;
  if (!g) return null;
  const kicker = L`旗のガイド（試作） ${fmtNum(g.n + 1)}/${fmtNum(g.total)}`;
  const go = g.go ?? { act: 'proto-guide', data: { go: 'steps' }, label: '' };
  return { kind: 'guide', proto: true, icon: 'flag', kicker, title: g.title, label: go.label, text: go.label ? L`${kicker}：${g.title}（${go.label}）` : L`${kicker}：${g.title}`, hint: g.text, act: go.act, data: go.data ?? {}, more: 0 };
}
/** The guide's sentence for its step `id`, as one line of the prototype on the card that step opens ('' when the guide is at another step). */
export function stepLine(FS, id) {
  const g = FS.proto ? pm.guideModel(FS) : null;
  return g && g.current === id && g.text ? html`<p class="pop-line proto-place ok">${tagHtml()}${icon('flag')}<span>${g.text}</span></p>` : '';
}
/**
 * The bar's one line for a fighting host that is in hand with no card open while the guide is at the march: on a
 * phone the march is chosen on the board with no sheet over it, and nothing said what to press. Null otherwise.
 */
export function armedNote(FS, model) {
  if (!FS.proto || model?.kind !== 'host' || model.pop || !model.march?.ok || !pm.fights(model.host)) return null;
  const g = pm.guideModel(FS);
  // (a wide screen has room for the guide's own sentence before it; a phone's bar says the short line alone)
  if (!(g?.current === 'march' && g.go?.data?.go === 'march')) return null;
  // (a phone has no pointer to rest on a tile, and the ground to march to is unexplored parchment: nothing showed
  // where a banner could rise. The world was asked about every tile of that province for this host — the preview
  // route —, and the widest of its answers is one press away; any other tile can still be pressed)
  const b = FS.proto.marchBest ?? null, best = b && String(b.host) === String(model.host.id) && int(b.tile) && pm.landOf(FS, b.p, b.q)?.resolvedNext === b.r ? b : null;
  return html`${tagHtml()}<span class="an-long">${g.text} </span>${L`行き先のマスを押します：つぎの旗は、進軍した先に立てられます`}${best
    ? html` <button type="button" class="btn small primary an-best" data-act="proto-march-best" data-p="${best.p}" data-q="${best.q}" data-tile="${best.tile}">${icon('flag')}${L`いちばん広く取れるマスを選ぶ（+${fmtNum(best.size)}マス）`}</button>` : ''}`;
}
/**
 * The guide's step as one line for a phone while a sheet, a card or the hand has the foot of the screen (the resting
 * sheet's own line is not in sight then): the step by name with its one press. '' with the prototype off or no step.
 */
export function guideStrip(FS) {
  const g = guideNext(FS);
  if (!g) return '';
  const attrs = raw(Object.entries(g.data ?? {}).map(([k, v]) => `data-${String(k).replace(/[^\w-]/g, '')}="${String(v).replace(/[^\w.,:-]/g, '')}"`).join(' '));
  return html`<button type="button" class="proto-strip" data-act="${g.act}" ${attrs} aria-label="${L`次にやること：${g.text}`}">${icon('flag')}<span class="ps-k">${g.kicker}</span><strong class="ps-t">${g.title}</strong>${g.label ? html`<span class="ps-do">${g.label}</span>` : ''}</button>`;
}
/** The guide's steps as a card (the drawer's guide, above the page's own). '' with the prototype off or when all is done. */
export function guideCard(FS) {
  const g = FS.proto ? pm.guideModel(FS) : null;
  if (!g) return '';
  const attrs = d => raw(Object.entries(d ?? {}).map(([k, v]) => `data-${String(k).replace(/[^\w-]/g, '')}="${String(v).replace(/[^\w.,:-]/g, '')}"`).join(' '));
  return html`<section class="vcard onboarding proto-guide" aria-labelledby="proto-guide-t"><h3 id="proto-guide-t" class="proto-h">${icon('flag')}${L`旗のガイド`}${tagHtml()}<span class="pg-n num">${fmtNum(g.n)}/${fmtNum(g.total)}</span></h3>
    <ol class="checklist">${g.steps.map(s => html`<li class="${s.status === 'done' ? 'done' : s.status === 'current' ? 'now' : ''}" ${raw(s.status === 'current' ? 'aria-current="step"' : '')}><span class="ck-mark" aria-hidden="true">${s.status === 'done' ? icon('check') : ''}</span><span class="ck-name">${s.name ?? pm.stepName(s.id)}</span></li>`)}</ol>
    <div class="ck-now"><p>${g.text}</p>${g.go ? html`<div class="actions"><button type="button" class="btn primary" data-act="${g.go.act}" ${attrs(g.go.data)}>${g.go.label}</button></div>` : ''}</div>
    <p class="proto-note">${pm.labelText(FS.proto.claims)}</p></section>`;
}

// ------------------------------------------------------------------ this turn's list
/**
 * What the prototype adds to "next" of this turn's list (hud/turnlist.mjs): the counts of the viewer's hosts, a
 * banner of the viewer's under threat or another nation's banner about to rise on our ground (with 軍勢を送る), a
 * banner of the viewer's that is frayed or whose walk is near. Each
 * line starts with 試作. `[{icon, text, tone, go, send?}]`; [] with the prototype off.
 */
export function turnItems(FS) {
  if (!FS.proto) return [];
  const t = pm.tag();
  return [
    ...pm.threatsOf(FS).map(x => ({ icon: 'alert', tone: 'warn', text: L`${t}：${x.text}`, go: { p: x.p, q: x.q, tile: x.tile }, send: { p: x.p, q: x.q, tile: x.tile } })),
    // (a banner of the viewer's that is frayed, or whose walk is near: what the coming turns hold for it, with 見る)
    ...pm.walksDue(FS).map(x => ({ icon: 'flag', tone: x.kind === 'frayed' ? 'warn' : '', text: L`${t}：${x.text}`, go: { p: x.p, q: x.q, tile: x.tile } })),
    ...pm.risingOwn(FS).map(x => ({ icon: 'flag', text: L`${t}：${x.text}`, go: { p: x.p, q: x.q, tile: x.tile } })),
  ];
}
