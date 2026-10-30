# ② 契約案：Grant と工房在庫の交換権（StockSwap v1）

**状態：採用待ちの契約案。** 権利の検査・予約・実行・失効の契約は②が管理する。他の担当は、別の権利アカウントや別の検査経路を作らず、この案への変更要求として出す。下の tag・コード・seed・layout は**提案値**で、共有の表（`v2::Ix`、`CqError`、`AccountKind`、ログの kind）には入れていない。割当案は `06-EVENTS.ja.md` §3。

実装：
- ABI：`frontier-abi/src/v2/rights.rs`
- プログラム：`permutation-frontier/src/proc/rights.rs`
- パッチ：`patches/v1/`（前回の版は `patches/v0/` に保全）

## 1. 範囲

- 種類は **StockSwap（`kind = 1`）だけ**。施設がすでに作った武具と、利用者の鉱石・木材を交換する。加工の実行でも、生産能力の予約でもない（`02-SPEC.ja.md` §1）。
- 資源はゲーム内の倉の値のまま。SPL トークン、独自トークン、持ち分、融資、市場は含まない。
- 国（①）の判断とは独立。国の決定は、資産所有者の許可の代わりにならない。

## 2. 役割

| 役割 | 誰 | 鍵 |
|---|---|---|
| issuer | 施設の村の所有者の Citizen | 発行は財布だけ。取消は財布かセッション |
| grantee | 利用者の Citizen | 自分の財布か、自分のセッション |
| 誰でも（crank） | 誰でも | 期限切れ・世代切れの後の解放と、後始末 |

## 3. アカウント：Grant（272 B、chain なし）

アドレス：`with_seed(season_pda, "gr" ‖ hex(le64 issuer_tag ‖ le32 nonce), program)`

| off | 欄 | 型 | 意味 |
|---|---|---|---|
| 0 | MAGIC | [u8;8] | `PSF2GRNT` |
| 8 | SEASON_ID | u64 | |
| 16 | VERSION | u16 | 1 |
| 18 | KIND | u8 | 1 = StockSwap |
| 19 | STATE | u8 | 1 Active、2 Revoked |
| 20 / 21 | FACILITY_GEN / STATION_GEN | u8 | 発行時の世代 |
| 22 / 23 | FACILITY_SITE / STATION_SITE | u8 | |
| 24 / 26 | P / Q | i16 | 施設と受取口の州 |
| 28 | NONCE | u32 | |
| 32 / 64 | ISSUER_CITIZEN / GRANTEE_CITIZEN | [u8;32] | |
| 96 / 128 | FACILITY / STATION | [u8;32] | 2つの Holding のアドレス |
| 160 | ISSUER_TAG | u64 | |
| 168 / 176 | EXPIRES_TS / ISSUED_TS | i64 | |
| 184 / 186 | MAX_SWAPS / SWAPS | u16 | SWAPS は実行済みの交換の数で、`seq` の基準 |
| 188 / 192 | MAX_UNITS / UNITS_SWAPPED | u32 | |
| 196 | OPEN_UNITS | u32 | 0 = 預かりなし |
| 200 | OPEN_TS | i64 | |
| 208 / 216 | OPEN_ORE / OPEN_WOOD | i64 milli | 受取口側の預かり |
| 224 | OPEN_ARMS | i64 milli | 施設側の預かり |
| 232 | REVOKED_TS | i64 | |
| 240 | RENT_TO | [u8;32] | 発行時の payer |

`OPEN_UNITS ≠ 0` で、片側の `OPEN_*` だけが 0 でないとき：もう一方の側は戻し終えている。0 でない側は、戻し先がないため凍結している（§6）。

## 4. 命令

P = プレイヤー前処理 `[actor s] [payer s,w] [season r] [citizen w]`（署名、季節の PDA・Running・ruleset、Citizen、セッション、行動バケツ）。

