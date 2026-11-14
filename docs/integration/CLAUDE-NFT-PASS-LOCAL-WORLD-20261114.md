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

## 5b. 通常の world と画面へ（同日 15:00 以降）：実行したものと未 compile のもの

**preload した fixture の world（§4.2）は通常の world ではない。** 以下は区別して書く。

| 部品 | 状態 | 検査 |
|---|---|---|
| 譲渡後に B が状態を変える（A が作った Citizen を B の SetVigil が変更、A の世代 0・1 は 174・175 で何も変えない、A の選んだ国は残る） | **実 chain で実行**（fixture world） | `test/localnet-nft-world.test.mjs` 2/2 |
| pass の setup（collection・config・TEST の販売・`CreateResidentPolicy`）：`src/nft-world-setup.mjs`。loopback だけ、冪等、鍵は seed ファイルから読み表示しない、別の authority の config は拒否 | **実 chain で実行**（validator に Core・住民 program・lane） | `test/nft-world-setup.test.mjs` 2/2 |
| ゲームの参加画面 → 発行ページの導線：relay の `--mint-url`（localnet・loopback http だけ）→ `GET /f/residents` の `mint` → パス未保有の wallet に「発行ページを開く」「取得したので読み直す」（`nft-reload`） | Node の試験で実行（画面の部品と純粋な module。実 relay・herald では未実行） | `permutation-gateway/test/web-frontier-nft-mint-link.test.mjs` 4/4 |
| `frontier-stack up --nft-pass`（`crates/stack/src/nftpass.rs`、config・up・resume・main） | **source だけ。未 compile・未実行** | rustfmt、`test/stack-nft-pass-wiring.test.mjs` 6/6（定数・command line・port・版の規則を source と照合） |
| **CreateSeason が NFT lane で通らない問題**：CreateSeason は binary の版（S1\|0x8000）と完全一致を要し、汎用の `validate` は 3/4/5 しか受けない。つまり NFT の build はこれまで Season を作れなかった（harness も Season を preload している）。拡張 lane と同じ隔離した range view を NFT lane にも適用（`proc/season.rs`、その lane のその版だけ、`validate` は不変）。stack も同じ view で検査し、`--nft-pass` は `--conquest`（S1）と `--beacon test-key` を要する | **source だけ。未 compile**。§2 の lane の `.so`（`2171b86e…`）はこの変更より前の build で、**今の source とは一致しない**。§4.1 の実 chain 試験はその `.so` の結果（CreateSeason を使わないので有効） | 上の wiring 試験、program 側の lane 試験を source に追加（build 時に走る） |
| keeper・herald・client の版の扱い | 主要な読み手は `>= PROGRAM_VERSION_S1/V2` で比べるので `0x8004` は S1 として読まれる（静的な確認だけ）。完全一致を求めるのは拡張と wide の lane の経路だけで、この world では使わない | 未実行 |

### 次に必要な build と実行（容量と領土戦の build の完了の連絡の後）

1. lane の SBF の再 build（約 233 MB、host build ではない）：`scripts/build-frontier-localnet-nft-sbf.sh`。program 側の lane 試験は host の `cargo test --features localnet-nft-sbf` が要る（host build）。
2. host build：`frontier-stack`・`frontier-localnet`・`frontier-keeper`・`frontier-herald`・`drand-replay`（他の worktree の実績で 2.7〜11 GiB）。
3. 実行：`frontier-stack up --nft-pass --conquest --beacon test-key --bots 0 --so <lane .so>`。確かめること：Season が S1\|0x8000 で作られる、setup の JSON が run state に入る、発行ページ（localnet + 80）で mint、ゲーム画面で NFT を選んで JoinResident（relay `/f/join` と gate）、ResidentAct、譲渡後の旧持ち主の拒否、パス未保有の wallet に発行ページへの導線。
4. 未実装のまま：`--nft-pass` の world の resume（今は拒否する）、ゲーム画面の実機・実ウォレット。

## 5c. lane の再 build・CreateSeason の実 chain 試験・host build の計測（同日 15:10〜15:30）

**lane の再 build**（watchdog 20.85 GiB、offline、自分の target だけ。build 後に lane の cargo target は削除）：`.so` sha256 `0227dbe1b490546102f90a44ad3c9b7fbedcc09ade5dba1b2b3fd604d2bc7f59`、1,450,704 B、`build-frontier.sh` の検査すべて通過、`deployable no`。今の source（`proc/season.rs` の lane の range view を含む）の build。

