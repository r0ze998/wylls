# ⑫ 記憶・会話・関係が AI の次の行動を変える（隔離した試作、v2）

会話を保存するだけでなく、**過去の協力・約束・不履行を根拠付きで覚え、次の取引相手の選択に効かせる**ための module と、決定的な fixture によるデモ・回帰テスト。実 LLM への通信・課金はしない。

v2（2026-10-30 のレビュー対応）では、事実認定を「誤った評価で関係を壊さない」形に直した。**記録がないことは未確認**、**約束と配送は明示的な割当でだけ結ぶ**、**DELIVERED だけでは数量も受取人も確定しない**、**発生時刻と観測時刻を分け、後から届いた証拠で判断を再評価できる**、**確認済みの評判と分からないことを分ける**。

- 調査（既存の再利用、関連文書、OSS 比較）：[01-survey.ja.md](01-survey.ja.md)
- ④⑤⑬ との接続契約（v2）：[02-contracts.ja.md](02-contracts.ja.md)
- 事実認定の規則：[03-evidence-rules.ja.md](03-evidence-rules.ja.md)

## 実行

```sh
sh workstreams/12-memory/run.sh     # デモ成果物を再生成し、回帰テスト（33 件）を実行
node workstreams/12-memory/demo/run-demo.mjs     # デモの表示だけ
```

Node 22 の標準ライブラリだけで動く（`npm install` 不要）。`permutation-gateway/citizens/` の `memory/config.mjs`（正規 JSON・sha256）と `mind/sanitize.mjs`（固定の消毒）を import する。既存ファイルは変更していない。

## デモ（`results/demo-console.txt`、決定的な参照ルール）

A が B に木材 100 を、A の倉庫（場所・世代を指定）へ届けるよう直接会話で頼む → B が受け、自分の隊商 B#7 をその約束に割当てる → ④が発送・精算・**倉庫の実加算量**・**精算時点の所有者**を報告 → A は約束・割当・各記録の id を出典に覚える → bell 300 の次の依頼で、B・C・D から選ぶ。**三者の価格・距離・在庫・到着は全 arm で同一。**

費用 = 価格×数量 + 20×距離 + (1−E)×1200（E は確認済みの根拠だけ）+ 0.1×1200×（期限切れで未確認の自分宛ての約束の数、上限 2）

| arm | B について A が知っていること | B の E | caution | 選択 | 記憶なしなら |
|---|---|---|---|---|---|
| none | 何もない | 0.5 | 0 | C | C |
| kept | 割当・精算・実加算・所有者まで確認 → `fulfilled` | 0.636 | 0 | **B** | C |
| not_delivered | B「送った」、④の完全な索引に B の発送がない → `not_delivered`、申告は偽（基準を明記） | 0.318 | 0 | C | C |
| claim_no_record | B「送った」、④から何も来ていない → **`unconfirmed`**（`no_record_found`）、申告は未検証 | **0.5（下げない）** | 120 | C | C |
| record_delayed | kept と同じ配送だが、④の記録の観測が bell 310（判断の後） | 0.5 | 120 | C | C |
| 〃 を bell 320 時点の観測で再評価 | `unconfirmed` → `fulfilled`（期限内） | 0.636 | 0 | **B になる** | — |
| kept_but_cheaper_C | kept、ただし C の単価 7 | 0.636 | 0 | C（価格が勝つ） | C |
| kept_but_no_stock | kept、ただし B の在庫 50 | 0.636 | — | C（B は不適格） | C |

各 arm の出力（`results/demo-output.json`）には、約束の状態と理由、申告の判定と基準、確認済み・未確認の内訳、候補ごとの費用項と `memory_delta`（`verified` と `caution` に分けた記憶の効き）、引用した記憶 id、出典付きの記憶ブロック、再評価の結果が入る。Claude／GPT に同じ形で渡せる入力は `results/inputs/<arm>.json`（契約 `wylls.memory12.decision-input/v2`）。

**これは決定的な参照ルールの結果であって、「LLM が自然に理解した」「人が面白いと感じた」証拠ではない。** 実 LLM での検証は未実施（⑤の担当範囲。同じ入力ファイルと回答検証器 `validateAnswer` を使う）。重みはすべて仮設定で、調整していない。

## 必須条件とテストの対応

