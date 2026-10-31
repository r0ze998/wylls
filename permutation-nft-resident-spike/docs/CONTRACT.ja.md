# 接続契約：NFT で譲渡できる住民アカウント（試作 v0、2026-10-31）

統合先：**④＝統合・実行基盤**（Citizen・prologue・relay・verifier の統合）。関連：**③＝MCP**（capability）、**⑤＝AI 参加・予算**（agent wallet・委任・hold）、**⑦＝UI**（waitlist 表示・ログイン・複数 asset の選択・譲渡後の案内）、**⑫＝記憶**（AI の非公開記憶）、**⑬＝AI 住民**（AI が操作する住民の譲渡）、**⑯＝独立検証**（verifier での actor・世代の再判定）、**⑰＝x402・USDC**（支払いと発行の分離）。

**改訂 v0.2（2026-10-31）**：§4 に保有者**世代**（`gen`）の規則、§10 に「何が世代更新を確実に起こすか」と制約を追加。継続世界は決定済み（U11 は移行方法の未決）。Metaplex Core は試作の選定方式で、本線採用は未決（U18）。

この契約は、隔離した試作 `permutation-nft-resident-spike/` が実装し、`test/*.test.mjs` が検査する範囲を書く。**模擬と実物の境界**は §8。価格・発行数・販売方法・ロイヤリティは決めない（UNDECIDED.ja.md）。

## 1. 用語と不変条件

| 用語 | 定義 |
|---|---|
| asset | 住民 1 人に対応する Metaplex Core の資産アカウント（`AssetV1`）。発行元 collection は 1 つに固定 |
| 住民 ID（residentId） | `hex(sha256("PSF-RES" ‖ asset_id)[0..15])`。asset が存在する限り不変。ウォレットから導出しない |
| 保有者（holder） | asset の `owner` フィールドの現在値（チェーンから読む） |
| 保有者世代（gen） | 住民プログラムの口座（Citizen）が持つ整数。プログラム経由の譲渡（`TransferResident`）ごとに +1 され、同時に session 鍵が消える。買い戻しも +1 |
| epoch（relay） | relay が資格情報を束縛する値 = チェーンの `gen` ＋ relay が観測した「世代更新を伴わない保有者変更」（ガード無し asset の迂回。ガード有りでは常に 0） |
| 公開切替（publish） | 世界を「参加待ち」から「ログイン可」へ切り替える 1 ビット。住民記録・世界を作り直さない |
| 資格（eligibility） | 保有者であること。別の登録・引換券・支払い記録からは発生しない |

不変条件（テストが確認）:

- I1. 住民記録は**チェーン上で検証できた asset**から 1 回だけ作られる。通知・支払い・画面の表示からは作らない。（`registry.test.mjs`）
- I2. 保有者は常にチェーンの読取値。読取が「最後に確認した変更」より古い（`StaleRead`）か、読めない（`ChainUnavailable`）とき、**何も許可しない**。（`registry.test.mjs`, `auth.test.mjs`）
- I3. 全ての資格情報（ログイン token、MCP capability、AI 委任の記録、チェーン上の session 鍵、署名済み操作）は保有者と世代に束縛され、保有者変更で失効する。**relay が途中の保有者変更を観測していなくても**、チェーンの世代が進んでいれば失効する。（`auth.test.mjs`, `transfer-loop.test.mjs`, `buyback.test.mjs`）
- I4. 操作の権限は**操作を認可する時点**と**送信直前**に保有者を読み直し、さらにプログラムの prologue が実行時に確認する。（`gateway.mjs`, `mock-chain.mjs`）
- I5. 公開切替・譲渡・再起動で住民記録と世界を作り直さない。（`registry.test.mjs`, `restart.test.mjs`）
- I6. 1 asset = 1 住民。複数 asset を持つウォレットは複数の住民を別々に操作し、片方の資格情報で他方を動かせない。（`transfer-loop.test.mjs`）
- I7. 支払い・発行・資格は 3 つの別の記録。1 支払いに発行は最大 1 回。結果不明の支払いからは発行しない。（`entry.test.mjs`）

## 2. 接続面（HTTP、`src/http.mjs`。実物では relay の `/f/*` に相当）