**CreateSeason の実 chain 試験**（`test/localnet-nft-create-season.test.mjs` 4/4）。AnnounceSeason は wall-clock の validator では 24 時間待つため、AnnounceSeason が書く状態（ANNOUNCED・authority・params hash・作成可能時刻を過ぎた・bond）を preload し、**CreateSeason そのものは実取引**：
- lane の版 S1\|0x8000 で Season が作られる（CREATED、Frontier と defence pool ができる）。
- S1（4）と拡張 lane の 0x4804 は BadData（1）で拒否、何も作られない。
- 告知と違う parameters は Announce（56）で拒否。
- params hash の計算は vector の値と一致（未変更の preset で確認）。
新しい `.so` で既存の実 chain 試験も通過（lane 3・world 2・setup 2）。

**host build の計測と保留**：`frontier-stack`・`frontier-localnet`・`drand-replay`・`frontier-keeper`・`frontier-herald`・`frontier-viewers`・`frontier-bots` を release・offline・`--locked`・`CARGO_INCREMENTAL=0`・debug 0 で、自分の target（`frontier-node/target-nftpass`、git 管理外）へ。watchdog 20.85 GiB。
- 開始時の空き 22.20 GiB。約 460 crate のうち 375 の compile を始めた時点で target 681 MB（deps 621 MB、build 53 MB）、cargo の source cache は増えなかった（281 MB、展開済み）。
- 領土側が 100 turn の計測 world（開始時 21 GiB）を準備するとの連絡で**停止**（exit 143、残った process 無し）。停止後の空き 21.56 GiB。部分 target 681 MB は再開のため残した（空きは 21 GiB 以上）。
- 残り：LiteSVM と Solana SVM 系、7 binary の crate、link。見込み（推測）：完了時の target は合計 1.1〜1.5 GiB、つまり**あと約 0.5〜0.9 GiB**。今の空き 21.56 GiB から始めると終わりに 20.7〜21.1 GiB となり、領土側の開始 floor 21 GiB を割りうる。
- 必要な条件：領土側の world を起動しない時間枠で再開する、または再開前の空きが**約 22.5 GiB 以上**（21 GiB の floor に 1 GiB 前後の余裕）。既存の他の target の再利用は、source が一致する証拠が無いので使わない。
- build 後の実行（未実施）：`FRONTIER_BIN=<target-nftpass/release> frontier-stack up --nft-pass --conquest --beacon test-key --bots 0 --so <lane .so>`。world の容量（ledger・snapshot）は別に要る。

## 5d. 通常 world と英語画面での実行（同日 15:45〜16:05）

**fixture ではない通常の world**で、発行 → 保有 → 参加 → 操作 → 譲渡を画面で通した。ローカルだけ。試験の鍵はその場の乱数（メモリと browser の localStorage だけ、記録しない）。実ウォレット・公開 chain・実資金は無し。

**host build**（guard 20.85 GiB、部分 target から再開）：完了 rc=0、warning 0。target は 853 MB（+172 MB）で止まらなかった。stack の unit test 20/20（`nftpass` の 3 件を含む）。7 binary を来歴付きで `frontier-node/nftpass-bin/`（41 MB）に保存（`host-bins.mjs verify` OK、commit `c1c1a55a`、rustc/cargo 1.95.0）。その後 target（1.0 GB）を削除。

**review の修正**：`run_with_deadline` の process group 全体の停止と、実行中の pipe の読み取り。関数を std だけの program に写して rustc で確かめ、crate の unit test でも確かめた。

**world**：`frontier-stack up --nft-pass --conquest --beacon test-key --bots 0 --viewers 0`（base 41000）。
- 1 回目は relay の npm 依存が無く、何も起動する前に拒否（exit 2）。`permutation-gateway` で `npm ci --ignore-scripts`（lockfile どおり、57 MB）。
- 2 回目：localnet に Core・住民 program・lane を deploy、**AnnounceSeason → CreateSeason で Season 7 を版 `0x8004` で作成**（preload ではない）、pass の setup（collection・InitConfig・TEST の販売・CreateResidentPolicy、run state に記録）、keeper・relay（`--mint-url`）・herald・mint ページ（41090）。setup 56 秒。

