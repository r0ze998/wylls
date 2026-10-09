// The Frontier's enum tables and program errors in Japanese and English
// (contract §9.6; web design §9). Japanese inline (L`…`), English in
// lang/en-frontier.mjs; the tables follow the language at read time
// (lazyTable), so a switch re-renders without a reload. Faction names are
// v9's (i18n.mjs CIV_NAMES); the colours are the Frontier's own (palette.mjs). Doctrine C shows as
// "Flame" (I-34). Every program error code of abi.mjs has a text
// (web-frontier-errors.test.mjs, W3-F, checks it; web-lang checks the
// English).
import { L, lazyTable, fmtNum } from '../lang.mjs';
import { CIV_NAMES } from '../i18n.mjs';
import { NATION_FILL } from './palette.mjs';
import { ERRORS } from './abi.mjs';

/** The nations' colours: the Frontier's own table (palette.mjs: the colours of the six leaders' clothes), in v9's faction order. */
export { NATION_FILL as FACTION_COLORS };
/** Faction display name by id 0–5 (6 = neutral: camps, Free Cities). */
export const factionName = f => (f === 6 ? L`中立` : CIV_NAMES[['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'][f]] ?? `#${f}`);

/** The eight resources (holding stores), in kernel order. */
export const RESOURCES = lazyTable({
  Food: () => L`食料`, Wood: () => L`木材`, Stone: () => L`石材`, Ore: () => L`鉱石`,
  Horses: () => L`馬`, Gold: () => L`金`, Science: () => L`学術`, Influence: () => L`影響力`,
});
export const RESOURCE_ORDER = Object.freeze(['Food', 'Wood', 'Stone', 'Ore', 'Horses', 'Gold', 'Science', 'Influence']);

/** Units, in kernel order. */
export const UNITS = lazyTable({
  Spearman: () => L`槍兵`, Archer: () => L`弓兵`, Horseman: () => L`騎兵`, Pikeman: () => L`長槍兵`,
  Crossbowman: () => L`弩兵`, Knight: () => L`騎士`, Scout: () => L`斥候`, Settler: () => L`開拓者`,
});

/**
 * A unit with its count, as a person says it: 「槍兵 600」 / "600 Spearmen" (the English needs the plural, so each
 * unit has its own line). `unit` is the kernel's name (UNIT_ORDER); `n` whole troops.
 */
const UNIT_COUNT = {
  Spearman: n => L`槍兵 ${n}`, Archer: n => L`弓兵 ${n}`, Horseman: n => L`騎兵 ${n}`, Pikeman: n => L`長槍兵 ${n}`,
  Crossbowman: n => L`弩兵 ${n}`, Knight: n => L`騎士 ${n}`, Scout: n => L`斥候 ${n}`, Settler: n => L`開拓者 ${n}`,
};
export const unitCount = (unit, n) => UNIT_COUNT[unit]?.(fmtNum(n)) ?? L`${fmtNum(n)} 兵`;

/** Stances (plaintext order 0–3). Disarray is a posture state (M3), named for reports. */
export const STANCES = lazyTable({
  // 待機の構え, not v9's bare 待機 ("Idle"): the stance reads "Hold" (W3-F D9, W5-E copy review).
  Hold: () => L`待機の構え`, Assault: () => L`突撃`, Flank: () => L`側撃`, Brace: () => L`迎撃`, Disarray: () => L`混乱`,
});

/**
 * What became of a host in a clash: ONE word per outcome of the rules, the same in the report, in the battle on the
 * map (app.mjs and people/replay.mjs hand it to the effect; fx/battle.mjs keeps the same strings as its default),
 * in the marches list and in the chronicle (UX design 11.13). The order card's forecast says the same words in the
 * future tense (hud/marchcard.mjs FATE_SHORT).
 */
export const FATES = lazyTable({
  Stays: () => L`戦場に残った`, Withdrew: () => L`隣へ退いた`, Bounced: () => L`村へ押し戻された`,
  Retreated: () => L`撤退した`, Destroyed: () => L`壊滅した`, Routed: () => L`敗走した`,
});
/**
 * The outcome of a clash for one side, in a word (the report's stamp; the title of the battle on the map uses the
 * same words: fx/battle.mjs verdictTitle): 壊滅 when nothing remains, 撃退 when a defender saw the attackers off,
 * 撤退 when the viewer's hosts did not stay, 持ちこたえた when both sides remain.
 */
