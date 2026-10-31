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
// an old-style season's — and never as the world ending; when the owners register that the world goes on
// (hud/worldclock.mjs), the end turn is not said at all.
import { L, fmtNum } from '../lang.mjs';
import { BELL_SECS, bellStart } from './clock.mjs';
import { worldContinues } from './hud/worldclock.mjs';

let pace = () => 1;
/** The chain's pace as the page knows it (app.mjs: the accelerated local clock's rate, else 1). */
export function setTermsPace(fn) { pace = typeof fn === 'function' ? fn : () => 1; }
const rate = () => { const r = Number(pace()); return Number.isFinite(r) && r > 1 ? r : 1; };

/** Seconds in words, at the scale they are long ("10 分", "約 3 時間" style numbers come from the caller). */
export function spanWords(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 90) return L`${fmtNum(s)} 秒`;
  if (s < 90 * 60) return L`${fmtNum(Math.round(s / 60))} 分`;
  if (s < 48 * 3600) return L`${fmtNum(Math.round(s / 3600))} 時間`;
  return L`${fmtNum(Math.round(s / 86400))} 日`;
}
/** A turn's length of game time ("10 分"). */
export const turnSpan = () => spanWords(BELL_SECS);
/** A turn's length as the player lives it: game time, and on a faster clock the real time too. */
export const turnLine = () => (rate() > 1 ? L`ゲーム内の ${turnSpan()}（この世界では実時間で約 ${spanWords(BELL_SECS / rate())}）` : turnSpan());

/** The season's deadlines: `{join: {bell, closed, realLeft}, end: {bell, ended, realLeft}}`, or null without a season or clock. */
export function deadlines(FS) {
  const s = FS?.season, g = Number(FS?.clock?.genesisTs ?? s?.genesisTs), now = Number(FS?.chain?.now?.());
  if (!s || !Number.isFinite(g) || !Number.isFinite(now)) return null;
  const nowBell = Math.floor((now - g) / BELL_SECS), endBell = Number(s.endBell), joinBell = Number(s.joinCloseBell ?? s.endBell);
  const left = b => Math.max(0, (bellStart(g, b) - now) / rate());
  return { join: { bell: joinBell, closed: nowBell >= joinBell, realLeft: left(joinBell) }, end: { bell: endBell, ended: nowBell >= endBell, realLeft: left(endBell) } };
}
/** The deadlines in one line for the join screen. */
export function deadlineLine(FS) {
  const d = deadlines(FS);
  if (!d) return '';
  const join = d.join.closed ? L`参加の受付は第${fmtNum(d.join.bell)}ターンで締め切られました。` : L`参加の受付は第${fmtNum(d.join.bell)}ターンまで（あと約 ${spanWords(d.join.realLeft)}）。`;
  const end = worldContinues(FS) ? '' : d.end.ended ? L`このプログラム（旧方式のシーズン）は第${fmtNum(d.end.bell)}ターンで新しい命令の受付を終えました。`
    : L`このプログラム（旧方式のシーズン）が新しい命令を受け付けるのは第${fmtNum(d.end.bell)}ターンまでです（あと約 ${spanWords(d.end.realLeft)}）。`;
  return `${join}${end}`;
}
/** WrongStatus said with its cause when the cause is the season's clock; null otherwise (the page's own words stand). */
export function wrongStatusWhy(FS, action = null) {
  const d = deadlines(FS);
  if (!d) return null;
  if (d.end.ended && !worldContinues(FS)) return L`このプログラム（旧方式のシーズン）は第${fmtNum(d.end.bell)}ターンで新しい命令の受付を終えたため、この操作は受け付けられません。`;
  if (action === 'join' && d.join.closed) return L`参加の受付は第${fmtNum(d.join.bell)}ターンで締め切られました。`;
  return null;
}
