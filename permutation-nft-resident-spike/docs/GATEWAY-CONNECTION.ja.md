# 既存 gateway への接続：所有者・世代・session の確認（v0.8、2026-11-05）

依頼：共有パッチ 01・03・04 を現行の relay・agent wallet と照合し、隔離したブランチで所有者・世代・session の確認アダプターと回帰試験を進める。A→B→A の譲渡、古い署名・MCP 委任、処理中の譲渡、応答喪失、再起動でも旧所有者の権限が復活しないことを確かめる。共有コアの変更は独立した差分にする。

## 1. 照合の結果（旧パッチ 01・03・04 と現行コード）

照合先は `origin/main` の `921429322d5aecd1a3df0dd8d82c405c87dd985a`（2026-10-31 以降 main は動いていない）。

| 旧パッチ | 現行への適用 | 照合で見つけたこと | 今回の扱い |
|---|---|---|---|
| 01 relay | 通る | 判定は署名検査の直後に 1 回だけ。シミュレーションの間に譲渡が着地すると、そのまま送る（処理中の譲渡を止めない） | 作り直し：replay の確保の後に判定し、**送る直前にもう一度読む**。拒否時は quota を返し、replay の確保も外す |
| 03 agent wallet | 通る | **agent の owner が保有者か**を見ている。A→B→A で A が保有者に戻ると、A が売る前に委任した agent が、A の再委任なしに動き出す（旧 03 だけを当てた main で再現：A→B 後は refused、B→A 後は **sent**） | 作り直し：**agent の鍵**が「現保有者が現世代で設定した session」かを見る。委任の見え方（`delegation()`）にも反映 |
| 04 画面 | 通る | 保有者の違いだけを見ていた | 保有者に加え、session が現世代・現保有者の設定かを見る（`ResidentSessionStale`） |

他のブランチとの重なり：同じ 3 ファイルを main から変えているのは、④ の `preserve/ws04-a967f5f1`（agent gateway に ③ 0005・⑤ 0001 を適用済み）と、agent wallet より前の古いブランチ 3 本（`frontier/playtest`、`frontier/ux`、`archive/claude-submit-20261029`）。④ のブランチでは agent gateway の差分が隣の行（`route`）で当たらないため、④ 向けに作り直した版を `patches/v2/` に置いた（§4）。

## 2. 何を作ったか

**共有コアの差分（3 つ、それぞれ 1 ファイルだけを変える独立したコミット。`patches/v2/` にも同じ内容）**

| 差分 | ファイル | 内容 | `ctx.residents` が無いとき |
|---|---|---|---|
| 0001 relay | `permutation-gateway/src/frontier/routes/relay.mjs` | `residentRefusal(ctx, citizen, actor)` を追加（export）。`sponsor()` で、署名した鍵（`shape.authority`）が Citizen の住民の現保有者として行動できるかを、replay の確保の後と、送る直前の 2 回確かめる。拒否は 403 `ResidentHolderChanged`／`ResidentSessionStale`／`ResidentSessionExpired`／`ResidentUnverified`。settle の要求者（quota の請求先）も同じ判定を通す | 挙動は変わらない |
| 0002 agent wallet | `permutation-gateway/src/frontier/agent/gateway.mjs` | `#build` で、agent の鍵が住民の現 session か（現保有者が現世代で設定し、期限内か）を確かめる。拒否は `SessionNotDelegated`（`resident` に理由）。`delegation()` は `delegated: false` と理由を返す | 挙動は変わらない |
| 0003 画面 | `permutation-server/web/frontier/fsession.mjs` | `matchesCitizen(session, citizen, now, resident?)`：保有者が違えば `ResidentHolderChanged`、session が現世代・現保有者の設定でなければ `ResidentSessionStale` | 第 4 引数が無ければ挙動は変わらない |

**試作側（共有コアではない）**

