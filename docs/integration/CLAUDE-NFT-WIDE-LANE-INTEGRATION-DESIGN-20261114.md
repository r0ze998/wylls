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

## 7. 追記（同日 夜）：実装した独立差分（build なし）

**0xDD の UI・relay の配線（JS、単体試験あり）**
- `permutation-gateway/client/src/frontier/resident.mjs`（web の sdk に同期）：`WIDE_RESIDENT_ACT_TAG = 0xDD`、`WIDE_ACT_INNER_TAGS = [0xD9, 0xDA]`（`wide_ix.rs` の `act_runs`）、`wideResidentActIx`（0xE2 と同じ形・同じ 4 つの proof 口座）、`classifyWideResident`。
- `shapes.mjs` `classify`：0xDD は **lane が `wide`（内側の wide 命令の分類器）を渡したときだけ**分類し、渡さなければ拒否（どの配備済み program も帯を持たない）。proof 口座は読み取り専用・署名なし・別々、内側は player の shape だけ。
- relay の holder gate（`routes/relay.mjs` `residentRefusal`）：0xDD の proof（asset と署名した世代）を 0xE2 と同じく gate に渡す。**譲渡で Citizen が新しい持ち主に移り、旧持ち主・譲渡前の世代は拒否**という意味は 0xE2 と同じ。
- 試験 `test/frontier-wide-resident-act.test.mjs` 4 件（builder、program の act_runs との一致、relay の分類、gate への proof）。**画面からの 0xDD の送信は未配線**（wide・征服の画面の送信は local play の経路で、NFT の分岐は無い）。賞金・商用条件は足していない。

**local 試験専用の lane 候補（Rust・script、build していない）**
- feature `localnet-conquest-nft-sbf` = `localnet-conquest-sbf` + `nft-experimental`。**候補の値**（本番の割り当てではない）：program ID `[0x4C; 32]`、版 `0x4804 | 0x8000 = 0xC804`、marker `PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD`、script `scripts/build-frontier-localnet-conquest-nft-sbf.sh`（中に「NOT BUILT YET」）。
- ガード：§2 の 1（expedition と NFT）と 3（SBF の NFT は lane 経由）に `not(feature = "localnet-conquest-nft-sbf")` を足しただけ。**この feature を持たない build では条件は論理的に同じ**。新しい排他：候補は `localnet-nft-sbf`・rights・capacity・custody・oracle・trace と組めない。conquest lane のガード（test-beacon 禁止など）はそのまま効く。
- expedition の経路（`wide_expedition_dispatch.rs`）は、候補 feature のときだけ候補の版を受ける。Season の範囲検査（`range_view`）は `localnet-expedition-sbf` を含むので候補の版にもそのまま効く。
- 試験：`permutation-nft-resident-spike/test/local-conquest-nft-candidate.test.mjs` 4 件と `local-nft-lane.test.mjs`（狭めた条件に合わせて更新）。**どちらも source の文字列の検査だけ**。
- **限界（未 build）**：許可した新 lane が compile でき動くこと、拒否する旧い組み合わせで `compile_error!` が実際に発火すること、marker が .so に入ることは、build（host の `cargo check`・SBF build）をしていないので**確かめていない**。rustfmt で構文だけ確認（HEAD と同じ差分数）。keeper・herald・fclient・stack は 0xC804 を知らないので、候補の .so で world を動かすにはそれらも要る。本番の program・版は決めていない。

## 8. 追記（同日 20:30）：画面の 0xDD と、host・画面の道具が候補の版を扱う箇所

**画面の 0xDD（実装、振る舞いの試験あり）**：`permutation-server/web/frontier/fplay.mjs` `buildWideResidentShape`。出来上がった wide の draft 命令（0xD9・0xDA の帯）を、NFT Citizen の proof と、帯を出す lane が与える budget で 0xDD に包む。試験 `permutation-gateway/test/web-frontier-wide-resident-send.test.mjs`（3 件）は、**ページが作った bytes を relay の `classify` と `residentRefusal` に通す**。帯を出さない lane では拒否される。出す lane では proof が shape に届き、今の持ち主は通り、旧持ち主と譲渡前の世代は拒否される。**ボタンからの送信は未配線**。ページには wide の命令を作る道具が無く（`frontierIx` は ABI v2 の表だけ）、ABI の budget 表にも wide の行が無い。

**既存 lane が変わらないことの確認**：
- JS：relay は lane が `wide` を渡さない限り 0xDD を拒否する（既定）。0xE2 の分類・gate・ページの経路は変えていない（resident・relay・sdk の試験 130 件、game ページの試験は変更前と同じ 10 件の失敗）。
- Rust：既存のガードには `not(feature = 候補)` を足しただけで、候補を持たない build では条件は論理的に同じ。**ただし compile で確かめてはいない**（build なし）。

**候補の版（0xC804）を扱うために変える必要がある箇所**（編集していない。多くは領土側 lane の file）：

