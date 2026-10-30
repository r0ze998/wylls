# ⑫ 記憶・会話・関係が AI の次の行動を変える（最小実装）

会話を保存するだけでなく、**過去の協力・約束・不履行を根拠付きで覚え、次の取引相手の選択に効かせる**ための module と、決定的な fixture によるデモ・回帰テスト。実 LLM への通信・課金はしない。

- 調査（既存の再利用と OSS 比較）：[01-survey.ja.md](01-survey.ja.md)
- ④⑤⑬ との接続契約：[02-contracts.ja.md](02-contracts.ja.md)

## 実行

```sh
node workstreams/12-memory/demo/run-demo.mjs                 # デモ（表示のみ）
node workstreams/12-memory/demo/run-demo.mjs --json workstreams/12-memory/results/demo-output.json   # 成果物を再生成
node --test workstreams/12-memory/test/*.test.mjs            # 回帰テスト（19 件）
# または: sh workstreams/12-memory/run.sh
```

Node 22 の標準ライブラリだけで動く（`npm install` 不要）。`permutation-gateway/citizens/` の `memory/config.mjs`（正規 JSON・sha256）と `mind/sanitize.mjs`（固定の消毒）を import する。既存ファイルは変更していない。

## 最小デモ（`results/demo-console.txt`）

A が B に木材 100 を直接会話で頼む → B が受ける → ④の事実として B の隊商が発送・**A に DELIVERED で精算** → A は「依頼 id・受諾 id・chain 記録 id」を出典に覚える → bell 300 の次の依頼で、B・C・D の三者から選ぶ。**三者の価格・距離・在庫・到着は全 arm で同一**。

費用 = 価格×数量 + 20×距離 + (1−E)×失敗時の損失 1200（E は A から見た相手の信頼度推定、何も知らなければ 0.5）

| arm（履歴） | B の E | 選択 | 記憶なしなら | 記憶が選択を変えたか |
|---|---|---|---|---|
| none（履歴なし） | 0.5 | C（1540） | C | いいえ |
| kept（B が履行、chain で確認） | 0.636 | **B（1476.5）** | C | **はい**（差 63.5） |
| broken（B が「送った」と申告、記録なし） | 0.317 | C（B は 1859.4 に上昇） | C | いいえ（B を遠ざける方向に効いた） |
| kept_but_cheaper_C（C が単価 7） | 0.636 | C（1340） | C | いいえ（価格が記憶に勝つ） |
| kept_but_no_stock（B の在庫 50） | 0.636 | C | C | いいえ（B は不適格） |

各 arm の出力には、候補ごとの費用項・`memory_delta`（記憶による費用の増減）・引用した記憶 id・出典 id 付きの記憶ブロックが入る。後で Claude／GPT に渡す入力そのものは `results/inputs/<arm>.json`。

**これは決定的な参照 policy の結果であり、「LLM が自然に理解した」「人が面白いと感じた」証拠ではない。** 数値（減衰の半減期・偽申告の上乗せ・失敗時損失）は設計上の仮置きで、調整していない。

## 必須条件とテストの対応（`test/memory12.test.mjs`）

