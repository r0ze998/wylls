# ② 検証範囲と、SBF・LiteSVM の実行手順

**結論：** 本体の `dispatch` を使った host-native の検証までは完了。SBF・LiteSVM・PS2 記録の再生への接続は未完了。**CU・取引の大きさ・実機での原子性を確かめるまで、本番で使えるとはしない。**

## 1. host-native で、本物のコードが動いている検査

ハーネス：`permutation-frontier/src/proc/rights_tests.rs`。`crate::dispatch` をネイティブで呼ぶ。

| 検査 | 動くコード |
|---|---|
| 命令の振り分け | `permutation_frontier::dispatch`（0xD0–0xD5 は v2 の表の前で分岐）、既存の命令（SetSession・Harvest・Vote）も同じ入口から |
| 署名・書込みフラグの**プログラム側**の検査 | プレイヤー前処理（`frontier_abi::prologue::player_prologue`）、各ハンドラの `writable`・`is_signer` の確認 |
| セッション・期限・財布専用 | 前処理の `SESSION`・`SESSION_EXPIRY`、`by_session` |
| 季節・アドレス | 季節の PDA の再計算（sha256）、Citizen・Holding・Province・Grant の正規アドレス、季節 id |
| 村のカーネル | `settle_tiered`、`pay`、`credit`、`write_holding`、連続生産（工房の変換を含む） |
| 占領ロック | `capture_lock`（州の写しの世代） |
| アカウントの作成と閉鎖のプログラム側 | `init::init_with_seed` の呼び出しの手順、`init::close_to`（`resize(0)`・`assign`・lamports の移動） |

## 2. テスト用のものが代わりに担っている検査

| 代替しているもの | 実機では | ハーネスでは（`host_test.rs`、`cfg(test)` だけ） |
|---|---|---|
| Clock | Clock sysvar | スレッドごとの時刻 |
| Rent | Rent sysvar | `frontier_abi::layout::rent` の式 |
| System プログラム | 本物の System プログラム | Transfer・Allocate・Assign・AllocateWithSeed を真似る。署名者、PDA の seed（`sha256(seeds ‖ program ‖ "ProgramDerivedAddress")`）、with-seed アドレスを検査する |
| CPI | ランタイムの CPI（アカウントの同期、権限の昇格の規則、深さ） | 上の関数を直接呼ぶ。同期や昇格の規則はない |
| 署名 | ed25519 の検証 | テストが `is_signer` を立てる |
| 所有者・書込み・lamports の規則 | ランタイムが命令の後に検査する | `World::runtime_rules` が**近似**する：成功した命令の後に、lamports の合計不変、変わったのは writable なアカウントだけ、データの変更は自プログラム所有か新規作成だけ、lamports が出るのは自プログラム所有か署名者だけ |
| 失敗時のロールバック | 取引の原子性 | テストが命令の前の状態を保存し、失敗したら戻す |
| アカウントの大きさの変更 | シリアライズされた領域の realloc | 8 B の前置きつきで確保したバッファに置き換える |

## 3. Solana の実行環境で未確認の部分

| 項目 | 未確認の理由 | 確認する手段 |
|---|---|---|
| PDA の署名（季節 PDA の `invoke_signed`） | seed の検査は真似ただけ | LiteSVM の `rights_round_trip_on_sbf_within_cu_and_size`（Grant が本物の System プログラムで作られること） |
| CPI | 同期・昇格・深さは真似ていない | 同上 |
| 所有者・writable の制約 | ランタイムの拒否は近似 | `signers_sessions_and_flags_on_sbf` |
| 失敗時のロールバック | テストが巻き戻しただけ | `a_failed_reserve_is_rolled_back_by_the_runtime`（受取口を引いた後に施設が足りない場合） |
| CU | 未測定 | 上の LiteSVM のテストが出力する。受け入れの上限の案は 200,000 CU |
| 取引の大きさ | 未測定（IssueGrant は 10 アカウント） | 同上。上限 1,232 B |
| アカウントのロード上限（SIMD-0186） | 未測定 | svm-tests の `loaded` |
| SBF の再配置の不具合（`events.rs` の注記：静的オブジェクトへのポインタ表は、低い語が落ちる） | rights のコードは表を使わず `match` だけ。ただし未確認 | `scripts/build-frontier.sh` の再配置の検査 |
| `build-frontier.sh` の検査（e_flags、overflow checks、テスト用の印がないこと） | 未実行 | 同スクリプト |
| 検証器との結合 | 記録がない | `06-EVENTS.ja.md`。再現テストあり |

