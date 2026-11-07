# パスの持ち主の契約：ゲーム・検証器・賞金で同じ定義を読む（2026-11-06）

所有者の方針（2026-11-06）：全プレイヤーに NFT パスが必須。**譲渡前の未受取賞金もパスとともに新しい持ち主へ移る**。返金と、その他の資産・履歴の移転は未決。

NFT 賞金は所有者側の CC が実装している。⑳ は賞金を実装しない（同じ部分を重ねない）。この文書は、賞金がゲームと検証器と**同じ持ち主の判定**を使うための契約。

## 1. 一つの定義：`frontier_abi::resident_auth`

| 関数 | 入力 | 返すもの |
|---|---|---|
| `holder(binding, policy, asset, resident)` | 束ねた asset と住民アカウント（キー・所有プログラム・バイト）、policy（Core・住民プログラム・collection・guard） | `Holder { asset, owner, generation, session }` か拒否 |
| `Holder::authority(actor, signed_generation, now, session_allowed)` | 操作する鍵、その鍵が署名した世代、今の時刻、session を認めるか | `Owner`・`Session` か拒否 |
| `authorize(...)`（ゲームが使う） | 上の二つ＋署名の有無 | `Ok` か拒否 |

- `owner`：asset の今の Core 所有者。
- `generation`：住民プログラムの持ち主の世代。持ち主が変わるたびに 1 増え、同じ命令で session が消える。transfer guard（凍結した Permanent Freeze と Permanent Transfer Delegate、どちらも住民プログラムのアドレスが持つ）により、`TransferResident` が asset を動かす唯一の方法。A→B→A は世代 0→1→2。
- `session`：今の持ち主が、今の世代に設定した代理鍵だけ（設定者が違う・世代が違うものは `None`）。期限は使うときに確かめる。
- 拒否の順：署名なし → `Asset`（束ねた asset でない／Core でない／collection が違う）→ `Unguarded`（guard が無い）→ `Resident`（束ねた住民アカウントでない）→ `StaleGeneration`（署名した世代が今と違う＝譲渡の前の署名）→ `NotCurrentAuthority`（今の持ち主でも、その生きた session でもない＝旧所有者・旧 session）。番号は 170–175（④ の割り当て、統合まで仮）。

ゲームの `authorize` は v0.17 でこの二つを組み合わせる形に置き換えた（判定と順は前と同じ。既存の試験はそのまま通る）。

## 2. 賞金側に合わせてほしいこと（提案。賞金の実装は所有者側の CC）

| 項目 | 提案 | 理由 |
|---|---|---|
| 権利の識別 | NFT 住民の賞金の権利は **asset（パス）**で識別する。財布や Citizen の住所では識別しない | 財布は譲渡で変わる。Citizen の住所は Season ごとに変わる（U45） |
| Season の Citizen との対応 | その Season の link（`["nft-citizen-link", season, asset]`、PSFNR001 `{asset, resident, citizen}`）で asset から Citizen を引く | 1 NFT・1 Season・1 Citizen。国（faction）と成果はその Citizen から |
| 受け取る人 | 受取の時点で `holder(...)` と `authority(actor, 署名した世代, now, session_allowed)` を通った人 | 譲渡前の未受取分も、今の持ち主だけが受け取れる |
| 署名する世代 | 受取の命令データに、受取人が署名した世代を入れ、同じ実行の中で住民アカウントと比べる | 譲渡の前に署名した受取は、譲渡の後に必ず拒否される |
| 支払先 | 受取の時点の持ち主（`owner`）の口座。保存した財布へは払わない | 旧所有者へ払われない |
| 二重受取 | 受取済みの印を、プールごとに asset で持つ | 譲渡しても新しい権利が生まれない |
| session で受け取れるか | **未決（所有者の判断）**。提案は持ち主本人だけ（`session_allowed = false`） | お金の移動は代理鍵の範囲を超えるため |
| 返金（refund）モード | **未決（所有者）**。払った人に返すか、パスの持ち主に返すか | 方針で未決とされている |

賞金の検証も、ゲームの操作と同じ証拠（§3 の住民プログラムの記録）で判定できる。