export const VERDICTS = lazyTable({
  won: () => L`勝利`, repelled: () => L`撃退`, held: () => L`持ちこたえた`, fell: () => L`壊滅`, turned: () => L`撤退`,
  lost: () => L`敗北`, ruin: () => L`共倒れ`, cleared: () => L`野営地を制圧`, arrived: () => L`着いた`, none: () => L`確認待ち`, watch: () => L`決着`,
});

/** Tiers of a holding. */
export const TIERS = lazyTable({ 0: () => L`集落`, 1: () => L`町`, 2: () => L`都市`, 3: () => L`城塞` });

/** Doctrine display names (I-34: doctrine C is "Flame" in M1 UI strings). */
export const DOCTRINE_C = () => L`炎`;

/** The bell pipeline states (clock.mjs PIPELINE) and what they mean to a player. */
export const PIPELINE_TEXT = lazyTable({
  open: () => L`受付中：このターンの到着は封印中です。守り手は、ターンの始まりにそこにいた軍勢で決まっています。`,
  awaitingBeacon: () => L`開封待ち：ターンが終わり、封を開ける鍵が出るのを待っています。`,
  revealing: () => L`開封中：封が順に開けられています。`,
  awaitingSeed: () => L`決着待ち：戦いを決めるくじが出るのを待っています。`,
  resolving: () => L`決着中：衝突を順に決着させています。`,
  resolved: () => L`決着：報告を見られます。`,
});

/** Season status names (effective status, fcodec.effectiveStatus). */
export const SEASON_STATUS_TEXT = lazyTable({
  Announced: () => L`予告済み`, Created: () => L`作成済み`, Seeded: () => L`開始待ち`, Running: () => L`進行中`,
  Ended: () => L`終了`, Closed: () => L`閉鎖`, Aborted: () => L`中止`, Unknown: () => L`不明`,
});

// ------------------------------------------------------------------ program errors (§5.4)
const ERROR_TEXT = {
  BadData: () => L`命令のデータが正しくありません`,
  BadAccount: () => L`記録の宛先が正しくありません`,
  BadAddress: () => L`記録の宛先が正しい形ではありません`,
  Auth: () => L`必要な署名がありません`,
  WrongStatus: () => L`シーズンがこの操作をできる状態ではありません`,
  RulesetMismatch: () => L`ルールのハッシュが一致しません`,
  WrongRound: () => L`封を開ける鍵の回が違います`,
  NoAnchor: () => L`このターンの封を開ける鍵がまだ出ていません`,
  Crypto: () => L`署名の検証に失敗しました`,
  Capacity: () => L`今は空いている土地がありません`,
  SiteTaken: () => L`その場所はすでに使われています`,
  WindowClosed: () => L`開封の受付は終わりました`,
  TooEarly: () => L`まだ早すぎます`,
  Reserved14: () => L`（使われていないコード）`,
  Kernel: () => L`ルールがこの操作を認めません`,
  Archived: () => L`このターンの記録はすでに保管庫に移されました`,
  Bucket: () => L`操作の上限に達しました。少し待ってください。`,
  NotTopLevel: () => L`直接の取引でしか実行できません`,
  Overflow: () => L`数値が大きすぎます`,
  NotOwner: () => L`あなたのものではありません`,
  Insufficient: () => L`資源か残高が足りません`,
  QueueFull: () => L`建設の列がいっぱいです`,
  NoTicket: () => L`村の申し込みがありません`,
  NotFinal: () => L`村がまだ確定していません`,
  TooManyAccounts: () => L`一度に扱う記録が多すぎます`,
  NotResident: () => L`この州はまだ前のターンの決着が済んでいません`,
  ProvinceFull: () => L`この州の枠がいっぱいです`,
  HostBusy: () => L`この軍勢は別の命令を待っています`,
  Cooldown: () => L`軍勢が休息中か、体力が足りません`,
  TransitState: () => L`進軍の状態が合いません`,
  ArrivalBell: () => L`そのターンには着けません（道のりに合いません）`,
  Path: () => L`道が正しくありません`,
  CommitMismatch: () => L`封の中身が約束と一致しません`,
  QuotaRefused: () => L`このターンは同じ国の到着が多く、枠に入れませんでした`,
  SlotMoved: () => L`到着の順位が変わりました。もう一度試します。`,
  NeedArrivalDay: () => L`到着の記録がまだ用意されていません`,
  Shielded: () => L`その村は保護中です`,
  DepartureUnsettled: () => L`出発の手続きがまだ済んでいません`,
  NotGathered: () => L`到着がまだ集められていません`,
  OutOfOrder: () => L`ターンの順番が違います`,
  NotQuiet: () => L`このターンには到着があります`,
  InputsOpen: () => L`衝突の記録はまだ閉じられません`,
  NotEligible: () => L`払い戻しの対象ではないか、すでに受け取りました`,
  FoldStale: () => L`集計が古くなっています`,
  TicketState: () => L`村の申し込みの状態が合いません`,
  NotDormant: () => L`まだ休眠していないか、進軍中です`,
  Explored: () => L`そこはすでに探索されています`,
  SessionExpired: () => L`ゲーム内の鍵の期限が切れました`,
  WrongRegion: () => L`地域が違います`,
  Aborted: () => L`シーズンは中止されました`,
  TipTooLow: () => L`チップが最低額に足りません`,
  AlreadyDone: () => L`すでに済んでいます`,
  LatchClosed: () => L`このターンの到着はもう締め切られました`,
  SeedNotReady: () => L`このターンの戦いを決めるくじがまだ出ていません`,
  BadPlaintext: () => L`封の中身が正しい命令ではありません`,
  Announce: () => L`シーズンの予告が正しくありません`,
  ReservedSite: () => L`その場所は予約されています（第0・第1輪）`,
  HostInTransit: () => L`この軍勢は、進軍の結果を受け取るまで動かせません`,
  JoinGate: () => L`参加には招待が必要です`,
  CohortFull: () => L`この州は、このターンの村の申し込みがいっぱいです。次のターンに試してください。`,
  TipNotPreset: () => L`チップは3つの選択肢から選んでください`,
  NotImplemented: () => L`まだ実装されていません`,
};

