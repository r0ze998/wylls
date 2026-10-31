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

## 第2期（⑰ 決済・⑱ 秘密の進軍・⑲ MagicBlock と公開運用）

| ID | 不変条件 | 破れと判断する条件 | 手段 |
|---|---|---|---|
| T17-1 | 公開 x402 仕様（exact scheme、Solana）に従う一般クライアントが参加費を払える、または「自前 SDK 限定」が明示されている | 一般形式の支払いが拒否され、かつ要件に自前形式の明示が無い | gateway 試験（記録: 拒否される。`extra.instruction: 'Pay+Join'` で明示あり） |
| T17-2 | 支払い成立後に応答を失っても、同じ支払いの再送で決済済みの取引を知れる | 再送が 409 Duplicate だけで取引を名指ししない | gateway 試験 |
| T17-3 | 着金待ちタイムアウト（504）後の再試行で、参加済みの本人に「支払い拒否」と言わない | 402 AlreadyPaid が返る | gateway 試験 |
| T17-4 | mint・宛先・ネットワークの不一致は送信前に拒否される | いずれかが通る | gateway 試験（確認）＋既存試験（vault/mint） |
| T17-5 | 未確定の金額を 0 として表示・解放しない | Claim の応答が読めない Entry を `amount: "0"` と返す | gateway 試験 |
| T17-6 | 参加費・賞金・運営費・AI 運用費・手数料が別台帳で、混ざらない | 同一台帳で合算される箇所がある | コード読解（混在なし。mint が同じ custody と vault は別口座） |
| T17-7 | 参加費を払えるのは参加（Join）と結びついた者だけで、終了後に後払いで受取権を得られない | Pay が Season 状態や Join と無関係に通る | プログラム読解（`pay` は pool OPEN と counted==0 だけ）→ **未実行**（SBF） |
| T18-1 | 封印した目的地は「到着ターンが終わるまで」公開されない（README） | 到着ターン開始時に平文 Reveal が送られる | Web 試験（seal.mjs / marchbook.mjs） |
| T18-2 | 公開済み round を使った試験を秘匿性の証明としない | 文書・試験が秘匿性を主張する | 文書読解（README:90 は否定を明記。drand-replay の 425 は試験環境の性質） |
| T18-3 | 署名偽造・別 round・drand 遅延は拒否または待機になる | いずれかが通る | 既存試験（svm g04/g05、fclient、drand-replay）＝**未実行**（SBF）、fclient は実行可能だが今回は既存結果に依存 |
| X2c | 番号だけ既知で判定の無いタグの着地命令は報告に出る | PASS で所見ゼロ | verify 試験 |
| T19-1 | MagicBlock の委任・commit・解除の順序と再開が、プログラムの規則と一致する | crank の順序がプログラムと逆 | gateway 試験（旧 prototype。Frontier は**未実装**） |
| T19-2 | 公開 RPC の履歴欠落を検出し、欠落を「期限切れ」や「未送信」と誤認しない | findex 初回同期が履歴の端を確認しない、keeper 起動時が履歴範囲を見ない | コード読解（agent 報告の引用）→ **未実装**（公開 RPC 経路自体が無い: TLS なし、`RpcPort::localnet` のみ） |
| T19-3 | snapshot（per-bell file）に後続取引の状態が混ざらない | `--source rpc` の Enriched が後続の bytes を付ける | コード読解 → 試験は**未実行**（RPC 経路） |
| T19-4 | 再起動・再読込で同じ処理を二重に行わない | relay の replay cache がメモリのみ、watcher の wakes が再配送 | コード読解。chain 側の署名重複拒否で実害は限定。agent wallet は B1 と同じ |

## 第3期（継続世界：期間境界をまたぐ処理）

| ID | 不変条件 | 破れと判断する条件 | 手段 |
|---|---|---|---|
| P1 | 境界直前の通常操作は通る | — | ABI 試験（確認） |
| P2 | 期間（戦期）の境界で、収穫・建設・隊商送付などの通常操作が拒否されない | `PlayerStart::finish` が `bell ≥ end_bell` で WrongStatus | ABI 試験（失敗 = 依存の証拠） |
| P3 | 世界の長さが季のパラメータで上限されない | `SeasonParams::validate` が `end_bell ≤ 4_032` を要求 | ABI 試験（失敗） |
| P4 | 境界をまたぐ隊商・加工・預かり・未確定取引・封印進軍が、所有権・数量・処理回数・費用を保つ | いずれかが消失・二重・停止 | 現行コードでは境界＝終了のため **設計待ち**。試験契約として REPORT §9 に列挙 |
| P5 | 長期運用で増え続ける状態（連番・保存量）に上限や剪定の方針がある | 無限に増える、または固定幅が溢れる | コード読解（限界の表） |
