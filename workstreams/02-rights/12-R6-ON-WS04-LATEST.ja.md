# ② 第6回：④の最新の統合候補への移植と接続（隔離候補）

**状態：** 統合用の候補。④が取り込むかどうかは④が決める。次のことは**決めていない**：
- StockSwap の採用
- 加工能力の貸出（⑨）
- 委任の範囲
- 占領時の所有権
- 交換の比率・上限・期限など、経済の条件

**番号はすべて仮**（④の割当、改訂 3）：
- 命令 tag：0xD0–0xD5
- 記録の kind：114–119
- エラー：200–213
- AccountKind：24（予約。共有の enum には足していない）
- 版の bit：0x2000（今回新しく足した仮の値。§2）

## 1. 版と経路

| 項目 | 値 |
|---|---|
| ④の基準 | `cf517b558d1303a84dba618550f40cb460b7ad99` に移植した。その後、④の `fa822453`（`claude/gallant-ride-cunptv` の先端。④から連絡のあった `5ee66869` を含む）を**通常の merge で取り込んだ**。衝突はなかった |
| 移植の仕方 | ②の r5 の差分（`2c302c87`）を、④の tree の上に移した。古い tree で置き換えてはいない。④・⑩・⑳・wide の変更は、そのまま残した |
| ②の履歴 | `dc3bd3d`、`2c58034a`、`b72c4afd`、`2c302c87` は、strategy ours の merge で履歴にだけつないだ。古いコードは取り込んでいない。これで、④は GitHub から全部を取得できる |
| 担当ブランチ | `claude/modest-wozniak-xcc7d8`。どの commit も `[skip ci]` 付きで、通常の push（force なし） |

## 2. 本来のゲームへの接続

**受付：** プログラムの本物の `dispatch` が、6 命令を受け付ける。ただし、新しい feature `rights-experimental` の build だけである。
- **既定の build（本番）：** 0xD0–0xD5 は知らない tag として拒否する（`BadData`）。試験 `map_growth_default_build_refuses_the_grant_tags` で確かめた。
- **`rights-experimental` の build：**
  - `PROGRAM_VERSION` に仮の bit 0x2000 を立てる（`0x2004`）。⑳の 0x8000、wide の 0x4000 と同じやり方。
  - 版の違う Season（本番の S1 など）では、Grant の命令をすべて `RulesetMismatch` で拒否する。本番の世界には触らない（試験 `a_production_season_refuses_every_grant_instruction`）。
  - `custody-preview` とは同時に build できない（`compile_error`）。版の組み合わせは④が決める。

**状態の更新：** 6 命令は、村の在庫・Grant 口座・Citizen の chain を、PS2 記録と同じ原子的な処理の中で書く。これは第2回からの実装で、変えていない。

**host での試験：** 試験は、④の鍵を使わない map-growth の harness の子 module（`map_growth_runtime_tests::rights`）に移した。
- System program の stub、ログの取得、時計、直列の lock を④と共有する。
- ②が自前で持っていた CPI・時計・rent の差し替え（`host_test.rs`、`init.rs`・`prologue.rs` の変更）は**消した**。④の harness と④の init・prologue は変わらない。

**④などの依頼者から使う形（共有の ABI `frontier_abi::v2::rights`、鍵は不要）：**

| 名前 | 内容 |
|---|---|
| `accounts::{issue, use_grant, release, close}` と各添字 | 6 命令の口座の順・signer・writable。プログラムの試験と VR が同じ表を使うので、ずれない |
| `IssueGrant`／`ReserveSwap`／…`::to_bytes()` | 命令のデータ（既存） |
| `grant(ctx, issuer_tag, nonce)` | Grant の公開アドレス（with-seed）。既存 |
| `GrantView::read(bytes)` と `.status(now)` | Grant 口座の状態の読み取り。結果は次のどれか：<br>• `Usable { seq, swaps_left, units_left, expires_ts }`<br>• `Reserved { seq, units }`<br>• `Expired { open_units }`<br>• `Revoked { open_units }`<br>• `Spent`<br>助言だけで、プログラムが同じ命令の中で検査し直す |
| `runs_grants(pv)`、`PROGRAM_VERSION_RIGHTS_S1` | その版が Grant を実行するか |

**④の `ports::Rights` には直接つないでいない。**
- ④の `Rights::check(holder, facility, units)` は、④の模擬にある「施設の使用」（単位を使って加工する）の型である。
- ④の HANDOFF §1 は、これを StockSwap と同じものとして扱わないと決めている。
- つなぐと、StockSwap の採用と意味を②が勝手に決めることになる。そのため、読み取りと命令の組み立て方だけを用意した。adapter を書くかどうかは④が決める（§6）。

## 3. 検証器

