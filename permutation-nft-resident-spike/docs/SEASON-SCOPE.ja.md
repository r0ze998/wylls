# NFT 住民のアカウントと Season の関係（2026-11-06、v0.15 で修正）

**v0.15（所有者の決定、2026-11-06）**：NFT パスは同じものを使い続け、世界を作り直しても同じパスで新しい世界に参加できる。④ の修正案（`claude/gallant-ride-cunptv` `46ff47f5`、patch sha256 `fe5b8bbc…`）を採った：link は **1 NFT に 1 つ、一度だけ書く**ままにし、世界ごとの Citizen は**住所・その世界の口座・NFT の印**の 3 つで確かめる（§6）。各世界で 1 NFT・1 Citizen、譲渡後は今の持ち主だけが操作できることは変わらない。資産や履歴を世界の間で引き継ぐかは**未決**（U11）で、何も移さない。以下 §1〜§5 は v0.14 までの調査の記録で、§2 の「別の Season ではログインできない」と §4 の候補は v0.15 で解消した。


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

## 6. v0.15 の修正（④ の案を採用）と確認（2026-11-06）

**経緯**：⑳ は最初に link を Season ごとにする形（`["nft-citizen-link", season, asset]`、`88d789b3`）を作ったが、同じ時に ④ が「link は 1 NFT に 1 つ、一度だけ書ける」を条件にした案を出したため、それを取り消して ④ の案に揃えた。

**変えたこと**

| 所 | 前 | 後 |
|---|---|---|
| link の住所と中身 | `["nft-citizen-link", asset]`、`PSFNR001` 104 B `{asset, resident, citizen}`、一度だけ書ける | **同じ**。`citizen` の欄は「その NFT が最初に作った Citizen（履歴）」の意味になる |
| `authorize`（操作の検査） | link の asset・住民・Citizen の三つが一致すること | link の **asset と住民**が一致すること（`frontier_abi::resident_binding::same_identity`） |
| 既存の link がある `JoinResident` | link の三つが今回の Citizen と一致すること | link の asset と住民が一致すること |
| 世界ごとの Citizen の確かめ方 | — | 既存の三つの検査：その世界の正しい住所（`check_addresses`）、その世界の口座であること（`present_v2`）、その NFT の印（`proc::resident::check` の `RESIDENT_ASSET`） |
| ABI（命令 tag、記録 130、エラー 170–175、予約領域、AccountKind 32） | — | **変更なし** |

**変えていないこと**：権限の読み方（Core の今の持ち主、住民プログラムの世代と session を毎回読む。これらは Season によらない）。Citizen の住所（Season ごと）。資産・履歴の引き継ぎ（何も移さない。新しい世界の Citizen は新しく作られる）。

**既存データへの影響**：link の住所と形は変わらないので、移行は要らない。devnet・mainnet とも未配備。財布の Citizen、記録、herald・keeper・検証器、SDK・中継・web の住所計算は変わらない。中継の `GET /f/residents` の `link: true` は「どこかの世界で参加したことがある」の意味になり、「この世界に参加済みか」は `joined`（web はこちらを使う）。herald・keeper・検証器は一つの program の一つの Season だけを索引するので、記録 130 の key（住民 ID、Season を含まない）は世界ごとの索引で重ならない。

**鍵を使わずに確かめたこと**（`permutation-frontier/src/resident_runtime_tests.rs`、④ が書いた 4 件、program の本物の `dispatch` を手元で、限界は同ファイルの先頭）：

1. 同じ link のまま世界 8 に参加でき、link のバイトは変わらない。同じ世界での 2 回目は `AlreadyDone`。別の世界の Citizen は拒否。
2. 譲渡がすべての世界に同時に効く。譲渡の後に作った世界 9 には B だけが参加できる。
3. asset や住民を変えた link は拒否。
4. 印の違う Citizen は拒否。

ほかの 5 件（初回ログイン、譲渡と A→B→A、署名なし・差し替え・保護なし、session と財布の経路）とあわせて 9 件合格。未実施：SBF の build と、Core・住民プログラムを含めた実行時の確認（鍵の生成を伴う。U37）。

**仕様の論点（未決、④ の指摘）**：引き継ぎを Join の時点で行う設計にするなら、空の Citizen で先に参加させると後から写せなくなるおそれがある。作り直しの前後で世界が同時に動いていると、1 つの NFT が複数の世界に同時に Citizen を持ち、売買のとき各世界の持ち物が一緒に移る。
