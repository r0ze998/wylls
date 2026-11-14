# NFT 参加パス：発行からゲーム参加までのローカル統合（2026-11-14）

branch `claude/nft-pass-mint-20261114`（基点 `3e3ba225`、独立 worktree `/Users/r0ze/Projects/wylls-nft-pass-20261114`）。正本 checkout・既存 world・領土戦の公開 API と本番フラグは変えていない。devnet・mainnet・実ウォレット・公開販売は対象外。発行側の記録は `permutation-nft-resident-spike/docs/MINT-READINESS-20261114.ja.md`。

## 1. playable-local と `nft-experimental` が排他である理由（解除しない）

- 1 つの build は 1 つの `PROGRAM_VERSION` を持ち、CreateSeason は Season の版がその値と**完全に一致**することを求める（`proc/season.rs`）。
- 遊べる local world（`localnet-conquest-sbf` → `expedition-dispatch-experimental`）は `S1 | wide 0x4000 | 0x0800 = 0x4804`。拡張の入口（`proc/wide_expedition_dispatch.rs`）と wide の経路（`proc/wide.rs`）も Season の版の完全一致を検査する。
- NFT 参加（`nft-experimental`）は `S1 | 0x8000`。両方を持つ版（例 `0xC804`）は**割り当てられていない**（④ の決定事項。`CODEX-EXPERIMENTAL-EXPEDITION-DISPATCH-20261110.md`「NFT, rights, capacity and custody combinations are compile-time errors」）。
- 合わせると、新しい版の番号、拡張と wide の完全一致の検査、web の `& 0x8000` の判定、keeper・herald・検証器の版の扱いをすべて変えることになる。領土戦の試験中の lane に触れるので採らない。

## 2. 選んだ経路：独立したローカル NFT world の lane

`localnet-nft-sbf`（commit `326730b7`）。版も tag も新設しない：

| 項目 | 内容 |
|---|---|
| feature | `localnet-nft-sbf = ["nft-experimental", "test-beacon"]`（S1＋NFT 住民＋試験用 beacon 鍵） |
| Season の版 | 既存の `S1 \| 0x8000`。遊べる lane（0x4804）や本番の Season とは互いに受け付けない |
| program ID | `[0x4E; 32]` だけ（`LOCALNET_NFT_PROGRAM_ID`）。他の ID では dispatch の先頭で `BadAddress` |
| 排他 | 拡張・征服・wide・rights・capacity・custody・oracle・trace と `compile_error!`。`nft-experimental` の SBF build は必ずこの lane（印の無い NFT の `.so` を作れない） |
| 印 | `PSF_LOCALNET_NFT_SBF_BUILD`（＋`PSF_TEST_BEACON_BUILD`）。lane では必須、他のすべての build では拒否（`scripts/build-frontier.sh`） |
| build | `scripts/build-frontier-localnet-nft-sbf.sh`（offline、専用の target と出力、約 250 MB 見込み）。`build-frontier.sh` を直接呼ぶと拒否 |

**14:50 に build した**（`scripts/build-frontier-localnet-nft-sbf.sh`、offline、空き容量の watchdog 付き。先に自分の住民 program の target 194 MB を消して相殺し、build 後に lane の cargo target 233 MB も消した。`.so` だけ残す）：`build-frontier.sh` の検査（SBPF v2、overflow 検査、lane の印 2 つが有り、他の印が無い、data relocation）をすべて通り `deployable no`。`.so` sha256 `2171b86eb691db7bb2354bbb54625149e855b9559d74ffe843bcc9cf84f0fca5`、1,450,616 B（program_hash `018f1bc8…`）。空き容量は 21.06 → 21.22 GiB（開始時より増えた）。Rust の host 試験は実行していない（host build をしないため）。

build の前に build なしで確認したこと：`permutation-nft-resident-spike/test/local-nft-lane.test.mjs` 5/5、`bash -n`、新しい Rust の箇所の rustfmt。Rust の試験（`markers::tests::the_local_nft_lane_is_isolated`、`localnet_nft_identity_tests`）は build 時に走る。

## 3. relay の holder gate：何を relay が確かめ、何を program だけが確かめるか

`permutation-gateway/src/frontier/resident-chain-gate.mjs`（commit `6c514387`・`3d7a5445`）。relay の context に既定で入る（`residents: null` で外せる。spike の gate を渡せばそれが優先）。

**読む条件**：`ResidentAct`・`JoinResident` の形のときだけ chain を読む。それ以外（財布の player の全取引、既存の全 world）は**読まずに通す**。NFT Citizen の `WALLET` は 0 なので財布の署名では操作できず、program が拒否する。既存 world への無条件の RPC 追加は無い。

