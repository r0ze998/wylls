# NFT 住民のアカウントと Season の関係（2026-11-06）

「1 NFT につき 1 アカウント」が、Season をまたいでも同じアカウントとして扱えるかを確かめた。結論：**同じ Season の中では成り立つ。別の Season では、今の実装では NFT がログインできない。** どう直すかは決めていない（U45）。移行方法・市場の扱いも決めていない。

## 1. 何が Season によるか

| もの | 住所・値の決まり方 | Season によるか |
|---|---|---|
| 住民 ID | `sha256("PSF-RES" ‖ asset)[0..15]` | **よらない**（NFT が同じなら同じ） |
| 住民プログラムの記録（持ち主の世代・session） | 住民プログラムの PDA `["resident", asset]` | **よらない**（世代は Season をまたいで続く） |
| Core の asset（持ち主） | NFT そのもの | よらない |
| policy | Frontier program の PDA `["nft-resident-policy"]` | よらない |
| link（NFT と Citizen の対応） | Frontier program の PDA `["nft-citizen-link", asset]` | **住所はよらない**。ただし中身に**最初の Season の Citizen の住所**を書き、一度だけ書ける |
| NFT の Citizen | `with_seed(Season PDA, "ct" ‖ 住民 ID, program)` | **よる**（Season ごとに別の住所） |
| 財布の Citizen（比較） | `with_seed(Season PDA, "ct" ‖ 財布の tag, program)` | **よる**（財布の住民も Season ごとに別） |

Citizen の中身（国・持ち村・行動の記録）は、財布の住民と同じく Season ごとの口座にある。権限（今の持ち主・世代・session）は Season によらない住民プログラムの記録から毎回読むので、Season が変わっても「今の持ち主だけが操作できる」は保たれる。

## 2. 確かめたこと（実行時の試験）

`permutation-frontier/src/resident_runtime_tests.rs` の `a_second_season_cannot_log_in_with_todays_link`（鍵の生成・導出・署名なし、限界は同ファイルの先頭）：

1. Season 7 で A が初回ログイン（`JoinResident`）。link に Season 7 の Citizen の住所が書かれる。
2. Season 8 を用意すると、同じ NFT の Citizen の住所は Season 7 と違う。
3. Season 8 で同じ NFT がログインすると、link の中身（Season 7 の Citizen）と合わず、`BadAccount` で拒否される。
4. 同じ理由で、Season 8 の `ResidentAct` も通らない（`authorize` が link と Citizen の一致を求める）。

つまり今の実装では、**NFT は最初にログインした Season でしか遊べない**。

## 3. 継続世界との関係

継続世界は決定済み（DISCREPANCIES D1・D12）。実装は今も Season 単位で、継続世界は ⑧ の ExtendFrontier（同じ Season を延ばす）で進んでいる。

- **同じ Season を延ばし続ける**なら、NFT の Citizen の住所は変わらず、§2 の問題は起きない。
- **新しい Season を作る**（作り直し、試験用の Season、`nft-experimental` の別版の Season など）と、§2 のとおりその Season には NFT でログインできない。

## 4. 直し方の候補（決めていない、U45）

| 案 | 内容 | 「同じアカウント」の意味 | 影響 |
|---|---|---|---|
| a | link を Season ごとにする（seed に Season を入れる） | 住民 ID（NFT）が同じ。Citizen は Season ごと（財布の住民と同じ扱い） | link の住所の規則が変わる。④ と AccountKind 32 の扱いを合わせる |
| b | link に Citizen を書かない（asset と住民の記録だけ）。Citizen は Season と住民 ID から毎回出す | a と同じ | link の中身の形が変わる |
| c | 今のまま（NFT は最初の Season だけ） | 最初の Season の Citizen だけ | 継続世界を一つの Season で続けるなら足りる。新しい Season を作るとその NFT は遊べない |

どの案でも、Season をまたいで Citizen の中身（持ち村・資源・記録）を持ち越すかは**移行方法**の問題で、決めていない（U11）。私的記憶・未決済の移転も同じく決めていない。

## 5. herald・web の扱い

herald の `/h/me/{asset}` は、その herald が見ている Season の NFT Citizen を返す（Season ごと）。web が asset と財布のどちらで引くかは U44 のとおり未決。
