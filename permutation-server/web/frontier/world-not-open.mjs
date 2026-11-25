// (page-not-open-yet) The world that is not open yet. Before the world is created the herald answers /h/season with
// 503 `{"ok":false,"code":"NoSeasonYet"}` (frontier-node herald server.rs; an announced world's account is not a world
// record yet either). That is not a failed connection: the page says calmly that the world is not open yet, and when it
// opens if the operator said so, and keeps asking — it opens by itself. Every other failed read keeps its own words.
//
// When it opens: the herald does not serve the announced time, so the operator may put a small file beside the page,
// `world-open.json`: `{"v":1,"opensAt":<unix seconds>}` — the earliest time the world can open. No file, a file that
// cannot be read, or a time already past: "soon".
import { L, fmtDateTime } from '../lang.mjs';

/** The herald's name for "no world record yet" (herald.mjs season() passes it through instead of `HTTP503`). */
export const NOT_OPEN_CODE = 'NoSeasonYet';

/** Whether a failed season read `{ok: false, code}` says the world is not open yet (and nothing else). */
export const isNotOpen = r => !!r && r.ok === false && r.code === NOT_OPEN_CODE;

/** The operator's file, checked: `{opensAt}` in unix seconds, or `{opensAt: null}` for anything else. */
export function parseWorldOpen(j) {
  const t = j && typeof j === 'object' && j.v === 1 ? j.opensAt : null;
  // (a time between 2020 and 2100 in seconds: a millisecond value or a string is not guessed at)
  return { opensAt: Number.isSafeInteger(t) && t >= 1_577_836_800 && t < 4_102_444_800 ? t : null };
}

/** Where the operator's file is: beside this page. */
export const worldOpenUrl = (base = import.meta.url) => new URL('world-open.json', base).href;

/** Read the operator's file (never thrown; any failure is `{opensAt: null}`). */
export async function readWorldOpen(f = globalThis.fetch, url = worldOpenUrl()) {
  try {
    const r = await f(url, { cache: 'no-store', signal: AbortSignal.timeout?.(8_000) });
    if (!r.ok) return { opensAt: null };
    return parseWorldOpen(await r.json());
  } catch { return { opensAt: null }; }
}

/** The opening time in the reader's own time zone, with the zone's name: "Nov 26, 12:00 PM GMT+9" / "11月26日 12:00 JST". */
export const openTimeText = opensAt => fmtDateTime(opensAt * 1000, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/**
 * The words: `title` (the world is not open yet) and `sub` (from when, or soon; and that there is nothing to do: the
 * page opens it). `notOpen` = `{opensAt}` (FS.notOpen), `now` in unix seconds. A time that has passed is not named
 * again: "soon".
 */
export function notOpenText(notOpen, now = Date.now() / 1000) {
  const t = notOpen?.opensAt ?? null;
  const sub = Number.isFinite(t) && t > now ? L`${openTimeText(t)} 以降に開きます。開いたら、このページに自動で表示されます。` : L`まもなく開きます。開いたら、このページに自動で表示されます。`;
  return { title: L`世界はまだ開いていません`, sub };
}

/** The page's calm banner (app.mjs renderChip, the `#stale-banner` line: never the red error line). */
export function notOpenBannerView(notOpen, now) {
  const t = notOpenText(notOpen, now);
  return { hidden: false, text: L`世界はまだ開いていません。${t.sub}`, reread: false, notOpen: true };
}
