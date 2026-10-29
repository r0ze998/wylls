# ② 契約案：Grant と施設利用権（WorkshopUse v0）

**状態：採用待ちの契約案。** この領域（権利の検査・予約・消費・失効）の契約は②が管理する。他の担当は、別の権利アカウントや別の検査を作らず、この案への変更要求として出す。下の tag・エラーコード・seed・layout は**提案値**で、共有 ABI の表（`v2::Ix`, `CqError`, `AccountKind`）には入れていない。採用時に統合担当が割り当てる（§9）。

実装：`frontier-abi/src/v2/rights.rs`（ABI）、`permutation-frontier/src/proc/rights.rs`（プログラム）。パッチ：`patches/`。

## 1. 範囲

- 権利の種類は **WorkshopUse（`kind = 1`）だけ**。
- 資源はゲーム内の倉の値のまま。SPL トークンに置き換えない。独自トークン・持ち分・融資・市場は含まない。
- 国（①）の判断とは独立。国の決定は、資産所有者の許可の代わりにならない。

## 2. 役割

| 役割 | 誰 | 鍵 |
|---|---|---|
| issuer | 施設の村の所有者の Citizen | 発行：財布だけ。取消：財布かセッション |
| grantee | 利用者の Citizen | 財布か、自分のセッション |
| crank | 誰でも | 期限切れ・世代切れの解放と、後始末だけ |

## 3. アカウント：Grant（272 B、chain なし）

アドレス：`with_seed(season_pda, "gr" ‖ hex(le64 issuer_tag ‖ le32 nonce), program)`。`issuer_tag = citizen_tag(issuer_citizen)`。

| off | 欄 | 型 | 意味 |
|---|---|---|---|
| 0 | MAGIC | [u8;8] | `PSF2GRNT` |
| 8 | SEASON_ID | u64 | |
| 16 | VERSION | u16 | 1 |
| 18 | KIND | u8 | 1 = WorkshopUse |
| 19 | STATE | u8 | 1 Active, 2 Revoked |
| 20 / 21 | FACILITY_GEN / STATION_GEN | u8 | 発行時の世代 |
| 22 / 23 | FACILITY_SITE / STATION_SITE | u8 | |
| 24 / 26 | P / Q | i16 | 施設と受取口の州 |
| 28 | NONCE | u32 | |
| 32 | ISSUER_CITIZEN | [u8;32] | |
| 64 | GRANTEE_CITIZEN | [u8;32] | |
| 96 | FACILITY | [u8;32] | 施設の Holding のアドレス |
| 128 | STATION | [u8;32] | 受取口の Holding のアドレス |
| 160 | ISSUER_TAG | u64 | |
| 168 | EXPIRES_TS | i64 | |
| 176 | ISSUED_TS | i64 | |
| 184 | MAX_USES | u16 | |
| 186 | USES | u16 | 消費した予約の数 |
| 188 | MAX_UNITS | u32 | |
| 192 | UNITS_CONSUMED | u32 | |
| 196 | OPEN_UNITS | u32 | 0 = 予約なし |
| 200 | OPEN_TS | i64 | |
| 208 / 216 / 224 | OPEN_ORE / OPEN_WOOD / OPEN_ARMS | i64 | 預かり（milli）。比が後で変わっても、戻す量は記録した量 |
| 232 | REVOKED_TS | i64 | |
| 240 | RENT_TO | [u8;32] | 発行時の payer |

## 4. 命令

P = プレイヤー前処理 `[actor s] [payer s,w] [season r] [citizen w]`（署名・季節 PDA・Running・ruleset・Citizen・セッション・行動バケツ）。

