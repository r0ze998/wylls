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

/** What variant A reads: the prize program's decided and provisional rules (permutation-prize lib.rs
 * `provisional::RULES`), as a compatibility check of the legacy season-end path only. */
const LEGACY_PRIZE = Object.freeze({
  kind: 'legacy-season-end',
  winner: 'most keeps held when the season has ended (decided in the code)',
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
  { id: 'P-scout', kind: 'scout', label: '物見櫓の目撃が、他の人に使われた（目撃の記録の出どころは今ない。⑭の塔は目撃をしない）' },
  { id: 'P-board-helper', kind: 'board_helper', label: '他国の人の掲示の依頼に応え、交換が双方に届いた（⑭の塔の案 B。模型の事実だけなら数えない）' },
]);

/** What carries on past any window's close, in every variant: the world has no end. */
const CONTINUES = ['村・土地・建物・倉と中身（荷）', '移動中の隊商（次の評価期間に着く）', '未完成の計画とそこに入れた材料', '国の所属と国の設定', '記録・実績・履歴'];
const UNDECIDED = '戦期に何を集計するか、要塞や戦争の状態を戻すか、賞金をどう扱うかは未決定（この評価器は決めない）';

export const RULESETS = Object.freeze({
  A: Object.freeze({
    id: 'A-baseline-competitive', version: 3, variant: 'A', status: 'legacy-compat',
    note: '現行コードの勝ち方だけ（旧経路の互換確認）。目標は判定しない',
    costs: S1_COSTS, prize: LEGACY_PRIZE,
    joint: [], national: null, personal: [],
    close: { kind: 'schedule' },
    scope: { ends: ['旧経路の確認として、評価期間の終わりに要塞の数で勝者を読む（現行プログラムは Season を Ended にして Tally・Finalize する。新しい世界を終える根拠にはしない）'], continues: CONTINUES },
    slotBy: 'cluster',
  }),
  B: Object.freeze({
    id: 'B-separate-tracks', version: 3, variant: 'B', status: 'comparison-only',
    note: '共同・国・個人を別々に判定。共同達成では評価期間も世界も閉じない',
    costs: S1_COSTS, prize: null,
    joint: [JOINT_NORTH_FORT], national: NATIONAL, personal: PERSONAL,
    close: { kind: 'schedule' },
    scope: { ends: ['この評価期間の目標の判定（与えられた期間の終わりで）', UNDECIDED], continues: CONTINUES },
    slotBy: 'cluster',
    carryInputs: true,
  }),
  C: Object.freeze({
    id: 'C-joint-window', version: 3, variant: 'C', status: 'comparison-only',
    note: '比較案（未採用）：共同達成（利用まで）が成立すると、予告の後にこの評価期間だけを閉じる。世界は閉じない',
    costs: S1_COSTS, prize: null,
    joint: [JOINT_NORTH_FORT], national: NATIONAL, personal: PERSONAL,
    close: { kind: 'joint-window', goal: 'J-north-fort', noticeBells: 24 },
    scope: { ends: ['この評価期間の目標の判定（共同達成から予告の鐘数の後。与えられた期間の終わりより遅くはならない）', '閉じた後、与えられた期間の残りはどの評価期間でも判定しない（報告する）', UNDECIDED], continues: [...CONTINUES, '完成した共同の建物'] },
    slotBy: 'cluster',
    carryInputs: true,
  }),
});
