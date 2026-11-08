# ④ への提案：NFT に紐付く住民 ID と、現在操作するウォレットを分ける（2026-10-31）

## 1. 現状の確認（コードで確かめた事実）

| 事実 | 根拠 |
|---|---|
| Citizen のアドレスは **season PDA × ウォレット**から導出される：`addr(Citizen) = create_with_seed(season_pda, "ct" ‖ hex(tag15), program)`, `tag15 = sha256("PSF-CIT" ‖ wallet)[0..15]` | `frontier-abi/src/addr.rs:177-179, 323-327`、`permutation-rules/src/frontier/addr.rs` |
| Citizen は `WALLET`(64) `SESSION`(96) `SESSION_EXPIRY`(128) を持つ。v1 レイアウトは `RSV @ 312` に 72 byte、**現行の v2 レイアウトは `RSV_348 @ 348` に 36 byte** の予約 | `frontier-abi/src/layout/player.rs:5-38`、`frontier-abi/src/v2/layout/player.rs:5-46` |
| プレイヤー prologue：`actor == wallet`、または `session_ok` のとき `actor == SESSION && now < SESSION_EXPIRY` | `frontier-abi/src/prologue.rs:1080-1135`、`permutation-frontier/src/proc/citizen.rs`（`player`） |
| `SetSession` はウォレット署名のみ（session 鍵は自分を差し替えられない） | `citizen.rs` `set_session`（`player(p, a, now, false)`） |
| Join は `wallet` 署名で Citizen を作り、`session` と `session_expiry` を data で受ける。season ごとに 1 Citizen | `citizen.rs` `join` |
| relay は `requesterCitizen` で「Citizen の wallet か未失効の session」を確認し、agent wallet は `SESSION == agentKey` を委任の根拠にする | `permutation-gateway/src/frontier/routes/relay.mjs:60-75`、`agent/gateway.mjs:479-482, 625-631` |
| ブラウザの session 鍵は `sha256("PS/frontier-session/v1" ‖ wallet 署名)` で導出され、`ps-fsession:<cluster>:<program>:<season>:<wallet>` に保存 | `permutation-server/web/frontier/fsession.mjs` |
| 賞金の Entry は `entryAddress(prize.program, pool, wallet)`：**ウォレット鍵** | `routes/prize.mjs`（`GET /f/prize?wallet=`、`claim`） |

したがって今の Citizen は「ウォレット＝所有者」「season＝寿命」で、本件の「asset＝所有者、継続世界」とは**異なる**。これを無理に書き換えず、以下を提案する。

## 2. 提案：住民 ID（asset 由来）と操作ウォレット（現保有者）の分離

### 案 B（推奨）：既存 Citizen を残し、予約領域に住民フィールドを足す

**注意（コードで確認）**：現在の S1 プログラム（program version 4）が使う Citizen は **v2 レイアウト**（`frontier-abi/src/v2/layout/player.rs`）で、予約は `RSV_348 @ 348 : rsv 36` の **36 byte** しかない（v1 レイアウト `layout/player.rs` の `RSV @ 312 : 72` は M1 のもの）。32 byte の鍵を 2 本は入らないので、Citizen の address と同じ **15 byte タグ**（120 bit）で持つ。

```
Citizen v2 (384 B)
  … 既存フィールドは不変 …
  RESIDENT_ASSET_TAG15 @ 348 : [u8;15]   sha256("PSF-RES" ‖ asset)[0..15]（全 0 = 旧来のウォレット束縛 Citizen）
  SESSION_SETTER_TAG15 @ 363 : [u8;15]   sha256("PSF-CIT" ‖ SetSession 時点の保有者)[0..15]（既存の citizen_tag15 と同じ関数）
  RESIDENT_FLAGS       @ 378 : u8        bit0 = bound（住民化済み）
  HOLDER_GEN           @ 379 : u32       保有者世代。TransferResident ごとに +1、同時に SESSION を消す
  RSV_383              @ 383 : rsv 1
```

**譲渡ガード（CONTRACT §10 の D）**：住民 asset は Permanent Freeze Delegate（凍結）＋ Permanent Transfer Delegate（authority = Frontier プログラムの PDA）付きで発行し、譲渡は新命令 `TransferResident`（現保有者が署名、プログラムが CPI で Core の transfer を forceApprove）だけで行う。この命令が `HOLDER_GEN += 1` と `SESSION = 0` を同じ取引で行うので、「世代更新を伴わない保有者変更」は構造的に存在しない。マーケットプレイス非互換は U7。

prologue の規則（`RESIDENT_FLAGS.bound` のとき）:

1. 命令は asset アカウントを 1 つ余分に受ける。Core プログラム所有・key byte `AssetV1`・`update_authority == Collection(世界が固定する collection)` を検査し、`residentTag15(asset.key) == RESIDENT_ASSET_TAG15` でこの Citizen の asset であることを確かめる（`BadAddress`/`BadAccount`）。
2. `holder = asset.owner`。`actor == holder` なら通す。
3. `session_ok` かつ `actor == SESSION && now < SESSION_EXPIRY && citizen_tag15(holder) == SESSION_SETTER_TAG15` なら通す。**設定者が現保有者でなければ session は無効**。さらに `TransferResident` が SESSION を消すので、買い戻し後も旧 session は残らない。
4. 命令データに `holder_gen` を含め、`Citizen.HOLDER_GEN` と違えば `StaleGen`（新コード）。署名済み・未送信の命令が世代をまたいで届くのを止める（同じウォレットが買い戻した場合も含む）。
5. それ以外 `Auth`。

