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

## 3. 検証器 V28（ResidentAct、番号は仮）

`frontier-node/crates/verify/src/checks/v28_resident_acts.rs`。成功した `ResidentAct` ごとに：

| 照合 | 証拠 | 判定 |
|---|---|---|
| 内側の命令が、program が NFT Citizen に走らせる 26 命令のどれか（`resident_wire::ACT_RUNS`。SetSession などは拒否） | 命令データ | 違えば FAIL |
| 証明の 4 アカウントが読み取り専用、Citizen が書き込み可、Season がこの Season | 命令のアカウント | 違えば FAIL |
| policy・link・住民アカウント・Citizen が、この Season でこのパスが参加した JoinResident と同じ | 保存された JoinResident | 違えば FAIL、参加が無ければ UNVERIFIABLE |
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
- 署名そのものは見ない（ウォレットの Citizen と同じく、実行環境が確かめた）。policy の住所も見ない（program が参加時と操作時に確かめる）。
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
