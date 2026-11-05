# ⑫ 統合への引渡し（2026-11-03）

統合担当（④）へ渡すための索引。新しい機能は加えていない。ただし④の数量契約と照合したところ、端数の扱いに⑫の誤りが見つかったので、そこだけ直した（下の B）。commit の SHA・tree・base・ファイルの SHA-256 は、保存パッケージの `RESTORE.ja.md` と `SHA256SUMS` に記す。

## A. ④に求めた事実・attestation：受領・接続できたもの／fixture・仮契約のもの

確認した④の版は `origin/preserve/ws04-a967f5f1`（2026-10-31）。⑧は `origin/preserve/ws08-persistence-ca67d40e` と `ws08-cont-verify-b519cd18`。**⑫が実際に受け取って接続できた事実・attestation は一つもない。** ⑫の試験はすべて fixture（`fixtures/scenario.mjs`）と、⑫が提案した仮契約（`02-contracts.ja.md`）で動いている。④の文書も「⑫の成果物は受け取っていない」と記している（`QUANTITY-CONTRACT.ja.md` §7、`CONTINUITY.ja.md:142`）。

| ⑫が求めたもの | ④・⑧の現状 | ⑫の扱い |
|---|---|---|
| `caravan_sent`・`caravan_settled`・`caravan_raided`（チェーンの記録） | 記録自体はチェーンにある（`fclient` の `CqEvent`）。⑫へ渡す経路は無い | fixture。項目は `CqEvent` に合わせてある |
| 村宛ての加算量 | ④の `RuleDerived` と**同じ規則**（加算は全量、記録は切り捨て。④ §1・§3） | **受け取らずに⑫自身が導く**（`holding-credit-uncapped/v1`）。④と一致 |
| `caravan_credited`（倉宛ての、この配送だけの加算量） | ④の P1（settle の記録に加算量を載せる）は**未適用**。④の `Recorded` に当たる | 仮契約。fixture だけ。無ければ `qty_unverified`（④の `Unverifiable` に当たる） |
| `place_owner`（精算時点の所有者の区間） | 無し | 仮契約・fixture。無ければ `recipient_unverified` |
| `coverage`（世界・partition・全送信経路・gapless・finalized） | 無し。④と⑲は「findex の欠落検出は完全な履歴を保証しない。findex に無いことを起きていない根拠にしない」と明記（`CONTINUITY.ja.md:183`、`INTEGRATION-PLAN-20261031.ja.md:107`） | 仮契約・fixture。**作れる主体がまだ無い**。無ければ「未発送」は決して確定しない |
| `lookup_failed` | 無し | 仮契約・fixture |
| `identity_alias`・`place_alias` | 無し。④の推奨 W1（今の Season の口座を世界の口座として固定し、新しく作らない）が採用されれば、partition は一つで、alias は不要になる。**W1 は未採用**（`CONTINUITY-DECISIONS.ja.md` §1.1） | 仮契約・fixture。W1 の場合は、registry を partition 一つにするだけで⑫は動く（試験済みの構成） |
| `world_id`・partition の登録・世界時計 | W1 案では `season_id` を世界の id とし、bell は u32 のまま続く。未採用 | fixture の仮の値（`WORLD`、`PARTITIONS`、bell） |
| ⑧の継続世界の記憶 | ⑧ `26-continuous-world.ja.md:86,198`：AI の記憶の保存先は実行ごとのまま（未解決）。記録の公開・封印は Season 終了に結び付いたまま（⑫・⑬が決める） | 未着手（残件 4） |

## B. ④の数量契約（`QUANTITY-CONTRACT.ja.md`）との照合と、今回の修正

| ④ | ⑫ | 一致 |
|---|---|---|
| §1 記録の cargo は `floor(milli/1000)` | 同じ前提（`CREDIT_RULES`） | 一致 |
| §3 `RuleDerived`：［b, b+1）、b = 0 でも 0 とは限らない | `rule_derived`。**今回の修正で、端数の余地を判定に入れた** | 修正後に一致 |
| §3 `Recorded`（P1）／`Unverifiable` | `exec_record` が無ければ `qty_unverified` | 一致（P1 は未適用） |
| §3 `KnownZero`：BURN・TAKE・LOST の記録があるときだけ 0 | `raided`・`lost` は中立。同じ caravan の記録があるときだけ | 一致。⑫は BURN と TAKE を区別しない（どちらも中立で、量を数えない） |
| R-1 別の宛先で settle しただけでは「奪われた」としない | 精算の宛先が発送の宛先と違えば `record_conflict`（未確認）。名前を出さず、評判に使わない | 一致 |
| §4 合計：Σb ≥ G で達成、Σb＋n ≤ G で未達、その間は判定できない | **修正前の⑫は Σb < G だけで `partial` としていた**（2 本の 49 で目標 99 が誤って「不足」になる）。b = 0 の配送を「未発送」とする経路もあった（満杯の倉で加算 0 の場合） | 修正後に一致（`qty_sub_unit_uncertain`） |