| tag | 命令 | アカウント（P の後） | 署名 | 効果 |
|---|---|---|---|---|
| 0xD0 | IssueGrant `{nonce u32, kind u8, max_uses u16, max_units u32, expires_ts i64}` | `[facility r] [province r] [grantee_citizen r] [station r] [grant w] [system]` | issuer の**財布** | Grant を作る。施設は issuer の生きた村で、工房 ≥1、占領ロックなし。受取口は grantee の生きた村で、同じ州・別の村・ロックなし。条件は `terms_ok` |
| 0xD1 | ReserveUse `{units u32}` | `[grant w] [facility w] [station w] [province r]` | grantee | 受取口から鉱石 `2u`・木材 `u`、施設から武具 `u` を預かる。全部か、何もしないか |
| 0xD2 | ConsumeUse `{}` | 同上 | grantee | 武具を受取口へ、鉱石・木材を施設へ。`USES += 1`、`UNITS_CONSUMED += u`。確定 |
| 0xD3 | ReleaseUse `{}` | `[actor s] [season r] [grantee_citizen r] [grant w] [facility w] [station w] [province r]`（P なし） | grantee、または期限切れ・世代切れ後は誰でも | 予約を両側とも戻す（§6） |
| 0xD4 | RevokeGrant `{}` | P + `[grant w] [facility w] [station w] [province r]` | issuer（財布かセッション） | 予約があれば戻す。`STATE = Revoked` |
| 0xD5 | CloseGrant `{}` | `[actor s] [season r] [grant w] [rent_to w]` | 誰でも | 予約なし、かつ取消・期限切れ・枠切れのとき、賃料を `RENT_TO` へ |

**検査の順（Reserve/Consume）：** データ → 書込みフラグ → P → Grant（所有者・大きさ・magic・季節・版・種類・再計算アドレス）→ grantee 一致 → Active → 期限 → 施設の固定 → 受取口の固定 → 州と占領ロック → 予約の有無 → 枠 → 資源。

Release と Close は季節の状態を問わない（季節の終了後も、戻すことと後始末ができる）。Reserve・Consume・Revoke・Issue は Running のときだけ。

## 5. エラー（提案コード 200–211）

| code | 名前 | いつ |
|---|---|---|
| 200 | BadGrant | Grant が偽物・別季節・別アドレス。または、渡した施設・受取口・賃料の送り先が Grant の記録と違う。または、同じ nonce の Grant がすでにある |
| 201 | NotGrantee | 役割の違う Citizen（利用・解放で grantee でない、取消で issuer でない） |
| 202 | Revoked | 取消済み |
| 203 | Expired | `now ≥ expires_ts` |
| 204 | QuotaExceeded | `units` が 0 または 10,000 を超える、回数・数量の超過 |
| 205 | ReservationOpen | 予約がすでに開いている |
| 206 | NoReservation | 消費・解放する予約がない |
| 207 | StaleHolding | 施設か受取口の世代・所有者・生死が、発行時と違う |
| 208 | NoWorkshop | 施設に工房がない |
| 209 | BadStation | 受取口が grantee の生きた村でない、州が違う、施設と同じ |
| 210 | BadTerms | 種類・枠・期限が範囲外、自分宛て |
| 211 | StillLive | まだ使える、または預かりがあるのに閉じようとした |

既存のコードも返る：`Auth`、`SessionExpired`、`WalletRequired`(81)、`CapturePending`(62)、`Insufficient`、`NotOwner`、`BadAddress`、`BadAccount`、`TooManyAccounts`、`BadData`、`Bucket`、`WrongStatus`。

## 6. 取消・解放・占領（v0 で実装した規則）

| 場面 | 開いている予約 | 未使用の枠 | 消費済み |
|---|---|---|---|
| 利用者が ReleaseUse | 両側とも戻る | 残る（何も消費していない） | 変わらない |
| 発行者が RevokeGrant | 両側とも戻る | 消える | **戻らない**（利用者の武具も、施設の材料も、そのまま） |
| 期限切れ | 誰でも解放でき、両側とも戻る | 使えない | 戻らない |
| 施設か受取口が占領された | 決着前は待つ（`CapturePending`）。決着後は誰でも解放でき、**今その場所を持つ者の倉へ**戻る（設計 20 §5〔採用済み〕：奪われた倉の中身は奪った側のもの） | 使えない（`StaleHolding`） | 戻らない |
| 戻し先の村がもうない（解放済み・閉鎖） | その側は失われる。もう一方は戻る | — | — |

**約束しないこと：** 消費済みの資源は返さない。施設の武具が予約の前に使われていれば、予約は `Insufficient` で失敗する。権利は、施設の在庫が尽きないことを保証しない。代案（占領時に焼く／発行者に戻す）は `04-PROPOSALS.ja.md` §3。

## 7. 不変条件

`02-SPEC.ja.md` §3 の1〜7。テストの対応は `README.ja.md` の表。

## 8. 他の担当への契約案