## 3. 検証器 V28（ResidentAct、番号は ④ が確定：割当 rev 6）

`frontier-node/crates/verify/src/checks/v28_resident_acts.rs`。成功した `ResidentAct` ごとに：

| 照合 | 証拠 | 判定 |
|---|---|---|
| 内側の命令が、program が NFT Citizen に走らせる 26 命令のどれか（`resident_wire::ACT_RUNS`。SetSession などは拒否） | 命令データ | 違えば FAIL |
| 証明の 4 アカウントが読み取り専用、Citizen が書き込み可、Season がこの Season | 命令のアカウント | 違えば FAIL |
| policy・link（この Season のもの）・Citizen が正規の住所。policy が分かれば住民アカウントと policy の guard authority も正規 | 公開のプログラムアドレスから計算（PDA と seed の住所。v0.18） | 違えば FAIL。policy が分からなければ住民アカウントと guard は未判定 |
| policy・link・住民アカウント・Citizen が、この Season でこのパスが参加した JoinResident と同じ | 保存された JoinResident | 違えば FAIL、参加が無ければ UNVERIFIABLE |
| policy の中身（Core・住民プログラム・collection・guard） | 保存物の CreateResidentPolicy、または住民プログラムの記録の policy アカウント | どちらにも無ければ、持ち主と住民アカウントの住所は未判定 |
| 実行結果：Citizen がこの asset の NFT Citizen のまま（財布はゼロ）、この時刻に操作された（`LAST_ACTION_TS`） | Citizen の実行後の状態 | 違えば FAIL、状態が無ければ UNVERIFIABLE |
| 持ち主と世代：署名した世代が持ち主の世代、操作した鍵が持ち主か生きた session | 住民プログラムの記録（`ResidentFeed`） | 下の表 |
| 内側の命令そのものの効果 | （NFT Citizen の命令の再生は未実装） | 常に UNVERIFIABLE |

持ち主の判定（`Holder` を記録から読み、§1 と同じ関数で判定する）：

| 場合 | 判定 |
|---|---|
| 記録が無い（今の Frontier の保存物には無い） | UNVERIFIABLE |
| 記録の順序が保存物と同じ feed のものでない（seq が重なる） | UNVERIFIABLE |
| 署名した世代が、操作より前に記録された世代より小さい | **FAIL**（譲渡前の署名が通った。世代は戻らないので、記録に抜けがあっても確か） |
| 署名した世代が記録より大きい | 記録に抜けが無ければ FAIL、あれば UNVERIFIABLE（譲渡が記録に無い） |
| 操作した鍵が持ち主でも生きた session でもない（旧所有者・旧 session・期限切れ） | 記録に抜けが無ければ **FAIL**、あれば UNVERIFIABLE（抜けた SetSession がありうる） |
| 持ち主か生きた session | 持ち主については問題なし（内側の命令は上のとおり UNVERIFIABLE） |

「記録に抜けが無い」とは、Frontier と住民プログラムの両方を一つの feed で保存し、操作の前の seq がすべて揃っていること。

### V28 の限界

- 住民プログラムの記録（`ResidentFeed`）を検証器に渡す入力の形は、まだ無い（`Input` は ④ の形式。`run` は記録なしで動き、持ち主の判定はすべて UNVERIFIABLE）。`run_with(cx, Some(&feed))` で渡せる。
- 署名そのものは見ない（ウォレットの Citizen と同じく、実行環境が確かめた）。
- V0 は ResidentAct を引き続き UNVERIFIABLE（`UnverifiedInstruction`）とする。V28 は、証拠で否定できるものを FAIL にし、残りを UNVERIFIABLE のまま残す。PASS にはならない。

## 4. 鍵を使わずに確かめたこと（2026-11-06）

すべて固定のバイトと書き込んだ住所だけ。鍵の生成・導出・署名、PDA や seed からの住所の計算はしていない（試験の中でも、試験が呼ぶ関数の中でも）。名前を指定して一つずつ実行した。