| 条件 | 実装 | テスト |
|---|---|---|
| 発言・本人の解釈・確認済み事実を分ける | 記録の**型**で分ける（`utterance`=said / `note`=interpreted / `fact`=verified）。派生状態に `unknown` を加えて表示 | core「a promise is talk」「speech cannot create a fact」「every summary line…」 |
| 約束を話しただけで権限・契約・履行にしない | 約束は `promised`、`authority:false`・`contract:false`。履行は割当＋精算＋実加算＋所有者の事実が揃ったときだけ | core・evidence 全般 |
| 記録の欠落を不履行・嘘にしない | `unconfirmed`＋理由。不足は完全な索引があるときだけ確定。E を下げず caution のみ | evidence「absence: …」 |
| 推測で対応付けない・並行取引・分割・二重計上なし | `allocate` 発言＋容量の宣言順消費。未割当は `unassigned` | evidence「allocation: …」 |
| 数量・受取人を DELIVERED だけで確定しない | `caravan_credited`・`place_owner`（精算時点）。不足分の内訳は下限・上限 | evidence「quantity: …」「recipient: …」 |
| 発生と観測を分け、再計算できる | `bell` / `created_bell`、`knowledge(clock, {observedBy})`、`reassess` | evidence「time: …」 |
| 評判と観測不足を分け、偽の基準を明示 | `reliability` に verified・claims・unresolved・neutral・mismatches・evidence | evidence「a claim is false only by a stated criterion」 |
| 出典・時刻・対象・公開範囲・訂正・失効、要約で出典を失わない | 全記録に id・二つの時刻・visibility・sources。note の失効・訂正、fact の rollback。追記のみ | core「rollback」「wrong note」「note expires」「summary line」 |
| 見える情報だけ・秘密を漏らさない | fold の最初に可視性で絞る。rollback は対象と同じ可視性を強制 | core「isolation」 |
| 会話中の命令文を信頼しない | 本文は untrusted で消毒、`untrusted_messages` に置くだけ。limits は呼び出し側だけ。act は whitelist、policy の回答も検証 | core「instructions in conversation…」 |
| 重複・矛盾した証言・再起動 | fact の id は chain 参照から（再観測は duplicate、中身違いは collision）。testimony は数えない。JSONL 再生 | core「duplicate」「testimony」「restart」 |
| 記憶があっても状況で他を選ぶ | 価格・距離・在庫・到着・予算が同じ費用式に入る | demo の arm |

## 限界（未実装・未検証）

1. **本線に未接続（接続前の判断事項）**。既存 AI 市民の契約 v1.3 付録 A.5 は約束・pact を「不活性」に保つと定め（ledger `commitments` は常に空、pact 語を拒否、テストが grep する）、再有効化には契約の新版と所有者の表明が要る。今回の許可は**隔離した記憶試作**までで、会話による権限付与や法的・経済的な契約の成立は扱わない（`authority:false`、`contract:false` は常に固定）。
2. **④の事実が前提**：`caravan_credited`（実加算量）、`place_owner`（精算時点の所有者）、`coverage`（送り主ごとの完全な発送索引）、`lookup_failed`。いずれも今の herald / findex は事実として出していない（findex の account snapshot と event index から導ける見込みはあるが、未確認。02 の依頼参照）。届かない限り、該当する約束は未確認のまま。
3. **`allocate` は当事者の発言**。隊商に約束 id を載せる手段はチェーンに無い。債務者が割当てず債権者もしなければ、届いていても `unassigned` のまま。
4. caution の係数、偽申告の重み、猶予、半減期は仮設定。caution は相手の誠実さを下げないが、判断を慎重にするので、記録の遅れが判断に影響しうる（再評価で検出できる）。
5. 発言者の認証は呼び出し側（社会層の署名検証）に任せている。
6. 実 LLM での比較、人の評価、⑤の token 予算に応じた `memory[]` の切り詰め（現状の入力は約 4.5 KB）は未実施。
7. journal は単一プロセス・単一ファイル。同時書き込みの排他、容量上限・圧縮はない。fold は毎回全件を走査する（規模の試験はしていない）。
8. `reassess` は参照ルールで選び直した場合を示すだけで、当時使われたのが LLM だった場合に LLM が何を選んだかは分からない。

## 復元

ブランチ `claude/trusting-allen-dox8j6`（基点 `4cd901de`）。push していない。保存パッケージ（bundle・patch・成果物・テスト結果・SHA256・手順）は `workstreams/12-memory/` の外に作り、チャットに添付する。追加・変更したのは `workstreams/12-memory/` 以下だけ。
