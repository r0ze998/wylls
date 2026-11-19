// LOCAL PLAY — a launcher world that has ENDED, confirmed before it is said (loop-play report B5).
//
// A launcher ends a world by itself (its life, its output, the disk's floor) or on its owner's press; the world's
// processes and its public proxy are then gone (`local-play-launcher.mjs` stop path, which leaves `stopped.json` in the
// world's directory). The page was never told: its herald reads failed ("could not connect"), its clock went on from
// the last sample, and what the clock alone implied was shown as if it had happened ("Turn 19", "Host arrived on
// turn 10") in a world stopped on turn 8.
//
// What this module decides, and nothing else:
//   - a herald read that FAILED BY THE NETWORK is the only reason to ask (`readFailed`): a herald that answers is never
//     doubted, and the launcher is never polled while the world is read;
//   - the question is the launcher's own same-origin keeper route for this page's wallet (the gate's `checkWorld`,
//     flocalplay.mjs, reached by `localPlayWorldCheck(cfg)`): its 404 `WorldNotFound` is the launcher saying it no
//     longer runs that world — the one answer taken as "ended". An answer that the world runs, a launcher that cannot be reached, any other refusal: unknown,
//     and nothing changes (the page goes on saying that it cannot connect);
//   - one question at a time, at most one per `minGapMs` of this machine's clock, and none once the end is known;
//   - `onEnded` is called once. The end is never taken back: a world that ended does not come back.
// It reads nothing itself, starts, stops or signs nothing, and holds no timer.
import { L } from '../lang.mjs';

/** The least wall time between two questions to the launcher (ms). */
export const WORLD_ENDED_ASK_GAP_MS = 5000;
/** The launcher's own code for a world it does not run (its `fault('WorldNotFound', 404)`). */
export const WORLD_NOT_FOUND = 'WorldNotFound';

/**
 * What a launcher's answer to the keeper question says of the world itself. `result`: the gate's `askLauncher` result
 * (`{ok: true, body}` or `{ok: false, launcher, code}`). → 'running' | 'ended' | 'unknown'.
 */
export function worldStateOf(result) {
  if (!result || typeof result !== 'object') return 'unknown';
  if (result.ok === true) return 'running';
  return result.ok === false && result.launcher === WORLD_NOT_FOUND ? 'ended' : 'unknown';
}

/**
 * `ask`: () → Promise of 'running' | 'ended' | 'unknown' (`worldStateOf` of the gate's `checkWorld`; a throw is 'unknown').
 * `onEnded`: called once, when the end is confirmed. `now`: this machine's clock, ms.
 * → `{readFailed(), isEnded(), asks()}`.
 */
export function createWorldWatch({ ask, onEnded = () => {}, now = () => Date.now(), minGapMs = WORLD_ENDED_ASK_GAP_MS } = {}) {
  let ended = false, asking = false, lastAsk = -Infinity, asks = 0;
  const readFailed = () => {
    if (ended || asking || typeof ask !== 'function') return null;
    const t = now();
    if (!Number.isFinite(t) || t - lastAsk < minGapMs) return null;
    asking = true; lastAsk = t; asks += 1;
    return Promise.resolve().then(ask).then(v => v, () => 'unknown').then(v => {
      asking = false;
      if (v !== 'ended' || ended) return ended ? 'ended' : 'unknown';
      ended = true;
      try { onEnded(); } catch { /* the display's own failure does not undo the end */ }
      return 'ended';
    });
  };
  return Object.freeze({ readFailed, isEnded: () => ended, asks: () => asks });
}

/**
 * B21 (loop-play3): whether a launcher answer is NO answer at all — the launcher itself could not be reached (stopped
 * with Ctrl-C, its terminal closed), which `worldStateOf` rightly leaves 'unknown'. `result`: the gate's `askLauncher`
 * result; an answer of any kind (the world runs, a refusal the launcher named) is the launcher being there.
 */
export function launcherSilent(result) {
  return !!result && typeof result === 'object' && result.ok === false && (result.launcher === null || result.launcher === undefined);
}
/**
 * This many silent answers in a row before the page says the launcher cannot be reached. One: the question is asked
 * only after a read of the world's herald already failed by the network, so one silent answer is two failures (the
 * world's herald AND the launcher); and the season is read every 30 s or slower, so a second answer would leave the
 * page saying only "N s behind" for a minute or more after a Ctrl-C (seen live, fix-ui-b17-b21). It is taken back by
 * the next answer or good read.
 */
export const LAUNCHER_LOST_AFTER = 1;

/**
 * B21: the count of a launcher that stopped answering. It asks NOTHING itself: the page hands it each answer of the one
 * question it already asks after a herald read failed by the network (`heard`: the gate's `checkWorld` result, as
 * `createWorldWatch` gets it). After `LAUNCHER_LOST_AFTER` silent answers in a row (`after`) `onLost` is called; an answer of
 * any kind, or a herald read that worked (`readOk`), calls `onBack` — unlike a world's end this is taken back: a
 * launcher started again answers again. No timer, no read, no send.
 */
export function createLauncherWatch({ onLost = () => {}, onBack = () => {}, after = LAUNCHER_LOST_AFTER } = {}) {
  let lost = false, silent = 0;
  const back = () => { silent = 0; if (!lost) return; lost = false; try { onBack(); } catch { /* the display's own failure */ } };
  const heard = result => {
    if (result === null || result === undefined) return lost;      // not a launcher world's page any more: nothing is said
    if (!launcherSilent(result)) { back(); return lost; }
    silent += 1;
    if (!lost && silent >= after) { lost = true; try { onLost(); } catch { /* the display's own failure */ } }
    return lost;
  };
  return Object.freeze({ heard, readOk: back, isLost: () => lost });
}

/** B21: the plain line of a launcher that cannot be reached (the banner and the "About this test world" box). */
export const launcherLostText = () => L`開始サービス（ターミナルで動かしている開始用のプログラム）に届きません。止めたのであれば、この世界はいま止まっています。ターンは進まず、命令も送れません。続けるには、開始サービスをもう一度起動し（保存した世界は続きから）、開始ページを開き直してください。`;

/** The banner's sentence once the world has ended (it replaces the "view is behind" banner: there is nothing later to read). */
export const worldEndedText = () => L`この世界は終了しました。ターンはもう進まず、命令も送れません。新しい世界は、開始ページを開き直して始めてください。`;
/** The dial's word under the last turn the world reached (short: the dial's line holds "9:26 left"; the banner says the rest). */
export const worldEndedWord = () => L`終了済み`;
