// The play screen's English for the entries added in canonical rounds 33–49 (git log 427c4963^..68e8548d --
// permutation-server/web/lang) and the land preview (git diff 68e8548d..7fc09e28 -- web/lang, frontier/land.mjs,
// frontier/map/landmarks.mjs), checked against GLOSSARY.md's Frontier section and the banned words of the play screen:
//  - every listed key has an English entry in the dictionary named, and the same English in every dictionary that has it;
//  - no Japanese, no curly apostrophes, no "tick", "bell", "settle(ment)", "keeper", "beacon", "seed", "secret",
//    "site ticket", "lamport" (web-frontier-cards.test.mjs BANNED_EN, plus the time-step guard);
//  - British spelling (GLOSSARY.md Style: the Frontier client);
//  - the glossary's word for each game term the Japanese uses (ターン → turn, 軍勢 → host, 封 → seal, …);
//  - punctuation: 「X」 → “X”, 〜 → –.
// What a test cannot read — that the English claims nothing the Japanese does not — was read by hand; each entry found
// wrong is in docs/integration/CLAUDE-LANE-D-ENGLISH-AUDIT-20261116.md with its proposed English, and is a test.todo
// below naming that entry (the todo asserts the proposed English, so it passes once the dictionary takes it).
// Left out on purpose: the expedition return's lines (fexpedition-return.mjs, completeness (b)/(c) of
// web-lang.test.mjs, an owner's open design call) and the resident lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lang from '../../permutation-server/web/lang.mjs';

const { EN, EN_GROUPS } = lang;
const JP = /[぀-ヿ㐀-鿿＀-￯]/;

