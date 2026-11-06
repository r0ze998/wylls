# 未決定事項（試作は値を置いていない／試作値を本番仕様にしない）

決定済みで**ここに無いもの**：継続世界（世界を終了・リセットしない。期間境界で住民・所有・進行を失わせる案には戻さない）。NFT 取得＝waitlist 登録。NFT に紐づく住民のゲームデータと操作権は売却・譲渡できる。鍵・API キー・外部アカウント・売り手の財布の資金は移さない。

| # | 項目 | 試作での扱い | 決める人・前提 |
|---|---|---|---|
| U1 | 無料か有料か、価格、供給数、販売方法、公開発行の時期、ロイヤリティ | `terms.amount = 'TEST-VALUE'`、供給数制限なし、royalties プラグイン未設定、公開発行なし | 所有者。法務確認（DECISIONS Y4/Y5 と同列） |
| U2 | collection authority（発行鍵）の保管と、誰が mint を打つか | relay がテスト鍵を持つ | 運営。新しい鍵の設定は承認されていない |
| U3 | 譲渡時の agent wallet の預け金・`held`/`sending`/`unresolved` hold | 模擬せず。推奨案：ウォレットの金なので売り手に残し、`held` は release、`sending` は結果待ち、agent は買い手名義で作り直す | ⑤④ |
| U4 | 未受取の賞金（prize Entry はウォレット鍵） | 現コードどおりウォレットに残る（DATA-MAP §3） | ⑰・所有者 |
| U5 | 投票資格（`JOIN_BELL` から 288 bell）を住民に残すか、保有者変更でリセットするか | 住民に残す（模擬せず） | ゲーム設計。買い占め対策と両睨み |
| U6 | 既存 Citizen の bind（住民化）を許すか、1 回限りか、asset の付け替えを許すか | 1 回限り・付け替え不可を提案 | ④ |
| U7 | **売買方式と譲渡ガード**：S（専用売買：Permanent Freeze＋Permanent Transfer Delegate＝プログラム、一般市場と非互換）か、G（Token-2022＋Transfer Hook、市場対応は未確認）か。Oracle は市場互換を満たせず、LifecycleHook は未提供 | S を**候補として**模擬。`docs/COMPARISON.ja.md` に推奨（今は決めず、市場対応の実証を待つ） | ④・所有者。**非互換の受容は決定していない** |
| U8 | 私的な会話（talk・council 発言）を買い手へ見せるか | 非開示のまま分離 | ⑫⑬・所有者・法務 |
| U9 | AI の非公開記憶（episodes/reflection）を住民の人格として移すか消すか | 分離 | ⑫⑬。AI 開示の法務未了 |
| U10 | 封印中で未公開の情報（未到着の封じた進軍の目的地） | 分離。公開時刻まで誰にも見せない | ④⑯ |
| U11 | **継続世界への移行方法**：現行の Citizen・Holding・Season は季節（S1 季節）単位に作られる。継続世界は決定済みで、問題は「どう移すか」——(a) 季節を「戦期」に読み替え、住民・村・倉・記録を戦期をまたいで同じアカウントのまま持ち越す派生、(b) 季節アカウントを廃し世界単位の派生へ移す、のどちらか。**期間境界で住民・所有・進行を失わせる案は取らない** | 手を付けず（試作の世界は季節を持たない） | ④。23-world-and-periods C 案の実装と同時 |
| U12 | NFT 保有は本人の一意性を証明しない（1 人が複数、複数人で 1 つ） | 1 asset = 1 住民として扱い、人数は数えない | 設計上の前提。sybil 対策は別件 |
| U13 | 凍結中（owner-managed FreezeDelegate）の住民の操作可否 | 拒否 | ④ |
| U14 | `StaleRead` の実チェーン基準（commitment、許容スロット差） | 「最後に確認した変更のスロット以上」かつ asset と Citizen を同じスロットで読む | ④・relay |
| U15 | 支払い＋発行の 1 取引化（原子性） | 別処理として扱う | ⑰。実測後 |
| U16 | 複数 asset を持つウォレットの UI（どの住民でログインするか） | asset を明示して challenge | ⑦ |
| U17 | 預かり物・債務の具体的な扱い（引き継ぎの表示、返還の期限、債務不履行時） | 消さずに移す、までを模擬 | ④⑤⑬・所有者（DATA-MAP §3） |
| U18 | Metaplex Core の本線採用 | 試作の選定方式。本線採用は未決 | ④・所有者 |
| U19 | 主要 NFT 市場（Magic Eden、Tensor 等）がフック付き Token-2022 NFT の listing・購入・送付を処理するか | 一次資料なし。devnet での実証が要る（新規導入のため承認待ち） | ④・所有者 |
| U20 | 専用売買経路の価格・通貨（USDC か）・手数料率・返金規則 | 仮値（25 単位、250 bps） | 所有者・⑰・法務 |
| U21 | 運営（プログラムの upgrade authority）が永続 delegate／フックを通じて全 asset を動かせる立場になることの開示と制限 | 未扱い | 所有者・法務 |
| U22 | 実 Core＋LiteSVM 検証のための導入（`docs/REAL-CORE-PLAN.ja.md` §1）を承認するか。devnet 実証（MARKET-COMPAT §2.4）を承認するか | 一覧と計画のみ。導入・配備はしていない | 所有者 |
| U23 | upgrade authority の形（単一鍵／多重署名／遅延／凍結）と、collection authority の保管。供給上限をプログラムで数えるか | TRUST-MODEL §3 の提案のみ | 所有者・法務 |
| U24 | devnet の試験価格（例 0.1 SOL）と、本番価格・供給数・ロイヤリティ。試験価格は config で変更可とし、本番条件と混同しない | 画面は `TEST PRICE` と明示 | 所有者 |
| U25 | MINT-FLOW §7 の R1〜R7（導入、プログラム配備、collection、treasury/config、devnet 試験、サイト公開、索引）の承認と、公開先・サイト担当 | 一括提示のみ | 所有者・サイト担当 |
| U26 | `mpl-core` 0.12.1 を SBF ビルドすると 3 関数でスタック超過の警告（プラグイン一覧の復号経路、本プログラムは呼ばない）。devnet 配備前に修正版の有無を確認するか、CPI ビルダーだけを使う最小依存に切り替えるか | 警告を記録（ENV-RECORD） | ④ |
| U27 | devnet 配備時のプログラム ID・upgrade authority・config authority の鍵（本環境には置かない方針） | 未決 | 所有者 |
| U28 | 公開 devnet RPC で `getProgramAccounts` が使えない場合の `/mint/mine` の索引：DAS（提供者のアカウントが要る）か、自前索引（`src/registry.mjs` 系。チェーン読取を正とし索引だけで判定しない） | ローカル validator では gPA＋検証で実施 | 所有者（A7） |
| U29 | devnet 配備の鍵の置き場と手順：所有者の端末で配備するか、本環境で使い捨て配備鍵を使い配備後に upgrade authority を移すか | 未実行。DEVNET-APPROVALS A1・A2 | 所有者 |
| U30 | Royalties プラグインを collection 作成時に付けるか（仮値）、付けずに後で足すか。ロイヤリティ率は未決（U1） | 付けていない | 所有者（A3 の前） |
| U31 | ウォレット 1 つにつき住民 1 つに限るか（wallet 由来の PDA で on-chain に一意にすると、別 blockhash で作り直した 2 本目も失敗し二重発行・二重課金を構造で防げる。⑰の Entry PDA `["entry", pool, wallet]` と同じ形）。現設計は「複数 NFT・1 ウォレット」を許し、一意性は試行ごとの asset 鍵に置く | 試行ごとの asset 口座の有無で判定（MINT-FLOW §1 期限切れ） | 所有者・④ |
| U32 | Frontier の Citizen と住民（Core asset）の対応を、誰がいつ書くか。Citizen は財布で決まるため、発行時・参加時・公開時のどこで結ぶか、一度結んだら変えないか | 試験では手で書いた（`ResidentBindings`、JSON ファイル、変更不可） | ④・所有者 |
| U33 | 委任を 2 か所（Frontier の SetSession と住民プログラムの SetSession）に要する形を、1 回で済ませるか。relay が住民プログラムの取引を中継するか | 保有者が自分の手数料で住民側を出す | ④ |
| U34 | Frontier program に保有者の世代と入口の検査を入れるか（旧パッチ 02 の欄＋検査）。入れない限り、relay を迂回した旧保有者の直接送信と、譲渡前に送った取引の着地は止まらず、買い手 B は A の Citizen を操作できない | 未着手（GATEWAY-CONNECTION §5） | ④・所有者 |
| U35 | 住民に紐付かない Citizen を、公開後も通すか（`requireBinding`） | 既定は通す（従来どおり） | 所有者 |
| U36 | 別作業の「認証」「NFT と Citizen の一対一登録」「命令接続」「検証器対応」の候補の所在 | 2026-11-06 に候補 20（`a0b80384`、パッチ）を受領・取り込み（CANDIDATE-20-REVIEW）。検証器の完成対応は含まれていない | 所有者 |
| U37 | 固定 seed を含む鍵の生成・導出・署名の試験の禁止のもとで、program をどう試験するか（例：LiteSVM の署名検査を切り、秘密鍵の無い公開鍵だけで命令を組む）。既存の固定 seed の試験を残すか・隔離するか・書き直すか | 今回は鍵を使う試験を一つも実行していない（FRONTIER-HOLDER §7） | 所有者 |
| U38 | 既存の Citizen（財布で作られたもの）を住民 NFT に移すか。移すなら、誰がどの NFT とどう結ぶか | 決めていない | 所有者 |
| U39 | Frontier の操作者の更新を、住民プログラムからの CPI（F1）で行うか、毎回 Core を読む（F2）か | 候補 20 が F2。F2 を推奨に改めた（CANDIDATE-20-REVIEW §3） | ④・所有者 |
| U40 | NFT Citizen の作成命令の記録の番号と版、Citizen の `WALLET` 欄、命令 tag、予約領域、住所と記録の key | 2026-11-06 に ④ が割り当て（統合まで仮）、実装済み。記録の kind は初版の 90 が v2 と重なり、④ が 130 に訂正（`33bb6c89`）。記録は program と読み手を同じ変更で入れる（未実装）（NFT-ACCOUNT-WIRING §3・§4） | ④ |
| U41 | 索引が未知の記録で止まる方針（候補 20 の findex）を採るか。herald の可用性との兼ね合い | 候補のまま取り込み、未判断 | ⑲・④ |
| U42 | relay・agent wallet・client・web が NFT Citizen の `Act`・`Join` を組み、中継するか（今は `0xff` を知らない） | 未接続（NFT-ACCOUNT-WIRING §3） | ④・⑦ |
| U43 | NFT の Join でも、season の join gate（招待・有料の参加）を求めるか | 財布の Join と同じく求める（仮） | 所有者・⑰ |
| U44 | herald の `/h/me/{key}` を NFT 住民では Core の asset で引く（財布の Citizen が先）。web の画面が asset と財布のどちらで引くか、asset を公開の識別に使ってよいか | herald は asset で引けるようにした（仮）。画面側は未接続 | ⑦・所有者 |
