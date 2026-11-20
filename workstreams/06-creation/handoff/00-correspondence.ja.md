# ⑥の工房・束・回数制限・荷車と、②④の契約の対応（一枚の表）

**この表の根拠（2026-11-05 に書き直し）：** ②③④の成果物を GitHub の上で読んだ（② `preserve/ws02-rights-dc3bd3d` = `dc3bd3d93465eebb65f1815eb702ca779cc31827`、③ `preserve/ws03-mcp-acdcd0bf` = `acdcd0bf795d10a65f6b8192076c4f8d6357e557`、④ `preserve/ws04-a967f5f1` = `a967f5f1c64facc32facf07010f39a679c77d80a`）。どれも統合候補・保全ブランチの提案で、確定した仕様ではない。2026-10-30 版の「報告の要約に基づく見立て」は、この表で置き換える。補遺（[ADDENDUM-20261030.ja.md](../ADDENDUM-20261030.ja.md)）の訂正を反映した。接続の詳細は [docs/11](../docs/11-connection.ja.md)。

> **2026-11-20 追記（② A が main に入った後の読み直し）：** オーナー判断 ② = A（2026-11-18）で、StockSwap は採用された。main（PR #33、`9bf65700`）にあるのは `frontier-abi/src/v2/rights.rs`（仮の tag・エラー・Grant の形）と `permutation-frontier/src/proc/rights.rs`（命令の処理）。どちらも feature `rights-experimental` の build だけにあり、仮の版の bit `0x2000` で本番の季節と分かれる。既定の build と devnet の dry-run の形には入らない（`PSF_RIGHTS_EXPERIMENTAL_BUILD` は dry-run で拒否）。下の表の②の列のうち「StockSwap は未採用」「受取口は村」は古い。どこが変わったかは末尾の「② A との照合」にまとめた。表の行の状態（⑥の側の接続）は変えていない：⑥のコードは② A の命令をまだ一つも呼ばない。

「状態」の言葉：**接続（変換）** ＝⑥の側で契約の形への変換を実装し、試験した（チェーンとは未接続）。**不一致** ＝契約どうしが合わない。**つながらない** ＝相手の契約がない。**未決定** ＝判断待ち。

| ⑥の要素 | ⑥が求める性質 | ②の契約 | ④（③）の契約 | 状態 | 足りないもの・不一致 |
|---|---|---|---|---|---|
| **荷車**（⑥の `caravan.send`。採用済みの S1 の命令） | 採用済みの計画から実行 id を固定して送り、実行 id で追い、到着と量を次の手順へ渡す。応答消失・再起動でも二重に登録・送信しない | ― | ④ `cf517b55`：`run accept`（上流の依頼者つき、パスをチェーンで確かめる）・`run view`（`p04-run/0.1`）・act の登録簿。③ `84f710d5`：`send_caravan {planId, requestId, runId}`・`get_run_status {runId}` | **接続（④③の実物で照合）**：`ports.mjs`（④の client と runexec、③の道具）・`dispatch.mjs`。④の照会は④自身のストアを本物の CLI で読んだ。④の受付は依頼者をそのまま渡し、拒否を保留にする（[docs/11](../docs/11-connection.ja.md) §11） | ④の受付が依頼者を通す試験（チェーン）。⑥の計画を受け取る gateway の route。③のサーバーを通す試験 |
| **結果**（到着・数える量・C の証拠） | 確定した配達だけを証拠にする。到着量が分からないものを 0 と書かない | ― | ④の15状態、`Verification`（Recorded / RuleDerived / KnownZero / Unverifiable / NotShipped）、数量契約、Receipt（`kind|subject` で重複除去） | **接続（変換）**：`resultOf`・`dedupeReceipts` | ⑥の模擬の記録（`delivered/made/raided/failed`）は④の状態の部分集合。⑥の模擬は置き換えていない |
| **工房**（B：他人の工房を使用権で動かす。⑥の `workshop.run`） | 施設所有者が出した使用権で、利用者の倉の中で加工する | **StockSwap は交換で、加工能力の貸出ではない。⑥の工房の代替にしない**（補遺 §2、② HANDOFF §0）。2026-11-20：② A で採用、`rights-experimental` の build だけ（下の照合 R1・R2） | ④の Run の施設は MOCK（`fac:<run_id>`、P3） | **つながらない** | 加工能力の貸出の契約がない。⑥の工房は S2 の `UseRun` の模擬のまま。最初の体験にどちらを採るかは未決定 |
| **束**（C：配送で届いた物を押さえ、一度だけ消費。採用保留） | 配送の物そのものを排他的に確保 | 押さえの契約なし（StockSwap の預かりは交換の両側のもの。② A でも同じ：照合 R5） | Receipt は「過去の出来事の証拠で、今も物が残っている証明ではない」。押さえの契約なし | **つながらない／採用保留** | 予約・escrow の一般化（必要な場面が出たときだけ） |
| **証拠＋在庫**（C の案B） | 確定した配送の証拠と、実行時の在庫の原子的な検査・消費 | ― | 検証済みの量（下限）だけを数える。④は次の段階の前に正本の在庫を読み直す | **未決定**（変換は `resultOf` の `evidence` まで） | 証拠の「一度だけ使った」印の置き場。⑥の C の手順を④の Run でどう表すか |
| **1日の回数**（暫定：受理された開始で数える） | 利用者 × 定義で、受理された開始を数える | Grant に「1日あたり」の回数はない（② 03 §8）。session の予算・範囲は制限しない | ④は Run を数えない（冪等キーと予算だけ） | **未決定**（補遺 §1） | 正本の層（⑥の模擬の中／統合後の実行サービスの中／チェーン）が未決定。実装は⑥の模擬の中だけ |
| **札の回数**（束ごと・工房ごと1日 × 24） | 実行と同じ取引で検査・加算 | StockSwap の `MAX_SWAPS`・`MAX_UNITS`・`seq` はある。1日あたりはない（② A のコードでも同じ：照合 R3・R4） | ― | **つながらない** | S2 の `UseRun` の形の契約がない |
| **実行の依頼の署名** | 利用者の署名、使い捨て番号、依頼の日 | ― | ④は `run_id` を冪等キーにする。実行者の鍵は session（③-R6） | **接続（変換）**：番号を `run_id` に入れる | ⑥の依頼の署名を④がどこで確かめるか（④の Run に署名の欄はない） |
| **止める**（利用者・施設所有者・運営） | 署名済み・送信済みは必ずは止まらない | 発行者の取消（RevokeGrant、0xD4）は StockSwap にはある。予約中は戻る、実行済みは戻らない（② A のコードで確認：照合 R6） | 取消の3段階（`StoppingNew` → `AwaitingSigned{until}` → `Completed{effects}`）、輸送中は `Ineffective` | **対応づけ（変換）**：`resultOf` が `cancel`・`effects` を渡す | 運営の緊急停止は未決定（docs/08）。⑥の模擬は「新規の停止」だけ |

