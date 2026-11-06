// ④との契約（受領版 wylls-ws04-handoff-20261030、ws04/handoff 2e536b6b119d8eaa4e9f4d795e856b696249a664）。
//
// ④の形（workstreams/04-execution/src/model.rs）：
//   pub type Res = [u64; RESOURCES];      // 「Whole units per resource (the PS2 logs' unit for cargo)」：整数単位
//   pub struct Outcome { delivered: Option<Res>, verification: Verification, cargo_logged: Option<Res>, effects: Vec<String>, note: String }
//   pub enum Verification { Recorded, RuleDerived, KnownZero, Unverifiable, NotShipped }
//   serde の既定の JSON：{"delivered": [8] | null, "verification": "RuleDerived", "cargo_logged": [8] | null, "effects": [], "note": ""}
//   （①の test/fixtures/ws04-outcomes-2e536b6b.json は、④のコードの Outcome を serde_json で書き出したもの）
//
// ①の到着（arrival.mjs）は依頼の資源だけを持つ（{wood: n, stone: n}）。ここで8資源の配列と行き来する。

import { RESOURCES } from './record.mjs';

export const WS04 = Object.freeze({ head: '2e536b6b119d8eaa4e9f4d795e856b696249a664', tree: '0a02f9e07fc7b2e3f2ea7d6ae0c5386c5da41e7a' });
export const WS04_VERIFICATIONS = Object.freeze(['Recorded', 'RuleDerived', 'KnownZero', 'Unverifiable', 'NotShipped']);

/** 8資源の配列（S1 の Resource の並び：food, wood, stone, ore, arms(horses), gold, science, influence） → 依頼の資源だけ。 */
export const pickNeed = (res, need) => (res ? Object.fromEntries(Object.keys(need).map(r => [r, Number(res[RESOURCES.indexOf(r)] ?? 0)])) : null);
/** 依頼の資源 → 8資源の配列（ないものは 0）。 */
export const toRes = obj => (obj ? Array.from({ length: 8 }, (_, i) => Number(obj[RESOURCES[i]] ?? 0)) : null);

/** ④の Outcome（JSON）を、①の到着の欄（依頼の資源ごと）にする。形が違えば例外。 */
export function fromWs04Outcome(o, need) {
  if (!o || typeof o !== 'object') throw new Error('④の Outcome ではない');
  if (!WS04_VERIFICATIONS.includes(o.verification)) throw new Error(`知らない verification：${o.verification}`);
  const res = x => {
    if (x === null) return null;
    if (!Array.isArray(x) || x.length !== 8 || !x.every(v => Number.isSafeInteger(v) && v >= 0)) throw new Error('Res は 8 個の 0 以上の整数（整数単位）');
    return x;
  };
  const delivered = res(o.delivered), cargoLogged = res(o.cargo_logged);
  if (o.verification === 'Unverifiable' && delivered !== null) throw new Error('Unverifiable なのに delivered がある');
  if (o.verification === 'KnownZero' && (delivered === null || delivered.some(v => v !== 0))) throw new Error('KnownZero なのに delivered が 0 でない');
  return { delivered: pickNeed(delivered, need), verification: o.verification, cargoLogged: pickNeed(cargoLogged, need) };
}

/**
 * ①の到着を、④の Outcome の形にする（契約の確かめ用）。①は Recorded（P1）を作らない。
 * 依頼の届け先とは別の場所への確定（misdelivered）は、依頼の届け先には 0（KnownZero）。輸送中・不明は Outcome を持たない（null）。
 */
export function toWs04Outcome(a) {
  if (a.verification === null || a.verification === undefined) return null;
  return { delivered: toRes(a.delivered), verification: a.verification, cargo_logged: toRes(a.cargoLogged), effects: [], note: '' };
}