**英語画面**（`demo/nft-world-screen-check.mjs`、playwright-core。ゲーム画面は `http://127.0.0.1:41040/frontier/frontier/`）：
1. パス未保有の wallet（Dev Wallet）：参加カードに「This wallet holds no resident NFT (entry pass)…」と発行ページへのリンク（41090）。
2. 発行ページで同じ鍵が mint（TEST PRICE）。
3. ゲームで「I got one: check again」→ 国を選ぶ → 「Join with this NFT」→「Playing as an NFT」（JoinResident）。
4. 「村を築いて始める」（PlaceHome を ResidentAct で）。chain で確認：NFT Citizen（asset の印）、Aster、村 1 つ。
4b. 再読込でもパスが出る（下の修正の後）。
5. Node から TransferResident A→B（世代 1）→ A の画面はパス未保有の表示に戻る → B の別 profile で「Play this NFT」→「Playing as an NFT」、A の作った村（Hamlet of Himere）と資源が B の画面に出る。

**画面で見つけて直した不具合**：前回の wallet を黙って再接続する起動の経路（`adoptConnectedWallet`）は、NFT の一覧を読む wallet の同期を通らない。そのため、NFT を持つ人がページを再読込すると NFT が出なかった。起動時に Season を読んだ後、一覧が未読なら読むようにした（`controller.mjs`。NFT の Season 以外では何も問い合わせない）。修正前は手順 5 の A の再読込で失敗し、修正後は 4b・5 とも通った。source の順序の試験を追加（`web-frontier-nft-mint-link.test.mjs` 5/5）。

**まだ画面で確かめていないこと**：B が画面から状態を変える行為（chain の層では確認済み：§4.1・§5b）、旧持ち主の古い署名を relay に送ったときの画面の表示、発行ページの英語化（発行ページは日本語だけ）、実ウォレット・実機。B の画面で「Choose a nation」の欄が出たままになる（表示だけの問題、未修正）。

**片付け**：`frontier-stack down`（全 component 停止、mint ページも）。41000–41099 に listener 無し、自分の process 無し。run directory（294 MB）は state・events・setup log を scratchpad に写してから削除。空き 21.75 GiB。領土側に報告済み。残したもの：7 binary（41 MB）、gateway の npm 依存（57 MB）、lane の `.so`。

## 5e. 発行ページの英語化・画面の不具合修正（同日 16:10〜、領土側の world の実行中：validator・world・build は無し）

| 変更 | 確認 |
|---|---|
| **発行ページを英語に**（`web/mint-lang.mjs`）：`?lang=en\|ja` → 前回の選択 → browser の言語（`ja*` は日本語、ほかは英語）。英語と日本語の切り替えボタン。TEST の表示はそのまま（「TEST PRICE — a test value, not a real price」「The price is a TEST value…」「On sale (TEST)」）。ゲームの参加画面のリンクはゲームの言語を `?lang=` で渡す | `test/mint-lang.test.mjs` 3/3（`mint.mjs` の T 文字列を source から全部抜き出し、`data-i18n`・title・販売の拒否文・server の価格表示に英語があり、placeholder が一致）。`test/browser.mint-en.test.mjs` 1/1（Chromium・模擬チェーン：英語で接続→mint→「Your pass is ready」→再読込も英語→切り替えで日本語。英語画面に日本語が残らない） |
| **見つけて直した**：切り替えボタンが保存して再読込しても、URL の `?lang=en` が優先されて英語のままだった | 切り替えは URL の `lang` を書き換える。上の browser 試験で確認 |
| 既存の browser 試験は日本語を前提にしているので、`wylls-mint-lang=ja` を明示 | 模擬 12 件中 11、1 件は既知の負荷依存の揺れ（単独 2/2） |
| **譲渡後の B に「Choose a nation」が出る**：NFT を選ぶと viewer を消してから NFT Citizen の記録を読むため、その間 `viewerState` が「known・land none」となり国選びが開いた。NFT を遊んでいて記録が未回答の間は pending にした（財布の player は不変） | `web-frontier-nft-viewer-switch.test.mjs`（switch 中・回答後・財布の 3 場合） |
| **旧持ち主の拒否の表示**：ページ自身の送信前の確認で `NftNotHeld`（「This resident NFT is not in this wallet now.」）。relay の gate の `ResidentGenerationStale`・`ResidentAssetMismatch`・`ResidentNotNft` に文が無かったので日英で追加 | 同ファイル：ページ・gate・program の拒否の全 code に日英の文があり、英語に禁止語が無い（計 4/4） |
| stack の wiring 試験を process group の停止に合わせた | 7/7 |

