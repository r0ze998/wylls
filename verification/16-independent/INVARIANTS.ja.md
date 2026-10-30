# ⑯ 検査する不変条件と「破れた」と判断する条件

対象は基点 `4cd901de` のコードと ③ `2f8ec700`。各不変条件に、破れを判定する条件と、確かめる手段（実行した試験 / コード読解のみ）を併記する。試験ファイルは `verification/16-independent/README.ja.md` の実行手順で動く。

## A. 供給網（隊商・倉・加工・略奪）

| ID | 不変条件 | 破れと判断する条件 | 手段 |
|---|---|---|---|
| A1 | 隊商の「いまの持ち主」は、記録と公開 feed と画面で一致する（契約 S1-1B §3.5「take で隊商は略奪者のもの」） | CARAVAN_RAIDED(TAKE) 後に、herald の `h/caravans.json` か Web の「道中の隊商」が、元の送り主を持ち主として示す | herald `Caravans::fold` 試験、Web `s1VillageModel`/`s1marks` 試験 |
| A2 | 同じ鍵 (owner_tag, seq) の CARAVAN_SENT を 2 回観測しても、消費側は 1 つの隊商として扱い、送付回数を水増ししない | TAKE 後の再 CARAVAN_SENT を「新しい送付」と数える、または元の持ち主の統計に加算する | keeper `CaravanDuty` 試験（`sent_seen`）、コード読解 |
| A3 | 倉（Vault）の受入は容量 CAP を超えず、超過分の扱い（契約: 消失）が記録に残る | CARAVAN_SETTLED が DELIVERED と全量 cargo を記録し、倉に入った量との差がどの記録にも無い | プログラム読解（`settle_caravan`）、検証器 V23 読解 |
| A4 | 資源は増殖しない：発送で出発元から減った量 ≥ 到着で入った量（経路損失・容量・焼失で減ることはあっても増えない） | 到着側の加算が出発側の減算を上回る経路がある | プログラム読解、permutation-rules の `wear_i64` 単体確認 |
| A5 | 数量の単位は milli（内部）と whole（記録・feed）で一貫し、切り捨て方向が揃う | 記録の whole 値が内部 milli の切り捨てと一致しない、または資源種類を混ぜて合算する箇所がある | コード読解（`cargo_log`、herald `vault_bytes`） |
| A6 | 所有者・保管者・運搬者・利用者の権限は混ざらない：session 鍵は自分の場所間のみ、他人宛は wallet、倉の閉鎖は wallet | session 鍵で他人宛送付や倉の閉鎖が通る | プログラム読解（`WalletRequired`）、③ の t04/t13（③の報告のみ、本環境未実行） |
| A7 | ③の委任（session 枠を courier PDA へ向ける）と、Web/relay の session 枠の使い方が衝突しない | courier へ向けた状態で Web が「鍵を作り直す」を提示し、黙って委任を解除する | Web `fdelegation.delegatedTo` 試験 |
| A8 | CPI 経由の Frontier 命令も、再生検証器が判定対象に含める（③パッチ 0002 の前提） | 検証器がトップレベル命令だけを集め、CPI の CARAVAN_SENT 記録が判定されないまま PASS | verify 読解（`world.rs`）、③ 0002 |
| A9 | ⑩（加工：鉱石のみ）と ⑨（鉱石+木材→兵器）の接続点は、基点の workshop（ore+wood→arms）と一致する | — | ⑨⑩の実物が無いため**未実行**。基点の `arms.rs` の数値のみ記録 |

## B. AI の権限・予算・競合

