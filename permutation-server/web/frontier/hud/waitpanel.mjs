// "While you wait" (owner r0ze 2026-11-26 15:48 Q-PT-13: always shown, collapsible; reports/playtest-priorities-design.md
// area 3, W1). One panel in the bottom-left rail (a phone: the sheet at rest) with the player's own timers and a few
// suggested next actions. Built ONLY from the viewer's own records the page already holds — its marches (FS.marches),
// its hosts (screens/host.mjs hostRows), its land record (FS.ownLand), the keep contest its own host or march is part of
// (screens/conquestguide.mjs conquestFacts) — and, for the battle to check, the offer the caller has already let through
// the fog (hud/firstbattle.mjs battleOffer, fed by app.mjs clashHere). Nothing here reads another player's state, fetches,
// or sends. Times are "about": they come from the turn pipeline, and a lagging keeper is later.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { unitCount } from '../fi18n.mjs';
import { UNIT_ORDER, SCOUT, SETTLER } from '../fland.mjs';
import { bellStart, bellAt } from '../clock.mjs';
import { activeHolding } from '../fstate.mjs';
import { icon } from './icons.mjs';
import { hostWaits, waitOf } from './keephand.mjs';
import { ownReportDue, earliestReportAt, reportEtaAt } from './firstbattle.mjs';
import { musterBellOf } from './firststeps.mjs';
import { dueHtml } from '../screens/shell.mjs';
import { hostRows } from '../screens/host.mjs';
import { DEPART_STAMINA, RULES } from '../fmarch.mjs';
import { provinceName } from './place.mjs';
import { queueSlots } from './rulebook.mjs';
import { FLAG } from '../onboarding.mjs';
import { conquestFacts } from '../screens/conquestguide.mjs';
import { ownLandView } from '../flocalplay-territory.mjs';
import { villageConfirm, confirmPending } from './provisional.mjs';
import { horizonFromFS } from '../screens/holding.mjs';
import { paidAgainCase, horizonHudLine } from '../landhorizon.mjs';

/** How many suggestions the panel lists at most. */
export const WAIT_SUGGESTIONS = 3;
/** The panel's place in the stored UI preferences (fui.mjs `waitPanel`). */
export const waitOpen = FS => FS?.ui?.waitPanel !== 'closed';

const combat = r => r && r.unit !== SCOUT && r.unit !== SETTLER;
const at = (FS, bell) => (FS?.clock && Number.isInteger(bell) ? bellStart(Number(FS.clock.genesisTs), bell) : null);

/**
 * The panel's content: `{timers: [{id, kind, at, ...}], suggestions: [{id, act, data}], soonest}` or null when the viewer
 * has no village yet (no own state to speak of). `offer`: hud/firstbattle.mjs battleOffer's answer (fog already applied).
 * `horizon`: the village card's land projection (screens/holding.mjs horizonFromFS; read from FS when not given).
 */
