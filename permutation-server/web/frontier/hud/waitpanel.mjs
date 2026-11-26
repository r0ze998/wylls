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
import { bellStart } from '../clock.mjs';
import { activeHolding } from '../fstate.mjs';
import { icon } from './icons.mjs';
import { hostWaits, waitOf } from './keephand.mjs';
import { ownReportDue, earliestReportAt } from './firstbattle.mjs';
import { dueHtml } from '../screens/shell.mjs';
import { hostRows } from '../screens/host.mjs';
import { provinceName } from './place.mjs';
import { queueSlots } from './rulebook.mjs';
import { FLAG } from '../onboarding.mjs';
import { conquestFacts } from '../screens/conquestguide.mjs';
import { ownLandView } from '../flocalplay-territory.mjs';

/** How many suggestions the panel lists at most. */
export const WAIT_SUGGESTIONS = 3;
/** The panel's place in the stored UI preferences (fui.mjs `waitPanel`). */
export const waitOpen = FS => FS?.ui?.waitPanel !== 'closed';

const combat = r => r && r.unit !== SCOUT && r.unit !== SETTLER;
const at = (FS, bell) => (FS?.clock && Number.isInteger(bell) ? bellStart(Number(FS.clock.genesisTs), bell) : null);

/**
 * The panel's content: `{timers: [{id, kind, at, ...}], suggestions: [{id, act, data}], soonest}` or null when the viewer
 * has no village yet (no own state to speak of). `offer`: hud/firstbattle.mjs battleOffer's answer (fog already applied).
 */
export function waitModel(FS, { offer = null } = {}) {
  if (FS?.mode !== 'play' || !activeHolding(FS)) return null;
  const h = activeHolding(FS);
  const flags = new Set(FS.ui?.dismissed ?? []);
  const timers = [];
  // 1 the viewer's own battle report
  const due = ownReportDue(FS);
  if (due) timers.push({ id: 'report', kind: 'report', at: due.at, arrive: due.arriveBell, dest: due.dest });
  let rows = [];
  try { rows = hostRows(FS).filter(combat); } catch { rows = []; }
  const ready = rows.find(r => !waitOf(FS, r)) ?? null;
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
    if (!['forming', 'resting', 'stamina'].includes(w.why) || !Number.isInteger(w.turn)) continue;
    timers.push({ id: `host:${w.id}`, kind: w.why === 'forming' ? 'hostForms' : 'hostMarch', at: at(FS, w.turn), turn: w.turn, unit: w.unit, troops: w.troops, stamina: w.stamina ?? null });
    if (timers.filter(x => x.id.startsWith('host:')).length >= 2) break;
  }
  if (ready) timers.push({ id: `host:${ready.id}`, kind: 'hostReady', at: null, unit: ready.unit, troops: ready.troops });
  // 3 land upkeep (the viewer's own land record, territory worlds)
  const player = FS.ownLand && Object.hasOwn(FS.ownLand, 'player') ? FS.ownLand.player : null;
  if (player) {
    const v = ownLandView(player, FS.nowBell ?? 0);
    if (v.tiles > 0) timers.push({ id: 'upkeep', kind: v.unpaid ? 'upkeepUnpaid' : 'upkeep', at: v.unpaid && Number.isInteger(v.turnsLeft) ? at(FS, (FS.nowBell ?? 0) + v.turnsLeft) : null, tiles: v.tiles, perHour: v.upkeepMilliPerHour / 1000, turnsLeft: v.turnsLeft });
  }
  // 4 the keep hold the viewer's own host or march is part of
  let x = null;
  try { x = conquestFacts(FS); } catch { x = null; }
  if (x?.holding) {
    const left = Math.max(0, x.holding.required - x.holding.progress);
    timers.push({ id: 'hold', kind: 'hold', at: at(FS, (FS.nowBell ?? 0) + left), p: x.holding.p, q: x.holding.q, progress: x.holding.progress, required: x.holding.required });
  }
  // suggestions, from the same records
  const suggestions = [];
  if (offer && !flags.has(FLAG.verified)) {
    if (offer.kind === 'real') suggestions.push({ id: 'verify', act: 'report-open', data: { p: offer.p, q: offer.q, bell: offer.bell }, mine: !!offer.mine });
    else if (!flags.has(FLAG.practiceMatch)) suggestions.push({ id: 'practice', act: 'practice-first', data: {} });
  }
  if (ready && !due) suggestions.push({ id: 'march', act: 'tab', data: { tab: 'hosts' }, unit: ready.unit, troops: ready.troops });
  const reserve = [0, 1, 2, 3, 4, 5].reduce((a, u) => a + Number(h.reserve?.[u] ?? 0), 0);
  if (!rows.length && reserve >= 100) suggestions.push({ id: 'muster', act: 'cg-go', data: { pop: 'muster' } });
  else if (!rows.length && !(FS.marches ?? []).length) suggestions.push({ id: 'train', act: 'cg-go', data: { pop: 'train' } });
  const now = FS.chain?.now?.() ?? 0;
  const busy = (h.queue ?? []).filter(q => q && q.kind === 1 && Number(q.doneAt) > now).length;
  if (busy < queueSlots(h.tier)) suggestions.push({ id: 'build', act: 'cg-go', data: { pop: 'build' } });
  const timed = timers.filter(t => Number.isFinite(t.at)).sort((a, b) => a.at - b.at);
  return { timers, suggestions: suggestions.slice(0, WAIT_SUGGESTIONS), soonest: timed[0] ?? null };
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
    case 'hold': return html`${L`${provinceName(FS, t.p, t.q, { own: false })}の砦のマス：${fmtNum(t.progress)} / ${fmtNum(t.required)} ターン保っています。州が手に入るのは`}<strong>${due}</strong>`;
    default: return '';
  }
}

const SUGGEST_ICON = { verify: 'check', practice: 'swords', march: 'banner', muster: 'ranks', train: 'helmet', build: 'hammer' };
/** One suggestion's words: `{label, note}`. */
export function suggestionText(s) {
  switch (s.id) {
    case 'verify': return { label: L`本物の戦いを、このブラウザで確かめる`, note: s.mine ? L`あなたの戦いの報告を開き、「このブラウザで確かめる」で計算し直すと「一致」が出ます。` : L`見えている場所の戦いの報告を開き、「このブラウザで確かめる」で計算し直すと「一致」が出ます。` };
    case 'practice': return { label: L`練習の戦いで「計算し直す」を試す`, note: L`まだ開ける本物の戦いがありません。練習の戦い（チェーンの記録ではありません）で、計算し直して同じ結果になることを確かめられます。` };
    case 'march': return { label: L`軍勢を進軍させる`, note: L`${who(s)} の軍勢が出発できます。` };
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
