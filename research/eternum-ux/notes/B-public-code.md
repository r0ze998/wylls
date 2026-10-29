# B. Realms / Eternum 公開コード調査（UX比較用）

調査日: 2026-10-29。読んだのはコードとリポジトリ内の文書だけで、ビルド・実行・インストールはしていない。

## 凡例

| ラベル | 意味 |
|---|---|
| 「コードで確認」 | ソースを直接読んで確認した。パスとコミットを付ける |
| 「文書で確認」 | リポジトリ内の文書（`FEATURE-MAP.md`、docs サイトの `.mdx`、patch notes）にそう書かれている。コードでの裏取りが無い場合はそう明記する |
| 「Issueで報告」 | GitHub Issue の記述。URL・日付・当時の版を付ける |
| 「コードで未確認」 | 探したが見つからなかった。「存在しない」という意味ではない |
| 「推測」 | 筆者の推論 |

コミットは次の略号で示す。

- **HEAD** = `BibliothecaDAO/eternum@next` `a0fc9024216d846a53d2ab103bbaab18e7059765`（2026-10-28 21:10 UTC, "Merge pull request #5103 … fix/client-batch-1028"）。パスは `apps/game/src/` 起点。
- **OLD** = `BibliothecaDAO/eternum@main` `bbc34deb536e274ffe393a26c2a64c2e11d06e5a`（2026-06-04, "Merge pull request #4847 from BibliothecaDAO/next"）。パスは `client/apps/game/src/` 起点。sparse clone で読んだ。

OLD の8場面は Explore サブエージェントが一次調査した。下の3点は筆者が自分で読んで裏を取った。

- `tx-emit.tsx` の文言
- `story-event-toast-bridge.tsx` の「spam を避けるため初回ロード時に既読化」
- `HintModalButton` の呼び出し箇所

それ以外の OLD の記述も行番号まで付いているが、筆者の再確認は部分的。

---

## 1. リポジトリ・版・デプロイ先

### 1.1 リポジトリ

- **本体リポジトリ**: https://github.com/BibliothecaDAO/eternum。説明は "onchain eternal game"。
  - 既定ブランチは **`next`**（`gh repo view` で確認）。`main` は 2026-06-04 から更新されていない。
  - 2026-10-29 時点で 415 ブランチある。
- **Blitz 関連ブランチ**: `blitz-2`（`e7105848`, 2025-08-04）、`blitz-ui`、`blitz-map`、`blitz-opti`、`blitz-fx-2`、`blitz-before-hype-1`。
- **Eternum S2 関連ブランチ**: `eternum-season-2`（`df7e0f88`, 2026-03-20）、`aymericdelab/eternum-s2`、`codex/eternum-s2-design-package`。
- **Frontier の実験ブランチ**: `lab/frontier-*`（例: `lab/frontier-research-ux`）。
- **タグ**（いずれも pre-release）:
  - `v0.1.0-alpha`（2023-10-13）
  - `ci-toolchain`
  - `shard-v0.1.0` … `shard-v0.7.0-rc.2`（2026-09-24〜2026-10-12）
  - `shard-v*` はアプリチェーン（シャード）側の版。クライアントの版タグはコードで未確認。
- **ドキュメント**:
  - HEAD はモノレポ内の `apps/game-docs`（Vocs）を https://docs.realms.party に出している（「コードで確認」HEAD `README.md`、`apps/game-docs/`）。
  - OLD は `docs.realms.world` を参照していた（「コードで確認」OLD `ui/features/landing/views/play-view.tsx` のリンク、`ui/modules/construction-gate.tsx`）。
  - 独立した docs リポジトリとして `BibliothecaDAO/eternum-guide`（2023-10 で更新停止）と `world-guide`（2024-09）がある。どちらも古い。
- **その他の周辺リポジトリ**: `account-portal`（"The Hub, Marketplace…"、2026-10-29 に push）、`realms-world-site`、`eternum-stats`。

### 1.2 版とモードの対応

**HEAD は現行クライアント**（「コードで確認」HEAD `README.md`）。

- 1つのコードベースで3形式を出す: **Frontier**（日替わりマップの無料PvE）、**Blitz**（最大24人・60分の有料スロット戦）、**Eternum**（数週間の長期4X）。
- 基盤は自前の Starknet アプリチェーン（Madara）。Herald が WebSocket でスナップショットを配る。
- `.env` / `.env.production` の値は `VITE_PUBLIC_GAME_VERSION=athanor`。`.env.production` は "client build for play.realms.party (Cloudflare Pages)" と明記している（「コードで確認」HEAD `apps/game/.env.production`）。
- 最新の patch notes は `content/patch-notes/2026-10-29.md`、タイトルは "Season alpha"（「文書で確認」）。内容は次の通り。
  - 新しいアプリ（Play / Season / What's new / You）
  - Discord またはメールコードでのサインイン
  - 全モード共通の新 HUD
  - Next up
  - Frontier の開始

**OLD は Dojo / Torii / Cartridge 時代のクライアント**（`client/apps/game`）。

- モード別の env ファイルがある: `.env.mainnet.eternum`、`.env.mainnet.blitz`、`.env.sepolia.*`、`.env.slot.*`。
- `VITE_PUBLIC_GAME_VERSION="v1.0.0"`、`VITE_PUBLIC_CHAIN=mainnet`、`VITE_PUBLIC_NODE_URL=https://api.cartridge.gg/x/starknet/mainnet`、`VITE_PUBLIC_FORCE_GAME_MODE_ID=blitz|eternum`（「コードで確認」OLD `client/apps/game/.env.mainnet.*`）。
- 推測: OLD が Eternum Season 1〜2 期と Blitz（2025-08〜2026-06）の本番クライアント。HEAD は 2026-10 に作り直された "Season alpha"。

**patch notes の日付**（「文書で確認」HEAD `content/patch-notes/`）は、各時期の変化を追う手がかりになる。