| 要求 | 応答 | 拒否コード |
|---|---|---|
| `GET /r/status?wallet=` | `{wallet, published, residents:[{residentId, assetId, epoch}], canLogin, onWaitlist}` | — |
| `GET /r/waitlist` | `{published, rows:[{residentId, assetId, holder, epoch, since, status: eligible|unconfirmed}]}` | — |
| `POST /r/challenge {address, assetId}` | `{nonce, text, expiresAt}`（text は SIWS 形。`Resources: - wylls:resident-asset:<assetId>` を含む） | `BadRequest` |
| `POST /r/login {address, assetId, nonce, text, signature}` | `{token, residentId, assetId, wallet, epoch, expiresAt}` | `NonceUnknown` `NonceUsed` `Expired` `BadMessage` `WrongDomain` `BadSignature` `NotHolder` `Unconfirmed`(503) `NotPublished`(409、`entitlement` 付き) |
| `POST /r/op {token, op:{residentId, name, …}, idempotencyKey, presigned?, approvalId?}` | `{ok, status: sent|refused|failed|awaiting-approval, signature?, code?, epoch, by}` | `BadCredential` `Expired` `OwnerChanged` `WrongResident` `ApprovalRequired` `ApprovalVoid` `Frozen` `StaleRead` `ChainUnavailable` `IdempotencyConflict`；チェーン側 `NotOwner` `BlockhashExpired` `AlreadyProcessed` |
| `POST /r/approve {token, approvalId}` | 承認記録 | `OwnerChanged` `ApprovalVoid` |
| `POST /r/notify {event}` | `{applied: confirmed|duplicate|unconfirmed|ignored}` | — |
| `POST /r/publish` | `{published: true, residents}` | （実物では運営トークン必須） |

**署名の所在**：保有者の鍵はブラウザから出ない。操作はブラウザが署名した取引（`presigned`）を token と共に送る（現行 relay の `POST /f/relay` と同じ形）。AI 委任は relay が持つ agent 鍵で署名する（現行 agent wallet の keyring と同じ）。

## 3. 住民記録の規則（registry）

1. **作成**：`observe(assetId)` がチェーンを読み、`verifyResidentAsset` が通ったときだけ記録を作る。判定は METHODS.ja.md §2（プログラム・key byte・collection・owner）。
2. **通知**：`ingest(event)` は署名で重複排除し、`observe` を促すだけ。読取が追い付かないときは `pending` に残し `reconcile()` で再試行。通知の中身（to/from）は**使わない**。
3. **変更の確定**：読取値の `owner` が記録と違えば `holder` を更新し `epoch += 1`、`holderSince.slot` を読取スロットに置く。以後その住民の読取は `slot ≥ holderSince.slot` を要求する。
4. **消失**：asset が無くなれば `gone` を付けて残す。再作成しない。
5. **collection の固定**：状態ファイルは collection を記録し、別の collection で開くことを拒む。
6. **ID 衝突**：同じ住民 ID を別 asset が導出したら `ResidentIdCollision` で拒否（統合しない）。

## 4. 権限判定と、譲渡と操作の競合の順序

判定点は 3 つ。どれか 1 つで落ちれば操作は成立しない。

| 判定点 | 誰が | 内容 |
|---|---|---|
| (a) 認可時 | relay（`auth.authorize`） | 資格情報の存在・期限 → `holderNow(assetId, {minSlot})` で保有者と epoch を読み直す。不一致なら `OwnerChanged` で**その住民の古い epoch の資格情報を全部失効** |
| (b) 送信直前 | relay（`gateway.submit` の beforeSend） | もう一度 `holderNow`。変わっていれば送らない（手数料も払わない） |
| (c) 実行時 | プログラム（`mock-chain.prologue`） | `actor == owner`、または `actor == session.key && session.setBy == owner && session.gen == gen && 未失効`。それ以外 `NotOwner`。さらに命令データの `gen` が現在の `gen` と違えば `StaleGen` |

**順序の規則**：
- **チェーンの実行順が境界**。譲渡 tx の前に実行された操作は成立し、結果は住民へ。後に実行された売り手の操作は (c) で拒否。
- 署名済み・未送信の売り手の取引は、後から届けば (c) で拒否。blockhash 期限切れは `BlockhashExpired`。**「NFT が移れば署名済み取引も消える」とは仮定しない**：消えないので (c) が必要。
- relay の (a)(b) は早期拒否のため。(b) と実行の間に譲渡が割り込む場合も (c) が守る（`transfer-loop.test.mjs` の race テスト）。
- 読取が古い（`StaleRead`）／読めない（`ChainUnavailable`）ときは拒否。「たぶんまだ保有者」とは扱わない。asset と Citizen（世代）は**同じスロット**で読む。
- **買い戻し（A→B→A）**：保有者は元に戻るが世代は 2 進む。A の旧 token・capability・委任・session 鍵・署名済み操作は全て拒否（`buyback.test.mjs`）。保証の根拠は §10。