| 試験 | 件数 | 内容 |
|---|---|---|
| `frontier-abi` `resident_auth::tests::*` | 3 | 持ち主の定義（A→B→A、旧所有者・旧 session・旧世代・期限切れ・設定者や世代の違う session）、ゲームの `authorize`（前と同じ判定）、番号 170–175 |
| `frontier-abi` `resident_wire::tests::act_runs_the_listed_player_instructions_only` | 1 | 26 命令の一覧 |
| `permutation-frontier` `proc::resident::act_list::*` | 1 | program の `act` の分岐が一覧と同じ（ソースの文字列を比べるだけ） |
| `verify` `checks::v28_resident_acts::tests::*` | 4 | 持ち主と生きた session は通る（A→B→A）。旧所有者・旧 session・譲渡前の署名を通した操作は FAIL（7 通り）。記録が無い・抜けがある・feed が別は UNVERIFIABLE（ただし世代の後戻りは FAIL）。内側の命令・アカウント・JoinResident・実行結果の不一致は FAIL |

V28 の試験は、判定を一つずつ壊すと落ちることも確かめた（4 か所）。

実行していないもの：program を実際に動かす試験（`resident_runtime_tests` など。program の中で PDA を計算する）、LiteSVM・SBF・Node の鍵を使う試験、CI。

## 5. v0.18：PDA・with_seed の計算が許可された後（2026-11-06）

所有者の指示：PDA と with_seed による公開アドレスの算出は、試験の中でもプログラムの中でも許可。鍵ペアの生成・導出と署名は、固定 seed・共通セットアップ・CI を含め引き続き禁止。

変更：
- `fclient::addr` に `resident_policy`・`resident_link`・`resident_account`・`resident_guard`（PDA）を加えた。web の SDK（`resident.mjs`）と同じ値になることを、web の関数で計算した固定の値と比べて確かめた。
- V28 が policy・link・Citizen・住民アカウント・guard authority の正規の住所を照合する（§3 の表）。参加の記録が無くても住所の誤りは FAIL になる。policy は保存物の CreateResidentPolicy からも読む。

実行前の確認（呼び出し先まで）：
- 試験と、試験が呼ぶ関数に、鍵ペアの生成（`Keypair`・`new_unique`・`from_seed`・`SigningKey`）と署名・署名検証が無いことを grep と読みで確かめた。PDA は sha256 と曲線上かどうかの判定だけ、with_seed は sha256 だけ。
- 実行時の試験（`resident_runtime_tests`）は本物の `dispatch` を動かす。操作者は書き込んだ住所で、署名の印（`is_signer`）は試験が立てる。program が呼ぶ `invoke_signed`（PDA の権限での system 命令）は試験の中の代替が処理し、暗号の署名は起きない。join・SetVigil の経路に署名の検証（ed25519・secp・BLS）は無い。

実行した試験（名前で絞って実行、すべて合格）：

| 試験 | 件数 |
|---|---|
| `permutation-frontier` `resident_runtime_tests::*`（実行時：初回ログイン、今の持ち主だけ、譲渡と買い戻しで旧所有者・旧 session・旧世代を拒否、無署名・guard なし・差し替えの拒否、世界ごと、旧グローバル link を使わない、Frontier の session と財布の経路は NFT Citizen に効かない）＋ `proc::resident::act_list::*` | 10 ＋ 1 |
| `verify` `checks::v28_resident_acts::tests::*` | 5 |
| `verify` `checks::v27_residents::tests::*`（⑪）・`facts::resident_tests::*`・`checks::v9_addresses::resident*` | 5 ＋ 2 ＋ 6 |
| `fclient` `addr::tests::resident_pdas_match_the_web_client` | 1 |
| `frontier-abi` `resident_auth::tests::*`・`resident_wire::tests::act_runs_*` | 3 ＋ 1 |

v0.17 の持ち主の定義への置き換え（`authorize` = `holder` + `authority`）の後で、実行時の試験が 10 件とも通ることも、これで確かめた。

実行していない：LiteSVM・SBF・Node の試験（鍵ペアを作り署名する）、CI（push は `[skip ci]`）。