- 2025-09-03 "Phases and brackets"
- 2025-11-07、2025-11-14、2025-12-08
- 2026-01-31、2026-03-28
- 2026-06-05 "Combat v3"
- 2026-10-29 "Season alpha"

### 1.3 クライアントURL / チェーン

| URL | 根拠 | 版 |
|---|---|---|
| https://play.realms.party | 現行ゲームクライアント（`.env.production`、`README.md`。リポジトリ中で最多の21箇所） | HEAD |
| https://play.dev-realms.party | 開発環境 | HEAD |
| https://docs.realms.party / docs.dev-realms.party | ルール文書 | HEAD |
| herald.realms.party、staging-herald.realms.party | 同期サーバ | HEAD |
| rpc.realms.party/rpc/v0 | アプリチェーン RPC | HEAD |
| admin.realms.party、app.realms.party、chat.realms.party | 運用、プロフィール、チャット | HEAD |
| https://realms.market | 外部マーケット（Market タブ） | HEAD |
| eternum.realms.world、blitz.realms.world | HEAD では `apps/amm-indexer/api/app.integration.test.ts` の CORS テストにだけ出てくる | HEAD（旧URLの名残） |
| alpha-eternum.realms.world | HEAD 内に2箇所 | HEAD |
| next-m.eternum.realms.world | モバイル版URL（`VITE_PUBLIC_MOBILE_VERSION_URL`） | OLD |
| empire.realms.world/trade、blitz.realms.world/profile、docs.realms.world | OLD UI 内のリンク | OLD |

- チェーン: HEAD は L3 アプリチェーンでゲームを動かし、Starknet mainnet は台帳・LORDS・MMR を持つ（「コードで確認」HEAD `README.md`、`apps/game/.env`）。OLD は Starknet mainnet / sepolia を Cartridge RPC 経由で使う（「コードで確認」OLD env）。
- HEAD は旧パス `/blitz`、`/frontier`、`/eternum`、`/dominion`、`/sign-in` を `/` に 301 リダイレクトする（「コードで確認」HEAD `apps/game/public/_redirects`、`src/app.tsx` の `RETIRED_PATHS`）。

### 1.4 構造の手がかり

- `apps/game/FEATURE-MAP.md`（949行）は、開発者が「どの機能がどの画面のどこにあるか」を全部書き出した地図。UX比較の一次資料として非常に有用。ただし後述の通りコードと食い違う箇所がある。
- 画面上の文言はほぼすべて `ui/design-system/kit/words.ts`（1300行）に集約されている。冒頭コメントは「glossary … ruled final 7 October 2026 … each spelled once」（「コードで確認」HEAD）。
- 実行時ロジック（建設可否・プリセット・自動化）は `packages/core` にある。

---

## 2. 8場面

### 場面1: 初訪問から最初の行動まで

**HEAD**

- **入口は Play ページ（`/`）。** 最も可能性の高い「次の一手」を金色ボタン1つで先頭に置く（「コードで確認」`shell/play/play-board.ts` の `LEAD_ORDER`）。優先順:
  1. Blitz の座席に Enter
  2. Frontier の日を Resume
  3. 準備中の Lobby
  4. Frontier を Play（未サインインなら Play free）
  5. 未読の Results
  6. Blitz に Join
  7. Blitz を Watch
  8. Eternum
- コメントには「a player with no realm finds it first rather than under Blitz's cards (owner, 26 October 2026)」とある。新規プレイヤーをまず無料の Frontier に導く設計。
- **サインインはウォレット不要。** Discord を第1候補、メールのコードを第2候補とし、どちらでも初回で Realms アカウントが作られる（「コードで確認」`shell/sign-in/start-step.tsx`）。
  - 端末は最大8台まで: `DOORWAY_WORDS.deviceLimit = "Signed in on 8 devices already."`（「コードで確認」`ui/design-system/kit/words.ts`）。
  - ウォレットは「payout wallet」として後から Settings でリンクする。選択肢は Ready / Braavos / Controller、またはメール経由の Ready（「コードで確認」`words.ts` の `WALLET_WORDS`）。
- **ゲームへの入場は「doorway」と呼ぶ4段トラック:** Account → Realm → Map → Play。観戦者は Map → Play の2段だけ（「コードで確認」`ui/features/game-entry/doorway/doorway-view.ts` の `PLAYER_STEPS` / `SPECTATOR_STEPS`）。
  - 止まる理由は3種類: `sign-in`、`retry`（失敗文言付き）、`devices`（端末上限）。
  - 失敗文言はサービス単位: "The world did not answer." / "The map could not be drawn." / "The realm could not be drawn."。マップ描画に失敗しても "Open realm" で領地ビューに進める（「コードで確認」`doorway-view.ts`、`ui/design-system/kit/failure-lines.ts`）。
- **入植（spawn / settle）はモードごとに違う**（「コードで確認」`ui/features/game-entry/game-entry-modal.tsx`）。
  - **Frontier**: "Found your realm" ボタン。所持 Realm NFT の一覧（"Your Realms"）から選ぶか番号を入れる。番号は任意（"Realm number (optional)"）で、空なら "Free home · no daily Labor"（`realm-number-picker.tsx`、`words.ts`）。
  - **Eternum**: `foundsOnItsOwn = isEternumMode && autoSettleEnabled` で自動入植する。
  - **Blitz**: `"Preparing x/y"` の Pill を出して席の準備を待つ。準備が整うと `phase === "ready"` で自動入場する。
  - 開始前は `ClockChip prefix="starts"` を表示する。
- **Blitz は有料ロビー制**（「コードで確認」`words.ts` の `ENTRY_WORDS`、`shell/blitz/*`）。
  - LORDS で支払う "Pay & join"。不足時は "Need X more LORDS"。
  - 締切後に "Entry closed. Drawing seats." で抽選する。
  - Sword（"Win ×2"）と Shield（"Loss ½"）のオプションがある。
  - 席が取れなければ "Take refund"。
  - テスト期間は "Mint 1,000 test tokens"（`mintTestTokenWord`）。