/** The audited keys by the dictionary that holds them (lang/en-<group>.mjs). */
const KEYS = {
  'frontier-hand': [
    // round 34 (8e385098): the return's preparation check, hud/hand.mjs
    '署名前の準備確認',
    '実験用の準備確認',
    '署名前の内容を取り直して確認します。署名・支払い・送信は行いません。',
    '署名前の準備内容を確認',
    '準備内容を確認できません',
    '署名前の内容を照合しました',
    '実験用の未署名データです。実行できることや帰還の完了を確認した結果ではありません。',
    '今回の記録のスロット',
    '有効期限の観測時点で残るブロック高',
    '有効期限は時間とともに変わります。必要なときに取り直してください。',
    '準備内容の詳細',
    // round 36 (3a85aa9c)
    '軍勢: {0}',
    // rounds 37/38/40 (37a3019a, 2721acd3, 701a7608): 精算 / "settle" off the play screen
    '結果は、探索したターンの決着のあとに出ます。',
    '結果は、探索したターンの決着のあとに出ます',
    'いまは納めるものがありません（命令のたびに蔵は納められます）。蔵は毎時 +{0} 増えています',
    'あなたの包囲は必要なターンを満たし、占領の結果を受け取るのを待っています（ターン {0} 以降・宣言はターン {1}・場所 {2}）。都市はまだあなたのものではありません。',
    'この都市では、別のプレイヤーの包囲が占領の結果を待っています。',
    '別の軍勢またはウォレットで送った包囲の結果が、まだ確定していません。その軍勢のカードで結果を照合してください。',
    '預けた資源：返却待ちです。返却先の拠点がもうありません。返却の債務として残っており、まだ結果を受け取っていません。いつ、どこへ戻るかはまだ決まっていません。',
    '返却と解放は、包囲の結果を受け取ったときに反映されます。自動で行われるとは限りません。',
    '戻るのは包囲の結果を受け取ったときで、それまでは「返却待ち」と表示します。',
    '預けた資源：返却待ちです。返却の債務として残っており、まだ結果を受け取っていません。',
    // round 2 of this audit (candidate aa12ce74): the walls' queue refusal, hud/orderparts.mjs
    '城壁の工事は 2 つ先までです。前の工事が仕上がり、そのターンが決着してからです',
  ],
  'frontier-play': [
    // round 36 (3a85aa9c): the clash report's recompute
    '照合しています…',
    // round 33 (427c4963): the march card's ready-again estimate
    '見込み（今出発し、軍勢が残り、ほかの戦いがない場合）：次はターン {0} から。到着で戦った場合は遅くともターン {1} から',
    // round 40 (701a7608): "by itself" and the keeper off the play screen
    '世界は同時に2つまでです。どの世界も、開始サービスで決めた時間（開始後に終了時刻を表示します）がたつと自動的に終わり、その進行は保存されません。上限のときは、終了する世界を自分で選びます（勝手には止めません）。',
    '自動終了の予定時刻は、このページでは確認できません。開始サービスで決めた時間で終わります。',
    'この世界は {0} ごろに自動的に終わります（開始サービスが決めた時刻。この端末の時計で表示）。',
    '世界の進行役は動いています（ターン {0} まで処理済み）。',
    '世界の進行役は動いています。',
    '世界の進行役は、次の処理を待っています（ターン {0} まで処理済み）。編成や進軍は、処理が進むと反映されます。',
    '世界の進行役は、次の処理を待っています。編成や進軍は、処理が進むと反映されます。',
    '世界の進行役は止まりました。この世界のターンはもう進まず、編成中の軍勢も進軍も進みません。',
    '世界の進行役は、送った処理の結果を確かめられず止まりました（同じ処理は再送しません）。この世界のターンはもう進みません。',
    '世界の進行役は動いていますが、到着地または滞在先の処理の一つは、送った結果を確かめられず止まりました（再送しません）。その処理はもう進みません。',
    '世界の進行役は動いていますが、到着地または滞在先の処理の一つは拒否されて止まりました。その処理はもう進みません。',
    '世界の進行役の報告はまだありません。少し待ってから、もう一度確認してください。',
    // the land preview (7a514f20 and before): the strip's chip and the selected tile, frontier/land.mjs
    '村の耕地（テスト用の世界）：この村の州で軍勢が立って広げたマスと、その分の生産の上乗せです。自分の領土（広い土地で取るマス）とは別のものです。',
    'この州の耕地 {0} マス · 生産 +{1}%',
    'どの国の土地でもない空き地（領土の試験）',
    'あなたの国の村の土地（領土の試験）',
    '{0}の村の土地（領土の試験）',
    'あなたの国が持つ土地（領土の試験）',
    '{0}が持つ土地（領土の試験）',
    'あなたの国が奪取中：{0} / {1} ターン',
    '{0}が奪取中：{1} / {2} ターン',
    '国の土地から切り離され減っています：{0} / {1} ターン',
    // round 2 of this audit (candidate aa12ce74): the land chip's other provinces, the fort and garrison checks, the walls,
    // the scout muster's line (frontier/land.mjs, screens/s1.mjs, screens/holding.mjs, hud/orderparts.mjs, screens/onboarding.mjs)
    'ほかの州 {0} マス',
    '（毎時 +{0}）',
    '地図で読み込んだほかの州だけを数えます（テスト用の世界）。地図を動かすと変わることがあります。',
    'この要塞にはあと {0} 人まで入れられます',
    '要塞を選んでください',
    'この村はもう追放されています（国に戻す提案は、追放された村の一覧から出せます）。',
    '入れる人数が範囲の外です',
    'この要塞には、それだけ入る空きがありません',
    '入れる人数は 1 から {0} までです',
    '守備隊にはあと {0} 人まで入れられます',
    '増やす人数は 1 以上の整数です',
    '守備隊には、それだけ入る空きがありません',
    '訓練した斥候を一つの隊にまとめましょう。このターンが終わり、封が開けられてターンが決着すると整列します。待つあいだも村の建設を進められます。',
  ],
  frontier: [
    // round 36 (3a85aa9c)
    '観測のスロット',
    '{0}はもう使えません',
    'この軍勢',
    // round 39 (37a3019a): local play, the test wallet and the relay's refusals, fi18n.mjs CLIENT_TEXT
    '要求が終わる前に取り消されました。もう一度試してください。',
    'この命令はローカルプレイでは送れません。',
    '命令は送りましたが、結果をまだ確認できません。あとで状態を確かめます。',
    '命令の対象が、確かめたあとで変わりました。いまの状態を確かめてください。',
    '命令の内容の形が正しくありません。送っていません。',
    'この軍勢の進軍は、いまローカルプレイでは送れません。',
    'この軍勢には、その手順がありません。',
    'この軍勢の別の手順が進んでいます。その結果を待ってください。',
    'この封はすでに開けられています。',
    '封を開けるのに必要な記録の状態を読めませんでした。',
    'ローカルプレイのサーバーの答えを読めませんでした。',
    'ウォレットが署名した取引を読めなかったため、送っていません。',
    '都市の包囲の記録を読めませんでした。',
    '記録の配信元に接続できません。',
    'ローカルプレイのプログラムが、このページの使うものと違います。',
    'このテスト用ウォレットはもう消えています。ページを開き直すと新しく作られます。',
    'このブラウザでは、テスト用ウォレットの鍵を作れません。',
    'このテスト用ウォレットのアカウントではありません。',
    'テスト用ウォレットはローカルネットでしか使えません。',
    'この取引の署名者に、テスト用ウォレットが含まれていません。',
    'テスト用ウォレットを知らせるページがありません。',
    'テスト用ウォレットは、ローカルプレイを選んだときだけ使えます。',
    'テスト用ウォレットは、この端末で開いたページでしか使えません。',
    'その道の移動を計算できませんでした。',
    '記録の配信元が、ローカルネットの世界を出していません。',
    'ローカルプレイの世界の版が、このページと合いません。',
    'ローカルプレイの世界を確かめられませんでした。',
    '記録の配信元のアドレスが正しくありません。',
    '起動した世界の種類が、選んだものと違います。',
    '世界の起動が時間内に終わりませんでした。',
    '世界を起動できませんでした。',
    '答えが大きすぎるため、読みませんでした。',
    '道の州の指定が正しくありません（1〜4 州）。',
    'このウォレットはもう使えません。',
    // round 42 (701a7608): the expedition lane's refusals, fi18n.mjs CLIENT_TEXT
    '出発点の選択が変わりました。もう一度選んでください。',
    'そのマスはすでに選ばれています。',
    '道の地形を時間内に読めませんでした。',
    '到着のターンを読み直す間に、カードが変わりました。',
    '到着のターンを読み直せませんでした。',
    '出発の準備の依頼の形が正しくありません。',
    '出発の下書きを作れませんでした。',
    '出発の準備が時間内に終わりませんでした。',
    '出発の準備の間に、選択が変わりました。',
    '出発の準備の答えを読めませんでした。',
    '出発の取引の役割が、決まりと合いません。',
    'このページが使うプログラムの版の記録がありません。',
    '観測が時間内に終わりませんでした。',
    '観測の間に、選択が変わりました。',
    '観測の答えを読めませんでした。',
    '観測の記録の値が正しくありません。',
    '封の中身が、封の約束と一致しません。',
    '世界のネットワークの記録がないため、封を作れません。',
    '世界の時計の値が正しくないため、封を作れません。',
    '到着のターンが正しくありません。',
    '封に使う乱数が正しくありません。',
    '封の処理を始められませんでした。もう一度試してください。',
    // round 43 (7cf55a04): the Hosts tab while the host is on a march, screens/host.mjs
    'あなたの軍勢は進軍に出ています。到着と結果は「進軍」で確かめられます。',
    '進軍を開く',
    // round 48 (de18bf02): the map's tag once the arrival turn has passed, map/hostmarks.mjs
    '軍勢はターン {0} に到着 · 位置を読み込んでいます',
    // loop-play2 B10 (2026-11-18): the hosts the Hosts list does not show because they are on the march, screens/host.mjs
    'ほかに {0} の軍勢が進軍に出ています。到着が読めるまで、この一覧には出ません。到着と結果は「進軍」で確かめられます。',
    '{0}への進軍',
    '進軍中の軍勢',
    '到着しました（ターン {0}）。結果は「進軍」で確かめられます',
    'ターン {0} に到着の予定',
  ],
};
const ALL = Object.entries(KEYS).flatMap(([group, keys]) => keys.map(key => ({ group, key })));

