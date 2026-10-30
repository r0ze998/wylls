# 10 ③の引き渡し：再現手順、他担当との契約、鍵と認可の限界、ChatGPT 実機検証の承認事項

作業日 2026-10-30。③は追加実装をここで止める。この文書は、統合の判断と ChatGPT 実機検証の承認のための資料である。

書き方の区別:

- **実行**：この作業機で実際に動かして確かめた。
- **コード**：ソースを読んだ結果。実行はしていない。
- **報告**：他担当の報告に書かれていた内容。成果物はまだ受け取っていない。
- **未確認**：確かめられていない。

## 0. 状態の区分（最初に読む）

| 区分 | 中身 | 根拠 |
|---|---|---|
| **実チェーンで動いた部分**（ローカル） | MCP の HTTP と OAuth（試験用の認可サーバー）、読取のツール、`prepare_caravan`、`send_caravan`。送付は代理人の財布（AgentGateway）、relay、frontier-localnet 上の Frontier プログラムを通る。到着は keeper の SettleCaravan と herald の events で判定する。隊商 2 本が `delivered` まで進んだ | 実行：[results/mcp-local-stack.json](results/mcp-local-stack.json)（season 93） |
| **②④の仮実装（MOCK）** | ② は `wylls.mock-grant/0`（接続時の上限：回数・1 回の積荷・期限）。④ は `wylls.mock-run-receipt/0`（要求 → 受理 → 処理中 → 完了／失敗）。どちらも③が仮に決めた形で、②④の契約ではない | コード：`mcp/src/ports.mjs` |
| **⑤への追加パッチ**（未適用） | [patches/0005](patches/0005-agent-wallet-sendcaravan.patch)：SendCaravan を代理人の行動（`transport` 群）に加える | 実行：一時 worktree に当てて試験した |
| **ChatGPT** | 何も実行していない。登録・OAuth・確認の表示・ツールの選び方・モデルの耐性は、どれも未確認 | — |

**パッチ 0005 が無いと、書込は使えない。** この repo の gateway のままでは、`send_caravan` は⑤から `ActionNotAllowed` で拒否され、何も送られない（試験 `without patch 0005 the relay refuses the caravan`）。パッチ無しで使えるのは読取と計画まで。

**試験の数は、省略を合格に数えない。**

| 試験 | 全数 | 通過 | 省略 | 失敗 |
|---|---|---|---|---|
| MCP の契約試験（この repo の gateway、パッチ無し） | 31 | 15 | 16（書込が要る試験） | 0 |
| MCP の契約試験（パッチ 0005 を当てた gateway） | 31 | 30 | 1（パッチ無しの時だけ意味がある試験） | 0 |
| gateway の `agent-wallet-*`・`frontier-relay*`（パッチ無し → パッチ有り） | 97 → 102 | 97 → 102 | 0 | 0 |
| ローカル実チェーン E2E | 13 の記録点 | 13 | 0 | 0 |

**E2E の 13 の記録点の内訳。** 5 点は準備である：stack、所有者の参加、倉庫の建設、代理人への委任、MCP の接続。残りの 8 点が MCP の操作の確認：村の状態、不足、隊商 1、倉庫の中身、拒否、隊商 2 と再送、上限、秘密が出ないこと。

## 1. 成功した構成と再現手順

### 1.1 固定する版

