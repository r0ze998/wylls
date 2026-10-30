// The three rulesets compared (docs/04-variants.ja.md). Every number is a
// placeholder for comparison, not a decision. A ruleset is data: its hash
// (`rulesetHash`) goes into every verdict, so changing a number changes the
// version a replay must name.

/** Structure costs, from the code at the base commit: permutation-rules
 * `frontier/structure.rs` `cost_units` (wood, stone, arms in the Horses slot, gold). */
export const S1_COSTS = Object.freeze({
  tower: { wood: 300, stone: 400, arms: 20, gold: 100 },
  palisade: { wood: 200, stone: 100, gold: 20 },
  fort: { wood: 500, stone: 800, arms: 50, gold: 200 },
});

/** What variant A reads: the prize program's decided and provisional rules (permutation-prize lib.rs `provisional::RULES`). */
const BASELINE_PRIZE = Object.freeze({
  winner: 'most keeps held when the period closes (decided)',
  tie: 'more territory bells; still tied: the tied nations share (provisional)',
  newMoney: 0,
});

const JOINT_NORTH_FORT = Object.freeze({
  id: 'J-north-fort',
  label: '北方の砦（共同）',
  structure: 'fort',
  requires: S1_COSTS.fort,
  minNations: 3,
  minShareBps: 1_000,
  attribution: 'origin',
  use: { minNations: 2, windowBells: 48, hows: ['garrison', 'pass', 'supply'] },
});

const NATIONAL = Object.freeze({
  default: 'N-build-use',
  goals: [
    { id: 'N-build-use', kind: 'build_use', base: 1, label: '国の建物を建て、他の人に使われる' },
    { id: 'N-hold', kind: 'hold_bells', base: 96, label: '要塞を持った鐘数（人数に応じて）' },
    { id: 'N-joint-share', kind: 'joint_share', label: '共同達成に、条件を満たす国として加わる' },
  ],
});

const PERSONAL = Object.freeze([
  { id: 'P-supplier', kind: 'supplier', label: '完成した計画に、確かめられた材料を入れた', minQty: { food: 100, wood: 100, stone: 100, ore: 100, arms: 10, gold: 20 } },
  { id: 'P-cross-user', kind: 'cross_user', label: '他の国の人の建物を使った' },
  { id: 'P-founder', kind: 'founder', label: '開いた計画が、他の2人以上の材料で完成した', minOthers: 2 },
  { id: 'P-raider', kind: 'raider', label: '他の国の隊商から奪った（国内の襲撃は数えない）', minQty: { food: 100, wood: 100, stone: 100, ore: 100, arms: 10, gold: 20 } },
  { id: 'P-scout', kind: 'scout', label: '塔で見たことが、他の人に使われた（⑭の塔の入力があるときだけ）' },
]);

const KEEPS_RESET = '勝敗の砦（要塞）は中立に、国どうしの戦争の状態は戦争なしに戻る（23 の C 案、提案）';
const CONTINUES = ['村・建物・倉と中身（荷）', '国の所属と国の設定', '記録と実績', '移動中の隊商（次の戦期に着く）'];

export const RULESETS = Object.freeze({
  A: Object.freeze({
    id: 'A-baseline-competitive', version: 1, variant: 'A',
    note: '現行コードの勝ち方だけ。目標は判定しない',
    costs: S1_COSTS, prize: BASELINE_PRIZE,
    joint: [], national: null, personal: [],
    close: { kind: 'schedule' },
    scope: { ends: ['要塞の数を数え、賞金の勝者を決める（現行：Season を Ended にして Tally・Finalize）'], continues: ['現行コードではシーズンの後の世界は続かない（23 の C 案は未実装）'] },
    slotBy: 'cluster',
  }),
  B: Object.freeze({
    id: 'B-separate-tracks', version: 1, variant: 'B',
    note: '共同・国・個人を別々に判定。共同達成では戦期も世界も終わらない',
    costs: S1_COSTS, prize: BASELINE_PRIZE,
    joint: [JOINT_NORTH_FORT], national: NATIONAL, personal: PERSONAL,
    close: { kind: 'schedule' },
    scope: { ends: ['予定の時刻に戦期が閉じ、要塞の数で勝者を決める', KEEPS_RESET, 'この戦期の目標の判定'], continues: [...CONTINUES, '未完成の共同計画に入れた材料（次の戦期に持ち越して数えるかは未決）'] },
    slotBy: 'cluster',
  }),
  C: Object.freeze({
    id: 'C-joint-chapter', version: 1, variant: 'C',
    note: '共同達成（利用まで）が成立すると、予告の後に戦期を区切る',
    costs: S1_COSTS, prize: BASELINE_PRIZE,
    joint: [JOINT_NORTH_FORT], national: NATIONAL, personal: PERSONAL,
    close: { kind: 'joint-chapter', goal: 'J-north-fort', noticeBells: 24 },
    scope: { ends: ['共同達成から予告の鐘数の後（予定の終わりより遅くはならない）に戦期が閉じ、その時点の要塞の数で勝者を決める', KEEPS_RESET, 'この戦期の目標の判定', '共同目標は次の章へ進む（次の章の中身は範囲外）'], continues: [...CONTINUES, '完成した共同の建物'] },
    slotBy: 'cluster',
  }),
});
