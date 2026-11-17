# 03 試作: 宣言型の効果（案 B）をホスト上で動かす

**範囲。** [`ext-kernel/`](ext-kernel/) は、案 B のコア側（解釈器・検査・記録）と第三者の検証器を、ホストの Rust で書いた最小実装。コア資源の増減は**本物の規則カーネル**（`permutation-rules` の `Holding::pay`・`Holding::credit`・`Holding::settle`）を通し、ハッシュもコアと同じ `permutation_rules::hash::sha256`（Solana では `sol_sha256`）を使う。版はコアの `PROGRAM_VERSION_S1 = 4` と `RULESET_HASH_V3`（`frontier-abi`）に固定する。

**していないこと。** Solana プログラムへの組込み、SBF ビルド、LiteSVM・validator での実行（[00](00-context.ja.md) §4：SBF ツールチェーンの導入が承認されていない）。オンチェーンでの口座と命令への対応は [patches/0002](patches/0002-core-extension-instructions.md) に案として書いた。crate は `#![no_std]`＋`alloc` で、規則カーネルと同じくプログラムに組み込める形にしてある（組み込んで確かめてはいない）。

## 1. 部品

| モジュール | 役割 | 契約 |
|---|---|---|
| `manifest.rs` | 正準 byte 列、`id = sha256("WYLLS-EXT-MANIFEST\0" ‖ bytes)`、厳格な解読（未知の op・非正準・余分な byte を拒否）、公開時の静的検査 | [01](01-contract.ja.md) §1–2 |
| `exec.rs` | 解釈器 `run_entry`（純関数）、コア定義の出口 `run_withdraw` | §2、§3 |
| `registry.rs` | 公開・更新（新 id＋`supersedes`）・停止／再開／取消と履歴 | §3（⑥の最小欄） |
| `grant.rs` | 利用者の許可（manifest id に固定）、`GrantAdapter`（②⑨⑩への差し替え点） | §4 |
| `host.rs` | コア側の検査の順序と原子的な書込、receipt の記録 | §5 |
| `receipt.rs` | Call と Receipt、`receipt_id`、鎖 | §5 |
| `verify.rs` | 第三者の再実行。PASS / FAIL / UNVERIFIABLE | §6 |
| `describe.rs` | 利用者 B が許可の前に読む説明（manifest の byte 列だけから作る） | §1、§4 |
| `buffer.rs` | 分割書込み。hash の確認と公開検査の後にだけ登録（r3） | §3b |
| `examples.rs` | 例の manifest（**例であり、採用したゲームルールではない**） | — |

## 2. 必須の実証（`tests/flow.rs` `f01`）

1. **作者 A が作る。** 「見張りの誓い」（`examples::watch_vow`）を byte 列にして登録簿に公開する。id はその byte 列のハッシュ。
2. **利用者 B が確認する。** 登録簿の byte 列だけから `describe` を作る。B が読む内容（実行時の出力。id は [05](05-results.ja.md)）:

   ```text
   extension "watch-vow" by a1a1…a1
   id 67e2e82e…7ecb
   core program_version 4 ruleset <RULESET_HASH_V3>
   state: 4 field(s) per user, at most 3 users
     field0: 0..=1000 (starts 0)            ← 誓いの回数
     field1: 0..=4611686018427387903 (starts 0)  ← 解ける鐘
     field2: 0..=1000 (starts 0)            ← 名声
     field3: 0..=20000 (starts 0)           ← 預けている木材
   may take up to 20000 milli Wood per call (core resources only; enforced by the core interpreter)
   entry 0 (arg0 in 1000..=20000, arg1 in 1..=144)
     require field3 == 0
     pay arg0 Wood from your holding into your escrow
     field3 := arg0
     field1 := now_bell
     field1 += arg1
     field0 += 1
     record event 1
   entry 1 ()
     require field3 > 0
     require now_bell >= field1
     refund field3 Wood from your escrow to your holding
     field3 := 0
     field2 += 1
     record event 2
   cannot: create resources, touch another user's holding or escrow, call other programs
   stop: the author or the operator may pause or revoke; you can then withdraw your escrow
   ```

3. **B が自分の許可だけで呼ぶ。** B の wallet で Grant（この id だけ、1 回 10,000、累計 15,000）を出し、B の署名で `pledge(10,000, 6)`。B の木材が 10,000 減り預かりが 10,000 増える。C の Holding は変わらない。5 鐘目の `fulfil` は規則が拒否し、何も書かれない。6 鐘目の `fulfil` で木材が戻り、名声が 1 になる。Grant の残りは 5,000。
4. **第三者が検証する。** 公開 byte 列、登録の履歴、前の状態、Call と Receipt の列、後の状態だけを渡し、`verify` が **PASS**。

### これは既存命令の合成ではない