修正（`src/fold.mjs`）：caravan の整数の加算をすべて割り当て済みの link は、端数を 1 単位まで持ちうるものとして数える（n）。

- `partial` は Σb＋n ≤ 約束量のときだけ。
- `late` は、期限内の分が Σb＋n ≤ 約束量で、期限内では足りなかったと証明できるときだけ。
- その間は `unconfirmed`（`qty_sub_unit_uncertain`）。
- 配送が一つでもあれば `not_sent` にしない。

試験は `test/quantity-units.test.mjs` の 7 件。修正前のコードでは、そのうち 4 件が失敗することを確かめた。変異試験 3 件も追加し、全 60 件で検知した。

## C. 指定の 4 点と最新の試験の対応

| 観点 | ⑫の規則 | 試験（ファイルと試験名の冒頭） |
|---|---|---|
| **unknown と不履行の区別** | 記録が無い・照会失敗・輸送中・未精算・本人や場所の未証明・量の未検証・端数で判定不能は、すべて `unconfirmed`（理由付き）にし、E を動かさない。不履行（`not_sent`・`partial`）は十分な coverage と量の証明があるときだけ。偽の申告は 2 つの基準だけ | `evidence`：`absence: no record at all…`、`absence: a failed lookup and a gap…`、`absence: in transit…`、`absence: "sent" and "delivered"…`、`a claim is false only by a stated criterion…`。`contract-v3`：`not sent is not "not arrived"…`、`caution is labelled as not an honesty judgment…`。`quantity-units`：`a caravan that carried less than one unit…`、`a delivery a full vault credited as 0…` |
| **発生時刻と観測時刻** | `bell`（発生）と `created_bell`（観測）。期限内かは精算の発生 bell で判断する。再評価は、遅着（使う）・判断後の出来事（使わない）・backdated（除外）を分け、元の入力をハッシュ付きで保持する | `evidence`：`time: an on-time delivery observed late is on time…`、`time: a decision taken before evidence arrived…`、`time: a wrong index attestation rolled back…`。`contract-v3`：`reassess: late arrivals of past facts are used…`、`reassess: a good deed done after the decision…`。`continuity`：`boundary: a decision before the boundary is reassessed…` |
| **数量配分** | 署名付きの割当だけで結ぶ。caravan の容量は、有効な操作を署名順に全約束で消費する。訂正・撤回・到着順・同時割当に対応。加算の不足の内訳は推測せず上下限で持つ。端数の余地（B） | `evidence`：`allocation: one caravan split over two promises…`、`allocation: a short credit shared by two allocations…`、`allocation: parallel promises…`。`contract-v3`：`allocation: a resend is a duplicate…`、`…arrive out of order…`、`…a correction and a revoke free capacity…`、`…concurrent allocations…`。`quantity-units` 全 7 件 |
| **finalized coverage** | coverage は、world と登録 partition が一致し、`finalized`、gapless、3 つの送信経路（トップレベル・CPI・raid の take）、期間全体を満たすときだけ有効。欠けたものは `coverage_gaps` に出す。partition をまたぐ場合は本人単位でつなぐ | `contract-v3`：`not sent: only a sufficient coverage proves it…`（finality・gapless・各経路・world・期間・送り主・world 未設定）、`not sent: a claim is judged false only against a sufficient coverage`。`continuity`：`boundary: "not sent" needs the whole window…` |

## D. ⑳（NFT の移転）について

私的な会話や非公開の記憶を NFT とともに移す方針は決まっていない。⑫には**自動で移す機能を加えていないし、今回も加えない**。⑫の記憶は本人（principal）単位で持ち、私的な記録は当事者だけに見える。NFT の移転で本人が変わる場合の扱い（移す・移さない・誰が見られるか）は、方針が決まるまで未定のままにする。

## E. 残件（⑫）

1. **④からの実際の事実の受け取り**（A の表）：特に coverage は作る主体が無い。W1 が採用されれば、alias と partition の多くは不要になる。
2. **既存 AI 記憶への接続**：`continuity/citizens-adapter.mjs` は移行候補で、どこからも呼ばれていない。M11 の再生（Season 単位）をどう扱うか（④・⑯）。
3. **履歴の上限と保存**：既存の episode の上限 200 は、保存からも削除する。⑫の journal は削除しない（30,400 記録で 13 MB）。分割・圧縮は④の保存方針と合わせて決める。
4. **⑧が挙げた記憶の保存先・公開時期**：実行ごとの保存先、Season 終了に結び付いた公開と封印（⑫・⑬）。
5. **割当の鍵の継続**：鍵の更新・失効、本人が変わる場合（D）。
6. **実 LLM による検証**：未実施。⑫のデモは決定的な参照ルールの結果である。
7. **GitHub への push**：前回の報告どおり、Vercel・Netlify・GitBook の設定を確認できないため保留している。
