# 保証範囲の訂正（2026-10-30）

この文書は、⑤のこれまでの報告（`7ac94cc1`・`5c6b6305`）の言い過ぎを直し、何を防げて何を防げないかを段階ごとに書きます。機能は足していません。足したのは、保証を正しく表示するための小さな変更と、再現テストだけです。

**資料の扱い：** ②（`dc3bd3d`、その前 `140fd63`）、③（`038b86f5`／`1bb0da2e`）、④（`bd415e7`）の commit は、取得できませんでした。`git fetch` でも GitHub API でも、この repo に見つかりません（`No commit found`）。この文書の②③④の中身は、**ユーザーから共有された報告の要約**で、コード確認済みではありません。③は、取得できたブランチ `claude/modest-goldberg-c180fk`（`2f8ec700`）の文書とパッチだけを読みました。

## 1. ②への依存の訂正

**前の書き方（誤り）：** 「資源の量・従う相手の中継での強制は②の Grant 待ち」。

**訂正：** 共有された②の最新報告（要約、未確認）によると、②の実装は **StockSwap** で、まだ採用されていません。
- StockSwap は、既存の工房の在庫と素材を交換する権利です。
- 加工能力の貸出ではありません。
- AI の session 権限や、本人の資源予算を制限する仕組みでもありません。

⑤が必要とする制限を②が作る、という前提は成り立ちません。必要な権限と、現状の不足を分けて書きます。

| 必要な権限 | 現状 | 不足 |
|---|---|---|
| 代理が使える資源の量（兵の数・荷の量）を、命令ごとに1回・1日で縛る | 中継の方針は USDC の額と行動の種類だけ。鎖は session 鍵に量の制限を持たない | 中継にも鎖にも仕組みがない。⑤の実行層（1プロセス）だけで縛っている |
| 従う相手・依頼の期限 | 依頼板そのものがない | 同上 |
| 命令ごとの範囲（例：物流だけ） | 鎖の session 鍵は「session 可」の全命令を使える | 鎖に仕組みがない（§2） |
| 対象の施設 | 施設の利用がプログラムにない | 命令もない |
| カテゴリ別の USDC の上限、1回の上限、方針の期限 | ⑤の実行層（1プロセス） | 中継で強制する案がパッチ 0001（未適用） |

誰がこれらを作るかは、決まっていません。②の StockSwap とは別の課題です。

## 2. 制限の強制場所：段階ごとに、何を防げて何を迂回できるか

| 段階 | 防げること | 迂回できる者・経路 |
|---|---|---|
| **モデル** | 何も防がない。モデルは案の文字列を返すだけで、接続トークン・鍵・道具を持たない（テストで、入力に秘密がないことを確認） | — |
| **⑤の実行層（1プロセス）** | モデルの案が、委任条件（命令・量・従う相手・期限・村）と⑤の上限（1回・カテゴリ別）を超えること | 接続トークンを持つ者が `agent_act` を直接呼ぶ。別プロセスの⑤（上限を別々に数える：テスト「two executor processes」）。中継の運営 |
| **中継（AgentGateway）** | `POST /f/agent/action`（トークンか runner）からの依頼が、mode・版・許可した行動・自分の村・USDC の予算と回数・鎖上の委任を外れること。代理の鍵が `POST /f/relay` で署名すること（`AgentKeyDirect`） | **代理の鍵（seed）を持つ者が RPC へ直接送る**（手数料を自分で払えば、中継の検査は一つも通らない。DESIGN.md §5.1）。seed は中継の鍵ディレクトリ（0600）にある。運営（保管口座の鍵も持つ。信頼が前提） |
| **鎖（プログラム）** | session 鍵が期限切れ。session 不可の命令（`SetSession`・`CloseVault`・`CloseStructure` など）。他人への隊商（`WalletRequired`）。ゲームの規則 | **session 鍵を持つ者は、期限まで、その Citizen のすべての村（最大3）で「session 可」のすべての命令を使える。** 命令・資源・回数の範囲はない |