| ID | 不変条件 | 破れと判断する条件 | 手段 |
|---|---|---|---|
| B1 | 同じ idempotency key の再送は、常に記録済みの結果を返し、2 度目の送信を起こさない（DESIGN §6.6） | 記録の削除（REQUESTS_MAX 超過）後に同じ key が再送され、新しい取引が送られる | gateway 試験（2,000 件超で再送） |
| B2 | 停止（manual）・policy 変更・mode epoch 変更の後に、古い判断は着地しない | 古い policyVersion/modeEpoch の要求が送信される | 既存試験で確認済み（`agent-wallet-gateway.test.mjs`）、再実行のみ |
| B3 | 推論代金（test USDC）とチェーン手数料（lamports）は台帳も単位も別で、未確定を 0 と表示しない | 未確定（unresolved/undecided）が「0」や「無料」と表示される | `fagent.mjs` 読解、view の `charged` 読解 |
| B4 | 権限を失った後（SetSession で鍵を取り戻した後）に有料推論をしない | 委任が無いのにモデル呼出しが課金される | runner 読解（scheduler の delegation 事前確認）、既存試験 |
| B5 | 1 Citizen の session 枠は 1 つであり、本人の Web 鍵・agent wallet・③ courier のどれが持っているかを各画面が区別する | 持ち主を区別できず、誤った案内（鍵の再生成）が出る | A7 と同じ試験 |
| B6 | MCP の `agent_act` は認証確認（agent_view 等）から通常操作へ進めるが、refused は課金されず送信されない | refused なのに hold が残る／課金される | 既存試験で確認（`agent-wallet-mcp.test.mjs`）、再実行のみ |
| B7 | MCP の requestId 名前空間は agent ごとで、他 agent と衝突しない | 別 agent の同じ requestId が IdempotencyConflict になる | gateway 試験 |
| B8 | 同じ agent に対し、本人の MCP と運営の runner が同一ターンに別々の行動を送ることは、設計上の決定として明示されている | 明示が無い（未決定） | コード読解 → **仕様未決定**として報告 |
| B9 | ④（実行器）の Rust コードでの試験 | — | ④の実物が無いため**すべて代役**（基点の JS runner）。区別を報告に明記 |

## C. 事実・記憶・達成・画面

| ID | 不変条件 | 破れと判断する条件 | 手段 |
|---|---|---|---|
| C1 | 「未決着」「到着済み未決済」「配達済み」「消失」「焼失後の空荷配達」を区別できる | CARAVAN_SETTLED(DELIVERED, cargo=0) が通常の配達と区別できない | ABI/記録読解 |
| C2 | CARAVAN_SENT の cargo は塔の損耗適用後であり、発送前の量との差（`worn_bps`）が feed に出る | herald の feed が `worn_bps` を落とし、画面が損耗を示せない | herald 試験（feed に worn_bps が無い） |
| C3 | 画面は、再読込・戻る・二重押し・別ウォレットでも、状態と次の操作を正しく示す | ウォレットのアカウント切替後も旧アカウントとして表示・送信する | Web 試験（`wallet.onChange` と `FS.wallet`） |
| C4 | event と history の重複観測を二重計上しない | keeper/herald の件数が TAKE の再 SENT で 2 になる | A2 と同じ |
| C5 | 記録の遅延・欠落を嘘や不履行として評判に入れない | — | 基点に評判機構なし → **未実行**（⑫⑮の実物待ち） |
| C6 | 「取消完了」「0円」「達成」の表示は、確定した事実だけに出る | 停止操作で「止まった」と出るが、実行中のモデル呼出しや送信済み取引が残る | `fagent.mjs` 読解（表示文言） |

## 横断

| ID | 不変条件 | 破れと判断する条件 | 手段 |
|---|---|---|---|
| X1 | プログラムの RULESET_HASH は規則カーネルの中身から導かれ、処理を変えたのに旧ハッシュを名乗れない | ハッシュが定数で、プログラム本体の変更と無関係 | presets/rules 読解、Web の wasm sha256 の扱い |
| X2 | 検証器は未知タグ・未判定タグの命令を PASS にしない | 未知タグが skip されて PASS | verify 読解・試験 |
| X3 | 予約容量を既存の入荷経路が尊重する | 基点に「予約」は無く、Vault の CAP だけ → A3 として扱う | — |
| X4 | ⑫ allocate は認証された発言だけを受理する | — | ⑫の実物なし → **未実行** |
| X5 | 詳細履歴を削った後に古い要求が再実行されない | B1 と同じ | gateway 試験 |
