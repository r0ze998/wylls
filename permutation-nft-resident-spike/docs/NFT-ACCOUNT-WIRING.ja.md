# NFT 住民の初回アカウント作成と、全操作への権限検査の接続（2026-11-06）

起点 `46e940bd`。program 側の実装は feature `nft-experimental` の内側にある。命令 tag・記録の番号と版・Citizen の `WALLET` 欄は**仮**で、④ に提案して返答待ち（§6）。

## 1. 権限の構造（Frontier program の中）

| 仕様 | どう成り立たせたか |
|---|---|
| 最初に NFT でログイン、1 NFT につき 1 アカウント | `Join`：対応の記録 `["nft-citizen-link", asset]` と Citizen `["nft-citizen", asset]` を同じ取引で作る。署名者は asset の今の owner 本人（session は不可）、署名された世代が今の世代、asset に transfer guard。同じ NFT の 2 回目は Citizen が既にあるので `AlreadyDone`。対応の記録は一回だけ書ける |
| 譲渡で操作権が新所有者へ | 毎回、同じ呼び出しの中で Core の今の owner を読む。譲渡（住民プログラムの `TransferResident`）の直後から新所有者が通る。Frontier 側に「操作者」の欄を持たないので、反映の遅れが無い |
| 旧所有者は操作できない | owner でない署名は `NotCurrentAuthority`。NFT Citizen の `WALLET` は全 0 なので、財布の経路（共通入口、RetireHost の自前判定、Frontier の session）も一致しない |
| 旧 session の拒否 | NFT Citizen の session は住民プログラムのものだけを見る（Frontier の SetSession は NFT Citizen では拒否）。住民プログラムは譲渡ごとに session を消し、session には設定した世代と設定者が残る。今の owner が今の世代で設定したものだけが通る |
| 旧世代・譲渡前の署名の拒否 | 命令データに署名された世代が、住民口座の今の世代と違えば `StaleGeneration`。譲渡ごとに世代＋1 |
| A→B→A でも復活しない | 世代は 0→1→2 と進み、戻らない。A が売る前に署名した取引（世代 0）も、A の前の session（消されている）も通らない。A は世代 2 で設定し直したものだけで動ける |
| guard の無い asset | 拒否（`Unguarded`）。guard が無いと通常の Core transfer で動き、世代が変わらないため |

## 2. 接続した命令と、接続しなかった命令

**NFT Citizen として実行できる命令（`Act` の中身、27）**：すべて「元の命令の口座＋[policy, link, asset, resident]」の形。本体は財布の経路と同じ関数（`_as` 形）で、複製は無い。

| 入口 | 命令 |
|---|---|
| `holding::player_as`（20） | Harvest、Build、Train、Explore、Muster、Dissolve、Garrison、Depart、BuildStructure、SeizeStructure、CloseStructure、FortGarrison、Propose、Vote、BuildVault、SendCaravan、RaidCaravan、RaidDomestic、SeizeVault、CloseVault |
| `citizen::player_as`（5） | SetVigil、FileOutpost、FileTicket、PlaceHome、SetSession（NFT Citizen では必ず拒否） |
| `conquest::player_v2_as`（1） | DeclareSiege（MC の season であることも確認） |
| RetireHost の自前判定（1） | RetireHost（季節中の被害者本人の判定を NFT 版に） |

`WalletRequired`（他人あての隊商、構造物の撤去）は「owner 本人」なら通り、session では拒否される（`by_session`＝owner でない）。

**新設**：`Join`（初回ログイン）、`Register`（候補 20：対応の記録だけを先に作る）、`CreatePolicy`（候補 20）、`Act`（上の 27 を包む）。

**権限の検査が無い命令（接続不要）**：Citizen の署名者を持たず、keeper か誰でも呼べる。SettleTicket、ReleaseDormant、CloseHolding、CloseCitizen、SettleExplore、DisbandStranded、SettleDeparture、Reveal（keeper）、SettleTransit、SweepPoolOwed、GatherClash、ResolveFromInputs、SkipQuiet、CloseClashInputs、CloseArrivalDay、CloseArrivalSlot、ClaimDefence、SettleSiege、SettleCapture、CloseMarch、SettleCaravan、DefaultRaid、SettleProposal、FastForward、季節の管理と地図の命令。

**接続していない**：財布の Join はそのまま（NFT Citizen とは別の Citizen を作る）。賞金 program（Entry は財布で決まる）。

## 3. 財布から決まる住所を前提にする箇所（洗い出し）

**program：今回直した（財布の Citizen には同じ検査、NFT Citizen は asset から決まる住所で検査）**