## ⑥から②④への確認事項

1. **④：** RunSpec の `facility` を省ける形にするか（荷車だけの Run）。
2. **④：** Run に定義の固定（作者・名前・版・内容ハッシュ・効果の版）を載せる欄を持つか。
3. **④③：** 論理名から場所の記録（`kind, p, q, at, gen`）と Citizen の tag を引く読み取り口。
4. **④：** 前の荷車の seq を後の Run の `inbound` に渡す手順。
5. **②：** 加工能力の貸出（使用権）の契約を作る予定はあるか。なければ⑥の工房は S2 の `UseRun` の採否として扱う。
6. **②④⑤：** 1日の回数の正本の層（補遺 §1）。

## ② A との照合（2026-11-20、コードで確かめた）

読んだもの：`frontier-abi/src/v2/rights.rs`、`permutation-frontier/src/proc/rights.rs`（main `760a92b4`）、⑥の `src/world.mjs`・`src/types.mjs`。⑥の前提は、この文書と [02-grant.ja.md](02-grant.ja.md) に書いたもの。**確認**＝コードがその通り。**反証**＝コードが違う。**該当なし**＝② A にその物がない（S2 の札の話で、S2 は main にない）。

### ② A のコードにあるもの（要点）

- 権利は一種類だけ：工房在庫の交換（`KIND_STOCK_SWAP = 1`）。利用者の鉱石・木材を、施設（工房のある村）が**すでに作った**武具と、工房の比率で交換する。工房を動かさず、将来の生産も押さえない。
- 利用者の側は **受取口＝利用者自身の倉（Vault）**。施設と同じ州のタイルにある、生きた倉。武具は倉に入り、出るのは荷車（SendCaravan 0xB1、襲撃 0xB3 あり）だけ。倉は奪える（0xB4）。
- 命令は仮の tag `0xD0–0xD5`：IssueGrant（0xD0）・ReserveSwap（0xD1）・ExecuteSwap（0xD2）・ReleaseSwap（0xD3）・RevokeGrant（0xD4）・CloseGrant（0xD5）。エラーは仮の 200–214（214 = `VaultFull`）。記録の kind は仮の 114–119。
- 発行は**財布だけ**（session は `WalletRequired`）。費用は施設の倉庫から金 25（`GRANT_ISSUE_COST`、燃やす。調整値）。予約・実行は利用者の財布か自分の session。
- Grant の枠：`max_swaps`（実行した交換の回数）・`max_units`（武具の総数）・`expires_ts`（秒。発行から最長 30 日）。1回の予約は最大 10,000。予約は同時に一つ。`seq` は実行済みの回数で、やり直しの二重実行を `SeqMismatch` で止める。
- Grant は施設と受取口を、鍵・世代・持ち主で固定する。奪われた・閉じた・建て直した場所は `StaleHolding`。

### ⑥の前提ごとの判定

