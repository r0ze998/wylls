// 国際供給網の作例（2026-10-30）：A国の採掘者・B国の工房の持ち主・C国の中継役が、
// それぞれ自分の得のために組み、届いた物を実際に使う。配置は固定（初期配置 B 型の一つの地域）。
//
// 数字：村の昇格（村→町：木材1000・石材600・金300、36ターン）、工房の費用（食料60・木材120・石材80・鉱石40）、
// 長槍兵の兵器（100人あたり50）、工房の比率（鉱石2で兵器1）は S1 の事実［事実：catalog.rs tier_up、arms.rs］。
// 手持ち・移動ターン・共同成果の基準は仮［仮］。人物は架空。

export const SUPPLY_PLACES = {
  'v:nagi': 'ナギの村「黒岩」（A国・鉱山）',
  'v:tou': 'トウの村「炉辺」（B国・工房）',
  'v:rin': 'リンの村「渡り場」（C国・中継の倉）',
  'v:sena': 'セナの村「遠見」（A国・工房、遠い）',
  'v:kai': 'カイの村「北谷」（B国・鉱石、遠い）',
};

/** 国（国籍）。参加を強制も禁止もしない。表示と、共同成果の「何か国にまたがるか」にだけ使う。 */
export const SUPPLY_NATIONS = { A: 'A国（アステル）', B: 'B国（シンダー）', C: 'C国（ボレアリス）' };

export const SUPPLY_MEMBERS = [
  { id: 'nagi', name: 'ナギ', home: 'v:nagi', nation: 'A', controller: 'p-nagi', role: '採掘者',
    note: '鉱石と石材が多い。木材が足りず、村を町にできない' },
  { id: 'tou', name: 'トウ', home: 'v:tou', nation: 'B', controller: 'p-tou', role: '工房の持ち主',
    note: '工房2基と木材の山。鉱石が足りず、工房を増やせない' },
  { id: 'rin', name: 'リン', home: 'v:rin', nation: 'C', controller: 'p-rin', role: '中継役',
    note: 'ナギとトウの間の渡り場に住む。木材と食料をためている。兵器がない。C国は隊商が速い（S1：×0.8）' },
  { id: 'sena', name: 'セナ', home: 'v:sena', nation: 'A', controller: 'p-sena', role: '遠くの同国（工房）',
    note: 'ナギと同じA国だが遠い。工房1基' },
  { id: 'kai', name: 'カイ', home: 'v:kai', nation: 'B', controller: 'p-kai', role: '遠くの同国（鉱石）',
    note: 'トウと同じB国だが遠い。鉱石がある' },
];

/**
 * 移動ターン［仮］。固定の配置：ナギとトウは峠を挟んで直接だと12ターン（襲われやすい道）。
 * リンの渡り場を通ると5＋5。遠くの同国（セナ・カイ）は10以上。
 */
export const SUPPLY_TRAVEL = {
  'v:nagi|v:tou': 12, 'v:nagi|v:rin': 5, 'v:rin|v:tou': 5,
  'v:nagi|v:sena': 11, 'v:sena|v:tou': 14, 'v:rin|v:sena': 12,
  'v:kai|v:tou': 10, 'v:kai|v:nagi': 15, 'v:kai|v:rin': 12, 'v:kai|v:sena': 18,
};

export const SUPPLY_STOCK = {
  nagi: { food: 400, wood: 300, stone: 800, ore: 900, arms: 0, gold: 400 },
  tou: { food: 500, wood: 2000, stone: 400, ore: 40, arms: 30, gold: 200 },
  rin: { food: 800, wood: 800, stone: 300, ore: 0, arms: 0, gold: 200 },
  sena: { food: 300, wood: 300, stone: 300, ore: 100, arms: 20, gold: 200 },
  kai: { food: 300, wood: 200, stone: 200, ore: 500, arms: 0, gold: 100 },
};
export const SUPPLY_RESERVE = { nagi: 40, tou: 60, rin: 100, sena: 40, kai: 40 };
export const SUPPLY_FACILITIES = [
  { id: 'ws-tou', kind: '工房', owner: 'tou', at: 'v:tou', copies: 2, perTurn: 1 },
  { id: 'ws-sena', kind: '工房', owner: 'sena', at: 'v:sena', copies: 1, perTurn: 1 },
];