| 箇所 | 以前の影響（NFT Citizen の場合） |
|---|---|
| `citizen.rs` SettleTicket | NFT Citizen が出した土地の申請が精算できず、預かりが残る |
| `citizen.rs` CloseCitizen | 閉じられない |
| `transit.rs` SettleTransit（野営の捕虜の Citizen） | 精算が止まる |
| `conquest.rs` `citizen_v2`（SettleSiege、SettleCapture の攻め手と被害者、RetireHost） | 攻城・占領の精算が止まり、同じ州の財布のプレイヤーも巻き込む |
| `citizen.rs` `tag15_of`（SetSession、SetVigil、FileOutpost、FileTicket、SettleTicket、CloseCitizen の記録の key） | 全 NFT Citizen が同じ key（財布 0 の tag）になる → 住民 ID を key に（仮） |

**program：財布のまま残したもの（意図どおり）**：共通入口の財布判定と住所検査、RetireHost の財布判定、財布の Join。NFT Citizen はここで必ず拒否される。

**program の外：未対応（NFT Citizen を正しく扱えない）**

| 場所 | 内容 | 影響 |
|---|---|---|
| keeper `landindex.rs:198,216,292` | 土地の申請の記録を財布の tag で Citizen に結ぶ | NFT Citizen の申請を keeper が精算に回せない |
| herald `conquest.rs:315` | Citizen の `WALLET` を読む | NFT Citizen の持ち主の表示が 0 |
| 検証器 `facts.rs:283,301`、`checks/v1_chains.rs:63`、`v11_land.rs:304`、`v12_explore.rs:32`、`conquest.rs:37` | 記録の key から財布の住所を出す | NFT Citizen の記録を別の住所に結ぶ → 失敗 |
| 検証器 `checks/v9_addresses.rs:56` | Citizen の住所を `WALLET` から検算 | NFT Citizen は必ず失敗 |
| 検証器 `checks/v23_caravans.rs:511` | 隊商の送り手の権限を `WALLET` で再判定 | NFT Citizen の送りは失敗 |
| fclient `addr.rs:229,357`、`vectors.rs` | Citizen の住所＝財布から | NFT Citizen の住所を出せない |
| gateway relay `routes/relay.mjs:70-73` | settle の要求者の Citizen を財布から | NFT Citizen の枠を使えない |
| gateway relay の shape 分類 | `0xff` の命令を知らない | **NFT Citizen の操作を relay が中継できない** |
| agent wallet `agent/gateway.mjs:72,481,...` | agent の Citizen＝owner の財布から。取引は財布の形で組む | NFT Citizen の代理（MCP 含む）は動かない |
| gateway `achievements.mjs:110`、`routes/prize.mjs:116,252` | 財布から Citizen | NFT Citizen は対象外 |
| client・web の SDK `addresses.mjs`、`faddr.mjs`、`prize.mjs` | Citizen の住所＝財布から | 画面が NFT Citizen を見つけられず、`Act`・`Join` の取引を組めない |

## 4. 仮の値（④ と調整中）

| 項目 | 仮の値 | 置き場所 |
|---|---|---|
| 命令 tag | 試験用 `0xff`、下位番号 0 CreatePolicy、1 Register、2 Act、3 Join | `frontier-abi/src/resident_wire.rs` |
| Citizen の `WALLET` | 全 0 | `frontier-abi/src/resident_citizen.rs` |
| Citizen の予約領域 | `RESIDENT_ASSET` @348（32）、`RESIDENT_FLAGS` @380（1、bit0）、381–383 予約 | 同上 |
| NFT Citizen の記録の key | 住民 ID `sha256("PSF-RES" ‖ asset)[0..15]`（住民プログラムの tag15 と同じ） | 同上 |
| 作成の記録 | 出さない（kind が未割当） | `proc/resident.rs` `join` |
| JoinShard の人数 | 数えない（財布のプレイヤーの shard の記録を壊さないため） | 同上 |

## 5. 試験（2026-11-06）

実行：ABI の 11 件（すべて固定のバイト列、名前で 1 件ずつ）。新規は住民 ID が実際の住民プログラムの値と一致すること、財布と NFT の Citizen の区別と記録の key、偽の印の拒否、`Act`・`Join` の符号。build・静的検査：`cargo check`、`cargo clippy -D warnings`（frontier-abi、permutation-frontier の既定と `nft-experimental`、全 target）、`cargo fmt --check`（workspace 全体）すべて通過。

実行していない：program を実際に動かす試験（LiteSVM・validator。鍵の生成と署名を伴うため未承認）、既存の固定 seed の試験、SBF の build、keeper・herald・検証器・gateway の試験。つまり、Join・Act・各命令の NFT 経路が実行時に正しく動くことは**未確認**。

## 6. ④ との調整

2026-11-06 に ④ のセッションへ提案を送った：命令 tag 3 つ（空き帯、0xC1 を避ける）、作成記録の kind と短い形、NFT Citizen の記録の key、`WALLET`＝0、予約領域の使い方、版を上げるか。返答はまだ無い。返答に合わせて §4 の値を変える。