validator を使わない spike 試験 91 件中 89 合格（1 件は既知の揺れ、1 件は上の wiring 試験の更新前）。validator を使う試験は領土側の world の間は実行していない。

**次の world の枠で確かめること（未実施）**：B が画面から状態を変える行為、旧持ち主の画面での拒否の表示（A のページを開いたまま譲渡し、A が操作する）、B の画面に国選びが出ないこと、英語の発行ページを通常 world で通すこと（screen check の手順 2 は英語に更新済み）。

## 5f. 通常 world の 2 回目：旧持ち主の画面での拒否・新持ち主の画面での操作を chain で照合（同日 16:45〜16:58）

領土側の world が早く終わり（16:44:40、片付け済み）、領土側に知らせてから起動した。追加の build は無し。7 binary は来歴 OK（commit `c1c1a55a`）、lane の `.so` `0227dbe1…`、住民 program は記録どおり。port は 41000 帯だけ。

- `frontier-stack up --nft-pass …`（run `nftpass-2`）：Season 7（版 `0x8004`、AnnounceSeason → CreateSeason）、pass の setup 4 段、mint ページ。setup 56 秒。
- 英語画面の検査（`demo/nft-world-screen-check.mjs`）。各段で chain を読む（`docs/integration/CLAUDE-NFT-PASS-WORLD2-CHAIN-20261114.json`：公開の住所・hash・数値だけ。試験の鍵は書いていない）：

| 段 | 画面 | chain |
|---|---|---|
| 1 | パス未保有：英語の参加カードと発行ページへのリンク（`?lang=en`） | — |
| 2 | 英語の発行ページで mint（「A LOCAL TEST network…」「TEST PRICE — a test value, not a real price」「On sale (TEST)」「Your pass is ready」） | — |
| 3–4 | 国を選んで NFT で参加、最初の村 | asset の持ち主 A、世代 0、NFT Citizen の印、村（Holding）の `OWNER_CITIZEN` ＝ その Citizen、蔵 14,302,627,800 |
| 4b | 再読込でも NFT を遊び続ける | — |
| 5 | Node から TransferResident A→B | 持ち主 B、世代 1 |
| 5a | **A の開いたままの画面で Harvest → 「That did not work — Nothing was harvested. This resident NFT is not in this wallet now.」** | **持ち主・世代・Citizen と Holding の bytes の hash・`LAST_OWNER_ACTION` が変わらない** |
| 5 | A の再読込：パス未保有の表示。B：同じ Citizen の村（国選びは出ない） | — |
| 6 | **B が画面から Harvest → 「Harvest written into the stores」** | **蔵 14,302,627,800 → 14,303,115,478、`LAST_OWNER_ACTION` 1785686600 → 1785697160、持ち主 B・世代 1・村の持ち主は同じ NFT Citizen** |
| 7 | B の画面に「Choose a nation」は出ない | — |

検査を通すまでに harness を直した点（product の不具合ではない）：A の最初の村の chain 確認は Holding の口座ができるまで待つ／再読込後は村の画面を「遊んでいる」と見なす／Harvest は action bar のボタンを使う／B は村があるので参加カードの「Playing as an NFT」は出ない（5e の修正どおり）。

**片付け**：`frontier-stack down`（全 component、mint ページも）。41000–41099 に listener 無し、自分の process・validator・browser 無し（Playwright の context は鍵ごと閉じた）。run directory（343 MB）は state・events・setup log・chain の記録を scratchpad に写してから削除。空き 21.53 GiB、領土側に報告済み。

**残り**：実ウォレット・実機・公開発行は対象外のまま。B の行為は Harvest だけ（建設・行軍などは未確認）。

## 5g. 通常 world の 3 回目：画面の譲渡 UI → 旧持ち主の拒否 → 新持ち主の建設・訓練・編成・行軍・Reveal を取引で照合（同日 19:20〜19:40）

主側の利用者の調整で、主側の retake world（41980–41993）と並行。追加の build は無し（7 binary 来歴 OK `c1c1a55a`、lane `.so` `0227dbe1…`、住民 program は記録どおり）。source は `3313726a`。空きの watchdog 20.85 GiB（`world` の `up` が終わるまで監視）、port は 41000 帯だけ、鍵はその場の一時鍵（process の中だけ、記録していない）、browser は自分の headless Playwright（主側の built-in pane には触れていない）。