| tag | 命令と data | アカウント | 署名 | 効果 |
|---|---|---|---|---|
| 0xD0 | IssueGrant `{nonce u32, kind u8, max_swaps u16, max_units u32, expires_ts i64}` | P + `[facility r] [province r] [grantee_citizen r] [station r] [grant w] [system]` | issuer の**財布** | Grant を作る（季節 PDA の AllocateWithSeed CPI） |
| 0xD1 | ReserveSwap `{units u32, seq u16}` | P + `[grant w] [facility w] [station w] [province r]` | grantee | 受取口から鉱石 `2u`・木材 `u`、施設から武具 `u` を預かる |
| 0xD2 | ExecuteSwap `{seq u16}` | 同上 | grantee | 預かりを相手側へ。`SWAPS += 1`。確定 |
| 0xD3 | ReleaseSwap `{}` | `[actor s] [season r] [grantee_citizen r] [grant w] [facility w] [station w] [province r]` | grantee、または期限切れ・世代切れの後は誰でも | 戻せる側を戻す。何も戻せなければ `ReturnBlocked` |
| 0xD4 | RevokeGrant `{}` | P + `[grant w] [facility w] [station w] [province r]` | issuer | 預かりを戻せるだけ戻す。`STATE = Revoked` |
| 0xD5 | CloseGrant `{}` | `[actor s] [season r] [grant w] [rent_to w]` | 誰でも | 預かりがなく、使えなくなった Grant の賃料を `RENT_TO` へ |

**Reserve・Execute の検査の順：** data → 書込みフラグ → P → Grant（所有者・大きさ・magic・季節・版・種類・再計算アドレス）→ grantee の一致 → Active → 期限 → 施設の固定 → 受取口の固定 → 州と占領ロック → 預かりの有無 → `seq` → 枠 → 資源。

Release と Close は、季節の状態を問わない。Issue・Reserve・Execute・Revoke は Running のときだけ。

## 5. エラー（提案コード 200–213）

| code | 名前 | いつ |
|---|---|---|
| 200 | BadGrant | Grant が偽物・別季節・別アドレス。渡したアカウントが Grant の記録と違う。同じ nonce の Grant がすでにある |
| 201 | NotGrantee | 役割の違う Citizen |
| 202 | Revoked | 取消済み |
| 203 | Expired | `now ≥ expires_ts` |
| 204 | QuotaExceeded | units が 0 または 10,000 超、回数・数量の超過 |
| 205 | ReservationOpen | 預かりが残っている |
| 206 | NoReservation | 実行・解放する預かりがない |
| 207 | StaleHolding | 施設か受取口の世代・所有者・生死が違う |
| 208 | NoWorkshop | 施設に工房がない |
| 209 | BadStation | 受取口が条件を満たさない |
| 210 | BadTerms | 種類・枠・期限が範囲外、自分宛て |
| 211 | StillLive | まだ使える、または預かりが残っている |
| 212 | **ReturnBlocked** | 解放で、どの側も戻せない（戻し先がない） |
| 213 | **SeqMismatch** | `seq` が実行済みの交換の数と違う（作り直した再送、または別の計画の手順） |

既存のコード：`Auth`、`SessionExpired`、`WalletRequired`(81)、`CapturePending`(62)、`Insufficient`、`NotOwner`、`BadAddress`、`BadAccount`、`TooManyAccounts`、`BadData`、`Bucket`、`WrongStatus`。

## 6. 取消・解放・占領・閉鎖

**取消と解放：**

| 場面 | 開いている予約 | 未使用の枠 | 実行済み |
|---|---|---|---|
| 利用者の ReleaseSwap | 両側とも戻る | 残る | 変わらない |
| 発行者の RevokeGrant | 戻せる側が戻る | **消える** | **戻らない** |
| 期限切れ | 誰でも解放できる | 使えない | 戻らない |
| 戻し先が満杯 | 上限を超えて入る（失われない） | — | — |
| 戻し先の村が消えた | その側は Grant に**凍結**。もう一方は戻る | — | — |

**占領（施設か受取口の世代が変わる）：**

| 占領された側 | 時点 | 資源とその場所 | 「元の場所へ戻す」で誰のものになるか | 既存の規則で決まるか |
|---|---|---|---|---|
| 施設 | 予約中 | 武具：Grant の預かり（発行者の分） | 施設の倉、つまり**占領者**のもの | **新しい判断。** 設計 20 §5（採用済み）は「奪われた倉の中身は奪った側のもの」。しかし預かりは、占領の時点で倉の中にない。占領者に渡すのは、§5 の精神に合わせた②の選択（代案は `04-PROPOSALS.ja.md` §3） |
| 施設 | 予約中 | 鉱石・木材：Grant の預かり（利用者の分） | 受取口（利用者のまま） | 決まる（受取口は占領されていない） |
| 受取口 | 予約中 | 鉱石・木材：預かり（利用者の分） | 受取口の倉、つまり**占領者**のもの | **新しい判断**（上と同じ理由） |
| 受取口 | 予約中 | 武具：預かり（発行者の分） | 施設（発行者のまま） | 決まる |
| 両方 | 予約中 | 両側 | それぞれの占領者 | 新しい判断 |
| どちらか | 実行後 | 倉の中の通常の資源 | 倉とともに占領者へ | **既存の規則で決まる**（倉の中身） |
| どちらか | 決着前（ロック中） | — | 待つ（`CapturePending`） | 既存の占領ロックの規則で決まる |
| どちらか | — | Grant そのもの | 使えなくなる（`StaleHolding`） | **新しい判断。** 20 §5 は、倉の持ち分・受け取りの札を無効にする。使用権への当てはめは類推 |
| 誰が戻せるか | 世代切れの後 | — | 誰でも（crank）。決着前は誰も戻せない | ②の選択 |