- **開始前のゲート**: プレイ開始前はすべての操作が「表示されるが閉じている」状態で、"Starts in 3m 12s" の理由を添える（「コードで確認」`utils/can-issue-orders.ts` の `actNowRefusal`）。
- **チュートリアル / オンボーディング**: 専用の段階チュートリアルはコードで未確認。代わりに場面2で述べる "Next up" コーチがある。
  - "How to play" は docs.realms.party/blitz を新しいタブで開くだけ（「文書で確認」`FEATURE-MAP.md` Shell 表）。
  - README が挙げる `ui/features/progression/{hints,onboarding,quests}` は HEAD に存在しない（README は "Last updated: 2026-03-03" で古い）。
- **ロビーのチャット**（「コードで確認」`words.ts` の `CHAT_WORDS`）: 登録者だけ書け（"Players registered in this Blitz write here."）、サインイン者は誰でも読める。

**OLD**（Explore 調査。行番号は OLD 基準）

- オンボーディングは状態機械 `world-select → account → avatar → loading → settlement → ready`（`hooks/context/use-unified-onboarding.ts`）。
- ウォレットは Cartridge Controller 必須。"Sign in required … connect your Cartridge Controller account before entering Blitz."（`ui/layouts/sign-in-prompt-modal.tsx`）。
- Learn タブ（`ui/features/landing/views/play-view.tsx`）は "New? Start Here" で docs.realms.world/blitz/key-concepts へ飛ばし、外部の動画・Google Docs のガイド一覧と "Practice Games" を並べる。
- 入植は2段の進捗表示 "Submit Settlement" → "Sync World State"。エラー文は人間向けに翻訳される。例: "This direction slot is occupied. Pick another slot."（`ui/features/landing/components/game-entry-modal.tsx`）。
- 弱点: Blitz 登録失敗はカードに "Retry" が出るだけで、理由はコンソールにしか出ない（`game-card-grid.tsx` l.417 付近）。

**比較の要点**

- OLD から HEAD で「ウォレット必須 → Discord / メールで開始」に変わった。
- 外部ガイドへ誘導する方式から、ゲーム内の Next up で導く方式に移った。

### 場面2: 開拓と最初の生産

**HEAD**

- **建設**: 領地ビューで空き区画をクリックし、ピッカーで建物を選んで **Build**。建てられないときは理由文が表示される（「コードで確認」`ui/features/settlement/construction/plot-construction-picker.tsx`、`use-plot-construction.ts`）。
- 理由文の一覧（「コードで確認」`packages/core/src/automation/construction.ts` の `fail(...)`）:
  - "Insufficient resources to build."
  - "Need more population."
  - "Need more capacity."
  - "No empty building tiles available."
  - "This tile is out of reach."
  - "This tile is already occupied."
  - "Switch to Resource mode first."
  - "Not available in this game mode."
- 並べ方: 「Each group keeps the game's own order and its fixed grid: nothing is re-sorted by what can rise now」。建てられるかどうかで並び替えない設計（`use-plot-construction.ts`）。
- 送信中の重複防止: 同じ区画には送信中の建設が1件だけ（`useInFlight("plot", …)`）。
- **生産（手動）**:
  - 判定文は "Not enough resources"、"Enter an amount to make"、"Spend at least 0.8 Copper"（下限の具体値付き）、"This recipe is unknown here"（「コードで確認」`ui/features/settlement/production/resource-production-controls.tsx` の `runVerdict` / `noCycleReason`）。
  - 量は「サイクル単位」で丸める。入力ごとに「保有 / 消費」を並べる（同 `runInputs`）。
  - OLD では入力0でも "Not enough resources" と出ていた（Explore の推測）。HEAD は "Enter an amount to make" に分けている（「コードで確認」）。
- **自動生産**: 拠点カード右上のセレクトで Smart / Custom / Off（「コードで確認」`ui/features/settlement/production/automation-preset-switch.tsx`、`packages/core/src/automation/presets.ts`）。
  - Smart = "Production runs itself across buildings."
  - Custom = "Production follows the shares you set."
  - Off = "Nothing is produced automatically."
- **資源表示**: 拠点カードに資源リングを5個ずつ並べる。左上バッジが建物数、右上が残り時間（3文字以内）、下縁が量（「文書で確認」`FEATURE-MAP.md`。コードは `ui/features/world/hud/realm-card.tsx` 等で未精査）。
- **自動処理**:
  - 到着した輸送の受け取り（claim）はクライアントが自動で行う（`ResourceArrivalAutoClaim`）。
  - Blitz の realm provision（補給）も自動ランナーがある（「コードで確認」`ui/action-runners.tsx`）。
- **Next up**（コーチ。「コードで確認」）:
  - Blitz は `ui/features/world/hud/coach.ts` の `coachSteps`。「What scores most for the player right now」を軸に、軍の編成 → 隣の crate を開ける → 探索（+5/タイル）→ キャンプ・リフト（+250）→ Hyperstructure（+1,000）の順で次の一手を出す。勝ち目のない相手（certain loss）なら先に realm の level-up を勧める。
  - Frontier は `ui/features/frontier/next-up/frontier-coach.ts`。"The day ends within the hour"、"Deploy your armies"、"Your army's XP buys a tier"、"Research a … tier"、"Your armies are out of stamina"、"Right-click a tile beside your army"（タッチ端末なら "Double-tap"）。
  - Settings → Next up → Tips をオフにすると警告だけが残る（「文書で確認」`FEATURE-MAP.md`）。
- **Build order**（Blitz）:
  - アカウントに保存する建設手順。JSON のコピーと「AIに頼む」用プロンプトのコピー（"Get help from an AI"）ができる（「コードで確認」`words.ts` の `BUILD_ORDER_WORDS`、`shell/build-orders/*`）。
  - 推奨手順は `packages/core/src/automation/build-order.ts` にある（「文書で確認」）。