- run `nftpass-3`：Season 7（版 `0x8004`）、setup 55 秒。画面の検査（`demo/nft-world-screen-check.mjs`、既定で譲渡を発行ページの画面から）を同じ world で 4 回実行（各回、新しい一時鍵で mint から）。1〜3 回目は harness の不具合で途中停止（下記）、**4 回目（`screen-check-13`）が最後まで通った**。
- **画面の成功・account の hash の変化だけでは証拠にしない**（keeper の自然な処理でも変わる）。`demo/nft-world-tx-evidence.mjs`（読むだけ）で、各段の**取引そのもの**を読んだ：`CLAUDE-NFT-PASS-WORLD3-TX-EVIDENCE-20261114.json`（公開の住所・署名・decode した field だけ）、画面の段の記録 `CLAUDE-NFT-PASS-WORLD3-STEPS-20261114.txt`。

| 段 | 画面 | 取引（chain） |
|---|---|---|
| 譲渡 | 発行ページの「Transfer your resident (TEST)」：自分宛を署名前に拒否 → 確認（asset・送り主・宛先）→ チェック → 送信 →「Transferred (confirmed on the chain)… This wallet can no longer play this resident.」 | TransferResident 1 件、成功、署名者 = A、宛先 = B（`4TeQ34oETSALJf3m…`） |
| A の拒否 | A の開いたままの画面で Harvest・Build →「This resident NFT is not in this wallet now.」 | **譲渡の後に A の取引は 0 件**（chain の Citizen・村の bytes も不変） |
| B Harvest | 「Harvest written into the stores」 | ResidentAct（世代 1、B の署名、proof に asset）→ Harvest、成功、事象 HARVEST（`5YyYHcx6cNyxwuMc…`） |
| B Build | 「building begun」 | ResidentAct（世代 1）→ Build、成功、事象 BUILD（item 0、done_at）（`2cSPGixu4WAjmpfi…`） |
| B Train | 「trained: they joined the reserve」 | ResidentAct（世代 1）→ Train、成功、事象 TRAIN（unit 0、n 100）（`2j5pQuzuwCVNEmzJ…`） |
| B Muster | 「ordered to form up」 | ResidentAct（世代 1）→ Muster、成功、事象 MUSTER（host 124249108905984、troops 100、tile 17）（`31e5aPF5qfMczC1T…`） |
| B Depart | 行き先を座標で（(2,0) マス 2）→「Sealed and on its way. It arrives on turn 148」 | ResidentAct（世代 1、B の署名）→ **Depart**、成功、事象 DEPART（同じ host、出発 bell 146、到着 bell 148）（`2YR2PcnxHWPmQjYp…`） |
| 出発の決着 | — | SettleDeparture、成功、事象 DEPARTURE_SETTLED（同じ host）。署名者は B ではない（keeper） |
| **Reveal** | — | Reveal、成功、事象 **REVEAL（同じ host、(2,0) 到着 148、マス 2 = 画面で選んだ行き先）**。署名者は B ではない（`2z2zdSdM2aHss9MB…`） |
| 到着の決着 | — | SettleTransit、成功、事象 TRANSIT_SETTLED（同じ host、outcome 1 = ページの表で「Withdrew」）。ゲームの結果で、失敗ではない |

所有者・世代：全段で asset の持ち主 B・世代 1（screen check の chain 記録）。

**harness の停止と、見つけた画面の不具合**（4 回のうち 3 回）：
- B の Train の直前に、Train の form が折り畳みの中へ移り button が消えた。原因は `screens/holding.mjs` の **`musterFirst = musterable >= 100` が再描画のたびに決め直される**こと：控えの兵がターンで 100 を越えると、開いている form が Train から Muster に入れ替わる。**人が人数を入力している最中にも起き得る操作性の不具合**。
- **最小修正（この後の commit）**：開く form を村（`musterScope`：cluster・program・season・wallet・村）ごとに**最初の表示で決めてページの間は保つ**（`troopsOrder`、`FS.musterDraft` と同じ形）。再読込・別の村・別の wallet では決め直す。unit 試験 `web-frontier-cards.test.mjs` 1 件追加。**world では未観察**（修正は world の後。4 回目は harness 側の対処＝折り畳みを開く・村の tab を開き直す、で通した）。描画のたびに drawer が村の tab から離れていたかどうかは**未確認**。
- game ページの既存試験の 10 件の失敗（conquest の配線・home rings・words など）は、この修正の**前の HEAD でも同じ 10 件**。文言の無い code（RequestTimeout・LocalPlayReadOnly など）は base の commit `18823ad2` から（NFT の作業ではない）。調べていない。

