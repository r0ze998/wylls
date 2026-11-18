// 口座の閉じた自分の隊商を、依頼への結び付けの候補として探す（2026-11-18）。読むだけ：応じる・署名・送信・結び付けはしない。
//
// 既存の決まり（17章 17-4c、board.mjs の link の受け取り）：応じた後に送った自分の隊商は、結び付ける前に口座が閉じても、
// チェーンの元の送信（CARAVAN_SENT）で確かめて結び付けられる。ところが画面は、ヘラルドの輸送中の一覧（moving）にある隊商しか
// 結び付けの候補に出さなかった（今のヘラルドは確定の記録 ended を出さない）。ゲームの「隊商を送る」から送った隊商の口座が先に
// 閉じると、画面からは結び付けられなかった。
//
// 口座が閉じた・元の送信がある、だけでは「着いた」ことの証拠ではない。だから一本ずつ、チェーンの記録で状態を分ける：
//   delivered    ：CARAVAN_SETTLED が成功（outcome 0）で、確定した場所が依頼の届け先と同じ → 「着いた（確定の記録）」
//   unsettled    ：口座は閉じているが、確定・襲撃の記録が見えない → 「未解決」（着いたとは言わない）
//   lost         ：CARAVAN_SETTLED の LOST（outcome 1） → 結び付けの候補にしない
//   unknown-outcome：CARAVAN_SETTLED の outcome が 0・1 以外（この画面の知らない値） → 分からない。着いた・失われたと言わず、候補にしない
//   misdelivered ：確定した場所が依頼の届け先と違う → 候補にしない（原因を確認中）
//   読めない     ：unread（分からない。見つからない・送っていない、にしない）
// 候補（delivered・unsettled）も、結び付けてよいかを決めるのは板（board.mjs：送った人の印・口座・元の送信・応答との前後・届け先・積荷）。
// 量はここでは言わない（送った荷は元の送信の記録。数えるのは板の到着の判定だけ：arrival.mjs）。
//
// 鍵の API を名指すファイル（record.mjs の署名の関数）を読み込まないため、資源の並び（record.mjs RESOURCES）と文脈の鍵
// （record.mjs ctxKey）は呼び出し側から受け取る（coop-ui.mjs が record.mjs のものを渡す）。持ち主の印は ids.mjs の ownerTagOf
// （record.mjs が再び出しているもの）。

import { citizenOf, caravanAccount, caravanHistory } from './chain.mjs';
import { ownerTagOf } from './ids.mjs';

/** 一度に読む隊商の本数（直近から）。一本につき口座 1・署名の一覧 1・取引いくつかを読む。 */
export const ARRIVED_LIMIT = 8;

/** 結び付けの候補にする状態。 */
export const LINKABLE = Object.freeze(['delivered', 'unsettled']);

/** 隊商の鍵（record.mjs の linkedCaravans・link の caravan.ctx と同じ形：文脈の鍵:持ち主の印:番号）。 */
export const caravanKey = (ctxText, ownerTag, seq) => `${ctxText}:${String(ownerTag)}:${Number(seq)}`;

/** 板の view で、もう扱いの決まった隊商（どれかの依頼に結び付けた・送信の記録がある）。鍵は caravanKey と同じ形。 */
export function excludedCaravans(view) {
  const out = new Set();
  for (const q of view?.requests ?? []) {
    for (const x of [...(q.links ?? []), ...(q.sendings ?? [])]) {
      const c = x?.caravan;
      if (c && typeof c.ctx === 'string') out.add(caravanKey(c.ctx, c.ownerTag, c.seq));
    }
  }
  return out;
}

const samePlace = (d, to) => !!d && Number(d.kind) === 1 && Number(d.p) === Number(to.p) && Number(d.q) === Number(to.q)
  && Number(d.at) === Number(to.site) && Number(d.gen) === Number(to.gen);

