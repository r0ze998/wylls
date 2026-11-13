// The first session's waits and firsts (the first-session review of 2026-11-13, after the natural trial):
//   - a forming host says where its turn really is — the turn still running, the seals' key awaited, the fair draw
//     open, the public random number awaited, the turn being settled — read from the turn pipeline (clock.mjs
//     `pipeline`) with the herald's facts of the muster turn (controller.mjs `FS.formingBells`). A countdown is shown
//     only where the pipeline names a time; no total wait is promised.
//   - one useful thing to do while it forms (grow toward a keep's need, or start a building);
//   - the first host that stands in the record, said once (hud/milestones.mjs), with a next goal this world can take;
//   - "Form a host" idle right after every troop went into a host reads as done, not as an error.
// Whether this page can march is one decision (`marchOpenFor`): in local play it stays false until the march
// owner's contract says otherwise. Rules are not read or changed here.
import { L, fmtNum } from '../../lang.mjs';
import { unitCount } from '../fi18n.mjs';
import { UNIT_ORDER, SCOUT, SETTLER } from '../fland.mjs';
import { pipeline, countdown } from '../clock.mjs';

/**
 * Can this page send a march? A world on a chain (not local play): yes, as before. Local play: only when the march
 * lane's answer says so — `FS.localMarch` = flocalplay-march.mjs `localMarchOpen(...)` → `{open, reason, capability,
 * ready, held}` (docs/integration/CLAUDE-LOCAL-MARCH-OPEN-CONTRACT-20261113.md). Anything else, including no answer
 * yet, is closed. Never read from the economy command list.
 */
export const marchOpenFor = FS => (FS?.localPlay ? FS?.localMarch?.open === true : true);

/**
 * Why this page cannot march, in one sentence ('' when it can): the contract's `reason`, worded for a player. No
 * promise of when: "not available" is all a closed answer says.
 */
export function marchClosedText(FS) {
  if (marchOpenFor(FS)) return '';
  switch (FS?.localMarch?.reason) {
    case 'LocalMarchNoCapability': return L`この世界では、このページからの進軍は提供されていません。`;
    case 'LocalMarchGate': return L`このページの試験用の鍵と接続が確かめられないため、進軍は使えません。`;
    case 'LocalMarchWideHolding': return L`この村からは、このページの進軍は使えません。`;
    case 'LocalMarchHeld': return L`この軍勢の進軍は送信済みで、結果をまだ確認できていません。同じ進軍は送り直しません。`;
    case 'LocalMarchNotReady':
    default: return L`この世界では、このページからの進軍はいま使えません。`;
  }
}

/** A combat host (not scouts or settlers). */
const combat = r => r && r.unit !== SCOUT && r.unit !== SETTLER;

/** The muster turn of a forming host row (state 2: it stands from `fromBell`), or null. */
export const musterBellOf = r => (r?.state === 2 && Number.isInteger(r.fromBell) && r.fromBell >= 1 ? r.fromBell - 1 : null);

/**
 * The pipeline phase of a forming host: `{phase, until}` — phase 'turnEnding' | 'awaitingKey' | 'fairDraw' |
 * 'awaitingSeed' | 'processing' | 'stood' | 'unknown'; `until` chain seconds or null (no countdown without one).
 * Facts: `FS.formingBells` = [{host, bell, facts}] (the herald's facts of the muster turn). Without facts only the
 * clock's own answer is used, and only while the muster turn still runs.
 */
export function formingPhase(FS, r) {
  const bell = musterBellOf(r);
  const now = FS?.chain?.now?.();
  if (bell === null || !FS?.clock || !Number.isFinite(now)) return { phase: 'unknown', until: null };
  const item = (FS.formingBells ?? []).find(x => x && String(x.host) === String(r.id) && x.bell === bell) ?? null;
  let pl;
  try { pl = pipeline(FS.clock, bell, { now, ...(item?.facts ?? {}) }); } catch { return { phase: 'unknown', until: null }; }
  if (!item && pl.state !== 'open') return { phase: 'unknown', until: null };
  const phase = { open: 'turnEnding', awaitingBeacon: 'awaitingKey', revealing: 'fairDraw', awaitingSeed: 'awaitingSeed', resolving: 'processing', resolved: 'stood' }[pl.state] ?? 'unknown';
  return { phase, until: Number.isFinite(pl.until) ? pl.until : null };
}

