// 板とゲームが同じ入口（オリジン）で、同じ世界か（2026-11-17）。読むだけ：応じる・署名・送信はしない。
//
// 板（board.mjs）は /coop/*（記録・view・config・読むだけの RPC）と /ws01/*（この画面）を出し、それ以外をヘラルドへ転送する。
// だから、板の入口で開いたゲーム（GAME_PAGE）と村のカード・この画面・記録の API は、同じ入口に並ぶ。
// ここでは、その入口のヘラルドの世界（/h/season：frontier-node herald views.rs の programId・season・cluster）が、
// 板の世界（/coop/config の season・cluster）と同じかを比べる。同じでなければ、この画面から隊商は送らない
// （送信は同じ入口の /gw → ヘラルド → 中継で、計画は板の世界で立てるため）。
// 分からない（ヘラルドがない・読めない・名指さない）ときは「分からない」と言う（同じとは言わない）。
//
// 守っていること：板の起動・転送・loopback・データ・公開の設定は変えない（board.mjs は変えない）。ここは画面の確かめだけ。
// この入口が公開してよいものかは、ここでは決めない（ローカルの loopback の入口を、公開の入口とは言わない）。

/** 板の入口でのゲームの場所（board.mjs の起動の知らせ：/frontier/frontier/ はヘラルドの画面の転送）。 */
export const GAME_PAGE = '/frontier/frontier/';

/**
 * ヘラルドの /h/season の答え（JSON）と、板の config の世界を比べる。
 * → {state: 'same', herald} | {state: 'different', differs: ['program'|'season'|'cluster'…], herald} | {state: 'unknown', why}
 */
export function compositionOf(j, cfg) {
  const board = cfg?.season;
  if (!board || typeof board.programId !== 'string' || board.seasonId === undefined || board.seasonId === null) return { state: 'unknown', why: '板の世界（プログラム・シーズン）が読めない' };
  if (!j || typeof j !== 'object' || typeof j.programId !== 'string' || (typeof j.season !== 'string' && typeof j.season !== 'number')) return { state: 'unknown', why: 'この入口のヘラルドが世界（プログラム・シーズン）を名指さない' };
  const herald = { programId: j.programId, season: String(j.season), cluster: typeof j.cluster === 'string' ? j.cluster : null };
  const differs = [];
  if (herald.programId !== board.programId) differs.push('program');
  if (herald.season !== String(board.seasonId)) differs.push('season');
  if (herald.cluster !== null && typeof cfg.cluster === 'string' && herald.cluster !== cfg.cluster) differs.push('cluster');
  if (differs.length) return { state: 'different', differs, herald };
  if (herald.cluster === null || typeof cfg.cluster !== 'string') return { state: 'unknown', why: 'ネットワーク（cluster）を比べられない', herald };
  return { state: 'same', herald };
}

const DIFF_JA = { program: 'プログラム', season: '世界の番号', cluster: 'ネットワーク' };

/** 画面の一行（文字だけ。リンクは画面が同じ入口の GAME_PAGE だけを付ける）。 */
export function compositionText(c, cfg) {
  if (c?.state === 'same') return `この入口のゲームとこの板は同じ世界（世界の番号 ${cfg.season.seasonId}・${cfg.cluster}）。村のカード・この画面・記録は同じ入口`;
  if (c?.state === 'different') return `この入口のゲーム（ヘラルド）は別の世界（${c.differs.map(d => DIFF_JA[d] ?? d).join('・')}が違う：ヘラルドは世界の番号 ${String(c.herald.season).slice(0, 20)}）。この板から隊商は送らない。板と同じ世界のヘラルドの前で板を起動してください`;
  return `この入口のゲームの世界を確かめられない（${c?.why ?? '?'}）。同じ世界とは言えない`;
}