/** Every English an entry can show: a string, or a function called with 1s and with 2s for each placeholder. */
const placeholders = key => new Set([...key.matchAll(/\{(\d+)\}/g)].map(m => m[1])).size;
const outputs = (value, key) => {
  if (typeof value !== 'function') return [value];
  const n = placeholders(key);
  return [value(...Array(n).fill(1)), value(...Array(n).fill(2))];
};

const BANNED_EN = /\bbells?\b|\bticks?\b|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
const AMERICAN = /\b(colors?|colored|centers?|centered|defense|favor\w*|neighbor\w*|honor\w*|labor\w*|behavior\w*|gray|canceled|canceling|traveled|traveling|modeled|license[ds]?|(organ|recogn|real|author|final|initial|synchron|priorit|minim|maxim|optim|categor|summar|apolog|emphas|util|normal|serial)iz\w*)\b/i;

/** The glossary's English (GLOSSARY.md, The Frontier) for each game term the audited Japanese uses. */
const TERMS = [
  ['ターン', /\bturns?\b/i],
  ['軍勢', /\bhosts?\b/i],
  ['進軍', /\bmarch(es)?\b/i],
  ['封', /\bseal/i],
  ['州', /\bprovinces?\b/i],
  ['マス', /\btiles?\b/i],
  ['村', /\bvillages?\b/i],
  ['国', /\bnations?\b/i],
  ['包囲', /\bsiege/i],
  ['都市', /\bcity\b/i],
  ['決着', /\bresolved?\b/i],
  ['結果を受け取', /\bcollect/i],
  ['世界の進行役', /\bautomatic services\b/i],
  ['ローカルプレイ', /\blocal play\b/i],
  ['テスト用ウォレット', /\btest wallet\b/i],
  ['記録の配信元', /\brecords server\b/i],
  ['端末', /\bdevice\b/i],
  ['署名', /sign/i],
  ['領土の試験', /\bterritory trial\b/i],
  ['土地', /\bland\b/i],
  ['要塞', /\bforts?\b/i],
  ['守備隊', /\bgarrison\b/i],
  ['追放', /\bexpel/i],
];