**OLD**

- Build パネルは Resources / Economic / Military の3タブ。Resource ↔ Labor のコスト切替がある。カードの上に無効理由を重ねて表示（`select-preview-building.tsx`）。
- 楽観的に区画を予約するストアがあり、90秒で失効する（`build-reservation-store.ts`）。
- "Suggested Actions" ピルから1クリックで実行できる（`top-header/pills/suggestions-pill.tsx`、`left-facets/blitz-suggestions.ts`）。この仕組みが HEAD の Next up / Build order の前身にあたる（推測）。

### 場面3: 建物・部隊の材料集め

**HEAD**

- **不足の書き方を統一**: 「Never a bare "2 / 3"」と決めている（「コードで確認」`ui/design-system/kit/reasons.ts` の `shortfallLine`）。
  - 形は "Needs 2,000 labor, have 1,614 · in 3h 50m"。自然に貯まる量なら待ち時間まで出す。
  - 人口の場合は "Needs 3 population, 2 free"。
  - スタミナは `staminaShortfall`: "Needs 50 stamina, have 13 · in 2m"。
- **拒否には修正手段を付ける**: 型は `Refusal = { reason, fix? }`。`Fix` は「the step that fixes a refusal: its word, its price … and its way」（「コードで確認」`ui/design-system/kit/refusal.ts`）。
- **建物の情報**: ⓘ ホバーで、名前・人口・「もう1棟で何が増えるか」・建設費の保有 / 必要（不足は赤）・生産者なら1サイクルの消費が出る（「文書で確認」`FEATURE-MAP.md`。コードでは `construction/building-hover.tsx`、`building-gives.ts` が該当すると推測）。
- **Frontier の build sheet**: 価格を帯で示し、資源不足は赤で待ち時間付き、人口不足は琥珀色（「文書で確認」`FEATURE-MAP.md` Frontier 表）。
- **輸送の不足**: "Needs N donkeys, M here"（「コードで確認」`ui/features/economy/transfers/transfer-window.tsx`）。
- **Frontier の研究**: ノードを選ぶと「価格 vs 保有」「最初に欠けているもの」「その直し方」が出る（「文書で確認」`FEATURE-MAP.md`。`ui/features/frontier/research/*` が実装）。

**OLD**

- コストを保有と並べ、緑 / 赤で示す（`ui/design-system/molecules/resource-cost.tsx`）。
- realm upgrade のボタン文言は "Need resources" / "Waiting for sync"。
- レシピは "Produces / Consumed By" で表示。

### 場面4: 資源と部隊の移動

**HEAD**

- **右クリック前の予告**: 軍を選んでタイルにホバーすると、右クリックで何が起きるかとそのコストを1行で出す（「コードで確認」`ui/features/frontier/hud/order-tip.ts`）。
  - 例: "Explore" + "30 stamina · 100 wheat"。
  - できないときは理由を出す: "Not enough food for the army" / "No army can enter this tile" / "Too far: move closer" / "Only unclaimed structures can be attacked" / "This game allows no transfer here"、スタミナ不足は待ち時間付き。
  - ソースのコメントは「the map's highlight colours mean the army's orders … this line is their legend」。
  - 食い違い: `FEATURE-MAP.md` は "+5 points" のような見返りも出すと書くが、コードのコメントには「owner, sheet round 5: no gesture, no description, no payoff」とある。少なくとも Frontier の tip は見返りを出さない（「コードで確認」）。
- **出撃**: 新しい軍の初期スタミナを明示する。"X starts on 30/120 stamina" / "starts full"（「コードで確認」`words.ts` の `startsOn`、`ui/features/military/components/unified-army-creation-modal/deploy-form.tsx`）。
- **資源輸送（Transfer ウィンドウ）**（「コードで確認」`ui/features/economy/transfers/transfer-window.tsx`）:
  - 送り元・送り先の両方を選び、複数の送り先に均等に分配できる。
  - ボタン文言は "Send N goods to … · lands in N min"。分単位で切り上げ、「never sooner than the chain lands them」。
  - 送信前に "Choose where to send" / "Choose what to send" と出す。
  - 結果は送り先ごとに分けて伝える: 拒否なら "The game refused it." と "Nothing reached X."、無応答なら "No answer for X yet: check Arrivals"、送信中なら "Still sending to X"。
  - Arrivals / Automation / Balances のタブがある。
- **配送の単位**: 配送は3分ごとの tick の終わりに着く。"Repeat" で自動化に登録できる（「文書で確認」`FEATURE-MAP.md`。コードでの裏取りはしていない）。
- **キー操作**（「文書で確認」`FEATURE-MAP.md`）:
  - `Tab` で軍を順送り、`I` で待機中の軍を選ぶ。
  - 右クリックで即座に命令する。軍の選択は保たれる。
  - 命令できないときも右クリックは必ず反応し、理由付きの無効ボタンを開く。
- **経路**: 経路プレビューの描画（パス線）は今回 HEAD で精査していない（コードで未確認）。`three/scenes/worldmap.tsx` にあると推測。

**OLD**

- 輸送には "Estimated Arrival"、"Donkeys Burnt for Transfer"（不足は赤）がある（`travel-info.tsx`）。
- 軍の移動にはホバーのツールチップで小麦とスタミナを示し、"Right-click to confirm" が点滅する（`tooltip-content.tsx`、`action-instructions.tsx`）。
- トーストは "Not enough stamina for this move" / "Army movement is still resolving"（`three/scenes/worldmap.tsx`）。
- 軍移動の ETA 表示は OLD ではコードで未確認（Explore）。

### 場面5: 取引と協力

**HEAD**