## 6. 接続済み・未接続・UNVERIFIABLE の区別（2026-11-06）

| 区分 | 内容 |
|---|---|
| 接続済み・実行で確認 | ゲームの権限検査（`authorize` = 持ち主の定義）。譲渡後の旧所有者・旧 session・旧世代の拒否と A→B→A（実行時の試験、署名の検証は外して `is_signer` を試験が立てる） |
| 接続済み・固定のデータで確認 | V28 の判定（内側の命令の種類、アカウント、正規の住所、参加時の link、実行後の Citizen、記録があるときの持ち主と世代） |
| 未接続 | V28 に住民プログラムの記録を渡す入力（`Input` は ④ の形式。今は記録なしで動く）。Frontier と住民プログラムを一つの feed で保存する索引。NFT 賞金（所有者側の CC。契約は §2 の提案）。V28 に記録を渡す `Input` の欄（④ の案はあるが未決）と、それを作る archiver の担当 |
| UNVERIFIABLE のまま | 記録が無いときの持ち主と世代。記録に抜けがあるときの旧所有者・旧 session（世代の後戻りだけは FAIL）。参加の記録が無いときの link の中身。policy が分からないときの住民アカウントの住所。内側の命令そのものの効果（NFT Citizen の命令の再生は未実装）。V0 は ResidentAct を `UnverifiedInstruction` のままにする（⑪ の求め） |

## 7. ④ の統合（2026-11-06）

④ は ⑳ b2f7becc を統合候補 4ebc0dc3（tree c809045b…）に衝突なく merge した（⑪ 0010 も同じ木）。④ の通しの場面の「撤回」の段は、所有者と世代を `resident_auth::holder` と `Holder::authority` で読む（第二の定義は無い）。結果は program の拒否と一致する。④ の段 E（chain_prize）は、今の prize program が NFT Citizen に払えないこと（どの経路も BadAccount）を本物のコードで示した。§2 は ④ の文書 §9 に、所有者側の CC への接点として載っている。いずれも ④ の報告で、⑳ はその木を見ていない（④ はまだ push していない）。

## 8. 住民プログラムの記録（ResidentFeed）と両プログラムの共有履歴（2026-11-07、v0.19）

統合候補 3ad0bcdb（ゲーム・NFT 初期配置・④ r2・⑲ r2 の履歴の扱い・⑪ 0011）を取り込み、その上に作った。

### 一つの順序の根拠

- ローカルノード（`frontier-localnet`）は、着地したすべての取引に一つの `seq` を振る（airdrop も含む）。`frontier_feed` はその台帳を program で絞るだけ。だから同じノードから住民プログラムで絞った feed は、Frontier の取引と同じ順序になる。両方の program に関わる取引は、両方の feed に同じ `seq`・同じ署名で現れる。
- `through`：住民プログラムの取引のうち `after < seq <= through` のものはすべて feed にある、という範囲。`fetch` は Frontier の取引を読んだ**後で**住民プログラムの feed を読み切り、`through` を Frontier の最後の `seq` にする。台帳は増えるだけなので、後から読み切れば少なくともそこまでは含む。
- 公開 RPC には同じ順序が無い（⑲ の `unproven`）。`fetch` はローカルノードの feed だけを受け付ける。

### 実装済み

| 項目 | 場所 |
|---|---|
| `ResidentFeed`（program・⑲ の `History`・`after`・`through`・取引（seq・署名・成否・実行後の状態）・policy）と fixture の JSON | `frontier-node/crates/verify/src/resident_feed.rs` |
| 検証器の入力 `Input.resident_feed`（④ の案どおり `Option`）。fixture の `resident_feed` 欄。読めない欄はエラー（黙って無しにしない） | `verify/src/input.rs` |
| 取得：`frontier-verify --rpc URL --localnet --resident-program ID`、`frontier-stack` の状態に `resident_program` があるとき | `verify/src/main.rs`、`stack/src/verifyrun.rs` |
| V28 が入力の feed を使う。持ち主の FAIL は `gaps_before` が空のときだけ | `verify/src/checks/v28_resident_acts.rs` |
| `gaps_before`：feed の出所が `unproven`、ゲームの履歴が `unproven`、出所が違う（ローカルノードなら URL まで同じ）、`after ≠ 0`、`through` が操作の前で止まっている（古い控え）、範囲外・同じ seq が二つ、同じ seq で Frontier と署名が違う | `resident_feed.rs` |
| ⑲ の判定規則：V28 の FAIL のうち、取得した取引の中だけで決まるもの（内側の命令・アカウントの書き込み可否・Season・正規の住所・参加時の link・実行後の Citizen）は不完全な履歴でも FAIL のまま。`ResidentOldAuthority`（feed に依る）は外す | `verify/src/history.rs` `self_contained` |

