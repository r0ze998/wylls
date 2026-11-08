# ⑨ ゲーム本体（プログラム）への接続（2026-11-08、④ の候補 `cf517b55` の上、`ae0df617` に追従）

> **④ の候補が `ae0df617cad8bef17b8763abe7f99baad11d78b2`（tree `4219fe2e…`）に進んだので、⑨ の担当ブランチに通常の merge で取り込んだ**（merge commit `cf439dba…`、衝突なし、どちらの commit も書き換えていない）。その上の `run.sh` の修正が `e529f157…`（tree `cecc28f26a68768a134d08aad0f8adda436e213c`）。**`ae0df617` に当てる列は [patches/to-04-ae0df617/](patches/to-04-ae0df617/)**（⑨ の 7 commit。`git am` で tree `cecc28f2…`、一致を確認）。下の §1 の `cf517b55` 向けの列も残す。§7 に、④ に求められた記録の kind の一覧と 10 枠に収める案。


⑨ の担当ブランチ `claude/elegant-bohr-co2uhr` を、④ の公開統合候補 `cf517b558d1303a84dba618550f40cb460b7ad99`（`claude/gallant-ride-cunptv`）まで fast-forward し、その上に ⑨ のコアの変更を 5 つの commit で積んだ。④ の候補には ⑨ の `872fe6a2`（kernel `9bd610c3…`、bridge10 `1177f502…`）が既に入っていた（作り直していない）。

## 1. commit と④への適用

| 順 | commit | 内容 |
|---|---|---|
| 1 | `5813eb2d57129c57a747e6c00767352a90948352` | **コア：`Holding.lent_workshops`**（⑨ のパッチ 0001 をそのまま適用）。`RSV_700` → `LENT_WORKSHOPS @ 700`、program・検証器・LiteSVM ハーネスの読み書き、占領での解除。生成した JS の配置表（gateway・server の `abi-v2-layouts.mjs`）も作り直した |
| 2 | `8ea3c047cd320156fdfc1b7ae9ed7e3aa6d50377` | **規則：`permutation_rules::frontier::capacity`**（feature `capacity-preview`）。⑨ の kernel を、プログラムの口座の形（Pool 口座＝許可と占有表、Job 口座）にした no_std の規則。kernel との差分試験 `kernel/tests/rules_port.rs` |
| 3 | `101ee30f276a1fca280d62443bf2755c0ed79463` | **プログラム：14 命令**（`frontier_abi::capacity`、`permutation-frontier` の `proc::capacity`、feature `capacity-preview`）とホスト試験 |
| 4 | `dff001ee531d74abf698d90cc7c3f0915d4f35ad` | **⑩ の区画との接続**（`capacity-preview` と `custody-preview` の両方）：区画からの投入（利用注文、`LOT_CONSUMED`）、使わなかった鉱石の区画への返却（`return_unused`）、未返却 |
| 5 | `2174440e63f4b08983128ff506c89a5afd11f695` | `run.sh` の最後の段を「この木のコアの試験」に置き換え |

この文書の commit が 6 つ目（文書とパッチの列だけ）。

**④ への適用（どちらでも同じ木になる）：**

- ⑨ の担当ブランチを ④ の候補に fast-forward で取り込む（⑨ のブランチは `cf517b55` の子孫）。
- または `patches/to-04-cf517b55/` の 5 つを順に `git am`：`cf517b55` に当たり、当てた後の tree は `f96bd565d56e629e20ab535ce831d54778a246a4`（⑨ の commit 5 の tree と一致を確認）。sha256 は同じ場所の `SHA256SUMS`。

既定の build（feature なし）は、コアの変更 1（`lent_workshops`。lent = 0 なら挙動は変わらない）以外は何も変わらない。命令・規則・口座は `capacity-preview` の内側だけにある。

## 2. 何が動くか（実装済み・接続済み）

