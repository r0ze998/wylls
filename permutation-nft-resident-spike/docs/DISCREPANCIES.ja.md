# 見つけた食い違い（文書どうし・文書と実装・今回の方向と現状）2026-10-31

方針：文書と実装が食い違うときは**実装の書き方**に従った。以下は本作業で実際に読んで確認したものだけ。

| # | 食い違い | 根拠 | 従ったもの |
|---|---|---|---|
| D1 | **季節で世界が終わる設計 vs 継続世界。** `docs/frontier/DECISIONS.md` T1（O-M1-25, 2026-09-30）「everything ends with the season … the next season starts from a fresh map」。一方 `docs/design/redesign/99-decisions.ja.md`（2026-10-23）「世界は続き、戦争だけを戦期で区切る（C案）… シーズン制はやめる」。今回の指示は継続世界・パス買い直しなし。**実装**は季節単位（Citizen は season PDA 配下、`CreateSeason` が S1 季節を作る、README「S1 seasons only」） | DECISIONS.md:397、99-decisions.ja.md:48、`frontier-abi/src/addr.rs`、`permutation-frontier/src/proc/season.rs` | 実装（季節単位）を前提に、住民を季節をまたいで持ち越す派生は U11 として未着手 |
| D2 | **waitlist の形。** サイト試案 `docs/site-proposal/index.html` はメール入力の事前登録フォームと「CITIZEN PASS · WAITLIST · NOT A TOKEN」。今回の方向は「NFT の取得そのものが waitlist 登録、別の先行登録を挟まない」。`PITCH.md:77` は「No registration, waitlist … exists」（実装には waitlist が無い、という意味で正しい） | index.html:176-199、PITCH.md:77 | 実装（waitlist は存在しない）。試作は NFT 保有の投影として新設。サイト試案の文言は要改訂 |
| D3 | **Citizen の束縛。** 指示文「現在の Citizen はウォレットとシーズンに結び付いている」＝実装と一致（`tag15 = sha256("PSF-CIT" ‖ wallet)`、season PDA）。ただし `docs/frontier/DECISIONS.md` Y3 は PlaceHome を「program version 3 の季節の参加手順」と書く一方、README と `season.rs` は現行を **program version 4（S1）** とする | DECISIONS.md:469、README.md:65、season.rs:30,290 | 実装（program version 4）。Y3 の記述は 10-17 時点の歴史 |
| D4 | **予約領域の大きさ。** 自分の初稿で v1 レイアウト（`RSV @ 312` 72 byte）を前提に 32 byte × 2 の追加を書いたが、現行 S1 が使う v2 Citizen の予約は `RSV_348` 36 byte | `frontier-abi/src/layout/player.rs:37`、`v2/layout/player.rs:45` | 実装（v2、36 byte）。INTEGRATION-04 を 15 byte タグ 2 本に修正済み |
| D5 | **agent wallet の `owner` の意味。** `docs/agent-wallet/DESIGN.md` §5 は owner＝ウォレット署名者。NFT 方向では「操作権限者＝現保有者」なので、agent を作った owner が保有者でなくなる状態が新たに生じる。文書・実装ともこの状態を想定していない | DESIGN.md §5、`agent/gateway.mjs:479-482` | 実装の構造（owner = wallet）を保ち、保有者判定を**追加**する提案（patches/03、U3） |
| D6 | **`SetSession` が唯一の失効手段。** DESIGN.md §5.1「SetSession (the only on-chain revocation)」。実装も同じ。NFT 譲渡は Core の `owner` を変えるだけで Citizen の `SESSION` に触れないため、**譲渡は session を失効させない**（Core 公式: Transfer/Freeze/Burn Delegate は失効するが、それはゲームの session 鍵とは別物） | DESIGN.md §5.1、`citizen.rs set_session`、metaplex.com/docs/core/transfer | 実装通り「消えない」と仮定し、`SESSION_SETTER_TAG15` で失効させる案を提示 |
| D7 | **賞金 Entry の鍵。** 設計文書は「住民に属するデータは買い手へ」を志向するが、実装の prize Entry は**ウォレット鍵**（`entryAddress(program, pool, wallet)`） | `routes/prize.mjs`、`client/src/frontier/prize.mjs` | 実装（ウォレットに残る）。U4 |
| D8 | **MCP 文書の rate limit** は実装と一致（40/2 per address: `app.mjs`；30/1 per agent: `routes/agent.mjs:123`）。食い違いなし（確認済みとして記録） | MCP.md、app.mjs、agent.mjs:123 | — |
| D9 | **公式ドキュメント URL の移転。** README 等が示す `developers.metaplex.com/*` は `metaplex.com/docs/*` へ 308 リダイレクト。本書の引用は移転先で確認 | WebFetch の結果 | 移転先 |
| D10 | **x402 ルートの二重存在。** `src/routes/x402.mjs`（旧 V5 プログラムの Register）と `src/frontier/routes/prize.mjs`（現行 Frontier の `Pay+Join`）が並存し、前者のヘッダ注釈は旧プログラム前提。⑰ の対象は後者 | 両ファイルの冒頭注釈 | 後者（現行） |
