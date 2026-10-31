# ⑱の修正候補の検証：平文を含む Reveal が、公開可能になる前に RPC へ出ないこと（④、2026-10-31）

**状態**：⑱のパッケージ `r18-package-20261031.tar.gz`（sha256 `e75ab1e4…8884`）は**未受領・未配置**。この文書は、修正を当てる**前**の基準の測定と、修正を当てた後に同じ試験を走らせるための道具を記録する。共有コアへは当てていない（下の patch は提案）。

## 道具（`keeper-play-reveal-before-anchor.patch`、sha256 `52d818e4fd2927ff65134a83255753179429b048f6cfa17a273901eec90ced62`）

対象は `frontier-node/crates/keeper/tests/play.rs` だけ（試験のみ。keeper の本体は変えない）。

- **RPC の境界で記録する port（`Watch`）**：keeper が RPC に渡すすべての取引（`send` と `simulate` の両方。simulate も平文を RPC のノードに渡す）のうち、Reveal（tag 0x51）を含むものについて、その瞬間のチェーンの状態を記録する。THE anchor（命令の 4 番目の口座）が載っていたか、時刻、署名。keeper の内部の見方ではなく、チェーンの状態で判定する。
- **5 つの場面**：
  1. 正常
  2. THE anchor を保留：書き込みを高い優先度で塞ぎ、T(arrive) の 20 slot 後まで載らないようにする
  3. THE anchor の読み取りが失敗する：RPC のエラーを注入する
  4. 保留の途中で keeper を journal から作り直す（再起動）
  5. 再試行：slot を保留し、版を上げていく
- **判定**：THE anchor がチェーンに載る前に RPC へ出た Reveal が 0 件であること。T(arrive) より前に出た件数は、別に数えるだけで判定しない（本人の自己公開をいつ許すかは未決の規則）。

## 基準での結果（修正の前。HEAD `bc09689a7d888958a9cbfa61a7db2f58598e9d27`、tree `ed2921f496be05b3f6326e84b71558625a1ac5c1` に、この patch を当てたもの）

| 場面 | THE anchor が載る前に RPC へ出た Reveal | 載った後 | T(arrive) より前 | THE anchor が初めて載った slot |
|---|---|---|---|---|
| 正常 | 7 | 0 | 2 | 703 |
| anchor の保留 | 7 | 0 | 2 | 722 |
| 読み取りの失敗（tick の失敗 39 回） | 7 | 0 | 2 | 723 |
| 再起動 | 6 | 0 | 0 | 722 |
| 再試行 | 7 | 20 | 2 | 703 |

5 つとも判定は失敗。つまり、**修正の前の keeper は、どの場面でも THE anchor より先に平文を RPC へ渡している**。⑱の指摘を、RPC の境界で再現した。

- T(arrive) より前の 2 件は、本人から預かった平文（owner material）の Reveal。T(arrive) の約 593 秒前（slot 627）に出ている。⑱の「最大約 600 秒前」と一致する。
- 再起動の場面では、その 2 件が出なかった。修正の前の keeper は、本人から預かった平文をメモリにしか持たず、再起動で失う（⑱の修正は journal に保存する）。秘匿とは別の、取りこぼしの問題である。
- 既存の play の試験 6 件は、`Watch` を挟んでも通る（変化なし）。

## 注意（試験の限界）

- **チェーン側は THE anchor が無くても Reveal を受け付ける**。実際の program（`permutation-frontier/src/proc/reveal.rs:803-835`）は、anchor が無ければ archive の墓標と latch だけを見る。試験のモデル（`keeper/tests/model/play.rs` の reveal）も同じ。したがって、「チェーンで拒否される」ことは、そもそも防御にならない。秘匿は keeper（と送信する側）が守るしかない。④の 2026-10-31 の記録の「早すぎて失敗した Reveal」という書き方は不正確だったので直した（CONTINUITY §5）。
- **in-process の chain には fork が無い**。「古い読み取り」（巻き戻る確定の前の状態や、遅れたノードからの読み取り）は再現していない。**未実行**。
- 実際の SBF の program と、公開の RPC では試していない。

## 修正を受け取った後の手順

1. sha256 を照合する。bundle の前提・HEAD・tree を確かめ、patch から復元して一致するかを見る。
2. 統合 HEAD の隔離コピーに、⑱の keeper・fclient の修正と、この patch を当てる。
3. `cargo test -p keeper --test play -- --test-threads=1`（ws04_* の 5 件と既存の 6 件）、frontier-node の workspace の試験、④の 72 件と 5 件を走らせる。
4. 正常な場面で Reveal が実際に出て、settle まで進むこと（公開できる場合を塞いでいないこと）も合わせて見る。

## ⑱から届いた修正の条件（2026-10-31、データとして受け取った。未受領・未検証）

- 正本：`r18-package-20261031.tar.gz`（sha256 `e75ab1e4…8884`、commit 90df6a64 まで）。補助：`r18-package-20261031-addendum.tar.gz`（sha256 `0272442237b4145a4b39d5e3c51b3a636500c5a5c33818aff740d36d07f6ee90`）。branch `claude/brave-bohr-xe4n4p`、HEAD `2d3351c8ce4579d4ce70203c6500390d066b8399`（tree `0ba555476f8c28b50c6e7a953691eef393e406a3`）、コードの最終 commit は `3ec952358f133412ee8b69c75c9327f2fbc7ea87`（tree `c985148149adf67a111c5d28524e8a396a689cf1`）。どちらも④の環境には未着。
- ⑱の判定の条件（④の問いへの答え）：THE anchor がチェーンにあり、かつ keeper 自身が drand から取った T(arrive) の署名を固定の鍵で検証できたときだけ Reveal を作る。RPC の読み取りだけには頼らない。BellAnchor は、bell・region・season が一致したときだけ anchor とみなす。
- ⑱の報告する試験：擬似 RPC が受け取った全取引の全命令から、Reveal の tag と平文・salt のバイト列を探す。次の場合はどれも送信 0 件で、条件がそろった後は Reveal が出る（`play.rs` の `w6t_tests`、`testkit.rs` の `FakePort.fail_reads`・`FakeDrand.down`、`mutations.log`）。
  - anchor が無い
  - 読み取りが失敗する
  - drand に届かない
  - 古い bell・別 season・別 region・別 owner の anchor
  - drand の公開前の anchor
  - 所有者の再送と再起動
- 受け取ったら：⑱の試験と、この文書の 5 場面（in-process の chain で、RPC の境界で判定する）を、同じ tree で走らせる。正常な場面で Reveal が出て settle まで進むかも見る。⑱の条件は「T(arrive) の署名の検証」を含むので、基準で T(arrive) より前に出た 2 件（owner material）も 0 になるはずである。
