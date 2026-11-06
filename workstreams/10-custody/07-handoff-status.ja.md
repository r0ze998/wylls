# 07 引き渡しの現状（2026-11-03）：版・検証器・ABI 番号・⑨との接続

④が受け取るための整理です。**共有コアの再統合や仕様の確定はしていません**。番号はすべて仮で、④が②⑧⑨⑪⑱と照合して割り当てます。区別：**修正済み**（差分に入っていて試験した）／**未解決**（作業が残る）／**仕様判断待ち**（④・所有者の決定が要る）。

照合に使った origin のブランチ（2026-11-03 に fetch）：

| 担当 | ブランチ | 先端 |
|---|---|---|
| ⑧ | `preserve/ws08-cont-verify-b519cd18`（`preserve/ws08-continuous-e3d773df` を含む） | `b519cd18e203a75ec7921f01aef46b29f8f202ea` |
| ⑱ | `fix/ws18-clippy-hostile-20261103`（`preserve/ws18-4fbe0c77` を含む） | `0bba3f310085639732b038085211f7cb3af5a462` |
| ② | `preserve/ws02-rights-dc3bd3d` | `dc3bd3d93465eebb65f1815eb702ca779cc31827` |
| ⑨ | **origin にない** | — |

その他の `preserve/ws*` は、ABI の表（error・tags・log・layout・presets・ruleset）にも、⑩の core 差分が触るファイルにも手を入れていない（`git diff 4cd901de…` で確認）。

## 1. ABI 番号の一覧（衝突の判定用）

基準 4cd901de の使用済み：タグ 〜0xC0、AccountKind 〜22、EntityKind 〜12、記録種別（CqKind）〜103、CqError 62〜93（M1 は 1〜61 と 99）。

| 種類 | ⑩（core `96fe6abf`） | ⑧ | ② | ⑱ | 判定 |
|---|---|---|---|---|---|
| 命令タグ | 0xC1–0xCB（OpenLot … WithdrawLot、11 個） | **0xC1 ExtendFrontier** | 0xD0–0xD5（表の外に置いた提案） | なし | **衝突：0xC1** |
| AccountKind | 23 Lot | なし | なし（表の外） | なし | 衝突なし |
| EntityKind（記録の連鎖） | 13 Lot | なし | なし | なし | 衝突なし |
| 記録種別 CqKind | 104–112（LOT_OPENED … LOT_LOSS） | **104 FRONTIER_EXTENDED** | なし | なし | **衝突：104** |
| 記録種別の上限定数 | `MAX_KIND`・`MAX_KIND_V2` を 112 に | 同じ2定数を 104 に | — | — | 文字の衝突（値は大きい方でよい） |
| CqError | **94** CustodyCapacity、95 CustodyNoSlot、96 OrderExpired、97 LotForfeited、98 LotNotEmpty | **94 ContinuousWorld** | 表の外に置いた提案 | なし | **衝突：94** |
| seed タグ | `cl`（Lot） | なし | `gr`（Grant、表の外） | — | 衝突なし |
| 口座の予約領域 | Vault 232–297、Caravan 296–319 | Season の conquest block 77–80（別の口座） | なし | — | 衝突なし |
| 検証器の検査名・コード | `V26:custody-guard`、`CustodyInProgramWithoutIt`、`CustodyUnverified` | なし | なし | `V0`、`UnknownInstruction`・`UnverifiedInstruction`・`UnknownProgramVersion` | 名前の衝突なし。目的が重なる（§3） |
| プログラム版・ruleset | 版 5・`RULESET_HASH_V4`（`custody-preview` のときだけ） | 版・ハッシュは変えない（Season の `continuous` 欄） | — | 既知の版を 1〜4 に固定 | 衝突なし（§2） |

**error 94 について**：⑧が 94 を使うと、⑩に残るのは 95〜98 の **4 つ**で、⑩の 5 つは 99（M1 の既存コード）より下に収まらない。99 より上を使うかどうかは ABI の方針の変更（`codes_are_the_contract_table` 試験が「62 から連番、最後は 99」と固定している）。選択肢（決めていない）：(a) 100 以上を割り当てる、(b) ⑩のコードを 4 つにする（例：`LotNotEmpty` を既存のコードで表す）、(c) ⑧の番号を動かす。

**⑧が先に入る場合の、衝突しない割り当ての一例**（④の参考。⑩は採用していない）：タグ 0xC2–0xCC、記録種別 105–113、エラーは上の (a)〜(c) のどれか。

