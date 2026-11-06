# 候補 20（NFT と Citizen の認証・一対一登録・試験用命令・記録と索引）の確認と、その上の実装（2026-11-06）

## 1. 受け取りと照合

| 項目 | 値 |
|---|---|
| 添付 | `wylls-candidates-clean-patches-20261105.tar.gz`、sha256 `d16b812d5cec881a7997bb0e696f62754e11ff99dcf843a48034d9b502ece7be`。中の `SHA256SUMS` は全件一致 |
| 対象パッチ | `20-nft-index.patch`、sha256 `2a3f10d763045b9bd3785ef3bf18c10d21514c2ab2d0bf20c8adc9b6afbd86b5`（19 ファイル、+1,501 −34） |
| 元の候補 | `feature/ws20-index-unknown-20261105` の `a0b80384f8063abce79c9c98a5e39a89c35a19f4`。コミットそのものは同梱されていない（README のとおり）。本環境にも無い |
| 基点 | `445585e757810388e9ddabbdbfcde8e9a793341b` |
| 照合 | 隔離した worktree で基点に `git apply --index` → `git write-tree` = `1c6baa6fd16007c97c30874c75f11182790cc721`（期待値と一致） |
| 取り込み | そのままのパッチを本ブランチ（`f742dfc6`、文書だけの差）に当てて `1a61caa4` として記録 |

## 2. 候補の中身

| 部品 | ファイル | 内容 |
|---|---|---|
| 認可の規則 | `frontier-abi/src/resident_auth.rs` | 署名者が「asset の今の Core owner」か「住民プログラムの session（現 owner が設定、現世代、期限内）」か。住民口座の世代＝命令に署名された世代でなければ `StaleGeneration`。asset は Core 所有・AssetV1・`Collection(x)`、住民口座は住民プログラム所有・133 byte・同じ asset |
| 方針の記録 | `resident_policy.rs`、program の `create_policy` | Core・住民プログラム・collection を固定する書き込み一回の PDA。作れるのは program の upgrade authority だけ |
| 一対一の記録 | `resident_binding.rs`（ABI と program） | `["nft-citizen-link", asset]` に {asset, resident, citizen} を一回だけ書く。Citizen の住所は `["nft-citizen", asset]`。`register_new` は Citizen がまだ無いうちに対応だけを先に作る（**v0.15 で改めた**：記録は `["nft-citizen-link", season, asset]` で Season ごとに一回だけ書き、Citizen は各 Season の `citizen_by_tag15(住民 ID)`。1 NFT・1 アカウントは**各世界で**。SEASON-SCOPE §6） |
| 試験用命令 | `resident_wire.rs`、`nft_registration.rs`、`proc/holding.rs` | 未割当の tag `0xff`（`nft-experimental` の build だけ）：CreatePolicy、Register、Harvest |
| Join の記録案 | `resident_join_candidate.rs` | 旧 JOIN と別の固定長記録（214 B）。番号・版は未割当 |
| 索引 | `findex` | 読めない記録・欠落で止める（以前は黙って飛ばした）。古い索引は使わない |
| gate | `src/resident-gate.mjs` | 対応の保存に失敗したら、以後すべて「未確認」で拒否 |

## 3. 調査した共通入口・5 つの例外・譲渡時の世代更新との比較