## 4. 許可された環境での実行手順（後から実行）

この環境では、Agave 3.1.9 の導入が権限の判定で拒否された。**別の経路で回避はしていない。**

**必要なもの：**
- Agave 3.1.9（`cargo-build-sbf`、platform-tools v1.52）
- Rust 1.89.0 と 1.95.0（`rustfmt`、`clippy`）
- ネットワーク（crates.io と release.anza.xyz）

**手順（CI の `.github/workflows/ci.yml` と同じ順）：**

```sh
# 0. 基準 commit にパッチを当てる（または、このブランチを checkout する）
git checkout 4cd901de9f8e0d6c0b2016851d30595c4a70aa46
git apply workstreams/02-rights/patches/v1/0001-*.patch \
          workstreams/02-rights/patches/v1/0002-*.patch \
          workstreams/02-rights/patches/v1/0003-*.patch \
          workstreams/02-rights/patches/v1/0004-*.patch
# 1. ツール
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
rustup toolchain install 1.89.0 1.95.0 --profile minimal --component rustfmt,clippy
# 2. 配備できる形のビルドの検査（2回ビルドして hash の一致も見る）
scripts/build-frontier.sh --twice
# 3. rights の LiteSVM テスト（test-beacon などの feature ビルドも run.sh が作る）
permutation-frontier/svm-tests/run.sh --release -- rights --nocapture
# 4. 既存の全テスト（回帰がないこと）
permutation-frontier/svm-tests/run.sh --release
```

**合格の条件：**
- 3つの rights テストが通る。
- 出力された CU と大きさを記録する。CU を `frontier_abi::v2::budgets` の表に入れる案を作る。
- 既存の svm-tests が全部通る。
- `build-frontier.sh --twice` が「deployable yes」と、2回の hash の一致を出す。

ここまでで、PDA の署名・CPI・ランタイムの制約・原子性・CU・大きさが確認できる。**それでも、PS2 の記録と検証器の規則が入るまでは統合しない**（`06-EVENTS.ja.md`）。

## 5. この環境で実行したもの・しなかったもの

| 実行した | 結果 |
|---|---|
| `cargo test -p permutation-frontier -p frontier-abi`（全件） | 通過 |
| rights の host テスト 35件、ABI のテスト 4件 | 通過 |
| 変異テスト（`mutate.py`、22種） | 22種とも検出 |
| 検証器の再現（`cargo test -p verify --test rights_replay`、2件） | 通過（交換は FAIL を再現し、対照は PASS、Grant だけの操作は見えない） |
| 代理 AI の方針の境界（`node --test workstreams/02-rights/tests/agent-policy-boundary.test.mjs`、2件） | 通過 |
| LiteSVM の rights テスト（`cargo test --release --test rights --no-run`） | **コンパイルだけ通過**。実行すると、program の `.so` がないので3件とも止まる（想定どおり） |
| fmt・clippy（変更した crate とテスト） | 通過 |

| 実行しなかった | 理由 |
|---|---|
| SBF ビルド、LiteSVM の実行、svm-tests の全件 | Agave の導入が拒否された |
| frontier-node のその他の crate（keeper・herald・bots）、wasm、web、gateway の全テスト | 変更していない。今回の範囲外 |