| ファイル | 内容 |
|---|---|
| `src/resident-gate.mjs` | `ResidentGate`：gateway が呼ぶ `check()`／`mayAct()`。規則は住民プログラムの `Op` の入口と同じ（保有者本人か、保有者が現世代で設定した期限内の session）。毎回チェーンを読み、何も覚えない。読めない・別プログラム・collection 違い・住民口座が無い・別 asset に紐付く → 拒否。`ResidentBindings`：Citizen → asset の対応（メモリか JSON ファイル、原子的に書く、一度決めたら動かない） |
| `test-gateway/worlds.mjs` | 住民側の 2 つの実装：mock（住民プログラムの規則をメモリで再現、実物と同じ 133 byte の口座）と real（**実 Core バイナリと実住民プログラム**をループバック validator に載せ、実際の取引で変える） |
| `test-gateway/gateway-residents.test.mjs` | 回帰試験（§3） |

## 3. 試験と結果（2026-11-05）

| 試験 | 環境 | 結果 |
|---|---|---|
| 既存 gateway の全試験（`permutation-gateway` で `npm test`）、**変更前の main** | 共有コアそのまま | 2,529 件：合格 2,528、skip 1、失敗 0 |
| 同、**共有コアの差分 3 つを当てた後** | `ctx.residents` 無し（既存の挙動） | 2,529 件：合格 2,528、skip 1、失敗 0（当てる前と同じ。§6） |
| 接続試験、mock 住民（9 件） | relay・agent wallet は実コード、Frontier 側は gateway の試験用チェーン、住民は mock | 9/9 合格 |
| 接続試験、**実 Core＋実住民プログラム**（6 件） | 同、住民は validator 上の実物を実取引で変える | 6/6 合格 |
| 対照：差分なしの main で同じ mock 試験 | — | 1 合格・8 失敗（応答喪失だけは既存の replay・冪等キーで通る） |
| 対照：旧パッチ 01・03・04 の main で同じ mock 試験 | — | 2 合格・7 失敗（処理中の譲渡・再起動・失効理由・画面ほか） |
| 対照：旧パッチ 03 だけ | agent の A→B→A | B→A 後に旧 agent が **sent**（復活） |
| 試作の既存試験（`node --test test/*.test.mjs`） | — | 67/67 合格 |
| LiteSVM（`svm-core`） | 実 Core | 9/9 合格（2026-11-05 の再実行） |

接続試験の中身（mock と real の両方で走る 6 場面、mock だけの 3 件）：

| 場面 | 確かめたこと |
|---|---|
| A→B→A、relay | 世代 0 の A の財布と A の session K は通る。A→B の後：A の財布、K、先に署名しておいた A と K の取引はすべて 403。B が B の世代で設定した K2 で署名しておいた取引も、B→A の後は 403。B→A の後も K は 403（世代 2 で A が設定し直すまで）。住民口座は世代 2、session 設定者は空 |
| A→B→A、agent（MCP の capability 経路と owner の command 経路） | Frontier の session だけでは動かない（住民側の委任が要る）。A→B 後：capability は有効なまま拒否、`delegation()` は `delegated:false`。B→A 後も拒否、A が世代 2 で委任し直して初めて sent |
| 処理中の譲渡、relay | シミュレーション中に譲渡が着地 → 送る直前の読み直しで 403、送信 0、quota は減らない、replay の確保は外れて同じバイト列はもう一度判定される |
| 処理中の譲渡、agent | 同じ。hold は全額戻り、帳簿は一致 |
| 応答喪失、relay／agent | 着地済みの取引を譲渡後に再送 → 送らない（relay は replay、agent は同じ冪等キーで記録済みの結果を返す、送信は増えない） |
| 再起動 | relay を作り直す（replay の記憶が消える）。agent の台帳・鍵・住民の対応はファイルから戻る。譲渡後：A の着地済みの取引の再送も、K の未送信の取引も 403（記憶ではなくチェーンの読取で拒否）。B→A の後も旧 agent は拒否 |
| 読取の失敗・偽 collection・住民口座なし（mock のみ） | 403 `ResidentUnverified`。住民に紐付かない Citizen はこれまでどおり通る。`requireBinding` ならそれも拒否 |
| 住民 session の期限切れ（mock のみ） | Frontier の session が有効でも 403 `ResidentSessionExpired` |
| 画面の判定（単体） | 第 4 引数なしは従来どおり。売却後は `ResidentHolderChanged`、前の世代の session は `ResidentSessionStale` |

