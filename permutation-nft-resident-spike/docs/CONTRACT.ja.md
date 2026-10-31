# 接続契約：NFT で譲渡できる住民アカウント（試作 v0、2026-10-31）

統合先：④（口座・認証の統合）。関連：③（session 鍵・ログイン）、⑤（MCP capability・AI 委任）、⑦⑫⑬⑯（番号の担当範囲はリポジトリに記録が無く、本書では**宛先未特定**。該当しそうな節に印を付けた）、⑰（x402・USDC 決済）。

この契約は、隔離した試作 `permutation-nft-resident-spike/` が実装し、`test/*.test.mjs` が検査する範囲を書く。**模擬と実物の境界**は §8。価格・発行数・販売方法・ロイヤリティは決めない（UNDECIDED.ja.md）。

## 1. 用語と不変条件

| 用語 | 定義 |
|---|---|
| asset | 住民 1 人に対応する Metaplex Core の資産アカウント（`AssetV1`）。発行元 collection は 1 つに固定 |
| 住民 ID（residentId） | `hex(sha256("PSF-RES" ‖ asset_id)[0..15])`。asset が存在する限り不変。ウォレットから導出しない |
| 保有者（holder） | asset の `owner` フィールドの現在値（チェーンから読む） |
| epoch | 住民ごとの「確認済みの保有者変更の回数」。買い戻しも 1 回と数える |
| 公開切替（publish） | 世界を「参加待ち」から「ログイン可」へ切り替える 1 ビット。住民記録・世界を作り直さない |
| 資格（eligibility） | 保有者であること。別の登録・引換券・支払い記録からは発生しない |

不変条件（テストが確認）:

- I1. 住民記録は**チェーン上で検証できた asset**から 1 回だけ作られる。通知・支払い・画面の表示からは作らない。（`registry.test.mjs`）
- I2. 保有者は常にチェーンの読取値。読取が「最後に確認した変更」より古い（`StaleRead`）か、読めない（`ChainUnavailable`）とき、**何も許可しない**。（`registry.test.mjs`, `auth.test.mjs`）
- I3. 全ての資格情報（ログイン token、MCP capability、AI 委任の記録、チェーン上の session 鍵）は保有者と epoch に束縛され、保有者変更で失効する。（`auth.test.mjs`, `transfer-loop.test.mjs`）
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
| (c) 実行時 | プログラム（`mock-chain.prologue`） | `actor == owner` または `actor == session.key && session.setBy == owner && 未失効`。それ以外は `NotOwner` |

**順序の規則**：
- **チェーンの実行順が境界**。譲渡 tx の前に実行された操作は成立し、結果は住民へ。後に実行された売り手の操作は (c) で拒否。
- 署名済み・未送信の売り手の取引は、後から届けば (c) で拒否。blockhash 期限切れは `BlockhashExpired`。**「NFT が移れば署名済み取引も消える」とは仮定しない**：消えないので (c) が必要。
- relay の (a)(b) は早期拒否のため。(b) と実行の間に譲渡が割り込む場合も (c) が守る（`transfer-loop.test.mjs` の race テスト）。
- 読取が古い（`StaleRead`）／読めない（`ChainUnavailable`）ときは拒否。「たぶんまだ保有者」とは扱わない。

## 5. 継続中の処理（③④⑤ との照合）

| 対象 | 規則 | 試作 | 統合条件 |
|---|---|---|---|
| 売り手のログイン状態 | 保有者変更の確認で失効（I3） | `auth.revokeBefore` | ④：relay のセッション層に epoch を持たせる |
| session 鍵（③） | チェーン：`SetSession` の設定者 ≠ 現保有者なら無効（INTEGRATION-04 案 B）。relay：`requesterCitizen` も同じ規則 | `prologue` の `setBy` | ③④：Citizen v2 に `SESSION_SETTER_TAG15` を追加（patches/02） |
| MCP capability（⑤） | 保有者の生きたログインの下でだけ発行。epoch 束縛。譲渡で失効 | `issueCapability` | ⑤：`AgentLedger.capabilityHash` に resident/epoch を添える（patches/03） |
| AI 委任（⑤） | relay 記録＋チェーン session 鍵の両方が epoch/設定者で失効。買い手が改めて委任すれば同じ agent 鍵でも動く | `recordDelegation`, `buildSetSession` | ⑤：`AgentGateway` の delegation 判定に保有者を加える（patches/03） |
| 署名・送信済みの操作 | チェーンの順序で決まる。relay は取り消さない | race テスト | — |
| 輸送中の隊商・加工中の注文 | 住民のもの。止めない。結果は住民へ（買い手） | `world.tick` | ⑫⑬（宛先未特定）：S1 の caravan/workshop は `OWNER_CITIZEN` 参照なので住民 ID 化で自動的に従う。要確認 |
| 費用確認待ち | 売り手の wallet+epoch に束縛。譲渡で void。買い手は改めて確認 | `approvals` | ⑤⑰：agent wallet の `held` hold は owner wallet のもの → 譲渡で `release`、`sending` は結果待ち（U3） |
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

- C1. Citizen の鍵付けを住民 ID（asset 由来）へ：既存の wallet 由来 Citizen は作り直さず、案 B（INTEGRATION-04）で `RESIDENT_ASSET_TAG15`・`SESSION_SETTER_TAG15` を v2 Citizen の予約領域（36 byte）に追加し、prologue の規則を広げる。LiteSVM テストが必要（本環境では SBF ツール無し）。
- C2. relay の `requesterCitizen`・agent wallet の delegation 判定に「asset の現保有者」を加える（patches/01, 03）。実 RPC で `StaleRead` の基準（slot/commitment）を決める。
- C3. 支払い＋発行の 1 取引化は、実署名者・スポンサー条件で実測してから（§6）。
- C4. 譲渡を一時停止する手段（Core Oracle プラグイン）を使うか（U7）。
- C5. 私的データ（会話・AI 記憶・封印情報）の扱い（U8〜U10）が決まるまで、買い手へ自動開示しない。
- C6. プログラム側で asset を読む方法：各プレイヤー命令に asset アカウントを渡し、Core プログラム所有・`AssetV1`・`Collection(期待値)`・`owner` を検査する（本試作の `verifyResidentAsset` と同じ順）。CU 予算への影響は未測定。