| 箇所（FRONTIER-HOLDER §1） | 候補 20 | 評価 |
|---|---|---|
| 共通入口 `player_prologue`（26 か所） | 変えていない。Harvest だけ、別の NFT 用の入口を本体ごと複製 | 財布の入口は NFT Citizen を**構造的に拒否する**：住所が `["nft-citizen", asset]` で、財布から決まる住所の検査（`check_key`）に合わない。旧所有者が財布の経路で操作する穴は無い。ただし NFT Citizen を動かせるのは Harvest だけ |
| SetSession | 使わない。NFT Citizen の session は住民プログラム側 | 財布の SetSession は住所の検査で拒否される。Frontier 側の session は NFT Citizen には効かない（意図どおり） |
| `WalletRequired`（他人あての隊商、構造物の撤去） | 未接続 | NFT 用の入口は `by_session`＝「actor が今の owner でない」を出すので、接続すれば「owner 本人だけ」の意味が保たれる |
| RetireHost（自前の財布・session の判定） | 未接続 | 自前の判定も財布から決まる住所を検査するので、NFT Citizen は拒否される（安全側）。その代わり、NFT Citizen は自分の捕虜を引き揚げられない |
| CloseCitizen | 未接続 | 財布から決まる住所を検査するので、NFT Citizen は閉じられない（rent が残る） |
| 賞金の Entry（財布で決まる） | 触れていない | NFT の住民の賞金は決めていない（⑰・規則の判断） |
| 譲渡時の世代更新 | Frontier は状態を持たない。毎回、住民プログラムの世代と Core の owner を読み、署名された世代と照合 | 住民プログラムの `TransferResident` が世代＋1・session 消去を行う（実 Core で検証済み）。新所有者は譲渡直後から通り、旧所有者・旧 session・譲渡前の署名は通らない。CPI も Frontier 側の欄も要らない。**私の F1 推奨よりこちら（F2）が良い**：Frontier と住民プログラムの結び付きが policy の固定だけで済む |

財布から決まる住所を前提にしている場所（NFT Citizen ではそのままでは動かない）：program の `citizen.rs` 9 か所、`conquest.rs` 1、`transit.rs` 1（捕虜の Citizen の精算）、ABI の `prologue.rs`・`log.rs`、keeper の `landindex.rs`、検証器の `facts.rs`・`v1_chains`・`v11_land`・`v12_explore`・`conquest.rs`。

## 4. 使える部分

1. 認可の規則（`resident_auth::authorize`）：毎回 live の owner と世代を読む形は、仕様「譲渡で操作権が新所有者へ、旧所有者は操作不可」をそのまま満たす。
2. 方針の記録：program の upgrade authority だけが一回だけ作る。信頼の根を一つにまとめている。
3. 一対一の記録：asset から決まる対応と Citizen の住所。同じ NFT で 2 つ目の対応・Citizen は作れず、Citizen から見ても NFT は一つ。仕様「1 NFT につき 1 アカウント」の土台。
4. 財布の入口が NFT Citizen を構造的に拒否すること（住所の違いから自然に成り立つ）。
5. Join の記録を旧 JOIN と分ける方針（旧 JOIN の wallet に asset を詰める案を採らない）。
6. 索引で読めない記録を飛ばさない方針、gate の保存失敗時の拒否。

## 5. 不足と問題点

| # | 内容 | 重さ | 今回の対応 |
|---|---|---|---|
| 1 | **transfer guard を確かめていない。** guard の無い asset は Core の通常の transfer で動き、世代が変わらない。A→B→A の後、A の古い世代の署名が通る | 高 | **直した**（`resident_guard`、policy v2、`Unguarded`） |
| 2 | Harvest の本体を丸ごと複製していた（財布の Harvest と食い違う危険） | 中 | **直した**（共通の NFT 入口 `player_nft` と共通の本体） |
| 3 | CI の `cargo fmt --check`（lib.rs の並び）と `clippy -D warnings`（引数の数）に通らない。このまま push すると CI が赤 | 中 | **直した** |
| 4 | **NFT Citizen を作る命令が無い**（「最初に NFT でログイン」が未実装）。`register_new` は対応を作るだけ | 高 | 未着手（§7） |
| 5 | 動かせる命令が Harvest だけ。残り 25 か所の入口と例外は未接続 | 高 | 入口を共通化した。命令ごとの接続は未着手 |
| 6 | `0xff` は未割当の試験用 tag。本番の ABI・SDK・relay の shape・keeper・検証器は未対応 | 高 | 未着手（④の判断） |
| 7 | Citizen の住所が season によらない。継続世界（season 一つ）では成り立つが、season が変わると前提が崩れる | 中 | 記録だけ |
| 8 | NFT Citizen は、捕虜の精算（transit）・RetireHost・CloseCitizen で財布から決まる住所の検査に当たる。捕虜になった NFT Citizen の精算が止まる恐れ | 中 | 記録だけ |
| 9 | 検証器・keeper・herald が NFT Citizen を知らない（JOIN の番号・版が未割当） | 高 | 未着手 |
| 10 | 索引の厳格化で、未知の記録 1 件で herald が止まる（可用性） | 中 | ⑲・④の判断 |
| 11 | 実際の program の実行（LiteSVM・validator）での試験が一つも無い | 高 | 鍵を使わない方法の承認待ち（§8） |