**片付け**：world は予定の終わり（run end、slot 2678）に達し、`frontier-stack down`（全 component、mint ページも）。41000–41099 に listener 無し、自分の process・browser 無し。run directory は **518 MB**（見込みの 350 MB より多い）、state と setup log を scratchpad に写してから削除。空き 22.27 GiB、主側に報告済み。

**残り**：Train・Muster の form の安定化は source と unit 試験だけ（world・人の操作では未確認）。実ウォレット・実機・公開発行は対象外のまま。

## 5h. 通常 world の 4 回目（未達）と、操作の不具合の手元での再現・修正（同日 19:45〜20:30）

**world 4（run `nftpass-4`、19:47〜20:03）**：主側と並行（合意済み、41000 帯、headless だけ、追加 build 無し、watchdog 20.85 GiB を `up` の終了後も component が残る間は継続）。目的は、人の通常の操作（押し直し無し）で Train・Muster の form・値・focus が自然な再描画の下で保たれることと、譲渡 UI・行軍の再試験。**結果：未達**。
- 譲渡 UI（自分宛の拒否 → 確認 → 送信）、旧持ち主 A の拒否（Harvest・Build）、B の Harvest までは毎回通った（`CLAUDE-NFT-PASS-PRESS-REDRAW-20261114/world4-run*-steps.txt`）。
- **B の Build で止まった**（押し直し無しの方式では 3 回とも）：Playwright の click は「要素が安定しない・DOM から外れた」で押せず、人に近い押し方（中心で mouse down、約 120 ms、mouse up）では BUILD の取引が無かった（`world4-run18-tx.json`：Harvest だけ）。その時点の画面・DOM は保存していない（試験の不備）。**Train・Muster の保持は world では未確認**。
- 測定（`world4-redraw-probe.json`）：A の村の画面で、約 16 秒は再描画なし、その後 4 秒に 7 回、村の操作部分が作り直された（変わった行は蔵の数・残り時間）。100 倍の試験時計では数が毎秒変わる。
- world は予定の終わりで停止（延長しない）。run directory 421 MB は state と setup log を写して削除。空き 22.79 GiB、主側に報告。

**手元での再現（world なし）**：`permutation-gateway/screens/press-redraw.screen.mjs`。fixture server の live の見本 world（時計が動き、drawer が自分で再描画する）で本物のゲーム画面を開き、pointerdown・pointerup・click の対象（drawer の中か、まだ DOM にあるか、押した点の要素＝重なりの有無）、再描画（監視した node の作り直しと時刻、離した直後に走ったか）、scroll、Build の注文が world に届いたかを記録。失敗時は screenshot と DOM を保存。証拠 `CLAUDE-NFT-PASS-PRESS-REDRAW-20261114/*.json`。

| 見つけたこと | 修正 | 手元の試験 |
|---|---|---|
| **数を入力中に再描画が来ると、caret が先頭へ移り、次の数字が前に入る**（120 と打つと 021）。値と focus は戻していたが caret を戻していなかった | `app.mjs` `keepState`：focus を戻した後、文字の欄は選択範囲を戻し、選択 API の無い数の欄は caret を末尾へ | 約 1 秒に 1 文字で打ち、**打鍵の間に再描画が 2 回**入っても「120」・focus・form の位置が保たれる（2 回実行とも）。修正前は同じ試験で「021」 |
| 押している間に drawer が作り直されると、押し始めと離した node が違い click にならない可能性 | `app.mjs` `makePressGate`：drawer（`#panel-body`）の中で押している間は再描画を保留し、離した直後（click の後）に走らせる。2 秒を超える押下（drag）は保留しない | drawer の fold を 12 回押す：**押している間の作り直し 0、click 12/12、うち 2 回は保留した再描画が離した直後に走った**（保留が実際に働いた） |
| Train・Muster の開いている form が控え 100 を越えると入れ替わる | `holding.mjs` `troopsOrder`（前の commit） | unit 試験だけ（この fixture では控えが 100 を跨がないので browser では未確認） |
| Build | — | 人に近い押し方で、Build は drawer の中、click は DOM にある node に届き、**fixture world に注文が届いた（0 → 1）** |