**混同しないこと：**
- 「中継の予算と許可リストが働く」は、中継を通る送りだけの話です。session 鍵を持つ者が RPC へ直接送る取引は、制限されません。
- 「鎖上の委任を確かめる」は、「代理の鍵が今この Citizen の session で、期限内か」を確かめるだけです。物流だけ、ある村だけ、ある量だけに権限を限るものではありません。
  - 根拠：`frontier-abi/src/prologue.rs:1120-1131`（actor == SESSION、期限内か、だけ）と、`frontier-abi/src/v2/layout/player.rs:6-9`（Citizen には `SESSION`・`SESSION_EXPIRY` しかない）。
  - 共有された②④の報告の「既存の session 鍵には命令ごとの範囲指定がない」と一致します。③の文書（`2f8ec700` `02-instruction-matrix.ja.md:51-53`）にも同じ事実があります。

### session の枠の単位：村ではなく Citizen

**前の書き方（誤り）：** 「session の枠は村に1つ」。

**正しくは：** Citizen（1つのウォレットの1シーズン分の口座）に1つです。

| 根拠 | 中身 |
|---|---|
| `frontier-abi/src/v2/layout/player.rs:6-9`、`:24` | Citizen の口座に `SESSION`・`SESSION_EXPIRY` が1組。村（Holding）は `HOLDING @ 168 : HoldingRef x3`（最大3） |
| `permutation-frontier/src/proc/citizen.rs:468-482` | `SetSession` はウォレットだけ（`player(..., false)`）。期限は最大 `MAX_SESSION_SECS`（③の文書では30日）。上書きで1組だけ |
| テスト「the session slot is the Citizen's」 | 同じ持ち主の2つ目の代理（別の村）へ委任すると、1つ目の代理は `SessionNotDelegated` になる。Citizen の口座に範囲の欄がないことも確認 |

**影響：**
- **複数の村：** 1つの Citizen が持つ村（最大3）は、すべて同じ session 鍵で動かせます。中継の「代理は自分の村1つだけ」（`WrongVillage`）は中継だけの制限で、鎖の制限ではありません。
- **複数の代理：** 中継は1人の持ち主に代理を8つまで作らせます（`MAX_AGENTS_PER_OWNER`）。ただし鎖の session は1つなので、委任できるのは同時に1つだけです。後から委任した方が前のを置き換えます。
- **複数の接続：** 同じ接続トークンで MCP を複数つないでも、同じ代理です。中継の台帳は1つの状態ファイルを1プロセスで持つので、予算は合算で守られます（ロック：`agent/lock.mjs`）。⑤の実行層の上限はプロセスごとなので、合算されません。
- **③の外部プログラム：** ③の courier も同じ session 枠を使います。courier に向けると代理の財布は止まり、逆も同じです（③ `04-interface-contract.ja.md` §4）。

## 3. 停止と手動復帰：3つに分ける

**前の表示を直したこと：** 手動に切り替えても、署名済みの取引・送信済みの取引・実行中の推論は取り消されません。「停止すると戻る」のは、送る前の予約（`held`）だけです。

| 段階 | 何が起きるか | どこで | ⑤の表示 |
|---|---|---|---|
| 1 新しい判断・署名・送信を止める | 中継の mode が manual になり、版（`modeEpoch`）が進む。停止前に決めた依頼は中継が断る（`AgentStopped`・`StaleMode`。送る直前の `beforeSend` でも） | 中継 | `stopReport().stage1_stop` |
| 2 署名済み・送信済みの操作と費用を照合する | 送信中（`sending`）は鎖の答えを待つ。着地なら確定。失敗・期限切れが証明されれば返金。証明できなければ未確定のまま。実行中の推論（`running`）は答えが返れば請求、再起動なら未確定。⑤の記録で結果のない行動は「不明」 | 中継の reconcile、⑤の確認 | `stage2_reconcile` |
| 3 未消費の予約を解放する | 送る前の予約（`held`）は停止そのもので返る（理由 `stopped`）。それ以外は停止では返らない | 中継の台帳 | `stage3_release` |

テスト：「a stop in three stages」で次を確かめました。
- 送信中のゲーム支出と、実行中の推論は、停止で返らない。
- 実行中の推論は、停止の後に答えが返った時点で請求される。
- 送る前の予約だけが返る。

**session の無効化（鍵の取り戻し）も3つに分けます。**

