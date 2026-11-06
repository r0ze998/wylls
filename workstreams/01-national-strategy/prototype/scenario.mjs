// 国の卓の試作：作例「国境の共同拠点を準備する」の初期状態と台本。
//
// 数字の扱い：
//   - 建物の費用と兵器の訓練費、工房の産出、投票の定足数は、基準 commit 4cd901d の
//     S1 のルール（permutation-rules）から写した［事実］。出典は各行のコメント。
//   - 手持ち、移動ターン、期限、建設にかかるターン、投票の締め切りの短縮は、
//     試作のための仮の値［仮］。フェーズ6の数字ではない。
// 人物は架空。ユキ・リオ・レンは「台本で動く仲間」で、AI ではない。

/** 1ターン＝10分（nation.rs のコメント「10-minute bells」）。 */
export const MINUTES_PER_TURN = 10;

/** 資源の表示名。キーは model.mjs と共通。 */
export const RESOURCES = Object.freeze({
  food: '食料', wood: '木材', stone: '石材', ore: '鉱石', arms: '兵器', gold: '金',
});

/** 建物の費用［事実：docs/frontier/stage1e/S1-1E-CONTRACT.md 2.3、caravan.rs VAULT_COST］。 */
export const BUILD_COST = Object.freeze({
  砦: { wood: 500, stone: 800, arms: 50, gold: 200 },
  見張り塔: { wood: 300, stone: 400, arms: 20, gold: 100 },
  倉: { wood: 200, stone: 200, gold: 50 },
});
/** 一人が持てる数［事実：同 2.3 の Per citizen、caravan.rs MAX_VAULTS］。 */
export const BUILD_LIMIT = Object.freeze({ 砦: 1, 見張り塔: 2, 倉: 3, 工房: 99 });
/** 建て終わるまでのターン［仮］。 */
export const BUILD_TURNS = Object.freeze({ 砦: 6, 見張り塔: 4, 倉: 3 });

/** 長槍兵100人の訓練に要る兵器［事実：arms.rs TRAIN_ARMS_PER_100 の Pikeman＝50］。 */
export const ARMS_PER_100_PIKEMEN = 50;
/** 槍兵（守備兵）1人の訓練に要る食料［仮］。槍兵は兵器を使わない［事実：TRAIN_ARMS_PER_100 の先頭3つは0］。 */
export const FOOD_PER_SPEARMAN = 1;

/** 倉の上限［事実：caravan.rs VAULT_CAP＝5000（千分の一単位で 5_000*1_000）。上限を超えて届いた分は失われる：S1-1B 契約 3.4］。 */
export const VAULT_CAP = 5000;
/** 護衛が待ち構えるターン数。過ぎたら持ち主の村へ戻り始める［仮］。 */
export const ESCORT_TURNS = 12;

/** 投票［事実：nation.rs QUORUM=3、passes = yes>no && yes>=QUORUM、WINDOW_BELLS=144］。 */
export const QUORUM = 3;
export const REAL_VOTE_WINDOW_TURNS = 144;
/** 試作では締め切りを短くする［仮］。 */
export const VOTE_WINDOW_TURNS = 6;

/** C案（試遊の仮説）の採択に要る、賛同した「判断する人」の数［仮。QUORUM にそろえた］。正式な意思決定ではない。 */
export const ADOPT_COSIGNERS = 3;
/** 採択されない提案が消えるまで［仮］。 */
export const PROPOSAL_EXPIRES_TURNS = 36;
/** 最後の行動からこのターン数たつと、卓に「不在の可能性」と出す［仮］。 */
export const ABSENT_TURNS = 6;
/** 偵察の知らせが「新しい」と言える間［仮］。 */
export const SCOUT_FRESH_TURNS = 12;

/** 場所。v:<人> は村。site は拠点（北の峠の手前）、pass は峠。 */
export const PLACES = Object.freeze({
  'v:kei': 'ケイの村「白樺」（国境）',
  'v:mira': 'ミラの村「鉄床」（丘）',
  'v:sota': 'ソウタの村「麦原」（平地）',
  'v:haru': 'ハルの村「渡し」（川）',
  'v:yuki': 'ユキの村「港町」（東）',
  site: '拠点（北の峠の手前）',
  pass: '北の峠',
});