`bound` でない Citizen は現行規則のまま（移行を強制しない）。

アドレス：新規の住民 Citizen は `tag15 = sha256("PSF-RES" ‖ asset)[0..15]`（試作の `ids.mjs` と同じ）で、`ct` と別の新タグ（例 `rc`）を使い、既存の名前空間と衝突させない。新規住民 Citizen では asset が address から導出できるので `RESIDENT_ASSET_TAG15` は整合性確認用。**既存口座の移行**は「bind」命令（ウォレット署名＋asset の現保有者 = そのウォレット）で `RESIDENT_ASSET_TAG15` と `bound` を書くだけに留め、アドレスは変えない（Holding の `OWNER_CITIZEN` 参照が壊れない）。

### 案 A（比較）：Citizen のアドレスを asset 由来にして作り直す

全 Citizen・Holding・transit の参照を書き換える移行が要る。継続世界で履歴を保つ方針に反するので非推奨。

### 案 C（比較）：relay だけで保有者を見る（プログラムは触らない）

relay を迂回して RPC へ直送する売り手の鍵・session 鍵を止められない（agent wallet DESIGN §5.1 が既に同じ限界を記している）。**認可の最終判定はプログラム**でなければならないので、単独では不可。案 B と併用（relay の早期拒否）。

## 3. 影響の整理

### 3.1 口座の移行

| 対象 | 影響 |
|---|---|
| 既存の wallet 束縛 Citizen | そのまま動く（`RESIDENT_ASSET = 0`）。bind で住民化できる。bind は 1 回で、別 asset への付け替えは不可（U6） |
| season ごとの Citizen | 継続世界は決定済み。現行の Citizen は season PDA 配下に作られるので、**移行方法**（季節を戦期と読み替えて同じアカウントを持ち越すか、世界単位の派生へ移すか）を決める必要がある（U11）。期間境界で住民・所有・進行を失わせる案は取らない |
| Join | 住民化した世界では「asset を持っていること」が Join の条件。`join_gate`（招待）と `Pay+Join`（x402）の両経路に「asset の保有者署名」を加える形。発行＝waitlist なので Join 時に別の支払いは要らない（⑰ と要調整） |

### 3.2 委任（session 鍵・agent wallet・MCP）

| 対象 | 影響 |
|---|---|
| `SetSession` | 署名者は**現保有者**。`SESSION_SETTER_TAG15` に保有者のタグを書く。買い手は譲渡後に自分で打ち直す |
| ブラウザの session 鍵の保存キー | `…:<season>:<wallet>` のままで良いが、`matchesCitizen` に「住民の保有者が自分か」を足す（patches/04） |
| agent wallet | `delegation()` が `SESSION == agentKey` に加えて `SESSION_SETTER_TAG15 == tag15(asset.owner) && asset.owner == rec.owner` を見る。`owner` の意味が「agent を作ったウォレット」から「作った時点の保有者」へ。譲渡後、同じ agent を買い手が使うには買い手名義で作り直す（預け金はウォレットのもの、U3） |
| MCP capability | `AgentLedger` の capability に resident/epoch を添え、保有者変更で `rotate` 相当に失効させる（patches/03） |

### 3.3 所有権検査（verifier・herald・relay）

| 対象 | 影響 |
|---|---|
| verifier（`frontier-verify`） | 命令ごとの actor 検査に「asset の owner / SESSION_SETTER」を再現する。asset アカウントの状態を**命令実行時のスロットで**読む必要がある（履歴を持つノードが要る） |
| herald `/h/me/{wallet}` | `f.ctx.citizen(wallet)` で Citizen を引いている（`views.rs:126-128`）。住民化後は「wallet が保有する asset → 住民 Citizen」の逆引きが要る（DAS `getAssetsByOwner` か registry） |
| relay `requesterCitizen` | wallet or session に加えて asset 保有者（patches/01）。読取の鮮度（`StaleRead`）基準を決める |
| 賞金 `Entry` | ウォレット鍵のまま。**未受取賞金は売り手に残る**のが現コードの帰結（U4） |

## 4. 試作が示したこと／示していないこと

- 示した：案 B の prologue 規則（`setBy == owner`、`gen`）で、譲渡後に売り手の session・agent 鍵・署名済み操作の直送が落ちること（`transfer-loop.test.mjs`）、A→B→A を relay が観測しなくても世代で全て落ちること（`buyback.test.mjs`）、ガード無しでは復活すること（同、最終テスト）。relay の 2 段の保有者読取と、読取の鮮度での拒否。
- 示していない：実 Core での Permanent Transfer Delegate の凍結下 CPI 譲渡、実プログラムでの CU、LiteSVM、asset アカウントの読取 API（Core の plugin 領域）、継続世界への Citizen の移行（U11）。