/** Rules an entry is known to break, with the audit doc's entry (docs/integration/CLAUDE-LANE-D-ENGLISH-AUDIT-20261116.md). */
const KNOWN = {
  // not wrong (the audit doc, ok-2): "readmit" is "take back into the nation" (国に戻す)
  'この村はもう追放されています（国に戻す提案は、追放された村の一覧から出せます）。': { rule: '国', doc: 'ok-2' },
  // not wrong (the audit doc, "ok with a note"): the march card's estimate says "it" for the card's own host
  '見込み（今出発し、軍勢が残り、ほかの戦いがない場合）：次はターン {0} から。到着で戦った場合は遅くともターン {1} から': { rule: '軍勢', doc: 'ok-1' },
};
const known = (key, rule) => KNOWN[key]?.rule === rule;
/** 「X」 that is a tab's name, written without quotes (GLOSSARY.md Style: "or no quotes for a name"). */
const NAMES = { 'あなたの軍勢は進軍に出ています。到着と結果は「進軍」で確かめられます。': /\bMarches\b/,
  'ほかに {0} の軍勢が進軍に出ています。到着が読めるまで、この一覧には出ません。到着と結果は「進軍」で確かめられます。': /\bMarches\b/,
  '到着しました（ターン {0}）。結果は「進軍」で確かめられます': /\bMarches\b/ };

