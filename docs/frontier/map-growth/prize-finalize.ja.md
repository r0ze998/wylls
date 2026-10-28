# 地図が広がるシーズンの賞金の確定（設計）

2026-10-28。ブランチ `map/region-append`。オーナーが P1・P1'・B を了承しました（G1 は入れない、次のシーズンから）。実装は §7 にあります。

2世界比較（[keeper-load-rules.ja.md](keeper-load-rules.ja.md) §13.5）で、地図が61州から817州に広がったシーズンでは、賞金の確定（Finalize）が `WrongExpectedCount` で断られました。休む・休まないに関係なく、2つの世界の両方で起きています。この文書は、その原因と直し方の案です。ルールの変更が要るところは分けて書きます。

## 0. 変えないこと

- 勝ち負けの決め方（オーナー決定）：シーズンの終わりに最も多くの州を持つ国が勝つ。手数料の80%が賞金。
- 同点のときの決め方と、勝った国の中での分け方（どちらも仮のまま）。
- 「凍結」の考え方：シーズンが終わり、州のすべてのターンが処理済みになったら、その州の砦はもう動かない。Tally はそういう州だけを数える。

## 1. 今の仕組みと、わかったこと

Tally と Finalize は `permutation-prize/src/lib.rs` にあります。

- **InitPool**（シーズンの前）：運営者が「砦のある州の数」（`expected_keeps`）を渡し、プールに書きます。ローカルの stack では54（最初の地図：61州 − 砦のない7州）です。
- **Tally**（シーズン終了後、誰でも）：州のアカウントを1つずつ読み、条件を満たせば数えます。条件は、`resolved_next ≥ end_bell`、砦の `since_bell < end_bell`、まだ数えていないこと（ビットマップ）です。数えた州は、砦の持ち主の面積を+1し、領地ターンを同点用の値に足します。
- **Finalize**（誰でも）：次の3つが等しいときだけ確定します。
  - プールの `expected_keeps`
  - 数えた数（`counted`）
  - ゲームの数：Frontier アカウントの `provinces_opened` − 7

調べてわかったことは5つです。

1. **`expected_keeps` はシーズンの前に決まります。** 地図が広がるシーズンでは、最後の州の数はシーズンの前にはわかりません。なので、どんな値を入れても、広がった時点で確定できなくなります。2世界比較では54と810で、どちらの世界も確定できませんでした。
2. **ゲームの数（Frontier の `provinces_opened`）は遅れることがあります。** この値を書くのは FoldOccupancy の最後の段（3段目）だけで、6つの ProvinceFund の `provinces_opened` を足して写しています（`permutation-frontier/src/proc/map.rs` の FoldOccupancy）。州を開く OpenProvince は ProvinceFund だけを増やし、Frontier には書きません。そのため、最後の FoldOccupancy より後に開いた州は Frontier の数に入りません。いつも正しい数は、**6つの ProvinceFund の合計**です。
3. **シーズンの終わりの直後にも、州を開けます。** OpenRing と OpenProvince が受け付けるのは、シーズンが Seeded か Running のときです。`end_bell` を過ぎていても、EndSeason が届くまでは Running のままです（EndSeason は誰でも送れますが、送られるまでに時間差があります）。その間に開いた州の砦は `since_bell ≥ end_bell` になり、Tally はこの州を永久に数えません。この州もゲームの数には入るので、**誰かがわざと1州開くだけで、確定できなくなります。**
4. **Tally のビットマップは1,024州まで**です（リング0〜17）。今のプリセットは `r_max` 16（817州）なので収まります。ただし CreateSeason は `r_max` 128 まで受け付けるので、リング18以上があるシーズンでは Tally がその州を断り（`BadAccount`）、確定できません。
5. **同点用の値は、州に書かれた領地ターン**です。キーパーの休み方（段階3）では、シーズンの終わりに全州を終わりまで早送りする（R2-0）ので、書かれた値が確定値になります。2世界比較で確かめています。

なお、州を閉じる CloseProvince は `end + 72 時間` からしかできません。なので Ended から72時間の間は、ProvinceFund の数は変わりません。州が閉じると Tally もできないので、Tally と Finalize はもともとこの72時間のうちに行う必要があります（今と同じ）。

## 2. 直し方の案

### P1：Finalize は、確定のときのゲームの数を使う（賞金プログラムの変更、おすすめ）

- Finalize の引数のアカウントを `[pool w] [frontier]` から `[pool w] [season] [fund×6]` に変えます。
- 6つの ProvinceFund を読みます。アドレスはゲームのものを計算し直し、持ち主がゲームのプログラムであることと、シーズンの番号を確かめます。
- `total = Σ provinces_opened − 7` とし、`counted == total` のときだけ確定します。
- シーズンが Ended であることも Finalize で確かめます。今は「Tally が Ended を確かめたから」に頼っています。
- `expected_keeps` は確定の条件に使いません。InitPool の引数は、配置を変えないため残し、0 を入れることにします（表示用）。