| | 中身 |
|---|---|
| 署名者 | 持ち主のウォレットだけ（`SetSession` はウォレット専用） |
| 確定 | `SetSession` の取引が鎖で着地した時点。それまでは代理の鍵が session のまま。**このデモの fixture は Citizen の口座を直接書き換えている（取引も署名もない）。着地した結果の模擬です** |
| 適用範囲 | その Citizen 全体（すべての村、session 可のすべての命令）。同じ枠を使う別の代理・③の courier も外れる |

### ④との接続要件（未検証：④ `bd415e7` は取得できず、共有された報告の要約）

| ④の報告 | ⑤の対応 | 接続の状態 |
|---|---|---|
| 取消は「新規要求の停止 → 署名済み要求の確認待ち → 成立済みの効果を列挙した取消完了」 | 段階1・2・3（`stopReport`）。成立済みの効果の列挙は、追跡（`trace()`）の各行の最終結果 | 形は対応する。④の型で受け渡す部分は未実装 |
| 費用は「予約・確定・未確定・解放」の4区分 | `costClasses()`：予約（送る前・送信中・推論中）、確定（台帳のカテゴリ別）、未確定（結果不明の推論、証明できない送信）、解放（台帳の返金の行。ビューの最後の50行だけ） | 区分は対応する。「解放」の合計は、ビューの履歴が50行で切れるので完全ではない |

## 4. 費用と出金の保証

### 単位と、実際のUSDC移動との区別

- **単位：** 金額はすべて**テストUSDC の最小単位（小数6桁）**です。入金 100,000 は 0.1 テストUSDC です。局所のテスト用の mint で、価値はありません。
- **USDC は一度も動いていません。**
  - 入金：fixture が「所有者が送金した」という取引の記録（`depositTx`）を、scripted chain の `getTransaction` の答えとして置きました。本物の `Custody.verifyDeposit` がそれを読んで、台帳に記帳しました。SPL Token のプログラムは動いていません。
  - 引出し：本物の `Custody.withdraw` が `TransferChecked` の取引を組み立てて署名し、scripted chain に「送り」ました。scripted chain は記録するだけで、着地の状態は fixture（`settle()`）が付けました。

### 固定額と、使用量の計測

| | 中身 | どこで動いたか |
|---|---|---|
| 固定額（1回 10,000 = 0.01 テストUSDC） | 中継の今の規則。トークン数は記録するだけ | デモと全テスト |
| 使用量での計測（トークン数 × 価格、見積りを上限に） | ⑤の `PriceBook` の計算 | 価格表のテスト（計算だけ）と、パッチ 0001 のテスト（使い捨ての作業コピー）。**中継の本体には入っていない** |

### 未確定の費用を勝手に解放しない、予約済みを出金しない条件

| 状態 | 守られること | 根拠 | テスト |
|---|---|---|---|
| 推論の実行中（`running`） | 停止しても返らない。答えが返れば請求 | `gateway.mjs:512-545`、DESIGN §6.5 | a stop in three stages |
| 中継の再起動・TTL 切れ | 実行中は「未確定」（`unresolved`）になる。予約のまま、出金できない。返すのは運営の判断か、既定で無効の期限ルール（`--agent-unresolved-release-ms`）だけ | `gateway.mjs:150-160`、DESIGN §6.5 | a lost answer…restart |
| 送信中（`sending`） | 鎖の証明（着地・失敗・期限切れの証明）がなければ動かない。証明できなければ未確定の印を付けて予約のまま。再起動でも返らない | `fate.mjs`、`gateway.mjs:546-575` | undecided money is never released |
| 出金 | `available` だけ。予約（送る前・送信中・推論中・未確定）は出金できない。全額の引出しは、まず代理を止める | DESIGN §6.2 | money in and out、undecided money |
| 複数プロセス | **中継の台帳は、1つの状態ファイルを1プロセスだけが持つ前提**（ロックファイル）。2つ目の中継プロセスは起動を断られる。**⑤の実行層の上限はプロセスごとで、複数プロセスでは守れない** | `agent/lock.mjs`、DESIGN §6.6・§9 | two executor processes（守れないことを固定） |

## 5. モデル情報の保証の段階