| 範囲 | 中身 |
|---|---|
| 施設 | 施設は Holding（コアの口座）そのもの。世代・持ち主・占領の記録（`PREV_GEN`・`CAPTURED_BELL`）から、Pool の世代が生きているか、いつ終わったかを決める |
| A の工房を貸す | LendCapacity／ReclaimCapacity が Holding の自分の生産を `Holding::lend_workshops`／`reclaim_workshops` で変える（連続生産と二重に使わない） |
| 許可・予約 | GrantCapacity（利用者は Citizen）、ReserveCapacity（Job 口座を作る。家賃は払った人へ戻る） |
| 材料 | DepositToJob：利用者の施設の州にある自分の倉（Vault）から、または（custody の build で）他人の区画から利用注文の下で |
| 加工 | 実時間と実レート（2 鉱石＋1 木材で 1 兵器、1 棟で毎時 4）。精算は誰でも、何度でも同じ結果 |
| 受け取り | ClaimJob：加工品と残りを利用者の倉へ（`STORES + CUSTODY_QUOTA ≤ CAP` を超えるなら丸ごと拒否）。区画から取った鉱石の残りは区画へ |
| 喪失 | RecordFacilityLoss：占領者が施設にある物を取る（仮の方針 CaptorTakesAll、Holding の倉へ） |
| 退役 | RetireJob／RetireGrant／RetirePool：口座を閉じ、家賃を払った人へ |
| 一度だけ | 再送（同じ投入 id、同じ受け取り、同じ貸し出しの seq）は何も変えない。区画を二度消費しない |

## 3. 試験（すべて鍵の生成・導出・署名なし）

| 対象 | 結果 |
|---|---|
| `permutation-rules`（既定／`capacity-preview`） | 513／515 件通過 |
| `frontier-abi`（既定／`capacity-preview`） | 146／152 件通過 |
| `permutation-frontier` のホスト試験（既定／capacity／custody／両方） | 107／111／108／114 件通過。clippy `-D warnings` も 4 つとも |
| 規則と kernel の差分（`rules_port.rs`） | 6,000 通り × 120 手（72 万手）、4 種の方針の組、占領と喪失を含めて、結果・記録・Pool・Job・Holding が毎手一致。わざと壊した 2 つを検出（3 つ目は意味の同じ変更） |
| ホスト試験（本物の `dispatch`、手で作った口座） | 7 件：開設から返却・退役まで、拒否（何も変えない）、再送、占領、他の build の Season、区画からの投入と返却（端数は未返却、整数単位は消費の取り消し） |
| ⑨ の `run.sh` 全段 | 終了コード 0（kernel 43＋4、bridge10 28、⑩ の adapter 17、コア 1,811） |
| JS の配置表 | `sync-web-sdk.mjs --check` 最新、`web-sdk.test.mjs` 8 件（no-keys-guard 付き） |

**実行していない：** SBF の build と LiteSVM（Agave の導入は拒否されたまま）、検証器の試験（共通部 `tests/common` と fixture が署名する）、鍵を使う Node の試験、実取引・配備。ホスト試験の `is_signer` は試験が立てる（署名の検証そのものは走らない）。

## 4. 決めていないこと（勝手に確定していない）

| 項目 | 今の扱い | 決める人 |
|---|---|---|
| **MixedSource**（区画の鉱石を使う予約に自分の鉱石、または別の区画） | 拒否（`NotImplemented`、名前の付いた関門） | 所有者 |
| **区画に入れる資源**（木材・兵器） | ⑩ の区画は鉱石だけのまま。⑨ は広げていない | 所有者・⑩ |
| **押収した倉の区画**（凍結） | 凍結中の返却はすべて未返却のまま（失われない）。没収は ⑩ の提案のまま | 所有者・⑩ |
| 喪失の方針・休眠・取消の方針 | Pool ごとに切り替えられる 3 つ（仮の既定 CaptorTakesAll／Unaffected／HonorBooked） | 所有者 |
| 解放された世代、二度占領された世代の終わり | Holding から時刻が読めないので RecordFacilityLoss は `NotImplemented` で拒否 | ④（Holding の履歴の持ち方） |
| 世代の番号の一周（u8） | 検出できない（施設の履歴をどの口座も持たない） | ④ |

## 5. ④ への依頼（番号と統合の判断）

1. **記録の kind**：⑨ の記録は 20 種、帯 120–129 は 10 枠。決まるまで capacity の build は ⑨ の PS2 記録を出さない（検証器から見て UNVERIFIABLE）。
2. **口座**：AccountKind 25・26 を `v2::layout::AccountKind` に入れるか（今は ABI の外、命令の処理が持ち主・住所・magic を検査）。magic の提案 `PSF1CPOL`・`PSF1CJOB`。
3. **版**：capacity の build の版の印 `0x2000`（提案）。custody と一緒なら `5 | 0x2000`。NFT・wide との組み合わせは `compile_error`。
4. **ルールの hash**：⑨ の規則は `KERNEL_VERSIONS` に入れていない。規則の束ね方の試験（`frontier_shared.rs`）は、⑨ の module を「feature の内側の未結合の preview」と名指しで除外した（隠していない）。
5. **共有の監視の一覧**：`permutation-frontier/src/ix.rs` の「倉の在庫を書く場所」の一覧に ⑨ の書き手を足した（上限で抑えている）。
6. **継続世界の R1**：⑨ の利用者・所有者の命令は既存の player prologue を通るので、戦期の終わり（end bell）の後に拒否される。⑨ は拒否しないことを求めている（CONTINUITY.ja.md）。
7. **`RSV_700` → `LENT_WORKSHOPS`** を割当表に載せること、0001 の版（S1 か S2 か）。