| 項目 | 値 |
|---|---|
| 基準 commit | `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（Document consolidated development handoff）。`origin/integrate/claude-consolidation-20261029` と `origin/claude/modest-goldberg-c180fk` に含まれる |
| ③の commit | `2f8ec700`（CPI）、`038b86f5`（MCP サーバー）、`1bb0da2e`（レビュー後の修正）、この文書の commit（保存パッケージの `MANIFEST.txt` に完全な ID がある） |
| 適用したパッチ | E2E と書込の試験は 0005 だけ。0001 は CPI の試験ハーネス用で、MCP には関係しない。0002〜0004 は文章の提案で、差分ではない |
| E2E を流したコード | `1bb0da2e` の直前の作業ツリー（E2E の終了 01:05:43Z、commit 01:06:18Z）。同じバイト列だったことは、この時点では証明していない。そのため保存パッケージでは、bundle から復元した tree で E2E を流し直した（§6、`verify/`） |
| Node | v22.22.0（RUNNING.md の要件は 20 以上） |
| Rust | 1.89.0 と 1.95.0（RUNNING.md §2） |
| SBF | cargo-build-sbf 3.1.9（Agave 3.1.9、platform-tools v1.52） |
| MCP の依存 | `@modelcontextprotocol/sdk` 1.32.1。試験用の devDependency だけで、実行時の依存は無い。`mcp/package-lock.json` の sha256 は `c7c15ec2…e3f59a` |
| gateway の依存 | `permutation-gateway/package-lock.json` の sha256 は `95f3f6b3…119e6b`（repo のまま） |

**この作業機でのビルド結果の sha256**（再現性の検査はしていない。同じ機械で同じ物を使ったことの記録）:

| ファイル | sha256 |
|---|---|
| `permutation-frontier/target/deploy-test-beacon/permutation_frontier.so`（stack が `--beacon test-key` で使うもの） | `676e84f5620a9406006ca4a679b5d1306b5be8d0957c99a49e90fb49c08195f5` |
| `permutation-frontier/target/deploy/permutation_frontier.so` | `2bbc15577dc25bc9d28ba75a49d7d286bbb8762c4557b302d73aab58b37ab7ad` |
| `permutation-prize/target/deploy/permutation_prize.so` | `c386b425f15fdd9ee6473fe3819ef9d4e560d8dd7be7cece54101631eb87b6f6` |
| `frontier-node/target/release/frontier-stack` | `b1bc9ba685be2ddb6fe549307c0f0d0c25511964442d9e4a5b3d4ee3c861a8f1` |

### 1.2 設定（E2E の時の値）

| 設定 | 値 | 意味 |
|---|---|---|
| stack | `up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 --game-hours 16 --season-end-at-play-end --bots 0 --personas off --entry-fee 25000000 --base-port 41700 --season 93` | 10 倍速のローカル世界。試験用 USDC だけ |
| relay（パッチ 0005 の worktree から） | `PSF_REPO=<worktree> FRONTIER_AGENT_WALLET=1 FRONTIER_AGENT_RECONCILE_MS=3000` | 代理人の財布を有効にする |
| 代理人の鍵の置き場 | `FRONTIER_AGENT_CUSTODY_KEY_FILE=<run の外>/agent-custody.json`、`FRONTIER_AGENT_KEYS_DIR=<run の外>/agent-keys` | run ディレクトリを手で作ると stack が「既存の世界」と判断するため、外に置く |
| 代理人の方針 | 許可：`transport`。mode：`auto` | E2E の中で所有者が署名して作る |
| ② MOCK の上限 | `maxSends: 2`、積荷の上限、期限 | E2E の中で所有者が同意画面の文に署名する |
| MCP サーバー | E2E のスクリプトが同じプロセスの中で起動する（`createWyllsMcp` と `createHandler`）。ストアはメモリ、封印の鍵はプロセスごとの乱数 | ファイルにも環境にも秘密を残さない |

### 1.3 起動と検証の手順

前提：§1.1 のツールが入っていること。ネットワークはローカルのポートだけを使う。

```sh
# 0. 取得（保存パッケージから。§6）
git clone <基準 commit を含む clone>  wylls && cd wylls     # 例：origin から integrate/claude-consolidation-20261029
git bundle verify ../ws03-handoff.bundle
git fetch ../ws03-handoff.bundle claude/modest-goldberg-c180fk:ws03-handoff && git checkout ws03-handoff

# 1. ビルド（docs/RUNNING.md §2）
scripts/build-frontier.sh --features test-beacon && scripts/build-prize.sh
npm ci --prefix permutation-gateway && (cd frontier-node && cargo build --locked --release --workspace)
(cd workstreams/03-composability/mcp && npm ci)

# 2. 契約の試験（パッチ無し：15 通過・16 省略）
(cd workstreams/03-composability/mcp && npm test)