| # | ⑥の前提（どこに書いたか） | 判定 | コードの根拠・⑥への意味 |
|---|---|---|---|
| R1 | StockSwap は交換で、加工能力の貸出ではない（上の表「工房」、02-grant §0） | **確認** | `rights.rs`「It does not run the workshop … does not reserve future production capacity」。⑥の工房の手順（B：使用権で他人の工房を動かす）は、② A でも表せない。「つながらない」のまま |
| R2 | StockSwap は未採用（上の表「工房」、02-grant §0） | **反証**（2026-11-18 から） | ② A で採用。ただし `rights-experimental` の build だけ。最初の devnet の形には入らない |
| R3 | Grant に「1日あたり」の回数はない（上の表「1日の回数」、02-grant §0） | **確認** | Grant の欄は `MAX_SWAPS`・`SWAPS`・`MAX_UNITS`・`UNITS_SWAPPED`・`EXPIRES_TS` だけ。1日の回数の正本の層は未決定のまま（Q6-3 は r0ze の判断待ち） |
| R4 | `MAX_SWAPS`・`MAX_UNITS`・`seq` がある（上の表「札の回数」） | **確認** | layout 184–195、ReserveSwap/ExecuteSwap の `seq`。⑥の「札の回数」（束ごと・工房ごと 1日 × 24）は S2 の `UseRun` の形で、② A に対応する物はない（つながらない、のまま） |
| R5 | 押さえの契約はない。StockSwap の預かりは交換の両側だけ（上の表「束」） | **確認** | 預かりは Grant の数（`OPEN_ORE`・`OPEN_WOOD`・`OPEN_ARMS`）で、どの倉庫にもない。配送で届いた物を押さえる一般の仕組みはない。束（Q6-2）は r0ze の判断待ち |
| R6 | 発行者の取消があり、予約中は戻り、実行済みは戻らない（上の表「止める」） | **確認**（補足あり） | RevokeGrant 0xD4。補足：戻す先の場所が無い、または倉に空きが無いとき、その側は **Grant の中に残る**（`ReturnBlocked`。燃やさず、どこにも入れない）。⑥の模擬にこの状態はない |
| R7 | 発行者による取り消しは S2 の規則に見当たらない（02-grant §4） | **該当なし／② A では反証** | S2 の札（Lot・Issue）は main にない。② A の Grant には取消がある。⑥の `GRANT_REVOKED` の説明「whether S2 allows it is ②'s decision」（`src/world.mjs`）は、② A の Grant については答えが出た。S2 の札については未確認のまま |
| R8 | 権利の種類は数値（S2：1 持ち分、2 受け取り、3 使用、4 配達）。⑥は文字列（`use`/`share`/`receipt`）をアダプタで変換（02-grant §4） | **該当なし／衝突に注意** | ② A の種類は `KIND_STOCK_SWAP = 1` だけ。S2 の 1（持ち分）と同じ数で、意味が違う。アダプタを書くときは、数だけで種類を決めないこと（`PROGRAM_VERSION` の bit `0x2000` で② A と分かる）。⑥の `TYPES` に「交換権」の型はない |
| R9 | 確認と消費が同じ原子的な操作（02-grant §1、S2 `UseRun` 2d §3） | **確認**（形が違う） | ReserveSwap が一つの命令の中で、枠・期限・取消・世代を検査し、三つの側を預かりへ移す。数えるのは「回数」ではなく「交換の回数と武具の数」 |
| R10 | 理由の区別：持ち手・種類・取消・無効・期限・回数（02-grant §3） | **確認**（対応表） | `NotGrantee`↔`GRANT_NOT_HELD`、`Revoked`↔`GRANT_REVOKED`、`StaleHolding`↔`GRANT_VOID`、`Expired`↔`GRANT_EXPIRED`、`QuotaExceeded`↔回数切れ。種類違い（`GRANT_WRONG`）は② A では `BadGrant`（一種類しかない） |
| R11 | 期限は日（⑥の `untilDay`） | **反証**（単位） | ② A は秒（`expires_ts`、`now ≥ expires_ts` で `Expired`）。⑥の日との変換は、日の境界（Q6-3、r0ze の判断待ち）に依る |
| R12 | Grant は session の範囲も予算も制限しない（02-grant §0、② HANDOFF §4 ⑤） | **確認**（一点追加） | 予約・実行は session でもよく、行動の枠（action bucket）を使う。ただし**発行は財布だけ**になった（`proc/rights.rs:644`）。⑥の計画が発行を手順に入れるなら、その手順は session では動かない |
| R13 | ⑥の工房は S2 の `UseRun` の模擬のまま（上の表「工房」） | **確認** | `UseRun` は main のコードにない（`git grep` で Rust に無し）。⑥の模擬は未統合ブランチ `ccr-184d6862-fqutoz` の写しのまま |

### ② A で新しく表せるようになったこと（⑥はまだ使っていない）

- 「工房の在庫と交換 → 倉から荷車で家へ」の二段の計画。ReserveSwap と ExecuteSwap を別の手順にでき、`seq` で再実行を止められるので、⑥の journal 先行の送り方（`dispatch.mjs`）と形が合う。⑥にはこの手順の型・効果がまだない。足すのは、⑥のチェーン接続の時期（Q6-1、r0ze の判断待ち）が決まってから。
- 発行の引数（`max_swaps`・`max_units`・`expires_ts`）は、② HANDOFF §4 の通りテンプレートの引数にできる。
