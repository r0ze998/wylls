// The evaluator's input contract, version 0 (draft shared with ①, ④ and ⑭;
// docs/03-contract.ja.md). An input is `{state, events}`: the state fixes who
// exists at the start of a war period and what they hold, the events are the
// facts after it. Every event carries an envelope:
//
//   id        unique per fact in its source (the same id twice is a duplicate
//             when the content is the same, a conflict when it is not)
//   stream    the source sequence it came in (`chain`, `ws01`, `ws14`, …)
//   seq       its position in that stream; positions are contiguous from
//             `state.streams[stream].from` (0 when absent) through
//             `state.streams[stream].through` when the source states it
//   sub       optional: the n-th event an adapter derived from that one record
//             (a caravan's cargo becomes one event per resource)
//   at        the game bell it happened at
//   kind      one of KINDS below
//   verified  how its quantities are known (VERIFIED)
//
// Nothing here is read from a chain: adapters (src/adapters/) turn records of
// the S1 program, ①'s request board or ⑭'s tower into these events.

/** Resources the evaluator keeps apart (S1 holds arms in the Horses slot). */
export const RESOURCES = Object.freeze(['food', 'wood', 'stone', 'ore', 'arms', 'gold']);

/** How an event's quantities are known. */
export const VERIFIED = Object.freeze({
  chain: 'read from the program\'s own records or accounts',
  chain_lower_bound: 'the chain shows at least this much (①: arrivals to a village count the manifest as a lower bound)',
  derived: 'computed by an adapter from chain facts, not a record of its own',
  unverified: 'stated by a person, a page or an off-chain service; not counted',
});

/** Event kinds and their required payload fields. */
export const KINDS = Object.freeze({
  'actor.join': ['actor', 'nation'],
  'actor.move': ['actor', 'nation'],
  'actor.expel': ['actor'],
  'lot.produce': ['lot', 'owner', 'resource', 'qty'],
  'ship.send': ['ship', 'from', 'to', 'resource', 'qty'],
  'ship.arrive': ['ship', 'qty'],
  'ship.raid': ['ship', 'raider', 'taken', 'burned'],
  'ship.lost': ['ship'],
  'project.open': ['project', 'goal', 'steward'],
  'contribute': ['project', 'actor', 'lot', 'qty'],
  'build.complete': ['project', 'structure'],
  'structure.seized': ['structure', 'by'],
  'use': ['structure', 'actor', 'how'],
  'keep.set': ['keep', 'nation'],
  'territory.counter': ['nation', 'bells'],
  'nation.goal': ['nation', 'goal'],
  'tower.sighting': ['sighting', 'tower', 'actor'],
  'tower.report.used': ['sighting', 'actor'],
  // A source record with nothing to judge: it holds its stream position so it is not taken for a gap.
  'position': [],
});

/** Reason codes, with the sentence a verdict shows for each. */
export const REASONS = Object.freeze({
  // records
  duplicate: '同じ id・同じ中身の記録がもう一度来た。一度だけ数えた',
  conflict: '同じ id で中身の違う記録がある。どちらも使わない',
  missing_records: 'この記録の流れに欠けた番号がある。欠けた後の記録に頼る判定は断定しない',
  malformed: '必須の欄が欠けているか、型が違う',
  unknown_kind: '契約にない種類の記録',
  causality: '起きる前提の出来事（送り・計画・建設）がない、または後にある',
  // goods
  insufficient: '持っていない量を使おうとした（同じ荷の二重消費を含む）',
  not_owner: 'その荷の持ち主ではない',
  already_settled: 'この隊商はもう着いたか、奪われたか、失われた',
  qty_exceeds_sent: '着いた量が送った量より多い',
  unverified_qty: '量が確かめられていない。寄与に数えない',
  lower_bound: 'チェーンで確かめられた下限の量だけを数えた',
  late: '期限の後に起きたので、この戦期の目標には数えない',
  after_close: '戦期が閉じた後の出来事。この戦期の勝敗・目標には数えない',
  not_required: 'この計画が要らない資源',
  surplus: '要求量を超えた分。寄与に数えない（先着）',
  project_closed: '計画はもう建設が終わったか、期限が過ぎた',
  not_steward: '計画の責任者ではない人が建設の完了を出した',
  wrong_structure: '完成した建物の種類が、計画の建物と違う',
  stream_kind: 'その記録の流れが運ばないはずの種類',
  close_undecided: '共同達成の鐘が確かでないので、戦期の終わりの時刻を決められない',
  not_own_goods: '自分の荷ではない（送られた荷）。個人の目標には数えない',
  inputs_incomplete: '建設の完了の時点で、資源ごとの要求量がそろっていない',
  seized: '建物は奪われた後なので、共同の建物としての利用に数えない',
  use_window: '利用の期限（完成からの鐘数）の外',
  // goals
  stage_inputs: '材料の投入：資源ごとの要求量に、確かめられた寄与がそろっていない',
  stage_completion: '建設の完了：完成していない',
  stage_use: '実際の利用：必要な数の国に使われていない',
  diversity: '寄与した国が足りない（各国が少なくとも一つの資源で要求量の一定割合以上、独立した参加者で）',
  same_slot: '同じ報酬枠（目標×戦期×受取人）にはもう入っている',
  not_member: 'その時点でどの国にも属していない',
  goal_not_in_ruleset: 'このルールの版では判定しない目標',
  not_awarded: 'その報酬枠は判定結果にない、または受取人が違う',
  achieved: '条件をすべて満たした',
  hold_short: '要塞を持った鐘数が目標に届かない',
  below_min: '資源ごとの最小量に届かない（資源は合計しない）',
  domestic: '国内の襲撃は数えない（28 の決定）',
});

const isInt = v => Number.isSafeInteger(v);
const isQty = v => isInt(v) && v >= 0;

/** Problems with one event's shape: `[]` when it is well formed. */
export function shapeProblems(e) {
  if (!e || typeof e !== 'object') return ['malformed'];
  if (typeof e.id !== 'string' || !e.id || typeof e.stream !== 'string' || !isInt(e.seq) || !isInt(e.at)) return ['malformed'];
  if (e.sub !== undefined && !(isInt(e.sub) && e.sub >= 0)) return ['malformed'];
  if (!Object.hasOwn(KINDS, e.kind)) return ['unknown_kind'];
  if (!Object.hasOwn(VERIFIED, e.verified ?? '')) return ['malformed'];
  for (const f of KINDS[e.kind]) if (e[f] === undefined || e[f] === null) return ['malformed'];
  if ('resource' in e && !RESOURCES.includes(e.resource)) return ['malformed'];
  for (const f of ['qty', 'taken', 'burned', 'bells']) if (f in e && !isQty(e[f])) return ['malformed'];
  return [];
}

/** The fields of an event other than its envelope. */
export const payloadOf = ({ id, stream, seq, sub, at, kind, verified, ...rest }) => rest;
