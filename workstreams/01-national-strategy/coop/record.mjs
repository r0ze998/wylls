// 国をまたぐ物資の依頼：署名付きの記録と、その畳み込み（ブラウザと node の両方で動く）。
//
// 守っていること（docs/17-coop-connect.ja.md）：
//   1. 記録は持ち主のウォレットの署名つき（Ed25519。ウォレットの signMessage、または試験用の鍵）。
//      依頼は依頼した人だけが取り消せ、応答は応答した人だけが取り下げられる。
//   2. 依頼に応じる（accept）のは「送るつもりがある」という表明だけ。資源は動かず、履行の義務も生まれない。
//      物が動くのは、送り主本人がウォレットで署名した S1 の隊商（SendCaravan）だけ。
//   3. 隊商を依頼に結び付ける（link）のは、その隊商の持ち主だけ（持ち主の印 ownerTag をウォレットから計算して照らす）。
//   4. 物々交換・加工の貸出・到着時払いは、ここにはない（贈与で保証できるように見せない）。
//   5. 記録は国籍で参加を強制も禁止もしない。記録の国は申告で、判定には使わない（国はチェーンの Citizen で確かめる：chain.mjs）。

import { sha256 } from '../../../permutation-server/web/sdk/sha256.mjs';
import { concat, fromBase64, toBase64, toHex, utf8 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { decode as fromBase58, encode as toBase58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { ownerTagOf } from './ids.mjs';

export const DOMAIN = 'WYLLS-COOP-V1';
export const KINDS = Object.freeze(['request', 'respond', 'withdraw', 'cancel', 'sending', 'link', 'leave']);
// sending：送る人が隊商の取引にウォレットで署名した直後、中継へ出す前に板へ残す記録（ウォレットの署名・blockhash・番号・送り元・荷）。
//   これがあるので、画面の再読込や板の再起動の後も「結果の分からない送信」が残り、同じ依頼へ二重に署名・送付しない（board.mjs）。
//   記録するのは送るつもりの取引で、物を動かすのは中継とプログラム。記録だけでは何も起きない。
/** S1 の資源の並び（permutation-rules holding.rs Resource）。兵器は Horses の枠（arms.rs ARMS）。 */
export const RESOURCES = Object.freeze(['food', 'wood', 'stone', 'ore', 'arms', 'gold']);
export const RESOURCE_JA = Object.freeze({ food: '食料', wood: '木材', stone: '石材', ore: '鉱石', arms: '兵器', gold: '金' });
export const MAX_QTY = 100000;
/** 記録の時刻のずれの許容（板に届いた時刻との差、秒）。 */
export const CLOCK_SKEW = 300;

const fail = why => ({ ok: false, why });
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** 鍵の順を固定した JSON（整数・文字列・真偽・配列・オブジェクトだけ）。 */
export function canonical(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('canonical: 整数だけ');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  throw new Error(`canonical: ${typeof v} は使えない`);
}

/** 署名する文：DOMAIN ‖ 改行 ‖ 署名を除いた記録の canonical JSON。 */
export function messageOf(rec) {
  const { sig, ...body } = rec;
  void sig;
  return utf8(`${DOMAIN}\n${canonical(body)}`);
}

/** 記録の ID（署名を除いた本文の sha256、16進）。依頼の ID にも使う。 */
export const recordId = rec => toHex(sha256(messageOf(rec)));

/** 持ち主の印（S1 の Caravan の ownerTag）：ウォレット → Citizen の口座 → 先頭8バイト（faddr.mjs と同じ）。 */
export { ownerTagOf };   // 住所の決め方は ids.mjs（試験では導出しない表に差し替えられる）

// ------------------------------------------------------------------ 署名

/**
 * 署名する人。`signMessage(bytes) → 64バイト` と `address`（base58）を持つもの。
 * ウォレット（Wallet Standard の solana:signMessage）か、試験用の鍵（testSigner）。
 */
export async function signRecord(signer, rec) {
  const body = { ...rec, signer: signer.address };
  delete body.sig;
  const sig = await signer.signMessage(messageOf(body));
  return { ...body, sig: toBase64(sig) };
}

/** Ed25519 の署名を確かめる（WebCrypto）。 */
export async function verifySig(rec) {
  try {
    const pub = fromBase58(String(rec.signer));
    const sig = fromBase64(String(rec.sig));
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, sig, messageOf(rec));
  } catch {
    return false;
  }
}

/** 試験用の鍵（ローカルのみ。実資金のウォレットではない）。`seed` を渡すと決まった鍵になる（テスト用）。 */
export async function testSigner(seed = null) {
  let pair;
  if (seed) {
    // PKCS#8 の Ed25519 の前置き ‖ 32バイトの種
    const pk8 = concat(new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]), seed);
    const privateKey = await crypto.subtle.importKey('pkcs8', pk8, { name: 'Ed25519' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    const publicKey = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: 'Ed25519' }, true, ['verify']);
    pair = { privateKey, publicKey };
  } else {
    pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  }
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    address: toBase58(raw),
    kind: 'test',
    signMessage: async m => new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, m)),
    signBytes: async m => new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, m)),
  };
}