| 検査 | 第6回の扱い |
|---|---|
| V0（⑱） | ④の帯の規則を保つ。<br>• Grant を実行する版（`runs_grants`）の、S1 の季節では、VR に任せる。<br>• S1 でなければ UNVERIFIABLE。<br>• **その他の既知の版（M1 の 1、本番 S1 の 4 など）では FAIL のまま**。<br>`known_version` に `0x2004` を足した。⑱向けの adapter（r4）は不要になった |
| V0E（⑪） | Grant の kind（114–119）は、⑳の 130 と同じ「出す命令の隣でだけ判定する kind」に入れた。最上位に Grant の命令がある取引の記録は VR が判定する。命令のない記録や CPI の記録は、V0E では `UnverifiedRecord` のまま。⑪の tripwire（`new_bands`）も通る |
| VR・V7 | 第4回の規則のまま：<br>• ログ欠落・CPI・事後状態不足は UNVERIFIABLE<br>• ログが完全なのに記録がなければ FAIL |

**誤って PASS にしないことの確認（署名なしの試験。base は rights build の季節に直したもの）：**

| 場合 | 結果 | 試験 |
|---|---|---|
| Grant を実行しない版の季節（版 1、版 4） | 7 命令すべてが V0 の FAIL（`UnknownInstruction`） | `a_grant_under_a_program_that_does_not_run_it_fails` |
| 未知の命令 0xFE・0xD9、未知の口座 | FAIL | `an_unknown_instruction_or_account_fails` |
| CPI（ログあり／なし） | UNVERIFIABLE と V7 の FAIL ／ FAIL | `a_grant_instruction_reached_by_cpi_is_never_a_pass` |
| ログ欠落（3 通り） | UNVERIFIABLE（VR・V7・V0E） | `a_grant_record_lost_with_the_logs_is_unverifiable_never_a_pass` |
| 記録の欠落（ログは完全） | FAIL | `a_missing_record_fails`、`whole_logs_without_the_record_still_fail` |
| 事後状態の不足（Grant・村・Citizen） | UNVERIFIABLE または FAIL | `missing_evidence_is_never_a_pass`、`post_states_short_of_the_writes_are_never_a_pass` |
| 正直な流れ | 指摘なし（base の CQ2 の artefact も消えた） | `the_honest_flow_adds_no_finding` |

## 4. ⑪への回帰例：V0E は S1 の口座の事後状態の欠落を見ない

**再現した。** 次の取引を作った。
- 前の取引の事後状態で知られた program 口座を、後の成功した取引が書込み可能で持つ。
- その取引の事後状態に、その口座がない。

結果：
- Citizen（対照）では、V0E は `MissingPostState` を出す。
- 次の 5 種類では、何も出さない：MarchState（`PSF1MRCH`）、Vault（`PSF1VALT`）、Caravan（`PSF1CRVN`）、Structure（`PSF1STRC`）、Nation（`PSF1NATN`）。

原因は、`v0_evidence::program_kind` が v1 の `frontier_abi::layout::AccountKind`（M1 の 17 種）で magic を引いていることである。

**渡すもの（どちらも②の差分を当てた後に当てる）：**

| ファイル | 内容 |
|---|---|
| `patches/for-ws11/0001a-regression-only.diff` | 回帰例の試験だけ（`v0e_asks_the_post_state_of_every_s1_kind`）。今の V0E では失敗する |
| `patches/for-ws11/0001-v0e-s1-account-kinds.diff` | 修正の案（v2 の `AccountKind` で引く。Holding は今までどおり除く）と、同じ試験 |

修正は⑪の判断である。②のブランチには当てていない。

## 5. 試験（鍵の生成・導出・署名を伴うものは実行していない）

**監査したこと：**
- 実行する試験のファイルと、そこから呼ぶ共通部品に、`Keypair`・署名・鍵の導出がないことを確かめた。
- PDA と with-seed のアドレス計算（公開の hash）は使う。

**実行しなかった試験：**

| 試験 | 理由 |
|---|---|
| `verify` の `coverage`・`record` | `Keypair` を作る |
| `verify` の `fixtures` | `fixture::march` が試験用の鍵で署名する（④の `ba8f77dc` の記録どおり） |
| LiteSVM、SBF、`svm-tests` | 署名を伴う |

結果は §7 の表にまとめる（push の後に記入する）。

## 6. ④への適用方法と残件

**適用方法：** 担当ブランチ `claude/modest-wozniak-xcc7d8` を、④の候補へ通常の merge で取り込む。
- このブランチは④の `fa822453` を含む。
- 共有のコードで②が変えるのは、`frontier-abi/src/v2/{log,mod,rights}.rs` と、§8 に挙げるファイルだけである。
- 既定の build の振る舞いは変わらない：0xD0–D5 を拒否する。記録の表に 6 つの kind が増える。V0・V0E は Grant を実行する版だけを区別する。

**④の作業として残るもの：**
1. 生成物の作り直し（`frontier-abi/vectors/v2/logs.json` と web SDK。`abi-vectors --check` は stale を出す）。
2. 版の bit 0x2000 と、`rights-experimental` の扱いを確定すること。
3. `ports::Rights` に adapter を書くかどうか（§2）。

**その他の残件：**
- 番号の確定。
- 本物の記録での再生（SBF・ローカルチェーン。署名を伴う）。
- ⑪が回帰例を受け取ること。
- 未決のルール（冒頭の一覧）。

## 7. 実行した試験の結果

（push の後に記入する。）

## 8. 変更したファイルの範囲

（push の後に記入する。）