**なぜこれで正しいか**：Ended のあとは OpenProvince ができず、`end + 72 時間` までは CloseProvince もできません。なので Finalize のときの ProvinceFund の合計は、シーズンが終わった時点の州の数と同じです。数え漏れがあれば `counted < total` となり、確定しません。これは今と同じ守り方です。

**ルールの扱い**：勝ち負けの決め方は変わりません。変わるのは「すべての砦を数えた」をどう確かめるか（事前の数か、終了時のゲームの数か）だけです。ただし賞金プログラムの動きが変わるので、オーナーの了承が要ります。

### P1'：シーズン終了後に開いた州は「数えたが面積なし」にする（賞金プログラムの変更、おすすめ）

- Tally で、州の `opened_bell ≥ end_bell` なら、ビットマップに印を付け、`counted` を+1します。面積と同点用の値には何も足しません。
- 理由：そういう州は、シーズンの終わり（`end_bell` の始まり）にはまだ存在しませんでした。「終わりに持っていた州」に入れないのが正しい扱いです。
- これで、§1-3 のわざと開く問題を、ゲームを変えずに防げます。
- 確かめ方：砦の `since_bell` は、開いたときか、`end_bell` より前のターンの占領でしか変わりません。そのため `since_bell ≥ end_bell` になる砦は、`end_bell` 以降に開いた州のものに限られます。

### G1：`end_bell` 以降は州を開けないようにする（ゲームのルール変更、任意）

- OpenRing、ConsumeRingSeed、OpenProvince で、今のターンが `end_bell` 以降なら断ります。
- 「地図は `end_bell` で止まる」がゲームの側でもはっきりします。P1' と両方入れても問題ありません。
- ゲームのプログラムの変更なので、次のシーズンからです。

### B：リング18以上のシーズンには賞金プールを作らない（賞金プログラムの変更、小さい）

- InitPool で Season の `r_max` を読み、17 を超えていれば断ります。
- これで、確定できないプールが作られることを防げます。
- リング18以上のシーズンで賞金を使うときは、ビットマップを広げる必要があります。たとえば `r_max` 128 なら約49,500州で約6.2 KB です。プールの配置が変わる別の作業になります。

### 使わない案

- **P0：運営者が `expected_keeps` に `r_max` までの州の数を入れる**。地図が `r_max` まで広がるとは限らないので、広がらなければ確定できません。採りません。
- **プールをシーズンの後に作る**。参加費の支払いはシーズン中なので、採りません。

## 3. おすすめの組み合わせ

**P1 ＋ P1' ＋ B** をおすすめします。どれも賞金プログラムの中だけの変更で、ゲームのプログラムは変えません。G1 は、ゲームのルールをはっきりさせたいときに次のシーズンから追加します。

## 4. 変わる部品

| 部品 | 変更 |
|---|---|
| `permutation-prize` | Finalize のアカウントと条件（P1）、Tally の終了後に開いた州（P1'）、InitPool の `r_max` の確認（B）。プールの配置は変えない |
| `permutation-gateway/client/src/frontier/prize.mjs` | `finalizeIx` のアカウント（season と ProvinceFund×6） |
| `permutation-gateway/scripts/prize-settle.mjs` | Finalize の呼び方。`--check` の照合を ProvinceFund の合計に合わせる |
| `frontier-node/crates/stack/src/prize.rs` | InitPool の `expected_keeps` を 0 にする（`--prize-keeps` は不要になる） |
| ゲーム（G1 を入れる場合のみ） | OpenRing、ConsumeRingSeed、OpenProvince の `end_bell` の確認 |

## 5. 確かめ方

1. **賞金プログラムの svm テスト**（`permutation-prize/svm-tests`）：
   - 地図が広がったシーズンで Finalize が確定する。
   - Frontier の数が遅れていても確定する。
   - 1州でも数え漏れがあると確定しない。
   - `end_bell` 以降に開いた州は面積に入らないが、数には入る。
   - `r_max` 18 のシーズンでは InitPool が断られる。
   - ProvinceFund の偽物（別のアドレスや別のシーズン）は断られる。
2. **2世界比較のやり直し**：同じ設定で、Tally から Finalize までが両方の世界で確定し、勝者が同じになることを確かめます。今回の設定ではどの国も135州で同点なので、同点の決め方（仮）が働くことも確かめられます。

## 6. オーナーに決めてほしいこと

1. 「すべての砦を数えた」の基準を、シーズン前の運営者の数から、**終了時のゲームの州の数**（ProvinceFund の合計）に変えてよいか（P1）。
2. `end_bell` 以降に開いた州を、面積に入れずに「数えた」扱いにしてよいか（P1'）。あわせて、ゲームの側でも開けないようにするか（G1、次のシーズンから）。
3. 当面、賞金プールを `r_max` 17 以下のシーズンに限ってよいか（B）。
4. 入れる時期。賞金プログラムは、動いているシーズンのプールにも効いてしまいます。なので、次のシーズンからを前提にします。

**答え（オーナー、2026-10-28）**：1〜3 はすべて了承。G1 は入れない。4 は次のシーズンから。

## 7. 実装

### 賞金プログラム（`permutation-prize/src/lib.rs`）