export function waitModel(FS, { offer = null, horizon } = {}) {
  if (FS?.mode !== 'play' || !activeHolding(FS)) return null;
  const h = activeHolding(FS);
  const flags = new Set(FS.ui?.dismissed ?? []);
  const timers = [];
  // 1 the viewer's own battle report
  const due = ownReportDue(FS);
  if (due) timers.push({ id: 'report', kind: 'report', at: due.at, arrive: due.arriveBell, dest: due.dest });
  let rows = [];
  try { rows = hostRows(FS).filter(combat); } catch { rows = []; }
  // (fix-loop24, LP22/loop-play24 BREAK-5: in the first seconds of every turn the host's province is a moment behind the
  //  new turn — keephand.mjs waitOf says `settling` — and a standing host was neither resting nor ready: the panel said
  //  「いま待っているものはありません」 for about a quarter of each turn at ×60. What the host waits for does not change with
  //  the province catching up: its ready turn and its stamina are its own. Read through the settling moment — settledWait)
  const ready = rows.find(r => { const w = waitOf(FS, r); return !w || (w.why === 'settling' && r.state === 1 && !settledWait(FS, r)); }) ?? null;
  // (a ready host and no report awaited: when a march sealed this turn would be reported at the earliest. Said for any
  //  march — the page forgets a march once it is settled, so "first" could not be told from the records)
  if (!due && ready) {
    const t = earliestReportAt(FS.clock, FS.nowBell, FS.season);
    if (t !== null) timers.push({ id: 'next-report', kind: 'nextReport', at: t });
  }
  // 2 the viewer's hosts: forming, resting, short of stamina (a host on a march is the report above)
  let waits = [];
  try { waits = hostWaits(FS); } catch { waits = []; }
  for (const w of waits) {
    if (timers.filter(x => x.id.startsWith('host:')).length >= 2) break;
    // (fix-loop22, LP22-3/LP22-8: a host still forming — `forming`, or `settling` while its row is still state 2 — stands
    //  when its MUSTER turn is resolved (the turn's end, the seals' window, the seed margin, the keeper: firstbattle.mjs
    //  reportEtaAt, the clock the own report's ETA uses and which matched to the minute), not at the start of the next
    //  turn: a kept 1× world said "turn 1: in about 9 min" and the host stood on turn 2, 20.5 min after Form)
    const forming = formingAt(FS, w, rows);
    // (verify-pr267: a host pushed home by a keep or a camp comes back as state 2 too, with the stamina the march left it —
    //  54 of the 74 a departure needs, seen live in --demo —: it stands on that turn but may march only once the stamina is
    //  back, +1 a resolved turn (host.rs Stamina::at). The panel said 「整列し、ターン 22 から進軍できます」 of a host that
    //  could depart from turn 40; it says the stamina wait, as it does from the turn the host stands)
    const back = forming ? standsShort(FS, rows.find(x => String(x.id) === String(w.id)), forming.turn) : null;
    if (back) { timers.push({ id: `host:${w.id}`, kind: 'hostMarch', at: at(FS, back.turn), turn: back.turn, unit: w.unit, troops: w.troops, stamina: back.stamina }); continue; }
    if (forming) { timers.push({ id: `host:${w.id}`, kind: 'hostForms', at: forming.at, turn: forming.turn, unit: w.unit, troops: w.troops, stamina: null }); continue; }
    // (fix-loop24: a standing host whose province is still settling the new turn: its own rest, as before the turn changed)
    // (verify-pr270: likewise a host whose march has arrived — its report is out — while its village's transit record is
    //  not settled yet (keephand.mjs waitOf `march`, `arrived`): for that turn it was no timer at all, and the panel said
    //  「いま待っているものはありません」 of a host short of stamina (live, --demo ×60: stamina 5, ready from turn 126).
    //  It may not depart before its own ready turn and stamina anyway: say that wait, from its own record)
    if (w.why === 'settling' || (w.why === 'march' && w.arrived)) {
      const r = rows.find(x => String(x.id) === String(w.id));
      const sw = r && r.state === 1 ? settledWait(FS, r) : null;
      if (sw) timers.push({ id: `host:${w.id}`, kind: 'hostMarch', at: at(FS, sw.turn), turn: sw.turn, unit: w.unit, troops: w.troops, stamina: sw.stamina ?? null });
      continue;
    }
    if (!['resting', 'stamina'].includes(w.why) || !Number.isInteger(w.turn)) continue;
    // (resting / short of stamina: the host may depart in turn `w.turn` — stamina is +1 per resolved turn (host.rs
    //  Stamina::at) and a departure in turn b reads it at b —, so from that turn's start; said on the wall clock at the
    //  world's real turn length by screens/shell.mjs dueHtml)
    timers.push({ id: `host:${w.id}`, kind: 'hostMarch', at: at(FS, w.turn), turn: w.turn, unit: w.unit, troops: w.troops, stamina: w.stamina ?? null });
  }
  if (ready) timers.push({ id: `host:${ready.id}`, kind: 'hostReady', at: null, unit: ready.unit, troops: ready.troops });
  // 3 land upkeep (the viewer's own land record, territory worlds)
  const player = FS.ownLand && Object.hasOwn(FS.ownLand, 'player') ? FS.ownLand.player : null;
  if (player) {
    const v = ownLandView(player, FS.nowBell ?? 0);
    const pa = v.tiles > 0 && v.unpaid ? upkeepPaidAgain(FS, horizon) : null;
    if (pa) timers.push({ id: 'upkeep', kind: 'upkeepPaidAgain', at: pa.now ? null : at(FS, (FS.nowBell ?? 0) + pa.paidIn), tiles: v.tiles, paidIn: pa.paidIn, now: pa.now, sustainable: pa.sustainable, line: pa.line });
    else if (v.tiles > 0) timers.push({ id: 'upkeep', kind: v.unpaid ? 'upkeepUnpaid' : 'upkeep', at: v.unpaid && Number.isInteger(v.turnsLeft) ? at(FS, (FS.nowBell ?? 0) + v.turnsLeft) : null, tiles: v.tiles, perHour: v.upkeepMilliPerHour / 1000, turnsLeft: v.turnsLeft });
  }
  // 4 the keep hold the viewer's own host or march is part of
  let x = null;
  try { x = conquestFacts(FS); } catch { x = null; }
  if (x?.holding) {
    const left = Math.max(0, x.holding.required - x.holding.progress);
    timers.push({ id: 'hold', kind: 'hold', at: at(FS, (FS.nowBell ?? 0) + left), p: x.holding.p, q: x.holding.q, progress: x.holding.progress, required: x.holding.required });
  }
  // 5 (fix-provisional-guide, loop-play23 BREAK-1) the provisional village: when it can be confirmed (hud/provisional.mjs —
  //  the program's finality_due), and once that time has passed, that the next action confirms it. The panel said
  //  「いま待っているものはありません」 beside 「控えの兵を軍勢にする」, which could not be pressed for hours
  let vc = null;
  try { vc = villageConfirm(FS); } catch { vc = null; }
  if (vc) timers.push({ id: 'village', kind: vc.state === 'waiting' ? 'villageWait' : vc.state === 'unknown' ? 'villageWaitUnknown' : 'villageNow', at: vc.state === 'waiting' ? vc.at : null, latest: !!vc.latest });
  // suggestions, from the same records
  const suggestions = [];
  // (the confirming action first, once it confirms: a Harvest needs no final village)
  if (vc && (vc.state === 'due' || vc.state === 'past')) suggestions.push({ id: 'confirm', act: 'harvest', data: {} });
  if (offer && !flags.has(FLAG.verified)) {
    if (offer.kind === 'real') suggestions.push({ id: 'verify', act: 'report-open', data: { p: offer.p, q: offer.q, bell: offer.bell }, mine: !!offer.mine });
    else if (!flags.has(FLAG.practiceMatch)) suggestions.push({ id: 'practice', act: 'practice-first', data: {} });
  }
  if (ready && !due) suggestions.push({ id: 'march', act: 'tab', data: { tab: 'hosts' }, unit: ready.unit, troops: ready.troops });
  const reserve = [0, 1, 2, 3, 4, 5].reduce((a, u) => a + Number(h.reserve?.[u] ?? 0), 0);
  // (no "Form a host" while the village cannot form one yet: the program refuses Muster NotFinal)
  if (!rows.length && reserve >= 100) { if (!confirmPending(vc)) suggestions.push({ id: 'muster', act: 'cg-go', data: { pop: 'muster' } }); }
  else if (!rows.length && !(FS.marches ?? []).length) suggestions.push({ id: 'train', act: 'cg-go', data: { pop: 'train' } });
  const now = FS.chain?.now?.() ?? 0;
  const busy = (h.queue ?? []).filter(q => q && q.kind === 1 && Number(q.doneAt) > now).length;
  if (busy < queueSlots(h.tier)) suggestions.push({ id: 'build', act: 'cg-go', data: { pop: 'build' } });
  const timed = timers.filter(t => Number.isFinite(t.at)).sort((a, b) => a.at - b.at);
  return { timers, suggestions: suggestions.slice(0, WAIT_SUGGESTIONS), soonest: timed[0] ?? null };
}