| 確認 | relay の gate | program |
|---|---|---|
| policy（Core program・住民 program・collection・guard） | 読む。guard が住民 program の collection-authority でなければ拒否 | 作成時に検査し、毎回読む |
| asset：Core program の所有、AssetV1、policy の collection、name・uri の形 | 同じ（偽の collection、似せた program → `ResidentUnverified`） | 同じ（`resident_auth::holder`） |
| **transfer guard**：凍結済みの Permanent Freeze Delegate と Permanent Transfer Delegate、authority＝`Address(guard)` | **同じ**（`resident_guard::check` を移植。無い・凍結していない・別の authority → `ResidentUnguarded`） | 同じ |
| 住民記録：住民 program の所有、133 B、この asset | 同じ（別 asset の記録 → `ResidentUnverified`） | 同じ |
| 署名した世代＝記録の世代（先に検査） | 同じ（譲渡前の署名、A→B→A、未来の世代 → `ResidentGenerationStale`） | 同じ |
| 署名者＝今の持ち主、またはこの持ち主がこの世代で設定した有効な session | 同じ（パス未保有、譲渡後の旧持ち主、他人が設定した session、旧持ち主の session → `ResidentHolderChanged`）。JoinResident は持ち主本人だけ | 同じ |
| session の期限 | chain の時計を渡したときだけ（既定は program に任せる） | chain の時計で検査 |
| Wrapper の asset と Citizen の印の一致 | 検査（`ResidentAssetMismatch`）。財布の Citizen への ResidentAct は `ResidentNotNft` | 検査 |
| Citizen の住所、link、Season の状態・join gate、内側の命令の規則 | **しない** | 検査 |

relay を通過しても権限にはならない。同じ取引の中で program がもう一度判定する。

### relay の費用負担

| いつ拒否されるか | relay の費用 |
|---|---|
| 1 回目の gate（rate limit・quota の課金・fee payer の署名より前） | 無し（replay の鍵を解放） |
| simulation で program が拒否 | 無し（simulation は読み取り。quota は全額返す） |
| 2 回目の gate（送信直前、simulation の後） | 無し（quota を全額返し、replay の鍵を解放。送信しない） |
| 2 回目の gate の後、取引が着地するまでに譲渡が着地した | **1 取引分の手数料**（program が chain 上で拒否する。quota はその取引を数える）。この窓は読み取りでは閉じられない |

順序は `test/frontier-resident-chain-gate.test.mjs` が relay のソースで固定している。

### 試験（build・npm 依存なし）

`permutation-gateway/test/frontier-resident-chain-gate.test.mjs` 11/11。使うバイトは program 自身が書いたもの：実 Core と住民 program の LiteSVM 出力（`svm-core/out` の mint 後・A→B 後・A→B→A 後）と、Frontier の NFT Citizen の vector（同じ asset）。偽の collection、似せた program、guard 無し・未凍結・別 authority の delegate、別 asset の記録、古い世代・未来の世代、session（有効・期限切れ・他人の・旧持ち主の）、パス未保有、譲渡後の旧持ち主、JoinResident。guard の検査行を外すと失敗することも確かめた。

## 4. 発行からゲームまでの部品の状態

| 部品 | 状態 |
|---|---|
| 発行ページ＋住民 program（最新 build `947da0b9…`） | 実 Core＋ローカル validator で 6/6（MINT-READINESS §3） |
| 住民 program の source と JS の一致 | `program-source-agreement.test.mjs` 4/4 |
| Frontier の NFT lane | source（未 compile）、§2 |
| `CreateResidentPolicy` の JS builder | `client/src/frontier/resident.mjs`（commit `0846c367`）。Rust の wire・口座・guard と照合 3/3 |
| relay の holder gate | §3 |
| ゲーム web の NFT 経路（NFT 選択・JoinResident・ResidentAct） | 既存。`programVersion & 0x8000` の world で有効 → この lane の world で有効になる。web 試験 16/16（1 件の古い正規表現を修正） |
| **発行 → 保有 → 参加 → 操作（program の層）** | **実 chain で通った**（§4.1） |
| world の起動（Season の作成・keeper・herald・relay・ゲーム画面） | **未実装**。§5 |

### 4.1 実 chain の試験（2026-11-14 14:50〜15:00、ループバック validator、実 program）

同じ `solana-test-validator` に、実 Core（mainnet の binary）、住民 program（`947da0b9…`）、Frontier の NFT lane（`2171b86e…`、`[0x4E; 32]`）を載せた。試験値・乱数のメモリ内の鍵だけ。

