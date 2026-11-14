# NFT 参加パス：発行できる状態の確認（2026-11-14、v0.26）

branch `claude/nft-pass-mint-20261114`（基点 `3e3ba225`）。ローカルだけで行った。devnet・mainnet への配備、実ウォレット、実資産、公開販売・配布、正式な価格・供給数・ロイヤリティ・treasury・永続 authority の決定は**していない**。

## 1. 結論

| 区分 | 状態 |
|---|---|
| 発行（MintResident：支払い＋Core asset＋住民口座を 1 取引） | **最新ソースの SBF build で、ローカル validator 上の実 program と実 Core で動く**（§3 の L1〜L6 が合格） |
| 保有確認（ページの `/mint/mine`・`/mint/status`、再読込） | 同上（L1・L5） |
| 譲渡後の旧所有者・旧 session の拒否、二重 mint、結果不明、ロールバック | 同上（L2〜L6） |
| ゲームへの参加（JoinResident）→ 基本操作（ResidentAct） | **実 chain では未接続**。理由は §5。web の NFT 経路の単体試験と、Frontier 本体の host 試験（既存）だけ |
| 実ウォレット・公開発行 | 対象外（未実施） |

## 2. build と配備用ファイルの一致

| 物 | 値 |
|---|---|
| ソース digest（`program/` の Cargo.toml・Cargo.lock・rust-toolchain.toml・src/） | `6d906500d82d6818031f4a83c5abc94d1f1c6756cb91e9275f1e3ef492c2504a`（v0.16 から不変） |
| `.so`（`cargo-build-sbf` 3.1.9、platform-tools v1.52） | `947da0b94d0b51ca2d8fe2ba48b7ba9f1c88fdd793efb4b5943bf2a6623dce22`、165,360 B |
| 記録 | `program/BUILD-RECORD.json`（commit 済み）。`node archive/program-artifact.mjs status` → `OK` |
| Core | `mpl_core.so` sha256 `515541c8…`（ENV-RECORD #4 と同じファイルを手元の過去の受け渡し物から写した。取得し直していない） |
| 旧 `.so` | `95e462f3…`（10/31）は v0.14・v0.16 の変更を含まない。使わない |

- build の容量：target 194 MB。Cargo.lock は不変、新規 crate の導入は無し（`mpl-core` 0.12.1 は lockfile どおり）。
- 警告：`mpl-core` 0.12.1 の 3 関数のスタック超過（U26、10/31 と同じ。本 program の経路では呼ばない）。
- 鍵：`cargo-build-sbf` が自動生成した program 鍵は使わずに削除した。ローカル試験の program ID は `sha256("wylls-resident-program id (test)")`。`.so`・Core・鍵はリポジトリに入れない（`.gitignore`）。

## 3. 実行した試験（2026-11-14）

| 種類 | コマンド | 結果 |
|---|---|---|
| 純粋・模擬チェーン（Node） | `node --test test/*.test.mjs` | 72 件中 54 合格・0 失敗・18 skip（ブラウザ試験は driver 不在で skip。下の 2 行で実行） |
| ブラウザ × 模擬チェーン | `node --test test/browser.mint.test.mjs` | 修正後 12 件中 11〜12 合格。7 番（途中離脱→再読込）は全件実行で 1 回失敗、単独 3/3 合格（負荷依存の揺れ。v0.7 の L6 と同種） |
| **ブラウザ × 実 program（ループバック validator、実 Core）** | `node --test --test-concurrency=1 test/browser.localnet.test.mjs` | **6/6 合格**：L1 正常系＋再読込、L2 古い価格の preflight 拒否、L3 応答消失→結果不明→署名で解決（二重発行なし）、L4 二重クリック 1 件、L5 relay 未観測の A→B→A（旧 session・旧世代・B の session がすべて拒否）、L6 着地したロールバック（支払い後の Core 失敗で全体が戻る） |
| ソースとの一致（build 不要） | `node --test test/program-source-agreement.test.mjs`（新規） | 4/4：命令 tag、エラー番号（サーバ表とページの表）、口座レイアウトと magic が `program/src/lib.rs` と一致 |
| ゲーム web の NFT 経路（build 不要） | `permutation-gateway` の `web-frontier-ws07-nft`・`web-frontier-resident*` | 16/16（resident-home の古い正規表現を直した後）。`frontier-resident.test.mjs` は gateway の npm 依存が無いため未実行 |