/**
 * (fix-lp28-paid-again, owner Q-LP28-1 (b); loop-play28 BREAK-3) An unpaid land the village card's projection sees paid by
 * a coming payment before its grace ends (landhorizon.mjs paidAgainCase): `{paidIn, now, sustainable, line}` — the panel
 * then says that payment, not a let-go countdown — or null (no projection, or the release really comes: the countdown
 * stays). The projection is only taken while it is for the same unpaid record (its grace equals the chain record's).
 * `line`: the card's compact line, for a land production does not cover (it goes unpaid again later).
 */
export function upkeepPaidAgain(FS, horizon) {
  let h = horizon;
  if (h === undefined) { try { h = horizonFromFS(FS); } catch { h = null; } }
  const pa = paidAgainCase(h);
  if (!pa) return null;
  const v = ownLandView(FS?.ownLand?.player, FS?.nowBell ?? 0);
  if (!v.unpaid || h.graceTurnsLeft !== v.turnsLeft) return null;
  return { ...pa, line: pa.sustainable ? '' : horizonHudLine(h, h.rate) };
}

/**
 * (fix-loop24) What a standing host (state 1) waits for once its province has caught up with the turn, from its own
 * record alone: `{why: 'resting', turn}` before its ready turn, `{why: 'stamina', turn, stamina}` short of the stamina a
 * departure takes (the rule of keephand.mjs waitOf), or null — it may march then.
 */