| 条件 | 実装 | テスト |
|---|---|---|
| 発言・本人の解釈・確認済み事実を分ける | 記録の**型**で分ける（`utterance`=said / `note`=interpreted / `fact`=verified）。発言者が flag で昇格できない | 「a promise is talk」「speech cannot create a fact」「every summary line carries sources」 |
| 約束を話しただけで権限・契約・履行にしない | 約束は派生状態 `promised`、`authority:false`・`contract:false`。履行は DELIVERED の fact だけ。送り主・受取人・資源・時刻が一致し、1 回の配達は 1 件にしか使わない | 「a delivery only counts when…」「one delivery settles one promise」 |
| 出典・時刻・対象・公開範囲・訂正・失効 | 全記録に id・bell・visibility・sources。note に `expires_bell`、`correction`、fact に `rollback`。追記のみ | 「rollback」「wrong note is corrected」「note expires」 |
| 要約で出典が消えない | 要約行は基にした全記録 id を持ち、すべて閲覧者が解決できる | 「every summary line carries sources」 |
| 見える情報だけ・秘密の漏洩なし | fold の最初に可視性で絞る。rollback は対象と同じ可視性を強制 | 「isolation」（私的会話・封印行軍・他国の卓が入力にも要約にも派生値にも出ない。入力ハッシュが無関係な arm と一致） |
| 会話中の命令文は信頼しない | 本文は untrusted で消毒して `untrusted_messages` に置くだけ。limits は呼び出し側だけが渡す。act は whitelist、余分な field は拒否。policy の回答も検証 | 「instructions in conversation cannot change budget…」 |
| 偽の履行申告 | 申告は `claimed_unverified`、期限後は `broken`＋`false_claim`（黙っていた場合より重い） | 「a fake delivery claim…」 |
| 重複イベント | fact の id は chain 参照だけから決まる。同じなら `duplicate`、中身違いは `collision` で拒否・記録 | 「a duplicate fact is a no-op…」 |
| 誤記憶の訂正 | 本人の note だけ訂正可。訂正前の時点の再現も可能 | 「a wrong note is corrected…」 |
| 矛盾した証言 | testimony は表示・照合のみで信頼度に数えない。食い違いは `conflicting`、検証可能なら `contradicted_by_fact` | 「testimony is shown…」 |
| 再起動 | JSONL journal を再生して同じハッシュ・同じ判断。壊れた最終行は無視 | 「restart」 |
| 関係値を上げ続けない・何が何に効いたか説明 | Beta 推定（正負の根拠を別に持つ）、半減期で事前値 0.5 へ戻る、観察だけの根拠は半分の重み。襲撃・消失・取り下げは中立。判断ごとに `memory_delta`・記憶なしの選択・引用 id を `decision` 記録に残す | 「reliability is not a counter…」「demo」「a valid model answer…」 |
| 記憶があっても状況で他を選ぶ | 価格・距離・在庫・到着・予算が同じ費用式に入る | demo の 5 arm |

テストが本当に効くかは、主要な防御（可視性・rollback・消費済み配達・偽申告・collision・余分な field・観察重み・入力の複製）を一つずつ壊して失敗することを確認した。

## 限界（未実装・未検証）

1. **本線に未接続**。既存 AI 市民の契約 v1.3 付録 A.5 は約束・pact を「不活性」に保つことを定め（ledger `commitments` は常に空、pact 語を拒否）、再有効化には契約の新版と所有者の判断が要る。⑫は別 module として置いただけで、mind・brain・watcher・prompt は変えていない。
2. **④の受取人解決が前提**。`CARAVAN_SETTLED` は受取人 tag を持たない。fixture では解決済みとして与えている。
3. **配達と約束の対応はヒューリスティック**（送り主・受取人・資源・時刻が合う最初の未使用の配達）。同じ相手と同じ資源の別取引が重なると取り違えうる。隊商に約束 id を載せる手段はない。
4. **`broken` は「④の記録が届いていない」ことに依存**。④が遅れると一時的に `broken` になる（後から配達が届けば `late` に変わる）。猶予は 6 bell。
5. 発言者の認証は呼び出し側（社会層の署名検証）に任せている。⑫自身は署名を検証しない。
6. 参照 policy の数値は仮置き。実 LLM で同じ入力を使った比較・人の評価はしていない。⑤の token 予算に応じた `memory[]` の切り詰めは未実装（現状の入力は約 3 KB）。
7. journal は単一プロセス・単一ファイル。同時書き込みの排他、容量上限・圧縮はない（既存エピソードの 200 件上限のような規則は未導入）。
8. 規模の試験（多数の住民・長期間）はしていない。fold は毎回全件を走査する。

## 復元

ブランチ `claude/trusting-allen-dox8j6`（基点 `4cd901de`）。push していない。`git bundle` と patch を作業ディレクトリ外にも保存した（最終報告に記載）。追加したのは `workstreams/12-memory/` 以下だけ。