/** 各人の目標（個人の評価）。どれも本人の状態で判定し、取引の回数や送った量では判定しない。 */
export const PERSONAL_GOALS = {
  nagi: { kind: 'tier', tier: '町', text: '村を町にする（生産 +50%：catalog.rs tier_bonus_pct）', military: false },
  tou: { kind: 'workshops', copies: 4, text: '工房を4基にする', military: false },
  rin: { kind: 'trained', n: 100, text: '長槍兵100を訓練して、渡り場を守る', military: true },
  sena: { kind: 'none', text: '（作例では、頼まれたら応じるかを決める役）', military: false },
  kai: { kind: 'none', text: '（作例では、頼まれたら応じるかを決める役）', military: false },
};

/** 国の目標（国の評価）。個人の目標と衝突しうる。国は持ち主の物を動かせない。 */
export const NATION_GOALS = {
  A: { text: 'A国：東の砦攻めのために兵器100を集める', wants: { res: 'arms', qty: 100 }, asks: ['nagi', 'sena'] },
  B: { text: 'B国：鉱石を他国に頼らない（B国の鉱石でB国の工房を回す）', prefers: 'kai', asks: ['tou'] },
  C: { text: 'C国：渡り場を交易の要所にする（構えは「通行を許す」が望ましい）', asks: ['rin'] },
};

/**
 * 共同成果（試作の基準［仮］）：「三国の交易路が使われる」。
 * 他の人から届いて（④で確定した到着だけ）、受け取った人が実際に使った（建設・昇格・訓練に消費した）量を
 * 人ごとに数え、その量が perPerson 以上の人が、nations か国以上・people 人以上いること。
 */
export const JOINT = { perPerson: 50, nations: 3, people: 3, deadline: 96 };

/** 申し出の見本（判断の選択肢として出す）。どれも②の範囲（素材と生産済みの兵器の交換）。 */
export const DEAL_TEMPLATES = [
  { from: 'nagi', to: 'tou', give: { res: 'ore', qty: 120 }, want: { res: 'arms', qty: 30 },
    why: 'トウは鉱石が欲しい。手元の兵器30なら今すぐ渡せる（もっと欲しければ、鉱石が届いてから作る）' },
  { from: 'nagi', to: 'rin', give: { res: 'arms', qty: 30 }, want: { res: 'wood', qty: 700 },
    why: 'リンは兵器が欲しく、木材をためている。兵器はトウとの交換で手に入れてから' },
  { from: 'tou', to: 'kai', give: { res: 'arms', qty: 20 }, want: { res: 'ore', qty: 200 },
    why: '同じB国のカイから鉱石を得る（遠い。B国の目標に沿う）' },
  { from: 'rin', to: 'tou', give: { res: 'food', qty: 200 }, want: { res: 'arms', qty: 20 },
    why: 'リンがトウから直接兵器を得る（ナギを通さない）' },
  { from: 'rin', to: 'sena', give: { res: 'wood', qty: 100 }, want: { res: 'arms', qty: 20 },
    why: '遠いセナの工房から兵器を少し得る' },
];

/**
 * ②の交換権では扱えない（未実装の契約が要る）取引。判断の中では閉じた選択肢として、理由つきで出す。
 */
export const CLOSED_DEALS = [
  { who: ['nagi', 'tou'], label: '鉱石と木材を直接交換する', reason: '素材どうしの交換は、②の試作（素材と生産済み武具の交換権）の範囲外。両方の持ち主が同時に受け渡す契約が要る' },
  { who: ['nagi', 'sena'], label: 'セナの工房を借りて、自分の鉱石で兵器を作る', reason: '加工能力の貸出は②の試作にない（交換権であって貸出ではない）。施設の使用権の契約が要る' },
  { who: ['tou', 'rin'], label: 'リンに木材を預けて、持ち主のまま運んでもらう', reason: '所有を移さない輸送（預かり）は未実装。今の S1 では、運んでもらうには相手に贈る（相手の物になる）しかない' },
  { who: ['nagi', 'rin'], label: '「木材が届いたら兵器を払う」という条件つきの支払い', reason: '到着を条件にした支払いは未実装の契約。④の到着の確定とつなぐ必要がある' },
];