export function settledWait(FS, r) {
  const bell = FS?.nowBell ?? 0;
  if (!r || r.state !== 1) return null;
  if (Number.isInteger(r.readyBell) && bell < r.readyBell) return { why: 'resting', turn: r.readyBell, stamina: null };
  const st = Number(r.stamina);
  if (Number.isFinite(st) && st < DEPART_STAMINA) return { why: 'stamina', turn: Math.max(bell + DEPART_STAMINA - st, Number.isInteger(r.readyBell) ? r.readyBell : 0), stamina: st };
  return null;
}

/**
 * (fix-loop24, BREAK-5) The panel keeps what it last said until new data is in: a model with no timer, for the same
 * village, while that village's own province has not caught up with the turn (`resolvedNext + 1 < nowBell`, the
 * "settling" moment of every turn change), no host of it is read at all although the last model had host timers, or the
 * last model awaited a march's report (the host between its report and home), and
 * no more than one turn after the last model with timers, is answered by that last model's timers. Pure: `prev` is
 * `{key, bell, model}` (null at first) → `{shown, keep}` (`keep` the record for next time).
 */
export function steadyWaitModel(FS, prev, model) {
  const h = activeHolding(FS), key = h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : null, bell = FS?.nowBell ?? null;
  if (!model) return { shown: model, keep: null };
  if (model.timers.length) return { shown: model, keep: { key, bell, model } };
  const own = h ? FS?.provinces?.get?.(`${h.p},${h.q}`)?.province ?? null : null;
  const behind = !own || Number(own.resolvedNext) + 1 < Number(bell);
  let rowsNow = 0;
  try { rowsNow = hostRows(FS).filter(combat).length; } catch { rowsNow = 0; }
  const lostRows = rowsNow === 0 && (prev?.model?.timers ?? []).some(t => String(t.id).startsWith('host:'));
  // (a march's report just came: its row left the list and its host is on the way home, not yet a standing host with a
  //  timer of its own — the panel said 「いま待っているものはありません」 for a few seconds then, --wide ×60)
  const marchGap = (prev?.model?.timers ?? []).some(t => t.kind === 'report');
  // (verify-pr270: that moment can span two turn changes — the march row gone late in its report's turn, the host read
  //  again in the turn after next —: live, --wide --ai 4 ×60, 4.5 s of 「いま待っているものはありません」 at the second change.
  //  The report's hold reaches one turn further; the others stay at one)
  const span = marchGap ? 2 : 1;
  if (prev && prev.key === key && prev.model?.timers?.length && Number.isInteger(bell) && Number.isInteger(prev.bell) && bell - prev.bell <= span && (behind || lostRows || marchGap)) {
    return { shown: { ...model, timers: prev.model.timers, soonest: prev.model.soonest }, keep: prev };
  }
  return { shown: model, keep: { key, bell, model } };
}

/**
 * (fix-loop22) When a forming host of wait `w` stands: `{at, turn}` — `at` the chain time its muster turn is expected to be
 * resolved (firstbattle.mjs reportEtaAt of hud/firststeps.mjs musterBellOf), `turn` the turn that runs then — or null for a
 * wait that is no forming host's. `rows`: screens/host.mjs hostRows' combat rows.
 */