# 3. パッチ 0005 の一時 worktree（main tree は変えない）
W=$(mktemp -d)/gw; git worktree add --detach $W HEAD
git -C $W apply "$PWD/workstreams/03-composability/patches/0005-agent-wallet-sendcaravan.patch"
for d in permutation-frontier/target permutation-prize/target frontier-node/target permutation-gateway/node_modules; do ln -s "$PWD/$d" "$W/$d"; done
(cd $W/permutation-gateway && node --test test/agent-wallet-*.test.mjs test/frontier-relay*.test.mjs)          # 102/102
(cd workstreams/03-composability/mcp && WS03_GATEWAY_ROOT=$W/permutation-gateway npm test)               # 30 通過・1 省略

# 4. 実チェーン E2E：mcp/e2e/README.md の手順 2〜4（stack をこの worktree の relay で立て、local-stack.mjs を流す）
```

結果の判定：`results/mcp-local-stack.json` の `result` が `PASS` で、§0 の 13 の記録点があること。

## 2. ②④⑤との契約対応表

②と④の commit は、この作業機の clone にも origin にも無かった（2026-10-30 に確認。`git fetch origin <sha>` は "not our ref"、GitHub の commit 照会は "No commit found"）。そのため、②④については**報告**の内容だけを記録する。報告をもとにした adapter は作っていない。

| 担当 | 報告の基準 | 成果物 |
|---|---|---|
| ② | `dc3bd3d93465eebb65f1815eb702ca779cc31827` | 未受領 |
| ④ | `bd415e7430dafe7284f7bbf7bbce1f78940b2ec6` | 未受領 |
| ⑤ | この repo の代理人の財布（`permutation-gateway/src/frontier/agent/`）。AI staking は資料が無い | 既存コードだけ |

### 2.1 ② 権利

| 項目 | ③の今 | ②（報告） | 判定 |
|---|---|---|---|
| ③の接続時の上限（MOCK Grant）と②の施設交換権 | 所有者が接続の時に署名する、この接続の中だけの上限（回数・積荷・期限）。③のサーバーが守る | 施設の交換の権利 | **不一致（別のもの）**。同じ Grant として置き換えられるものとは扱わない。08 §3 の「置き換えの対象は `MockGrantPort` だけ」は、②の権利が接続の上限と同じ意味を持つと仮定した書き方だったので訂正した |
| StockSwap | 無い（ツールも MOCK も無い） | 素材と生産済みの武具の交換。加工能力の貸出ではない。**未採用** | **一致**（双方とも扱わない） |
| ②の権利を③が確かめる口 | 無い | — | **資料待ち**。②の権利を MCP の操作の前提にする場合は、②の照会の形（誰の権利か、期限、取消）が要る。それまで③の MOCK は「接続の上限」としてだけ残す |
| コアの範囲限定の委任 | 無い（session 鍵は全部か無しか。§3） | — | **資料待ち**（[patches/0004](patches/0004-core-scoped-delegation.md) で要求を整理済み） |

### 2.2 ④ 実行と追跡

| 項目 | ③の MOCK | ④（報告） | 判定 |
|---|---|---|---|
| 状態 | requested / accepted / processing / completed / failed | 報告には全体の一覧が無い | **資料待ち** |
| 取消 | 状態が無い。接続を取り消すと新しい要求は止まるが、送った要求の扱いは表示しない（§3.3） | 取消を 3 つに分ける：新規要求の停止、署名済み要求の照合待ち、取消完了 | **不一致**。③に取消の状態が無い。対応の案は §3.3 |
| 結果不明 | `accepted` のまま `history` に「結果不明、チェーンで決める」と書く。痕跡が無く通し番号も進まなければ `failed`（`NotSent`） | 署名済み要求の照合待ち | **一部一致**。意味は近いが、③では独立した状態ではなく `history` の文章になっている |
| 実入荷量 | `completed` と `outcome: delivered` だけを返す。量は返さない（§4） | 実入荷量の未検証を独立した状態にする | **不一致**。③は「未検証」を示す欄を持たない。今の③の `delivered` は「チェーンが届いたと決着させた」という意味だけで、量の保証ではない |
| 費用 | ② MOCK の上限を「確保 → 消費 → 戻す／解く」で扱う。USDC の費用は⑤の gateway の保留（`charges`）の写し | 4 区分：予約・確定・未確定・解放 | **一部一致**。③の確保は予約に、消費は確定に、結果不明のまま消費した分は未確定に、解く・戻すは解放に当たる。ただし③のは「回数の上限」で、費用ではない。費用の正本は⑤にある |
| 識別子 | `op_` + SHA-256(link, requestId)。gateway の冪等キーは `ws03:<link>:<requestId>` | — | **資料待ち** |

### 2.3 ⑤ 予算・支払い・手動／自動・AI staking

| 項目 | ③の今 | ⑤（既存コード） | 判定 |
|---|---|---|---|
| 予算・残高 | 読むだけ（`GET /f/agent`）。③は台帳を持たない | 代理人の財布の ledger | **一致** |
| 書込の可否 | `POST /f/agent/action` を呼ぶだけ | AgentGateway（mode、方針の版、許可行動、村、保留、残高、日次上限、オンチェーンの委任） | **一致** |
| SendCaravan を代理人の行動にする | パッチ 0005 が要る | 今の `ACTION_GROUPS` に無い | **不一致（パッチ待ち）**。適用条件は [patches/README](patches/README.ja.md) |
| 手動／自動の切替 | 計画の時の `modeEpoch` を送る。manual なら `AgentStopped` | `mode`、`modeEpoch` | **一致** |
| AI staking | 前提にしていない | 資料が無い | **資料待ち**（08 §5 の要求案） |

## 3. 代理人の鍵と認可の限界

### 3.1 3 つの層は別のもの

| 層 | 誰が持つ | できること | 制限するもの |
|---|---|---|---|
| ① MCP の接続（OAuth トークンと link） | ChatGPT など MCP のクライアント | ③のツールを呼ぶこと。書込は `send_caravan` だけで、所有者の場所の間の隊商に限る | ③のサーバー（スコープ、② MOCK の上限、計画の期限、速度制限） |
| ② 代理人の capability | **③の MCP サーバー**（AES-256-GCM で封印して保存） | relay の `POST /f/agent/action` に、⑤の方針の範囲で行動を頼むこと | ⑤の relay（方針、予算、mode、村、relay の形の検査） |
| ③ session 鍵（ed25519） | **⑤の relay の keyring**（`FRONTIER_AGENT_KEYS_DIR/<agentId>.key`、16 進の seed、mode 0600、**暗号化なし**）。MCP サーバーは持たない | **チェーンの上では、所有者の Citizen のプレイヤー命令を、SetSession を除いてすべて署名できる**。期限まで、または所有者が置き換えるまで | チェーン（`player_prologue`：`session_ok` が偽なのは SetSession だけ。期限は最長 30 日） |

コードの根拠：

- `frontier-abi/src/prologue.rs` の `player_prologue`。
- `permutation-frontier/src/proc/citizen.rs`：SetSession だけが `player(…, false)`。ほかに PlaceHome などの `player(…, true)` があり、`conquest.rs:227` も同じく session を受ける。
- gateway の `NEVER_DELEGATED`（Join、SetSession、PlaceHome、FileTicket、FileOutpost、DeclareSiege、RetireHost）は **relay の方針**であって、チェーンの制限ではない。

したがって、**今回のスコープ・上限・予算は「信頼するサーバー」（③の MCP サーバーと⑤の relay）での制限である。鍵そのものの権限が狭くなったわけではない。** relay の外では、keyring の鍵を持つ者は誰でも、その Citizen の命令をほぼすべて送れる。relay は、代理人の鍵が署名した取引を gateway の外では受け付けない（`isAgentKey`）。しかし、それはその relay の中だけの話である。

賞金と USDC について：`permutation-prize` のソースに session の扱いは見当たらない（grep の結果）。session 鍵で賞金を受け取れるかどうかは確かめていない（**未確認**）。預かった試験用 USDC は、別の custody 鍵が持っている。引き出しは、所有者が署名して登録した払出先にしか送られない（コード：`custody.mjs`）。

鍵の範囲をチェーンの上で狭めるには、コアの変更が要る（patches/0004）。

### 3.2 取消と停止の区別

| 操作 | 誰が | 何が止まる | 止まらないもの |
|---|---|---|---|
| MCP の接続の取消（ChatGPT で外す、`/oauth/revoke`、所有者の署名による `/link/revoke`） | 所有者か ChatGPT | その link のトークン。③のストアの capability の写しは消す。新しい要求は受けない | relay の capability そのもの（rotate するまで有効）。session 鍵。送付済みの取引と道中の隊商 |
| ⑤の手動切替（mode を manual にする） | 所有者の署名つき owner command | gateway が代理人の行動を `AgentStopped` で拒否する | チェーン上の session 鍵（有効なまま）。署名済み・送付済みの取引 |
| capability の rotate | 所有者の署名つき owner command | 古い capability は relay で無効になる | session 鍵 |
| チェーン上の session の失効（所有者のウォレットで SetSession を別の鍵か零にする、または期限が切れる） | 所有者のウォレットだけ | その鍵による新しい取引はチェーンで `Auth` か `SessionExpired` になる | 失効の前に着地した取引と道中の隊商。失効と競り合って先に着地した取引 |

**署名済み・送付済みの要求は、どれでも取り消せるとは限らない。**

- 署名して RPC に出した取引は、blockhash の寿命（目安 60〜90 秒）の間に着地しうる。
- 隊商が一度出たら、呼び戻す命令は無い。

**同じ代理人に 2 本目の link を caravan スコープで作ると、1 本目の capability は無効になる**（同意の時に rotate するため）。これはコードを読んだ結果で、試験はしていない。

### 3.3 ④との照合待ちをどこに出すか（提案。実装はしていない）

- **今の③**：送った後に接続を取り消すと、ChatGPT からはその操作を見られなくなる。トークンが無くなるうえ、③の追跡は問い合わせがあった時にだけ進む（pull）ので、取消の後は誰も進めない。結果は、ゲームの画面か herald で見るしかない。
- **提案**：④の 3 区分に合わせる。
  1. 新規要求の停止：link を取り消した時点。
  2. 照合待ち：取消の時に `requested`・`accepted`・`processing` だった操作。
  3. 取消完了：すべての照合待ちが終端になった時。

  照合待ちの一覧は、MCP ではなく所有者の代理人ページ（⑤）か④の受領証の画面に出す。その操作は④の追跡で終端まで進める（③の pull に頼らない）。④の契約が来たら、`receiptOf` と `track` を差し替える時にこの 3 区分を入れる。

### 3.4 秘密情報：確かめた範囲

| 対象 | 確かめた方法 | 結果 |
|---|---|---|
| ツールの回答 | 試験 `secrets: …`（模擬）、E2E の記録の全文を検索（実） | capability は無い |
| ログ | 同上（サーバーのログを全部集めて検索） | capability は無い。Authorization ヘッダ、本文、トークンは書かない作り |
| ストアのファイル | 試験：ファイルの全文に capability・アクセストークン・リフレッシュトークンが無いこと、mode が 0600 であること | 合格。トークン、リフレッシュ、認可コードは SHA-256 の値だけを保存（コード：`auth.mjs` の `db.tokens[sha(…)]` など） |
| 保存の形 | 一時の確認（commit していない） | capability は `v1.<iv 16 字>.<本文>.<tag 22 字>` の形（AES-256-GCM） |
| 同意画面 | 試験：画面の HTML に秘密が無い | 合格。ウォレットは署名だけを返す |
| `results/` と保存パッケージ | 文字列の検索（`access_token`、`refresh_token`、`secretKey`、`capability":"`）、§6 | 見つからない。入っているのはローカルの試験用ウォレットの公開鍵だけ |

確かめていないこと：メモリのダンプ、core ファイル、swap、node の例外ログに capability が出るかどうか。

### 3.5 封印の鍵（`WYLLS_MCP_SEAL_KEY`）の扱い

| 場面 | 今の作り | 確かめたこと | 未確認・提案 |
|---|---|---|---|
| 管理 | 環境変数（32 バイト、base64url）。ストアをファイルにする時は必須で、無ければ起動しない。メモリのストアならプロセスごとの乱数 | コード（`bin/wylls-mcp.mjs`、`seal.mjs`） | 本番では KMS か secret manager から渡す。環境変数は `/proc/<pid>/environ` で同じ利用者から読める |
| 再起動（同じ鍵） | ストアと鍵が同じなら続きから動く | 実行：試験 `… (crash): after a restart …` | — |
| 再起動（違う鍵） | capability を開けない | 実行（一時の確認、commit していない、2026-10-30）：読取は動く。`send_caravan` は `InternalError` になり、何も送られない。操作は `requested` のまま残り、② MOCK の確保も残る | 「鍵が違う」と分かる名前のエラーにし、確保を解くのが望ましい（未実装。追加実装は止めているので提案のみ）。回復の手順：正しい鍵で起動し直すか、所有者が接続を取り消して作り直す |
| バックアップ | 鍵とストアは別々に置く前提 | — | ストアのバックアップに鍵を同梱しない。鍵を失えば capability は開けないが、所有者が rotate して接続を作り直せば済む（鍵の紛失で資産は失われない）。逆に、鍵とストアが一緒に漏れた場合は、所有者が capability を rotate し、mode を manual にし、必要なら SetSession で session を失効させる |
| 削除 | link の取消で、その link の capability を消す（`capability = null`）。ファイルは原子的に書き換える（一時ファイル → fsync → rename） | コード | 古い内容が、ディスクの未使用領域やバックアップ・スナップショットに残りうる。relay の側の capability は rotate するまで有効 |
| ローテーション | 仕組みが無い（鍵を替えると既存の link は開けなくなる） | — | 鍵の版を `v1` の後に持たせ、新旧の両方で開けるようにする案 |
| relay の keyring（⑤） | session 鍵の seed を平文で保存（mode 0600） | コード（`keyring.mjs`） | 暗号化や HSM は⑤の判断。③の範囲外 |

## 4. 到着と試験の根拠

### 4.1 村と倉庫で、入荷の扱いが違う（コード：`permutation-frontier/src/proc/caravan.rs` の `settle_caravan`）

| 宛先 | 決着の時の処理 | CARAVAN_SETTLED の記録 |
|---|---|---|
| 村（holding） | 積荷の全量を `credit` する（`stores[r].add`、その時点で上限で切らない） | `outcome`、宛先、**送った積荷**、手数料 |
| 倉庫（vault） | 資源ごとに `min(have + c, max(cap, have))` で切る。`VAULT_CAP` は 5000 単位。**容量を超えた分は黙って失われる** | 同じ形。**記録の積荷は送った量で、実際に入った量ではない** |

したがって、**`delivered` は「チェーンが届いたとして決着させた」という意味で、入荷量の保証ではない。** 倉庫が宛先の時、実際に入った量は記録からは分からない。決着の前後の倉庫の中身の差から求めるしかない。村についても、決着の後で上限を超えた分がどう扱われるか（次の settle で切られるか）は確かめていない（**未確認**）。

### 4.2 ローカル実験で completed / delivered とした根拠

| 隊商 | completed / delivered の根拠 | 量についての根拠 |
|---|---|---|
| 1（村 → 倉庫、食料 100） | herald の `/h/events` にある CARAVAN_SETTLED（同じ owner_tag と seq、`outcome = 0`） | 倉庫の中身を別に読んだ（herald の倉庫の feed）：食料が積荷の量以上（`inVault >= carry`）。倉庫は空から始めたので、容量の超過は起きない条件だった |
| 2（倉庫 → 村、食料 100） | 同じく CARAVAN_SETTLED | **村の中身による量の確認はしていない**（村は生産が続くので、差が積荷と一致するとは限らない） |

ここで言えることは「容量の超過が無い正常系で、倉庫に入ったことを中身で確かめた」までである。**容量を超えた時に実際の入荷量を正しく検証できることは、確かめていない。** ③のツールは、量が分からないのに 0 や全量と答えることはしない。量の欄そのものを持たず、計画の積荷（`planSummary.cargo`）は「送った量」としてだけ返す。④の「実入荷量の未検証」の状態に合わせる時は、`delivered` に `received: "unverified"` を付け、倉庫が宛先なら決着の前後の中身の差を示す、という形を提案する（未実装）。

### 4.3 悪意あるゲーム内文章

| 言えること | 根拠 |
|---|---|
| サーバーは、ゲーム内の文章を命令として実行しない。書込の引数は計画 ID と requestId だけで、文章は `untrusted` で包んで返す | 実行：試験 `words in the game are data …`（模擬。代理人の履歴に仕込んだ指示が何も起こさない） |
| モデルが誘導されても、書込はサーバーの層（スコープ、上限、計画、⑤の方針）を通らなければならない | コードと試験 |
| **接続したモデル（ChatGPT）が誘導されないこと** | **未検証**。ChatGPT の実機で試していない。誘導されたモデルは、許された範囲の中では（自分の場所の間の隊商を上限まで）送りうる。ChatGPT の書込の確認は人への表示であって、認可ではない |

## 5. ChatGPT の接続：次に承認がいること

### 5.1 公式資料（2026-10-30 に読み直した）

| 項目 | 内容 | 出典 |
|---|---|---|
| 登録の手順 | ChatGPT の web で ChatGPT Plugins（chatgpt.com/plugins）を開き、＋ → 「Add custom MCP server」。名前、Server URL かトンネル、認証を入れ、危険の警告に同意して「Create as a plugin」。使う前に install する | https://developers.openai.com/api/docs/guides/custom-mcp-server |
| 公開範囲（個人・ワークスペース） | 作った plugin は「your personal plugins or the workspace where you created it」に出る。ワークスペースの権限と Lockdown が適用される | 同上 |
| 書込の確認 | 「Write actions by default require confirmation」。`readOnlyHint` が無いツールは書込として扱う。会話の中では承認を覚えさせられる | 同上 |
| 通信 | Streamable HTTP（通常は `/mcp`）。公開 HTTPS か Secure MCP Tunnel。localhost は開発用 | https://developers.openai.com/plugins/deploy/connect-chatgpt 、 https://developers.openai.com/plugins/build/mcp-server |
| 私的な検証 | Secure MCP Tunnel なら、サーバーを公開せずに ChatGPT から接続できる。ただし公開ディレクトリへの申請の要件は満たさない | 同上 |
| OAuth | RFC 9728 と RFC 8414、PKCE S256 は必須。`resource` を authorize と token の両方で送る（`aud` に入れる）。CIMD が推奨、DCR も可、事前登録も可。RFC 9207 を満たせばリダイレクト URI は `https://chatgpt.com/connector_platform_oauth_redirect`。client credentials などの機械間のグラント、API キー、利用者の mTLS は使えない | https://developers.openai.com/plugins/build/auth |
| 公開ディレクトリの方針 | annotations の 3 つを明示する（「they do not grant permission or replace authentication」）。送金・暗号資産の送付・投資取引の実行は不可。デジタル商品・トークン・クレジットの販売は不可。13〜17 歳にも適すること。リアルマネーの賭博は不可 | https://developers.openai.com/plugins/plugin-guidelines |
| 使えるプランと役割 | **未確認**。help.openai.com（記事 12584461）は 403 で読めなかった。開発者向けの資料にも書かれていない | — |
| CIMD | ③は**未実装**。ChatGPT が DCR で接続できることは資料で読んだが、実機では確かめていない | — |