- **Trade（市場）**: 拠点のアクションの1つ。対応コマンド `CreateTradeOrder` / `AcceptTradeOrder` / `BuyFromBank` / `SellToBank` がゲームで有効なときだけ表示する（「コードで確認」`ui/features/world/containers/left-facets/use-structure-actions.tsx`）。
  - 中身は `MarketModal` で、order panel・compact order book・Bank（AMM）・履歴を持つ（「コードで確認」`ui/features/economy/trading/market-modal.tsx`）。
  - `FEATURE-MAP.md` は「Transfer (Eternum: Trade)」と書いている。推測: Eternum だけで出る。
- **Frontier はプレイヤー間の取引も攻撃もない**: 文書に「Trade, bridge, or send anything to another player」は不可、「No other player can attack you」とある（「文書で確認」`apps/game-docs/docs/pages/frontier/index.mdx`）。
- **部族（Tribes / Guilds）**: `showGuildsTab = isEternumMode && mode.ui.showGuildsTab` で Eternum だけ（「コードで確認」`ui/features/social/components/social-board.tsx`）。リーダーボードのウィンドウ（ヘッダーの名前チップから開く）の中にタブとして入る。
- **Hyperstructure**: 拠点のバナー詳細に `HyperstructureConstruction` があり、アクセス設定は `Public / Private / GuildOnly`（「コードで確認」`ui/features/world/components/hyperstructures/hyperstructure-construction.tsx`、`structure-banner-entity-detail.tsx`）。貢献UIの文言は精査していない。
- **チャット**（「コードで確認」`ui/features/social/realtime-chat/*`）:
  - identity Worker の WebSocket を使う。Global / Game / DM の3種（Frontier の文書）。
  - ゲームチャットに書けるのは登録者だけ: "Game chat requires registration in this game"（`realtime-chat-shell.tsx`）。
  - `@` メンション（`use-chat-mentions.ts`）。
  - DM はプッシュ通知の対象（`packages/notifications/src/preferences.ts` の `includesDirectMessageNotification`）。
- **リーダーボード**: 名前チップから開く。各列が行動ごとの得点。rated ゲームでは「いま終わったら MMR がどう動くか」を出す（「文書で確認」`FEATURE-MAP.md`、`ui/features/social/player/mmr-forecast.ts` が存在）。

**OLD**

- 市場は Order Book / History / Realm Production。`venue-comparison.tsx` は AMM と order book のうち安い方に "Best" バッジを付ける（良い設計）。
- "Not enough donkeys for transport!"。
- 部族（Tribes）作成・招待・Public / Private。
- zone チャット: "Join a zone to view chat."。
- 弱点: 注文の受諾 / 取消の失敗はコンソールに出すだけ（`market-order-panel.tsx` l.394, 410）。

### 場面6: 戦闘リスクの判断

**HEAD**

- **攻撃予報**: 敵を右クリックしても、まず予報が開くだけで送信はしない。両軍の損害と生存、左に Details、右に Attack ボタンを置く（「文書で確認」`FEATURE-MAP.md`）。
- **予報の計算**（「コードで確認」`ui/features/military/battle/fight-forecast.ts` の `forecastAttack`）:
  - 契約と同じ計算でダイスの両端（攻撃側最悪 vs 防御側最良、とその逆）を求める。
  - "Worst roll: X · best: Y" と表示する（`quick-attack-preview.tsx` l.319）。
  - 総コストは "2 exchanges · 60 stamina" / "Out of stamina after 5 exchanges" / "One attack, then cooldown · 30 stamina"（`describeFightCost`）。
- **全滅確定の警告**: `HudNotice tone="bad" line="Certain loss at any roll"`（「コードで確認」`quick-attack-preview.tsx` l.508）。
  - 防御がいなければ "No defenders: claim it" / "No defenders: move adjacent to claim"。
  - ブロックの理由は "On cooldown" / "No troops selected" / "No guard in range"。
  - オプションに "Garrison survivors" のチェックがある。
- **Frontier には運の要素がない**: 「no dice are rolled, so a fight's forecast is its result」（「文書で確認」`frontier/index.mdx`）。コードでも `rollsDice` が false のときは両端を一致させている（「コードで確認」`fight-forecast.ts`）。
- **シミュレーター**: `BattleLab mode="sim"` はタイル選択パネルと未占有タイルのクアドラントから開ける（「コードで確認」`ui/features/world/components/actions/selected-worldmap-entity.tsx` l.71、`unoccupied-tile-quadrants.tsx` l.138）。live モードは `combat-modal.tsx`。
- **コーチとの連動**: 全滅確定の目標には近づかせず、先に level-up を勧める（「コードで確認」`coach.ts` の `certainLoss`）。
- **Raid**: `raid-container.tsx`、`raid-result.tsx` が HEAD にもある。文言の精査はしていない。

**OLD**

- Battle lab は sim と live を同じ画面で扱う。live でパラメータを触ると "Reset to act" でロックされ、誤って本番攻撃しない（良い設計）。
- 結果バナーは "Victory — the enemy is wiped out" 等。
- raid のプレビューは "Success Chance:"、"Your Casualties"、"Easy to raid! No defenders present."。

### 場面7: 不在からの復帰

**HEAD**

- **イベントの帯と Log**（「コードで確認」`ui/features/event-feed/*`、`events-filter-switch.tsx`、`words.ts`）:
  - 右列に最新3件の帯を置き、全件は **Log** で見る。
  - レンズは Blitz が Important（既定）/ All、Frontier の Feed が All（既定）/ Important / Mine。
  - 1行は結果まで含む文になる。例: "Explored · (4, 6): +5 points, +200 Essence"、"Army lost: 1,000 Knights · … vs The Vanguard"（「文書で確認」`FEATURE-MAP.md`）。
  - 行をクリックするとその場所へ飛ぶ。