/** A forming host in one sentence: who, and where its muster turn is now. */
export function formingLine(FS, r) {
  const who = unitCount(UNIT_ORDER[r.unit], r.troops);
  const { phase, until } = formingPhase(FS, r);
  const now = FS?.chain?.now?.() ?? 0;
  const cd = until !== null ? countdown(until - now) : null;
  switch (phase) {
    case 'turnEnding': return L`${who} は編成中です。このターンの終わり（あと ${cd}）のあと、封が開けられ、戦いを決めるくじが出てターンが決着すると整列します。`;
    case 'awaitingKey': return L`${who} は編成中です。ターンが終わり、封を開ける鍵が出るのを待っています。`;
    case 'fairDraw': return cd ? L`${who} は編成中です。封が開けられています（締め切りまで ${cd}）。そのあとターンが決着すると整列します。` : L`${who} は編成中です。封が開けられています。そのあとターンが決着すると整列します。`;
    case 'awaitingSeed': return cd ? L`${who} は編成中です。戦いを決めるくじが出るのを待っています（予定まで ${cd}）。` : L`${who} は編成中です。戦いを決めるくじが出るのを待っています。`;
    case 'processing': return L`${who} は編成中です。ターンを決着させています。済みしだい整列します。`;
    case 'stood': return L`${who} の編成のターンは決着しました。村の記録が更新されると地図に立ちます。`;
    default: return L`${who} は編成中です。編成したターンが決着すると整列します。`;
  }
}

/** The viewer's forming combat host rows (state 2), from `hostRows(FS)`'s rows. */
export const formingHosts = rows => (rows ?? []).filter(r => combat(r) && r.state === 2);
/** The viewer's combat hosts that stand in the record (formed, or out on a march). */
export const stoodHosts = rows => (rows ?? []).filter(r => combat(r) && (r.state === 1 || r.state === 3 || r.inTransit));

/**
 * One thing worth doing while a host forms, or null: `{kind: 'train', count, short} | {kind: 'build', free}`.
 *   short toward the keep (`need` from conquestguide keepTarget) and the stores pay for some → train;
 *   else a free building slot with nothing blocking a build → build.
 */
export function whileWaiting({ need = null, troops = 0, reserve = 0, canTrain = 0, freeSlots = 0, buildBlocked = true } = {}) {
  const short = Number.isFinite(need) ? Math.max(0, need - troops - reserve) : 0;
  if (short > 0 && canTrain > 0) return { kind: 'train', count: Math.min(short, canTrain), short };
  if (freeSlots > 0 && !buildBlocked) return { kind: 'build', free: freeSlots };
  return null;
}

/** The while-waiting suggestion in one sentence ('' for none). */
export function whileWaitingLine(s, unit = 0) {
  if (!s) return '';
  if (s.kind === 'train') return L`待つあいだに：あと ${unitCount(UNIT_ORDER[unit], s.short)} で、届く砦に勝てる見込みの兵数になります。`;
  if (s.kind === 'build') return L`待つあいだに：建物の空きが ${fmtNum(s.free)} あります。建物は毎時の産出を増やします。`;
  return '';
}

/**
 * The first host's next goal: 'seeKeeps' (march open, enough troops or no keep known), 'addTroops' (march open,
 * short), 'growToward' (march closed, short), 'keepsOnly' (march closed, enough), or null (march closed, no keep
 * known: nothing this page can point at).
 */
export function firstHostNext({ troops = 0, need = null, marchOpen = false } = {}) {
  const known = Number.isFinite(need);
  if (marchOpen) return known && troops < need ? 'addTroops' : 'seeKeeps';
  if (!known) return null;
  return troops < need ? 'growToward' : 'keepsOnly';
}

/** The next goal in one line ('' for none). */
export function firstHostNextLine(next, { unit = 0, need = null } = {}) {
  const n = Number.isFinite(need) ? unitCount(UNIT_ORDER[unit], need) : '';
  switch (next) {
    case 'seeKeeps': return L`次の目標：届く砦を選んで進軍する`;
    case 'addTroops': return L`次の目標：${n} まで兵を足してから砦へ`;
    // (short: the banner celebrates; why the march is closed is said by the guide, which stays on screen)
    case 'growToward': return L`次の目標：届く砦に勝てる ${n} まで兵を足す`;
    case 'keepsOnly': return L`次の目標：届く砦を見る`;
    default: return '';
  }
}

/** Why "Form a host" is idle: 'allFormed' when the reserve is empty and a combat host exists (forming or standing), else null. */
export function musterIdleCode({ reserve = 0, hosts = 0 } = {}) {
  return reserve <= 0 && hosts > 0 ? 'allFormed' : null;
}
export const allFormedText = () => L`控えの兵はすべて軍勢にしました。もう一隊つくるには、先に訓練しましょう`;
/** The same, short enough for the action bar's button. */
export const allFormedShort = () => L`全員編成済み：訓練で次の一隊へ`;

/** The muster card's rule line and the order list's line: the host stands once the muster turn is settled. */
export const musterRuleText = () => L`線の内側のマスを押すと場所を変えられます（村のある州の、通れるマス）。軍勢は、このターンの決着のあとに整列します。`;
