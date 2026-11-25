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
import { L, t, fmtNum } from '../../lang.mjs';
import { RESOURCES, RESOURCE_ORDER, UNITS, TIERS, BUILDINGS, unitCount, departRefusedReason } from '../fi18n.mjs';
import { UNIT_ORDER, SCOUT, SETTLER, buildItemOf } from '../fland.mjs';
import { RULES, DEPART_STAMINA } from '../fmarch.mjs';
import { MAX_PATH_STEPS } from '../seal.mjs';
import { tileHex, TILE_OFFSETS } from '../fgeo.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';
import { holdingName } from '../people/ui.mjs';
import { holdingModel, provisionalNote } from '../screens/holding.mjs';
import { hostState, hostRows } from '../screens/host.mjs';
import { musterIdleCode, allFormedText, allFormedShort, musterRuleText, formingHosts, stoodHosts, marchClosedReasonText } from './firststeps.mjs';
import { directionOf } from '../screens/explore.mjs';
import { ring } from '../screens/parts.mjs';
import { icon, RESOURCE_ICON } from './icons.mjs';
import { tileName, provinceName } from './place.mjs';
import { grownSince, trainCost, maxTrain, shortOf, HOST_TROOPS, WORKED_RADIUS, UNIT_STATS } from './rulebook.mjs';
import { costChips, costWords, shortWords, took, unitGood, unitStrength, whyText, exploreResultTurn, exploreResultLine } from './orderparts.mjs';
import * as proto from './proto.mjs';
import { delegationOf, handNote } from '../fdelegation.mjs';
import { previewOf } from '../proto/hand-model.mjs';
import { conquestOn, noContestableKeep, renderKeepsPop, waitOf, holdTurns } from './keephand.mjs';
import { EXPEDITION_POP, inspectionVersion } from '../fexpedition.mjs';
import { originalReturnModel } from '../fexpedition-return.mjs';
import { OUTBOUND_POP, outboundReadyOnce, outboundSketch, outboundArrivalCandidate, outboundRouteRefusal, outboundEndpointOpen } from '../fexpedition-compose.mjs';
import { localDepartOf, localDepartSpent } from '../flocalplay-depart.mjs';
import { devnetDepartOf } from '../fdevnet-depart.mjs';
import { localRevealOf, localRevealCandidate } from '../flocalplay-reveal.mjs';
import { localReturnOf, localReturnSpent } from '../flocalplay-return.mjs';
import { localConquestShown, localConquestSpent, localConquestReadFor, localConquestOrderFor, localConquestCityFor } from '../flocalplay-conquest.mjs';
import { hostStepInFlight } from '../flocalplay-hoststep.mjs';
import { provinceLag, PENDING_LAG_TURNS } from '../flocalplay-pending.mjs';
import { SETTLE_CODES } from '../flocalplay-pending.mjs';
import { localOrderRoute } from '../flocalplay-act.mjs';

import { composerChoices } from '../screens/march.mjs';

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
export const INSPECTION_POPS = Object.freeze([EXPEDITION_POP]);

export { ownHostsAt, ownHosts, marchCheck, exploreCheck, dissolveCheck, canAct, subjectOf, popOf } from './subject.mjs';
import { ownHosts, marchCheck, exploreCheck, dissolveCheck, canAct, subjectOf, popOf } from './subject.mjs';
import { returnCard } from './returncard.mjs';

// (round 25: local play sends only its own few orders — flocalplay-act.mjs LOCAL_ACT_NAMES — and refuses the rest when
//  they are sent. A bar button for an order local play refuses says so on the button and is not pressed, with the same
//  sentence the refusal says (controller.mjs localPlayReadOnly), instead of opening a card whose confirm is refused only
//  after it is pressed. Nothing local play can send changes; an ordinary session is as before.)
const localRefuses = (FS, name) => !!FS?.localPlay && localOrderRoute({ localPlay: FS.localPlay, name, v: {}, signer: undefined, requester: null }) === 'refuse';
const localReadOnlyText = () => L`ローカルプレイでは、まだ命令を送れません（読み取りのみ）。`;
/** The bar's line for the orders local play refuses, named by their buttons' words (B6): 「進軍」・「解散」 / March, Dissolve. */
export const localReadOnlyNamed = words => L`ローカルプレイでは、${words.map(w => L`「${w}」`).join(L`・`)}はまだ送れません（読み取りのみ）。`;
// (round 26: a march — the bar's March, its return home, a march on a keep — is sent in local play only while the march's
//  own answer is open (controller.mjs sendTheMarch: FS.localMarch.open), and refused with the same sentence otherwise)
/**
 * (fix-loop5, L5-8) Why the march buttons of this host are closed, by the march lane's own reason (LocalMarchGate: the
 * page's test key or connection could not be confirmed this moment; LocalMarchHeld: a march of it awaits its result…).
 * loop-play5 read 「「進軍」・「砦へ進軍」・「解散」はまだ送れません（読み取りのみ）」 in a --wide world whose march lane is
 * open — a passing closed answer worded as if local play never marched. Null when open.
 */