export function formingAt(FS, w, rows = []) {
  if (!w || !(w.why === 'forming' || w.why === 'settling') || !FS?.clock) return null;
  const r = (rows ?? []).find(x => String(x.id) === String(w.id) && x.state === 2) ?? null;
  const b = musterBellOf(r);
  if (b === null) return null;
  const t = reportEtaAt(FS.clock, b);
  if (t === null) return null;
  return { at: t, turn: bellAt(Number(FS.clock.genesisTs), t) ?? b + 1 };
}

/**
 * (verify-pr267) A state-2 host `r` that stands on turn `turn` with less stamina than a departure takes: `{turn, stamina}` —
 * the turn its stamina reaches DEPART_STAMINA (+1 a turn from its stamina now, keephand.mjs waitOf's own count) and its
 * stamina now — or null (a newly formed host, at full stamina, or no row).
 */
export function standsShort(FS, r, turn) {
  const bell = FS?.nowBell, s = Number(r?.stamina);
  if (!r || !Number.isInteger(bell) || !Number.isFinite(s) || !Number.isInteger(turn)) return null;
  if (Math.min(RULES.STAMINA_CAP, s + Math.max(0, turn - bell)) >= DEPART_STAMINA) return null;
  return { turn: Math.max(turn, bell + DEPART_STAMINA - s, Number.isInteger(r.readyBell) ? r.readyBell : 0), stamina: s };
}

const who = t => unitCount(UNIT_ORDER[t.unit], Math.floor(Number(t.troops) || 0));

/** One timer in one line (markup). */
export function timerLine(FS, t) {
  const now = FS.chain?.now?.() ?? null;
  const due = Number.isFinite(t.at) ? dueHtml(t.at, now) : '';
  switch (t.kind) {
    case 'report': return html`${L`あなたの戦いの報告（ターン ${fmtNum(t.arrive)} の到着）：`}<strong>${due}</strong>`;
    case 'nextReport': return html`${L`このターンに封をして出発すると、戦いの報告は早くて`}<strong>${due}</strong>`;
    case 'hostForms': return html`${L`${who(t)} の軍勢が整列し、ターン ${fmtNum(t.turn)} から進軍できます：`}<strong>${due}</strong>`;
    case 'hostMarch': return html`${t.stamina !== null ? L`${who(t)} は体力を回復中で、ターン ${fmtNum(t.turn)} からまた進軍できます：` : L`${who(t)} は休息中で、ターン ${fmtNum(t.turn)} からまた進軍できます：`}<strong>${due}</strong>`;
    case 'hostReady': return html`${L`${who(t)} の軍勢は、いま進軍できます。`}`;
    case 'upkeep': return html`${L`土地 ${fmtNum(t.tiles)} マスの維持費：毎時 食料 ${fmtNum(t.perHour)}（払えています）`}`;
    case 'upkeepUnpaid': return html`${L`土地の維持費が払えていません。手放し始めるまで：`}<strong>${due || L`まもなく`}</strong>`;
    case 'upkeepPaidAgain':
      if (!t.sustainable) return html`${t.line}`;
      return t.now
        ? html`${L`土地の維持費は未払いです。今の支払いで払われ、その後はこの食料の生産でずっと維持できます。`}`
        : html`${L`土地の維持費は未払いです。${fmtNum(t.paidIn)} ターン後の支払いで払われ、その後はこの食料の生産でずっと維持できます。払われるのは：`}<strong>${due || L`まもなく`}</strong>`;
    case 'villageWait': return html`${t.latest ? L`あなたの村は仮の村です。確定できるのは遅くとも` : L`あなたの村は仮の村です。確定できるのは`}<strong>${due}</strong>${L`から。その時刻を過ぎたら、収穫などの行動をひとつすると確定し、軍勢を編成できます。`}`;
    case 'villageWaitUnknown': return html`${L`あなたの村は仮の村です。確定できるのは遅くとも申し込みから約 4 時間後で、そのあと行動をひとつすると確定します。`}`;
    case 'villageNow': return html`${L`あなたの村は、いま確定できます：`}<strong>${L`次の行動（収穫など）をひとつすると確定します`}</strong>`;
    case 'hold': return html`${L`${provinceName(FS, t.p, t.q, { own: false })}の砦のマス：${fmtNum(t.progress)} / ${fmtNum(t.required)} ターン保っています。州が手に入るのは`}<strong>${due}</strong>`;
    default: return '';
  }
}