test('the audited keys: each in its dictionary, the same English in every dictionary that has it', () => {
  assert.equal(ALL.length, new Set(ALL.map(e => e.key)).size, 'a key is listed twice');
  assert.ok(ALL.length >= 100, `${ALL.length} keys audited`);
  for (const { group, key } of ALL) {
    assert.ok(Object.hasOwn(EN_GROUPS[group], key), `lang/en-${group}.mjs has no ${JSON.stringify(key)}`);
    const mine = outputs(EN_GROUPS[group][key], key);
    for (const [g, dict] of Object.entries(EN_GROUPS)) {
      if (g === group || !Object.hasOwn(dict, key)) continue;
      assert.deepEqual(outputs(dict[key], key), mine, `${JSON.stringify(key)}: lang/en-${g}.mjs differs from lang/en-${group}.mjs`);
    }
    assert.deepEqual(outputs(EN[key], key), mine, `${JSON.stringify(key)}: the merged dictionary shows other English`);
  }
});

test('the audited English: no Japanese, straight apostrophes, no banned play-screen words, British spelling', () => {
  const bad = [];
  for (const { key } of ALL) {
    for (const out of outputs(EN[key], key)) {
      assert.equal(typeof out, 'string', key);
      if (JP.test(out)) bad.push(`Japanese: ${key} → ${out}`);
      if (/[‘’]/.test(out)) bad.push(`curly apostrophe: ${key} → ${out}`);
      if (BANNED_EN.test(out)) bad.push(`banned word ${out.match(BANNED_EN)[0]}: ${key} → ${out}`);
      if (AMERICAN.test(out)) bad.push(`American spelling ${out.match(AMERICAN)[0]}: ${key} → ${out}`);
      for (const p of out.matchAll(/\{(\d+)\}/g)) if (+p[1] >= placeholders(key)) bad.push(`{${p[1]}} not in the key: ${key}`);
    }
    for (const p of new Set([...key.matchAll(/\{\d+\}/g)].map(m => m[0]))) {
      if (typeof EN[key] === 'string' && !EN[key].includes(p)) bad.push(`drops ${p}: ${key} → ${EN[key]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the audited English: the glossary\'s word for every game term the Japanese uses', () => {
  const bad = [];
  let checked = 0;
  for (const { key } of ALL) {
    for (const [ja, en] of TERMS) {
      if (!key.includes(ja) || known(key, ja)) continue;
      checked++;
      for (const out of outputs(EN[key], key)) if (!en.test(out)) bad.push(`${ja} → ${en}: ${key} → ${out}`);
    }
  }
  assert.ok(checked >= 80, `${checked} term uses checked`);
  assert.deepEqual(bad, []);
});

test('the audited English: 「X」 → “X” (or a name without quotes), 〜 → –', () => {
  const bad = [];
  for (const { key } of ALL) {
    const out = outputs(EN[key], key)[0];
    if (/「[^」]*」/.test(key) && !known(key, '「」')) {
      if (NAMES[key] ? !NAMES[key].test(out) : !/“[^”]*”/.test(out)) bad.push(`「」: ${key} → ${out}`);
    }
    if (key.includes('〜') && !known(key, '〜') && !out.includes('–')) bad.push(`〜: ${key} → ${out}`);
  }
  assert.deepEqual(bad, []);
});

test('the known-wrong entries are still listed keys (a stale KNOWN entry would hide nothing)', () => {
  for (const key of Object.keys(KNOWN)) assert.ok(ALL.some(e => e.key === key), key);
});

// ------------------------------------------------------------------ the audit doc's proposed changes
// Each asserts the proposed English. All 11 were taken on the integration branch (2026-11-16), so they are ordinary tests.
const proposed = (doc, key, english, why) =>
  test(`${doc} (CLAUDE-LANE-D-ENGLISH-AUDIT-20261116.md): ${why}`, () => {
    assert.deepEqual(outputs(EN[key], key), outputs(english, key));
  });

proposed('D-1', '道の州の指定が正しくありません（1〜4 州）。',
  'The route\'s provinces are not valid (1–4 provinces).', '〜 is – (GLOSSARY.md Style), as every sibling range');
proposed('D-2', 'テスト用ウォレットは、この端末で開いたページでしか使えません。',
  'The test wallet works only on a page opened on this device.', '端末 is "device" in every other entry');
proposed('D-3', '戻るのは包囲の結果を受け取ったときで、それまでは「返却待ち」と表示します。',
  'They come back when the siege\'s result is collected; until then they are shown as “waiting to be returned”.',
  '「返却待ち」 is the label "waiting to be returned", quoted');
proposed('D-4', '世界は同時に2つまでです。どの世界も、開始サービスで決めた時間（開始後に終了時刻を表示します）がたつと自動的に終わり、その進行は保存されません。上限のときは、終了する世界を自分で選びます（勝手には止めません）。',
  'At most two worlds at once. Each ends on its own once the time set by the start service has passed (its end time is shown once it starts), and its progress is not saved. At the limit you choose which world to end (none is ended for you).',
  'the end time is shown, never a default the launcher may not use (loop-play4 B-12); the Japanese names no operator');
proposed('D-5', '村の耕地（テスト用の世界）：この村の州で軍勢が立って広げたマスと、その分の生産の上乗せです。自分の領土（広い土地で取るマス）とは別のものです。',
  'The village\'s fields (test world): the tiles hosts claimed by standing in this village\'s province, and the production they add. Not your own territory (the tiles you claim on the wide land).',
  'the Japanese does not say whose hosts (or the Japanese adds あなたの国の: the owner\'s call)');
proposed('D-6', 'テスト用ウォレットは、ローカルプレイを選んだときだけ使えます。',
  'The test wallet can be used only when local play is chosen.', '使えます is "can be used", not "is used"');
proposed('D-7', '軍勢はターン {0} に到着 · 位置を読み込んでいます',
  'Host arrived on turn {0} · loading its position', 'the Japanese has no "Its"; 読み込んでいます is "loading"');
proposed('D-8', 'いまは納めるものがありません（命令のたびに蔵は納められます）。蔵は毎時 +{0} 増えています',
  'Nothing to store now (every order stores it). The stores are growing by +{0} an hour',
  'the Japanese says no "harvest"; 蔵 is the subject of the second sentence');
proposed('D-9', 'あなたの包囲は必要なターンを満たし、占領の結果を受け取るのを待っています（ターン {0} 以降・宣言はターン {1}・場所 {2}）。都市はまだあなたのものではありません。',
  'Your siege has met its required turns and is waiting for the capture\'s result to be collected (from turn {0}; declared on turn {1}; site {2}). The city is not yours yet.',
  'in a sentence "on turn N" (GLOSSARY.md ターン); 以降 is "from", not "due from"');
proposed('D-10', '今回の記録のスロット', 'Record slot of this check', '記録のスロット is "Record slot" (round 36); "reading" is no other entry\'s word for 記録');
proposed('D-11', 'この州の耕地 {0} マス · 生産 +{1}%',
  // (the dictionary's plural keeps {0} for the page to fill, as every plural entry does: compare in that form)
  (n, p) => `Fields in this province: ${n === 1 ? '{0} tile' : '{0} tiles'} · production +${p}%`,
  'この州 is "this province": "here" on the village strip does not say which place');

// ------------------------------------------------------------------ round 2 (candidate aa12ce74), the audit doc's R2 entries
proposed('R2-1', '地図で読み込んだほかの州だけを数えます（テスト用の世界）。地図を動かすと変わることがあります。',
  'Counts only the other provinces the map has loaded (test world). It can change as you move the map.',
  'the Japanese says what is counted (the loaded other provinces), not "land claimed"');
test('R2-2 (CLAUDE-LANE-D-ENGLISH-AUDIT-20261116.md): no stale entry for the scout card\'s old countdown label', () => {
  for (const [g, dict] of Object.entries(EN_GROUPS)) assert.ok(!Object.hasOwn(dict, '反映の目安まで（ゲーム内）'), `lang/en-${g}.mjs`);
});
