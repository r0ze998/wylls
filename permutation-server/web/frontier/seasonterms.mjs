// The season's times in words, read from the season and the chain's clock,
// never written into a sentence (workstream 07, brief item 4). A turn is
// BELL_SECS of the chain's clock (clock.mjs, the program's travel.rs); on a
// local world the clock may run faster (the stack's --scale), and there a turn
// lasts BELL_SECS / rate real seconds. The season takes joins until its
// `joinCloseBell` and ends at its `endBell` (Season account); the program
// refuses a join after the one and every order after the other with
// WrongStatus, which this page words with its cause.
//
// The world is to go on without an end (the project's direction; its shared core is 04's and 08's). This program
// still has an end turn, so the page says it as what it is — the turn after which THIS program takes no new order,
// a TEST world's limit (fix-loop13, LP13-1: the owners abolished seasons, so it is no longer called a season) — and
// never as the world ending or a rule for winning; when the owners register that the world goes on
// (hud/worldclock.mjs), the end turn is not said at all.
import { L, fmtNum } from '../lang.mjs';
import { BELL_SECS, NO_END_BELL, bellStart, worldContinues as seasonContinues } from './clock.mjs';
import { worldContinues as ownersSayContinues } from './hud/worldclock.mjs';

// NO_END_BELL (clock.mjs) is the program's "no end" turn (u32::MAX): a continuous season's end, and its join close
// when joining never closes.
/** Whether this world goes on: the owners' registration (hud/worldclock.mjs) or the season record itself (clock.mjs:
 *  a continuous flag AND the no-end turn). loop-play3: no source registers `continuity` on the page, so a kept
 *  (continuous) local world said "the old-style season takes orders until turn 4,294,967,295 (about 29,826,162 days)". */
const worldContinues = FS => ownersSayContinues(FS) || seasonContinues(FS?.season);

let pace = () => 1;
/** The chain's pace as the page knows it (app.mjs: the accelerated local clock's rate, else 1; null while a fast
 *  clock's pace is not known yet — fix-loop8, LP8-10). */
export function setTermsPace(fn) { pace = typeof fn === 'function' ? fn : () => 1; }
const rate = () => { const p = pace(); if (p === null) return null; const r = Number(p); return Number.isFinite(r) && r > 1 ? r : 1; };
/** The chain's pace (1 at the natural clock, e.g. 60 on a ×60 TEST world, null while a fast clock's pace is not known). */
export const termsRate = () => rate();

/** Seconds in words, at the scale they are long ("10 分", "約 3 時間" style numbers come from the caller). */
export function spanWords(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 90) return L`${fmtNum(s)} 秒`;
  if (s < 90 * 60) return L`${fmtNum(Math.round(s / 60))} 分`;
  if (s < 48 * 3600) return L`${fmtNum(Math.round(s / 3600))} 時間`;
  return L`${fmtNum(Math.round(s / 86400))} 日`;
}
/**
 * (fix-loop17, LP17-7) Seconds in words for a time LEFT, finer between an hour and a half and two days: hours and
 * minutes to the nearest ten ("1 時間 40 分", "2 時間 20 分"; a whole hour stays "2 時間"). The join card says two
 * deadlines side by side; with `spanWords` 101 and 143 minutes both read 「約 2 時間」. Other lengths are `spanWords`'.
 * `key` names the deadline: its last-said tens are held until the time left is LEFT_HOLD_MIN minutes away from them, so
 * a fast clock's measured pace (a few per cent of jitter, clock.mjs) does not flip 「1 時間 30 分」 ⇄ 「1 時間 40 分」.
 */
export const LEFT_HOLD_MIN = 8;
const saidLeft = new Map();
const fineWords = m => { const h = Math.floor(m / 60), r = m % 60; return r ? L`${fmtNum(h)} 時間 ${fmtNum(r)} 分` : L`${fmtNum(h)} 時間`; };
export function spanFine(secs, key = null) {
  const s = Math.max(0, Math.round(secs)), was = key === null ? undefined : saidLeft.get(key);
  if (was !== undefined && Math.abs(s / 60 - was) < LEFT_HOLD_MIN) return fineWords(was);
  if (s < 90 * 60 || s >= 48 * 3600) { if (key !== null) saidLeft.delete(key); return spanWords(s); }
  const m = Math.round(s / 600) * 10;
  if (key !== null) saidLeft.set(key, m);
  return fineWords(m);
}
/** A turn's length of game time ("10 分"). */
export const turnSpan = () => spanWords(BELL_SECS);
/** A turn's length as the player lives it: game time, and on a faster clock the real time too. */
// (fix-loop8, LP8-10: on a fast clock whose pace is not known yet, the game time alone — never 「10 分」 as if it were real)
export const turnLine = () => { const r = rate(); return r === null ? L`ゲーム内の ${turnSpan()}` : r > 1 ? L`ゲーム内の ${turnSpan()}（この世界では実時間で約 ${spanWords(BELL_SECS / r)}）` : turnSpan(); };
/** How long `n` turns last as the player lives them ("約 12 時間"; on a faster clock the real time) — newcomer-ux: the
 *  guide said "hold 72 turns" and never how long that is (12 hours at the natural clock). */
