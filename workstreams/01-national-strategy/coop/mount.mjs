// 板の画面が置かれた入口の下の道（mount）。板（board.mjs）は画面を `<mount>/ws01/repo/workstreams/01-national-strategy/coop/` に出す。
// 既定の板は入口の根に置かれ（mount = ''）、ローカルプレイの起動役（local-play-launcher.mjs --coop-board）は世界ごとの板を
// `/coop-world/<その世界の入口の番号>` の下に置く。画面は /coop/*・/h/* をこの mount の下で読む・出す（同じ入口のまま）。

/** 画面の道 `pathname` から mount（'' か '/a/b'）。画面の道でなければ ''。 */
export function mountOf(pathname) {
  const i = typeof pathname === 'string' ? pathname.indexOf('/ws01/repo/') : -1;
  if (i <= 0) return '';
  const m = pathname.slice(0, i);
  return /^(\/[A-Za-z0-9_-]+)+$/.test(m) ? m : '';
}

/** 入口の根からの道 `p`（/ で始まる）を、mount の下の道に。それ以外（相対・別の入口）はそのまま。 */
export const under = (mount, p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? `${mount}${p}` : p);
