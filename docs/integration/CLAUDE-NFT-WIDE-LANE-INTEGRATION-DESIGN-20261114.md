# NFT 参加パスと wide の領土戦 lane の統合：最小差分・排他の理由・未決事項（design note、2026-11-14）

branch `claude/nft-pass-mint-20261114`。**source を読んで整理しただけ**で、何も決めていない・何も変えていない：
- 版（`PROGRAM_VERSION`）の割り当て、lane の名前、program ID は決めていない（workstream 4 の決定事項）。
- `compile_error!` の排他（コンパイルガード）は 1 つも外していない。
- build・world・validator は動かしていない（領土側の world の実行中）。

区分（AUDIT 文書と同じ）：A＝NFT lane（`localnet-nft-sbf`）で ResidentAct が包める S1 の命令（済み）／**B＝wide の領土戦との統合（この文書）**／C＝本番の program・版・配備（別）。

## 1. 今の 2 つの lane

| | NFT lane（この branch） | 遊べる領土戦 lane（領土側） |
|---|---|---|
| feature | `localnet-nft-sbf` = `nft-experimental` + `test-beacon` | `localnet-conquest-sbf` ⊃ `localnet-expedition-sbf`、`expedition-dispatch-experimental`、`wide-world-experimental` |
| 版 | `S1 \| 0x8000` = `0x8004` | `S1 \| 0x4000 (wide) \| 0x0800 (expedition)` = `0x4804`（`frontier-abi/src/world_index/expedition_dispatch_ix.rs:26`） |
| program ID | `[0x4E; 32]`（`LOCALNET_NFT_PROGRAM_ID`） | `[0x45; 32]`（`LOCALNET_EXPEDITION_PROGRAM_ID`） |
| marker | `PSF_LOCALNET_NFT_SBF_BUILD` + `PSF_TEST_BEACON_BUILD` | `PSF_LOCALNET_EXPEDITION_SBF_BUILD` + `PSF_LOCALNET_CONQUEST_SBF_BUILD` |
| build script | `scripts/build-frontier-localnet-nft-sbf.sh` | `scripts/build-frontier-localnet-conquest-sbf.sh` |
| NFT 住民の命令 | 0xE0 CreateResidentPolicy・0xE1 JoinResident・0xE2 ResidentAct（v2 の 26 命令を包む） | 無い（`nft_registration` は `nft-experimental` の下） |
| wide・征服の命令 | 無い | 0xD6–0xDF の帯・0xEE Reveal、征服の種類 12–18（版つきの包み経由） |

## 2. 排他の理由（ガードの場所、外していない）

1 つの build は 1 つの `PROGRAM_VERSION` を持ち、CreateSeason は Season の版が**完全に一致**することを求める（`proc/season.rs` の `range_view`、各 lane の版だけを S1 の範囲検査に通す）。両方を持つ版は割り当てられていない。それをコンパイル時に止めているのが次のガード（`permutation-frontier/src/lib.rs`）：

1. `expedition-dispatch-experimental` と `nft-experimental`（rights・capacity・custody も）は同時に build できない（「has an isolated host-only program version」、lib.rs 78–82 行付近）。
2. `localnet-nft-sbf` は expedition・wide・rights・capacity・custody・oracle・trace のどれとも組めない（「is the isolated local NFT lane only」、lib.rs 233–247 行付近）。
3. SBF の `nft-experimental` は必ず `localnet-nft-sbf`（marker の無い NFT の .so を作らせない、lib.rs 249–256 行付近）。
4. `localnet-expedition-sbf` は `test-beacon` と組めない（lib.rs 59–64 行付近）。NFT lane は `test-beacon` を含むので、ここでも衝突する。
5. capacity・custody と NFT の組み合わせも「版が未決」で止めている（lib.rs 332–342 行付近）。

**ガードは正しく働いている**（版が無いまま混ぜると、Season の版の検査・web の `& 0x8000` の判定・keeper／herald の版の扱いが黙って食い違う）。外すのは版が決まってから。

## 3. wide の側にすでにあるもの（読んで分かったこと）

- **0xDD WideResidentAct**（`proc/wide.rs` 2727 行付近、`wide-world-experimental` の下）：NFT 住民の Citizen が wide の player 命令（ClaimSite・Depart・Muster・Dissolve・Economy・Garrison・DeclareSiege）を行うための、帯専用の ResidentAct。内側の命令は `Auth::Resident` で動き、検査は既存の `proc::resident::start`（policy・link・Core asset の今の持ち主か session・**署名した世代**）。つまり譲渡前の署名・旧持ち主は wide でも拒否される設計。
- 0xE2（v2 の ResidentAct）は v2 の 26 命令だけ、0xDD は帯の命令だけを包み、互いに相手を通さない（wide.rs のモジュール文書）。
- host の試験：`wide_garrison_nft_runtime_tests.rs`（「Literal NFT proofs through actual WideResidentAct -> WideGarrison」、Join・譲渡・lifecycle は対象外と明記）、`proc/wide_expedition_resident.rs`（既に wide に居る住民の遠征の下書き）。
- tag は重ならない：住民の 0xE0–0xE2 と、wide の 0xD6–0xDF・0xEE（`frontier-abi/src/resident_wire.rs`、`world_index/wide_ix.rs`）。