## 6. 今回の実装（コミット）

| コミット | 内容 |
|---|---|
| `1a61caa4` | 候補 20 をそのまま取り込み（由来の記録） |
| `8c6991a9` | ABI：transfer guard の検査（実 Core のバイトで試験）、policy v2、認可が guard を要求、候補の fmt・clippy の修正 |
| `6771a151` | program：共通の NFT 入口 `player_nft`、Harvest の本体の共通化、policy 作成時に guard の authority を住民プログラムから検算 |

仕様に対する到達点：

| 仕様 | 状態 |
|---|---|
| 1 NFT につき 1 アカウント | 対応の記録と Citizen の住所が asset から一意に決まる（program の関数あり、Register を試験用 tag で接続）。**Citizen を作る命令は無い** |
| 譲渡で操作権が新所有者へ | NFT の入口が live の owner を読む。Harvest で接続。**他の命令は未接続** |
| 旧所有者は操作できない | NFT の入口：owner でない署名・前の世代の署名・前の世代の session は拒否。財布の入口：NFT Citizen を住所で拒否 |
| 譲渡前の署名・A→B→A 後の古い session の拒否 | 署名に世代が入り、住民プログラムが譲渡ごとに世代＋1・session 消去。guard が無い asset は拒否 |

## 7. 次の実装（判断が要るもの）

1. **NFT Citizen の作成（最初のログイン）**：asset から決まる住所に Citizen を作り、国・shard を決め、記録を出す。Citizen の `WALLET` 欄に何を入れるか（0 にして財布の判定に決して合わないようにするのが安全）、記録の番号と版、関連する索引・検証器の対応が要る。番号と版の割り当ては ④ に確認する。
2. **残りの入口の接続**：`player()`／`player_v2()` を呼ぶ 25 か所を、「命令の口座＋4 つの証明口座」の形で NFT 版にする。本体を共通化してから接続する（Harvest と同じ形）。
3. 例外の接続：`WalletRequired` の 2 か所（`by_session` で済む）、RetireHost の NFT 版、CloseCitizen と捕虜の精算の住所の検査。
4. 検証器・keeper・herald の対応。

## 8. 試験（2026-11-06）

実行したもの（すべてリテラルのバイトだけ。鍵の生成・導出・署名、PDA の計算、ネットワークは無い。名前で 1 件ずつ実行）：

| 試験 | 結果 |
|---|---|
| ABI：候補 20 の 5 件（auth、binding、join 記録、policy、wire。auth・policy・wire は guard に合わせて更新） | 5/5 |
| ABI：`resident_guard` の 2 件（実 Core のバイト、改変した変種） | 2/2 |
| findex：候補 20 の 2 件（メモリ内 SQLite と固定バイト） | 2/2 |
| 試作：`bindings-atomic-no-keys.test.mjs`（ファイル保存だけ） | 2/2 |

build・静的検査：`cargo check` と `cargo clippy -D warnings`（frontier-abi、permutation-frontier の `program` と `nft-experimental`）すべて通過。`rustfmt --check`（変更した Rust ファイルすべて）通過。findex は `cargo check` 通過、clippy は 1.95.0 に clippy の component が無く未実行（入れるのは環境の変更）。

実行していないもの：program・Core を実際に動かす試験（LiteSVM、validator）、既存の固定 seed の試験すべて、SBF の build（`cargo-build-sbf` はプログラム鍵のファイルを生成するため）、herald・keeper・検証器。
