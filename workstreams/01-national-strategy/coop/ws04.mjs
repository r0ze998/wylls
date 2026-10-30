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
 * ①の到着の状態と、④の実行器の終わりの状態の対応（④ STATE-MACHINE）。①は依頼の量で到着を切らないので、Fulfilled と Partial は
 * ①では分けず 'Delivered' とする（D4）。
 */
export function toWs04Terminal(a) {
  if (a.state === 'delivered') return a.verification === 'Unverifiable' ? 'DeliveredUnverified' : 'Delivered(Fulfilled|Partial)';
  if (['lost', 'misdelivered', 'raided-taken', 'raided-burned'].includes(a.state)) return 'Failed';
  if (a.state === 'moving') return 'InTransit';
  return null;   // unknown：④の Indeterminate に近いが、①は送信の主体でないので状態を持たない
}