/**
 * ①の到着の状態と、④の実行器の終わりの状態の対応（④ QUANTITY-CONTRACT §4、executor.rs on_arrived。④ 8e96f24d で照合）。
 * ④の run は隊商1本で、比べる「依頼量」はその run の荷（`spec.ship.cargo`、損耗の前）。①は送った荷（チェーンの最初の CARAVAN_SENT の
 * cargo。命令の整数単位の荷と同じ）と、検証した量の下限 b を比べる：
 *   delivered が null（Unverifiable）→ DeliveredUnverified
 *   すべての資源で b ≥ 送った荷 → Fulfilled（証明）、どれかで b < 送った荷 → Partial（この run は届いていないと証明。b が 0 でも Partial：
 *   1 未満の端数が入っていうる。④ HANDOFF §2「0 個以上」）
 *   KnownZero（この隊商の焼却・奪取の記録、口座の持ち主の書き換え、LOST）→ Failed
 *   別の場所に着いた・別の行き先へ向かう（襲撃の記録なし）→ 'DestinationMismatch'（④の保留。outcome なし）
 *   shipped：依頼の資源ごとの送った量（分からなければ null → 'Delivered'：Fulfilled と Partial を決めない。推測しない）。
 * 依頼（複数の隊商）ごとの充足は fulfilmentOf。
 */
export function toWs04Terminal(a, shipped = null) {
  if (a.held === 'DestinationMismatch') return 'DestinationMismatch';
  if (a.verification === 'KnownZero') return 'Failed';
  if (a.state === 'delivered') {
    if (a.verification === 'Unverifiable' || a.delivered === null) return 'DeliveredUnverified';
    if (!a.delivered || !shipped) return 'Delivered';
    return Object.entries(shipped).every(([r, n]) => (a.delivered[r] ?? 0) >= n) ? 'Fulfilled' : 'Partial';
  }
  if (a.state === 'moving') return 'InTransit';
  return null;   // unknown・襲われた印だけ：④の Indeterminate に近いが、①は送信の主体でないので状態を持たない
}

/**
 * 実際に入った量の区間（資源ごと、整数単位。④ QUANTITY-CONTRACT §3）。{kind, perResource: {r: {min, maxExclusive}}} か null（述べない）。
 *   'lower-bound'：RuleDerived・Recorded（今の④は P1 を案 B＝切り捨てとして読む）。[b, b+1)
 *   'unknown'    ：Unverifiable。[0, cargo_logged+1)。cargo_logged が無ければ上限も述べない（maxExclusive null）
 *   'zero'       ：KnownZero。ちょうど 0
 *   null         ：輸送中・分からない・原因を確認中（量を述べない）
 */
export function amountOf(a) {
  const each = f => Object.fromEntries(Object.keys(a.delivered ?? a.cargoLogged ?? {}).map(r => [r, f(r)]));
  if (a.verification === 'KnownZero') return { kind: 'zero', perResource: each(() => ({ min: 0, maxExclusive: 0, exact: true })) };
  if (a.state !== 'delivered') return null;
  if (a.verification === 'Unverifiable' || a.delivered === null) {
    return { kind: 'unknown', perResource: Object.fromEntries(Object.entries(a.cargoLogged ?? {}).map(([r, v]) => [r, { min: 0, maxExclusive: v + 1 }])) };
  }
  if (a.delivered && ['RuleDerived', 'Recorded'].includes(a.verification)) return { kind: 'lower-bound', perResource: each(r => ({ min: a.delivered[r], maxExclusive: a.delivered[r] + 1 })) };
  return null;
}

const qtyText = (o, ja, suffix = '') => Object.entries(o ?? {}).map(([r, v]) => `${ja[r] ?? r} ${v}${suffix}`).join('・');
const REASON_JA = Object.freeze({
  lost: '行き先がない・村の世代が変わった', 'raided-taken': '襲撃で奪われた', 'raided-burned': '襲撃で焼かれた',
});

/**
 * 到着量の言い方（④ HANDOFF §2・QUANTITY-CONTRACT §3、⑦への提案 §7 に合わせた）。実際の到着量の状態だけを言う。
 * 数えた量（算入量）は別の欄（goal.mjs の counted）。
 *   - 下限（RuleDerived・Recorded）：「届いた 木材 196 以上」。0 でも「0 以上」（「0 個」「届かなかった」と言わない）
 *   - Unverifiable：「到着したが、入った量を確認できない（最大 木材 200＋端数）」。「届いた」「0 個」「全損」「失敗」と言わない
 *   - KnownZero：「届かなかった（理由）」
 *   - 別の場所：「別の場所に着いた（原因を確認中）」。「奪われた」と言わず、相手の名前を出さない
 *   - 輸送中：「輸送中 木材 200」（送った荷が分かれば）、分からない：「分からない（まだ確かめていない）」
 * {kind: 'lower-bound'|'unknown'|'zero'|'held'|'moving'|'unknown-state', text}
 */
