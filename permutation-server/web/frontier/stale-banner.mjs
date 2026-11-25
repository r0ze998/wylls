// What the stale banner says (app.mjs renderChip). On the ordinary page: reload before an action that needs the latest
// state (unchanged). On local play a reload would lose the page's memory-only key and the world could not be
// continued, so it says not to reload and offers a re-read instead (controller.mjs `state-reread`: a read only).
import { L } from '../lang.mjs';
import { worldEndedText, launcherLostText } from './flocalplay-ended.mjs';

/** `{ hidden, text, reread }` for `stale` = herald.mjs staleness(…) and `localPlay` = whether this page is local play. */
export function staleBannerView({ stale, localPlay = false }) {
  if (!stale?.stale) return { hidden: true, text: '', reread: false };
  const behind = Math.round(Number(stale.behind) || 0);
  if (!localPlay) return { hidden: false, text: L`表示が ${behind} 秒遅れています。最新の状態が必要な操作の前に再読み込みしてください。`, reread: false };
  return { hidden: false, text: L`表示が ${behind} 秒遅れています。再読み込みはしないでください（この世界の鍵が消え、続けられなくなります）。下のボタンで最新の状態を読み直せます。`, reread: true };
}

/**
 * The banner of a local-play world confirmed ended (the loop-play report B5; flocalplay-ended.mjs): it is not "behind" —
 * it says that the world ended, and offers no re-read, since nothing is left to read.
 */
export const endedBannerView = ({ kept = false } = {}) => ({ hidden: false, text: worldEndedText({ kept }), reread: false, ended: true, ...(kept ? { paused: true } : {}) });

/**
 * B21 (loop-play3): the banner while the launcher itself cannot be reached (stopped): a plain line instead of only the
 * dial's red mark. Not an end — a launcher started again takes it away — and no re-read (nothing answers).
 */
export const launcherLostBannerView = ({ kept } = {}) => ({ hidden: false, text: launcherLostText({ kept }), reread: false, lost: true });

/** The re-read button's words. */
export const rereadLabel = () => L`最新の状態を読み直す`;