- **未読数**: Frontier の Place bar で "Feed" の横に、前回読んだ後に届いた件数を出す（「コードで確認」`ui/features/frontier/hud/frontier-nav.tsx` の `unread`、`event-feed/unread-feed-count.test.tsx`）。
- **「不在中の要約」に相当するもの（Frontier）**: `DayDone` / day-done カード（「コードで確認」`ui/features/frontier/rollover/day-done.tsx`）。
  - 終わった日の合計、前日比の順位変化、軍が持ち帰った兵、Homecoming で次の出撃時に戻る分をまとめる。
  - コメントには「opening the game after it ended … this does」「the recap shows "until you act" (owner, 2026-10-25)」とある。日付をまたいで戻ったプレイヤーに、行動するまで要約を見せる。
  - 文言は "Day 12 done · Realm kept · Day 13 is open" と Continue（`words.ts` の `DAY_DONE` / `REALM_KEPT` / `DAY_OPEN`）。
- **Blitz / Eternum 向けの専用まとめ画面**: コードで未確認。ただし Log が全履歴を持ち、Next up の警告の先頭は「attacks, arrivals, an army lost」（「文書で確認」`FEATURE-MAP.md`）。
- **Web Push / メール通知**（「コードで確認」`apps/realms/server/shard-notifier.ts`、`packages/notifications/src/*`）:
  - レベルは off / important / standard / all（`preferences.ts`）。
  - 静音時間は端末時計で 22:00–08:00（`quiet-hours.ts`）。日開始の通知は 08:00 まで待たせ、他は捨てる。
  - **1日最大6件**（`DAILY_PUSH_CEILING = 6`）。
  - 対象は日開始（Frontier）、軍の休息完了、プレイヤー間の戦闘、DM、到着、約定など（「文書で確認」`FEATURE-MAP.md` Settings 節）。
  - 自分の操作では通知しない。
  - Frontier では "Remind me when Day N opens" で端末の通知をオンにでき、iPhone では "Add to Home Screen for reminders" と案内する（「コードで確認」`words.ts`）。
- **ニュース見出し**: マップ上部に8秒だけ出るバナー。対象はゲーム開始・realm / Hyperstructure の奪取・T3 建物・終了（「コードで確認」`ui/features/news-headlines/*` が存在。秒数は「文書で確認」）。
- **プレイヤー向けの通知はすべてイベントフィードに集約**:
  - コメントに「nothing renders outside the feed」とある。
  - 成功のトーストは「Never a chain action's」で、行動ごとのトランザクション行とストーリーで伝え、二重には告げない（「コードで確認」`ui/features/event-feed/notify.ts`）。
- **送信中と失敗のフィードバック**（全場面共通。「コードで確認」）:
  - `sendOnce` は対象ごとに1件しか送らない（二度押しをしても2件目のトランザクションにならない）。結果が出るまでボタンは押せず、`HudButton` は `busy` 文言・`aria-busy` を出す（`hooks/store/use-actions-in-flight.ts`、`ui/design-system/kit/hud-elements.tsx`）。
  - `untilApplied` はゲームへの適用までを待つ。無応答だった場合は「action may still apply」と扱い、自動で再送しない（`sync/action-outcome.ts`）。
  - 失敗は「拒否（news）」と「失敗（error）」に分ける。インラインの `ActionFailureNotice` を押した場所に出す（`event-feed/action-failure-notice.tsx`、`notify.ts` の `actionFailure`）。
  - 開発者向けの Action timeline（`?logs=1`）は送信の各段階を表示する（「文書で確認」`FEATURE-MAP.md`）。

**OLD**

- sonner トーストで "⏳ Transaction pending" → "Completed Action" / "❌ Transaction failed" / "⚠️ Transaction status uncertain" を出す（「コードで確認」筆者再確認 OLD `ui/shared/components/tx-emit.tsx` l.36, 44, 55）。
- Transactions ウィンドウに Stuck / Pending / Recent がある。
- 戦闘トーストは「On first load, mark all current events as "seen" so we don't spam toasts」で、20秒以内のものだけ出す（「コードで確認」筆者再確認 `ui/features/story-events/story-event-toast-bridge.tsx` l.29, 202, 287）。不在中の戦闘をまとめる画面はない（Explore 調査ではコードで未確認）。
- "⚠️ {name} under attack" の "View logs" は、遷移先の LeftView にレンダラが見当たらない（Explore の推測: 何も開かない）。

### 場面8: 敗北・出遅れからの再参加

**HEAD**

- **Blitz で全 realm を失ったとき**: HUD 左列に "Out of the game" パネルを出し、"You hold no realm." と表示する（「コードで確認」`ui/features/world/hud/out-of-game.tsx`）。
  - `FEATURE-MAP.md` は "You hold no realm. Watch until the end." と書くが、コードの定数は前半だけ。文書とコードがずれている。
  - その試合内での復活・再入植はコードで未確認。
  - 推測: その後は観戦を続けるか、Play から次のスロットに入り直す。Blitz は一定間隔で新しいスロットが立つ（「文書で確認」`blitz/entry.mdx`「A new Blitz slot starts every {BLITZ.game.slotMinutes} minutes」。分数は定数参照で、値は未確認）。
- **Blitz の締切**: 席は締切後に抽選され、抽選後は観戦（`resolveBlitzEntry`: 非メンバーは `"spectate"`）（「コードで確認」`ui/features/game-entry/game-entry-phase.ts`）。
- **Frontier は遅れて参加しても不利がない**:
  - 文書に「Entry is free and open for the whole season, so a player who arrives late starts the same way as one who arrived on day one」とある（「文書で確認」`frontier/index.mdx`）。
  - 毎日マップと軍はリセットされ、realm は資産ごと次のマップに再建される（"Realm kept"）。他のプレイヤーからの攻撃はない。
