# 03 同一トランザクションで合成できる操作／時間経過が要る操作

## 1. 同一トランザクションでの合成（実行で確認、LiteSVM）

| 組み合わせ | 結果 | 理由 | 試験 |
|---|---|---|---|
| courier の SendCaravan（seq 1）＋ courier の SendCaravan（seq 2） | **合成できる** | 2つ目は1つ目が進めた `Citizen.CARAVANS` を見る。宛先は読取のまま | `t07` |
| 同じ SendCaravan（seq 0）を2回 | 取引全体が失敗（`BadData`）、何も動かない | seq の一致（重複の防止）。原子性で1回目も戻る | `t07` |
| BuildVault ＋ その金庫への SendCaravan | **合成できない**（`BadAccount`、命令2 = BuildVault） | 各命令は、自分が読取専用で並べる program 口座が取引内で書込可だと拒否する（`check_flags`、書込ロックの正直さのための規則）。BuildVault は Province を読取、SendCaravan は書込。SendCaravan は宛先の金庫を読取、BuildVault は書込 | `t10` |
| SendCaravan ＋ SettleCaravan | **合成できない**（`BadAccount`、命令2 = SendCaravan） | SettleCaravan が宛先を書込にする。仮に通っても到着前なので `CaravanEarly` | `t08` |
| 所有者の SetSession ＋ courier の delegated SendCaravan | 試していない | SetSession の Citizen は書込、SendCaravan も書込なので C4 には当たらない見込み。ただし委任の設定と行使を同じ取引に入れる意味はない | — |

**結論。** 合成の可否は `top_level_only` ではなく、口座表の読取／書込の宣言で決まる。同じ口座を「片方は読むだけ、片方は書く」命令同士は、同じトランザクションに入らない。これはコアの意図的な規則（`frontier-abi/src/prologue.rs` `check_flags` の注記: 読取専用と並べた program 口座が書込可なら拒否し、ロック集合を正直に保つ）なので、変更は提案しない。外部の作者は、合成したい命令の組を [generated 表](generated/instruction-matrix.generated.ja.md) の口座列で先に照合する必要がある。

## 2. 時間経過が要る操作（④の非同期実行の担当）

隊商の規則は「出発」「道中」「到着」「受取」が別の時刻に起きる。courier は**出発だけ**を同期で行い、残りは時間が経ってから別の取引で動く。この担当では、それらを courier から同期で呼べないこと（呼んでも早すぎれば拒否されること）だけを確かめ、待って実行する仕組み（④の Run）は作っていない。

| 段階 | 命令 | 時間の条件 | 誰が実行できるか | 同期で呼ぶと |
|---|---|---|---|---|
| 出発 | SendCaravan | 即時 | 所有者（wallet、自分宛なら session） | 着地（`t01`） |
| 道中の襲撃 | 戦闘の解決（GatherClash, ResolveFromInputs：top-level only）が隊商の枠に襲撃を書く | 鐘（10 分）ごとの解決の後 | keeper | CPI 不可（`NotTopLevel`） |
| 襲撃の決定 | RaidCaravan（襲撃側）／DefaultRaid（窓の後、誰でも） | 解決後、襲撃側の窓 `RAID_DECIDE_BELLS` 内／後 | 襲撃側の所有者／誰でも | 窓の外は `RaidWindow`、決定済みは `RaidState` |
| 受取 | SettleCaravan | `ARRIVE_TS` を過ぎ、かつ経路の Province が最後の鐘まで解決済み | 誰でも（fee を受け取る） | `CaravanEarly`（`t08`：到着時刻を過ぎても解決前なら拒否） |
| 宛先の世代 | SettleCaravan 時に判定 | 受取の時点 | — | 宛先が別の世代なら `LOST`（`t10`） |

`t08` と `t10` では、時間経過の部分（到着時刻、Province の解決済みの鐘、開いた襲撃の枠）をコアの `caravan.rs` と同じ方法で**作り込んで**いる（時計を進め、`set_resolved_next` で解決済みにし、隊商の枠に襲撃者を書く）。keeper が実際に解決した場合の試験は、コアの `g13_s1_clash_raids_a_caravan_and_the_raider_takes_it` が担う。

## 3. ④への受け渡し（要求だけ）

外部プログラムが「送って、着いたら受け取る」を1つの意図として扱いたい場合、④の Run には少なくとも次が要る（提案、未実装）:

1. 出発の取引の結果（`return_data` の seq、Caravan のアドレス `cv‖owner_tag,seq`、CARAVAN_SENT の記録）を次の段階の入力にできる。
2. 受取の可否を `ARRIVE_TS` と経路 Province の `resolved_next` から判断し、早すぎれば `CaravanEarly` を「まだ」として扱う（失敗ではない）。
3. 受取は誰でも実行でき fee を得るので、外部プログラム自身が受取を独占する設計は取れない。
4. 襲撃で所有者が変わった隊商（`t10`）は、元の送り手の意図と別の結末になる。Run はこれを「失敗」ではなく「規則による結末」として返す必要がある。
