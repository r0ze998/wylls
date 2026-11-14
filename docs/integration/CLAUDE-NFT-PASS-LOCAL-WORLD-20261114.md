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

**未 compile**（容量を領土戦の試験に残すため）。build なしで確認したこと：`permutation-nft-resident-spike/test/local-nft-lane.test.mjs` 5/5、`bash -n`、新しい Rust の箇所の rustfmt。Rust の試験（`markers::tests::the_local_nft_lane_is_isolated`、`localnet_nft_identity_tests`）は build 時に走る。

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
| world の起動（chain・Season・keeper・herald・relay） | **未実装**。§5 |

## 5. 残り（容量か build が要る）

1. **lane の SBF build**（約 250 MB）と、実 chain での確認：program ID の拒否、`CreateResidentPolicy`（upgrade authority だけ、guard の検査、一度だけ）、同じ chain での mint と譲渡、relay gate が実 program のバイトを読むこと。`solana-test-validator` で足り、host build は要らない。自分の住民 program の target（194 MB）を消して相殺する計画。
2. **world の起動**：`frontier-stack up` に `--nft-pass`（`--prize-so` と同じ形）を足す。中身は (a) `frontier-localnet --program` で Core（authority 無し）と住民 program（authority＝起動時のメモリ内の鍵）を同じ chain に載せる、(b) Frontier の program ID を `[0x4E; 32]` にする、(c) Season 作成の後に住民 program の setup（collection・InitConfig・試験値の SetTerms）と `CreateResidentPolicy`、(d) 発行ページの companion server をその RPC につなぐ。`frontier-localnet` はすでに複数の `--program ID=PATH[:MAXLEN][@AUTHORITY]` を受け付ける。
3. **host build の容量**：stack・localnet・keeper・herald・drand-replay の host build は、他の worktree の実績で 2.7〜11 GiB。今の余裕（開始 21 GiB／維持 20 GiB に対して約 21.1 GiB）では無理。既存の `frontier-localnet` の binary（11-05）は来歴が合わず（その後 localnet は約 400 行変わった）、証拠には使わない。
4. 公開発行にだけ要る判断（価格・供給・treasury・authority・配備先・RPC・公開先）は MINT-READINESS §6。

## 6. push の記録

| 時刻 | `git ls-remote origin refs/heads/claude/nft-pass-mint-20261114` |
|---|---|
| 2026-11-14 13:5x JST | `764f8e872429161525a4abf62d7668acf9208c9d`（発行側の checkpoint） |
| 2026-11-14 14:25 JST | `3d7a5445bdf05a2201d102c1c0f6c96abc83fa1b`（lane・gate・builder まで） |

この文書を含む commit とその後の commit の remote SHA は最終報告に書く。手元の `refs/remotes/origin/…` が見えないときは `git fetch origin claude/nft-pass-mint-20261114` で取れる（ls-remote は remote を直接読む）。