**範囲の注意**：保留は drawer（`#panel-body`）だけ。手札の pop-up（`handEl`・`handPopEl`、砦・編成の pop）は**対象外**（主側が同じ gate を後で足す合意、この branch の HEAD の後）。world 4 の B の Build が drawer の中だったことは手元の試験で同じ要素で確かめたが、**world 4 で何が押下を失わせたかは未確定**（重なり・layout の移動・別の原因。当時の DOM を保存していない）。**通常操作（人の押下と入力）の world での確認は未解決**。

game ページの既存試験は 1607 件中 1597 合格、失敗 10 件は修正の前と同じ（§5g）。

## 5i. 控え 100 の境と、畳んだ form の focus（同日 20:10〜、world なし）

- fixture：`screens/liveworld.mjs` に `reserve`（開始時の控え。既定は従来どおり）。控え 40 で始め、入力の途中で world 自身がその viewer の Train 100 を行う（`world.order('Train')`、同じ player の別のタブと同じ経路）。ページは控えが 40 → 140 になるのを自分で見る。
- **見つけた不具合（base から）**：Muster の数は打鍵ごとに draft を保存して drawer を書き直す。その時 `keepState` が **折り畳みを開き直す前に focus を戻していた**ため、新しい markup で閉じた fold の中の欄に focus が入らず、**最初の 1 桁で focus が消えて以後の打鍵が失われた**（手元の probe：「1」の後は active が BODY。base の app.mjs でも同じ）。修正：fold を先に戻し、それから値と focus。
- **troopsOrder の見直し**（初回体験のレビューの指摘）：ページの間ずっと固定すると、訓練の後に Muster が畳まれたまま（再読込まで）になる。focus が兵の card の中にある間だけ順を保ち、それ以外は再描画ごとに控えで決める。
- browser 試験（`press-redraw.screen.mjs`、7/7）：
  - Train を打っている間に控えが 100 を越える → 値・focus・開いた form・畳まれた Muster が保たれる。
  - Muster を fold から開いて打っている間に越える → 値・focus・開いた fold が保たれる。
  - 誰も card にいない → 40 で Train、world が訓練すると Muster が開き Train が畳まれる。
  - **base の holding.mjs に戻すと Train の場合は失敗する**（控え 140 で focus が消える）ので、試験は旧い入れ替わりを捉えている。
- 手札の pop-up への同じ保留は主側の round 17a（この branch の app.mjs の上、主側が canonical に適用。私は自分の部分と主側の差分の行を review）。
- **world での確認はまだ**（次の world は主側と枠を合意してから。press の記録と失敗時の screenshot・DOM・event log を screen check に足した）。

## 5j. 通常 world の 5 回目（未達、押下が失われた原因を特定）（同日 20:28〜20:39）

主側と合意（並行、41000 帯、headless、追加 build なし、0.5 GB 以内、watchdog 20.85 GiB を全 component の停止まで）。host binary は記録どおりの `c1c1a55a` の build（binary の hash と `Cargo.lock` は一致）。`host-bins.mjs verify` は **NOT OK**（source が変わった）と出たが、変わったのは lane 候補の 4 file だけで、どれも未 build の候補 feature の下にあり、これらの binary には入っていない。画面の検査を 2 回（押下の記録つき、押し直しなし。2 回目は 1 回目の原因を直した検査で、同じ world で 1 回だけ）。

