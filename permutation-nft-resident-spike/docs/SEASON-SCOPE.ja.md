# NFT 住民のアカウントと Season の関係（2026-11-06、v0.15 で修正）

**v0.15（所有者の決定、2026-11-06）**：NFT パスは同じものを使い続け、世界を作り直しても同じパスで新しい世界に参加できる。そのため link を **Season ごと**にした（`["nft-citizen-link", season, asset]`）。各世界で 1 NFT につき 1 Citizen、譲渡後は今の持ち主だけが操作できることは変わらない。資産や履歴を世界の間で引き継ぐかは**未決**（U11）で、何も移さない。④ と照合した（§6）。以下 §1〜§5 は v0.14 までの調査の記録で、§2 の「ログインできない」は v0.15 で解消した。


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

## 6. v0.15 の修正と確認（2026-11-06）

**④ との照合の経緯**：⑳ が link を Season ごとにした（`88d789b3`）のと同じ時に、④ は link を 1 NFT に 1 つのまま残す案（`claude/gallant-ride-cunptv` `46ff47f5`）を出し、⑳ は一度それを採った（`deebd3b5`）。その後 ④ が、未配備で既存の link の移し替えが無いことを理由に、Season ごとの link（この案）を受け入れ、AccountKind 32 の意味を「NFT の Season ごとの link」とすることも受け入れたため、この案に戻した。④ の案は「採らなかった案」として ④ の記録に残る。Season ごとの link は、住所・その世界の口座・NFT の印の検査に加えて、link がその世界の Citizen を名指すことも確かめる。

**変えたこと**

| 所 | 前 | 後 |
|---|---|---|
| link の住所（program `resident_binding.rs`） | `["nft-citizen-link", asset]`（全 Season で一つ） | `["nft-citizen-link", season, asset]`（Season ごと。`season` は Season 口座の住所 32 B で、id ではない：別の program の Season と混ざらない。JoinResident・authorize・client で同じ） |
| link の中身 | `PSFNR001`、104 B、`{asset, resident, citizen}`、一度だけ書ける | **同じ**。その Season の Citizen だけを結ぶ |
| SDK・中継・web の住所計算（`linkAddress`） | `(programId, asset)` | `(programId, season, asset)` |
| ABI（命令 tag、記録 130、エラー 170–175、Citizen の予約領域） | — | **変更なし** |

**変えていないこと**：権限の読み方（Core の今の持ち主、住民プログラムの世代と session を毎回読む。これらは Season によらない）。Citizen の住所（`citizen_by_tag15(住民 ID)`、Season ごと）。資産・履歴の引き継ぎ（何も移さない。新しい世界の Citizen は新しく作られる）。

**既存データへの影響**

- チェーン上：devnet・mainnet とも未配備なので、古い住所の link は**どこにも無い**。
- もし古い版（`nft-experimental`）で動いている世界があれば、その世界の NFT Citizen の link は古い住所にあり、新しい版では見つからず操作できなくなる。今は該当なし。統合の前に入れれば影響しない。
- 財布の Citizen、記録、herald・keeper・検証器：link を読まないので影響なし。中継の `GET /f/residents` の `link` は「この Season の link があるか」の意味になる。
- 費用：**link の rent（104 B）は、参加する人（JoinResident の payer）が世界ごとに払う**。中継が立て替える場合の上限額（Citizen と link の rent）は前から含めている。
- 中継の `GET /f/residents` の `link` は「この世界の link があるか」で、`joined`（この世界の Citizen があるか）と一致する。herald・keeper・検証器は一つの program の一つの Season だけを索引するので、記録 130 の key（住民 ID、Season を含まない）は世界ごとの索引で重ならない。

**鍵を使わずに確かめたこと**（`permutation-frontier/src/resident_runtime_tests.rs`、program の本物の `dispatch` を手元で、限界は同ファイルの先頭）：

1. 同じ NFT が世界 7 と世界 8 の両方に初回ログインでき、それぞれ別の Citizen と別の link ができる。世界 8 の link は世界 8 の Citizen を名指す。世界 7 の Citizen と link のバイトは世界 8 のログインの前後で変わらない。世界 8 の Citizen は新しく作られ、何も写されない。各世界で二度目のログインは `AlreadyDone`。
2. A→B の譲渡は両方の世界に同時に効く。両方の世界で A の古い署名（174）と新しい署名（175）を拒否し、B はすぐ操作できる。B→A でも、両方の世界で B（174・175）と A の最初の所有の署名（174）を拒否し、世代 2 の A は通る。
3. 譲渡のあとに作られた世界では、今の持ち主 B だけが初回ログインでき、A は拒否される（174・175）。
4. 世界 8 の操作に世界 7 の link や Citizen を混ぜると拒否される。世界 8 の初回ログインに世界 7 の link を渡すと `BadAddress`。
5. 古い seed（`["nft-citizen-link", asset]`）の住所にある口座は、program が持ち、この世界の Citizen を名指す正しい記録を持っていても使われない（操作は拒否、初回ログインは `BadAddress`）。

**仕様の論点（未決、④ の指摘）**：引き継ぎ（U11）を Join の時点で行う設計にするなら、空の Citizen で先に参加させると後から写せなくなるおそれがある。作り直しの前後で世界が同時に動いていると、1 つの NFT が複数の世界に同時に Citizen を持ち、売買のとき各世界の持ち物が一緒に移る。

未実施：SBF の build と、Core・住民プログラムを含めた実行時の確認（鍵の生成を伴う。U37）。