/** The text of a program error (§5.4) by code, or by name; unknown codes say so with the number. */
export function errorText(codeOrName) {
  const name = typeof codeOrName === 'number' ? ERRORS.find(e => e[0] === codeOrName)?.[1] : codeOrName;
  const fn = name && ERROR_TEXT[name];
  return fn ? fn() : L`不明なエラー（${codeOrName}）`;
}

/** Every error name that has a text (the errors test compares it with abi.mjs ERRORS). */
export const ERROR_NAMES = Object.freeze(Object.keys(ERROR_TEXT));

/** Texts for this page's own refusal codes (herald, seal, pins, wasm). */
const CLIENT_TEXT = {
  network: () => L`通信できませんでした`,
  NotFound: () => L`まだ記録がありません`,
  WrongSeason: () => L`別のシーズンの記録です`,
  WrongKey: () => L`頼んだものと違う記録が届きました`,
  NotQuicknet: () => L`このシーズンの公開乱数は quicknet ではありません`,
  TestBeaconOffLocalnet: () => L`テスト用の乱数はローカルネットでしか使えません`,
  PkHashMismatch: () => L`公開乱数の鍵がシーズンの記録と一致しません`,
  SealAuditFailed: () => L`封の自己点検に失敗しました。何も送っていません。`,
  WasmHashMismatch: () => L`ルールのプログラムが公開されたものと一致しません`,
  PinMismatch: () => L`シーズンの記録の宛先が、プログラムから導いたものと一致しません`,
  RelayMessageChanged: () => L`中継サーバーが署名前の取引を書き換えました`,
  // ---- the relay's refusals (permutation-gateway src/frontier, §8.3; W3-F)
  RelayRejected: () => L`中継サーバーがこの取引の形を受け付けませんでした`,
  UseRevealRoute: () => L`開封は取引ではなく開封の材料として送ります`,
  QuotaExceeded: () => L`今日送れる操作の回数を使い切りました。シーズンの日付が変わると、また送れます。`,
  InviteRequired: () => L`このシーズンに参加するには招待が必要です`,
  OperatorLowFunds: () => L`手数料を立て替える資金が足りません。しばらくしてから試してください。`,
  BadSignature: () => L`署名を確認できませんでした`,
  Duplicate: () => L`同じ取引はすでに送られています`,
  AlreadyProcessed: () => L`同じ取引はすでに送られています`,
  BlockhashExpired: () => L`取引の期限が切れました。もう一度送ってください。`,
  RateLimited: () => L`送信が速すぎます。少し待ってください。`,
  ProgramError: () => L`別のプログラムがこの取引を拒みました`,
  SimulationFailed: () => L`試しの実行でこの取引は失敗しました`,
  SimulationIncomplete: () => L`中継サーバーが試しの実行の結果を読めませんでした`,
  InvalidTransaction: () => L`取引の形が正しくありません`,
  KeeperUnavailable: () => L`封を開ける係につながっていません。封は、到着のターンが終わったあとに開けられます。`,
  GateUnavailable: () => L`中継サーバーが招待の鍵を持っていません`,
  InvitesUnavailable: () => L`招待を扱えません`,
  WorldUnavailable: () => L`シーズンの記録を読めません`,
  InsufficientFunds: () => L`残高が足りません`,
  BodyTooLarge: () => L`送る内容が大きすぎます`,
  InvalidJson: () => L`送る内容が読めませんでした`,
  BadRequest: () => L`頼み方が正しくありません`,
  OperatorOnly: () => L`運営者だけの操作です`,
  TokenError: () => L`運営者の鍵が正しくありません`,
  TimeoutError: () => L`時間内に答えがありませんでした`,
  Unavailable: () => L`サーバーが応じませんでした。少し待ってから、もう一度試してください。`,
  // ---- this page's own steps (W3-F)
  NoRelay: () => L`中継サーバーの場所がわかりません`,
  NoPin: () => L`シーズンがまだ決まっていません`,
  BadRelayAnswer: () => L`中継サーバーの答えを読めませんでした`,
  MessageRefused: () => L`署名する前の点検で取引を止めました`,
  BuildFailed: () => L`取引を組み立てられませんでした`,
  TooLarge: () => L`取引が大きすぎます`,
  SignFailed: () => L`署名できませんでした`,
  WalletAlteredMessage: () => L`ウォレットが署名した文面が違います`,
  WalletRejected: () => L`ウォレットで取り消されました`,
  WalletError: () => L`ウォレットのエラーです`,
  NoWallet: () => L`ウォレットが接続されていません`,
  NoSession: () => L`ゲーム内の鍵がありません。鍵を作ってください。`,
  SessionMismatch: () => L`このゲーム内の鍵は、登録されているものと違います`,
  Expired: () => L`取引は期限までに記録されませんでした`,
  Unconfirmed: () => L`取引がまだ確認できません。あとで状態を確かめます。`,
  TransactionFailed: () => L`取引は記録されましたが失敗しました`,
  NotSaved: () => L`この端末に進軍の記録を保存できないため、送りませんでした`,
  BadName: () => L`名前は1〜24文字の文字・数字・空白・「-」「_」「.」で付けてください`,
  BadRoster: () => L`名簿のファイルが読めませんでした`,
  AlreadySent: () => L`この進軍はすでに送られています`,
  NoKernel: () => L`ルールがまだ読み込まれていません`,
  NoWasm: () => L`このサーバーにはルールのファイルがまだありません`,
  PlannerRefused: () => L`道を探せませんでした`,
  NoPath: () => L`そこまでの道が見つかりません`,
  NoDestination: () => L`行き先を選んでください`,
  BadTile: () => L`そのマスはありません`,
  Stance: () => L`構えを選んでください`,
  Retreat: () => L`撤退の倍率が正しくありません（0.0001〜6 倍）`,
  NotScout: () => L`探索できるのは斥候だけです`,
  NoClock: () => L`シーズンの時計がまだありません`,
  WrongRound: () => L`封の回が到着のターンと合いません`,
  WorkerFailed: () => L`封の処理が止まりました。もう一度試してください。`,
  SealFailed: () => L`封を作れませんでした`,
  BadPoint: () => L`封の点が正しくありません`,
  FoCheck: () => L`封の検査に失敗しました`,
  BeaconClockMismatch: () => L`公開乱数の時計がシーズンの記録と一致しません`,
  ChainHashMismatch: () => L`公開乱数の系列がシーズンの記録と一致しません`,
  NoExport: () => L`ルールのファイルにその機能がありません`,
  MissingExport: () => L`ルールのファイルが古いか壊れています`,
  WasmAbiMismatch: () => L`ルールのファイルの版が違います`,
  BadEnvelope: () => L`州の記録の形が正しくありません`,
  BadOverview: () => L`全体図の記録の形が正しくありません`,
  BadRecord: () => L`記録を読めませんでした`,
  BadBody: () => L`答えを読めませんでした`,
  WrongMagic: () => L`記録の種類が違います`,
  WrongSize: () => L`記録の大きさが違います`,
  WrongKind: () => L`記録の種類が違います`,
  BadLayout: () => L`記録の形の表が壊れています`,
  BadBackup: () => L`鍵のバックアップを読めませんでした`,
  WalletBadSignature: () => L`ウォレットの署名を確認できませんでした`,
  WalletUnsupported: () => L`このウォレットは使えません`,
  NoAccount: () => L`ウォレットにこのネットワークで使えるアカウントがありません`,
  BadSessionText: () => L`鍵の文面を作れませんでした`,
};
/** A client-side refusal's text (falls back to the program table, then the code). */
export const clientText = code => (CLIENT_TEXT[code] ? CLIENT_TEXT[code]() : errorText(code));
/** Every client and relay code that has a text (web-frontier-errors.test.mjs checks the relay's codes against it). */
export const CLIENT_CODES = Object.freeze(Object.keys(CLIENT_TEXT));