- 両回とも、譲渡 UI（自分宛の拒否 → 確認 → 送信、chain で譲渡済み）、旧持ち主 A の拒否（Harvest・Build、chain は不変）、B の Harvest（蔵が増えた）まで通った。B の Build で止まった。
- **押下の記録から分かったこと**（`CLAUDE-NFT-PASS-PRESS-REDRAW-20261114/world5-run*-B-press*.json`、`world5-run20-B-failure.png`）：
  - B の Build の押下の pointerdown と pointerup は**地図の canvas に当たっていた**（押した点の要素は `frontier-map`、drawer ではない）。
  - 1 回目は村の tab の押下から 260 ms 後（drawer が動いている途中に見えた）。2 回目は「止まって見える・押す点が button」の条件を 3 秒待っても満たさず、同じく地図に当たった。
  - 失敗時の screenshot：**drawer は村ではなく「Selection – Hills」（地図の選択）を表示**。押そうとした Build はそもそも画面に出ていなかった。
  - 原因：検査の「村を開く」が `[data-act="tab"][data-tab="holding"]` の**先頭の要素**を押していて、それが dock の Village tab ではない別の要素（座標 (388, 574)）だった。fixture の画面試験は `#tabs [data-tab="holding"]` を押しており、こちらが正しい。
  - **結論**：world 4・5 の「Build の押下が失われた」のは、**検査の script が画面に無い Build を押していた**ため。ページが押下を失った証拠ではない（ただし、正しい tab で world 上の押下を通した確認はまだ）。
- 修正（`demo/nft-world-screen-check.mjs`）：村を開くのは `#tabs [data-tab="holding"]`、その後 `#holding-title` を待つ。押す前に button が止まって見え、押す点の要素が button であることを待つ（見る動作で、押し直しではない）。
- world は予定の終わり前に停止（延長しない）。run directory 304 MB を削除、空き 22.49 GiB、主側に報告。
- **未確認のまま**：world での B の Build・Train・Muster の人の押下と入力（form・値・focus の保持）、行軍。次の world（主側と合意してから）で、直した検査を 1 回だけ。

## 5k. 通常 world の 6 回目：正しい tab で開き、B の Build の人に近い押下が取引になった（同日 22:00〜22:09）

主側の down＋df（21.85 GiB）の後、主側の求めで watchdog を **21.1 GiB** にして起動。追加 build なし、headless、41000 帯。同じ world で検査を 2 回（2 回目は 1 回目の原因を直した 1 回だけ、新しい world は増やしていない）。

- 1 回目（`world6-run21-*`）：譲渡 UI・A の拒否・B の Harvest まで成功、B の Build で止まった。押下の記録：**Village tab を約 130 ms 間隔で 2 回押していた**。ゲームの dock は「開いている tab をもう一度押すと drawer を閉じる」（`app.mjs` の dock の処理）ので、1 回目で村が開き 2 回目で閉じ、drawer が「Selection」に戻り、Build は地図に当たった。原因は検査の `villageOrder` が `openVillage` を続けて 2 回呼んでいたこと（ページの不具合ではない）。
- 修正：`openVillage` は村がもう出ていれば押さない。tab も人の押し方（止まって見え、押す点が tab）で 1 回だけ押し、tab が current になり村の見出しが出ることを確かめる（出なければ失敗、押し直しなし）。押下の記録に `data-tab` を追加。
- 2 回目（`world6-run22-*`）：**dock の Village tab（`data-tab="holding"`）の押下で村が開き、B の Build の押下は pointerdown・pointerup・click がすべて drawer の Build に当たり**（押す前に約 260 ms、止まるのを待った）、**chain に B の署名の ResidentAct（世代 1）→ Build が成功**（`world6-run22-tx.json`。A の譲渡後の取引は 0 件）。その後、検査の selector の誤り（`section:has(#hp-troops-h)` が drawer 全体にも当たる）で止まった。
- 修正：兵の card は `section.vcard[aria-labelledby="hp-troops-h"]`。押す前に止まらない・押す点が別の要素のときは**古い座標で押さず**、screenshot・DOM・記録を残して失敗にする。
- 片付け：world を停止、run directory 259 MB を削除、空き 21.83 GiB、主側に報告。
- **未確認のまま**：world での Train・Muster の入力（自然な再描画の下での値・focus・form）と押下、行軍と Reveal（直した検査で次の world 1 回）。

## 6. push の記録

| 時刻 | `git ls-remote origin refs/heads/claude/nft-pass-mint-20261114` |
|---|---|
| 2026-11-14 13:5x JST | `764f8e872429161525a4abf62d7668acf9208c9d`（発行側の checkpoint） |
| 2026-11-14 14:25 JST | `3d7a5445bdf05a2201d102c1c0f6c96abc83fa1b`（lane・gate・builder まで） |

この文書を含む commit とその後の commit の remote SHA は最終報告に書く。手元の `refs/remotes/origin/…` が見えないときは `git fetch origin claude/nft-pass-mint-20261114` で取れる（ls-remote は remote を直接読む）。