**適用の確認**：⑩の core パッチ 9 本は、⑱（`0bba3f31`）と②（`dc3bd3d9`）の先端には `git am -3` で全部当たる。⑧（`b519cd18`）には 0001 だけ当たり、0002 で ABI の表（error・tags・log・ix・budgets・prologue とベクタ）が衝突する（[results/apply-probe.log](results/apply-probe.log)）。⑱の `supported()` は `_ => false` なので、custody のタグは追加の分岐なしで「UnverifiedInstruction」になる（読んだだけ、組み合わせてのビルドはしていない）。**2026-11-05 訂正**：⑱に当てると `Ctx::unverifiable` が二重定義になり、検証器はコンパイルできない（[09](09-v26-state.ja.md) §5.2）。「当たる」は「ビルドできる」ではなかった。

## 2. V4 rules とプログラムのハッシュ

| 区分 | 内容 |
|---|---|
| 修正済み | custody を v3 の名で動かさない：既定ビルドは `RULESET_HASH_V3` = `234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d`（不変）・版 4 で、custody タグを `BadData`。`--features custody-preview` だけが `RULESET_HASH_V4` = `2f430c062fbc2f12f587ecfd46c38e572f303aa4cb6abc6b3d781547fdf48635`・版 5・規則 13 で、ハッシュ・版・dispatch が同時に切り替わる。`KERNEL_VERSIONS_V4` = V3 ＋ `custody` 1。V4 の固定値は kernels と一致する試験で守る。`PSF_CUSTODY_PREVIEW_BUILD` の印があるビルドは `build-frontier.sh` が配備用として拒否する。0009 は表を変えていない（V4 不変） |
| 未解決 | **プログラムのハッシュ（`.so` の SHA-256・program_hash）はない**：SBF ビルドをしていない（Agave の導入は許可されていない）。LiteSVM 試験、CU・読込量の測定、custody 用のプリセット（版 5 の Season パラメータ）がない |
| 仕様判断待ち | custody を独自の版 5 にするか、④・⑧の継続世界の版にまとめるか。⑧の `continuous` 欄・ExtendFrontier と同じ版に載せるなら V4 を作り直す。⑨のために木材・兵器を許すと `ENABLED_RESOURCES` が変わり V4 も変わる |

## 3. 検証器（V26）

| 区分 | 内容 |
|---|---|
| 修正済み | `V26:custody-guard`（core パッチ 0006）：custody の痕跡（着地した custody 命令、`LOT_*` 記録、Lot の CLOSE、Lot・custody の数・custody 欄を持つ口座）は、custody のないシーズンで FAIL、custody シーズンで UNVERIFIABLE。修正前は偽の custody 命令が PASS だった。試験 6 件通過（本日再実行） |
| 2026-11-05 追加 | core 差分 0010：口座だけで決まる法則の再判定（`V26:custody-state`、[09](09-v26-state.ja.md)）。法則違反は FAIL、未決の規則は UNVERIFIABLE、シーズンは PASS にならない |
| 未解決 | V26 の本体（命令の再生による再判定：署名・順序・予約 ≤ 保管・保管品の隊商、改ざん分類）。期間をまたぐ区画の検証（[06](06-continuity.ja.md) C7） |
| 仕様判断待ち | ⑱の V0（UnverifiedInstruction・UnknownProgramVersion）と目的が重なる。両方残すか、⑩のガードを V0 に寄せるか。組み合わせると、custody のないシーズンで着地した custody 命令は ⑩ の FAIL ＋ ⑱ の Unverifiable で FAIL、custody シーズン（版 5）は ⑱ が UnknownProgramVersion で止める。「V26」という名前も仮 |

## 4. ⑨との接続（資源・容量予約）

| 区分 | 内容 |
|---|---|
| 修正済み | 容量予約の範囲を固定した：倉の一般在庫を書くのは SendCaravan の引き落とし・上限つきの SettleCaravan・custody の書き戻しの 3 か所だけで、増えると試験が落ちる（`vault_stock_writers_are_the_listed_ones`）。予約の解放はちょうど一度（`tests/capacity.rs`） |
| 2026-11-05 追加 | ⑨のトレイトを⑩の区画で実装したアダプターと契約試験（[08](08-adapter-09.ja.md)）。以下の「未接続」はオンチェーンについて |
| 未解決 | **⑨とは未接続（オンチェーン）**。資源は鉱石だけ。加工中の物の状態、成果物の持ち主、他人が A の区画へ返す入口がない。⑨の成果物を倉へ入れる経路は、上の 3 か所と同じ上限処理が要る |
| 仕様判断待ち | 成果物の持ち主。木材（1）・兵器（`Horses` の欄、4）を許すか（口座の形は変わらない、V4 は変わる）。押収時の区画の扱い（⑩の提案、決定ではない）。②の stock-swap（鉱石・木材と兵器の交換、預かり付き）は⑨・⑩の「利用」と重なるので、④がどちらを使うか決める（番号の衝突はない） |