/**
 * The text for a failed answer `{code, programCode?, httpStatus?}` from the
 * relay, the herald, the keeper link or this page (§9.6): a program error
 * by its number first (the relay passes `programCode`), then by name, then
 * this page's and the relay's own codes; `HTTP429`-style codes by status.
 */
export function failureText(r) {
  if (!r) return L`不明なエラー（${'?'}）`;
  if (Number.isInteger(r.programCode) && ERRORS.some(e => e[0] === r.programCode)) return errorText(r.programCode);
  const code = r.code ?? null;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]();
  if (code && CLIENT_TEXT[code]) return CLIENT_TEXT[code]();
  const m = /^HTTP(\d{3})$/.exec(String(code ?? ''));
  const status = m ? +m[1] : r.httpStatus;
  if (status === 429) return CLIENT_TEXT.QuotaExceeded();
  if (status >= 500) return CLIENT_TEXT.Unavailable();
  return L`不明なエラー（${code ?? status ?? '?'}）`;
}

// ------------------------------------------------------------------ play tables (W3-F)
/** Doctrines A–F by faction id (kernel `doctrine::of_faction`); C shows as "Flame" (I-34). */
export const DOCTRINE_NAMES = lazyTable({
  0: () => L`石の守り手`, 1: () => L`潮`, 2: () => DOCTRINE_C(), 3: () => L`新緑`, 4: () => L`光明`, 5: () => L`鉄`,
});
/** Buildings by the resource they produce (catalog items 0–5), and the walls (item 6). */
export const BUILDINGS = lazyTable({
  Food: () => L`農場`, Wood: () => L`伐採場`, Stone: () => L`石切り場`, Ore: () => L`鉱山`, Gold: () => L`造幣所`, Science: () => L`書庫`, Walls: () => L`城壁`,
});
/** Holding states. */
export const HOLDING_STATES = lazyTable({
  none: () => L`なし`, provisional: () => L`仮の村`, final: () => L`確定した村`, released: () => L`手放された`,
});
/** TRANSIT_SETTLED outcomes (flog.TRANSIT_OUTCOMES). */
export const TRANSIT_OUTCOME_TEXT = lazyTable({
  Stays: () => L`戦場に残った`, Withdrew: () => L`隣へ退いた`, Bounced: () => L`村へ押し戻された`, Retreated: () => L`撤退した`,
  Destroyed: () => L`壊滅した`, BouncedUnranked: () => L`村へ押し戻された（同じ国の到着が多すぎたため。損失なし）`, Routed: () => L`敗走した（兵・体力・チップの半分を失った）`,
  BadSeal: () => L`封が正しくなかったため失われた`,
});