## 4. `patches/v2/`

| ファイル | 当て先 |
|---|---|
| `0001-relay-resident-gate.patch`、`0002-agent-gateway-resident-session.patch`、`0003-web-fsession-resident.patch` | `origin/main`（`92142932`）に順に `git am`／`git apply`。このブランチのコミットそのもの |
| `0002-agent-gateway-resident-session.on-ws04-a967f5f1.patch` | ④ の `preserve/ws04-a967f5f1` 用（③ 0005・⑤ 0001 適用済みの agent gateway）。0001・0003 はそのまま当たる |

旧パッチ 01・03・04（`patches/` 直下）は**置き換え済み**。消さずに残すが使わない。

## 5. この接続で保証できないこと（共有コアの program を変えるまで）

1. **relay を迂回されると止められない。** Frontier program の Citizen は財布で決まり、保有者の世代を持たない。旧保有者 A が自分で手数料を払ってチェーンへ直接送れば、program は受け付ける。旧権限の失効は **relay と agent wallet を通る経路だけ**で効く。チェーン上で効かせるには、Citizen への世代の欄（旧パッチ 02 の `HOLDER_GEN` 等）と program の入口の検査が要る（④ の判断、未着手）。
2. **新しい保有者 B は A の Citizen を操作できない。** gate は B を通すが、program は `Citizen.WALLET`（A）の署名か A が設定した session しか受け付けない。B が SetSession を出すこともできない（財布のみ）。「譲渡で操作権が買い手に移る」は、program の変更まで実現しない。今回できたのは「旧保有者を止める」側だけ。
3. **譲渡の前に送った取引は、譲渡の後に着地しうる。** relay は送る直前まで確かめるが、送った後の順序はチェーンが決める。Frontier program は世代を見ないので、その取引は効く（住民プログラムの `Op` なら `StaleGen` で拒否される）。
4. **A の財布で署名した取引は、A が保有者に戻れば通る。** A→B→A の後、A が売る前に自分の財布で署名しておいた取引は、blockhash の有効期間（150 ブロック、約 1 分）の間なら relay を通る。A 自身の署名で A が保有者なので、第三者に渡した権限の復活ではないが、世代で縛ってはいない。
5. **委任は 2 か所に要る。** agent や session 鍵が動くには、Frontier の SetSession（従来）に加えて、住民プログラムの SetSession（保有者・現世代の記録）が要る。relay はいま住民プログラムの取引を中継しないので、保有者が自分で手数料を払う。1 回で済ませる方法は未決（U33）。
6. **Citizen と住民の対応を誰がいつ書くか**は未決（U32）。試験では手で書いた。

## 6. 既存 gateway 全試験の記録

| 木 | tests | pass | skip | fail | 備考 |
|---|---|---|---|---|---|
| `origin/main` `92142932`（変更なし） | 2,529 | 2,528 | 1 | 0 | 基準 |
| 同＋差分（文言なしの初版） | 2,529 | 2,527 | 1 | **1** | `web-frontier-errors.test.mjs`：新しい拒否コードに画面の文言が無い（D31）。文言を足して解消 |
| 同＋差分 3 つ（コミット `2a1f008b`・`ffdd8ffa`・`062868ac`） | 2,529 | 2,528 | 1 | 0 | 基準と同じ |
| ④ の `preserve/ws04-a967f5f1`＋差分 3 つ（agent wallet は `on-ws04` 版） | 2,539 | 2,538 | 1 | 0 | ④ の木の差分なしの基準は今回走らせていない。接続試験の mock 9 件もこの木で 9/9 合格 |

実行は `permutation-gateway` で `npm test`（`node --test test/*.test.mjs screens/logic.screen.mjs`）。ログは作業環境の scratchpad（`gw-20261105/`）に残し、リポジトリには入れていない。