ブラウザ driver は repository が固定している `playwright-core` 1.58.2（`permutation-gateway/screens`、`npm ci` で 13 MB）を使い、既存の Chromium キャッシュで動かした。

### 見つけて直したもの

- **ページの注意書きが `[object Object]` になる**（v0.16 から）：companion server が `notice` を旗のオブジェクトで送り、ページがそれを文字列として表示していた。文字列だけを採るようにし、実 program の試験 L1 で注意書きの文面を確認するようにした（`web/mint.mjs`、`test/browser.localnet.test.mjs`）。
- ゲーム web の試験 1 件が controller の変更（local play の条件 `!localPlay &&` の追加）に追従していなかった。NFT の扱いは不変で、試験の照合だけを直した。

## 4. 発行画面の起動（ローカル、実 program）

```sh
cd permutation-nft-resident-spike
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
# 1 回だけ：program の build と記録（target 約 200 MB）
(cd program && cargo-build-sbf --manifest-path Cargo.toml)
mkdir -p program/target/deploy && cp ../permutation-chain/target/deploy/wylls_resident_program.so program/target/deploy/
rm -P ../permutation-chain/target/deploy/wylls_resident_program-keypair.json   # 自動生成の program 鍵（使わない）
node archive/program-artifact.mjs status            # OK であること（MISMATCH なら使わない）
# Core の .so は .local/programs/mpl_core.so（sha256 515541c8…、ENV-RECORD #4）
# ブラウザ試験の driver（任意）：(cd ../permutation-gateway/screens && npm ci)
node src/mint-demo.mjs --localnet --port 41990      # → http://127.0.0.1:41990/web/mint.html
```

- validator は 127.0.0.1 だけ、RPC は 40000–59999 の空きポート、ledger は一時ディレクトリ（停止時に削除）。
- この world は**試験値**で開く：価格 0.1 SOL（`priceLamports`）、供給 1,000,000、1 ウォレット上限なし、名前・URI は仮、treasury は乱数のアドレス、初期化鍵は起動ごとの乱数（メモリ内だけ）。どれも製品の決定ではない。
- ページのウォレットは試験用（Wallet Standard 形のテストウォレット）。実ウォレット（Phantom など）は未試験。
- 他の作業の world が動いている間は、ポートと容量（validator の ledger 約 5 MB）を確かめてから起動する。

## 5. ゲーム参加が実 chain で未接続の理由（容量だけの問題ではない）

1. **今のローカルプレイの program と NFT 機能は同時に build できない**。ゲームのローカルプレイは `localnet-conquest-sbf`（→ `expedition-dispatch-experimental`）で build する。NFT 参加（`nft-experimental`、tag 0xE0–0xE7、版 `S1 | 0x8000`）とは `compile_error!` で排他になっている（`permutation-frontier/src/lib.rs` の「expedition-dispatch-experimental has an isolated host-only program version」）。web の `controller.loadNfts` も `programVersion & 0x8000` の world だけで有効なので、今遊べる world では NFT の選択肢が出ない。両方を持つ版の番号と組み合わせは ④（workstream 4）の決定事項（NFT-ACCOUNT-WIRING §4）。
2. **NFT 対応の Frontier（S1＋`nft-experimental`）で world を作る道具が host build を要する**。`scripts/build-frontier.sh` は `nft-experimental` を受け付けない。world の作成（CreateSeason・AnnounceSeason など）は Rust の `frontier-stack`／`fclient` にあり、その host build は数 GiB と見込まれる（他の worktree の `target/debug` は 0.8〜1.6 GiB）。今回は領土戦の試験と同時に空き容量（開始 21 GiB／維持 20 GiB）を守るため、build していない。Frontier 本体の SBF build 自体は約 250 MB と見込む（他 worktree の実績 241 MB）。
3. ローカルプレイの chain は LiteSVM で Frontier だけを載せる（Core・住民 program を載せない）。

