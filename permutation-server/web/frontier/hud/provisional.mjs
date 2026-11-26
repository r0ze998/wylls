// (fix-provisional-guide, loop-play23 BREAK-1 / Q-LP23-1 a + Q-LP23-2 a, page only) When the viewer's provisional village
// can be confirmed, read from the records the page already holds — the program's own rule, not a new one:
//   frontier-abi/src/prologue.rs finality_due: Holding state 1 (provisional) AND now ≥ Holding.final_ts AND the ticket's
//   cohort is closed (prologue.rs cohort_closed: every village request filed in the same turn in that Province is settled,
//   or 24 turns have passed since it — Province COHORT_BELLS). final_ts = round_time(S) + 600 (proc/citizen.rs, the
//   ticket's seed round S plus one turn). The flip is LAZY: nothing writes it when the time comes; the next resident action
//   that carries the village's own Province applies it (proc/holding.rs finality: Harvest, Build, Train; proc/host.rs
//   Muster, which then forms the host in the same press; caravans, garrisons…). Keeper A does not send one.
// The page's mirror of the rule is fland.mjs finalityDue / cohortClosed / ticketTimes. Times are said on the viewer's wall
// clock by screens/shell.mjs dueText (the panel's timer by dueHtml) (fix-loop22: never the chain's own clock).
import { L, lang } from '../../lang.mjs';
import { activeHolding } from '../fstate.mjs';
import { finalityDue, cohortClosed, ticketTimes } from '../fland.mjs';
import { dueText } from '../screens/shell.mjs';

/**
 * The viewer's active village while it is provisional, or null (no village, or final):
 *   {state: 'waiting', at, latest}  it cannot be confirmed before chain time `at` — `latest` when the cohort is still open
 *                                   on the page's copy of the Province, so `at` is the 24-turn bound (it may come sooner);
 *   {state: 'due', at: null}        the rule holds now: the next action confirms it (and the page lets Muster be pressed);
 *   {state: 'past', at}             `at` has passed but the page cannot yet see the rule hold (its Province copy is old or
 *                                   missing): an action that does not need a final village — Harvest — confirms it;
 *   {state: 'unknown', at: null}    no chain "now" or no times on the record.
 */
export function villageConfirm(FS) {
  const h = activeHolding(FS);
  if (!h || h.state !== 1) return null;
  const prov = FS?.provinces?.get?.(`${h.p},${h.q}`)?.province ?? null;
  let now = NaN;
  try { now = Number(FS?.chain?.now?.()); } catch { now = NaN; }
  const bell = FS?.nowBell;
  if (!Number.isFinite(now)) return { state: 'unknown', at: null, latest: true };
  if (Number.isInteger(bell) && finalityDue(h, prov, now, bell)) return { state: 'due', at: null, latest: false };
  const fts = Number(h.finalTs ?? NaN);
  let by = null;
  try { by = FS?.clock && Number.isInteger(h.ticketBell) ? ticketTimes(FS.clock, h.ticketBell).cohortEndsBy : null; } catch { by = null; }
  const closed = !!prov && Number.isInteger(bell) && Number.isInteger(h.ticketBell) && cohortClosed(prov, h.ticketBell, bell);
  const at = closed ? fts : Math.max(Number.isFinite(fts) ? fts : -Infinity, Number.isFinite(by) ? by : -Infinity);
  if (!Number.isFinite(at) || at <= 0) return { state: 'unknown', at: null, latest: true };
  if (at <= now) return { state: 'past', at, latest: !closed };
  return { state: 'waiting', at, latest: !closed };
}

/** Two sentences as one line: English puts a space between them, Japanese does not. */
export const joinSentences = (a, b) => (!b ? a : !a ? b : lang() === 'en' ? `${a} ${b}` : `${a}${b}`);

/** Whether the village still blocks forming a host (provisional, and the rule does not hold yet on the page's records). */
export const confirmPending = c => !!c && c.state !== 'due';

/**
 * The guide's sentence (plain text: it is also the pill's tooltip) for a provisional village: when it can be confirmed
 * (screens/shell.mjs dueText: how long, then the wall clock), that any action after that time confirms it, and what can be
 * done meanwhile. `meanwhile`: 'build' | null.
 */
export function confirmLine(FS, c, { meanwhile = 'build' } = {}) {
  if (!c) return '';
  const now = FS?.chain?.now?.() ?? null;
  const also = meanwhile === 'build' ? L`それまでは、建設ができます。` : '';
  if (c.state === 'due') return L`あなたの村は、いま確定できます。次の行動（収穫・建設・訓練・軍勢の編成など）をひとつすると確定します。`;
  if (c.state === 'past') return L`あなたの村は、確定できる時刻を過ぎました。収穫などの行動をひとつすると確定します。そのあとで軍勢を編成できます。`;
  if (c.state === 'unknown') return joinSentences(L`あなたの村は、まだ仮の村です。確定できるのは遅くとも申し込みから約 4 時間後です。その時刻を過ぎたら、収穫などの行動をひとつすると確定します。`, also);
  const when = dueText(c.at, now);
  return joinSentences(c.latest ? L`あなたの村は、まだ仮の村です。確定できるのは遅くとも${when}からです。その時刻を過ぎたら、収穫などの行動をひとつすると確定します。`
    : L`あなたの村は、まだ仮の村です。確定できるのは${when}からです。その時刻を過ぎたら、収穫などの行動をひとつすると確定します。`, also);
}