export const turnsLine = n => { const r = rate(), g = Math.max(0, Number(n) || 0) * BELL_SECS; return r === null ? L`ゲーム内で約 ${spanWords(g)}` : r > 1 ? L`この世界の実時間で約 ${spanWords(g / r)}` : L`約 ${spanWords(g)}`; };

/**
 * (owner-answers-ui, owner 2026-11-26 10:52 Q-EUA2-4 = Q-EUA-1 A) A game-time length said with its real length on a
 * faster clock: 「（実時間で約 10 秒）」 after "8:53" at ×60. Nothing at the natural clock or while the pace is not known
 * (fix-loop8, LP8-10: never a guess). `secs` are chain (game) seconds.
 */
export const realTail = secs => {
  const r = rate(), s = Number(secs);
  if (r === null || !(r > 1) || !Number.isFinite(s) || !(s > 0)) return '';
  // (live at ×60: "0:19 left" said "about 0 seconds" — under half a second is said as that)
  return s / r < 0.5 ? L`（実時間で 1 秒未満）` : L`（実時間で約 ${spanWords(s / r)}）`;
};

/** (owner-answers-ui, Q-EUA2-4) The same real length in a few characters, for the turn dial (「実時間≈10秒」 / "≈10 s real"). */
export const realShort = secs => {
  const r = rate(), s = Number(secs);
  if (r === null || !(r > 1) || !Number.isFinite(s) || !(s > 0)) return '';
  const real = Math.round(s / r);
  if (s / r < 0.5) return L`実時間 1秒未満`;
  if (real < 90) return L`実時間≈${fmtNum(real)}秒`;
  if (real < 90 * 60) return L`実時間≈${fmtNum(Math.round(real / 60))}分`;
  return L`実時間≈${fmtNum(Math.round(real / 3600))}時間`;
};

/** The season's deadlines: `{join: {bell, closed, realLeft}, end: {bell, ended, realLeft}}`, or null without a season or clock
 *  (`realLeft` null while a fast clock's pace is not known yet). */
export function deadlines(FS) {
  const s = FS?.season, g = Number(FS?.clock?.genesisTs ?? s?.genesisTs), now = Number(FS?.chain?.now?.());
  if (!s || !Number.isFinite(g) || !Number.isFinite(now)) return null;
  const nowBell = Math.floor((now - g) / BELL_SECS), endBell = Number(s.endBell), joinBell = Number(s.joinCloseBell ?? s.endBell);
  const r = rate(), left = b => (r === null ? null : Math.max(0, (bellStart(g, b) - now) / r));
  return { join: { bell: joinBell, closed: nowBell >= joinBell, realLeft: left(joinBell) }, end: { bell: endBell, ended: nowBell >= endBell, realLeft: left(endBell) } };
}
/** The deadlines in one line for the join screen. */
export function deadlineLine(FS) {
  const d = deadlines(FS);
  if (!d) return '';
  // (a join close at the no-end turn is no deadline: nothing is said of it)
  // (a time left not known yet — a fast clock's pace still being measured — is not said: fix-loop8, LP8-10)
  const join = d.join.bell >= NO_END_BELL ? '' : d.join.closed ? L`参加の受付は第${fmtNum(d.join.bell)}ターンで締め切られました。` : d.join.realLeft === null ? '' : L`参加の受付は第${fmtNum(d.join.bell)}ターンまで（あと約 ${spanFine(d.join.realLeft, `join:${d.join.bell}`)}）。`;
  // (walletless demo: a world made fresh at every page load says nothing of the test-world end turn while it is ahead)
  const end = worldContinues(FS) || (FS?.sample?.demo && !d.end.ended) ? '' : d.end.ended ? L`この試しの世界は第${fmtNum(d.end.bell)}ターンで新しい命令の受付を終えました（試しの世界の上限です）。`
    : d.end.realLeft === null ? '' : L`この試しの世界が新しい命令を受け付けるのは第${fmtNum(d.end.bell)}ターンまでです（あと約 ${spanFine(d.end.realLeft, `end:${d.end.bell}`)}。試しの世界の上限です）。`;
  return `${join}${end}`;
}
/** WrongStatus said with its cause when the cause is the season's clock; null otherwise (the page's own words stand). */
export function wrongStatusWhy(FS, action = null) {
  const d = deadlines(FS);
  if (!d) return null;
  if (d.end.ended && !worldContinues(FS)) return L`この試しの世界は第${fmtNum(d.end.bell)}ターンで新しい命令の受付を終えたため（試しの世界の上限です）、この操作は受け付けられません。`;
  if (action === 'join' && d.join.closed) return L`参加の受付は第${fmtNum(d.join.bell)}ターンで締め切られました。`;
  return null;
}