/**
 * 依頼 `request`（view の形：id・ctx・to・need・responses）について、送る人 `wallet` の、口座の閉じた自分の隊商を分ける。
 *   reader：chain.mjs の rpcReader、season：依頼の文脈が無いときの文脈（板の今の文脈）、
 *   resources：record.mjs RESOURCES（積荷の並び）、ctxKey：record.mjs ctxKey。どちらも要る（無ければ読まない）。
 * → {status: 'ok', scanned: {from, to}|null, found: [{ownerTag, seq, state, sent: {resource: 量}}], unread: [{seq, why}]}
 *   （found の state は delivered・unsettled・lost・misdelivered・unknown-outcome。sent は元の送信の荷で、届いた量ではない）
 *   か {status: 'unread', why}（Citizen を確かめられない・番号が読めない。隊商がないとは言わない）
 */
export async function arrivedCandidates(reader, season, wallet, request, { resources, ctxKey, exclude = new Set(), limit = ARRIVED_LIMIT } = {}) {
  if (!Array.isArray(resources) || typeof ctxKey !== 'function') return { status: 'unread', why: '資源の並びか文脈の鍵が渡されていない' };
  if (!reader) return { status: 'unread', why: 'チェーンを読めない（板に --rpc がない）' };
  const ctx = request?.ctx ?? season;
  const resp = request?.responses?.[wallet];
  if (!resp || resp.answer !== 'accept' || resp.withdrawn) return { status: 'unread', why: 'この依頼に応じた答えが見えない' };
  if (!request.to || !request.need) return { status: 'unread', why: '依頼の届け先か量が読めない' };
  let me;
  try { me = await citizenOf(reader, ctx, wallet); } catch (e) { return { status: 'unread', why: `チェーンを読めない：${e.message ?? e}` }; }
  // 確かめた Citizen だけ（追放中などは caravans の欄があっても unverified：その番号では探さない）
  if (me?.status !== 'verified') return { status: 'unread', why: me?.why ?? 'Citizen を確かめられない' };
  const n = Number(me.caravans);
  if (me.caravans === undefined || me.caravans === null || !Number.isInteger(n) || n < 0) return { status: 'unread', why: 'Citizen の隊商の番号が読めない' };
  const lim = Math.max(1, Math.min(ARRIVED_LIMIT, Math.floor(Number(limit)) || ARRIVED_LIMIT));
  const tag = ownerTagOf(ctx, wallet), ck = ctxKey(ctx);
  const need = Object.keys(request.need);
  const out = { status: 'ok', scanned: n ? { from: Math.max(0, n - lim), to: n - 1 } : null, found: [], unread: [] };
  for (let seq = n - 1; seq >= Math.max(0, n - lim); seq--) {
    if (exclude.has(caravanKey(ck, tag, seq))) continue;
    const caravan = { ownerTag: tag, seq };
    let acc, h;
    try { acc = await caravanAccount(reader, ctx, caravan); } catch (e) { acc = { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
    if (acc.status === 'found') continue;   // まだ口座がある（輸送中など）：ヘラルドの一覧の候補のまま
    if (acc.status !== 'absent') { out.unread.push({ seq, why: acc.why }); continue; }
    try { h = await caravanHistory(reader, ctx, caravan); } catch (e) { h = { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
    if (h.status !== 'ok') { out.unread.push({ seq, why: h.why }); continue; }
    if (!h.sent || h.raided) continue;   // まだ載っていない番号・襲われた隊商（板が断る）
    if (!samePlace(h.sent.dst, request.to)) continue;   // 別の届け先へ送った隊商
    const sent = Object.fromEntries(need.map(r => [r, Number(h.sent.cargo?.[resources.indexOf(r)] ?? 0)]).filter(([, v]) => v > 0));
    if (!Object.keys(sent).length) continue;   // 依頼の資源を積んでいない（板が断る）
    const st = h.settled;
    // outcome は既知の 0（届いた）と 1（LOST）だけを読む。ほかの値は分からない（着いた・失われたのどちらとも言わない。候補にもしない）
    const state = !st ? 'unsettled' : st.outcome === 0 ? (samePlace(st.dst, request.to) ? 'delivered' : 'misdelivered') : st.outcome === 1 ? 'lost' : 'unknown-outcome';
    out.found.push({ ownerTag: tag, seq, state, sent });
  }
  return out;
}

/**
 * 探した結果を、鍵（送る人｜プログラム｜シーズン｜依頼）ごとに持つ（画面の状態。純粋な部分だけ）。
 *   scan(args) → arrivedCandidates の答え（Promise）。
 * load(key, args)：その鍵の新しい読みを始める（前の読みは、その鍵では古くなる）。読み終えた答えは、始めた鍵にだけ当てる：
 *   読んでいる間に画面の送る人・世界が変わっても、答えはその鍵のもの（A→B→A で戻ると A の答えが見える）。
 *   同じ鍵で後から始めた読みがあれば、先の答えは当てない（速い連打・やり直し）。
 * get(key)：{status: 'loading'} | arrivedCandidates の答え | null（まだ探していない）。
 */
export function createArrivedPicks({ scan, changed = () => {} }) {
  const picks = new Map();
  let seq = 0;
  /** 押したとき：同じ鍵で読んでいる途中なら何も始めない（連打）。{started: false, why} か {started: true, done: Promise}。 */
  function press(key, args) {
    if (!key) return { started: false, why: 'no-viewer' };
    if (picks.get(key)?.status === 'loading') return { started: false, why: 'loading' };
    return { started: true, done: load(key, args) };
  }
  async function load(key, args) {
    if (!key) return null;
    const mine = { seq: ++seq, status: 'loading' };
    picks.set(key, mine);
    changed();
    let r;
    try { r = await scan(args); } catch (e) { r = { status: 'unread', why: `チェーンを読めない：${e?.message ?? e}` }; }
    if (picks.get(key) !== mine) return null;   // 同じ鍵の新しい読みがある：古い答えは当てない
    const done = { seq: mine.seq, ...(r && typeof r === 'object' ? r : { status: 'unread', why: '答えの形が違う' }) };
    picks.set(key, done);
    changed();
    return done;
  }
  return { load, press, get: key => (key ? picks.get(key) ?? null : null) };
}

// ------------------------------------------------------------------ 画面の一行（coop-ui.mjs がそのまま使う。DOM・通信・署名なし）

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** coop-ui.mjs の esc と同じ置き換え。 */
export const escHtml = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

/** 状態の言葉：着いた（確定）と言うのは delivered だけ。量は言わない（送った荷は元の送信の記録）。 */
export const ARRIVED_JA = Object.freeze({
  delivered: '確定の記録で依頼の届け先に着いた',
  unsettled: '口座は閉じたが確定の記録が見えない（未解決。着いたとは言わない）',
  lost: '失われた（LOST の記録）',
  misdelivered: '依頼の届け先とは別の場所で確定した（原因を確認中）',
  'unknown-outcome': '確定の記録の結果がこの画面の知らない値（分からない。着いた・失われたとは言わない）',
});

/**
 * 依頼一件の「口座の閉じた自分の隊商」の行（HTML の文字列）。
 *   ready：署名する人がいて、板がチェーンを読み（cfg.chain）、読むだけの RPC がある（cfg.rpcProxy）。でなければ ''。
 *   pick：createArrivedPicks の get(key)。request：view の依頼（id、ctx）。ctx：依頼の文脈（無ければ板の今の文脈）。
 *   view：板の view（もう結び付けた・送信の記録がある隊商を、描くときにもう一度除く）。ctxKey：record.mjs ctxKey。
 *   names：資源の名前（record.mjs RESOURCE_JA）。
 * 結び付けのボタンは LINKABLE の状態だけ。押すと既存の link の記録（板が確かめる）。ほかの状態は文だけ。
 */
export function renderArrived({ ready, pick, request, ctx, view, ctxKey, names = {}, limit = ARRIVED_LIMIT }) {
  if (!ready) return '';
  const esc = escHtml, id = esc(request.id);
  const goods = o => Object.entries(o ?? {}).map(([r, v]) => `${names[r] ?? r} ${v}`).join('・') || '—';
  const btn = `<button data-act="arrived-load" data-id="${id}" data-testid="arrived-load"${pick?.status === 'loading' ? ' disabled aria-busy="true"' : ''}>${pick ? '口座の閉じた自分の隊商を探し直す' : '口座の閉じた自分の隊商を探す（チェーンを読むだけ）'}</button>`;
  if (!pick) return `<div class="row" data-testid="arrived">${btn}<span class="note">ゲームから送った隊商が上の一覧から消えたときに。直近 ${Number(limit)} 本を見る</span></div>`;
  if (pick.status === 'loading') return `<div class="row" data-testid="arrived" data-status="loading">${btn}<span class="note">チェーンを読んでいる…</span></div>`;
  if (pick.status !== 'ok') return `<div class="row" data-testid="arrived" data-status="unread">${btn}<span class="warn">隊商を探せない（${esc(pick.why ?? '?')}）。隊商がないとは限らない</span></div>`;
  const done = excludedCaravans(view);
  const found = (pick.found ?? []).filter(c => !done.has(caravanKey(ctxKey(ctx), c.ownerTag, c.seq)));
  const range = pick.scanned ? `隊商 #${pick.scanned.from}〜#${pick.scanned.to} を見た` : 'この Citizen の隊商はまだない';
  const unread = pick.unread?.length ? `<span class="warn" data-testid="arrived-unread">読めなかった隊商：${pick.unread.map(u => `#${esc(u.seq)}`).join('・')}（その分は分からない）</span>` : '';
  const row = c => (LINKABLE.includes(c.state)
    ? `<button data-act="link" data-id="${id}" data-tag="${esc(c.ownerTag)}" data-seq="${esc(c.seq)}" data-testid="arrived-link" data-state="${esc(c.state)}">隊商 #${esc(c.seq)}（${esc(ARRIVED_JA[c.state])}・送った荷 ${esc(goods(c.sent))}）をこの依頼に結び付ける</button>`
    : `<span class="note" data-testid="arrived-other" data-state="${esc(c.state)}">隊商 #${esc(c.seq)}：${esc(ARRIVED_JA[c.state] ?? `分からない状態（${c.state}）`)}（結び付けの候補にしない）</span>`);
  const list = found.length ? found.map(row).join('')
    : `<span class="note" data-testid="arrived-none">この届け先へ送った、口座の閉じた・まだ結び付けていない自分の隊商は見つからない（${esc(range)}）</span>`;
  return `<div class="row" data-testid="arrived" data-status="ok">${btn}${list}${unread}<span class="note">${esc(range)}。結び付けてよいかは板が確かめる（応じる前に送った隊商は板が断る）。数えるのは板が確定を確かめた到着だけ</span></div>`;
}

/**
 * この行のボタンの行き先（読むだけの分け方）：data-act と data-*（dataset）から、
 *   {act: 'arrived-load', id} | {act: 'link', id, caravan: {ownerTag, seq}} | null（ほかのボタン）。
 * link は、画面のほかの「結び付ける」ボタンと共通で、これまでと同じ形（ownerTag は data-tag のまま、seq は Number）。
 * 確かめは板（board.mjs）。ここでは何も送らない・緩めない・足さない。
 */
export function arrivedClick(ds) {
  if (!ds) return null;
  if (ds.act === 'arrived-load') return { act: 'arrived-load', id: ds.id };
  if (ds.act === 'link') return { act: 'link', id: ds.id, caravan: { ownerTag: ds.tag, seq: Number(ds.seq) } };
  return null;
}