wide の側は NFT 住民の**行動**を受ける準備がある。足りないのは、同じ build に NFT 住民を**作る**命令（0xE0・0xE1）が無いこと。

## 4. 統合に要る最小差分（候補、決めていない）

順に、版が決まった後の作業。

| # | 場所 | 差分 | 未決の判断 |
|---|---|---|---|
| 1 | 版 | 領土戦 lane の版に NFT を足した版が要る。算術上の和は `0x4804 \| 0x8000 = 0xC804` だが**割り当てではない**。別の bit・別の番号も有り得る | **版の番号**（workstream 4） |
| 2 | feature・lane | 例：`localnet-conquest-sbf` に `nft-experimental` を足した新しい lane feature、その marker、build script、出力先 | lane の名前・program ID（`0x45` を共有するか新しい ID か）・marker 名 |
| 3 | lib.rs のガード | §2 の 1・2・3 を、新しい lane のときだけ通すように狭める（他の組み合わせは今のまま拒否） | 1 の版が決まるまで変えない |
| 4 | beacon | NFT lane は `test-beacon`、領土戦 lane は `test-beacon` を禁止（§2 の 4）。統合 lane は**領土戦 lane の beacon の扱いに合わせる**のが最小と見えるが、NFT lane が `test-beacon` を必要とした理由（S1 CreateSeason の beacon 鍵の hash の照合）を、領土戦 lane がどう満たしているかは**未確認** | 要確認 |
| 5 | Season の版 | `proc/season.rs` の `range_view`、`proc/wide_expedition_dispatch.rs`・`proc/wide.rs` の版の完全一致の検査、stack の `setup.rs` の版の上書き | 1 に従う |
| 6 | 画面 | `controller.mjs:179` は `programVersion & 0x8000` で NFT の一覧を読む。統合版が 0x8000 を含めば自動で NFT を読む（含まない番号なら判定の変更が要る）。wide・征服の画面の送信（行軍・征服・経済）は今 wallet／session で署名：NFT で遊ぶときは **0xDD で包む経路**が要る（v2 の 0xE2 の経路 `fresident.act`・`marchSubmitFor` と同じ形） | 1 に従う。画面の 0xDD の経路は新規の作業 |
| 7 | relay | holder gate（`resident-chain-gate.mjs`）は 0xE1・0xE2 を検査する。0xDD も同じ照合（asset の持ち主・transfer guard）を先に行う追加 | — |
| 8 | stack | `frontier-stack up --nft-pass` は今 NFT lane の .so と `0x4E` の ID を選ぶ。統合 lane では、領土戦の起動に住民 program・Core・setup・mint ページを足す形 | lane が決まってから |
| 9 | keeper・herald・検証器 | `frontier-node/crates`（herald の `conquest.rs`、fclient の `abi.rs`・`decode.rs` など）の版の扱い | 1 に従う |

## 5. 遊び方の上で決める必要があること（技術ではなく方針、決めていない）

- NFT 住民が S1 の領土戦（拡張・征服）に参加できるか。参加できるなら、どの命令まで（0xDD の現行の一覧どおりか）。
- **征服の途中の譲渡**：包囲・予約・捕獲は Citizen に付くので、譲渡すると新しい持ち主がそのまま引き継ぐ（世代が上がり、旧持ち主の署名は拒否）。それでよいか、進行中は譲渡を止めるか。
- NFT 住民の領土が賞（prize）の対象になるか（wide の prize の扱い自体も未決、wide.rs のモジュール文書）。
- 本番（C）の program・版とどう関係するか（NFT lane も領土戦 lane も試験専用で `deployable no`）。

## 6. この branch で行ったこと・行っていないこと

- 行った：上の読解と、この文書。
- 行っていない：版の割り当て、ガードの解除・変更、新しい feature・build script、build、world。

決まった後の順序の案：(1) 版と lane 名の決定 → (2) ガードを新しい lane だけに狭める差分と host 試験（`cargo test --features <新 lane>` で、他の組み合わせが今も拒否されることを含む）→ (3) build と marker の検査 → (4) 領土戦の world に住民 program を足した起動 → (5) 画面の 0xDD 経路と relay の gate → (6) 通常 world で、NFT 住民の拡張・征服と、譲渡後の旧持ち主の拒否を chain で照合。