export function deliveredText(a, ja, shipped = null) {
  if (a.verification === 'KnownZero') return { kind: 'zero', text: `届かなかった（${REASON_JA[a.state] ?? '0 と分かっている'}）` };
  if (a.held === 'DestinationMismatch') return { kind: 'held', text: a.state === 'misdirected' ? '別の行き先へ向かっている（原因を確認中）' : '別の場所に着いた（原因を確認中）' };
  if (a.state === 'delivered' && (a.verification === 'Unverifiable' || a.delivered === null || a.delivered === undefined)) {
    const max = a.cargoLogged ? qtyText(a.cargoLogged, ja) : null;
    return { kind: 'unknown', text: `到着したが、入った量を確認できない${max ? `（最大 ${max}＋端数）` : ''}` };
  }
  if (a.state === 'delivered' && a.delivered) return { kind: 'lower-bound', text: `届いた ${qtyText(a.delivered, ja, ' 以上')}` };
  if (a.state === 'moving') return { kind: 'moving', text: `輸送中${shipped ? ` ${qtyText(shipped, ja)}` : ''}` };
  if (a.state === 'raided-unconfirmed') return { kind: 'unknown-state', text: '襲われた印がある（焼かれたか奪われたかは記録で確かめていない）' };
  return { kind: 'unknown-state', text: '分からない（まだ確かめていない）' };
}

/**
 * 依頼ごとの充足（④ QUANTITY-CONTRACT §4 の合計の目標の三つの区分。依頼量 G を資源ごとに）。
 * ①の依頼は複数の隊商で満たしうるので、依頼に割り当てた到着の「数えられる量」の区間を足す（goal.mjs countOf の counted と countUpper）：
 *   下限 L ＝ Σ 数えた量（検証済み・到着時の受取人が依頼した人・応じた後の送信）
 *   上限 U ＝ Σ その到着が数えられうる量の上限（未満）：下限の到着は b+1、量を確認できない到着は cargo_logged+1、
 *            受取人・時刻が未検証の到着も b+1（後で確かめられうる）、0 と分かる・数えないと決まった到着は 0
 *   status：
 *     'fulfilled'    どの資源も L ≥ G（証明）
 *     'not-reached'  結び付けた隊商がすべて終わり（final）、どれかの資源で U ≤ G … 実際の量 < U ≤ G なので届いていない（証明）
 *     'undetermined' その間（下限が依頼量未満なだけでは「未達」と言わない）。輸送中・原因を確認中があればここ
 *     'none'         結び付けた隊商がない
 * 依頼量を超えた分も lower に残す（共同の目的は資源ごとの合計で判定するので、依頼で切らない）。
 */
export function fulfilmentOf(q, arrivals) {
  const own = arrivals.filter(a => a.requestId === q.id && !a.duplicateOf);
  const lower = Object.fromEntries(Object.keys(q.need).map(r => [r, 0]));
  const upperExclusive = Object.fromEntries(Object.keys(q.need).map(r => [r, 0]));
  let open = 0, unproven = 0, zero = 0, held = 0;
  for (const a of own) {
    if (a.counted) for (const [r, v] of Object.entries(a.counted)) lower[r] = (lower[r] ?? 0) + v;
    if (a.countUpper) for (const r of Object.keys(q.need)) upperExclusive[r] += a.countUpper[r] ?? 0;
    if (a.countFinal === false) { open += 1; if (a.held) held += 1; }
    else if (!a.counted && a.verification === 'KnownZero') zero += 1;
    else if (!a.counted && a.state === 'delivered') unproven += 1;
  }
  const shortBy = Object.fromEntries(Object.entries(q.need).map(([r, n]) => [r, Math.max(0, n - (lower[r] ?? 0))]).filter(([, v]) => v > 0));
  const provenShort = open === 0 && Object.entries(q.need).some(([r, n]) => upperExclusive[r] <= n);
  const status = !own.length ? 'none' : !Object.keys(shortBy).length ? 'fulfilled' : provenShort ? 'not-reached' : 'undetermined';
  return { status, lower, upperExclusive: open ? null : upperExclusive, shortBy, open, held, unproven, knownZero: zero, links: own.length, counted: lower };
}

export const FULFILMENT_JA = Object.freeze({
  fulfilled: '依頼量に届いた（数えた量の下限で証明）', 'not-reached': '依頼量に届かなかった（すべて終わり、上限で証明）',
  undetermined: '判定できない（下限は依頼量に届いていないが、届いていないとも言えない）', none: 'まだ隊商がない',
});
