# NFT 住民の初回アカウント作成と、全操作への権限検査の接続（2026-11-06）

起点 `46e940bd`。program 側の実装は feature `nft-experimental` の内側にある。命令 tag・記録の番号・Citizen の予約領域・住所と記録の key は ④ が 2026-11-06 に割り当てた（統合まで仮、§4）。

## 1. 権限の構造（Frontier program の中）

| 仕様 | どう成り立たせたか |
|---|---|
| 最初に NFT でログイン、1 NFT につき 1 アカウント | `JoinResident`（0xE1）：対応の記録 `["nft-citizen-link", asset]` と Citizen を同じ取引で作る。Citizen は Season の `citizen_by_tag15(住民 ID)` に、財布の Join と同じ方法で作る（住民 ID＝`sha256("PSF-RES" ‖ asset)[0..15]`）。署名者は asset の今の owner 本人（session は不可）、署名された世代が今の世代、asset に transfer guard。同じ NFT の 2 回目は Citizen が既にあるので `AlreadyDone`。対応の記録は一回だけ書ける |
| 譲渡で操作権が新所有者へ | 毎回、同じ呼び出しの中で Core の今の owner を読む。譲渡（住民プログラムの `TransferResident`）の直後から新所有者が通る。Frontier 側に「操作者」の欄を持たないので、反映の遅れが無い |
| 旧所有者は操作できない | owner でない署名は `NotCurrentAuthority`。NFT Citizen の `WALLET` は全 0 なので、財布の経路（共通入口、RetireHost の自前判定、Frontier の session）も一致しない。全 0 の財布は署名できず、NFT Citizen は全 0 の財布の tag の住所にも無い |
| 旧 session の拒否 | NFT Citizen の session は住民プログラムのものだけを見る（Frontier の SetSession は NFT Citizen では拒否）。住民プログラムは譲渡ごとに session を消し、session には設定した世代と設定者が残る。今の owner が今の世代で設定したものだけが通る |
| 旧世代・譲渡前の署名の拒否 | 命令データに署名された世代が、住民口座の今の世代と違えば `StaleGeneration`。譲渡ごとに世代＋1 |
| A→B→A でも復活しない | 世代は 0→1→2 と進み、戻らない。A が売る前に署名した取引（世代 0）も、A の前の session（消されている）も通らない。A は世代 2 で設定し直したものだけで動ける |
| guard の無い asset | 拒否（`Unguarded`）。guard が無いと通常の Core transfer で動き、世代が変わらないため |

## 2. 接続した命令と、接続しなかった命令

**NFT Citizen として実行できる命令（`ResidentAct`＝0xE2 の中身、27）**：すべて「元の命令の口座＋[policy, link, asset, resident]」の形。本体は財布の経路と同じ関数（`_as` 形）で、複製は無い。

| 入口 | 命令 |
|---|---|
| `holding::player_as`（20） | Harvest、Build、Train、Explore、Muster、Dissolve、Garrison、Depart、BuildStructure、SeizeStructure、CloseStructure、FortGarrison、Propose、Vote、BuildVault、SendCaravan、RaidCaravan、RaidDomestic、SeizeVault、CloseVault |
| `citizen::player_as`（5） | SetVigil、FileOutpost、FileTicket、PlaceHome、SetSession（NFT Citizen では必ず拒否） |
| `conquest::player_v2_as`（1） | DeclareSiege（MC の season であることも確認） |
| RetireHost の自前判定（1） | RetireHost（季節中の被害者本人の判定を NFT 版に） |

`WalletRequired`（他人あての隊商、構造物の撤去）は「owner 本人」なら通り、session では拒否される（`by_session`＝owner でない）。

**新設**：0xE0 `CreateResidentPolicy`（候補 20）、0xE1 `JoinResident`（初回ログイン）、0xE2 `ResidentAct`（上の 27 を包む）。候補 20 の `Register`（対応だけを先に作る）は、`JoinResident` が対応も作るので外した。

**権限の検査が無い命令（接続不要）**：Citizen の署名者を持たず、keeper か誰でも呼べる。SettleTicket、ReleaseDormant、CloseHolding、CloseCitizen、SettleExplore、DisbandStranded、SettleDeparture、Reveal（keeper）、SettleTransit、SweepPoolOwed、GatherClash、ResolveFromInputs、SkipQuiet、CloseClashInputs、CloseArrivalDay、CloseArrivalSlot、ClaimDefence、SettleSiege、SettleCapture、CloseMarch、SettleCaravan、DefaultRaid、SettleProposal、FastForward、季節の管理と地図の命令。

**接続していない**：財布の Join はそのまま（NFT Citizen とは別の Citizen を作る）。賞金 program（Entry は財布で決まる）。

## 3. 財布から決まる住所・財布の欄を前提にする箇所（洗い出し）

④ の求めに合わせ、「拒否に頼れる（NFT Citizen には届かず、それで安全）」と「住民 ID に切り替えが要る（NFT Citizen を正しく扱うため）」に分けた。NFT Citizen は `citizen_by_tag15(住民 ID)` にあり、記録の key も住民 ID なので、**記録の key から住所を出す読み手は、そのままで NFT Citizen を見つけられる**。

**A. 拒否に頼れる**

