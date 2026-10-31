# MagicBlock ER 接続候補：委任対象と信頼境界（⑲、候補・未採用）

2026-10-31。基点 `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`。**候補です。採用・配備はしていません。** 決定 O8（`docs/frontier/DECISIONS.md`、「Season 1 は Solana 本体のみ。ER の経路は置かない」）と、現行プログラム冒頭の「no MagicBlock」（`permutation-frontier/src/lib.rs:2`）はそのままです。世界は継続し、期間の区切りでは終わりません（2026-10-31 の方針訂正）。この文書もその前提に立ちます。

## 1. 結論

- **現行 S1 の口座は、どれも委任対象にしません。** S1 のプレイヤー操作は、どれも Citizen（財布・セッション鍵・預け金、`frontier-abi/src/prologue.rs:1140-1168` の行動バケット）を書きます。Province は全員の状態を抱え、賞金の Tally が読みます。委任すると、⑩の所有権の保証と⑰の決済の前提（`owner == game program`、`permutation-prize/src/lib.rs:399-409`）が崩れます。技術的にも委任できません。Season 以外はすべて `create_with_seed` の住所で PDA ではないので（`frontier-abi/src/addr.rs:1-11`）、委任プログラムが要求する「所有プログラムが PDA として署名する」形にならず、曲線外であることの検査（`request_undelegation.rs` の `is_on_curve_fast`）も通りません。
- **最小の対象は、価値を持たない新しい PDA 口座 1 つです（「板」）。** 世界ごとに 1 つ、`["wylls-er-board", le64 world_id]`。家賃だけを持ち、所有記録・賞金・得点・乱数・時刻の規則のどれにも使いません。何を書くかの用途（公開した計画の下書き、国の卓など）は**決めていません**。この候補では、委任・commit・解除・脱出の仕組みを検証する運び手として使います。
- **速くなるもの**は、拘束力のない高頻度の書込みです。ローカルで、ER 上の書込みは 2〜3 ms、base は約 360〜460 ms でした（RESULTS 参照）。base の 1 件ごとの手数料もかかりません。**速くしないもの**は、価値・所有・得点・乱数・時刻に関わるすべてです。これらは L1 に残します。

## 2. S1 の口座ごとの判定

各口座の作り手と書き手は、コードの調査に基づきます（`frontier-abi/src/v2/prologue.rs`、`permutation-frontier/src/proc/*.rs`）。

| 口座 | 主な書込主体 | 価値・権利 | ER に置いた場合に速くなるもの | 判定 | 理由 |
|---|---|---|---|---|---|
| Season（PDA） | 運営、keeper（委任不要の誰でも）、SettleProposal | 作成保証金 | なし（ほぼ読むだけ） | L1 | すべての命令が読む。賞金プログラムが `owner == game` で読む |
| Frontier・RingSeed・ProvinceFund・DefencePool | keeper、運営 | ProvinceFund と DefencePool は lamports の積立 | なし | L1 | 価値を持つ（⑰）。地図拡張の資金 |
| JoinShard | Join、SettleTicket、SettleCapture | なし | Join の競合が減る | L1 | Join・占領と同じ取引で Citizen と一緒に書かれる。単独では移せない |
| BeaconLog・BellAnchor・SeedCache・AnchorArchive・DefenceClaim | keeper（BLS 検証） | 料金の証拠、家賃 | なし | L1 | BLS12-381 の syscall（SIMD-0388）が ER で使えるか未確認。アンカーの着地 slot が keeper の遅延判定（`lateness_slots`）の証拠で、ER の slot は意味が違う |
| Citizen | 本人・セッション鍵（全 P 命令）、占領・奪取の相手 | 財布、セッション鍵、預け金 | 本人操作が速くなる | **L1** | ⑩の所有権の根。賞金の Claim が読む |
| Holding | 本人、keeper（GatherClash は他人の分も）、捕獲 | 移動の預け金、pool_owed | 移動・建設 | **L1** | 預け金（⑰）、所有（⑩） |
| Province | 全プレイヤーと keeper | 得点（領地ターン） | 解決処理 | **L1** | 全員の軍・隊商・施設を抱える。Tally が読む（⑰） |
| Vault・Caravan・Structure | 本人、襲撃・奪取の相手、keeper | Caravan は料金の lamports | 隊商・施設操作 | **L1** | 奪取・没収と所有（⑩）、料金（⑰） |
| Nation | Propose・Vote（本人）、SettleProposal（keeper） | 方針表 | 投票 | L1 | SettleProposal が Season・Citizen・Holding も同時に書く |
| ArrivalSlot・ArrivalDay・ClashInputs | keeper（Reveal、GatherClash） | 料金の証拠 | 解決処理 | L1 | 封印進軍・drand（⑱）。slot を証拠に使う |
| MarchState | S1 では CloseMarch だけ | なし | なし | L1 | S1 では使われていない（FoldMarch は拒否） |
| 賞金プログラム（Pool・Vault・Entry） | 参加者、運営 | 試験用 USDC | なし | L1 | ⑰の対象。委任しない |
| **板（新規、候補）** | 世界の authority（委任・終了・脱出）、書き手（用途は未定）、ER 上で誰でも（commit） | 家賃のみ | 高頻度の書込み、手数料なし | **委任対象（候補）** | 価値も所有記録も持たない。解除後は L1 でそのまま続く |

ER 上で S1 の命令を動かすには、ほかにも未確認・不適合な点があります。