担当名と範囲は依頼文のものだけを使う（③ 公開命令と CPI 接続、④ 複数段階の実行）。⑤・⑥ は、依頼文に範囲の定義がない。下では、**チェーンを読む側**と**クライアント・代理 AI 側**に分けて書いた。⑤・⑥への割り当ては、各担当の確認が必要。

### 8.1 ③（公開命令と CPI 接続）へ

- 命令の形は §4、data は `frontier_abi::v2::rights::{IssueGrant, ReserveUse, …}::to_bytes()`。②の検査を、クライアント側でもう一度実装しないこと。チェーンの拒否コードをそのまま返す。
- **relay の形の許可**（`checkRelayShape`）は、0xD0–0xD5 を今は通さない。通すなら、IssueGrant を「財布の署名が必要な形」に分類する。エージェント鍵の relay 直送の拒否（`AgentKeyDirect`）の対象にも入れる。
- **CPI：** プログラムは、これらの命令が CPI で呼ばれることを拒まない（`top_level_only` ではない）。署名は外側の取引から伝わるだけなので、他のプログラムが利用者の署名を偽ることはできない。呼ぶ側のプログラムが Grant を作ったり書き換えたりすることもできない。CPI 専用の口を作るなら、この表の命令を呼び、別の検査経路を作らないこと。
- 代理 AI の `ACTION_GROUPS` に入れるなら、ReserveUse・ConsumeUse・ReleaseUse だけを候補にする。**IssueGrant と RevokeGrant は、代理に任せない一覧（`NEVER_DELEGATED`）に入れる**ことを提案する。財布だけの IssueGrant は、セッション鍵ではもともと実行できない。

### 8.2 ④（複数段階の実行）へ

- 段階の間で資源を押さえるには ReserveUse を使う。予約は Grant 1つにつき同時に1つ。段階が失敗したら ReleaseUse（利用者の鍵）で両側を戻す。
- 消費（ConsumeUse）は確定で、取り消せない。④の「巻き戻し」は、消費の前でしか効かない。
- 予約が開いたまま期限が切れると、**誰でも**解放できる。④の計画は、期限より前に消費するか、自分で解放すること。
- 予約の量は、そのときの武具 1 あたりの比（`ORE_PER_ARM`, `WOOD_PER_ARM`）で決まり、Grant に記録される。

### 8.3 チェーンを読む側（検証器・キーパー・herald）へ

- **前提条件（未実装）：** 現在の PS2 ログには、これらの記録の種類がない。v0 の命令は、chain の記録なしで村の倉を書き換える。今の検証器で再生すると、倉が合わず、改ざんとして検出されるはず（未確認）。**採用する前に**、次の記録の種類を割り当て、検証器に再判定（V 番号）と改ざんの型（T 番号）を足す必要がある。
  - `GRANT_ISSUED`（Citizen issuer、施設の Holding）
  - `GRANT_RESERVED`、`GRANT_CONSUMED`、`GRANT_RELEASED`（施設と受取口の Holding。量は milli の3値）
  - `GRANT_REVOKED`、`GRANT_CLOSED`
- キーパーの仕事はない。期限切れの解放と後始末は、誰が送ってもよい精算（D 級相当）として扱える。
- herald は、Grant アカウントを §3 の layout で読めば、権利の一覧（施設ごと・利用者ごと）を出せる。

### 8.4 クライアント・代理 AI 側（UI・MCP）へ

- 表示する文言：「この権利は、施設の倉にある武具を、あなたの材料と交換で受け取る権利です。施設の在庫は保証されません。予約した分は、取消のときも戻ります。消費した分は戻りません。」
- 代理 AI の**予算**（テスト USDC）は、権利の上限ではない。上限は Grant の `MAX_UNITS` と `MAX_USES` だけ。UI で混同させないこと。

## 9. 採用時に割り当てるもの

| 項目 | 提案値 | 衝突の確認 |
|---|---|---|
| tag | 0xD0–0xD5 | v2 の `Ix::from_tag` にない（テスト `tags_and_codes_do_not_collide_with_v2`） |
| エラー | 200–211 | v2 の `Code::from_code` にない（同テスト） |
| seed | `gr` | v1・v2 の seed tag にない |
| AccountKind | なし（独自の magic `PSF2GRNT`） | 採用時に `AccountKind` 23 などへ |
| PS2 記録の種類 | §8.3 | 未割り当て |
| PROGRAM_VERSION | 配備するなら上げる | ruleset hash は変わらない（rules カーネルは無変更） |