コアの 74 命令に、「利用者が選んだ時刻まで資源を預かり、時刻が来たら返して数を数える」状態はない。資源を置く口座は Holding・Vault・Caravan だけで、Vault への移動は隊商（襲撃・世代の規則つき）、Caravan は到着と受取の規則に従う。回数（名声）を数える欄もない。したがって A 案（合成）では作れず、③が示したとおり合成は部分集合にとどまる（③ `t11`）。

**合成で足りる例**（基準として）は③の courier（SendCaravan の CPI 転送と委任）で、この試作では作り直していない。

## 3. 拒否の例（`tests/refusals.rs`、`tests/verifier.rs`）

| 種類 | 例 | 結果 | 試験 |
|---|---|---|---|
| 他人の鍵・資源・許可 | C が B として署名／作者が B として署名／B が C の Holding から払う／Grant のない C／session 鍵で Grant を書く／C が B の Grant を書く／期限切れ session | `NotSigned`／`NotOwner`／`NoGrant`／`SessionExpired` | `r01` |
| 権限の逸脱 | Grant の 1 回上限超え、累計超え、許可していない entry、期限切れ・取消・回数切れ | `GrantCap`／`GrantEntry`／`GrantExpired`／`GrantRevoked`／`GrantCalls` | `r02` |
| 二重実行 | 同じ Call の再送、seq の飛ばし、同じ記録を 2 回含む記録簿 | `SeqMismatch`、検証は FAIL `SeqReplay` | `r03` |
| 異なる版 | 作者が v2 を公開（新 id）、B の v1 の Grant で v2 を呼ぶ／v1 は v1 の意味のまま／他人の「更新」／作者でない公開 | `GrantVersion`、v1 は名声 +1（v2 は +2）／`NotAuthor`／`NotSigned` | `r04` |
| コアの版違い | `program_version` 5、ruleset 違い | `CoreVersion` | `r05` |
| 停止・取消・実行済み | 一時停止中の呼出し、出口（他人は不可、Grant が有効で Active 中は不可）、再開後、取消は恒久 | `Paused`／`NotSigned`／`ExitNotOpen`／`InstanceClosed`／`Revoked`。実行済みの receipt と状態は残る。全体の検証は PASS、停止中の時刻の呼出しを含む履歴は FAIL | `r06` |
| 返却（r3） | Grant の期限切れ・取消・回数切れ、コアの版の変更で出口が開く／2 度目の返却／自分の別の Holding へ／他人の Holding へ／返すものがない／返却の記録の重複／開いていない出口の記録／5 手の全 16,807 通り | `ExitNotOpen`→返却、`InstanceClosed`、`NotOwner`、`NothingToWithdraw`、検証 FAIL。全通りで保存則と利用者だけでの全量回収、検証 PASS | `e01`–`e06` |
| 分割書込み（r3） | 未完成・欠落・120 通りの順序・重複・食い違う片・違う内容・正しい hash の不正 manifest・他人・範囲外 | `Incomplete`／`ChunkConflict`／`HashMismatch`／`UnknownEffectSet`／`NotSigned`／`NoBuffer`／`OutOfBounds`。登録前の呼出しは `NotRegistered` | `b01`–`b07` |
| PASS にしない（r3） | 2 つの正直な履歴への 1,254 個の改変 | PASS 0。知らない・欠けたものは UNVERIFIABLE | `n01`、`n02` |
| 無限実行・未知の op | 33 op、範囲外の参照、上限のない資源の支払い、予約 id、未知の effect_set、0x08–0xFF の全 op コード、非正準・余分な byte、1,025 B | `TooManyOps`／`BadReference`／`BadBounds`／`UnknownEffectSet`／`UnknownOp`／`Malformed`／`TooLarge` | `r07` |
| 過大な状態作成 | `max_instances` = 3 を超える 4 人目 | `InstanceCap` | `r08` |
| 発行・残高の書換 | 預かりのない返却、Holding にない量の支払い | `EscrowInsufficient`／`Insufficient` | `r09` |
| 原子性 | 支払いの後の条件で失敗、欄の上限超え | `RequireFailed`／`FieldBounds`。Holding・状態・Grant・記録は不変 | `r10` |
| 偽の完了記録 | receipt の増減・event の改竄、呼出しと食い違う receipt、到着前の「完了」、記録の削除、鎖の分岐、receipt なしの状態変化、id と違う byte 列 | 検証 FAIL（`ReceiptMismatch`／`CallReceiptMismatch`／`RulesRefuse`／`FinalStateMismatch`／`SeqReplay`／`ChainBreak`／`UnexplainedWrite`／`ManifestHashMismatch`） | `v01`、`v02` |
| 検証器が知らないもの | manifest がない、未知の effect_set・receipt 版・語彙、最終状態がない、コアの版がない、拡張の外での Holding の変化 | 検証 **UNVERIFIABLE**（PASS にしない） | `v03` |
| 決定性 | 同じ入力を 2 回 | receipt id と状態が一致 | `f02` |
| 保存則 | 4 回の誓いと返却 | 常に Holding＋預かり＝最初の量 | `f03` |