- **時刻。** bell は `Clock.unix_timestamp` から決まり（`permutation-frontier/src/clock.rs:59-62`）、遅延の判定には slot を使います（`defence.rs:19`、`transit.rs:64`）。ER の時計と slot が base と同じ意味である保証はありません。
- **CPI の範囲。** System 以外への CPI はなく、トップレベル命令だけを許しています（`get_stack_height`）。
- **ER 上の命令イントロスペクション。** Instructions sysvar を読んで ComputeBudget の入札を見ますが、ER での扱いは未確認です。

## 3. 信頼境界

| 誰・何 | 信頼してよいこと | 信頼してはいけないこと |
|---|---|---|
| base（Solana L1）、`finalized` | 委任の有無（所有者、委任記録）。最後に commit した板の内容。解除・ロールバックの事実 | — |
| base、`confirmed` | 表示 | 委任・解除の判断（巻き戻りうる） |
| ER の検証者（単一の順序付け役） | 委任中の板の書込みの順序と即時の反映（「live」）。**commit する内容も検証者を信じるしかない**（下記） | 確定。ローカルで、ER のストレージを消すと、commit していない書込みが黙って消えた（RESULTS §2.4）。検閲・遅延もありうる |
| ER の RPC の切替先 | `getIdentity` が委任記録の検証者と一致し、`(seq, head)` が既知の最大以上であること | 別の識別子、低い版。調停器は無視して警告するか、停止する |
| 世界の authority 鍵（既存の運営鍵。新しい鍵は作らない） | 委任先の選択、セッションの終了、脱出の要求 | 板の内容（書込みは compare-and-set でしか変わらない） |
| 委任プログラム（DLP） | 委任・commit の nonce・解除・タイムアウト後のロールバック | ロールバックで返るのは「最後に finalize した base の内容」だけ。ER 上の新しい状態は失われる |

委任中、ER の検証者は板について次のことができます。

- 書込みを遅らせる、拒む、並べ替える。
- commit を出さない。
- **任意の内容を commit する。** 委任プログラムは、検証者が署名した状態（CommitState → Finalize）を受け入れるだけで、ER での実行を base で再検証しません（`delegation-program` @ `41e3d1d3` の `commit_state`／`finalize`）。

板が守るのは次の 2 つだけです。

- 委任していない他の口座には触れられないこと。
- 解除時に、内容が「この世界の板」の形をしていること（callback が magic と世界の ID を検査する）。

**板の中身について、検証者は完全に信頼される立場にあります。** 価値・所有・得点を板に置かない理由はこれです。

緩和策（未実装、課題）：板の `(seq, head)` は書込みごとの記録（ログ `ERB`：seq・head・request・payload）の連鎖です。ER の取引ログを再生した結果と commit された `(seq, head)` を突き合わせれば、改ざんは検出できます。突き合わせられるのは、ER が履歴を保持している間だけです（ローカルの ER は `getSignaturesForAddress`・`getTransaction` を返した。公開 ER の保持期間は未確認）。

## 4. 書込主体・確定性・使えなくなった場合（板）

| 操作 | 層 | 誰 | 確定の意味 | 使えないとき |
|---|---|---|---|---|
| Init | base | authority（板に記録） | base の finalized | — |
| Write（compare-and-set on `(seq, head)`） | 委任中は ER、それ以外は base | 署名者（用途の規則は未定） | ER：live（確定ではない）。base：finalized | ER 停止中は誰も書けない。base はプログラムが拒否する（所有者が DLP）。L1 が自動で引き継ぐことはない |
| Delegate | base | authority（＝委任の家賃支払者） | finalized | — |
| Commit | ER | 誰でも | base で finalize されたとき | 委任された支払い口座がなければ、1 セッションに 10 回まで（委任プログラム v2.0.1）。計画器は 9 回で区切る |
| CommitAndUndelegate（セッション終了） | ER | authority | base で所有者がこのプログラムに戻ったとき | — |
| RequestUndelegation（脱出 1） | base | authority（家賃支払者の署名が必須） | finalized | 人が判断して実行する |
| UndelegateWithRollbackAfterTimeout（脱出 2） | base | 誰でも（要求から 9,000 slot 後、約 60 分） | finalized。板に「ロールバック済み」の印と seq を残す | commit していない ER の書込みは失われる（ログ `ERB_ROLLBACK`） |
| 解除の callback | base | 委任プログラムだけ（buffer の所有者と内容を検査） | finalized | — |

## 5. 継続世界での扱い

- **セッションは期間で閉じない。** 委任セッションが閉じるのは次の 3 つのときだけです。戦期の境界・期間の切替を理由にした解除はしません（`frontier-er/src/plan.rs`）。
  - commit の予算が尽きそうなとき
  - 世界が信頼する検証者を交代するとき
  - 保守のとき
- **一本の版の鎖を保つ。** 板の `(seq, head)` は、何度委任しても、解除しても、ロールバックしても一本の鎖で続きます。試験で確認しました（1440 bell・10 戦期・多数セッション、`frontier-er/tests/continuing.rs`）。
- **世界の ID。** 板が S1 の連鎖ヘッダの `season_id` の位置に入れる値は、世界の ID です。Season PDA を世界の識別子として使い続けるか改名するかは、④・⑧の移行判断です。板の側では終わりの時刻を持ちません。
- **継続運用の費用。** 長く続けると、セッションごとの費用がかかります。devnet の文書では 0.003 SOL/セッション＋commit 1 回ごとに 0.001 SOL ですが、未計測です。委任された支払い口座（delegated fee payer）を使うかは、⑰・運用の判断です。