| 段階 | 何が分かるか | ⑤の状態 |
|---|---|---|
| 設定名 | こちらが頼んだ名前だけ | 記録している（`configuredModel`） |
| サーバーの自己申告（別名） | サーバーが名乗る名前。起動スクリプトは、どのファイルにも同じ別名を付ける | 記録している（`reportedAlias`、`servedModel`）。**検証ではない** |
| サーバーの自己申告（ファイル名） | サーバーが言う読み込んだファイルの名前。名前を変えたファイルも同じに見える | 記録している（`modelFile`）。**検証ではない** |
| ファイルのハッシュの照合 | 動いているホストでファイルの sha256 を取り、固定したハッシュと比べる | **未実装** |

`identify()` の答えには `assurance` と `verified: false` を付けました。⑤のコードが、モデルを「検証済み」とすることはありません。

## 6. 本物（実装コード）と模擬：経路とテスト

本物なのは**台帳・中継などの実装コード**です。鎖とモデルは模擬です。③の ChatGPT の実機接続や、実際の鎖の上での USDC の移動は、⑤では何も確かめていません。

| 主張 | 通った本物のコード | 模擬だった所 | テスト |
|---|---|---|---|
| 入金の記帳 | `AgentGateway.deposit` → `Custody.verifyDeposit`（署名者・宛先・mint・金額の規則）→ `AgentLedger.credit`（1つの署名は1回だけ） | 取引そのもの（fixture の `depositTx` を scripted chain が返す）。HTTP の route（`POST /f/agent/deposit`）は通していない（fixture が gateway を直接呼ぶ） | money in and out（二重入金は `already`）、the flow |
| 引出し | 持ち主の署名付き命令（`POST /f/agent/command`、`owner-auth.mjs` の検証）→ `AgentGateway.withdraw` → `Custody.withdraw`（取引を組み立てて署名）→ reconcile → `fate.mjs` | 送金の実行と着地（scripted chain が記録し、fixture が状態を付ける） | the flow、money in and out、undecided money |
| MCP | `mcp/agent-mcp.mjs` の `createAgentMcp().handle()`（JSON-RPC の処理と道具） → 中継の route（`GET /f/agent`、`POST /f/agent/action`、`GET /f/agent/terms`）の handler | 通信路（同じプロセスの中で handler を呼ぶ。stdio・TCP・MCP クライアントのアプリは使っていない） | participation の全テスト、the flow |
| 持ち主の命令（予算・範囲・停止・トークン） | `POST /f/agent/command` の handler、`owner-auth.mjs`、`AgentGateway`・`AgentLedger` | 持ち主のウォレット（テストの鍵ペア） | the flow、stopped or revoked |
| 予算・回数・停止・版・許可・村 | `AgentGateway.submit`・`meterInference`・`AgentLedger.hold` | — | concurrent runs、over the limits、stopping right after |
| 鎖上の委任の確認 | 中継が Citizen の口座を読む `#build`・`delegation()` | Citizen の口座（fixture が書く。`SetSession` の取引はない） | the session slot、stopped or revoked |
| 取引の組み立て・代理の鍵の署名・中継の形の確認と模擬実行 | `#build`・`shapeMessage`・`classify`・`sponsor()` | 模擬実行の中身（scripted chain は署名だけを確かめ、ゲームのプログラムは動かさない） | the demo path、the flow |
| ゲームの効果（兵が増えた） | — | すべて模擬（`settle()` が真似る） | the demo path |
| モデル | local-openai の HTTP クライアント（⑤のコード） | モデル（127.0.0.1 の fake サーバーが台本で答える。モデルではない） | the model is configuration |

## 7. ③とのパッチの接続

- ③の最新（`038b86f5`／`1bb0da2e`）と、⑤向けの隊商のパッチ 0005 は取得できませんでした。**資料待ち**です。
- 参考として、取得できた③のブランチ（`2f8ec700`）のパッチ 0001（`permutation-frontier/svm-tests/src/chain.rs`）を、⑤の 0001 と一緒に、使い捨てのコピーで確かめました。触るファイルが重ならず、どちらの順でも当たります。
- 0005 は隊商を代理の経路に足すものなので、⑤の 0001 と同じファイル（`contract.mjs` の `ACTION_GROUPS`、`gateway.mjs` の `accountsFor`）に触れる見込みです。**未確認です。** 適用順は、0005 を受け取ってから決めます。

## 8. 引き続き未決定

本番の価格、精算の方式、外部モデルの有効化、パッチ 0001 の採用。