| 試験 | 結果 |
|---|---|
| `test/localnet-nft-lane.test.mjs`：同じ `.so` を別 ID に載せると `BadAddress`。`CreateResidentPolicy` は upgrade authority 以外で `Auth`、guard 違いで `BadData`、正しいもので 1 回だけ成功し 2 回目は拒否。書かれた policy を relay gate が読む。同じ chain で mint と譲渡、gate が実 program のバイトで holder・パス未保有・旧持ち主・古い世代を判定。発行ページの `--rpc` 接続が同じ config を読む | 3/3（3 回実行） |
| `test/localnet-nft-world.test.mjs`：Season と Frontier だけ preload（§4.2）、あとは実取引。policy → **A が mint** → パス未保有の wallet の JoinResident は `ResidentNotCurrentAuthority`(175)、Citizen は作られない → **A の JoinResident** で NFT Citizen（WALLET 0、asset の印、faction 2）と world の link ができる → 2 回目の JoinResident は拒否 → **A の ResidentAct(SetVigil 600)** が Citizen に書かれる → 他人の ResidentAct は 175 → **A→B の TransferResident** → A の世代 0 は `ResidentStaleGeneration`(174)、A の世代 1 は 175、B の世代 0 は 174、どれも Citizen を変えない → B の世代 1 は holder の検査を通り、SetVigil 自身の規則（6 日に 1 回、A が直前に変えた）で `Cooldown`(29) → B の JoinResident は拒否（1 NFT・1 Citizen）。各段で relay gate の答えが program と一致 | 1/1（3 回実行） |
| 住民 spike 全体（`node --test --test-concurrency=1 test/*.test.mjs`） | 87 件中 86 合格、skip 0。失敗 1 は既知の負荷依存の模擬試験（途中離脱→再読込、単独 3/3 合格） |

B の操作は state を変えていない（cooldown）。B が操作できることは「holder の検査を通って行為自身の規則に達した」ことで示した。状態を変える 2 回目の操作は、時計を進められる chain（frontier-localnet）か別の行為で確かめる。

### 4.2 preload した state の範囲（正直な限界）

`src/nft-world-fixture.mjs` は Running の Season（2048 B）と Frontier（512 B、open sites 100）を、Frontier program の runtime harness（`resident_runtime_tests.rs` `World::new`）と同じ値で書く。版は lane の `S1 | 0x8000`。**AnnounceSeason・CreateSeason・InitShards で作った Season ではない**。map・国・beacon・keeper は無く、JoinResident と Citizen だけの行為（SetVigil など）までを試せる。ゲーム画面での遊びや、建設・行軍などの行為には本物の world の起動（§5）が要る。

## 5. 残り（容量か build が要る）

1. ~~lane の SBF build と実 chain での確認~~（済み、§2・§4.1）。
2. **world の起動**：`frontier-stack up` に `--nft-pass`（`--prize-so` と同じ形）を足す。中身は (a) `frontier-localnet --program` で Core（authority 無し）と住民 program（authority＝起動時のメモリ内の鍵）を同じ chain に載せる、(b) Frontier の program ID を `[0x4E; 32]` にする、(c) Season 作成の後に住民 program の setup（collection・InitConfig・試験値の SetTerms）と `CreateResidentPolicy`、(d) 発行ページの companion server をその RPC につなぐ。`frontier-localnet` はすでに複数の `--program ID=PATH[:MAXLEN][@AUTHORITY]` を受け付ける。
3. **host build の容量**：stack・localnet・keeper・herald・drand-replay の host build は、他の worktree の実績で 2.7〜11 GiB。今の余裕（開始 21 GiB／維持 20 GiB に対して約 21.1 GiB）では無理。既存の `frontier-localnet` の binary（11-05）は来歴が合わず（その後 localnet は約 400 行変わった）、証拠には使わない。
4. 公開発行にだけ要る判断（価格・供給・treasury・authority・配備先・RPC・公開先）は MINT-READINESS §6。

## 6. push の記録

| 時刻 | `git ls-remote origin refs/heads/claude/nft-pass-mint-20261114` |
|---|---|
| 2026-11-14 13:5x JST | `764f8e872429161525a4abf62d7668acf9208c9d`（発行側の checkpoint） |
| 2026-11-14 14:25 JST | `3d7a5445bdf05a2201d102c1c0f6c96abc83fa1b`（lane・gate・builder まで） |

この文書を含む commit とその後の commit の remote SHA は最終報告に書く。手元の `refs/remotes/origin/…` が見えないときは `git fetch origin claude/nft-pass-mint-20261114` で取れる（ls-remote は remote を直接読む）。
