// What the stale banner says (app.mjs renderChip). On the ordinary page: reload before an action that needs the latest
// state (unchanged). On local play a reload would lose the page's memory-only key and the world could not be
// continued, so it says not to reload and offers a re-read instead (controller.mjs `state-reread`: a read only).
import { L } from '../lang.mjs';

/** `{ hidden, text, reread }` for `stale` = herald.mjs staleness(…) and `localPlay` = whether this page is local play. */
export function staleBannerView({ stale, localPlay = false }) {
  if (!stale?.stale) return { hidden: true, text: '', reread: false };
  const behind = Math.round(Number(stale.behind) || 0);
  if (!localPlay) return { hidden: false, text: L`表示が ${behind} 秒遅れています。最新の状態が必要な操作の前に再読み込みしてください。`, reread: false };
  return { hidden: false, text: L`表示が ${behind} 秒遅れています。再読み込みはしないでください（この世界の鍵が消え、続けられなくなります）。下のボタンで最新の状態を読み直せます。`, reread: true };
}

/** The re-read button's words. */
export const rereadLabel = () => L`最新の状態を読み直す`;
