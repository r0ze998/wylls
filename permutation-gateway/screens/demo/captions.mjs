// Captions of the play-flow recording (record-playflow.mjs), one per step,
// in Japanese and in English. The wording follows the game's own terms
// (lang/en-frontier.mjs; docs/frontier/SUMMARY.ja.md): holding, host, bell,
// march, explore, the sealed destination, the clash report and "verify in
// this browser".

export const STEPS = ['join', 'site', 'holding', 'build', 'scout', 'march', 'bell', 'report', 'verify'];

export const CAPTIONS = {
  ja: {
    kicker: '六重の辺境 · 1人のプレイヤーの流れ',
    intro: {
      title: '六重の辺境',
      sub: '六つの陣営が一つの辺境を奪い合う、封をした進軍と10分ごとの鐘のゲーム。',
      small: 'ローカルのチェーン（時計 20 倍）· 開発用ウォレット · 新しい地図と HUD',
    },
    join: { title: '参加：ウォレットをつなぐ', body: 'ウォレットが署名するのは参加の1回だけ。以後の行動はこの端末のゲーム内の鍵が署名し、手数料はリレーが払います。' },
    site: { title: '陣営と入植地を選ぶ', body: '陣営を選んで参加し、本拠の扇区の州から空いた区画を最大3つ、希望順に選んで入植希望を出します。' },
    holding: { title: '最初の拠点', body: '入植希望は次の鐘の種で抽選され、拠点が届きます。地図は自分の拠点へ移動し、左の欄に拠点が並びます。' },
    build: { title: '建てる', body: '拠点で最初の建物を建てます。資源は鐘ごとに入り、建物が拠点を育てます。' },
    scout: { title: '偵察：斥候を出す', body: '斥候を訓練して軍勢に編成し、周りのマスを探索させます。見えるものが増え、行き先を選べるようになります。' },
    march: { title: '封をした進軍', body: '槍兵の軍勢で蛮族の野営地へ。行き先は封の中にあり、ほかの人には到着の鐘しか見えません。' },
    bell: { title: '鐘が鳴る', body: '到着の鐘でビーコンが記録され、封が開き、衝突がその鐘のうちに決着します。' },
    report: { title: '衝突の報告', body: '誰が・どれだけ・どの構えで戦い、何が残ったか。報告は誰でも読めます。' },
    verify: { title: 'このブラウザで確かめる', body: 'このブラウザが同じルールで衝突を計算し直し、チェーンに記録された結果と一致するかを確かめます。' },
    outro: { title: '確かめられました', sub: '参加 → 入植 → 建設 → 偵察 → 封をした進軍 → 鐘 → 報告 → 検証', small: '六重の辺境 — PERMUTATION STATE' },
    waitBell: '次の鐘を待っています',
    waitHolding: '入植の抽選（次の鐘の種）を待っています',
    waitHost: '新しい軍勢が次の鐘で名簿に加わるのを待っています',
    waitArrival: b => `到着の鐘（第${b}鐘）を待っています`,
    waitReport: '衝突の決着と報告を待っています',
    waitVerify: 'ブラウザの中で衝突を計算し直しています',
    waitJoin: '参加の記録を待っています',
    fast: '待ち時間（早送り）',
  },
  en: {
    kicker: 'The Sixfold Frontier · one player’s play flow',
    intro: {
      title: 'The Sixfold Frontier',
      sub: 'Six factions contest one frontier with sealed marches and a bell every ten minutes.',
      small: 'Local chain (clock at 20×) · dev wallet · the new map and HUD',
    },
    join: { title: 'Join: connect a wallet', body: 'Your wallet signs only to join. Play actions are signed by an in-game key on this device, and the relay pays the fees.' },
    site: { title: 'Choose a faction and a site', body: 'Pick a faction and join, then pick up to three free sites in a province of your home wedge, in order of preference, and file the ticket.' },
    holding: { title: 'The first holding', body: 'The ticket is drawn with the next bell’s seed and the holding arrives. The map flies to it and the left rail lists it.' },
    build: { title: 'Build', body: 'The first building on the holding. Resources come in every bell, and buildings grow the holding.' },
    scout: { title: 'Scout and explore', body: 'Train scouts, muster them into a host and send it to explore the tiles around: you see more, and can pick where to march.' },
    march: { title: 'A sealed march', body: 'A host of spearmen marches on a barbarian camp. The destination is sealed: everyone else sees only the arrival bell.' },
    bell: { title: 'The bell', body: 'At the arrival bell the beacon is recorded, the seal opens and the clash resolves within that bell.' },
    report: { title: 'The clash report', body: 'Who fought, with how many, in which stance, and what was left. Anyone can read a report.' },
    verify: { title: 'Verify in this browser', body: 'This browser recomputes the clash with the same rules and checks it matches the result recorded on the chain.' },
    outro: { title: 'Verified', sub: 'Join → site → build → scout → sealed march → bell → report → verify', small: 'The Sixfold Frontier — PERMUTATION STATE' },
    waitBell: 'Waiting for the next bell',
    waitHolding: 'Waiting for the draw (the next bell’s seed)',
    waitHost: 'Waiting for the new host to join the roster at the next bell',
    waitArrival: b => `Waiting for the arrival bell (bell ${b})`,
    waitReport: 'Waiting for the clash to resolve and its report',
    waitVerify: 'Recomputing the clash in this browser',
    waitJoin: 'Waiting for the join to land',
    fast: 'Waiting (fast-forward)',
  },
};