/** 荷車の移動ターン［仮。実際は道と地形で決まる：caravan.rs fastest_path］。 */
const TRAVEL = {
  'v:mira|v:kei': 9, 'v:mira|site': 10, 'v:mira|v:haru': 5, 'v:mira|v:sota': 7, 'v:mira|v:yuki': 8,
  'v:sota|v:kei': 12, 'v:sota|site': 12, 'v:sota|v:haru': 6, 'v:sota|v:yuki': 6,
  'v:haru|v:kei': 7, 'v:haru|site': 8, 'v:haru|v:yuki': 5,
  'v:kei|site': 2, 'v:kei|pass': 3, 'site|pass': 2, 'v:kei|v:yuki': 14,
  'v:mira|pass': 11, 'v:sota|pass': 14, 'v:haru|pass': 10, 'v:yuki|pass': 16, 'v:yuki|site': 15,
};
export function travelTurns(from, to) {
  if (from === to) return 0;
  return TRAVEL[`${from}|${to}`] ?? TRAVEL[`${to}|${from}`] ?? 10;
}

/**
 * 試作で操作できる人と、台本で動く仲間。
 * controller は「誰の判断で動くか」。試遊の仮説として、賛同は村の数ではなく controller の数で数える
 * （同じ人が動かす複数の村や、同じ運営者が動かす台本・AI を、独立した意思として数えないため）。
 * 本物の S1 では、ウォレットや村の数から controller は分からない。だから採択は正式な意思決定にしない。
 */
export const MEMBERS = [
  { id: 'kei', name: 'ケイ', home: 'v:kei', playable: true, kind: 'human', controller: 'p-kei', note: '国境の村。北の国の軍が最初に来る場所に住む' },
  { id: 'mira', name: 'ミラ', home: 'v:mira', playable: true, kind: 'human', controller: 'p-mira', note: '丘の村。鉱石と工房がある' },
  { id: 'sota', name: 'ソウタ', home: 'v:sota', playable: true, kind: 'human', controller: 'p-sota', note: '平地の村。食料が多く、倉と荷車をよく使う' },
  { id: 'haru', name: 'ハル', home: 'v:haru', playable: true, kind: 'human', controller: 'p-haru', note: '川の村。工房を持つが、ふだんは自分の村を育てている' },
  { id: 'yuki', name: 'ユキ', home: 'v:yuki', playable: false, kind: 'script', controller: 'operator', note: '東の港町。北の国との交易を望む（台本で動く）' },
  { id: 'rio', name: 'リオ', home: 'v:yuki', playable: false, kind: 'script', controller: 'operator', note: 'ユキの近く（台本で動く）' },
  { id: 'ren', name: 'レン', home: 'v:yuki', playable: false, kind: 'script', controller: 'operator', note: 'ユキの近く（台本で動く）' },
];

/** 各人の村の在庫［仮］。 */
const STOCK = {
  kei: { food: 300, wood: 700, stone: 300, ore: 0, arms: 0, gold: 300 },
  mira: { food: 150, wood: 400, stone: 900, ore: 400, arms: 40, gold: 150 },
  sota: { food: 1200, wood: 600, stone: 300, ore: 0, arms: 0, gold: 150 },
  haru: { food: 500, wood: 500, stone: 500, ore: 20, arms: 10, gold: 200 },
  yuki: { food: 400, wood: 300, stone: 200, ore: 0, arms: 30, gold: 300 },
  rio: { food: 200, wood: 200, stone: 200, ore: 0, arms: 0, gold: 100 },
  ren: { food: 200, wood: 200, stone: 200, ore: 0, arms: 0, gold: 100 },
};
/** 予備の槍兵［仮］。 */
const RESERVE = { kei: 220, mira: 60, sota: 40, haru: 80, yuki: 50, rio: 30, ren: 30 };

/**
 * 工房［事実：arms.rs 工房1基＝毎時 鉱石8・木材4 → 兵器4、ORE_PER_ARM=2、WOOD_PER_ARM=1］。
 * 1ターン＝10分なので、1基は1ターンに約0.67。試作では整数に丸めて「1ターンに何個」で持つ［仮］。
 */
const FACILITIES = [
  { id: 'ws-mira', kind: '工房', owner: 'mira', at: 'v:mira', copies: 3, perTurn: 2 },
  { id: 'ws-haru', kind: '工房', owner: 'haru', at: 'v:haru', copies: 2, perTurn: 1 },
];