### 5.2 2 つの段階は別のもの

| | 個人・ワークスペースの中の接続の検証 | 公開ディレクトリへの掲載 |
|---|---|---|
| 目的 | §1.4 の各項目（09）を実機で確かめる | 一般の利用者に出す |
| 到達性 | Secure MCP Tunnel か開発用トンネルで足りる | 安定した公開 HTTPS が要る |
| 認可サーバー | 今の試験用のもの（ウォレット署名、DCR）でも試せる。ただし同意画面と DCR が外から届く | 本番の認可サーバーが要る（監査済みの実装、CIMD） |
| 方針 | ワークスペースの規則 | plugin-guidelines の全部。WYLLS の USDC の季節との関係は法務・運営の判断が要る |
| 今回 | **承認待ち**（下の手順） | **対象外**。検証の後に別に判断する |

### 5.3 最小の実機検証の手順（承認を求めるもの。この段階では実行しない）

| # | 必要な操作 | 理由 | リスクと抑え方 | 費用 |
|---|---|---|---|---|
| 1 | ChatGPT の web で custom MCP server を作れるアカウントかワークスペースを用意する（プランと役割を確かめる） | 登録の前提。プランの条件は未確認 | 新しい認証情報は作らない。既存のアカウントを使う | プランの料金（**未確認**。既に契約があれば追加なし） |
| 2 | ローカルの stack（試験用 USDC、10 倍速）と、パッチ 0005 を当てた relay と MCP サーバーを、検証用の機械で起動する | 実チェーンの代わり。本番のネットワークには何も送らない | 公開するのは MCP サーバーだけ。relay と herald はループバックのままにする | なし |
| 3 | Secure MCP Tunnel（推奨）か開発用トンネルで、MCP サーバーの `/mcp` と OAuth の経路だけを外に出し、`WYLLS_MCP_ISSUER` をその URL にする | ChatGPT は localhost に届かない | 同意画面、DCR、メタデータは誰でも呼べる。速度制限と数の上限はあるが、検証の間だけ開き、終わったら閉じる。許すリダイレクト URI は、今の既定では ChatGPT の 2 つと loopback（ローカルのクライアント用）。loopback は外のブラウザからは自分の機械にしか戻らないが、外に出す前に ChatGPT の 2 つだけに絞るかを決める（コードの変更が要る。今回はしない） | トンネルによる（Secure MCP Tunnel の料金は**未確認**） |
| 4 | ChatGPT で接続を作る。認証は OAuth（DCR） | ChatGPT 側のクライアント登録 | 外部サービスへの登録になる。検証の後に削除する | なし |
| 5 | 所有者がブラウザのウォレット（Phantom などの拡張）で同意画面に 2 回署名する（link の文と rotate-capability） | **ブラウザ拡張での署名は未確認**。台本の署名ではなく実機で確かめる必要がある | 試験用ウォレットだけを使い、本番の資産を持つウォレットは使わない。上限は `maxSends` を小さく、期限を短くする | なし |
| 6 | 会話で 09 §1.4 の 5 項目を確かめる：確認の表示、ツールの順、切断の後の続き、拒否、注入された文章への反応 | 実機の確認 | 書込の承認を「覚える」は使わない。録画は、通った項目だけにする | ChatGPT の利用量（プランの範囲内） |
| 7 | 終了：ChatGPT の接続を削除し、`/link/revoke`、capability の rotate、SetSession による session の失効、トンネルの停止、stack の停止 | 後に何も残さない | §3.2 のとおり、取消と失効は別々に行う | なし |