## 6. ⑩ への依頼

1. **返却の記録の種類**：ClaimJob が `return_unused` で区画の `CONSUMED` を減らすが、記録の種類が無いので区画の鎖を進めていない（区画の状態だけ書く）。⑩ の V26 が状態の変化を記録と照らすなら、`LOT_RETURNED` のような種類が要る。
2. **区画ごとの未返却**：1 単位未満の端数は予約（Job 口座）が持つので、その予約は退役できない。adapter-09 の `owed` と同じく区画の側に未返却を持てば、端数が貯まって整数単位になれる。
3. ⑨ は ⑩ のファイルを変えていない。⑩ の custody の読み書き（倉の見え方、区画の住所、拒否の番号）は ⑨ の `proc/capacity.rs` に写した（`proc::custody` の関数は非公開のため）。公開してもらえれば写しをやめる。

## 7. 記録の kind（④ の求め：一覧と、帯 120–129 の 10 枠に収める案）

**案であって決定ではない**（④ が ⑪ とあわせて決める）。⑨ の記録は 20 種（`kernel/src/event.rs`、規則の `capacity::Event` も同じ）。kind に 1 バイトの副種別（sub-kind）を足し、意味の近いものを同じ kind にまとめると 10 枠に収まる。

| kind（案） | 名前（案） | 副種別 → ⑨ の記録 | 主な中身 |
|---|---|---|---|
| 120 | CAP_POOL | 0 PoolOpened、1 FacilityLost、2 PoolRetired | owner／喪失の時刻と占領者 |
| 121 | CAP_LEND | 0 Lent、1 Reclaimed | units、lent、時刻 |
| 122 | CAP_GRANT | 0 Granted、1 Revoked、2 GrantRetired | grant、user／取消の時刻と取り消した予約の数 |
| 123 | CAP_RESERVED | 0 Reserved | job、units、窓、max_output |
| 124 | CAP_DEPOSITED | 0 Deposited | job、投入 id、資源、量（出どころ：倉／区画は鍵で区別できる） |
| 125 | CAP_RUN | 0 Started、1 Settled、2 Completed | job、今回の産出、使った量、累計 |
| 126 | CAP_STOPPED | 0 Cancelled、1 Lost | job、時刻、それまでの産出 |
| 127 | CAP_CLAIMED | 0 Claimed、1 Refunded | job、産出、返した材料（分割：整数単位と端数） |
| 128 | CAP_FORFEITED | 0 Forfeited | job、占領者へ移った産出と材料、占領者 |
| 129 | CAP_RETIRED | 0 Retired、1 Receipt | job、uid、産出／四つの口座（⑩ の式） |

- 再生の検証器は、kind と副種別の組で ⑨ の規則（`frontier::capacity`）の記録と 1 対 1 に照らせる。
- 区画の側の記録（`LOT_CONSUMED`、返却）は ⑩ の kind。⑨ の記録は ⑨ の Pool・Job の鎖に載せる案（entity kind は ④ の判断）。
- 代わりに 20 枠を割り当てるなら、副種別を外し、表の順に 1 つずつにすればよい。

**④ の回答（2026-11-08）の反映**：(e) 版の印は別の program の版として扱う（⑨ は `0x2000`）。ただし ⑨ は **custody と同時に build できるようにしている**（区画からの投入に両方が要る。版は `5 | 0x2000`）。④ は「同時に compile できないようにするのは、それまでの扱いとして妥当」としたが、⑨ は両方を要するので、この組み合わせの版も ④ に決めてほしい。(d)・(b) は仮の割当として載せてよい（正式化はこの候補の上で 0001 を確かめてから）。(a)・(c) は保留（記録は出さない）。(f) RULESET_HASH には入れない（入れていない）。

**④ の土台の clippy の指摘**：`ae0df617` の `permutation-frontier/src/crypto/quick.rs` の試験の値に、使われていない関数・定数が 8 件ある（既定の build でも出る）。⑨ の `run.sh` は ⑨ のファイルの指摘だけで失敗にし、残りは数を記録する（`results/core-tests.log`）。