const localMarchWhy = (FS, r = null) => {
  if (!localMarchClosed(FS, r)) return null;
  const a = r && typeof FS.localMarchFor === 'function' ? FS.localMarchFor(r.holding ?? null, r.id ?? null) : FS.localMarch;
  return marchClosedReasonText(a?.reason);
};
const localMarchClosed = (FS, r = null) => {
  if (!FS?.localPlay) return false;
  // (round 27: for the host shown — its own village and its own held march — as its send would find it once composed)
  if (r && typeof FS.localMarchFor === 'function') return FS.localMarchFor(r.holding ?? null, r.id ?? null)?.open !== true;
  return FS.localMarch?.open !== true;
};

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
  // (every troop already in a host — the first host forming or standing: the idle muster reads as done, not as an error)
  let hostsNow = 0;
  try { const rows = hostRows(FS); hostsNow = formingHosts(rows).length + stoodHosts(rows).length; } catch { hostsNow = 0; }
  const allFormed = musterIdleCode({ reserve: musterable, hosts: hostsNow }) === 'allFormed';
  const promo = m.promotion;
  // (each figure says what it counts: 「25:00」 beside three rings, 「控え 400」, 「400」 and 「都市へ」 were read as codes:
  // the design review of 2026-10-24. The time is what is left; the reserve is people; a host takes up to that many; a
  // promotion the stores cannot pay says how many goods are short)
  const buttons = [
    { id: 'build', icon: 'hammer', word: L`建てる`, act: 'hand-pop', data: { pop: 'build' },
      figure: m.queue.length ? L`あと ${took(running.doneIn)}` : L`空き ${fmtNum(m.slots)}`, rings: m.queue.length ? Array.from({ length: m.slots }, (_, i) => (m.queue[i] ? { share: m.queue[i].share ?? 0, on: true } : { share: 0, on: false })) : null,
      tone: m.queue.length >= m.slots ? 'warn' : '', hint: m.queue.length >= m.slots ? whyText('QueueFull', { tier, freeIn }) : L`建設中 ${fmtNum(m.queue.length)}/${fmtNum(m.slots)}` },
    { id: 'train', icon: 'helmet', word: L`訓練`, act: 'hand-pop', data: { pop: 'train' }, figure: L`控え ${fmtNum(musterable)}人`,
      tone: cheapest.length ? 'warn' : '', hint: cheapest.length ? shortWords(cheapest) : L`訓練はすぐに終わり、兵は控えに入ります` },
    { id: 'muster', icon: 'ranks', word: L`編成`, act: 'hand-pop', data: { pop: 'muster' }, figure: L`最大 ${fmtNum(musterable)}人`, opens: true,
      why: musterBlock ? (musterBlock === 'NotFinal' ? whyText('NotFinal') : musterBlock === 'NoReserve' && allFormed ? allFormedShort() : whyText(musterBlock)) : null, hint: L`控えの兵を軍勢にして、州のマスに集めます` },
    { id: 'harvest', icon: 'grain', word: L`収穫`, act: 'harvest', data: {},
      // (nothing has grown since the last settling — any order settles the stores —: the figure says what an hour brings, not a dead "+0")
      figure: hv.full.length ? L`満杯 ${fmtNum(hv.full.length)}` : hv.total > 0 ? L`+${fmtNum(hv.total)}` : hv.perHour > 0 ? L`毎時 +${fmtNum(hv.perHour)}` : L`+${fmtNum(0)}`, tone: hv.full.length ? 'bad' : '',
      why: m.blocks.Harvest.length ? whyText(m.blocks.Harvest[0]) : null,
      hint: hv.full.length ? L`${hv.full.map(r => RESOURCES[r]).join(' / ')}が満杯：これ以上は増えません。使いましょう` : harvestHint(hv) },
    promo ? { id: 'promote', icon: 'tierup', word: L`昇格`, act: 'hand-pop', data: { pop: 'promote' },
      figure: promo.running ? L`あと ${took(promo.doneIn)}` : promo.short.length ? L`足りない ${fmtNum(promo.short.length)}` : L`${TIERS[promo.to]}へ`, tone: promo.running ? 'busy' : promo.blocks.length ? 'warn' : '',
      hint: promo.running ? L`${TIERS[promo.to]}へ昇格中` : promo.short.length ? shortWords(promo.short) : L`${TIERS[promo.to]}へ：${costWords(promo.cost)}` }
      : { id: 'promote', icon: 'tierup', word: L`昇格`, act: 'hand-pop', data: { pop: 'promote' }, figure: '', why: whyText('TopTier') },
  ];
  // (the read-only expedition check asks for a host this village issued: with none yet it has nothing to check, and on
  // a first visit it read as a second, unexplained action beside Build and Train — the first-session review of 2026-11-13)
  const name = holdingName(sub.holding);
  if (!FS.sample && !FS.proto && inspectionVersion(FS.season?.programVersion) && hostsNow > 0) buttons.push({
    id: EXPEDITION_POP, icon: 'search', word: L`遠征を確認`, act: 'hand-pop', data: { pop: EXPEDITION_POP },
    figure: L`読み取り専用`, quiet: true, hint: L`この村が発行した軍勢の番号で確認します。現在地や生存を意味しません。`,
  });
  // (the rank under the name, unless the name says it already: 「ラマールの町」 over 「町」)
  const rank = TIERS[tier] ?? '', said = !!rank && String(name).toLowerCase().includes(String(rank).toLowerCase());
  return { kind: 'village', key: `v:${sub.holding.p},${sub.holding.q},${sub.holding.site}`, name, label: L`${name}の行動`, icon: 'home',
    sub: provisional ? L`仮の村` : said ? '' : rank, note: provisional ? provisionalNote(FS, sub.holding) : null,
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
  const mc = marchCheck(FS, r), dc = dissolveCheck(FS, r), dLocal = localRefuses(FS, 'Dissolve'), mLocal = localMarchClosed(FS, r), eLocal = localRefuses(FS, 'Explore');
  const ex = r.unit === SCOUT ? exploreCheck(FS, r) : null;
  // (2026-11-16: 次の軍勢 counts and cycles the hosts of the host's OWN village — the press (app.mjs nextHost) goes there;
  //  a host of another village chosen by a plain tap or a chip read 1/N of the open village's hosts, which it is not among)
  const all = ownHosts({ ...FS, activeHolding: sub.holdingIndex });
  const at = all.findIndex(x => x.id === r.id);
  const pop = popOf(FS, sub);
  // (the board is armed for a march as soon as a host that can march is selected: its reach is lit and a tap is the order)
  const armed = mc.ok && pop !== 'explore' && pop !== 'dissolve' && pop !== EXPEDITION_POP && pop !== OUTBOUND_POP;
  const from = tileHex(r.p, r.q, r.tile), home = h ? tileHex(h.p, h.q, h.tile) : null;
  const away = hexDist(from, home);
  const name = unitCount(UNIT_ORDER[r.unit], r.troops);
  const st = hostState(r, bellOf(FS));
  const where = r.home ? L`${holdingName(h)}にいます` : L`${tileName(FS, r.p, r.q, r.tile)}（${provinceName(FS, r.p, r.q)}）にいます`;
  const buttons = [
    { id: 'march', icon: 'march', word: MARCH_WORD(), act: 'hand-march', data: { host: r.id }, figure: L`体力 ${fmtNum(r.stamina)}/${fmtNum(RULES.STAMINA_CAP)}`, pressed: armed, why: mLocal ? localMarchWhy(FS, r) : mc.ok ? null : mc.text,
      hint: L`行き先のマスを押します。体力を ${fmtNum(DEPART_STAMINA)} 使い、着くのは 2 ターン先からです` },
    // a conquest season: the keeps this host can reach, as a list (hud/keephand.mjs). A host that cannot depart yet may still
    // open it: the list then says from which turn it can go (never a dead end)
    // (not offered where no keep can be taken: a world opened only to the heartlands — noContestableKeep)
    ...(conquestOn(FS) && !noContestableKeep(FS) && r.unit !== SCOUT && r.unit !== SETTLER ? [{ id: 'keeps', icon: 'flag', word: L`砦へ進軍`, act: 'hand-pop', data: { pop: 'keeps' }, figure: L`${fmtNum(holdTurns(FS))} ターンで奪取`, pressed: pop === 'keeps',
      // (round 28: a march on a keep is composed from the host's own village too — controller.mjs cq-march —, so this
      //  button asks the same per-host answer as March and Return)
      why: r.inTransit ? mc.text : mLocal ? localMarchWhy(FS, r) : null, tone: waitOf(FS, r) ? 'warn' : '', hint: L`この軍勢が届く他国の砦を一覧にします。行を選ぶと、その砦への命令の紙が開きます` }] : []),
    ...(ex ? [{ id: 'explore', icon: 'scout', word: L`探索`, act: 'hand-pop', data: { pop: 'explore' }, figure: ex.ok ? L`${fmtNum(ex.targets.length)} マス` : '', pressed: pop === 'explore', why: eLocal ? localReadOnlyText() : ex.ok ? null : ex.text,
      hint: L`となりのマスを 2 つまで調べます` }] : []),
    { id: 'return', icon: 'home', word: L`村へ戻す`, act: 'hand-return', data: { host: r.id }, figure: r.home ? '' : L`${fmtNum(away ?? 0)} マス先`, why: r.home ? whyText('AtHome') : mLocal ? localMarchWhy(FS, r) : mc.ok ? null : mc.text,
      hint: L`村への進軍です（体力 ${fmtNum(DEPART_STAMINA)}）。封をする前に確かめます` },
    { id: 'dissolve', icon: 'disband', word: L`解散`, act: 'hand-pop', data: { pop: 'dissolve' }, figure: L`控えへ ${fmtNum(r.troops)}`, pressed: pop === 'dissolve', why: dLocal ? localReadOnlyText() : dc.ok ? null : dc.text, quiet: true,
      hint: L`このターンの決着のあと、兵は村の控えに戻ります` },
    { id: 'next', icon: 'next', word: L`次の軍勢`, act: 'hand-next', data: {}, figure: all.length ? `${fmtNum(Math.max(0, at) + 1)}/${fmtNum(all.length)}` : '', why: all.length < 2 ? whyText('OnlyOne') : null,
      hint: L`このターンに動かせる軍勢から順に選びます` },
  ];
  // the prototype rule "banners" (hud/proto.mjs; only while the sample world serves it): what this host can do with a banner where it stands, first on the bar
  const flag = FS.proto ? proto.bannerButton(FS, r, pop) : null;
  if (flag) buttons.unshift(flag);
  if (!FS.sample && !FS.proto && inspectionVersion(FS.season?.programVersion)) buttons.push({
    id: EXPEDITION_POP, icon: 'search', word: L`遠征を確認`, act: 'hand-pop', data: { pop: EXPEDITION_POP },
    figure: L`読み取り専用`, pressed: pop === EXPEDITION_POP, quiet: true,
    hint: L`この軍勢を P,Q で確認します。移動や命令は行いません。`,
  });
  if (!FS.sample && !FS.proto && inspectionVersion(FS.season?.programVersion)) buttons.push({
    id: OUTBOUND_POP, icon: 'march', word: L`境界への道を準備`, act: 'hand-pop', data: { pop: OUTBOUND_POP },
    figure: L`送信しません`, pressed: pop === OUTBOUND_POP, quiet: true,
    hint: L`現在いるマスから六方向で道を組みます。地形・到着時刻は未検証です。`,
  });
  // (one reason that keeps two or more of the bar's buttons from being pressed — the host is forming up, it is short of
  // stamina, the province has not caught up with the turn — is said once, on the bar's own line under the host's name,
  // and those buttons keep their figures: the same sentence stood on three buttons in two lines each, the bar grew wider
  // than its place and its last button was cut off by its edge. The English recording of 2026-10-11)
  // (round 31: "the province has not caught up with the turn" comes and goes with the catch-up; said inside a single
  //  button it replaced that button's figure, the button changed width when the province caught up and the row moved
  //  under a pressing finger — a press aimed at 「砦へ進軍」 fell on its neighbour in a ×10 world. It is said on the bar's
  //  line even when only one button has it, and the button keeps its figure and its place.)
  const behind = mc.code === 'NotResident' && buttons.some(b => b.why === mc.text) ? mc.text : null;
  const shared = sharedWhy(buttons) ?? behind;
  if (shared) for (const b of buttons) if (b.why === shared) b.said = true;
  // (a host that is forming up says so under its name already — 「編成中（次のターンから）」 —: the line is not said a second time)
  // (round 19: while the forts card is open, its own wait slot says why its rows wait; the bar's line would be the same
  //  reason a second time, and the card stands on the bar — the line coming and going moved the card's rows under the
  //  pointer by its height. So with the forts card open and a wait to say there, the bar leaves the line to the card.)
  const toCard = pop === 'keeps' && !!waitOf(FS, r);
  const note0 = shared && !toCard && !(mc.code === 'Forming' && shared === mc.text) ? shared : null;
  // (round 27: local play's refusal is said in full on the bar's own line, which wraps — inside a button it was clipped to
  //  two short lines, "In local play, this order cannot be sent yet (rea…" in a live world; the refused buttons stay refused)
  // (the loop-play report B6: the bar's line said "this order cannot be sent yet" with nothing saying WHICH — it stood
  //  under a host whose March and March on a keep were sent normally, raised by Dissolve alone. The line names the
  //  refused orders by their buttons' own words; each refused button keeps the plain sentence as its title)
  const lro = localReadOnlyText(), localOff = buttons.filter(b => b.why === lro), localSaid = localOff.length > 0;
  for (const b of localOff) b.said = true;
  const lroNamed = localSaid ? localReadOnlyNamed(localOff.map(b => b.word)) : null;
  const note = localSaid ? (note0 && note0 !== lro ? `${note0} ${lroNamed}` : lroNamed) : note0;
  return { kind: 'host', key: `h:${r.id}`, name, label: L`${name}の行動`, unit: r.unit, faction, sub: st.text, tone: st.tone, where, note, noteTone: note ? 'why' : null,
    chips: sub.hosts.length > 1 ? sub.hosts.filter(x => x.id !== r.id).map(x => hostChip(FS, x)) : [], villageHere: r.home ? holdingName(h) : null,
    buttons, host: r, march: mc, explore: ex, dissolve: dLocal ? { ok: false, text: localReadOnlyText() } : dc, armed, away, stamina: r.stamina };
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
  // the owner's agent holds the key (fdelegation.mjs): nothing on this bar can be sent from this device; say so first
  // (Q16-3: or another key — ③'s courier, another app or device —, known on a device with no stored key too)
  { const held = (!FS.session || FS.sessionProblem === 'SessionMismatch') ? delegationOf(FS) : null; if (held) { model.note = handNote(held, { review: FS.keyReview === held.agentKey, kept: !!held.foreign && FS.keyKept === held.agentKey }); model.noteTone = 'agent'; } }
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
  // (`opens`: the button only opens its card — reading it sends nothing —, so a reason the card's own action is refused is
  //  said on the button but does not refuse the press: round 21, the Form a host button was refused half of each turn)
  const off = !!b.why && !b.opens;
  // (a button that cannot be pressed stays in the tab order and says why: `aria-disabled`, never the `disabled` attribute)
  return html`<button type="button" class="hand-btn hand-${b.id}${b.proto ? ' hand-proto' : ''}${b.tone ? ` tone-${b.tone}` : ''}${b.quiet ? ' quiet' : ''}${off ? ' off' : ''}" data-act="${b.act}" data-hand="${b.id}" ${dataAttrs(b.data)}
    ${raw(off ? 'aria-disabled="true"' : '')} ${raw(b.pressed !== undefined ? `aria-pressed="${b.pressed && !off ? 'true' : 'false'}"` : '')} title="${off ? b.why : b.hint ?? ''}">
    <span class="hand-ic">${icon(b.icon)}</span><span class="hand-word">${b.word}</span>${b.proto ? proto.tagHtml() : ''}
    ${b.why && !b.said ? html`<span class="hand-why">${b.why}</span>` : html`<span class="hand-fig">${b.rings ? slotRings(b.rings) : ''}<span class="num">${b.figure}</span></span>`}
  </button>`;
}

const chipHtml = c => html`<button type="button" class="hand-chip${c.ready ? ' ready' : ''}" data-act="hand-host" data-host="${c.id}" title="${c.state.text}" aria-label="${L`${c.text}を選ぶ（${c.state.text}）`}">${icon(c.unit === SCOUT ? 'scout' : 'sword')}<span>${c.text}</span></button>`;

