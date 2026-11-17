# ② イベントと再生：統合前の必須課題

**状態：** 再現は済み。記録の種類は**割当案**だけで、統合パッチは作っていない（§4）。

## 1. 最小再現（実際の検証器で確認）

`frontier-node/crates/verify/tests/rights_replay.rs`（パッチ `v1/0003`）。検証器の本体 `verify_core::verify` を、記録済みの正直な季節 `land-program.json` に対して実行しました。この季節は、そのままなら PASS します。

| ケース | 足した取引 | 結果 |
|---|---|---|
| 対照 | 提案 tag 0xD2（ExecuteSwap）の取引。2つの Holding を**変えずに**書く | **PASS**、指摘なし |
| 交換 | 同じ取引。Holding を、パッチと同じ方法（`touch` なしの settle と credit）で書く。PS2 の記録はなし | **FAIL**。V7 `HoldingReplayMismatch` が2件（"a write that is not an owner action left the Holding's accrual state other than the rules do"） |
| Grant だけ | 提案 tag 0xD0（IssueGrant）の取引。未知の program アカウント（`PSF2GRNT`）を作る。Holding は書かない | **PASS**（V9 の情報警告1件だけ）。**未知の tag と未知のアカウントは拒否されない**。つまり Holding を書かない権利の操作（発行、予約のない取消、閉鎖）は、再生から**見えない** |

さらに、カーネルの `credited(before, 時刻, 量)` は、交換の後の Holding をバイト単位で作り直せました。`before` だけでは作り直せません。**再生に必要なのは、取引の時刻と、側ごとの移動量です。**

結論：今のまま統合すると、交換が1回でもあった季節は、検証器が FAIL にします。一方で、発行や閉鎖は誰にも見えません。どちらも統合を止める理由になります。

## 2. 操作ごとに、再生に必要な情報

識別子：Grant は `(season, issuer_tag u64, nonce u32)` で一意です（アドレスはここから導出されます）。記録の key は `issuer_tag ‖ nonce`（12 B）にします。隊商の `owner_tag ‖ seq` と同じ形です。

| 操作 | 状態の変化 | 記録に要る payload（案） | chain を進める entity |
|---|---|---|---|
| IssueGrant | Grant を作成（賃料、`RENT_TO`）。Holding は書かない | grantee の tag、施設の key（8）と世代、受取口の key（8）と世代、P・Q、kind、`max_swaps`、`max_units`、`expires_ts`、賃料 | issuer の Citizen |
| ReserveSwap | 受取口から鉱石・木材、施設から武具を引く（どちらも `touch` なしの settle と pay）。Grant の `OPEN_*` を書く。grantee の Citizen の行動バケツ | `seq`、`units`、鉱石・木材・武具（milli） | grantee の Citizen、受取口、施設 |
| ExecuteSwap | 受取口に武具、施設に鉱石・木材を credit。`SWAPS` と `UNITS_SWAPPED` | `seq`、3つの量 | grantee の Citizen、受取口、施設 |
| ReleaseSwap | 戻せる側を credit。戻せない側は Grant に残す | 呼び手の区別（grantee／期限切れ／世代切れ）、側ごとの「戻した量」と「残した量」 | 書いた Holding（grantee の P 前処理は通らないので、Citizen は書かない） |
| RevokeGrant | 解放と同じ処理と、`STATE`・`REVOKED_TS`。issuer の Citizen の行動バケツ | ReleaseSwap と同じものと、取消時刻 | issuer の Citizen、書いた Holding |
| CloseGrant | Grant の賃料を `RENT_TO` へ。アカウントを閉じる | 賃料、受取人 | （Holding は書かない）CLOSE と同様の記録 |

**検証器が足すべき規則（案）：**
- V7：Holding の継続性。tag 0xD1–0xD4 が書く Holding は、`before` を「`touch` なしの settle と、記録の量の pay／credit」にしたものと一致すること。
- 新しい再判定：Grant の保存。預かりの合計が、予約・実行・解放の量と一致すること。
- V9：Grant の種類と正規アドレス。
- 改ざんの型：量の書換え、`seq` の書換え、側の入れ替え。

