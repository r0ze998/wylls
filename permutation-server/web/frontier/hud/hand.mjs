// The hand (UX design 14.2): select a thing, act on the board.
//
// Selecting the viewer's own village or one of the viewer's own hosts puts
// that thing's ACTION BAR where the dock stands (bottom centre; on a phone
// above the tab bar): bell-metal buttons of 56 px, each an icon, a word
// and one live figure. A button that cannot be pressed now says why in
// its own place, in the rule's numbers. The dock comes back when the
// selection goes.
//
//   the village   建てる · 訓練 · 編成 · 収穫 · 昇格
//   a host        進軍 · 探索 (a Scout host) · 村へ戻す · 解散 · 次の軍勢
//
// A press either sends the one instruction (収穫), arms the board (進軍: the
// reach is lit and a tap on a tile is the order), or opens the bar's small
// card above it (the build fan over the village, the units to train, the
// tile and the troops of a new host, the promotion, the tiles a Scout
// explores, the dissolving of a host). No order needs the drawer.
//
// Pure: the subject and the model from the store, the markup from the
// model. app.mjs puts it in the page, places the fan over the village
// through the map's own projection, and turns `data-act` into orders
// (controller.mjs). Every number comes from hud/rulebook.mjs.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { RESOURCES, RESOURCE_ORDER, UNITS, TIERS, BUILDINGS, unitCount } from '../fi18n.mjs';
import { UNIT_ORDER, SCOUT, SETTLER, buildItemOf } from '../fland.mjs';
import { RULES, DEPART_STAMINA } from '../fmarch.mjs';
import { MAX_PATH_STEPS } from '../seal.mjs';
import { tileHex, TILE_OFFSETS } from '../fgeo.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';
import { holdingName } from '../people/ui.mjs';
import { holdingModel, provisionalNote } from '../screens/holding.mjs';
import { hostState } from '../screens/host.mjs';
import { directionOf } from '../screens/explore.mjs';
import { ring } from '../screens/parts.mjs';
import { icon, RESOURCE_ICON } from './icons.mjs';
import { tileName, provinceName } from './place.mjs';
import { grownSince, trainCost, maxTrain, shortOf, HOST_TROOPS, WORKED_RADIUS, UNIT_STATS } from './rulebook.mjs';
import { costChips, costWords, shortWords, took, unitGood, unitStrength, whyText, exploreResultTurn, exploreResultLine } from './orderparts.mjs';
import * as proto from './proto.mjs';
import { previewOf } from '../proto/hand-model.mjs';
import { conquestOn, renderKeepsPop, waitOf, holdTurns } from './keephand.mjs';

const int = Number.isInteger;
const nowOf = FS => FS.chain?.now?.() ?? 0;
const bellOf = FS => FS.nowBell ?? 0;

/**
 * The order's own word, 進軍 (an empty value gives it a key of its own: the dock's tab is the same word in Japanese
 * and "Marches" in English, and the order is "March").
 */
const MARCH_WORD = () => L`${''}進軍`;
/** The cards the bar opens above itself. */
export const POPS = Object.freeze(['build', 'train', 'muster', 'promote', 'explore', 'dissolve', 'march']);
/** The card of the prototype rule "banners" (hud/proto.mjs): it can open only while the sample world's season record carries the prototype (`FS.proto`). */
export const PROTO_POPS = Object.freeze(['banner']);
/** The card of a conquest season (program version 3; hud/keephand.mjs): the keeps the host can reach. It can open only on such a season. */
export const CONQUEST_POPS = Object.freeze(['keeps']);

export { ownHostsAt, ownHosts, marchCheck, exploreCheck, dissolveCheck, canAct, subjectOf, popOf } from './subject.mjs';
import { ownHosts, marchCheck, exploreCheck, dissolveCheck, canAct, subjectOf, popOf } from './subject.mjs';

// ------------------------------------------------------------------ the model
const hexDist = (a, b) => (a && b ? (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs((a.q + a.r) - (b.q + b.r))) / 2 : null);

/** What has grown since the last settling, as the 収穫 button's figure and its words. */
export function harvestModel(m) {
  const grown = grownSince(m.rawHolding ?? m.holding, m.now);
  const total = grown.reduce((a, x) => a + Math.max(0, x), 0);
  const full = m.stores.filter(s => s.cap > 0 && s.value >= s.cap);
  // (what the stores gain in an hour, all goods together: said on the button while nothing waits to be settled)
  const perHour = m.stores.reduce((a, s) => a + (s.cap > 0 && s.value >= s.cap ? 0 : Math.max(0, Number(s.perHour) || 0)), 0);
  return { grown, total, perHour, full: full.map(s => s.resource), parts: grown.map((n, i) => ({ resource: RESOURCE_ORDER[i], n })).filter(x => x.n > 0) };
}

/** The reserve's kinds that can form a host, most troops first: `[{unit, troops}]`. */
export const reserveOf = m => m.facts.reserve.filter(r => r.unit !== SETTLER && r.troops > 0).sort((a, b) => b.troops - a.troops);