| 箇所 | 理由 |
|---|---|
| program：共通入口の財布・session 判定と住所検査、RetireHost の財布判定 | NFT Citizen の `WALLET` は全 0（誰も署名できない）、住所は全 0 の財布の tag の住所と違う |
| program：財布の Join、財布の SetSession | 財布の Citizen だけを作る・扱う。NFT Citizen の SetSession は `ResidentAct` の中でも明示的に拒否 |
| relay `routes/relay.mjs:70-73`（settle の要求者を Citizen の枠に数える） | NFT Citizen では null になり、匿名の枠に数えられるだけ（権限には関わらない） |
| agent wallet `agent/gateway.mjs`（agent の Citizen＝owner の財布の Citizen） | NFT Citizen には届かない（owner の財布の Citizen があればそちらを動かすだけ）。NFT Citizen の代理は別に作る必要がある（U42） |
| 賞金 `routes/prize.mjs`、program の Entry、`achievements.mjs` | 財布の Citizen だけが対象。NFT の住民の賞金は決めていない |

**B. 住民 ID に切り替えが要る**

| 箇所 | 今の動き | 要る変更 |
|---|---|---|
| program：SettleTicket、CloseCitizen、SettleTransit の野営の Citizen、`citizen_v2`（SettleSiege、SettleCapture、RetireHost）、記録の key（`tag15_of`） | **今回直した**：住所＝`citizen_by_tag15(記録の key)`、key＝住民 ID | — |
| 検証器 `checks/v9_addresses.rs:56` | Citizen の住所を `WALLET` から検算 → NFT Citizen は失敗 | 印のある Citizen は住民 ID から検算 |
| 検証器 `checks/v23_caravans.rs:511` | 他人あての隊商の送り手を `WALLET` で再判定 → NFT Citizen は失敗 | その時点の Core の owner と住民の世代での再判定（住民プログラムの状態が要る） |
| 検証器 `facts.rs`、`v1_chains`、`v11_land`、`v12_explore`、`conquest.rs` | 記録の key から `citizen_by_tag15` → NFT Citizen の住所も正しく出る | `RESIDENT_JOINED`（kind 90）を Citizen の始まりとして読む |
| keeper `landindex.rs` | 記録の key から住所 → 正しく出る | `RESIDENT_JOINED` を読む（JOIN の代わり） |
| herald `conquest.rs:315`（tag → 財布・国） | NFT Citizen は財布 0 と表示 | 印のある Citizen は asset（または住民 ID）を持ち主の識別に |
| fclient `addr.rs`（`citizen(wallet)`）、`decode.rs` | 財布からしか住所を出せない | 住民 ID からの住所、resident 欄の読み取り |
| gateway relay の shape 分類 | 0xE0–0xE2 を知らない → **NFT Citizen の操作を中継できない** | `JoinResident`・`ResidentAct` の shape（中の命令＋証明口座 4 つ） |
| client・web の SDK `addresses.mjs`、`faddr.mjs`、`prize.mjs` | Citizen の住所＝財布から | 住民 ID からの住所、`JoinResident`・`ResidentAct` の取引の組み立て、ログイン画面 |
| ④ の executor・acts（`agentId` を key に） | — | ④ が確認する |

**記録 `RESIDENT_JOINED`（kind 90）**：④ の割り当て済み。program と読み手（keeper・herald・検証器・fclient）を同じ変更で更新する必要がある（今の decode は知らない kind を拒否）ので、まだ出していない。

## 4. 割り当て（④、2026-11-06、統合まで仮）

④ の記録：`claude/gallant-ride-cunptv` の `6057256bc9845454ebc89b97610b65f814ea69bc`、`workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md`。

| 項目 | 値 | 実装の場所 |
|---|---|---|
| 命令 tag | 0xE0 CreateResidentPolicy、0xE1 JoinResident、0xE2 ResidentAct、0xE3–0xE7 予備、0xFF は試験だけ | `frontier-abi/src/resident_wire.rs`、`permutation-frontier/src/lib.rs` |
| 記録 | kind 90 `RESIDENT_JOINED`（key＝住民 ID、payload 42 B）、91–94 予備。ログの VERSION は上げない | **未実装**（program と読み手を同じ変更で） |
| Citizen の `WALLET` | 全 0 | `frontier-abi/src/resident_citizen.rs` |
| 予約領域 | `RESIDENT_ASSET` @348（32）、`RESIDENT_FLAGS` @380（1、bit0）、381–383 予約。LAYOUT_VERSION は 2 のまま | 同上 |
| Citizen の住所と記録の key | 住民 ID から（`citizen_by_tag15(住民 ID)`） | 同上、`proc/resident.rs` |
| program の版 | 本番の値は統合時に ④ が決める。試験 build は別の値（`0x8000 | S1`） | `permutation-frontier/src/lib.rs` |
| JoinShard の人数 | 数えない（記録が無いまま数えると、財布のプレイヤーの shard の記録が壊れる） | `proc/resident.rs` |

## 5. 試験（2026-11-06）

実行：ABI の 11 件（すべて固定のバイト列、名前で 1 件ずつ）。新規は、住民 ID が実際の住民プログラムの値と一致すること、財布と NFT の Citizen の区別と記録の key、偽の印の拒否、0xE0–0xE7 が v2 の命令表で空いていること、`CreateResidentPolicy`・`JoinResident`・`ResidentAct` の符号。build・静的検査：`cargo clippy -D warnings`（frontier-abi、permutation-frontier の既定と `nft-experimental`、全 target）、`cargo fmt --check`（workspace 全体）すべて通過。

実行していない：program を実際に動かす試験（LiteSVM・validator。鍵の生成と署名を伴うため未承認）、既存の固定 seed の試験、SBF の build、keeper・herald・検証器・gateway の試験。つまり、JoinResident・ResidentAct・各命令の NFT 経路が実行時に正しく動くことは**未確認**。

## 6. ④ との調整

2026-11-06 に提案を送り、同日 ④ から割り当てが届いた（§4）。④ の意見に合わせ、NFT Citizen の住所を候補 20 の `["nft-citizen", asset]` から `citizen_by_tag15(住民 ID)` に改めた。§3 の一覧を ④ に送った。