## 5. 継続中の処理（③④⑤ との照合）

| 対象 | 規則 | 試作 | 統合条件 |
|---|---|---|---|
| 売り手のログイン状態 | 保有者変更の確認で失効（I3） | `auth.revokeBefore` | ④：relay のセッション層に epoch を持たせる |
| session 鍵（④） | チェーン：`SetSession` の設定者 ≠ 現保有者、または session の世代 ≠ 現世代なら無効；譲渡で session は消える。relay：`requesterCitizen` も同じ規則 | `prologue` の `setBy`/`gen` | ④：Citizen v2 に `SESSION_SETTER_TAG15`・`HOLDER_GEN` を追加（patches/02） |
| MCP capability（③） | 保有者の生きたログインの下でだけ発行。世代束縛。譲渡で失効 | `issueCapability` | ③：`AgentLedger.capabilityHash` に resident/世代を添える |
| AI 委任（⑤⑬） | relay 記録＋チェーン session 鍵の両方が世代/設定者で失効。買い手が改めて委任すれば同じ agent 鍵でも動く | `recordDelegation`, `buildSetSession` | ⑤：`AgentGateway` の delegation 判定に保有者を加える（patches/03） |
| 署名・送信済みの操作 | チェーンの順序で決まる。relay は取り消さない | race テスト | — |
| 輸送中の隊商・加工中の注文 | 住民のもの。止めない。結果は住民へ（買い手） | `world.tick` | ④⑯：S1 の caravan/workshop は `OWNER_CITIZEN` 参照なので住民 ID 化で自動的に従う。verifier（⑯）で確認 |
| 費用確認待ち | 売り手の wallet+世代に束縛。譲渡で void。買い手は改めて確認 | `approvals` | ⑤⑰：agent wallet の `held` hold は owner wallet のもの → 譲渡で `release`、`sending` は結果待ち（U3） |
| AI 住民の譲渡（⑬⑫） | AI が操作する住民も同じ規則。AI の非公開記憶は自動で移さない（U9） | — | ⑬⑫ |
| 表示（⑦） | waitlist・ログイン・複数 asset の選択・譲渡後の「もう保有者ではない」案内は読取値のみから描く。表示だけで資格を与えない | `GET /r/status`, `/r/waitlist` | ⑦ |
| 未確定の支払い・inference の hold（⑰⑤） | ウォレットのもの。住民と混ぜない | — | U3 |

## 6. waitlist と決済（⑰）

状態：`payment ∈ {pending, settled, failed, unknown}`、`mint ∈ {none, sent, minted}`、`eligibility = holder == wallet`（記録ではなく読取）。

規則（`entry.test.mjs`）:
1. `pay` は idempotencyKey で冪等。二重押し・再送は記録済みの結果を返す。別ウォレットの同じ鍵は `IdempotencyConflict`。
2. `unknown` の支払いからは発行しない（`PaymentUnknown`）。後の照会で `settled` と判れば、その時点で 1 回だけ発行。
3. `mintFor` は送信**前**に intent を保存し、送信後に記録する。送信と記録の間で落ちたら `recover` が memo（intent id）でチェーン上の発行を探す。見つからなければ `MintUnknown` のまま、**盲目的に再発行しない**。
4. 発行の重複通知は署名で排除（1 住民）。
5. 資格は registry の保有者から導く。支払い記録に「資格あり」の列は持たない。
6. waitlist の表示は `GET /r/waitlist` / `GET /r/status` で、再読込・再起動・譲渡後も同じ読取規則で同じ答えになる（`restart.test.mjs`、`http.test.mjs`）。売却後の旧保有者は `onWaitlist: false`、新保有者は `true`。

**支払いと発行を 1 取引にできるか**：Core の collection への mint は collection authority の署名を要する。現行 relay は利用者の取引に fee payer・join gate の署名を**追加**する形（`/f/x402/join` の atomic モード）なので、`[USDC 転送, Core create]` を 1 取引にして relay が collection authority として共同署名する構成は**可能性がある**。ただし、実際の署名者集合（payer, collection authority, asset keypair, fee payer）、x402 facilitator の検査（「exactly one instruction」等の現行規則に反する）、スポンサーの drain guard・allowance の下で成立するかは**実チェーンで確かめるまで原子的と呼ばない**。試作は別々の処理として扱い、§6 の 1〜3 で二重発行を防ぐ。→ 統合条件 C3。