const SUGGEST_ICON = { confirm: 'grain', verify: 'check', practice: 'swords', march: 'banner', muster: 'ranks', train: 'helmet', build: 'hammer' };
/** One suggestion's words: `{label, note}`. */
export function suggestionText(s) {
  switch (s.id) {
    case 'verify': return { label: L`本物の戦いを、このブラウザで確かめる`, note: s.mine ? L`あなたの戦いの報告を開き、「このブラウザで確かめる」で計算し直すと「一致」が出ます。` : L`見えている場所の戦いの報告を開き、「このブラウザで確かめる」で計算し直すと「一致」が出ます。` };
    case 'practice': return { label: L`練習の戦いで「計算し直す」を試す`, note: L`まだ開ける本物の戦いがありません。練習の戦い（チェーンの記録ではありません）で、計算し直して同じ結果になることを確かめられます。` };
    case 'march': return { label: L`軍勢を進軍させる`, note: L`${who(s)} の軍勢が出発できます。` };
    case 'confirm': return { label: L`収穫して村を確定する`, note: L`確定できる時刻を過ぎました。収穫で村が確定し、軍勢を編成できるようになります。` };
    case 'muster': return { label: L`控えの兵を軍勢にする`, note: L`控えの兵を一つの軍勢にまとめます。` };
    case 'train': return { label: L`兵を訓練する`, note: L`訓練はすぐに終わり、兵は村の控えに入ります。` };
    case 'build': return { label: L`建物を建てる`, note: L`建物の空きがあります。建物は毎時の産出を増やします。` };
    default: return { label: '', note: '' };
  }
}

const dataAttrs = d => raw(Object.entries(d ?? {}).map(([k, v]) => `data-${String(k).replace(/[^\w-]/g, '')}="${String(v).replace(/[^\w.,:-]/g, '')}"`).join(' '));

/**
 * The panel (markup): a heading whose button folds it (`data-act="wait-toggle"`, aria-expanded / aria-controls), the
 * soonest time beside it while folded, and when open the timers (a list) and the suggestions (buttons). '' for no model.
 * Not a live region: the times are redrawn as the page polls, and a screen reader is not interrupted by them.
 */
export function renderWaitPanel(FS, model, { open = waitOpen(FS) } = {}) {
  if (!model) return '';
  const soon = model.soonest && !open ? html`<span class="waitp-soon">${dueHtml(model.soonest.at, FS.chain?.now?.() ?? null)}</span>` : '';
  const head = html`<h2 class="waitp-h" id="waitp-h"><button type="button" class="waitp-tab" data-act="wait-toggle" aria-expanded="${open ? 'true' : 'false'}" aria-controls="waitp-body">${icon('hourglass')}<span>${L`待つあいだに`}</span>${soon}${icon('chevron', 'waitp-mark')}</button></h2>`;
  const timers = model.timers.length ? html`<ul class="waitp-timers">${model.timers.map(t => html`<li class="waitp-t waitp-${t.kind}" data-wait-timer="${t.kind}">${timerLine(FS, t)}</li>`)}</ul>` : html`<p class="muted">${L`いま待っているものはありません。`}</p>`;
  const sugg = model.suggestions.length ? html`<h3 class="waitp-sub" id="waitp-sugg">${L`できること`}</h3><ul class="waitp-sugg" aria-labelledby="waitp-sugg">${model.suggestions.map(s => {
    const t = suggestionText(s);
    return html`<li><button type="button" class="waitp-go" data-act="${s.act}" ${dataAttrs(s.data)} data-wait-suggest="${s.id}">${icon(SUGGEST_ICON[s.id] ?? 'next', 'waitp-ic')}<span class="waitp-go-t"><strong>${t.label}</strong><span class="waitp-note">${t.note}</span></span></button></li>`;
  })}</ul>` : '';
  // (folded: the body stays in the document, hidden, so the button's aria-controls always names an element)
  return html`<section class="waitp${open ? '' : ' waitp-closed'}" aria-labelledby="waitp-h" data-wait-panel="${open ? 'open' : 'closed'}">${head}<div class="waitp-body" id="waitp-body" ${raw(open ? '' : 'hidden')}>${timers}${sugg}<p class="waitp-foot muted">${L`あなた自身の記録だけから出しています。時刻は見込みです。`}</p></div></section>`;
}