- **Eternum の追加入植**: "Settle another realm" ボタンは `isEternumDevMode` のときだけ出る（「コードで確認」`game-entry-modal.tsx`）。本番での追加入植・村の入植 UI は HEAD ではコードで未確認。
- **Results 画面**: 結果の後は "Continue"、チェスト（順位帯 "Top 20%" 等）を Open できる。Sword / Shield のクレジットは次回の参加費に使われる（「コードで確認」`words.ts` の `REWARD_WORDS`）。
- **観戦**: `?spectate=true`。終了したゲームも最終状態のマップを見られる（"See the end map"）（「文書で確認」`FEATURE-MAP.md`）。

**OLD**

- Blitz は登録期間後は Spectate だけで、途中参加・復活はコードで未確認（Explore）。
- 敗北時に出るのは全体の見出し "PLAYER ELIMINATED" だけ。個人向けの回復画面はコードで未確認。
- Eternum では入植済みでも "Settle" が見え、村の入植がある（Explore の推測: 追加拠点の主な経路）。

---

## 3. Issue・TODO・設計上の良い点

### 3.1 UX問題を述べた Issue（「Issueで報告」）

すべて closed（2026-10-29 時点）。「版」は作成日から推定した当時のクライアント。

| # | 日付 | 版（推定） | 内容 |
|---|---|---|---|
| [#3615](https://github.com/BibliothecaDAO/eternum/issues/3615) | 2025-09-18 | Blitz / OLD 系 | メニューが大きすぎて盤面を隠す。ズーム時のラベルも過密（playtest: Krumpy Lumpkins, squiddy） |
| [#3617](https://github.com/BibliothecaDAO/eternum/issues/3617) | 2025-09-18 | Blitz | 観戦モードでリーダーボードが見られない。全 realm 奪取後も Settle ボタンが有効 |
| [#3616](https://github.com/BibliothecaDAO/eternum/issues/3616) / [#3627](https://github.com/BibliothecaDAO/eternum/issues/3627) | 2025-09 | Blitz | 入植 tx が40秒以上止まる。終盤の操作が pending のまま固まる。ヘックスを「揺らさないと」クリックできない |
| [#3666](https://github.com/BibliothecaDAO/eternum/issues/3666) | 2025-09-28 | Blitz | 軍の行き先を選ぶメッセージ箱が他の候補を隠し、比較できない（Lord_kb） |
| [#3680](https://github.com/BibliothecaDAO/eternum/issues/3680) | 2025-09-29 | Blitz | 防衛スロット / 残高から攻撃軍へ兵を移す UI が分かりにくい（Defense / Balance 切替が隠れている） |
| [#3756](https://github.com/BibliothecaDAO/eternum/issues/3756) | 2025-10-13 | Blitz | 「Players don't notice when they have relics」。獲得時の通知だけ対応済み |
| [#3102](https://github.com/BibliothecaDAO/eternum/issues/3102) | 2025-05-09 | Eternum S1 | Labor の選択肢が目立たず、労働ルートの流れが分からない |
| [#3625](https://github.com/BibliothecaDAO/eternum/issues/3625) / [#3516](https://github.com/BibliothecaDAO/eternum/issues/3516) | 2025-07〜09 | Blitz | 輸送で資源の既定が未選択で手間（"player feedback"）。0量の資源を隠したい等 |
| [#3518](https://github.com/BibliothecaDAO/eternum/issues/3518) | 2025-07-25 | Blitz | realm ビューに入るのにクリックが多い。ダブルクリック要望（"player feedback"）。HEAD では実装済み（「文書で確認」`FEATURE-MAP.md`: double-click で realm ビュー） |
| [#3623](https://github.com/BibliothecaDAO/eternum/issues/3623) | 2025-09-22 | Blitz | 「資源があるように見えるのに建てられない」、建物数の表示、クイック建設 |
| [#4265](https://github.com/BibliothecaDAO/eternum/issues/4265) | 2026-02-20 | Blitz playtest god-mode-2 | 最初に出撃した軍がリロードまでクリック・移動できない |
| [#1701](https://github.com/BibliothecaDAO/eternum/issues/1701) | 2024-09-22 | Eternum 初期 | マップの俯瞰が難しい。POI・座標共有・検索の要望 |
| [#1994](https://github.com/BibliothecaDAO/eternum/issues/1994) | 2024-11-05 | Eternum 初期 | モバイルで軍を動かしにくい |
| [#707](https://github.com/BibliothecaDAO/eternum/issues/707) / [#1157](https://github.com/BibliothecaDAO/eternum/issues/1157) / [#1958](https://github.com/BibliothecaDAO/eternum/issues/1958) | 2024 | Eternum 初期 | walkthrough を開始直後に見せたい。チュートリアルを何度でもスキップできる（tx が飛ぶ）。「困ったらリロード」をオンボーディングに入れたい |
| [#5052](https://github.com/BibliothecaDAO/eternum/issues/5052) / [#5056](https://github.com/BibliothecaDAO/eternum/issues/5056) | 2026-10-16 | HEAD | 開発者自身の認識: "getting from 'what is this?' to 'I'm in a game' takes more steps and more screen-hunting than it should"。「every error state explains the next action」を完了条件にしている |
| [#5067](https://github.com/BibliothecaDAO/eternum/issues/5067) | 2026-10-16 | HEAD | HUD が二重に作られている（Blitz / Eternum 用と Frontier 用）。「neither is good on mobile」。5領域の共通オーバーレイに統合する |

**コード内の QA 痕跡**: `live-qa-night-1` / `live-qa-night-2` という社内QAの指摘番号がコメントに残っている（「コードで確認」HEAD）。

- `words.ts` l.47: HUD は "Tomorrow lasts 1d"、Play は "24h" と単位がずれていた。
- `chest-tile-details.tsx` l.15: 無効化された金色の "Move next to it" が、理由をホバーでしか言わなかった。
- `use-army-entity-detail` / `use-army-creation.ts` l.486: 出撃前に初期スタミナを示す。

### 3.2 UX関連の TODO

- HEAD: 非テストコードの TODO / FIXME は全体で3件だけで、いずれも `ui/shared/index.ts` の整理 TODO（「コードで確認」）。UX判断は TODO ではなく「(owner, 2026-10-27: …)」形式のオーナー裁定コメントで残す。非テストの `.ts` / `.tsx` に51箇所ある（「コードで確認」grep）。
- OLD: `travel-info.tsx:56` "hacky way to set can carry…"、`players-panel.tsx:27` "need to paginate"。わずかしかない（Explore）。

### 3.3 良い設計（比較で参考になる点）

- 「できない理由」と「直し方」を常にボタンの位置に出す（`Refusal{reason, fix}`、`shortfallLine` の held / need / wait）。
- 送信中は1件だけ・二度押し不可・無応答なら自動で再送しない。押した場所でインラインに失敗を伝える。
- 攻撃は予報を経てから送信する。最悪 / 最良のダイス幅と "Certain loss at any roll" を出す。
- 次の一手を1つに絞る Next up / コーチ（得点最大の行動、警告優先、Tips オフ可）。
- Frontier の日終わり要約（"until you act"）、通知の静音時間と1日6件の上限。
- 用語を1ファイルに集約し、「each spelled once」とする。
- OLD: AMM と order book の "Best" 比較、live / sim の誤爆防止ロック。

---

## 4. UX比較に効く、コードで裏付けた事実トップ10

1. **ウォレットなしで始められる**（HEAD）。Discord かメールのコードでアカウントができ、payout wallet は後から付ける（`shell/sign-in/start-step.tsx`、`words.ts` `WALLET_WORDS`）。OLD は Cartridge Controller 必須だった（`ui/layouts/sign-in-prompt-modal.tsx`）。
2. **入口は「次にやること」1つを金色で出す。** 無 realm のプレイヤーはまず無料の Frontier へ導く（`shell/play/play-board.ts` `LEAD_ORDER`）。
3. **入場は4段の可視トラック**（Account → Realm → Map → Play）。失敗は「どのサービスが応答しなかったか」の1行と Retry、マップ失敗時は "Open realm" という代替路がある（`doorway-view.ts`、`failure-lines.ts`）。
4. **専用の段階チュートリアル / クエストは HEAD に見当たらない。** 代わりに状況から次の一手を1つ出す Next up コーチがある（`world/hud/coach.ts`、`frontier/next-up/frontier-coach.ts`）。OLD の Lordpedia（12トピック）は呼び出し元が実質ない（`HintModalButton` の呼び出し2箇所はどちらも無効の分岐）。
5. **不足表示は「Needs X, have Y · in 待ち時間」で統一**し、裸の "2 / 3" を禁止している（`ui/design-system/kit/reasons.ts`）。建設不可の理由文は8種以上（`packages/core/src/automation/construction.ts`）。
6. **右クリック前にホバーでコストか拒否理由を1行出す**（"30 stamina · 100 wheat" / "Too far: move closer"）。マップの色の凡例を兼ねる（`frontier/hud/order-tip.ts`）。
7. **送信中は対象ごとに1件・二度押し不可。** 結果が「適用 / 拒否 / 無応答（まだ適用されうる）」のどれかを区別し、無応答なら自動で再送しない（`use-actions-in-flight.ts`、`sync/action-outcome.ts`）。通知はすべてイベントフィードに集約し、成功トーストは出さない（`event-feed/notify.ts`）。OLD は sonner で pending / success / failure / uncertain を毎回トーストしていた（`tx-emit.tsx`）。
8. **攻撃は予報経由**で、ダイスの最悪 / 最良の両端と "Certain loss at any roll" を示す。Frontier はダイスなしで「予報＝結果」（`military/battle/fight-forecast.ts`、`quick-attack-preview.tsx`）。
9. **不在からの復帰**: Frontier は日終わり要約を行動するまで見せる（`frontier/rollover/day-done.tsx`）。Push は静音 22–08 時・1日6件まで（`quiet-hours.ts`、`shard-notifier.ts`）。OLD は初回ロード時に既存イベントを既読化してトーストを出さず、要約もなかった（`story-event-toast-bridge.tsx`）。
10. **敗北後の扱い**: Blitz は "You hold no realm." を表示して観戦に回る（`world/hud/out-of-game.tsx`）。試合内の復活はコードで未確認。Frontier は無料・シーズン中いつでも参加でき、realm は毎日持ち越す（文書）。Eternum の追加入植ボタンは dev モード限定（`game-entry-modal.tsx`）。

## 5. 未解決の問い

- 本番の play.realms.party は HEAD（`a0fc902`）と同じか。デプロイされたコミットはコードからは分からない。ビルドタグ（`ui/layouts/build-tag.tsx`）を実機で読めば確かめられる。
- HEAD で Eternum モードは本番で遊べるか。Play は "when it opens" を出す実装になっている（`play-board.ts` `eternumItems`）。市場・部族・Hyperstructure 貢献の UX は、Eternum が開くまで実機で確認できない可能性がある。
- `FEATURE-MAP.md` とコードのずれ（"+5 points" の見返り表示、"Watch until the end." の文言）は、どちらが本番の挙動か。
- Blitz / Eternum のホバー命令 tip が Frontier と同じ `order-tip.ts` を使っているか。world map 側（`three/scenes/worldmap.tsx`、約4,000行超）の精査が要る。
- 経路のプレビュー（複数ヘックスの線と到着時刻）は HEAD にあるか（コードで未確認）。
- OLD の "View logs" は本当に何も開かないのか（Explore の推測。実機での確認が要る）。
- Issue は大半が 2025 年の Blitz playtest 由来で、HEAD（2026-10 の再設計）への新しいプレイヤーの声は Issue 上にほぼない。C（プレイヤーの声）の調査と突き合わせが要る。
- 読んだコードは shallow / sparse clone の各1コミットだけ。ブランチ `eternum-season-2`（2026-03）と `blitz-2`（2025-08）の UI は読んでいない。