| 場所 | 今 | 候補の lane で要ること |
|---|---|---|
| `frontier-node/crates/stack/src/nftpass.rs:30` `LANE_PROGRAM_VERSION`、`up.rs:1170`、`setup.rs:135,154` | NFT lane の `0x8004`、範囲検査で S1 に写す | 候補の版と program ID `[0x4C;32]` を選ぶ起動。conquest の起動（local-play launcher）に住民 program・Core・setup・mint ページを足す形 |
| `frontier-node/crates/keeper/src/wideduty.rs:1289,1295` | Season の版 == 配備の版、wide bit 必須 | 配備の版に 0xC804 を与えれば、検査の形はそのまま |
| `frontier-node/crates/keeper/src/experimental_{expedition,expedition_depart,conquest}_prepare.rs` | `0x4804` 固定 | 版を引数か配備から読む |
| `permutation-gateway/src/frontier/{expedition-prepare,expedition-depart-prepare,conquest-prepare}.mjs`（`'18436'`）、`local-play-{preview,resident,relay}.mjs` | `0x4804` 固定 | 同上 |
| `permutation-server/web/frontier/flocalplay.mjs:30` `LOCAL_PLAY_PROGRAM_VERSION = 0x4804`、`fexpedition-prepare.mjs:27`、`hud/hand.mjs` | `0x4804` 固定 | 同上。NFT の一覧は `controller.mjs:179` の `& 0x8000` で、0xC804 なら自動で読む |
| herald・fclient | 版で layout を選ぶ（`>= PROGRAM_VERSION_S1` など） | 0xC804 は S1 以上なので S1 の扱いになる見込み（未確認） |

これらは版の割り当て（workstream 4）と、領土側の lane の所有に関わる。**ここでは変えず**、決まったら領土側と調整して直す。大きな build（host・SBF）は主側と容量・CPU の枠を合意してからだけ行う。

## 9. 追記（同日 21:40）：候補 lane 限定の wide 命令の encoder・配線と、検証の計画

**実装した（JS、検証済み）**：`permutation-gateway/client/src/frontier/resident.mjs`（web の sdk に同期）。
- wide の player 命令の data：ClaimSite（0xD9）、0xDA の envelope の Muster（op 1）・Dissolve（op 2、56 byte の host 参照）・Economy（op 3、Harvest・Build 0–8・Train unit 0–6 × n ≥ 1）・Garrison（op 4、1〜u32::MAX）・DeclareSiege（op 5、data だけ）。範囲外は Rust と同じく wire 形式なし（拒否）。
- 口座の並び：`wide_ix.rs` の `CLAIM_SITE`・`MUSTER`・`DISSOLVE`・`ECONOMY`／`ECONOMY_MIRROR`（城壁・tier-up は province を書く）・`GARRISON`。prologue は `[actor s] [payer s,w] [season r] [citizen w]`。NFT では actor が asset の今の持ち主（またはその session）、citizen が NFT Citizen。
- `candidateWideActIx`：**候補 lane の program ID と版の組のときだけ** 0xDD で包む。他の lane（conquest の 0x4804、NFT の 0x8004、S1）では作る前に拒否。owner・generation の proof は 0xE2 と同じ。
- 期待値：`frontier-abi/vectors/v2/wide-resident-candidate.json`（Rust の encoder から手で導いた bytes）。`test/frontier-wide-commands.test.mjs` 4 件（各命令の bytes、0xDD の bytes、口座の並び〔Rust の group の名前と順を読んで照合〕、候補だけの builder が relay の classify を候補の gate 経由でだけ通る）。
- **未実装**：WideDepart（封をした行軍：seal の作成が要る）、DeclareSiege の口座の並び（この group に無い）、画面のボタンからの送信（候補 lane の world がまだ無い）。

**用意したが未実行（未 compile）**：`frontier-abi/tests/wide_resident_candidate_vectors.rs`。Rust の encoder と decoder が同じ bytes を出し・受けることと、それらの bytes が同じ JSON にあることを確かめる。rustfmt で構文と書式だけ確認。実行は `cargo test -p frontier-abi --features world-index-experimental --test wide_resident_candidate_vectors`（host build：主側と枠を合意してから）。

**「検証が済んでいない」と「実装できない」の区別**：
- 検証が済んでいない（実装はある）：Rust の golden 試験、候補 lane の feature が compile できること、旧い組み合わせで `compile_error!` が出ること、候補の .so の marker。build の枠があれば確かめられる。
- 今は実装できない：候補 lane で動く world（keeper・herald・stack・page の道具が 0xC804 を知らない。領土側の file で版も未決）。画面からの 0xDD の送信（その world が要る）。

**枠が開いたときの計画（順番）**：
1. 主側の down＋df の後、**直した検査で通常 world を 1 回**（NFT lane、追加 build なし、0.5 GB 以内、watchdog は重なるなら 21.1 GiB、それ以外は 20.85 GiB）。dock の Village tab → 自然な再描画の下での入力・focus・押下（押下の記録つき）→ B の Build・Train・Muster の取引 → 行軍と Reveal の取引。終わったら片付けて down＋df。
2. 主側と容量・CPU を合意してから、**候補の限定 Rust 検証**（大きい順に分けて、各段の後に df）：
   a. `cargo test -p frontier-abi --features world-index-experimental --test wide_resident_candidate_vectors`（frontier-abi だけ、host、target は自分専用の dir、guard 付き）。
   b. `cargo check -p permutation-frontier --features localnet-conquest-nft-sbf`（候補が compile できること）と、旧い組み合わせ（`expedition-dispatch-experimental,nft-experimental` など）が `compile_error!` で**失敗する**ことを確かめる check（host）。
   c. 合意があれば `scripts/build-frontier-localnet-conquest-nft-sbf.sh`（SBF、約 250 MB、offline）で marker と `deployable no`。
   各段の結果をこの文書に記録し、target は終わったら消す（来歴に要る物だけ残す）。
3. 候補の world（0xC804）は、版の割り当てと、領土側の file（keeper・gateway・page の 0x4804 固定、§8）の変更が要るので、領土側と合意してから。