## 7. 必須テストとの対応

| 要求 | テスト |
|---|---|
| 偽物の NFT、同名の別 collection、古い保有情報、他人の署名を拒否 | `core-asset.test.mjs`（look-alikes）、`registry.test.mjs`（stale notification、lagging reader）、`auth.test.mjs`（B が A の challenge に署名、改変文面、別ドメイン）、`transfer-loop.test.mjs`（偽署名の tx） |
| 署名の再送、二重押し、支払い結果不明、取得通知の重複 | `auth.test.mjs`（nonce 二重送信）、`transfer-loop.test.mjs`（AlreadyProcessed、idempotencyKey 再送）、`entry.test.mjs`（unknown、二重押し、通知重複） |
| 譲渡とゲーム操作の競合、譲渡後の旧 session・MCP・AI 操作 | `transfer-loop.test.mjs`（the loop、chain order、relay 内 race） |
| 譲渡前に署名済みの操作が後から届く | `transfer-loop.test.mjs`（presigned → NotOwner、BlockhashExpired） |
| 再起動、RPC の遅延・欠落、住民 ID の重複生成 | `restart.test.mjs`、`registry.test.mjs`（lag、unavailable、concurrent observe、collision） |
| NFT が複数、売り手が買い戻し | `transfer-loop.test.mjs`（several NFTs / buy-back）、`registry.test.mjs`（epochs） |

## 8. 模擬と実物の境界

| 層 | 試作 | 実物（統合時） |
|---|---|---|
| asset のバイト列と判定 | `encodeAssetV1` が作る実物同形の bytes を `decodeAssetV1`／`verifyResidentAsset` が読む（**実物の判定ロジック**） | RPC `getAccountInfo(asset)` の bytes を同じ関数に通す。プラグイン領域（frozen 等）の復号は未実装 |
| チェーン | `MockChain`（スロット、履歴、署名検証、実行順、session、prologue） | Solana + Core プログラム + Frontier プログラム。prologue の規則は patches/02 の提案 |
| RPC の遅延・欠落 | `reader({lagSlots, fail})` | 実 RPC の commitment と履歴の有無（agent wallet DESIGN §6.7 の規則を流用） |
| 通知 | `chain.eventsSince` / `POST /r/notify` | インデクサ webhook／自分の送信結果。中身は信用しない |
| 支払い | `MockPaymentRail`（settled/failed/unknown を台本で） | x402 facilitator（`/f/x402/join` 系）。⑰ |
| 発行 | `chain.mint`（collection authority = relay の鍵） | Core `createV1`（collection authority 署名）。鍵の管理は未決（U2） |
| ログイン | SIWS 形の文面 + node:crypto ed25519 | Wallet Standard `signIn` / `signMessage`。文面の検証規則は同じ |
| 世界 | `World`（最小の村） | Frontier の Holding/Province/S1。住民 ID 化は INTEGRATION-04 |
| 永続化 | JSON 1 ファイル（tmp+rename） | relay の state store（同方式） |

## 9. 統合条件（安全に決められない部分）

- C1. Citizen の鍵付けを住民 ID（asset 由来）へ：既存の wallet 由来 Citizen は作り直さず、案 B（INTEGRATION-04）で `RESIDENT_ASSET_TAG15`・`SESSION_SETTER_TAG15`・`HOLDER_GEN` を v2 Citizen の予約領域（36 byte）に追加し、prologue の規則を広げる。LiteSVM テストが必要（本環境では SBF ツール無し、未実行）。
- C2. relay の `requesterCitizen`・agent wallet の delegation 判定に「asset の現保有者」を加える（patches/01, 03）。実 RPC で `StaleRead` の基準（slot/commitment）を決める。
- C3. 支払い＋発行の 1 取引化は、実署名者・スポンサー条件で実測してから（§6）。
- C4. 譲渡を一時停止する手段（Core Oracle プラグイン）を使うか（U7）。
- C5. 私的データ（会話・AI 記憶・封印情報）の扱い（U8〜U10）が決まるまで、買い手へ自動開示しない。
- C6. プログラム側で asset を読む方法：各プレイヤー命令に asset アカウントを渡し、Core プログラム所有・`AssetV1`・`Collection(期待値)`・`owner` を検査する（本試作の `verifyResidentAsset` と同じ順）。CU 予算への影響は未測定。
- C7. 譲渡ガード（§10 の D）を実 Core で確かめる：Permanent Freeze Delegate 下で Permanent Transfer Delegate の CPI 譲渡（forceApprove）が通ること、owner の plain transfer が拒否されること、マーケットプレイスの listing/escrow が動かないことの影響（U7）。
- C8. ⑯：verifier が各命令の actor を「その時点の asset.owner・SESSION_SETTER・HOLDER_GEN」で再判定できるよう、履歴を持つノードから asset と Citizen を命令スロットで読む。