既存の検証（今回は再実行していない）：`permutation-frontier/src/resident_runtime_tests.rs`（host、Core と住民 program はバイトで置く模擬、10 件）。実 program を使った Frontier＋Core＋住民 program の一貫試験は**未実施**（SEASON-SCOPE §6、U37）。

### 接続するのに要る判断と作業（推奨順）

1. ④ が NFT と今のローカルプレイ（拡張・征服）を同時に持つ版の番号を決める（または NFT の検証用に S1＋`nft-experimental` の world を別に立てると決める）。
2. 容量の空いた時に、NFT 対応の Frontier の SBF build（約 250 MB）と、world を作る host 道具の build（見込み 1〜3 GiB）。
3. 1 つのローカル validator（または LiteSVM）に Core・住民 program・Frontier を載せ、`CreateResidentPolicy` → world 作成 → ページで mint → 同じウォレットで `JoinResident` → `ResidentAct`（SetVigil など）→ 譲渡 → 旧所有者の拒否、を一つの試験にする。
4. relay の `/f/residents` と holder gate（`ctx.residents`）を本番の relay で有効にする（今は spike の試験だけが設定する）。

### 5 の続き（同日 14:30 まで）

ゲーム参加の統合は `docs/integration/CLAUDE-NFT-PASS-LOCAL-WORLD-20261114.md`（repository の root から）に記録した。要点：排他は解除せず、版を増やさない独立した lane（`localnet-nft-sbf`、program ID `[0x4E; 32]`）を source として追加した（未 compile）。relay の holder gate が program と同じ順序で transfer guard まで読む。`CreateResidentPolicy` の JS builder を追加した。発行ページは `--rpc` で loopback の chain に読み取り専用でつながる。実 chain の試験（`test/localnet-nft-lane.test.mjs`）は lane の build 後に走る。

## 6. 公開発行にだけ要る残りの判断（実施していない）

DEVNET-APPROVALS の A1〜A11 と UNDECIDED のうち、発行に直接かかるもの：

| 判断 | 番号 |
|---|---|
| 配備先（devnet／mainnet）と program ID・upgrade authority・config authority の鍵と保管、authority の形（多重署名・凍結） | A1・A2、U27・U29 |
| 価格・無料／有料・供給数・販売期間・1 ウォレット上限 | U24、U1 |
| treasury のアドレス | A5 |
| collection の名前・URI・画像（metadata の置き場）、Royalties を付けるか・率 | A3、U30 |
| RPC（公開 RPC か提供者）と `/mint/mine` の索引（gPA 不可なら DAS か自前索引） | A7、U28 |
| ページの公開先と表示文（試験であること、価値を保証しないこと） | A8・A9 |
| 実ウォレット・実機での試験 | A10 |
| `mpl-core` のスタック超過警告の扱い | U26 |

A1 の配備対象は今回の `.so`（`947da0b9…`、165,360 B）。配備直前に `program-artifact.mjs status` を再実行し、配備後は programdata の中身を `.so` の長さで切って sha256 を比べる（PROGRAM-BUILD §2）。

## 7. 記録の区分

- 模擬：`test/*.test.mjs` の模擬チェーン、`browser.mint.test.mjs`。
- 実 program のローカル検証：`browser.localnet.test.mjs`（実 Core＋最新住民 program、ループバック validator、試験ウォレット）。
- 実ウォレット：未実施。
- 公開発行：未実施。
