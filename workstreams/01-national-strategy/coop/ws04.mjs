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
 * ①の到着の状態と、④の実行器の終わりの状態の対応（④ STATE-MACHINE「到着量の判定」、executor.rs の Arrived → …）。
 * ④の run は隊商1本で、比べる「依頼量」はその run が送った荷（`ship.cargo`）。①の到着も隊商1本なので、送った荷（チェーンの
 * CARAVAN_SENT の cargo、整数単位）と比べる：
 *   delivered が null（Unverifiable）→ DeliveredUnverified、delivered が全部 0 → Failed、送った荷以上 → Fulfilled、少ない → Partial。
 *   shipped：依頼の資源ごとの送った量（分からなければ null → 'Delivered'：Fulfilled と Partial を決めない。推測しない）。
 * 依頼（複数の隊商）ごとの充足は fulfilmentOf。
 */
export function toWs04Terminal(a, shipped = null) {
  if (a.state === 'delivered') {
    if (a.verification === 'Unverifiable' || a.delivered === null) return 'DeliveredUnverified';
    if (!a.delivered) return 'Delivered';
    const d = Object.values(a.delivered);
    if (d.every(v => v === 0)) return 'Failed';
    if (!shipped) return 'Delivered';
    return Object.entries(shipped).every(([r, n]) => (a.delivered[r] ?? 0) >= n) ? 'Fulfilled' : 'Partial';
  }
  if (['lost', 'misdelivered', 'raided-taken', 'raided-burned'].includes(a.state)) return 'Failed';
  if (a.state === 'moving') return 'InTransit';
  return null;   // unknown：④の Indeterminate に近いが、①は送信の主体でないので状態を持たない
}

const qtyText = (o, ja) => Object.entries(o ?? {}).map(([r, v]) => `${ja[r] ?? r} ${v}`).join('・');
const REASON_JA = Object.freeze({
  lost: '行き先がない・村の世代が変わった', misdelivered: '依頼の届け先とは別の場所に確定した', 'raided-taken': '襲撃で奪われた', 'raided-burned': '襲撃で焼かれた',
});

/**
 * 到着量の言い方（④ HANDOFF §2、CONTRACTS §8.1）。実際の到着量の状態（分からない・0 と分かる・n と分かる）だけを言う。
 * 数えた量（算入量）は別の欄（goal.mjs の counted）。
 *   - 検証した量（Recorded・RuleDerived）：「届いた n 個」
 *   - Unverifiable：「到着したが、入った量を確認できない（最大 n 個）」。n は記録の cargo（上限）。「届いた」「0 個」「全損」「失敗」と言わない
 *   - KnownZero：「届かなかった（理由）」
 *   - 輸送中：「輸送中」（④の「輸送中 n 個」の n は送った荷。分かれば出す）、分からない：「分からない（まだ確かめていない）」
 * {kind: 'verified'|'unverifiable'|'known-zero'|'moving'|'unknown', text}
 */
export function deliveredText(a, ja, shipped = null) {
  if (a.verification === 'KnownZero') return { kind: 'known-zero', text: `届かなかった（${REASON_JA[a.state] ?? a.note ?? '0 と分かっている'}）` };
  if (a.state === 'delivered' && (a.verification === 'Unverifiable' || a.delivered === null || a.delivered === undefined)) {
    const max = a.cargoLogged ? qtyText(a.cargoLogged, ja) : null;
    return { kind: 'unverifiable', text: `到着したが、入った量を確認できない${max ? `（最大 ${max}）` : ''}` };
  }
  if (a.state === 'delivered' && a.delivered) return { kind: 'verified', text: `届いた ${qtyText(a.delivered, ja)}` };
  if (a.state === 'moving') return { kind: 'moving', text: `輸送中${shipped ? ` ${qtyText(shipped, ja)}` : ''}` };
  return { kind: 'unknown', text: '分からない（まだ確かめていない）' };
}

/**
 * 依頼ごとの充足（④ STATE-MACHINE：検証できた入荷量が依頼量以上なら Fulfilled、少なければ Partial、0 なら Failed）。
 * ①の依頼は複数の隊商で満たしうるので、依頼に割り当てた到着の「数えた量」（counted：検証済みで、到着時の受取人が依頼した人で、
 * 応じた後の送信のもの）を資源ごとに足し、依頼の need と比べる。数えない到着（量を確認できない・未検証）は足さない。
 *   status：
 *     'fulfilled'  資源ごとに、数えた量が依頼量以上
 *     'partial'    数えた量が 0 より多いが、どれかの資源で依頼量に足りない
 *     'failed'     結び付けた隊商がすべて終わり、どれも届かなかった（KnownZero）
 *     'unverified' 数えた量が 0 で、到着したが数えられないもの（量を確認できない・受取人や時刻が未検証）がある。0 とも失敗とも言わない
 *     'pending'    数えた量が 0 で、まだ終わっていない・分からない隊商がある
 *     'none'       結び付けた隊商がない
 *   counted：資源ごとの数えた量、shortBy：資源ごとの不足、open：まだ終わっていない隊商の数、unproven：到着したが数えられない隊商の数
 * 依頼量を超えた分も counted に残す（共同の目的は資源ごとの合計で判定するので、依頼で切らない）。
 */
export function fulfilmentOf(q, arrivals) {
  const own = arrivals.filter(a => a.requestId === q.id && !a.duplicateOf);
  const counted = Object.fromEntries(Object.keys(q.need).map(r => [r, 0]));
  let open = 0, unproven = 0, zero = 0;
  for (const a of own) {
    if (a.counted) for (const [r, v] of Object.entries(a.counted)) counted[r] = (counted[r] ?? 0) + v;
    else if (a.verification === 'KnownZero') zero += 1;
    else if (a.state === 'delivered') unproven += 1;
    else open += 1;
  }
  const shortBy = Object.fromEntries(Object.entries(q.need).map(([r, n]) => [r, Math.max(0, n - (counted[r] ?? 0))]).filter(([, v]) => v > 0));
  const any = Object.values(counted).some(v => v > 0);
  const status = !own.length ? 'none'
    : !Object.keys(shortBy).length ? 'fulfilled'
    : any ? 'partial'
    : unproven ? 'unverified'
    : open ? 'pending'
    : 'failed';
  return { status, counted, shortBy, open, unproven, knownZero: zero, links: own.length };
}

export const FULFILMENT_JA = Object.freeze({
  fulfilled: '依頼量に届いた（Fulfilled）', partial: '一部（Partial）', failed: '届かなかった（Failed）',
  unverified: '到着したが、数えられる量がまだない', pending: '輸送中・結果待ち', none: 'まだ隊商がない',
});