- **Finalize（P1）**：アカウントを `[pool w] [season] [province fund ×6]`（ウェッジ0〜5の順）に変えました。
  - Season がプールのもので、Ended であることを確かめます。
  - 6つの ProvinceFund は、アドレスをゲームのものとして計算し直し、持ち主・印（magic）・大きさ・シーズン番号を確かめます。
  - `Σ provinces_opened − 7` より `counted` が少なければ `TallyIncomplete`、多ければ `WrongExpectedCount` です。
  - プールの `expected_keeps` は確定の条件に使いません（表示用。0 でもよくなりました）。
- **Finalize の期限は付けません**（オーナー判断、2026-10-29）。
  - 一度は `end + 72 時間` からの Finalize を断る期限を入れましたが、オーナーの判断で外しました。
  - 残る注意：`end + 72 時間` からは CloseProvince を誰でも送れ、閉じた州の分だけ ProvinceFund の数が減ります。まだ数えていない州が閉じられると、数え漏れのまま `counted == 合計` になりえます。
  - なので運用では、§1 の終わりに書いたとおり、Tally と Finalize をこの72時間のうちに済ませます。
- **Tally（P1'）**：州の `opened_bell ≥ end_bell` なら、ビットマップに印を付けて `counted` を+1し、面積と同点用の値には何も足しません。このとき `resolved_next` と砦の `since_bell` は見ません。
  - `opened_bell < end_bell` の州は今までどおりです（`since_bell ≥ end_bell` なら `ProvinceNotFinal`）。
- **InitPool（B）**：Season の `r_max` が17を超えると `BadParams` で断ります（定数 `MAX_RING` = 17）。

### そのほかの部品

| 部品 | 変更 |
|---|---|
| `permutation-gateway/client/src/frontier/prize.mjs` | `finalizeIx({ prize, season, provinceFunds })`（6つでなければ例外）。web の SDK の写しも生成し直しました |
| `permutation-gateway/scripts/prize-settle.mjs` | Finalize に season と ProvinceFund×6 を渡します。`--check` のゲームの数は ProvinceFund の合計にしました。`end_bell` 以降に開いた州は面積から外します |
| `permutation-gateway/src/frontier/routes/prize.mjs` | `GET /f/prize` に `keepsToCount`（ProvinceFund の合計 − 7）を足しました |
| web の賞金画面 | 「集計中です（x / y 州）」の y を `keepsToCount` にしました（無ければ従来の値） |
| `frontier-node/crates/stack` | `--prize-keeps` の既定を0にしました（表示用）。`--prize-so` と `--r-max` 18以上の組み合わせは、起動前に断ります |

ゲームのプログラムは変えていません。

### 確かめたこと

- 賞金プログラムの svm テスト 13/13 が通りました。新しいテストは次の5つです。
  - 地図が広がったシーズン（プールは54のまま、Frontier の数は61のまま遅れている）で、ProvinceFund の数で確定する。
  - 広がった地図で1州でも数え漏れがあると確定しない。
  - `end_bell` 以降に開いた州は、持ち主や `resolved_next` に関係なく、数に入り面積に入らない。
  - Ended でなければ確定しない。
  - `r_max` 18 と 128 では InitPool が断られ、17 なら作れる。
- 今までのテストは、Frontier の代わりに ProvinceFund の偽物（別のアドレス、ウェッジの入れ替え、別のシーズン、5つしかない）を断る形に直しました。
- プログラムの単体テスト4、frontier-node 706、gateway 2,522 が通りました。

### 2世界比較のやり直し（2026-10-29）

前回と同じ設定で、新しい賞金プログラムを使いました（48ターン、プレイヤーなし、61州から817州に広がる地図）。休みなしの世界は 41700 番台、休みありの世界は 41600 番台です。

| | 休みなし | 休みあり |
|---|---|---|
| Tally | 51回、810/810 | 51回、810/810 |
| ゲームの数（ProvinceFund の合計 − 7） | 817 − 7 = 810 | 817 − 7 = 810 |
| `end_bell` 以降に開いた州 | 0 | 0 |
| Finalize | **確定** | **確定** |
| 面積 | どの国も135 | どの国も135 |
| 領地ターン | どの国も4,556 | どの国も4,556 |
| 勝者 | 6か国すべて（同点） | 6か国すべて（同点） |
| `--check`（チェーン・プール・ヘラルド） | 一致 | 一致 |
| 検証ツール | PASS | PASS |

- 2つの世界の817州は、チェーンの見出しの後ろがすべて同じバイトでした（前回と同じ）。
- どの国も面積も領地ターンも同じなので、同点の決め方（仮）どおり6か国で分ける結果になりました。2つの世界で同じです。
- このときの Frontier の数も817で、遅れはありませんでした。前回の失敗は、プールの54だけが原因です。
- 運用で気づいたこと：stack はシーズンの終わりでチェーンの時計を止めます。そのため、Tally を送る前に時計を動かす必要があります（`scripts/demo-clock.sh <base> resume`）。今回は1倍で動かし、終わってから止めました。
