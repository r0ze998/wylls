# 04 安全境界: 防げること・防げないこと

「試験」の列はこの作業機で通った試験（[05](05-results.ja.md)）。すべてホスト上の試作での結果で、Solana プログラムとしての保証ではない（[00](00-context.ja.md) §4）。

| 依頼の境界 | 仕組み（案 B） | 試験 | 防げない・未確認の範囲 |
|---|---|---|---|
| 他人の資源・権限・秘密鍵を勝手に取得できない | 呼出しは Citizen の wallet か期限内の session の署名、Holding の所有者＝呼出し者、Grant は（利用者, manifest id）ごと。op は呼出し者自身の Holding と状態しか参照できない（他人を指す operand が語彙にない）。Grant は wallet だけが書ける | `r01`、`r02` | session 鍵が漏れれば、Grant の範囲内で使われる（コアの session と同じ）。Solana の署名検証そのものはランタイムに依存（試作ではモデル化しただけ） |
| 無限実行 | 分岐・ループ・呼出しの op が存在しない。1 entry ≤32 op、各 op は定数時間＋`Holding::settle` | `r07`（0x08–0xFF 全コードが `UnknownOp`） | `Holding::settle` の内部ループ（予約の完了の数＝最大 4）は既存のコアと同じ。SBF 上の CU は未測定 |
| 再入 | 解釈器はコアの他の命令も外部プログラムも呼ばない | 構造上（op がない） | 案 C を採るなら Solana の `ReentrancyNotAllowed` に依存（[10](10-research.ja.md) §0） |
| 非決定的結果 | 入力は call・状態・Holding・`now_ts` だけ。整数のみ、checked 演算 | `f02`（2 回の実行で receipt id 一致） | `now_ts` はコアが `Clock` から渡す値。どの slot に入るかは利用者が選べない（時刻に依存する op は、到着時刻と同じく前後し得る） |
| 過大な状態作成 | manifest ≤1,024 B、fields ≤8、`max_instances`、instance は固定長 240 B、rent は作成者負担 | `r07`、`r08` | 作者が多数の manifest を公開することは止めない（公開ごとに作者が rent を払う）。instance を閉じる操作は未設計で、`max_instances` は「作られた数」 |
| 偽の完了記録 | receipt は前の receipt id を持つ鎖。状態が鎖の先頭を持つ。検証器が再実行して receipt と後の状態を照合 | `v01`、`v02` | 検証器が受け取る前後の状態（archive）が正しいことは、既存の検証器と同じく RPC・索引の信頼に依存 |
| 二重実行 | `seq` の一致。成功で 1 進む。再送は必ず拒否 | `r03` | ④が「再送が拒否された＝失敗」と誤読しないよう、`last_receipt` で完了済みを判別する約束が要る（[01](01-contract.ja.md) §5） |
| コア資源の発行・消費は規則を通す | `Pay`/`Burn` は `Holding::pay`、`Refund` は預かりの範囲で `Holding::credit`。発行の op はない。残高を直接書く op はない | `r09`、`f03`（保存則） | 「何を消費させてよいか」はゲームの判断。v1 は Burn（消費）を許す。消費を禁じるか上限を設けるかは採用前に決める（[06](06-adoption.ja.md)） |
| 版の固定 | manifest id ＝ 正準 byte 列の SHA-256（非正準・余分な byte は拒否）。Grant は id に固定。更新は新 id。コアの版（`program_version`、`ruleset_hash`）も manifest に固定 | `r04`、`r05`、`r07` | **解釈器そのものの意味は effect_set の番号で区別するだけ**。コアのアップグレード権限者が同じ番号の意味を変えないことは運用の約束（プログラムの `.so` ハッシュの固定は既存 V2 が見る） |
| 停止・取消・アップグレードと実行済み効果の区別 | 停止・取消は新しい呼出しだけを拒否。実行済みの状態と receipt は残り検証できる。停止中は出口（Withdraw）で預かりを戻せる。取消は恒久。更新は旧 id を変えない | `r04`、`r06` | 停止の直前に送られた取引の順序は slot の順。利用者が「停止前に誓った資源」を作者が取り上げる手段はない（op がない）が、停止中は `fulfil` も止まるので、名声などの報酬は得られない |
| 検証器が未知の操作を見逃す問題を成功扱いにしない | 未知の effect_set・receipt 版・op・manifest 欠落・状態欠落は UNVERIFIABLE。FAIL は UNVERIFIABLE より優先 | `v03`、`v04` | **既存の再生検証器（`frontier-node/crates/verify`）は、知らないタグの Frontier 命令を黙って飛ばす**（事実（コード）。各検査が `from_tag` の None を `continue`）。修正案は [patches/0001](patches/0001-verify-unknown-instruction-is-unverifiable.patch)、効果は [05](05-results.ja.md) §3 |
| 任意コードを本番に開かない | 案 B は作者のコードを実行しない。manifest はデータ | — | 解釈器はコアの一部なので、解釈器のバグはコアのバグになる |