/** The action bar (`#hand`): who has the hand, its buttons, and the way back to the dock. */
export function renderHand(model) {
  if (!model) return '';
  const head = model.kind === 'village'
    ? html`<span class="hand-medal">${icon('home')}</span><span class="hand-who"><strong class="hand-name">${model.name}</strong>${model.sub ? html`<span class="hand-sub">${model.sub}</span>` : ''}</span>`
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
  <span class="pop-presets">${presets.filter(p => p.n >= min && p.n <= max).map(p => html`<button type="button" class="btn small" data-act="${act}" data-n="${p.n}"${p.all ? html` data-all="1"` : ''} aria-pressed="${(p.all ? p.pressed : p.n === n) ? 'true' : 'false'}">${p.text}</button>`)}</span></div>`;

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
  // (fix-loop9, LP9-5: 「全部」 is ALL of the reserve when the order goes, not the number it was when the card was drawn —
  //  at ×60 a training batch lands after the card is drawn: the bar said 「最大 500人」 and the muster sent 400)
  const all = FS.hand?.troopsAll === true || !int(FS.hand?.troops);
  const troops = Math.max(HOST_TROOPS.min, Math.min(max, all ? max : FS.hand.troops));
  return { unit: pick?.unit ?? null, troops, max, all, tile: int(FS.hand?.tile) ? FS.hand.tile : null };
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
  let hostsNow = 0;
  try { const rows = hostRows(FS); hostsNow = formingHosts(rows).length + stoodHosts(rows).length; } catch { hostsNow = 0; }
  const why = block === 'NoReserve' && musterIdleCode({ reserve: model.reserve.reduce((a, r) => a + r.troops, 0), hosts: hostsNow }) ? allFormedText() : block ? whyText(block) : null;
  const at = d.tile === null || d.tile === h.tile ? L`${holdingName(h)}（村のマス）` : tileName(FS, h.p, h.q, d.tile);
  const who = d.unit === null ? '' : unitCount(UNIT_ORDER[d.unit], d.troops);
  // (round 21, local play only: a muster refused only because the province is finishing its turn may be pressed — ONE
  //  waiting send of this exact muster, sent once when it can be (controller.mjs armMusterWait); while one waits, the card
  //  says so and offers to cancel it. An ordinary session is as before.)
  const blocks = model.m.blocks.Muster ?? [];
  const local = !!FS.localPlay, waiting = local && !!FS.musterWait;
  const waitable = local && d.unit !== null && d.max >= HOST_TROOPS.min && blocks.length > 0 && blocks.every(c => SETTLE_CODES.includes(c));
  const go = waiting
    ? html`<button type="button" class="btn primary pop-go" aria-disabled="true">${icon('ranks')}${L`送信待ち`}</button><button type="button" class="btn pop-quiet" data-act="muster-wait-cancel">${L`送信待ちを取り消す`}</button>`
    : html`<button type="button" class="btn primary pop-go" data-act="${local ? 'muster-send-wait' : 'muster'}" data-unit="${d.unit ?? 0}" data-troops="${d.troops}" data-tile="${d.tile ?? h.tile}" ${raw(why && !waitable ? 'aria-disabled="true"' : '')}>${icon('ranks')}${who ? L`${who} をここに集める` : L`ここに集める`}</button>`;
  // (loop-play4 B-2, local play only: the province turns behind is the world's keeper under the machine's load — said, so
  //  that a refusal for minutes is not a mystery; the waiting send keeps waiting by itself until it catches up)
  const lag = local ? provinceLag(FS.provinces?.get(`${h.p},${h.q}`)?.province, FS.nowBell) : null;
  const loadNote = Number.isInteger(lag) && lag >= PENDING_LAG_TURNS && blocks.includes('NotResident') ? L`この州の決着が ${fmtNum(lag)} ターン遅れています。このマシンの負荷が高く、世界の進行が追いついていないためです。` : '';
  const line = waiting ? L`送信待ち：州のターンの決着がつき次第、この編成を1回だけ送ります（ターン ${fmtNum(FS.musterWait.untilBell)} まで）。兵種・兵数・場所が変わったら、送らずに取り消します。` + (loadNote ? ' ' + loadNote + ' ' + L`決着が追いつくまで、送信待ちは自動で延ばします。` : '')
    : waitable ? (loadNote ? loadNote + ' ' : '') + L`${why} 押すと、整い次第この編成を1回だけ送ります（兵種・兵数・場所が変わったら送らずに取り消します）。` : null;
  // (a low card: the board above it is where the tile is chosen)
  return html`${popHead(L`編成`, html`${icon('pin')}${L`集める場所：`}<strong>${at}</strong>`)}
    <div class="pop-foot pop-muster">
      <div class="unit-toks unit-toks-row" role="group" aria-label="${L`兵種`}">${model.reserve.map(r => html`<button type="button" class="unit-tok unit-tok-small${r.troops < HOST_TROOPS.min ? ' short' : ''}" data-act="hand-unit" data-unit="${r.unit}" aria-pressed="${r.unit === d.unit ? 'true' : 'false'}">
        ${unitPic(f, r.unit, 30)}<strong class="unit-tok-name">${UNITS[UNIT_ORDER[r.unit]]}</strong><span class="unit-tok-str num">${fmtNum(r.troops)}</span></button>`)}</div>
      ${d.unit === null ? '' : countRow('hand-troops', d.troops, { min: HOST_TROOPS.min, max: d.max, presets: [{ n: d.max, text: L`全部`, all: true, pressed: d.all }], label: L`兵数` })}
      ${go}
    </div>
    <p class="pop-line${why || line ? ' pop-why' : ' pop-rule'}">${line ?? why ?? musterRuleText()}</p>
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
  if (model.pop === EXPEDITION_POP) return expeditionPop(FS, model);
  if (model.pop === OUTBOUND_POP && model.kind === 'host') return outboundPop(FS, model);
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

/**
 * Local play only (FS.localPlay; flocalplay-depart.mjs): the one send of the local-play page, on the boundary card.
 * The button asks for the departure of the draft as it stands; the lines say how far the run got. An unknown
 * outcome is said as unknown, with the one thing that may be done about it (ask again); never as a success.
 */
function outboundLocalDepart(FS, ready) {
  if (!FS.localPlay) return '';
  const d0 = localDepartOf(FS);
  // (fix-loop16, LP16-6: a departure that was CONFIRMED belongs to the host that left. On the card of another host — the
  //  next expedition — its line 「出発が確定しました（ターン N に到着予定…）」 stood for hundreds of turns, as if it were this
  //  draft's. A run in flight or not settled is still shown whatever the host: its signature is the way to ask about it)
  const src = FS.expeditionCompose?.source?.host ?? null;
  const d = d0.status === 'confirmed' && typeof d0.host === 'string' && typeof src === 'string' && d0.host !== src ? { ...d0, status: 'idle' } : d0;
  const sig = d.signature ? `${d.signature.slice(0, 8)}…${d.signature.slice(-6)}` : '';
  const step = { sealing: L`封をしています…`, preparing: L`出発の取引を用意しています…`, signing: L`このページのテスト用ウォレットで署名しています…`, submitting: L`送信して結果を待っています…` }[d.status];
  const line = step ? html`<p class="pop-line local-depart-step" role="status">${step}</p>`
    : d.status === 'confirmed' ? html`<p class="pop-line local-depart-done" role="status">${L`出発が確定しました（ターン ${d.arriveBell} に到着予定・移動枠 ${d.transitSlot}）。署名 ${sig}`}</p>`
    : d.status === 'submitted' ? html`<p class="pop-line local-depart-sent" role="status">${L`送信しました。確定はまだ確認できていません。署名 ${sig}`}${d.error ? html` <span>${L`（照合できませんでした：${d.error}）`}</span>` : ''}</p>`
    : d.status === 'failed' ? html`<p class="pop-line local-depart-failed" role="alert">${d.chain === 'rejected' ? L`出発は送る前の確かめで断られました（チェーンには届いていません）：${departRefusedReason(d)}。軍勢は出発していません（村にいます）。進軍の一覧にも出しません。署名 ${sig}` : L`出発はチェーンで断られました：${departRefusedReason(d)}。軍勢は出発していません（村にいます）。進軍の一覧にも出しません。署名 ${sig}`}</p>`
    : d.status === 'expired' ? html`<p class="pop-line local-depart-expired" role="alert">${L`出発の取引は期限が切れました（記録されないままで、これから記録されることはありません）。軍勢は出発していません（村にいます）。進軍の一覧にも出しません。署名 ${sig}`}</p>`
    : d.status === 'unknown' ? html`<p class="pop-line local-depart-unknown" role="alert">${L`結果を確認できませんでした。出発したかどうかは不明です。もう一度送らずに、結果を照合してください。署名 ${sig}`}${d.error ? html` <span>${L`（照合できませんでした：${d.error}）`}</span>` : ''}</p>`
    : d.status === 'error' ? html`<p class="pop-line local-depart-error" role="alert">${L`出発できませんでした（${d.error ?? '?'}）。${d.sent ? '' : L`何も送っていません。`}`}</p>` : '';
  // (fix-loop8, LP8-1: the page's own retry after a run ended unsent because the clock moved — controller sendLocalPlayDeparture)
  const retry = FS.departRetry ? html`<p class="pop-line local-depart-retry" role="status">${L`出発の途中で世界の時計が進みました（何も送っていません）。条件を読み直して、もう一度送ります（${FS.departRetry.n} / ${FS.departRetry.of} 回目）…`}</p>` : '';
  const settle = d.status === 'unknown' || d.status === 'submitted';
  // (a departure was already sent on this observation of the conditions: it is used up until they are read again)
  const spent = localDepartSpent(FS);
  if (spent) ready = false;
  return html`<div class="outbound-local-depart"><p class="pop-line">${L`ローカルプレイ：この軍勢を、このページのテスト用ウォレットの署名で出発させます（このマシンの試験用の世界だけ）。封の中身はこのページのメモリにだけ残り、再読み込みすると失われます。`}</p>
    ${retry || line}
    <div class="pop-foot">${settle ? html`<button type="button" class="btn small" data-act="outbound-local-reconcile" ${raw(d.busy ? 'aria-disabled="true"' : '')}>${L`結果を照合する`}</button>`
      : html`<button type="button" class="btn primary" data-act="outbound-local-depart" ${raw(d.busy || FS.departRetry || !ready ? 'aria-disabled="true"' : '')}>${d.busy || FS.departRetry ? L`出発を送っています…` : L`出発する（ローカルプレイ）`}</button>`}
      ${!ready && !d.busy && !FS.departRetry && !settle ? html`<span>${spent ? L`この確認結果ではすでに出発を送りました。もう一度出発するには「出発条件を確認」で最新の状態を読み直してください。` : L`先に「出発条件を確認」で条件を満たしてください。`}</span>` : ''}</div></div>`;
}

/**
 * Devnet play only (FS.devnetPlay on a wide devnet season, never local play; fdevnet-depart.mjs): the boundary card's
 * departure signed by the player's connected wallet. Two presses: 「送る内容を確認」 seals and shows the transaction
 * (who pays, the fee, the tip and bond escrowed, the total, the arrival turn, the destination); 「ウォレットで署名して送る」
 * has the wallet sign exactly that and sends it once. An unknown outcome is said as unknown, with the status look-up.
 */
function outboundDevnetDepart(FS, ready) {
  if (FS.localPlay || !FS.devnetPlay || !FS.devnetWide) return '';
  const d = devnetDepartOf(FS), sig = d.signature ? `${d.signature.slice(0, 8)}…${d.signature.slice(-6)}` : '', p = d.preview;
  const step = { sealing: L`封をしています…`, preparing: L`送る取引を組み立てています…`, signing: L`ウォレットで署名しています…`, submitting: L`送信して結果を待っています…` }[d.status];
  const line = step ? html`<p class="pop-line devnet-depart-step" role="status">${step}</p>`
    : d.status === 'confirmed' ? html`<p class="pop-line devnet-depart-done" role="status">${L`出発が確定しました（ターン ${d.arriveBell} に到着予定・移動枠 ${d.transitSlot}）。署名 ${sig}`}</p>
        <p class="pop-line devnet-depart-keeper">${L`このあとの手順（公開ラウンドでの封の開封・到着先の解決・集結・結果の受け取り）は keeper A が行います。封の中身はこのブラウザに暗号化して保管しています。`}</p>`
    : d.status === 'submitted' ? html`<p class="pop-line devnet-depart-sent" role="status">${L`送信しました。確定はまだ確認できていません。署名 ${sig}`}${d.error ? html` <span>${L`（照合できませんでした：${d.error}）`}</span>` : ''}</p>`
    : d.status === 'failed' ? html`<p class="pop-line devnet-depart-failed" role="alert">${L`出発は失敗しました（理由 ${d.code ?? '?'}）。軍勢は出発していません。署名 ${sig}`}</p>`
    : d.status === 'unknown' ? html`<p class="pop-line devnet-depart-unknown" role="alert">${L`結果を確認できませんでした。出発したかどうかは不明です。もう一度送らずに、結果を照合してください。署名 ${sig}`}${d.error ? html` <span>${L`（照合できませんでした：${d.error}）`}</span>` : ''}</p>`
    : d.status === 'error' ? html`<p class="pop-line devnet-depart-error" role="alert">${L`出発できませんでした（${d.error ?? '?'}）。${d.sent ? '' : L`何も送っていません。`}`}</p>` : '';
  const preview = p && ['preview', 'signing', 'submitting', 'submitted', 'unknown', 'confirmed', 'failed'].includes(d.status) ? html`<div class="devnet-depart-preview" role="status">
    <p class="pop-line">${L`送る取引：境界への出発（ExpeditionDepart）・署名者はこのウォレットだけ`}</p>
    <p class="pop-line">${L`支払うウォレット`}: <span style="overflow-wrap:anywhere">${p.payer}</span></p>
    <p class="pop-line">${L`手数料 ${p.fee} lamports・チップ ${p.tip}・行軍料 ${p.marchFee}・封の保証金 ${p.sealBond}（チップ以下は村に預けられます）`}</p>
    <p class="pop-line">${L`行軍記録の賃料 ${p.transitRent} lamports（このウォレットから、行軍記録が預かります）`}</p>
    <p class="pop-line">${L`最大の支払い ${p.total} lamports`}</p>
    <p class="pop-line">${L`到着ターン ${p.arriveBell}・行き先 ${p.destination ? `${p.destination.p},${p.destination.q}` : '?'}・アカウント ${p.accounts}`}</p>
    <p class="pop-line" style="overflow-wrap:anywhere">${L`取引の要約`}: ${p.digest}</p></div>` : '';
  const settle = d.status === 'unknown' || d.status === 'submitted', off = d.busy ? 'aria-disabled="true"' : '';
  const foot = settle ? html`<button type="button" class="btn small" data-act="outbound-devnet-reconcile" ${raw(off)}>${L`状況を確かめる`}</button>`
    : d.status === 'preview' ? html`<button type="button" class="btn primary" data-act="outbound-devnet-send" ${raw(off)}>${L`ウォレットで署名して送る`}</button>
        <button type="button" class="btn small" data-act="outbound-devnet-clear" ${raw(off)}>${L`やめる`}</button>`
    : ['confirmed', 'failed', 'error'].includes(d.status) ? html`<button type="button" class="btn small" data-act="outbound-devnet-clear" ${raw(off)}>${L`閉じる`}</button>`
    : html`<button type="button" class="btn primary" data-act="outbound-devnet-preview" ${raw(d.busy || !ready ? 'aria-disabled="true"' : '')}>${d.busy ? L`用意しています…` : L`送る内容を確認`}</button>
        ${!ready && !d.busy ? html`<span>${L`先に「地形・時間を確認」で道と到着ターンを確かめてください。`}</span>` : ''}`;
  return html`<div class="outbound-devnet-depart"><p class="pop-line">${L`devnet：この軍勢を、接続中のウォレットの署名で境界の外へ出発させます。手数料・チップ・保証金はこのウォレットが払います。`}</p>
    ${preview}${line}
    <div class="pop-foot">${foot}</div></div>`;
}

/**
 * Local play only (FS.localPlay; flocalplay-reveal.mjs): the explicit opening of a seal this page holds, for a
 * departure the test world confirmed. Two presses: 確認 (a read; nothing is signed) and then 封を開く. Empty when the
 * page holds no such seal and nothing was asked. What it says at the end is only that the opening is recorded:
 * the arrival, its battle and the return are decided at the destination and are not claimed here. An outcome that
 * is not known is said as not known, with the one thing that may be done (ask again); never sent a second time.
 * Shown on the boundary card and, by the page, apart from it (the host has left its tile after departing).
 */
export function localRevealStrip(FS) {
  if (!FS.localPlay) return '';
  const r = localRevealOf(FS), seal = localRevealCandidate(FS);
  // (fix-wide-breaks BREAK-3: with no seal left to open — the chain showed it opened, flocalplay-expedition.mjs — a
  //  finished check's line goes too; an outcome not yet known, or a run in flight, still stands)
  if (!seal && !r.busy && !['unknown', 'submitted', 'revealed', 'failed'].includes(r.status)) return '';
  const sig = r.signature ? `${r.signature.slice(0, 8)}…${r.signature.slice(-6)}` : '';
  const turn = r.arriveBell ?? seal?.arriveBell ?? '?';
  const why = {
    RevealWindowClosed: L`封を開ける期間が終わっています。`, RevealArchived: L`この到着ターンの記録はすでに片付けられています。`, RevealLatchClosed: L`到着先はこのターンの受付をすでに締め切っています。`,
    RevealSeasonNotRunning: L`この世界は進行中ではありません。`, RevealSeasonEnded: L`この世界の受付が終わっており、この到着は受け付けられません。`,
    RevealAdmissionContested: L`到着先の枠がほかの軍勢と競合しています。このページでは順位を判定しないため、送りません。`,
    RevealAdmissionMismatch: L`到着先にこの軍勢の名前の記録がありますが、この封のものとは一致しません。`,
    RevealDestinationNotOpen: L`到着先の州がまだ開かれていません。`, RevealDestinationNotReady: L`到着先の州の準備がまだ終わっていません。`,
    RevealTransitMissing: L`この出発の記録が見つかりません。`, RevealAlreadyGathered: L`この軍勢はすでに到着先で受け付けられています。`, RevealHostDestroyedAtOrigin: L`この軍勢は出発地で失われました。`,
    RevealSealMissing: L`このページには開ける封が残っていません（再読み込みすると封の中身は失われます）。`,
  }[r.code] ?? null;
  const step = { checking: L`いまの記録を読んで、封を開けられるか確かめています…`, reading: L`最新の記録を読み直しています…`, signing: L`このページのテスト用ウォレットで署名しています…`, submitting: L`送信して結果を待っています…` }[r.status];
  const line = step ? html`<p class="pop-line local-reveal-step" role="status">${step}</p>`
    : r.status === 'ready' ? html`<p class="pop-line local-reveal-ready" role="status">${L`封を開けられます（到着ターン ${turn}・到着先の枠 ${r.targetI}）。開くと封の中身（行き先と命令）が公開されます。`}</p>`
    : r.status === 'blocked' ? html`<p class="pop-line pop-why local-reveal-blocked" role="status">${why ?? L`いまは封を開けられません。`} (${r.code ?? '?'}) ${L`何も送っていません。`}</p>`
    : r.status === 'revealed' ? html`<p class="pop-line local-reveal-done" role="status">${L`封を開いたことが記録されました（到着ターン ${turn}）。到着先での決着を待っています。戦いや帰還の結果は、まだ決まっていません。`}${sig ? html` <span>${L`署名 ${sig}`}</span>` : ''}</p>`
    : r.status === 'submitted' ? html`<p class="pop-line local-reveal-sent" role="status">${L`送信しました。記録されたかどうかはまだ確認できていません。署名 ${sig}`}${r.error ? html` <span>${L`（照合できませんでした：${r.error}）`}</span>` : ''}</p>`
    : r.status === 'unknown' ? html`<p class="pop-line local-reveal-unknown" role="alert">${L`結果を確認できませんでした。封が開かれたかどうかは不明です。もう一度送らずに、結果を照合してください。署名 ${sig}`}${r.error ? html` <span>${L`（照合できませんでした：${r.error}）`}</span>` : ''}</p>`
    : r.status === 'failed' ? html`<p class="pop-line local-reveal-failed" role="alert">${L`封を開く取引は失敗しました（理由 ${r.code ?? '?'}）。封は開かれていません。封はこのページに残っています。署名 ${sig}`}</p>`
    : r.status === 'error' ? html`<p class="pop-line local-reveal-error" role="alert">${L`封を開けませんでした（${r.error ?? '?'}）。${r.sent ? '' : L`何も送っていません。`}`}</p>` : '';
  const settle = r.status === 'unknown' || r.status === 'submitted', off = r.busy ? 'aria-disabled="true"' : '';
  const buttons = settle ? html`<button type="button" class="btn small" data-act="local-reveal-reconcile" ${raw(off)}>${L`結果を照合する`}</button>`
    : r.status === 'ready' ? html`<button type="button" class="btn primary" data-act="local-reveal-send" ${raw(off)}>${L`封を開く（ローカルプレイ）`}</button>
        <button type="button" class="btn small" data-act="local-reveal-check" ${raw(off)}>${L`確認し直す`}</button>`
    : r.status === 'revealed' ? (seal ? html`<button type="button" class="btn small" data-act="local-reveal-clear">${L`次の封を確認する`}</button>` : '')
    : ['failed', 'error', 'blocked'].includes(r.status) ? html`<button type="button" class="btn small" data-act="local-reveal-check" ${raw(off)}>${L`確認し直す`}</button>`
    : html`<button type="button" class="btn small" data-act="local-reveal-check" ${raw(off)}>${r.busy ? L`確かめています…` : L`封を開けるか確認する`}</button>`;
  return html`<div class="outbound-local-reveal"><p class="pop-line">${L`ローカルプレイ：出発が確定した軍勢の封を、このページのテスト用ウォレットの署名で開きます（このマシンの試験用の世界だけ）。到着ターン ${turn}。`}</p>
    ${line}
    <div class="pop-foot">${buttons}</div></div>`;
}

/** Local preparatory card. Its controls have no order form or executable action. */
/**
 * The earliest observed arrival turn, offered beside the range it comes from (`pick`: fexpedition-compose.mjs
 * outboundArrivalCandidate, only while the observation is still this draft's; `entered`: the draft's own field).
 * A press fills the field and reads the observation again; the field in 詳細 stays for any other turn.
 */
function outboundArrivalPick(pick, entered) {
  if (!pick) return '';
  // (fix-loop6, LP6-1: on a fast clock the offer is the earliest turn plus the turns the send itself takes —
  //  fexpedition-compose arrivalHeadroom — and an entered turn still inside the observed range is kept, not re-offered)
  const n = /^(0|[1-9][0-9]{0,9})$/.test(entered) ? Number(entered) : null;
  // (an entered turn with any room past the earliest stays — the offer moves with the clock and the measured rate, the field need not)
  const inside = n !== null && n > pick.min && n <= pick.max;
  if (entered === pick.arriveBell || (inside && (pick.headroom ?? 0) > 0)) return html`<p class="pop-line outbound-arrival-set">${pick.headroom
    ? L`到着ターンの候補はターン ${entered} です（最も早いターン ${pick.min} に、送るまでに時計が進む分の余裕を足しています）。詳細で変更できます。`
    : L`到着ターンの候補はターン ${pick.arriveBell}（観測した範囲で最も早い候補）です。詳細で変更できます。`}</p>`;
  return html`<div class="pop-foot outbound-arrival-pick"><button type="button" class="btn small" data-act="outbound-arrival-earliest">${pick.headroom
      ? L`間に合う候補（ターン ${pick.arriveBell}）を使う` : L`最も早い候補（ターン ${pick.arriveBell}）を使う`}</button>
    <span>${entered ? L`いまの候補：ターン ${entered}` : L`到着ターンの候補は未入力です`}</span></div>
    ${pick.headroom ? html`<p class="pop-line outbound-arrival-why">${L`最も早いターン ${pick.min} は、確認して送るあいだに世界の時計が進むと断られます。${pick.headroom} ターンの余裕を足した候補です。`}</p>` : ''}`;
}

/**
 * (fix-loop7, LP7-3) Why the road cannot be marched, and at which step: 「山や水のマスには進めません」 with 「5 歩め（北西）
 * のマスです」. Said from the read, and kept (fexpedition-compose outboundRouteRefusal) until the road changes — a clock poll
 * no longer takes it away. `still`: shown from that memory, after the read itself was dropped by the clock.
 */
const ROUTE_WHY = { RouteImpassable: () => L`山や水のマスには進めません`, RoutePalisade: () => L`道の途中の柵を通れません。`, RouteLandMissing: () => L`道の途中に、まだ読み取れていない州があります。` };
function outboundRefusalLine(m, { still = false, steps = null } = {}) {
  if (!m || !ROUTE_WHY[m.code]) return '';
  const at = Number.isInteger(m.stepIndex) ? (Number.isInteger(m.direction) && DIR_TEXT[m.direction]
    ? L`${m.stepIndex + 1} 歩め（${DIR_TEXT[m.direction]()}）のマスで止まります。` : L`${m.stepIndex + 1} 歩めのマスで止まります。`) : '';
  // (verify-pr137: 「一歩戻す」 takes away the LAST step; a road stopped at an earlier step needs as many presses as the steps
  //  from the stopping one to the end — 「その一歩を「一歩戻す」で消して」 read as one press for a road stopped at step 1 of 4)
  const undos = Number.isInteger(m.stepIndex) && Number.isInteger(steps) && steps > m.stepIndex ? steps - m.stepIndex : 1;
  const fix = m.code === 'RouteLandMissing' ? L`「地形・時間を確認」をもう一度押すと読み直します。`
    : undos > 1 ? L`「一歩戻す」を ${undos} 回押して ${m.stepIndex + 1} 歩めまで消し、別の方向に変えると、もう一度確認できます。`
      : L`その一歩を「一歩戻す」で消して別の方向に変えると、もう一度確認できます。`;
  return html`<div class="outbound-route-refusal" role="status"><p class="pop-line pop-why">${ROUTE_WHY[m.code]()}</p>${at ? html`<p class="pop-line pop-why outbound-refusal-step">${at}</p>` : ''}<p class="pop-line">${fix}</p>${still ? html`<p class="pop-line outbound-refusal-kept">${L`この道を読み取った結果です。道を変えるまで出ています。`}</p>` : ''}</div>`;
}

function outboundRouteReport(check, pick = null, entered = '', directions = []) {
  if (!check) return '';
  if (check.status === 'loading') return html`<p class="pop-line" role="status">${L`道の州の記録を読み込んでいます…`}</p>`;
  if (check.status === 'error') return html`<p class="pop-line pop-why" role="status">${L`道の記録を読めませんでした。もう一度確認してください。`} (${check.code})</p>`;
  const r = check.report;
  const why = r.code === 'RouteLandMissing' ? L`道の途中に、まだ読み取れていない州があります。`
    : r.code === 'RouteImpassable' ? L`山や水のマスには進めません`
    : r.code === 'RoutePalisade' ? L`道の途中の柵を通れません。`
    : r.code === 'ArrivalRequired' ? L`詳細で到着ターンの候補を入力し、もう一度確認してください。`
    : ['ArrivalTooEarly', 'ArrivalTooLate', 'ArrivalAfterSeason', 'ArrivalWindowEmpty'].includes(r.code) ? L`到着ターンの候補が、記録から計算した範囲に入りません。`
    // (fix-loop8, LP8-8: said as the card's own line for that draft error says it, not as 「経路を計算できません」)
    : r.code === 'WideDestinationRequired' ? L`終点はまだリング 128 の内側です。境界の外まで道を続けてください。`
    : r.code ? L`この記録では経路を計算できません。` : null;
  return html`<div class="outbound-route-report" role="status">
    ${r.travelSecs !== null ? html`<p class="pop-line">${r.wearBps > 0
      // (fix-loop8, LP8-8: the wear is the S1 WATCHTOWERS' (物見櫓, structure.rs wear_bps) — 「塔」 read as the central tower
      //  that ⑭ abolished; said in percent, and only when there is some)
      ? L`記録上の移動時間 ${r.travelSecs} 秒・物見櫓に見張られる道で兵の ${fmtNum(r.wearBps / 100)}% を失います`
      : L`記録上の移動時間 ${r.travelSecs} 秒（物見櫓に見張られる区間はありません）`}</p>` : ''}
    ${r.min !== null && r.max !== null && r.min <= r.max ? html`<p class="pop-line">${L`到着候補：ターン ${r.min}〜${r.max}`}</p>` : ''}
    ${ROUTE_WHY[r.code] ? outboundRefusalLine({ code: r.code, stepIndex: r.stepIndex, direction: Number.isInteger(r.stepIndex) ? directions[r.stepIndex] ?? null : null }, { steps: directions.length })
      : why ? html`<p class="pop-line pop-why">${why}${r.stepIndex !== null ? ` (${r.stepIndex + 1})` : ''}</p>` : ''}
    ${outboundArrivalPick(pick, entered)}
    <p class="pop-line">${L`取得した記録と推定出発時刻での計算です。現在の通行・到着や出発の成功は未確認です。`}</p>
  </div>`;
}

function outboundContextReport(check, pick = null, entered = '', directions = []) {
  if (!check) return '';
  if (check.status === 'loading') return html`<p class="pop-line" role="status">${L`軍勢・村・地形・時刻をまとめて読み込んでいます…`}</p>`;
  if (check.status === 'error') return html`<p class="pop-line pop-why" role="status">${check.code === 'ExpeditionPreviewDisabled'
    ? L`この接続では出発条件の読み取りを利用できません。` : L`出発条件を読めませんでした。情報を更新して、もう一度確認してください。`} (${check.code})</p>`;
  return html`<div class="outbound-context-report" role="status">
    <p class="pop-line">${L`軍勢・村・地形・時刻を同じ読取時点で確認しました。最新状態や出発の成功を保証するものではありません。`}</p>
    <p class="pop-line${check.ready.ok ? '' : ' pop-why'}">${check.ready.ok
      ? L`この読取時点では、軍勢と村の出発条件を満たしています。`
      : L`この読取時点では、軍勢と村の出発条件を満たしていません。`}${check.ready.ok ? '' : ` (${check.ready.code})`}</p>
    ${outboundRouteReport(check, pick, entered, directions)}
    <p class="pop-line pop-why">${L`出発の送信はまだ利用できません。`}</p>
  </div>`;
}

/** (fix-loop5, L5-4) The road's endpoint is not an opened wide province: said at once, with the nearest opened one. */
function outboundEndpointLine(endpoint, targets) {
  const o = outboundEndpointOpen(endpoint, targets);
  if (!o || o.open) return '';
  return html`<p class="pop-line pop-why outbound-endpoint-closed" role="status">${o.nearest
    ? L`終点の州 ${endpoint.p},${endpoint.q} は、この世界ではまだ開いていません（開いている広い土地は、地図に描かれた第129〜131輪の州だけです）。いちばん近い開いた州は ${o.nearest.p},${o.nearest.q}（${o.nearest.away} 州先）です。`
    : L`終点の州 ${endpoint.p},${endpoint.q} は、この世界ではまだ開いていません（開いている広い土地は、地図に描かれた第129〜131輪の州だけです）。`}</p>`;
}

function outboundPop(FS, model) {
  const s = FS.expeditionCompose ?? {}, review = s.review, source = s.source, directions = s.directions ?? [];
  let choices = { stances: [], retreat: [], tips: [] };
  try { choices = composerChoices(FS); } catch { /* A missing season is explained by the source blocker. */ }
  const endpoint = s.trace?.endpoint;
  // (offered only from an observation that is still of this host, these steps, this source and connection)
  let pick = null;
  try { pick = outboundArrivalCandidate(FS); } catch { /* none to offer: the report's own words say why */ }
  const entered = typeof s.arriveBell === 'string' ? s.arriveBell : '';
  // (verify-pr149: an entered turn the clock has already passed — earlier than the earliest turn the remembered offer
  //  gives now — holds nothing: after a refused departure (ArrivalBell, ArrivalTooEarly…) the card stood on it with no
  //  offer once the next poll dropped the read, the LP8-1 dead end by another way. The offer is put beside it then; a
  //  turn still inside the range is kept as before)
  const passed = !!pick?.remembered && /^(0|[1-9][0-9]{0,9})$/.test(entered) && Number(entered) < pick.min;
  // (fix-loop7, LP7-3: the road's refusal, kept until the road changes)
  let refusal = null;
  try { refusal = outboundRouteRefusal(FS); } catch { refusal = null; }
  // (devnet play on a wide season: the keyless departure-conditions read is local play's; the devnet card has its own)
  const devnetCard = !FS.localPlay && !!FS.devnetPlay && !!FS.devnetWide;
  const points = outboundSketch(directions).map(p => ({ x: p.q + p.r / 2, y: p.r * Math.sqrt(3) / 2 }));
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const left = Math.min(...xs) - 1, top = Math.min(...ys) - 1, width = Math.max(...xs) - left + 1, height = Math.max(...ys) - top + 1;
  const reason = s.error === 'ChooseSteps' ? L`六方向から一歩ずつ選んでください。`
    : s.error === 'WideDestinationRequired' ? L`終点はまだリング 128 の内側です。境界の外まで道を続けてください。`
    : s.error === 'ArrivalRequired' ? L`到着ターンの候補を入力し、地形・時間を確認してください。`
    : s.error === 'SourceChanged' ? L`軍勢・所有者・接続情報が変わりました。カードを開き直してください。`
    : s.error === 'PathTooLong' || s.error === 'PathProvinces' ? null
    : s.error ? L`この準備は利用できません` : null;
  return html`${popHead(L`境界への道を準備`)}
    <p class="pop-line outbound-help">${L`地図の破線のマスを押すと一歩追加します。「地形・時間を確認」で道の記録を読み取れます。`}</p>
    ${s.error === 'SourceChanged' ? html`<p class="pop-line pop-why" role="status">${reason}</p>` : ''}
    <div class="pop-foot outbound-directions" role="group" aria-label="${L`一歩進む方向`}">${DIR_TEXT.map((name, direction) => html`<button type="button" class="btn small" data-act="outbound-step" data-direction="${direction}" ${raw(!source || directions.length >= 32 ? 'aria-disabled="true"' : '')}>${name()}</button>`)}</div>
    ${s.stepRefused ? html`<p class="pop-line pop-why outbound-step-refused" role="status">${L`道の形は 32 マス・4 州までです。`} ${L`この一歩は足せません。「一歩戻す」で道を変えるか、もっと近い砦を選んでください。`}</p>` : ''}
    <div class="pop-foot"><span>${directions.length}/32 · ${s.trace?.accountKeys.length ?? 0}/4 ${L`入る州`}</span>
      <button type="button" class="btn small" data-act="outbound-undo" ${raw(!directions.length ? 'aria-disabled="true"' : '')}>${L`一歩戻す`}</button>
      <button type="button" class="btn small" data-act="outbound-reset">${L`道を消す`}</button></div>
    ${endpoint ? html`<p class="pop-line">${L`道から決まる終点`}: ${endpoint.p},${endpoint.q} · ${L`マス`} ${endpoint.tile}</p>` : ''}
    ${outboundEndpointLine(endpoint, FS.localPlay?.wideLand?.targets)}
    <div class="pop-foot"><button type="button" class="btn small" data-act="outbound-route-read" ${raw(!source || !directions.length || s.routeCheck?.status === 'loading' ? 'aria-disabled="true"' : '')}>${L`地形・時間を確認`}</button>
      ${devnetCard ? '' : html`<button type="button" class="btn small" data-act="outbound-context-read" ${raw(!source || !directions.length || s.contextCheck?.status === 'loading' ? 'aria-disabled="true"' : '')}>${L`出発条件を確認`}</button>`}</div>
    ${FS.outboundReread && (s.routeCheck?.status === 'loading' || s.contextCheck?.status === 'loading') ? html`<p class="pop-line outbound-read-again" role="status">${L`読み取りの途中で世界の時計が進んだため、読み直しています（${FS.outboundReread.n} / ${FS.outboundReread.of} 回目）…`}</p>` : ''}
    ${pick?.remembered && (!entered || passed) && !s.routeCheck && !s.contextCheck && !FS.outboundReread ? html`<div class="outbound-route-report outbound-arrival-remembered" role="status">${outboundArrivalPick(pick, entered)}<p class="pop-line">${L`さきほどの「地形・時間を確認」の読み取りからの候補を、時計に合わせて進めています。押すと読み直します。`}</p></div>` : ''}
    ${!s.routeCheck && !s.contextCheck && !FS.outboundReread && refusal ? outboundRefusalLine(refusal, { still: true, steps: directions.length }) : ''}
    ${s.error === 'ArrivalRequired' && !refusal && !(pick?.remembered && !entered) && !s.routeCheck && !s.contextCheck && !s.dropped && !FS.outboundReread ? html`<p class="pop-line outbound-arrival-empty" role="status">${L`到着ターンはまだ入っていません。「地形・時間を確認」を押すと、到着候補とそれを入れるボタンが出ます（自分で入れる欄は「詳細」の中です）。`}</p>` : ''}
    ${s.dropped && !s.routeCheck && !s.contextCheck && !FS.outboundReread ? html`<p class="pop-line pop-why outbound-read-dropped" role="status">${L`読み取りの途中で世界の時計が進んだため、その結果は使えませんでした（×60 ではよく起こります）。このページが 2 回まで自動で読み直しましたが、間に合いませんでした。もう一度押してください。`}</p>` : ''}
    ${outboundRouteReport(s.routeCheck, pick?.from === 'route' ? pick : null, entered, directions)}
    ${outboundContextReport(s.contextCheck, pick?.from === 'context' ? pick : null, entered, directions)}
    ${outboundLocalDepart(FS, !!review && ((s.contextCheck?.status === 'read' && s.contextCheck.ready?.ok === true && s.contextCheck.report?.ok === true)
      // (fix-loop6, LP6-1: read as holding for this very draft, the observation since dropped by a clock poll — the press reads again first)
      || (!s.contextCheck && outboundReadyOnce(FS))))}
    ${outboundDevnetDepart(FS, !!review && s.routeCheck?.status === 'read' && s.routeCheck.report?.ok === true)}
    ${localRevealStrip(FS)}
    <details data-fold="outbound-details"><summary>${L`詳細`}</summary>
    <p class="pop-line">${L`記録上の地形と推定時刻から道を準備します。現在の通行条件と出発の成功は未確認です。`}</p>
    <p class="pop-line">${L`選択した軍勢`}: ${model.host.id}</p>
    ${source ? html`<p class="pop-line">${L`観測した出発点`}: ${source.origin.p},${source.origin.q} · ${L`マス`} ${source.origin.tile}</p>` : ''}
    ${directions.length ? html`<svg role="img" aria-label="${L`出発点からの相対的な道の形`}" viewBox="${left} ${top} ${width} ${height}" width="100%" height="96"><polyline points="${points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="0.12"/><circle cx="0" cy="0" r="0.2" fill="currentColor"/><circle cx="${points.at(-1).x}" cy="${points.at(-1).y}" r="0.25" fill="none" stroke="currentColor" stroke-width="0.1"/></svg>
      <p class="pop-line">${directions.map(d => DIR_TEXT[d]()).join(' → ')}</p>` : ''}
    <div class="pop-line"><label>${L`到着ターンの候補`} <input type="text" inputmode="numeric" autocomplete="off" maxlength="10" data-bind="outbound-arriveBell" value="${s.arriveBell ?? ''}"></label></div>
    <div class="pop-line"><label>${L`構え`} <select data-bind="outbound-stance">${choices.stances.map(x => html`<option value="${x.value}" ${raw(s.stance === x.value ? 'selected' : '')}>${x.text}</option>`)}</select></label></div>
    <div class="pop-line"><label>${L`撤退`} <select data-bind="outbound-retreat">${choices.retreat.map(x => html`<option value="${x.id}" ${raw(s.retreat === x.id ? 'selected' : '')}>${x.text}</option>`)}</select></label>
      ${s.retreat === 'custom' ? html`<label>${L`倍率`} <input type="text" inputmode="decimal" maxlength="12" data-bind="outbound-ratio" value="${s.ratio ?? ''}"></label>` : ''}</div>
    <div class="pop-line"><label>${L`チップの候補`} <select data-bind="outbound-tip">${choices.tips.map(x => html`<option value="${x.id}" ${raw(s.tip === x.id ? 'selected' : '')}>${x.text} · ${x.lamports.toString()} lamports</option>`)}</select></label></div>
    <div aria-live="polite">${reason && s.error !== 'SourceChanged' ? html`<p class="pop-line pop-why">${reason}${!['ChooseSteps', 'WideDestinationRequired', 'ArrivalRequired'].includes(s.error) ? ` (${s.error})` : ''}</p>` : ''}
    ${review ? html`<p class="pop-line">${L`136 バイトの平文案です。封印・署名・送信は行っていません。`}</p>
      <details><summary>${L`平文の全バイトを確認`}</summary><p class="pop-line" style="overflow-wrap:anywhere">${review.plainHex}</p></details>
      <details><summary>${L`出発点・軍勢・州の識別子`}</summary><p class="pop-line" style="overflow-wrap:anywhere">${L`軍勢: ${review.host}`}</p>
        <p class="pop-line" style="overflow-wrap:anywhere">${L`所有者`}: ${source.original_owner}</p>
        <ol>${review.accountKeys.map(key => html`<li style="overflow-wrap:anywhere">${key}</li>`)}</ol></details>
      ${review.roles ? html`<p class="pop-line">${L`観測した空き行軍枠の候補`}: ${review.transitSlot} · ${L`現在も使えるとは確認できていません。`}</p><details><summary>${L`実行できない役割案`}</summary><ul>${review.roles.map(r => html`<li style="overflow-wrap:anywhere">${r.name}: ${r.address} · ${r.signer ? L`署名が必要` : L`署名不要`} · ${r.writable ? L`書き込み役割` : L`読み取り役割`}</li>`)}</ul></details>` : html`<p class="pop-line pop-why">${L`正規の役割案はまだ利用できません。`}</p>`}
      <p class="pop-line pop-why">${L`土地と時刻の一貫した記録、出発条件、到着可能時刻、署名者の承認を確認する必要があります。公開実行は閉じています。`}</p>` : ''}</div>
    <p class="pop-line pop-rule">${L`封印・署名・送信はすべて無効です。地図・行軍記録・通常の行軍案は変更しません。`}</p></details>`;
}

/** The entered coordinate is an inspection query, never a destination or a claimed current location. */
function expeditionPop(FS, model) {
  const state = FS.expeditionPreview ?? {}, report = state.report, source = report?.source;
  let returning = null, returnError = false;
  if (report && state.request) {
    try { returning = originalReturnModel(report, state.request); } catch { returnError = true; }
  }
  const unavailable = FS.resident ? L`NFT の軍勢はこの確認に対応していません。` : !FS.wallet?.address ? L`接続したウォレットが必要です。` : FS.meStatus !== 'ready' ? L`自分の記録を読み込んでから確認してください。` : null;
  return html`${popHead(L`この軍勢を P,Q で確認`)}
    <p class="pop-line">${L`読み取り専用です。P,Q は確認する場所であり、行き先でも現在地の証明でもありません。`}</p>
    ${model.kind === 'village' ? html`<p class="pop-line">${L`この村が発行した軍勢の番号を入力してください。番号 0 も有効です。これは現在地や生存の証明ではありません。`}</p>
      <label class="pop-line">${L`軍勢の発行番号`} <input type="text" inputmode="numeric" autocomplete="off" maxlength="10" data-bind="expedition-sequence" value="${state.sequence ?? ''}"></label>` : html`<p class="pop-line">${L`選択した軍勢`}: ${model.host.id}</p>`}
    <div class="pop-line"><label>P <input type="text" inputmode="text" autocomplete="off" maxlength="20" data-bind="expedition-p" value="${state.p ?? ''}" aria-label="P"></label>
      <label>Q <input type="text" inputmode="text" autocomplete="off" maxlength="20" data-bind="expedition-q" value="${state.q ?? ''}" aria-label="Q"></label></div>
    <p class="pop-line">${L`リング 128 より外の整数を、先頭のゼロや空白なしで入力してください。`}</p>
    <p class="pop-line">${L`接続したウォレットを支払者の候補として表示するだけです。署名・支払い・送信は行いません。`}</p>
    <div class="pop-foot"><button type="button" class="btn primary" data-act="expedition-inspect" ${raw(unavailable ? 'aria-disabled="true"' : '')}>${state.status === 'loading' ? L`もう一度確認` : L`確認する`}</button></div>
    ${unavailable ? html`<p class="pop-line pop-why">${unavailable}</p>` : ''}
    <div aria-live="polite">${state.status === 'loading' ? html`<p class="pop-line">${L`読み取り中…`}</p>` : ''}
      ${state.error ? html`<p class="pop-line pop-why">${L`確認できません`}: ${state.error}</p>` : ''}
      ${report ? html`<p class="pop-line">${L`確認結果`}: ${report.status} · ${report.stage}</p>
        ${report.blocker ? html`<p class="pop-line pop-why">${report.blocker.code}</p>` : ''}
        <p class="pop-line">${L`観測のスロット`}: ${source.context_slot ?? '?'} · ${L`鮮度は不明です。権限や完了を証明する結果ではありません。`}</p>
        ${returnError ? html`<p class="pop-line pop-why">${L`帰還の手順を確認できませんでした。もう一度読み取ってください。`}</p>` : ''}
        ${returning ? returnCard(returning) : ''}
        ${returning?.proposal ? html`<details><summary>${L`実行できない役割案`}: ${returning.proposal.action}</summary><ul>${returning.proposal.roles.map(r => html`<li>${r.name}: ${r.address} · ${r.signer ? L`署名が必要` : L`署名不要`} · ${r.writable ? L`書き込み役割` : L`読み取り役割`}</li>`)}</ul></details>` : ''}
        ${localReturnBlock(FS, returning)}
        ${localConquestBlock(FS, returning)}
        ${returning?.proposal && !FS.localPlay && state.request.deployment.program_version === '18436' ? html`<section class="expedition-preparation" data-preparation-status="${state.preparation?.status ?? 'idle'}" aria-label="${L`署名前の準備確認`}">
          <p class="pop-line"><strong>${L`実験用の準備確認`}</strong></p>
          <p class="pop-line">${L`署名前の内容を取り直して確認します。署名・支払い・送信は行いません。`}</p>
          <button type="button" class="btn" data-act="expedition-prepare" ${raw(state.preparation?.status === 'loading' ? 'aria-disabled="true"' : '')}>${L`署名前の準備内容を確認`}</button>
          ${state.preparation?.status === 'loading' ? html`<p class="pop-line">${L`読み取り中…`}</p>` : ''}
          ${state.preparation?.error ? html`<p class="pop-line pop-why">${L`準備内容を確認できません`}: ${state.preparation.error}</p>` : ''}
          ${state.preparation?.report?.blocker ? html`<p class="pop-line pop-why">${L`準備内容を確認できません`}: ${state.preparation.report.blocker.code}</p>` : ''}
          ${state.preparation?.report?.prepared ? preparationDetails(state.preparation.report) : ''}
        </section>` : ''}
        ${report.draft_blocker ? html`<p class="pop-line">${report.draft_blocker}</p>` : ''}` : ''}</div>
    <p class="pop-line pop-rule">${L`公開の実行経路は閉じたままです。帰還済みとは判定せず、地図や行軍記録も変更しません。`}</p>`;
}

/**
 * Local play only (FS.localPlay; flocalplay-return.mjs): the two player-signed steps of the return, on the return
 * card. The step offered is the one the card's own observation names (`returning.proposal`), never a choice here.
 * Two presses: 準備 (nothing is signed; what would be signed is then shown) and 署名して送る. What it says at the end is
 * only that this step's transaction is recorded: after the first step the turn still has to be processed, and the
 * reserve is only ever shown by the card's next read. An outcome that is not known is said as not known, with the
 * one thing that may be done (ask again); never sent a second time.
 */
function localReturnBlock(FS, returning) {
  if (!FS.localPlay) return '';
  const d = localReturnOf(FS), offered = returning?.proposal?.action ?? null;
  if (d.status === 'idle' && !offered) return '';
  const name = a => (a === 'Dissolve' ? L`広域で解散を指示` : a === 'Return' ? L`元の村の予備兵に戻す` : '?');
  const sig = d.signature ? `${d.signature.slice(0, 8)}…${d.signature.slice(-6)}` : '', dig = d.digest ? `${d.digest.slice(0, 12)}…` : '';
  const step = { preparing: L`署名前の内容を用意して確かめています…`, signing: L`このページのテスト用ウォレットで署名しています…`, submitting: L`送信して結果を待っています…` }[d.status];
  const line = step ? html`<p class="pop-line local-return-step" role="status">${step}</p>`
    : d.status === 'prepared' ? html`<p class="pop-line local-return-prepared" role="status">${L`署名する内容を確かめました：${name(d.action)}（メッセージ ${dig}・有効期限のブロック高 ${d.lastValidBlockHeight}）。このページのテスト用ウォレットだけが署名し、手数料も支払います。`}</p>
        ${d.action === 'Return' && d.returnUnits !== null ? html`<p class="pop-line">${L`予備兵に戻す人数の候補: ${fmtNum(d.returnUnits)}人`}</p>` : ''}`
    : d.status === 'confirmed' ? html`<p class="pop-line local-return-done" role="status">${d.action === 'Dissolve'
        ? L`解散の指示が記録されました。ターンの処理が済むまで待ち、もう一度読み取ってください。帰還はまだ終わっていません。`
        : L`予備兵に戻す取引が記録されました。もう一度読み取って、予備兵の人数を確認してください。`} <span>${L`署名 ${sig}`}</span></p>`
    : d.status === 'submitted' ? html`<p class="pop-line local-return-sent" role="status">${L`送信しました。記録されたかどうかはまだ確認できていません。署名 ${sig}`}${d.error ? html` <span>${L`（照合できませんでした：${d.error}）`}</span>` : ''}</p>`
    : d.status === 'unknown' ? html`<p class="pop-line local-return-unknown" role="alert">${L`結果を確認できませんでした。この手順が記録されたかどうかは不明です。もう一度送らずに、結果を照合してください。署名 ${sig}`}${d.error ? html` <span>${L`（照合できませんでした：${d.error}）`}</span>` : ''}</p>`
    : d.status === 'expired' ? html`<p class="pop-line local-return-expired" role="status">${L`この操作は反映されませんでした。送った取引は有効期限を過ぎ、記録されていません。署名 ${sig}`}</p>`
    : d.status === 'failed' ? html`<p class="pop-line local-return-failed" role="alert">${L`この手順の取引は失敗しました（理由 ${d.code ?? '?'}）。何も変わっていません。署名 ${sig}`}</p>`
    : d.status === 'error' ? html`<p class="pop-line local-return-error" role="alert">${L`この手順を進められませんでした（${d.error ?? '?'}）。${d.sent ? '' : L`何も送っていません。`}`}</p>` : '';
  const settle = d.status === 'unknown' || d.status === 'submitted', spent = localReturnSpent(FS), other = hostStepInFlight(FS, 'return') !== null, off = d.busy || other ? 'aria-disabled="true"' : '';
  // (one step at a time for this host: while a siege is being sent or its outcome is not known, no return step)
  const prepare = label => html`<button type="button" class="btn small" data-act="local-return-prepare" ${raw(d.busy || !offered || spent || other ? 'aria-disabled="true"' : '')}>${label}</button>`;
  const buttons = settle ? html`<button type="button" class="btn small" data-act="local-return-reconcile" ${raw(off)}>${L`結果を照合する`}</button>`
    : d.status === 'prepared' ? html`<button type="button" class="btn primary" data-act="local-return-send" ${raw(off)}>${L`署名して送る（ローカルプレイ）`}</button>${prepare(L`準備し直す`)}`
    : prepare(d.busy ? L`確かめています…` : offered ? L`「${name(offered)}」を準備する（ローカルプレイ）` : L`準備し直す`);
  return html`<section class="expedition-local-return" data-local-return="${d.status}" aria-label="${L`ローカルプレイ：帰還の手順を送る`}">
    <p class="pop-line">${L`ローカルプレイ：帰還の手順を、このページのテスト用ウォレットの署名で一つずつ送ります（このマシンの試験用の世界だけ）。まず準備して内容を確かめ、次に自分で送ります。`}</p>
    ${line}
    <div class="pop-foot">${buttons}
      ${other ? html`<span>${L`この軍勢の別の手順を送っているか、その結果がまだ分かっていません。先にそちらを照合してください。`}</span>`
        : spent && !d.busy && !settle ? html`<span>${L`この読み取り結果ではすでに手順を送りました。次へ進むには、もう一度読み取ってください。`}</span>` : ''}</div></section>`;
}

/**
 * Local play only (FS.localPlay; flocalplay-conquest.mjs): the siege of the Free City in the province the host stays
 * in, on the expedition card. Offered only while the card's observation says the host STAYS (the `resident` phase)
 * and this start carries a world capability (`FS.localPlay.conquestWorld`); without one the card says, in one line,
 * that this test world has no city to besiege, and offers nothing to press. (The same signed message lands as a
 * reservation or, when the province is already resolved through the turn, as an immediate declaration: the program
 * decides at execution. So `confirmed` says only that the transaction is recorded, never which of the two it became
 * and never that the siege has not started — that is for a read of the table, which does not exist yet.) Two presses: 準備 (nothing is signed; what
 * would be signed is shown) and 署名して送る.
 *
 * What the signed step is (decision B, 2026-11-12): a RESERVATION of a siege. It becomes a siege only if its
 * conditions hold when its turn is processed; it cannot be cancelled; if it does not start, the deposit and the
 * holding slot come back and the day's declaration count stays used; of several reservations on one city the first
 * that meets the conditions becomes the siege. The block says so BEFORE the first press. At the end it says only that
 * the reservation's transaction is recorded: whether the siege started, its result and any capture are for a later
 * read to show (`order`, fconquest-order.mjs; none is read today), and staying here is not owning the city.
 */
function localConquestBlock(FS, returning) {
  // (what became of a reservation is only ever a fact of the read-only reservation read, made on the player's own press:
  //  flocalplay-conquest.mjs `readLocalConquestOrders`. It shows a reservation still waiting, or one that did not take
  //  effect with what is still owed — and nothing for a record that is gone)
  // (the step's own lines belong to the host and the identity it was prepared for: on another host's card, or after
  //  the wallet / Season / program changed, they are not drawn; if such a step is still unsettled the card says so)
  const shown = localConquestShown(FS);
  return localConquestView(FS, returning, { state: shown.state, foreign: shown.foreign, spent: localConquestSpent(FS), other: hostStepInFlight(FS, 'conquest') !== null,
    // (both for THIS start's city: a read of another province is no evidence about it — not its orders, not "no reservation")
    order: localConquestOrderFor(FS, FS.localPlay?.conquestWorld ?? null), read: localConquestReadFor(FS, FS.localPlay?.conquestWorld ?? null),
    city: localConquestCityFor(FS, FS.localPlay?.conquestWorld ?? null) });
}
/**
 * The lines for one reserved siege, from the card's model of it (fconquest-order.mjs `siegeOrderModel`), or '' for
 * none. A model that could not be made (`{ok: false}`) is said as unreadable: never as a success or a failure. What
 * came back is said only as a fact of the model ("returned"), otherwise as still waiting; a capture is said only by
 * the `captured` phase, which the model gives for the three capture facts together and nothing less.
 */
export function siegeOrderView(order) {
  if (order === null || order === undefined) return '';
  if (order.ok !== true) return html`<p class="pop-line pop-why local-conquest-order" data-siege-order="unreadable" role="status">${L`包囲の予約の状態を読み取れませんでした。成立したとも、しなかったとも表示しません。`} (${order.code ?? '?'})</p>`;
  const o = order;
  const reason = { HostGone: L`軍勢がもういません`, HostNotOnTile: L`軍勢が自由都市のマスにいません`, HostNotLeading: L`軍勢がそのマスの先頭ではありません`, CityNotFree: L`都市はもう自由都市ではありません`,
    AnotherOrderApplied: L`先に条件を満たした別の予約が包囲になりました`, NoHoldingSlot: L`拠点の使用枠が空いていません`, TooLate: L`この世界の受付の終わりまでに包囲が終わりません` }[o.reason] ?? o.reason;
  const failed = o.phase === 'not_applied';
  // (a reservation that did not start: the slot with its rent, and the deposited resources, come back separately. A
  //  deposit still held is OWED back, kept as a debt; with the slot already released that is said in so many words,
  //  and it is not a finished settlement)
  // (a deposit owed to a Holding that no longer exists stays owed: where it goes instead is not decided, and that is what is said)
  const stake = failed && o.stake === 'held' && o.source === 'absent' ? L`預けた資源：返却待ちです。返却先の拠点がもうありません。返却の債務として残っており、まだ結果を受け取っていません。いつ、どこへ戻るかはまだ決まっていません。`
    : failed ? { held: L`預けた資源：返却待ちです。返却の債務として残っており、まだ結果を受け取っていません。`, returned: L`預けた資源：戻りました。` }[o.stake]
    : { held: L`預けた資源：返却の処理待ちです。`, returned: L`預けた資源：戻りました。`, burnt: L`預けた資源：戻りません。` }[o.stake];
  const slot = failed ? { held: L`使用枠と預り金：解放待ちです。`, released: L`使用枠と預り金：解放済みです。` }[o.slot]
    : { held: L`使用枠：返却の処理待ちです。`, released: L`使用枠：戻りました。`, used: L`使用枠：新しい拠点が使っています。` }[o.slot];
  const head = o.phase === 'ordered' ? L`包囲の予約：ターン ${o.orderBell} の処理を待っています（場所 ${o.site}）。まだ包囲は始まっていません。取り消しはできません。`
    : o.phase === 'started' ? L`包囲が始まりました（ターン ${o.decidedBell}・場所 ${o.site}）。勝敗と占領は、このあとのターンの処理で決まります。都市はまだあなたのものではありません。`
    // (no cause is stored for this: a general sentence, never a specific cause stated as fact. How it ended is said only
    //  on a basis: `lapsed` false = its own turn was processed; true = the season ended or was interrupted; null = not known)
    : failed && o.lapsed === false ? L`包囲は始まりませんでした（ターン ${o.decidedBell}・場所 ${o.site}）。予約したターンの処理のときに条件を満たさなかったか、先の予約が包囲になりました。今日の宣言回数は1回使われたままです。`
    : failed && o.lapsed === true ? L`包囲は始まりませんでした（場所 ${o.site}）。世界の受付の終了または中断により、予約は成立しませんでした。今日の宣言回数は1回使われたままです。`
    : failed ? L`包囲は始まりませんでした（場所 ${o.site}）。予約は成立しませんでした。今日の宣言回数は1回使われたままです。`
    : o.phase === 'captured' ? L`自由都市を占領しました（場所 ${o.site}・ターン ${o.decidedBell}）。占領の記録、新しい拠点、使用枠を確認しました。`
    : o.phase === 'lost' ? L`包囲は失敗しました（場所 ${o.site}・ターン ${o.decidedBell}）。都市は占領していません。`
    : L`包囲は決着しないまま終わりました（場所 ${o.site}・ターン ${o.decidedBell}）。都市は占領していません。`;
  // (while reserved or under way the deposit and the slot are simply held: said once, in the block's first line, not as "waiting to be returned")
  const owed = o.phase === 'ordered' || o.phase === 'started' ? '' : html`<p class="pop-line" data-siege-return="stake">${stake}</p><p class="pop-line" data-siege-return="slot">${slot}</p>${failed && !o.settled
    // (nothing here promises that what is owed comes back by itself: a settlement has to be run, and no runner is promised)
    ? html`<p class="pop-line" data-siege-return="note">${L`返却と解放は、包囲の結果を受け取ったときに反映されます。自動で行われるとは限りません。`}</p>` : ''}`;   // (two facts, two lines)
  return html`<div class="local-conquest-order" data-siege-order="${o.phase}" data-siege-settled="${o.settled ? 'yes' : 'no'}" role="status">
    <p class="pop-line"><strong>${head}</strong></p>${owed}
    ${failed && o.reason !== null ? html`<p class="pop-line" data-siege-reason="derived">${L`状態から導出した理由（記録された理由ではありません）：${reason}`}</p>` : ''}
    ${o.day ? html`<p class="pop-line">${L`今日の宣言回数：${o.day.used} / ${o.day.limit}`}</p>` : ''}</div>`;
}
/**
 * The block's markup for a given state: what `localConquestBlock` shows for the page's live state, and what a
 * fixture page shows for a state written by hand (no signing, no send: the keyless display of every outcome).
 * `view`: `{state, spent, other}` as flocalplay-conquest.mjs / flocalplay-hoststep.mjs give them, and `order`: the
 * card's model of this host's reserved siege (`siegeOrderView`), or null; and `read`: the reservation read's state
 * (its button and what it said), or null for none.
 */
/**
 * The line for the city's PRESENT state (fconquest-order.mjs `cityStateModel`; null → ''). Present facts only: a siege
 * says its own progress of its own requirement; a capture due says the turn it is due from; "yours now" says that the
 * wallet's Citizen holds a Holding there now, and nothing of how it came to (no "captured", no "won"); a slot owed
 * says only that; another player's is said by its kind, without their numbers.
 */
export function cityStateView(city) {
  if (city === null || city === undefined) return '';
  const c = city;
  const text = c.state === 'siege' ? L`あなたの包囲が進行中です：${c.progress} / ${c.required} ターン（宣言はターン ${c.declaredBell}・場所 ${c.site}）。都市はまだあなたのものではありません。`
    : c.state === 'capture_due' ? L`あなたの包囲は必要なターンを満たし、占領の結果を受け取るのを待っています（ターン ${c.dueBell} 以降・宣言はターン ${c.declaredBell}・場所 ${c.site}）。都市はまだあなたのものではありません。`
    : c.state === 'owned' ? L`この都市はいま、あなたが所有しています（場所 ${c.site}・拠点の枠 ${c.slot}）。いま所有しているという事実だけを表示しています。`
    : c.state === 'slot_owed' ? L`この都市へのあなたの包囲は、いまは進行していません。拠点の使用枠 ${c.slot} は解放待ちです（場所 ${c.site}）。`
    : c.what === 'siege' ? L`この都市では、別のプレイヤーの包囲が進行中です。`
    : c.what === 'capture_due' ? L`この都市では、別のプレイヤーの包囲が占領の結果を待っています。`
    : c.what === 'holding' ? L`この都市はいま、別のプレイヤーが所有しています。`
    : L`この都市には、別のプレイヤーの包囲に関する記録があります。`;
  return html`<p class="pop-line local-conquest-city" data-siege-city="${c.state}" role="status"><strong>${text}</strong></p>`;
}
export function localConquestView(FS, returning, { state: d, spent, other, order = null, read = null, city = null, foreign = false }) {
  if (!FS.localPlay) return '';
  const staying = returning?.phase === 'resident', orderLines = siegeOrderView(order);
  // (a host that no longer stays is offered nothing; what became of its reservation is still said)
  // The reservation read (`read`: flocalplay-conquest.mjs `localConquestReadFor`, or null where there is none — a
  // fixture): one button, the player's own press, and what the read said. "No record" is said as exactly that: a
  // record that is gone does not tell whether a siege started, a return completed, or nothing was reserved.
  // (the city's present state stands with the order's lines: what is there now, beside what the record says)
  const cityLines = cityStateView(city);
  const readLines = read === null || !FS.localPlay.conquestWorld ? '' : html`<div class="local-conquest-read" data-siege-read="${read.status}">
    ${read.status === 'reading' ? html`<p class="pop-line" role="status">${L`予約の状態を読み取っています…`}</p>`
      : read.status === 'error' ? html`<p class="pop-line pop-why" role="alert">${read.error === 'ConquestRouteClosed' ? L`包囲の経路はまだ閉じています（試験用の世界での確認が済んでいません）。` : L`予約の状態を読めませんでした。`} (${read.error ?? '?'}) ${L`予約の状態は分かりません。`}</p>`
      : read.status === 'read' && !orderLines && !cityLines ? html`<p class="pop-line" role="status">${L`この州の記録に、この都市へのあなたの予約はいまありません（読み取りのスロット ${read.contextSlot}）。記録がないことだけでは、包囲が始まったのか、返却が済んだのか、予約がなかったのかは分かりません。`}</p>`
      : read.status === 'read' ? html`<p class="pop-line">${L`読み取りのスロット ${read.contextSlot}。記録にある事実だけを表示しています。`}</p>` : ''}
    <div class="pop-foot"><button type="button" class="btn small" data-act="local-conquest-orders" ${raw(read.busy ? 'aria-disabled="true"' : '')}>${read.busy ? L`読み取り中…` : L`包囲予約の状態を読む（ローカルプレイ）`}</button></div></div>`;
  if (d.status === 'idle' && !staying) return orderLines || cityLines || readLines ? html`<section class="expedition-local-conquest" data-local-conquest="order-only" aria-label="${L`ローカルプレイ：自由都市を包囲する`}">${orderLines}${cityLines}${readLines}</section>` : '';
  const world = FS.localPlay.conquestWorld ?? null;
  if (d.status === 'idle' && !world) return html`<section class="expedition-local-conquest" data-local-conquest="unavailable"><p class="pop-line pop-why">${L`ローカルプレイ：この試験用の世界には、包囲できる自由都市がまだありません。包囲は使えません。`}</p></section>`;
  const sig = d.signature ? `${d.signature.slice(0, 8)}…${d.signature.slice(-6)}` : '', dig = d.digest ? `${d.digest.slice(0, 12)}…` : '';
  const step = { preparing: L`署名前の内容を用意して確かめています…`, signing: L`このページのテスト用ウォレットで署名しています…`, submitting: L`送信して結果を待っています…` }[d.status];
  const why = { ConquestRouteClosed: L`包囲の経路はまだ閉じています（試験用の世界での確認が済んでいません）。`, ConquestWorldUnavailable: L`この試験用の世界には、包囲できる自由都市がまだありません。`,
    ConquestNoFreeCityHere: L`この軍勢がいる州には、包囲できる自由都市がありません。`, ConquestHostNotStaying: L`この軍勢は、いま滞在中ではありません。`,
    TargetNotFreeCity: L`対象は自由都市ではありません。`, HostNotOnTarget: L`この軍勢は自由都市のマスにいません。`, SiegeUnavailable: L`いまは包囲を予約できません。`,
    ConquestCityHeld: L`この都市はすでに所有されています。包囲の予約は送れません。` }[d.error] ?? null;
  const line = step ? html`<p class="pop-line local-conquest-step" role="status">${step}</p>`
    : d.status === 'prepared' ? html`<p class="pop-line local-conquest-prepared" role="status">${L`署名する内容を確かめました：自由都市の包囲を予約（州 ${d.standing?.p ?? '?'}, ${d.standing?.q ?? '?'}・場所 ${d.site}・メッセージ ${dig}・有効期限のブロック高 ${d.lastValidBlockHeight}）。このページのテスト用ウォレットだけが署名し、手数料も支払います。`}</p>
        <p class="pop-line pop-why">${L`送ると取り消せません。包囲が始まらなくても、今日の宣言回数は1回使われます。`}</p>`
    : d.status === 'confirmed' ? html`<p class="pop-line local-conquest-done" role="status">${L`取引が記録されました。予約として受け付けられたのか、すでに包囲として始まったのかは、まだ確認できていません。占領もまだ分かりません。受け付けられた予約は取り消せません。`} <span>${L`署名 ${sig}`}</span></p>`
    : d.status === 'submitted' ? html`<p class="pop-line local-conquest-sent" role="status">${L`送信しました。記録されたかどうかはまだ確認できていません。署名 ${sig}`}${d.error ? html` <span>${L`（照合できませんでした：${d.error}）`}</span>` : ''}</p>`
    : d.status === 'unknown' ? html`<p class="pop-line local-conquest-unknown" role="alert">${L`結果を確認できませんでした。この取引が記録されたかどうかは不明です。もう一度送らずに、結果を照合してください。署名 ${sig}`}${d.error ? html` <span>${d.chain === null ? L`（送信の応答を確認できませんでした：${d.error}）` : L`（照合できませんでした：${d.error}）`}</span>` : ''}</p>`
    : d.status === 'expired' ? html`<p class="pop-line local-conquest-expired" role="status">${L`この操作は反映されませんでした。送った取引は有効期限を過ぎ、記録されていません。署名 ${sig}`}</p>`
    : d.status === 'failed' ? html`<p class="pop-line local-conquest-failed" role="alert">${L`包囲を予約する取引は失敗しました（理由 ${d.code ?? '?'}）。何も変わっていません。署名 ${sig}`}</p>`
    : d.status === 'error' ? html`<p class="pop-line local-conquest-error" role="alert">${why ?? L`包囲を予約できませんでした。`} (${d.error ?? '?'}) ${d.sent ? '' : L`何も送っていません。`}</p>` : '';
  const settle = d.status === 'unknown' || d.status === 'submitted', off = d.busy || other ? 'aria-disabled="true"' : '';
  // (one step at a time for this host: while a return step is being sent or its outcome is not known, no siege)
  // (a city the read has shown to be HELD — by this wallet or by another player — is not offered a reservation: the
  //  button is not drawn at all. A display choice only: it withholds an action the program would refuse; no rule is
  //  decided here. The read button stays, so the present state can be read again)
  const heldCity = city !== null && (city.state === 'owned' || (city.state === 'other' && city.what === 'holding'));
  // (`foreign`: a siege step of ANOTHER host or identity is still running or unsettled — nothing is prepared here until it is settled on its own card)
  const prepare = label => (heldCity ? '' : html`<button type="button" class="btn small" data-act="local-conquest-prepare" ${raw(d.busy || !staying || !world || spent || other || foreign ? 'aria-disabled="true"' : '')}>${label}</button>`);
  const buttons = settle ? html`<button type="button" class="btn small" data-act="local-conquest-reconcile" ${raw(off)}>${L`結果を照合する`}</button>`
    // (a message prepared BEFORE the read showed the city held is not offered for signing either: no send button, and the module refuses it too)
    : d.status === 'prepared' && heldCity ? html`<span role="status">${L`この都市はすでに所有されています。包囲の予約は送れません。`}</span>`
    : d.status === 'prepared' ? html`<button type="button" class="btn primary" data-act="local-conquest-send" ${raw(off)}>${L`署名して送る（ローカルプレイ）`}</button>${prepare(L`準備し直す`)}`
    // (while the wallet signs or the relay is asked, the line above says what is happening: no button stands there with another word on it)
    : d.status === 'signing' || d.status === 'submitting' ? ''
    : prepare(d.busy ? L`確かめています…` : L`自由都市の包囲予約を準備する（ローカルプレイ）`);
  return html`<section class="expedition-local-conquest" data-local-conquest="${d.status}" aria-label="${L`ローカルプレイ：自由都市を包囲する`}">
    <p class="pop-line">${L`ローカルプレイ：この州の自由都市への包囲を予約します（このマシンの試験用の世界だけ）。滞在しているだけでは、都市はあなたのものではありません。まず準備して内容を確かめ、次に自分で送ります。`}</p>
    <ul class="local-conquest-rules">
      <li>${L`予約は、予約したターンの処理のときに条件を満たしていれば包囲として始まります。資源を預け、拠点の使用枠を1つ押さえます。`}</li>
      <li>${L`予約は取り消せません。`}</li>
      <li>${L`包囲が始まらなかった場合、預けた資源と使用枠は戻りますが、今日の宣言回数は1回使われたままです。`} ${L`戻るのは包囲の結果を受け取ったときで、それまでは「返却待ち」と表示します。`}</li>
      <li>${L`同じ都市に複数の予約がある場合、処理のときに条件を満たす最初の予約だけが包囲になります。`}</li>
    </ul>
    ${orderLines}
    ${cityLines}
    ${readLines}
    ${line}
    <div class="pop-foot">${buttons}
      ${other ? html`<span>${L`この軍勢の別の手順を送っているか、その結果がまだ分かっていません。先にそちらを照合してください。`}</span>`
        : foreign ? html`<span role="status">${L`別の軍勢またはウォレットで送った包囲の結果が、まだ確定していません。その軍勢のカードで結果を照合してください。`}</span>`
        : spent && !d.busy && !settle ? html`<span>${L`この読み取り結果ではすでに手順を送りました。次へ進むには、もう一度読み取ってください。`}</span>` : ''}</div></section>`;
}

/** Public bytes only, deliberately no acceptance or wallet/send control. */
function preparationDetails(report) {
  const p = report.prepared, b = report.blockhash;
  return html`<p class="pop-line"><strong>${L`署名前の内容を照合しました`}</strong></p>
    <p class="pop-line pop-why">${L`実験用の未署名データです。実行できることや帰還の完了を確認した結果ではありません。`}</p>
    <p class="pop-line">${L`今回の記録のスロット`}: ${report.source.context_slot} · ${L`有効期限の観測時点で残るブロック高`}: ${b.remaining_block_heights}</p>
    <p class="pop-line">${L`有効期限は時間とともに変わります。必要なときに取り直してください。`}</p>
    <details><summary>${L`準備内容の詳細`}</summary>
      <p class="pop-line">${p.action} · ${p.shape.bytes} bytes · ${p.shape.locks} accounts · ${p.shape.sigs} signers</p>
      <p class="pop-line">CU: ${p.budget.cu_limit} · CU price: ${p.budget.cu_price} · loaded bytes: ${p.budget.loaded_limit}</p>
      <p class="pop-line" style="overflow-wrap:anywhere">Fee payer: ${p.fee_payer}</p>
      <p class="pop-line" style="overflow-wrap:anywhere">Blockhash: ${b.hash}</p>
      <p class="pop-line" style="overflow-wrap:anywhere">Selected snapshot: ${report.request.source_snapshot_digest}</p>
      <p class="pop-line" style="overflow-wrap:anywhere">Fresh snapshot: ${report.source.digest}</p>
      <p class="pop-line" style="overflow-wrap:anywhere">Message SHA-256: ${p.message_digest}</p>
      <ul>${p.roles.map(r => html`<li style="overflow-wrap:anywhere">${r.name}: ${r.address} · ${r.signer ? L`署名が必要` : L`署名不要`} · ${r.writable ? L`書き込み役割` : L`読み取り役割`}</li>`)}</ul>
    </details>`;
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