/** 作例の共同目標（ケイの提案）。必要なものは、それぞれ誰が満たせるかが違う。 */
export const OUTPOST_GOAL = {
  id: 'outpost',
  title: '国境の共同拠点を準備する',
  purpose: '北の峠から入る北の国の軍と荷車を止め、峠の向こうの鉱脈へ出る足場にする',
  site: 'site',
  proposer: 'kei',
  deadlineIn: 48,
  requiresStance: { north: 'war' },
  needs: [
    { id: 'stone', kind: 'deliver', resource: 'stone', qty: 500, to: { kind: 'village', member: 'kei' },
      use: '砦の材料。ケイの手持ち300と合わせて、砦の石材800になる', usedBy: 'kei', input: true },
    { id: 'arms', kind: 'deliver', resource: 'arms', qty: 50, to: { kind: 'village', member: 'kei' },
      use: '砦の兵器50', usedBy: 'kei', input: true },
    { id: 'vault', kind: 'build', building: '倉', at: 'site',
      use: '前線の倉。守備兵の食料をためる' },
    { id: 'food', kind: 'deliver', resource: 'food', qty: 400, to: { kind: 'vault-at', at: 'site' },
      use: '守備兵の食料。倉の持ち主が、必要なときに砦の持ち主へ送る', usedBy: 'vault-owner', consumer: 'kei' },
    { id: 'fort', kind: 'build', building: '砦', at: 'site',
      use: '北の国の軍と、拠点の荷車を守る' },
    { id: 'garrison', kind: 'garrison', qty: 300,
      use: '砦の守備兵。S1 では、砦に兵を置けるのは砦の持ち主だけ（FortGarrison）' },
    { id: 'watch', kind: 'watch', at: 'pass',
      use: '峠の様子を知る。峠の見張り塔か、新しい偵察の知らせのどちらかで満たす' },
    { id: 'escort', kind: 'escort', optional: true,
      use: '拠点へ向かう荷車の護衛。封じた進軍なので、卓には件数だけを出す' },
  ],
  /** 縮小案（方針変更で使う）［仮］。 */
  shrink: { food: 250, garrison: 200, watchOptional: true },
};

/** 競合する目標（「方針の対立」の出来事で出る）。 */
export const RIVAL_GOAL = {
  id: 'eastsiege',
  title: '東の砦攻めの兵器を集める',
  purpose: '東の国の砦を包囲する。包囲の宣言には兵器50を使い切る（arms.rs SIEGE_ARMS）',
  site: 'v:yuki',
  proposer: 'yuki',
  deadlineIn: 40,
  requiresStance: {},
  needs: [
    { id: 'arms', kind: 'deliver', resource: 'arms', qty: 120, to: { kind: 'village', member: 'yuki' },
      use: '包囲の兵器50と、長槍兵140人の訓練70', usedBy: 'yuki' },
  ],
};

/**
 * 協力したときの、その人自身の得［仮の場面設定。報酬や通貨ではなく、ゲームの中で起きること］。
 * 自給を選んだときに得られないもの・それでも得られるもの（ただ乗り）も書く。
 */
export const BENEFITS = {
  kei: {
    join: '自分の村が国境にある。砦が建てば、北の国の軍は先に砦とぶつかる。自分の村の壁だけで受けるより損が小さい',
    alone: '一人では砦の石材と兵器が足りない。自分の村の壁を厚くするだけなら一人でできるが、峠は通られる',
  },
  mira: {
    join: '峠の向こうの鉱脈へ出る道が、砦の後ろを通るようになる。自分の鉱石の荷車が襲われにくくなる',
    alone: '兵器を自分の長槍兵に回せる。ただし峠の向こうの鉱脈へは、護衛なしで行くことになる',
  },
  sota: {
    join: '拠点の倉は自分の物のまま。前線で食料を求める人（砦の持ち主など）との受け渡しの場所になる',
    alone: '食料は自分の村で使える。ただし前線の受け渡しの場所を、他の誰かが押さえるかもしれない',
  },
  haru: {
    join: '砦ができれば、渡しの村も北から攻められにくくなる。少しだけ手伝えば、記録に「応じた」が残る',
    alone: '砦ができれば、手伝わなくても守りの得は受ける（ただ乗り）。記録には何も残らない',
  },
};

/** 初期の世界。model.mjs の createWorld が深く写して使う。 */
export function initialWorld() {
  return {
    turn: 0,
    nation: { id: 'west', name: '西の国', stance: { north: 'war', east: 'war' } },
    stanceNames: { north: '北の国', east: '東の国' },
    members: Object.fromEntries(MEMBERS.map(m => [m.id, {
      ...m, present: true, lastActive: 0, inNation: true, expelled: false,
    }])),
    stock: structuredClone(STOCK),
    reserve: { ...RESERVE },
    facilities: Object.fromEntries(FACILITIES.map(f => [f.id, {
      ...f, status: '稼働', contents: {}, troops: 0, readyAt: 0, gen: 0,
    }])),
    goals: {},
    pledges: {},
    shipments: {},
    requests: {},
    votes: {},
    marches: {},
    scouts: [],
    declined: {},
    log: [],
    seq: 1,
  };
}