**焼却は採用していない。** 戻し先が消えた場合は凍結で、資源保存の例外かつ未決定事項（`04-PROPOSALS.ja.md` §3）。

## 7. 不変条件と脅威の対応

不変条件は `02-SPEC.ja.md` §6。脅威 T1–T22 とテストの対応は、`02-SPEC.ja.md` §7 と `README.ja.md` の表。

## 8. 他の担当への接続依頼

### ③ 公開 API・外部接続・MCP

- 命令の形は §4、data は `frontier_abi::v2::rights::*::to_bytes()`。チェーンの拒否コード（§5）をそのまま返す。②の検査を、クライアント側でもう一度実装しないこと。
- relay の `checkRelayShape` は、今は 0xD0–0xD5 を通さない。通すなら：
  - IssueGrant は「財布の署名が必要な形」にする。
  - エージェント鍵の直送の拒否（`AgentKeyDirect`）の対象にも入れる。
- MCP：能力トークンの範囲で ReserveSwap・ExecuteSwap・ReleaseSwap を出すなら、必ず `seq` を Grant から読んで付ける。IssueGrant と RevokeGrant は**出さない**（`NEVER_DELEGATED` に入れることを提案）。
- CPI：拒まない（`top_level_only` ではない）。外側の取引の署名しか伝わらないので、署名は偽造できない。呼ぶ側のプログラムが Grant を書き換えることもできない。

### ④ 複数段階の実行

- 段階の間で両側を押さえるには ReserveSwap、確定は ExecuteSwap、巻き戻しは ReleaseSwap。巻き戻しは実行の前でしか効かない。
- 各手順の `seq` は、計画の開始時に Grant の `SWAPS` を読んで決める。再送は `SeqMismatch` で安全に失敗する。
- 在庫がなければ予約は失敗する（待機状態はない）。再試行・期限・別の施設への切替は④の側で扱う。
- 予約を開いたまま期限が切れると、誰でも解放できる。

### ⑤ AI の参加・AI staking・予算管理・手動／自動の切替

- **Grant は、⑤の予算や操作制限の代わりにならない。** grantee のセッションは、Grant の外でも本人の全資産を動かせる（`05-DELEGATION.ja.md` §1、§2）。
- ⑤の予算（テスト USDC）は、Grant の `MAX_UNITS`・`MAX_SWAPS` とは別物。UI で同じものとして見せないこと。
- 代理 AI に Grant を使わせるなら：
  - 許可リストに ReserveSwap・ExecuteSwap・ReleaseSwap を、名前を付けて足す。
  - 手動への切替は、チェーン上の予約を止めない。予約が開いていれば、切替の時に ReleaseSwap を出すこと。
- AI staking には関与しない。

### ⑥ 作成・公開・再利用

- 「工房の貸し出し」のテンプレートは、IssueGrant の引数（量・回数・期限・受取口の条件）で表せる。ただし次のものは、v1 の範囲外：
  - **時間帯**（夜の分）
  - **1日あたり**の回数
  - **譲渡・転売・又貸し**
  - 複数の利用者への一括発行
- 公開された仕組みが他人の Grant を束ねる場合も、使う鍵は各 grantee のもの。束ねた側が他人の Grant を使う口はない。

### チェーンを読む側（検証器・キーパー・herald。担当未定）

- **統合前の必須課題：** PS2 の記録がない。検証器は、Holding を書く交換を FAIL にし（V7）、Grant だけの操作は見えない。再現と、必要な情報・割当案は `06-EVENTS.ja.md`。

## 9. 採用時に割り当てるもの

`06-EVENTS.ja.md` §3 にまとめた。プログラム版の二律背反（PlaceHome の版の一致）は `06-EVENTS.ja.md` §5。