// ------------------------------------------------------------------ 形の確認

function needOf(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (!RESOURCES.includes(k) || !isInt(v, 1, MAX_QTY)) return null;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
const placeOk = t => t && t.kind === 'holding' && isInt(t.p, -64, 64) && isInt(t.q, -64, 64) && isInt(t.site, 0, 63) && isInt(t.gen, 0, 0xffffffff);

/** 記録の形だけを確かめる（署名と状態は別）。理由の文字列か null。 */
export function shapeProblem(rec, goals) {
  if (!rec || typeof rec !== 'object') return '記録ではない';
  if (rec.v !== 1) return '版が違う';
  if (!KINDS.includes(rec.kind)) return `知らない種類：${rec.kind}`;
  if (typeof rec.signer !== 'string' || typeof rec.sig !== 'string') return '署名がない';
  if (!rec.season || typeof rec.season.programId !== 'string' || typeof rec.season.seasonId !== 'string') return 'シーズンがない';
  if (!isInt(rec.at, 0, 2 ** 40)) return '時刻がない';
  switch (rec.kind) {
    case 'request':
      if (!goals[rec.goalId]) return `知らない目的：${rec.goalId}`;
      if (!needOf(rec.need)) return '必要な資源が正しくない（種類と1〜100000の整数）';
      if (!placeOk(rec.to)) return '届け先（村）が正しくない';
      if (!isInt(rec.nation, 0, 5)) return '国（申告）が正しくない';
      if (!isInt(rec.expiresAt, rec.at + 1, rec.at + 30 * 86400)) return '期限が正しくない';
      if (typeof rec.nonce !== 'string' || rec.nonce.length > 64) return 'nonce が正しくない';
      return null;
    case 'respond':
      if (typeof rec.request !== 'string') return '依頼の ID がない';
      if (!['accept', 'decline'].includes(rec.answer)) return '答えが正しくない';
      if (!isInt(rec.nation, 0, 5)) return '国（申告）が正しくない';
      if (rec.answer === 'accept' && !needOf(rec.offer)) return '送るつもりの量が正しくない';
      return null;
    case 'withdraw': case 'cancel':
      if (typeof rec.request !== 'string') return '依頼の ID がない';
      if (rec.kind === 'cancel' && !['self', 'other', 'done'].includes(rec.reason)) return '取消の理由が正しくない';
      return null;
    case 'sending':
      if (typeof rec.request !== 'string') return '依頼の ID がない';
      if (!rec.caravan || !/^\d{1,20}$/.test(String(rec.caravan.ownerTag)) || !isInt(rec.caravan.seq, 0, 0xffffffff)) return '隊商の ID が正しくない';
      if (typeof rec.walletSig !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(rec.walletSig)) return 'ウォレットの署名が正しくない';
      if (typeof rec.blockhash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rec.blockhash)) return 'blockhash が正しくない';
      if (!needOf(rec.cargo)) return '荷が正しくない';
      if (!rec.src || !isInt(rec.src.p, -64, 64) || !isInt(rec.src.q, -64, 64) || !isInt(rec.src.site, 0, 63) || !isInt(rec.src.gen, 0, 255)) return '送り元が正しくない';
      return null;
    case 'link':
      if (typeof rec.request !== 'string') return '依頼の ID がない';
      if (!rec.caravan || !/^\d{1,20}$/.test(String(rec.caravan.ownerTag)) || !isInt(rec.caravan.seq, 0, 0xffffffff)) return '隊商の ID が正しくない';
      return null;
    case 'leave':
      if (!goals[rec.goalId]) return `知らない目的：${rec.goalId}`;
      return null;
  }
  return '不明';
}

// ------------------------------------------------------------------ 畳み込み

/** チェーンの文脈（どの programId・シーズン ID の口座で確かめるか）の鍵。 */
export const ctxKey = c => `${c.programId}/${c.seasonId}`;
const sameCtx = (a, b) => a.programId === b.programId && a.seasonId === b.seasonId;