## 3. 割当案（他担当と衝突しない範囲）

**状態：提案。** 採用時に統合担当が割り当てます。

| 項目 | 提案値 | 根拠 |
|---|---|---|
| 命令の tag | 0xD0–0xD5 | v2 の割当は 0x01–0x6x、0xA0–0xA7、0xB0–0xBE、0xC0。0xA4 と 0xA8–0xAF は予約済み |
| エラーコード | 200–213 | v2 の割当は 1–61、99、62–93 |
| PS2 記録の kind | 200 GRANT_ISSUED、201 SWAP_RESERVED、202 SWAP_EXECUTED、203 SWAP_RELEASED、204 GRANT_REVOKED、205 GRANT_CLOSED | 割当は 0–70、80–88、89（予約）、90–103。104 以降は次の段階に空けておく |
| seed | `gr` | 既存の seed tag にない |
| AccountKind | 23 Grant（採用時に）。今は独自の magic `PSF2GRNT` | v2 は 1–22 |
| EntityKind | Grant は chain にしない（記録は Citizen と Holding の chain に載せる） | Grant の数だけ chain を増やさない |

## 4. 統合パッチを作らなかった理由

記録を出すには、次の共有部分を同時に変える必要があります。
- 共有のログ表 `frontier_abi::v2::log::CQ_SPECS`。件数 23 がテストで固定され、ABI の vectors にも出ます。
- プログラムの `events::WIDTHS_V2`（上限 103）。
- 検証器の復号、V1・V7・V9 の規則、改ざんの型。

これは、チェーンを読む側の担当と統合担当の範囲です。②が先に作ると、番号と表を既成事実にしてしまいます。

渡すものは3つです。
1. §2 の仕様
2. §3 の割当案
3. **受け入れテスト**としての §1 の再現：記録と V7 の規則が入ったら、交換のケースが PASS に変わること。Grant だけのケースは、Grant の種類を検査する規則を足したら、Grant を認識していることの確認に変えること。

## 5. hash が変わらないことと、経済が変わらないことは別

- **rules カーネル**（`permutation-rules`）は変えていません。S1 の ruleset hash（`RULESET_HASH_V3`）も変わりません。
- それでも、**ゲームで許される経済操作は増えます。**
  - 同じ州の2人の間で、武具と鉱石・木材を固定の比で、**隊商を使わず、襲撃の危険なしに、その場で**交換できます。
  - 今は、他人へ資源を移すには、財布の署名つきの隊商（見えて、襲われる）が要ります。
  - 自分の別アカウントへ権利を出せば、同じ州の中で、自分の資源を襲撃なしに移す経路になります。資源は増えませんが、輸送の危険は回避できます。
  - 採否は経済の判断です（`04-PROPOSALS.ja.md` §4）。

| 対象 | 影響 |
|---|---|
| 命令 | tag 0xD0–0xD5 が増える。既存の命令は変わらない |
| ABI | `frontier_abi::v2::rights` を追加（既存の表は変えない）。プログラムの `Error` に `Rights` の variant を追加（プログラム内部） |
| プログラム版 | **二律背反（統合担当の判断が要る）。** `PROGRAM_VERSION` を上げると（4 → 5）、Season に記録された版（4）と食い違う。走っている S1 季節では **PlaceHome が `RulesetMismatch` で止まる**（`permutation-frontier/src/proc/citizen.rs:1173`）。CreateSeason も、パラメータの版と一致を要求する（`season.rs:290`）。上げなければ、同じ版番号のまま許される操作が変わる。案：**新しい季節にだけ配備**し、そこで版を上げる |
| relay | `checkRelayShape` は未知の tag を通さない。今の relay 経由では使えない（③） |
| 代理 AI の財布・MCP | 行動に含まれていない。財布を通しては使えない（③⑤） |
| 検証器 | Holding を書く操作は FAIL、Grant だけの操作は見えない（§1） |
| キーパー・herald | 何もしない（feed がない） |
| Web・wasm | 変わらない（rules が無変更） |