## 10. 何が世代更新を確実に起こすか（買い戻しへの保証と制約）

**問題**：`SESSION_SETTER_TAG15 == tag15(現保有者)` だけでは、A→B→A で保有者が A に戻った瞬間、A が昔設定した session 鍵・A が昔署名した操作が再び通る。relay の epoch も、途中の B を**観測していなければ**進まない。模擬コードが自動で epoch を進めるだけでは保証にならない。

**チェーン上で確実に起こすには**、「譲渡が起きたら必ずプログラムが動く」構造が要る。通常の Core 譲渡（`transferV1`、owner 署名）は asset の `owner` を書き換えるだけで、我々のプログラムもゲームの Citizen も触らない（公式：「Transfer only changes ownership」）。よって**ガード無しでは迂回できる**（`buyback.test.mjs` 最終テストで実証：世代 0 のまま A の旧 session が通る）。

| 候補 | 仕組み（公式資料で確認した範囲） | 保証 | 制約 |
|---|---|---|---|
| **D（試作が模擬）** | asset を **Permanent Freeze Delegate**（凍結、authority = プログラム）＋ **Permanent Transfer Delegate**（authority = プログラム）付きで発行。どちらも「作成時のみ追加でき、譲渡後も失効しない」。凍結中は owner の譲渡が拒否される（「Frozen Assets cannot be transferred」）。Permanent Transfer Delegate は「forceApprove — can transfer even when frozen」。プログラムの `TransferResident`（現保有者が署名）が CPI で譲渡し、同じ取引で `HOLDER_GEN += 1`・session 消去 | **構造的**：asset が動く経路がプログラムだけなので、世代更新を伴わない保有者変更は存在しない。relay が何も観測しなくても次の読取で世代が進んでいる | 発行時に付ける（既発行の asset には付けられない）。**マーケットプレイスの通常の listing・escrow 譲渡が動かない**（売買はプログラムが用意する経路か、`TransferResident` を呼ぶ連携が要る）。ウォレットが「frozen」と表示する。Permanent Transfer Delegate が凍結下で本当に通るかは実 Core で未確認（C7） |
| C | collection または asset に **Oracle 外部プラグイン**。Core は `transfer` 前に Oracle 口座を読み、`Rejected` なら拒否（公式：Oracle は reject のみ）。プログラムが「許可中（宛先 B 用 PDA `["mpl-core", recipient]`、PreconfiguredRecipient）」を書くときだけ譲渡が通り、その書き込み命令で世代を進める | 譲渡の**前**に必ずプログラム命令が要るので世代は進む。宛先ごとの PDA なら 1 回の許可で 1 回の譲渡 | Oracle 口座の作成・家賃・解除の管理。collection レベルの Oracle が全 asset に効くかは公式に明記なし（要確認）。マーケットプレイスの escrow 宛先は事前許可できない（同じ制約） |
| ガード無し | 通常の Core 譲渡のまま。relay の観測で epoch を進める | **保証なし**。未観測の A→B→A で旧権限が復活（実証済み）。緩和：relay が全譲渡をインデクサで購読し、`bypassed` を検知したら住民の全資格情報を失効させる——しかし取りこぼしは防げない | マーケットプレイスと両立 |

**試作の採用**：D を模擬（`mock-chain.mjs` の `guard`、`TransferResident`、`StaleGen`）。**保証できること**：D または C を採る限り、A→B→A で旧 session・capability・委任・署名済み操作は復活しない（世代が命令データと session 記録に含まれるため）。**保証できないこと**：ガード無しの通常 Core 譲渡では復活を防げない。**決めるべきこと**：U7（D か C か、マーケットプレイス非互換を受け入れるか）。本線で Core を採るかも未決（U18）。