ChatGPT で使えている映像は、この手順で実機の検証が通るまで作らない（09 §3.2）。

## 6. 保存パッケージ

チャットからダウンロードできる 1 つの tar.gz にまとめた。中身（`MANIFEST.txt` と `SHA256SUMS` が正本）:

| 中身 | 内容 |
|---|---|
| `ws03-handoff.bundle` | **thin bundle**。前提の commit は `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（基準）。その後の③の commit と、ブランチ `claude/modest-goldberg-c180fk` を含む。基準 commit は `origin/integrate/claude-consolidation-20261029` から取得できる |
| `docs/` | `workstreams/03-composability/` の文書（`*.ja.md`、`mcp/README.md`、`mcp/e2e/README.md`） |
| `patches/` | 0001〜0005 と README |
| `results/` | repo の `results/`（ローカルの試験と E2E の記録） |
| `verify/` | 別の一時ディレクトリで bundle から復元し、試験と E2E を流し直した記録 |
| `PUBLIC-DIFF.txt` | 基準 commit からの差分の一覧。既存の履歴（基準まで）と、③の成果（その後）を分けたもの |

含めないもの：秘密鍵、トークン、認証状態（ストアのファイル）、代理人と custody の鍵、利用者のデータ、`node_modules`、ビルド結果。

この作業は push の許可ではない。bundle はローカルのファイルで、どのリモートにも送っていない。