### 未検証・未接続

- **実ノードで試していない**：`fetch` と `--resident-program` は、住民プログラムを載せたローカルノードで動かしていない（試験は固定の feed だけ）。
- **ノードが同じであることの証明は無い**：出所の一致は記録された説明（URL）の比較で、証明ではない。
- **findex の保存物に住民プログラムの feed は無い**：`--archive` から読むときは feed が付かない（V28 の持ち主は UNVERIFIABLE）。保存物の形にするのは ④ と ⑲ との合意が要る。
- **観測範囲と取引の一対一の照合**：feed に「範囲内のすべての取引がある」ことは、ノードの台帳を信じたうえでの主張。v0.19 の追補で、feed を読んだ**後**の台帳の長さ（`frontier_status` の `transactions`、`tip`）を記録し、読んだ seq がそれを超えていれば「読み取りが食い違う」として whole にしないようにした。これは鮮度の確認だけで、完全性の根拠は増えない（同じノードの数なので、そのノードが欠けていれば数も欠ける。⑲ の指摘）。
- **住民プログラムの取引の中身**：V28 は住民プログラムの命令（TransferResident・SetSession）そのものは検証せず、その実行後の状態を使う。
- `gaps_before` の「feed の出所が unproven」の規則は、「出所が同じ」と「ゲームの履歴が unproven でない」から導かれる重複の守り（壊しても試験は落ちない）。

### 実行した試験（鍵ペアの生成・導出・署名なし。PDA・with_seed の計算はあり）

| 試験 | 件数 |
|---|---|
| `verify` `resident_feed::tests::*`（一つの順序・古い控え・RPC・別ノード・fixture と feed の混在・同じ seq の別取引・範囲外・二重・`after`、JSON の往復） | 2 |
| `verify` `checks::v28_resident_acts::tests::*`（feed の読み取り範囲で古い控えを UNVERIFIABLE、ゲームの履歴が RPC なら UNVERIFIABLE を追加） | 5 |

`gaps_before` の規則を一つずつ壊すと、範囲と署名の規則では試験が落ちることを確かめた。実行しなかった：`tests/common` を使う試験（鍵ペアを作り署名する）、LiteSVM・SBF・Node、CI。

### ⑲ の確認（2026-11-07、読んだだけで試験は未実行）と保存物の方針

- `history.rs` の V28 の行と、`ResidentOldAuthority` を外すことに同意。
- `fetch` の注記を直した：ローカルノードの feed は、空でも台帳の feed（`ledger_feed`）。
- findex の `Archive::append` は seq を振り直す。保存物から読んだ Frontier の入力の seq は台帳の seq ではない。今は出所の説明（URL）の一致を求めるので、保存物と実ノードの組合せは whole にならない（安全側）。
- 保存物の持ち方の提案（⑲）：二つの保存物ではなく、**一本の保存物に両方のプログラムを台帳の順で**入れる（`frontier_feed` の絞り込みを「どちらかのプログラム」に、カーソルは台帳の seq の `feed_after` のまま）。両方に関わる取引は一件になり、照合は保存物の seq ではなく署名で行う。二本にするなら、記録ごとに台帳の seq を別の欄に残す必要がある。公開 RPC には二つのプログラムに共通の順序が無く、whole にならないのが正しい。**未実装**（localnet の `frontier_feed` と findex は ④・⑲ の領分。担当と形の合意が要る）。