function villageModel(FS, sub) {
  const m = holdingModel({ ...FS, activeHolding: sub.holdingIndex });
  if (!m) return null;
  const h = m.settled, tier = Number(h.tier ?? 0);
  const provisional = m.facts.state === 'provisional';
  const reserve = reserveOf(m), musterable = reserve.reduce((a, r) => a + r.troops, 0);
  const hv = harvestModel(m);
  const running = m.queue.find(q => q.running) ?? m.queue[0] ?? null;
  const freeIn = m.queue.length >= m.slots ? Math.min(...m.queue.map(q => q.doneIn)) : 0;
  const cheapest = shortOf(trainCost(0, 100, FS.season?.programVersion), m.have);
  const musterBlock = m.blocks.Muster.includes('NotFinal') ? 'NotFinal' : !reserve.some(r => r.troops >= HOST_TROOPS.min) ? 'NoReserve' : m.blocks.Muster[0] ?? null;
  const promo = m.promotion;
  const buttons = [
    { id: 'build', icon: 'hammer', word: L`建てる`, act: 'hand-pop', data: { pop: 'build' },
      figure: m.queue.length ? took(running.doneIn) : L`空き ${fmtNum(m.slots)}`, rings: m.queue.length ? Array.from({ length: m.slots }, (_, i) => (m.queue[i] ? { share: m.queue[i].share ?? 0, on: true } : { share: 0, on: false })) : null,
      tone: m.queue.length >= m.slots ? 'warn' : '', hint: m.queue.length >= m.slots ? whyText('QueueFull', { tier, freeIn }) : L`建設中 ${fmtNum(m.queue.length)}/${fmtNum(m.slots)}` },
    { id: 'train', icon: 'helmet', word: L`訓練`, act: 'hand-pop', data: { pop: 'train' }, figure: L`控え ${fmtNum(musterable)}`,
      tone: cheapest.length ? 'warn' : '', hint: cheapest.length ? shortWords(cheapest) : L`訓練はすぐに終わり、兵は控えに入ります` },
    { id: 'muster', icon: 'ranks', word: L`編成`, act: 'hand-pop', data: { pop: 'muster' }, figure: fmtNum(musterable),
      why: musterBlock ? (musterBlock === 'NotFinal' ? whyText('NotFinal') : whyText(musterBlock)) : null, hint: L`控えの兵を軍勢にして、州のマスに集めます` },
    { id: 'harvest', icon: 'grain', word: L`収穫`, act: 'harvest', data: {},
      // (nothing has grown since the last settling — any order settles the stores —: the figure says what an hour brings, not a dead "+0")
      figure: hv.full.length ? L`満杯 ${fmtNum(hv.full.length)}` : hv.total > 0 ? L`+${fmtNum(hv.total)}` : hv.perHour > 0 ? L`毎時 +${fmtNum(hv.perHour)}` : L`+${fmtNum(0)}`, tone: hv.full.length ? 'bad' : '',
      why: m.blocks.Harvest.length ? whyText(m.blocks.Harvest[0]) : null,
      hint: hv.full.length ? L`${hv.full.map(r => RESOURCES[r]).join(' / ')}が満杯：これ以上は増えません。使いましょう` : harvestHint(hv) },
    promo ? { id: 'promote', icon: 'tierup', word: L`昇格`, act: 'hand-pop', data: { pop: 'promote' },
      figure: promo.running ? L`あと ${took(promo.doneIn)}` : L`${TIERS[promo.to]}へ`, tone: promo.running ? 'busy' : promo.blocks.length ? 'warn' : '',
      hint: promo.running ? L`${TIERS[promo.to]}へ昇格中` : promo.short.length ? shortWords(promo.short) : L`${TIERS[promo.to]}へ：${costWords(promo.cost)}` }
      : { id: 'promote', icon: 'tierup', word: L`昇格`, act: 'hand-pop', data: { pop: 'promote' }, figure: '', why: whyText('TopTier') },
  ];
  const name = holdingName(sub.holding);
  return { kind: 'village', key: `v:${sub.holding.p},${sub.holding.q},${sub.holding.site}`, name, label: L`${name}の行動`, icon: 'home',
    sub: provisional ? L`仮の村` : TIERS[tier] ?? '', note: provisional ? provisionalNote(FS, sub.holding) : null,
    chips: sub.hosts.map(r => hostChip(FS, r)), buttons, m, hv, reserve, musterable, promo, tier, provisional };
}
/** The 収穫 button's words: what has grown, and that the strip already counts it (the instruction settles; it gives nothing more). */
const harvestHint = hv => (hv.parts.length
  ? L`前の収穫から ${hv.parts.map(x => `${RESOURCES[x.resource]} +${fmtNum(x.n)}`).join(' · ')}（上の数字にもう入っています）。押すと蔵の記録に納めます`
  : hv.perHour > 0 ? L`いまは納めるものがありません（命令のたびに蔵は納められます）。蔵は毎時 +${fmtNum(hv.perHour)} 増えています` : L`蔵は時間で増えます。押すと蔵の記録に納めます`);

const hostChip = (FS, r) => ({ id: r.id, unit: r.unit, text: unitCount(UNIT_ORDER[r.unit], r.troops), state: hostState(r, bellOf(FS)), ready: canAct(FS, r) });

