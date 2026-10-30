# 0002 コアに案 B を組み込む場合の命令・口座・記録（案、未適用・未実行）

**位置づけ。** `ext-kernel` のホスト上の部品を Frontier プログラムに組み込むときの対応表。コード差分ではなく設計案で、共有コア（`frontier-abi`、`permutation-frontier`、`frontier-node/crates/verify`、`permutation-gateway` の relay）は変更していない。採用が決まったら integrator が M1 契約 §3.4 / I-55 の手順で取り込む前提。

## 1. 命令（タグ 0xD0–0xD5 を予約する案）

v2 の最大タグは `FastForward = 0xC0`（`frontier-abi/src/v2/tags.rs`）。拡張用に 0xD0 台を空けておく。

| タグ | 名前 | class | 署名 | 口座（案） | ext-kernel の対応 |
|---|---|---|---|---|---|
| 0xD0 | ExtWriteManifest(offset u16, bytes) | P（作者） | 作者 | [author s][payer s][buffer w] | 1,232 B の取引に収まらない manifest の分割書込（[02](../02-comparison.ja.md) §4）。buffer は `create_with_seed(season, "xb‖hex(author[..15])")` |
| 0xD1 | ExtPublish(supersedes: Option<[u8;32]>) | P（作者） | 作者 | [author s][payer s][season r][buffer w][registration w][old_registration r?][system] | `Registry::publish`：buffer を解読・静的検査し、`sha256` で id を計算、`create_with_seed(season, "xr‖hex(id[..15])")` に登録。buffer を閉じる |
| 0xD2 | ExtSetStatus(status u8) | N（作者か運営） | 作者または Season の運営鍵 | [signer s][season r][registration w] | `Registry::set_status`。取消は恒久 |
| 0xD3 | ExtGrant(grant) | P（利用者の wallet のみ） | Citizen の wallet | [wallet s][payer s][season r][citizen r][grant w][registration r][system] | `Host::set_grant`。session 鍵は不可 |
| 0xD4 | ExtCall(entry u8, args [i64;≤4], seq u64) | P | wallet か期限内の session（`player_prologue` と同じ） | [actor s][payer s][season r][citizen r][holding w][registration r][grant w][instance w][system] | `Host::call`。instance が無ければ payer が rent を払って作る（`max_instances` を registration の数で確認） |
| 0xD5 | ExtWithdraw(seq u64) | P | 同上 | [actor s][payer s][season r][citizen r][holding w][registration r][instance w] | `Host::withdraw`。登録が Paused / Revoked のときだけ |

全命令 `top_level_only = false`。ただし ExtCall の中からコアの他の命令や第三者のプログラムを CPI で呼ぶことはない（解釈器に呼出しの op がない）。

## 2. 口座（案）

| 口座 | 大きさ | 中身 | rent（計算値） |
|---|---|---|---|
| ExtRegistration `xr‖id` | 64 B のヘッダ＋manifest ≤1,024 B | magic、id、author、status、supersedes、`created`（instance 数）、履歴の最後の 8 件、manifest の byte 列 | 1,024 B のとき 8,463,360 lamports（作者負担） |
| ExtGrant `xg‖citizen_tag,id` | 214 B（magic 8＋citizen 32＋id 32＋entries 1＋per_call 64＋budget 64＋calls 4＋expiry 8＋revoked 1） | `grant.rs` の欄 | 2,380,320 lamports（利用者負担。取消で閉じて戻る案） |
| ExtInstance `xi‖citizen_tag,id` | 240 B（`examples/sizes.rs`） | seq、fields[8]、escrow[8]、last_receipt | 2,561,280 lamports（利用者負担） |

**閉じる操作は未設計。** 預かりが 0 で停止・取消済みの instance を閉じて rent を戻す命令が要る（`max_instances` の数え方も「作られた数」から「生きている数」へ変える必要がある）。

## 3. 記録（PS2 の新しい種別、案）

| 種別 | 中身 | 検証器の使い道 |
|---|---|---|
| EXT_PUBLISHED | id、author、supersedes | 登録の履歴の始点 |
| EXT_STATUS | id、status、ts | `history`（停止中の呼出しを FAIL に） |
| EXT_RECEIPT | Receipt v1 の byte 列（`receipt.rs`、引数 4 個・event 32 個で最大 約 430 B） | 再実行と照合（`verify.rs`） |

ログは 10 KB 程度で切れる（`Program log` の上限）ことに注意。1 命令 1 receipt なので収まる見込み（未測定）。

## 4. 既存の部品に要る変更（未適用）

| 部品 | 変更 | 理由 |
|---|---|---|
| `frontier-abi` tags / prologue / ix / log | 上のタグ・口座表・データ型・記録種別 | ABI の一部 |
| `permutation-frontier` | `ext` の処理。解釈器は `wylls-ext-kernel` を依存に足すか、`permutation-rules` に移す | — |
| Holding の書込 | ExtCall は `touch_owner` を**しない**（拡張の呼出しで休眠の時計を戻さない）。`Holding::pay`/`credit` のみ | 拡張がゲームの休眠規則に影響しないように。採否は⑤⑧の判断 |
| 再生検証器 V7 | `caravan_holding_write` と同じ形で「ExtCall／ExtWithdraw の Holding（決済と receipt の増減）」を足す。足さないと Holding の書込は「owner action でない書込」として FAIL になる（`v7_replay.rs`、事実（コード）） | 既存の検証器との整合 |
| 再生検証器 V2 | 知らないタグを UNVERIFIABLE にする（[0001](0001-verify-unknown-instruction-is-unverifiable.patch)） | 未知の操作を PASS にしない |
| relay | ExtCall を player shape として `classify` の許可表に足すか、relay では扱わない | ③ [05](https://github.com/r0ze998/wylls/blob/2f8ec700/workstreams/03-composability/05-relay.ja.md) |
| 検証器の入力 | 登録口座と instance の前後の状態、manifest の byte 列を archive に含める | `verify.rs` の `Evidence` |