/**
 * 記録を一つずつ畳み込む（板は受け取った順に足していく。全体を毎回やり直さない：長く続く世界で記録が増えても重くならない）。
 *
 * 世界の継続（2026-10-31 の方針）：依頼の板は、シーズン（チェーンの文脈）が変わっても依頼・応答・結び付け・記録を消さない。
 *   - `contexts`：読める文脈の一覧（今の文脈と、前の文脈）。一覧にない文脈の記録は断る（知らない口座で確かめられない）。
 *   - `current`：新しい依頼を出せる文脈。前の文脈の依頼は、自分の期限まで開いたまま（文脈が変わったことでは閉じない）。
 *   - 依頼に続く記録（応答・取り下げ・取消・送信・結び付け）は、依頼と同じ文脈で確かめる（旧版の証拠を新版の証拠に読み替えない）。
 *   - 隊商の鍵は文脈ごと（Citizen はシーズンごとの口座で、隊商の番号もその Citizen ごとに 0 から）なので、鍵に文脈を含める。
 * 文脈を世界の正本として定義するのは④⑧の共通方針で、①は渡された一覧を使うだけ。
 */
export function createFolder({ goals, contexts, current = null }) {
  const S = { requests: {}, left: {}, rejected: [], accepted: [] };
  const seenIds = new Set();
  const linkedCaravans = new Set();
  let n = -1;
  const known = c => contexts.some(x => sameCtx(x, c));
  const leftOf = (g, w) => (S.left[g] ?? []).includes(w);
  let quiet = false, live = false;
  const reject = (rec, why) => { if (!quiet) S.rejected.push({ id: recordId(rec), kind: rec.kind, signer: rec.signer, why }); return { ok: false, why }; };
  /**
   * 一つ足す。断った記録は状態を変えない。`quiet`：断った記録を rejected に残さない（板が受け付けなかった送信。保存しないので）。
   * `live`：いま受け取る記録（新しい依頼は今の文脈だけ）。保存した記録の読み直しでは、その時に正しかった記録を断らない。
   */
  function add(rec, opts = {}) {
    quiet = !!opts.quiet;
    live = !!opts.live;
    n += 1;
    const shape = shapeProblem(rec, goals);
    if (shape) return reject(rec, shape);
    if (!known(rec.season)) return reject(rec, `知らない文脈（${ctxKey(rec.season)}）の記録`);
    const id = recordId(rec);
    if (seenIds.has(id)) return reject(rec, '同じ記録が二度');
    const r = rec.request ? S.requests[rec.request] : null;
    if (r && !sameCtx(r.ctx, rec.season)) return reject(rec, `依頼（${ctxKey(r.ctx)}）と別の文脈の記録。依頼の口座は依頼の文脈で確かめる`);
    const season = r ? r.ctx : rec.season;
    const openAt = (q, t) => q.state === 'open' && t < q.expiresAt;
    const why = (() => {
      switch (rec.kind) {
        case 'request': {
          if (leftOf(rec.goalId, rec.signer)) return 'この目的から抜けた人は依頼できない';
          if (live && current && !sameCtx(rec.season, current)) return `新しい依頼は今の文脈（${ctxKey(current)}）で出す`;
          S.requests[id] = {
            id, ctx: { programId: rec.season.programId, seasonId: rec.season.seasonId }, goalId: rec.goalId, requester: rec.signer, nation: rec.nation, need: { ...rec.need }, to: { ...rec.to },
            at: rec.at, expiresAt: rec.expiresAt, state: 'open', cancel: null, responses: {}, links: [], sendings: [],
          };
          return null;
        }
        case 'respond': {
          if (!r) return '依頼が見つからない';
          if (rec.signer === r.requester) return '自分の依頼には応答できない';
          if (leftOf(r.goalId, rec.signer)) return 'この目的から抜けた人は応答できない';
          if (!openAt(r, rec.at)) return r.state === 'open' ? '依頼の期限が過ぎている' : `依頼は${r.state === 'cancelled' ? '取り消された' : '閉じた'}`;
          if (rec.answer === 'accept') {
            for (const [k, v] of Object.entries(rec.offer)) if (!(k in r.need) || v > r.need[k]) return `依頼にない量：${RESOURCE_JA[k] ?? k} ${v}`;
          }
          r.responses[rec.signer] = { id: recordId(rec), answer: rec.answer, offer: rec.answer === 'accept' ? { ...rec.offer } : null, nation: rec.nation, at: rec.at, withdrawn: false };
          return null;
        }
        case 'withdraw': {
          if (!r) return '依頼が見つからない';
          const x = r.responses[rec.signer];
          if (!x || x.answer !== 'accept' || x.withdrawn) return '取り下げる応答がない';
          x.withdrawn = true; x.withdrawnAt = rec.at;
          return null;
        }
        case 'cancel': {
          if (!r) return '依頼が見つからない';
          if (rec.signer !== r.requester) return '依頼した人だけが取り消せる';
          if (r.state !== 'open') return 'もう閉じている';
          r.state = 'cancelled'; r.cancel = { reason: rec.reason, at: rec.at };
          return null;
        }
        case 'sending': {
          if (!r) return '依頼が見つからない';
          const x = r.responses[rec.signer];
          if (!x || x.answer !== 'accept' || x.withdrawn) return '応じていない人は送れない';
          if (!openAt(r, rec.at)) return '依頼が開いていない';
          if (String(rec.caravan.ownerTag) !== ownerTagOf(season, rec.signer)) return '隊商の鍵がこの署名の人のものではない';
          for (const [k, v] of Object.entries(rec.cargo)) if (!(k in r.need) || v > r.need[k]) return `依頼にない量：${RESOURCE_JA[k] ?? k} ${v}`;
          if (Object.values(S.requests).some(q => q.sendings.some(z => z.walletSig === rec.walletSig))) return '同じ取引の記録が二度';
          r.sendings.push({ responder: rec.signer, caravan: { ownerTag: String(rec.caravan.ownerTag), seq: rec.caravan.seq, ctx: ctxKey(season) }, walletSig: rec.walletSig, blockhash: rec.blockhash,
            cargo: { ...rec.cargo }, src: { ...rec.src }, at: rec.at, n });
          return null;
        }
        case 'link': {
          if (!r) return '依頼が見つからない';
          const x = r.responses[rec.signer];
          if (!x || x.answer !== 'accept' || x.withdrawn) return '応じていない人は隊商を結び付けられない';
          if (!openAt(r, rec.at)) return '依頼が開いていない（取消・期限切れの後は結び付けない。隊商はそのまま届く）';
          if (String(rec.caravan.ownerTag) !== ownerTagOf(season, rec.signer)) return '隊商の持ち主がこの署名の人ではない';
          const key = `${ctxKey(season)}:${rec.caravan.ownerTag}:${rec.caravan.seq}`;
          if (linkedCaravans.has(key)) return 'この隊商はもう結び付けられている';
          linkedCaravans.add(key);
          r.links.push({ responder: rec.signer, claimedNation: x.nation, caravan: { ownerTag: String(rec.caravan.ownerTag), seq: rec.caravan.seq, ctx: ctxKey(season) }, at: rec.at, n });
          return null;
        }
        case 'leave': {
          if (leftOf(rec.goalId, rec.signer)) return 'もう抜けている';
          (S.left[rec.goalId] ??= []).push(rec.signer);
          // 抜けた人の開いている依頼は取り消し、応じた答えは取り下げる。送った隊商はそのまま届く。
          for (const q of Object.values(S.requests)) {
            if (q.goalId !== rec.goalId) continue;
            if (q.requester === rec.signer && q.state === 'open') { q.state = 'cancelled'; q.cancel = { reason: 'left', at: rec.at }; }
            const x = q.responses[rec.signer];
            if (x && x.answer === 'accept' && !x.withdrawn) { x.withdrawn = true; x.withdrawnAt = rec.at; x.byLeave = true; }
          }
          return null;
        }
      }
      return '不明';
    })();
    if (why) return reject(rec, why);
    seenIds.add(id);
    S.accepted.push(id);
    return { ok: true, id };
  }
  return { add, state: S };
}

/**
 * 記録の列をまとめて畳み込む（テストや読み直し用）。`season` 一つを渡す古い呼び方は、その文脈だけを読む。
 * 返す形：{ requests: {id: {...}}, left: {goalId: [wallet]}, rejected: [{id, kind, why}] }
 */
export function fold(records, { goals, season = null, contexts = null, current = null }) {
  const f = createFolder({ goals, contexts: contexts ?? [season], current });
  for (const rec of records) f.add(rec);
  return f.state;
}

/** 依頼の状態を、時刻 `now` で読む（期限切れを表示に反映。記録は変えない）。 */
export const stateAt = (q, now) => (q.state === 'open' && now >= q.expiresAt ? 'expired' : q.state);