function hostModel(FS, sub) {
  const r = sub.host, h = sub.holding;
  const faction = int(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const mc = marchCheck(FS, r), dc = dissolveCheck(FS, r);
  const ex = r.unit === SCOUT ? exploreCheck(FS, r) : null;
  const all = ownHosts(FS);
  const at = all.findIndex(x => x.id === r.id);
  const pop = popOf(FS, sub);
  // (the board is armed for a march as soon as a host that can march is selected: its reach is lit and a tap is the order)
  const armed = mc.ok && pop !== 'explore' && pop !== 'dissolve';
  const from = tileHex(r.p, r.q, r.tile), home = h ? tileHex(h.p, h.q, h.tile) : null;
  const away = hexDist(from, home);
  const name = unitCount(UNIT_ORDER[r.unit], r.troops);
  const st = hostState(r, bellOf(FS));
  const where = r.home ? L`${holdingName(h)}にいます` : L`${tileName(FS, r.p, r.q, r.tile)}（${provinceName(FS, r.p, r.q)}）にいます`;
  const buttons = [
    { id: 'march', icon: 'march', word: MARCH_WORD(), act: 'hand-march', data: { host: r.id }, figure: L`体力 ${fmtNum(r.stamina)}/${fmtNum(RULES.STAMINA_CAP)}`, pressed: armed, why: mc.ok ? null : mc.text,
      hint: L`行き先のマスを押します。体力を ${fmtNum(DEPART_STAMINA)} 使い、着くのは 2 ターン先からです` },
    // a conquest season: the keeps this host can reach, as a list (hud/keephand.mjs). A host that cannot depart yet may still
    // open it: the list then says from which turn it can go (never a dead end)
    ...(conquestOn(FS) && r.unit !== SCOUT && r.unit !== SETTLER ? [{ id: 'keeps', icon: 'flag', word: L`砦へ進軍`, act: 'hand-pop', data: { pop: 'keeps' }, figure: L`${fmtNum(holdTurns(FS))} ターンで奪取`, pressed: pop === 'keeps',
      why: r.inTransit ? mc.text : null, tone: waitOf(FS, r) ? 'warn' : '', hint: L`この軍勢が届く他国の砦を一覧にします。行を選ぶと、その砦への命令の紙が開きます` }] : []),
    ...(ex ? [{ id: 'explore', icon: 'scout', word: L`探索`, act: 'hand-pop', data: { pop: 'explore' }, figure: ex.ok ? L`${fmtNum(ex.targets.length)} マス` : '', pressed: pop === 'explore', why: ex.ok ? null : ex.text,
      hint: L`となりのマスを 2 つまで調べます` }] : []),
    { id: 'return', icon: 'home', word: L`村へ戻す`, act: 'hand-return', data: { host: r.id }, figure: r.home ? '' : L`${fmtNum(away ?? 0)} マス先`, why: r.home ? whyText('AtHome') : mc.ok ? null : mc.text,
      hint: L`村への進軍です（体力 ${fmtNum(DEPART_STAMINA)}）。封をする前に確かめます` },
    { id: 'dissolve', icon: 'disband', word: L`解散`, act: 'hand-pop', data: { pop: 'dissolve' }, figure: L`控えへ ${fmtNum(r.troops)}`, pressed: pop === 'dissolve', why: dc.ok ? null : dc.text, quiet: true,
      hint: L`このターンの決着のあと、兵は村の控えに戻ります` },
    { id: 'next', icon: 'next', word: L`次の軍勢`, act: 'hand-next', data: {}, figure: all.length ? `${fmtNum(Math.max(0, at) + 1)}/${fmtNum(all.length)}` : '', why: all.length < 2 ? whyText('OnlyOne') : null,
      hint: L`このターンに動かせる軍勢から順に選びます` },
  ];
  // the prototype rule "banners" (hud/proto.mjs; only while the sample world serves it): what this host can do with a banner where it stands, first on the bar
  const flag = FS.proto ? proto.bannerButton(FS, r, pop) : null;
  if (flag) buttons.unshift(flag);
  // (one reason that keeps two or more of the bar's buttons from being pressed — the host is forming up, it is short of
  // stamina, the province has not caught up with the turn — is said once, on the bar's own line under the host's name,
  // and those buttons keep their figures: the same sentence stood on three buttons in two lines each, the bar grew wider
  // than its place and its last button was cut off by its edge. The English recording of 2026-10-11)
  const shared = sharedWhy(buttons);
  if (shared) for (const b of buttons) if (b.why === shared) b.said = true;
  // (a host that is forming up says so under its name already — 「編成中（次のターンから）」 —: the line is not said a second time)
  const note = shared && !(mc.code === 'Forming' && shared === mc.text) ? shared : null;
  return { kind: 'host', key: `h:${r.id}`, name, label: L`${name}の行動`, unit: r.unit, faction, sub: st.text, tone: st.tone, where, note, noteTone: note ? 'why' : null,
    chips: sub.hosts.length > 1 ? sub.hosts.filter(x => x.id !== r.id).map(x => hostChip(FS, x)) : [], villageHere: r.home ? holdingName(h) : null,
    buttons, host: r, march: mc, explore: ex, dissolve: dc, armed, away, stamina: r.stamina };
}

/**
 * The bar's model, or null when the hand is empty: `{kind, key, name, label, sub, buttons: [{id, icon, word,
 * figure, why (the reason it cannot be pressed, or null), tone, pressed, act, data, hint, rings?}], chips, pop,
 * ordersThisTurn}`.
 */
export function handModel(FS) {
  const sub = subjectOf(FS);
  if (!sub) return null;
  const model = sub.kind === 'village' ? villageModel(FS, sub) : hostModel(FS, sub);
  if (!model) return null;
  model.subject = sub;
  model.pop = popOf(FS, sub);
  // (the prototype rule "banners": what to press while the guide's march is armed on the board with no card open)
  if (FS.proto && !model.note) { const n = proto.armedNote(FS, model); if (n) { model.note = n; model.noteTone = 'proto'; } }
  for (const b of model.buttons) if (b.act === 'hand-pop' && b.data.pop === model.pop) b.pressed = true;
  model.orders = (FS.orders ?? []).filter(o => o.turn === bellOf(FS)).length;
  return model;
}

/** The reason two or more of a bar's buttons share for not being pressable (the one most of them share), or null. */
export function sharedWhy(buttons) {
  const n = new Map();
  for (const b of buttons) if (b.why) n.set(b.why, (n.get(b.why) ?? 0) + 1);
  const top = [...n].sort((x, y) => y[1] - x[1])[0] ?? null;
  return top && top[1] >= 2 ? top[0] : null;
}

// ------------------------------------------------------------------ the bar
const dataAttrs = d => raw(Object.entries(d ?? {}).map(([k, v]) => `data-${String(k).replace(/[^\w-]/g, '')}="${String(v).replace(/[^\w.,:-]/g, '')}"`).join(' '));
const unitPic = (f, unit, size = 40) => html`<img class="unit-card f${f}" src="${miniCardUrl(f, MINI_KINDS[unit])}" alt="" width="${size}" height="${Math.round(size * 1.25)}" decoding="async">`;

/** The slots of the build queue as small rings (a filled ring: something is under way, as far as its share). */
const slotRings = rings => html`<span class="hand-rings" aria-hidden="true">${rings.map(r => html`<span class="hand-ring${r.on ? ' on' : ''}">${ring(r.on ? Math.max(0.04, r.share) : 0)}</span>`)}</span>`;

function button(b) {
  const off = !!b.why;
  // (a button that cannot be pressed stays in the tab order and says why: `aria-disabled`, never the `disabled` attribute)
  return html`<button type="button" class="hand-btn hand-${b.id}${b.proto ? ' hand-proto' : ''}${b.tone ? ` tone-${b.tone}` : ''}${b.quiet ? ' quiet' : ''}${off ? ' off' : ''}" data-act="${b.act}" data-hand="${b.id}" ${dataAttrs(b.data)}
    ${raw(off ? 'aria-disabled="true"' : '')} ${raw(b.pressed !== undefined ? `aria-pressed="${b.pressed && !off ? 'true' : 'false'}"` : '')} title="${off ? b.why : b.hint ?? ''}">
    <span class="hand-ic">${icon(b.icon)}</span><span class="hand-word">${b.word}</span>${b.proto ? proto.tagHtml() : ''}
    ${off && !b.said ? html`<span class="hand-why">${b.why}</span>` : html`<span class="hand-fig">${b.rings ? slotRings(b.rings) : ''}<span class="num">${b.figure}</span></span>`}
  </button>`;
}

const chipHtml = c => html`<button type="button" class="hand-chip${c.ready ? ' ready' : ''}" data-act="hand-host" data-host="${c.id}" title="${c.state.text}" aria-label="${L`${c.text}を選ぶ（${c.state.text}）`}">${icon(c.unit === SCOUT ? 'scout' : 'sword')}<span>${c.text}</span></button>`;

/** The action bar (`#hand`): who has the hand, its buttons, and the way back to the dock. */
export function renderHand(model) {
  if (!model) return '';
  const head = model.kind === 'village'
    ? html`<span class="hand-medal">${icon('home')}</span><span class="hand-who"><strong class="hand-name">${model.name}</strong><span class="hand-sub">${model.sub}</span></span>`
    : html`<span class="hand-medal hand-unit">${unitPic(model.faction, model.unit, 32)}</span><span class="hand-who"><strong class="hand-name">${model.name}</strong><span class="hand-sub tone-${model.tone ?? ''}">${model.sub}</span></span>`;
  return html`<div class="hand-head">${head}
      ${model.kind === 'host' && model.villageHere ? html`<button type="button" class="hand-chip hand-back" data-act="hand-host" data-host="" aria-label="${L`${model.villageHere}を選ぶ`}">${icon('home')}<span>${model.villageHere}</span></button>` : ''}
      ${model.chips.length ? html`<span class="hand-chips" role="group" aria-label="${L`このマスの軍勢`}">${model.chips.map(chipHtml)}</span>` : ''}
      <span class="hand-tools">
        <button type="button" class="hand-tool" data-act="hand-turn" aria-label="${L`このターンの命令（${fmtNum(model.orders)}）`}" title="${L`このターンの命令`}">${icon('list')}${model.orders ? html`<span class="hand-n num">${fmtNum(model.orders)}</span>` : ''}</button>
        <button type="button" class="hand-tool" data-act="hand-info" aria-label="${L`くわしく見る`}" title="${L`くわしく見る`}">${icon('info')}</button>
        <button type="button" class="hand-tool" data-act="hand-close" aria-label="${L`選択をやめる`}" title="${L`選択をやめる`}">${icon('close')}</button>
      </span></div>
    ${model.note ? html`<p class="hand-note${model.noteTone ? ` hand-note-${model.noteTone}` : ''}">${model.note}</p>` : ''}
    <div class="hand-acts" role="group" aria-label="${model.label}">${model.buttons.map(button)}</div>`;
}

// ------------------------------------------------------------------ the cards above the bar
const popHead = (title, sub = '') => html`<div class="pop-head"><strong class="pop-title">${title}</strong>${sub ? html`<span class="pop-sub">${sub}</span>` : ''}
  <button type="button" class="hand-tool pop-x" data-act="hand-pop" data-pop="" aria-label="${L`閉じる`}">${icon('close')}</button></div>`;

/** The build fan: the six buildings and the walls, each with the next copy's real cost, what it adds and how long it takes; one tap orders. */
function buildFan(model) {
  const { m, tier } = model;
  const blockedAll = m.blocks.Build[0] ?? null;
  const freeIn = m.queue.length >= m.slots ? Math.min(...m.queue.map(q => q.doneIn)) : 0;
  const tok = o => {
    const name = BUILDINGS[o.resource];
    const code = blockedAll ?? o.blocks[0] ?? null;
    const why = code ? whyText(code, { tier, freeIn, short: o.short, walls: o.kind === 'walls' }) : null;
    // (the queue is full: one reason for every building, said once under the card's head and not on each of them)
    const own = code === 'QueueFull' ? null : why;
    const gives = o.kind === 'walls' ? L`守り +100` : L`${RESOURCES[o.resource]} +${fmtNum(o.perHour)}/時`;
    return html`<button type="button" class="fan-tok${why ? ' off' : ''}${o.short.length ? ' short' : ''}" data-act="build" data-item="${o.item}" ${raw(why ? 'aria-disabled="true"' : '')}
      aria-label="${L`${name}を建てる：${gives}、${took(o.secs)}、${costWords(o.cost)}`}${why ? ` — ${why}` : ''}">
      <span class="fan-coin">${icon(o.kind === 'walls' ? 'wall' : RESOURCE_ICON[o.resource] ?? 'crate', `res-c-${o.resource}`)}</span>
      <strong class="fan-name">${name}${o.kind === 'building' && o.n > 1 ? html`<span class="fan-nth">${L`${fmtNum(o.n)}つ目`}</span>` : ''}</strong>
      <span class="fan-yield">${gives}</span>
      <span class="fan-cost">${costChips(o.cost, m.have)}</span>
      <span class="fan-time">${icon('hourglass')}${took(o.secs)}</span>
      ${own ? html`<span class="fan-why">${own}</span>` : ''}</button>`;
  };
  const full = (blockedAll ?? (m.queue.length >= m.slots ? 'QueueFull' : null)) === 'QueueFull' ? whyText('QueueFull', { tier, freeIn }) : null;
  const queue = m.queue.length ? html`<ol class="pop-queue" aria-label="${L`建設中`}">${m.queue.map(q => html`<li>${ring(q.share ?? 0)}<span>${q.item === 7 ? L`昇格` : BUILDINGS[buildItemOf(q.item)?.resource] ?? ''}</span><span class="num">${q.running ? L`あと ${took(q.doneIn)}` : L`待ち（あと ${took(q.doneIn)}）`}</span></li>`)}</ol>` : '';
  return html`${popHead(L`建てる`, L`建設中 ${fmtNum(m.queue.length)}/${fmtNum(m.slots)}`)}
    ${queue}${full ? html`<p class="pop-line pop-why fan-full">${full}</p>` : ''}
    <div class="fan" role="group" aria-label="${L`建てるもの`}">${m.offers.map(tok)}</div>`;
}

/** The count's stepper: −100, the number, +100, then presets. */
const countRow = (act, n, { min = 100, max = 0, presets = [], label }) => html`<div class="pop-count" role="group" aria-label="${label}">
  <button type="button" class="step-btn" data-act="${act}" data-n="${Math.max(min, n - 100)}" aria-label="${L`100 減らす`}" ${raw(n <= min ? 'disabled' : '')}>${icon('minus')}</button>
  <output class="pop-n num">${fmtNum(n)}</output>
  <button type="button" class="step-btn" data-act="${act}" data-n="${Math.min(max, n + 100)}" aria-label="${L`100 増やす`}" ${raw(n >= max ? 'disabled' : '')}>${icon('plus')}</button>
  <span class="pop-presets">${presets.filter(p => p.n >= min && p.n <= max).map(p => html`<button type="button" class="btn small" data-act="${act}" data-n="${p.n}" aria-pressed="${p.n === n ? 'true' : 'false'}">${p.text}</button>`)}</span></div>`;

/** The draft of a training order: `{unit, n, max, cost, short}` (the kind chosen, the count within what the stores pay for). */
export function trainDraft(FS, model) {
  const unit = int(FS.hand?.unit) && FS.hand.unit >= 0 && FS.hand.unit <= 6 ? FS.hand.unit : 0;
  const max = maxTrain(unit, model.m.have, FS.season?.programVersion);
  const n = Math.max(100, Math.min(Math.max(100, max), int(FS.hand?.n) ? FS.hand.n : 100));
  const cost = trainCost(unit, n, FS.season?.programVersion);
  return { unit, n, max, cost, short: shortOf(cost, model.m.have) };
}

function trainPop(FS, model) {
  const d = trainDraft(FS, model), f = model.m.faction;
  const blocked = model.m.blocks.Train[0] ?? null;
  const why = blocked ? whyText(blocked) : d.short.length ? shortWords(d.short) : null;
  const who = unitCount(UNIT_ORDER[d.unit], d.n);
  const tok = unit => {
    const c = trainCost(unit, 100, FS.season?.programVersion), can = maxTrain(unit, model.m.have, FS.season?.programVersion) >= 100;
    return html`<button type="button" class="unit-tok${can ? '' : ' short'}" data-act="hand-unit" data-unit="${unit}" aria-pressed="${unit === d.unit ? 'true' : 'false'}">
      ${unitPic(f, unit, 44)}<strong class="unit-tok-name">${UNITS[UNIT_ORDER[unit]]}</strong><span class="unit-tok-str">${unitStrength(unit)}</span>
      <span class="unit-tok-good">${unitGood(unit)}</span><span class="unit-tok-cost">${L`100人`}${costChips(c, model.m.have)}</span></button>`;
  };
  // (the prototype's one line of why the guide opened this card stands first: a phone shows the list and the order, and puts the card's last lines away)
  return html`${popHead(L`訓練`, L`控え ${fmtNum(model.musterable)}`)}${proto.whyLine(FS)}
    <div class="unit-toks" role="group" aria-label="${L`兵種`}">${UNIT_STATS.slice(0, 7).map((_, unit) => tok(unit))}</div>
    <div class="pop-foot">
      ${countRow('hand-n', d.n, { max: Math.max(100, d.max), presets: [{ n: 100, text: fmtNum(100) }, { n: 200, text: fmtNum(200) }, ...(d.max > 200 ? [{ n: d.max, text: L`最大 ${fmtNum(d.max)}` }] : [])], label: L`人数` })}
      <span class="pop-total">${costChips(d.cost, model.m.have)}</span>
      <button type="button" class="btn primary pop-go" data-act="train" data-unit="${d.unit}" data-n="${d.n}" ${raw(why ? 'aria-disabled="true"' : '')}>${icon('helmet')}${L`${who} を訓練する`}</button>
    </div>
    <p class="pop-line${why ? ' pop-why' : ''}">${why ?? L`訓練はすぐに終わり、兵は控えに入ります。`}</p>`;
}

/** The draft of a new host: `{unit, troops, max, tile (null: the village's own tile)}`: the whole reserve of the kind by default. */
export function musterDraft(FS, model) {
  const res = model.reserve;
  const pick = res.find(r => r.unit === FS.hand?.unit) ?? res[0] ?? null;
  const max = pick ? Math.min(HOST_TROOPS.max, pick.troops) : 0;
  const troops = Math.max(HOST_TROOPS.min, Math.min(max, int(FS.hand?.troops) ? FS.hand.troops : max));
  return { unit: pick?.unit ?? null, troops, max, tile: int(FS.hand?.tile) ? FS.hand.tile : null };
}

/** Where the new host of the open card would stand, as the prototype's preview is asked (proto/orders.mjs): `{p, q, tile, troops}`, or null for none or for Scouts. */
export function musterPlace(FS, model) {
  if (model?.kind !== 'village' || model.pop !== 'muster') return null;
  const d = musterDraft(FS, model), h = model.subject.holding;
  return d.unit === null || d.unit === SCOUT || d.max < HOST_TROOPS.min ? null : { p: h.p, q: h.q, tile: d.tile ?? h.tile, troops: d.troops };
}

function musterPop(FS, model) {
  const d = musterDraft(FS, model), f = model.m.faction, h = model.subject.holding;
  const block = model.m.blocks.Muster[0] ?? (d.unit === null || d.max < HOST_TROOPS.min ? 'NoReserve' : null);
  const why = block ? whyText(block) : null;
  const at = d.tile === null || d.tile === h.tile ? L`${holdingName(h)}（村のマス）` : tileName(FS, h.p, h.q, d.tile);
  const who = d.unit === null ? '' : unitCount(UNIT_ORDER[d.unit], d.troops);
  // (a low card: the board above it is where the tile is chosen)
  return html`${popHead(L`編成`, html`${icon('pin')}${L`集める場所：`}<strong>${at}</strong>`)}
    <div class="pop-foot pop-muster">
      <div class="unit-toks unit-toks-row" role="group" aria-label="${L`兵種`}">${model.reserve.map(r => html`<button type="button" class="unit-tok unit-tok-small${r.troops < HOST_TROOPS.min ? ' short' : ''}" data-act="hand-unit" data-unit="${r.unit}" aria-pressed="${r.unit === d.unit ? 'true' : 'false'}">
        ${unitPic(f, r.unit, 30)}<strong class="unit-tok-name">${UNITS[UNIT_ORDER[r.unit]]}</strong><span class="unit-tok-str num">${fmtNum(r.troops)}</span></button>`)}</div>
      ${d.unit === null ? '' : countRow('hand-troops', d.troops, { min: HOST_TROOPS.min, max: d.max, presets: [{ n: d.max, text: L`全部` }], label: L`兵数` })}
      <button type="button" class="btn primary pop-go" data-act="muster" data-unit="${d.unit ?? 0}" data-troops="${d.troops}" data-tile="${d.tile ?? h.tile}" ${raw(why ? 'aria-disabled="true"' : '')}>${icon('ranks')}${who ? L`${who} をここに集める` : L`ここに集める`}</button>
    </div>
    <p class="pop-line${why ? ' pop-why' : ' pop-rule'}">${why ?? L`線の内側のマスを押すと場所を変えられます（村のある州の、通れるマス）。軍勢は次のターンに整列します。`}</p>
    ${FS.proto && !why && musterPlace(FS, model) ? proto.placeLine(FS, previewOf(FS, musterPlace(FS, model))) : ''}${proto.whyLine(FS)}`;
}

function promotePop(FS, model) {
  const p = model.promo;
  if (!p) return html`${popHead(L`昇格`)}<p class="pop-line pop-why">${whyText('TopTier')}</p>`;
  const code = model.m.blocks.Build[0] ?? p.blocks[0] ?? null;
  const freeIn = model.m.queue.length >= model.m.slots ? Math.min(...model.m.queue.map(q => q.doneIn)) : 0;
  const why = code ? whyText(code, { tier: model.tier, freeIn, short: p.short }) : null;
  const g = p.gives;
  // (a thing the promotion leaves as it is says so: "2 → 2" read as a gain)
  const row = (ic, k, a, b) => html`<li class="${a === b ? 'same' : ''}">${icon(ic)}<span class="gain-k">${k}</span><span class="gain-v">${a === b ? html`<span class="num">${L`${b}（変わりません）`}</span>` : html`<span class="num">${a}</span>${icon('next', 'gain-to')}<strong class="num">${b}</strong>`}</span></li>`;
  return html`${popHead(L`${TIERS[p.from]}から${TIERS[p.to]}へ`, p.running ? L`昇格中 · あと ${took(p.doneIn)}` : took(p.secs))}
    <ul class="gains" aria-label="${L`昇格で変わること`}">
      ${row('grain', L`村の基本の産出`, `+${fmtNum(g.prodPct[0])}%`, `+${fmtNum(g.prodPct[1])}%`)}
      ${row('crate', L`蔵の上限（資源ごと）`, fmtNum(g.cap[0]), fmtNum(g.cap[1]))}
      ${row('hammer', L`同時に建てられる数`, fmtNum(g.slots[0]), fmtNum(g.slots[1]))}
      ${row('home', L`村のまわり（マス）`, fmtNum(g.radius[0]), fmtNum(g.radius[1]))}
    </ul>
    ${p.running ? '' : html`<div class="pop-foot"><span class="pop-total">${costChips(p.cost, model.m.have)}</span>
      <button type="button" class="btn primary pop-go" data-act="build" data-item="${p.item}" ${raw(why ? 'aria-disabled="true"' : '')}>${icon('tierup')}${L`${TIERS[p.to]}への昇格を始める`}</button></div>`}
    <p class="pop-line${why && !p.running ? ' pop-why' : ''}">${p.running ? L`終わると、村のまわりの土地がひとまわり広がります。` : why ?? (g.radius[1] > g.radius[0] ? L`建設の列をひとつ使います。終わると、村のまわりの土地がひとまわり広がります。` : L`建設の列をひとつ使います。`)}</p>`;
}

const DIR_TEXT = [() => L`東`, () => L`北東`, () => L`北西`, () => L`西`, () => L`南西`, () => L`南東`];
/** A tile next to a Scout by its direction, as a person says it. */
export const dirName = (from, to) => DIR_TEXT[directionOf(from, to)]?.() ?? L`となり`;

function explorePop(FS, model) {
  const r = model.host, ex = model.explore;
  const chosen = String(FS.explore?.host?.id ?? '') === r.id ? FS.explore.tiles ?? [] : [];
  const floor = FS.citizen?.exploresFloorLeft ?? 0;
  const why = ex?.ok ? null : ex?.text ?? null;
  // (a low card: the Scout's tiles are picked on the board above it)
  return html`${popHead(L`探索`, L`となりのマスを 2 つまで`)}
    <div class="pop-foot pop-explore">
      <div class="pop-picked" role="group" aria-label="${L`選んだマス`}">${chosen.length ? chosen.map(t => html`<button type="button" class="hand-chip picked" data-act="explore-tile" data-tile="${t}" aria-label="${L`${dirName(r.tile, t)}のマスを外す`}">${icon('eye')}<span>${dirName(r.tile, t)}</span>${icon('close', 'chip-x')}</button>`) : html`<span class="pop-none">${L`光っているマスを押して選びます`}</span>`}</div>
      <button type="button" class="btn primary pop-go" data-act="explore-send" ${raw(why || !chosen.length ? 'aria-disabled="true"' : '')}>${icon('scout')}${chosen.length ? L`${fmtNum(chosen.length)} マスを探索に出す` : L`探索に出す`}</button></div>
    <p class="pop-line${why ? ' pop-why' : ' pop-rule'}">${why ?? html`${exploreResultLine(exploreResultTurn(FS))}${floor > 0 ? L`はじめの探索はあと ${floor} 回、必ず功績 4 を得ます。` : L`マスごとに半々の確率で功績 4 を得ます。`}`}</p>
    ${proto.exploreLine(FS)}`;
}

function dissolvePop(FS, model) {
  const r = model.host;
  return html`${popHead(L`解散`)}
    <p class="pop-line">${L`${model.name} を解散します。このターンの決着のあと、兵は村の控えに戻ります。`}</p>
    <div class="pop-foot"><button type="button" class="btn pop-quiet" data-act="hand-pop" data-pop="">${L`やめる`}</button>
      <button type="button" class="btn primary pop-go pop-danger" data-act="dissolve" data-host="${r.id}" ${raw(model.dissolve.ok ? '' : 'aria-disabled="true"')}>${icon('disband')}${L`解散する`}</button></div>
    ${model.dissolve.ok ? '' : html`<p class="pop-line pop-why">${model.dissolve.text}</p>`}`;
}

/** The march's line while the board is armed: where a destination may be, and the two ways to a far one. */
function marchPop(FS, model) {
  return html`${popHead(MARCH_WORD(), L`体力 ${fmtNum(model.stamina)}/${fmtNum(RULES.STAMINA_CAP)}`)}
    <p class="pop-line">${L`行き先のマスを押します。線の内側は近くの ${fmtNum(6)} マス。その先も、道があれば ${fmtNum(MAX_PATH_STEPS)} マス・4 州まで選べます。`}</p>
    ${proto.stepLine(FS, 'march')}
    <div class="pop-foot pop-far"><button type="button" class="btn small" data-act="hand-far" data-how="chart">${icon('chart')}${L`全体図から選ぶ`}</button>
      <button type="button" class="btn small" data-act="hand-far" data-how="search">${icon('search')}${L`探して選ぶ`}</button></div>
    <p class="pop-line pop-rule">${L`どこへ行っても体力を ${fmtNum(DEPART_STAMINA)} 使います（1 ターンに 1 戻ります）。着くのは 2 ターン先から。山と水は通れません。`}</p>`;
}

/**
 * The card above the bar for `model.pop`, or '' when none stands open. `FS` gives the drafts (`FS.hand`: the unit and
 * the count of a training, the unit, troops and tile of a new host; `FS.explore`: the tiles picked for a Scout).
 */
export function renderPop(FS, model) {
  if (!model?.pop) return '';
  if (model.kind === 'village') {
    if (model.pop === 'build') return buildFan(model);
    if (model.pop === 'train') return trainPop(FS, model);
    if (model.pop === 'muster') return musterPop(FS, model);
    if (model.pop === 'promote') return promotePop(FS, model);
    return '';
  }
  if (model.pop === 'banner') return proto.bannerPop(FS, model);
  if (model.pop === 'explore') return explorePop(FS, model);
  if (model.pop === 'dissolve') return dissolvePop(FS, model);
  if (model.pop === 'march') return marchPop(FS, model);
  if (model.pop === 'keeps' && conquestOn(FS)) return renderKeepsPop(FS, model, { head: popHead });
  return '';
}

/** The tiles a new host may form up on: every passable tile of the village's own province with room for a host (six to a tile). */
export function musterTiles(FS, holding) {
  const prov = FS.provinces?.get?.(`${holding.p},${holding.q}`)?.province ?? null;
  if (!prov) return [];
  let mask = 0n;
  try { mask = BigInt(prov.passableMask ?? 0); } catch { mask = 0n; }
  const taken = new Map();
  for (const e of prov.entries ?? []) if (e.state >= 1 && e.state <= 2) taken.set(e.tile, (taken.get(e.tile) ?? 0) + 1);
  const out = [];
  for (let i = 0; i < TILE_OFFSETS.length; i++) if (((mask >> BigInt(i)) & 1n) === 1n && (taken.get(i) ?? 0) < 6) out.push({ p: holding.p, q: holding.q, tile: i });
  return out;
}

/** How far the village's land reaches now and after a promotion (tiles): the bar's promotion says the wider land truthfully. */
export const landRadius = tier => WORKED_RADIUS[Math.max(0, Math.min(3, Number(tier) || 0))];
