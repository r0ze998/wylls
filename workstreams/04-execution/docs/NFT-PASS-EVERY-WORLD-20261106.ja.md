# 同じ NFT パスで、作り直した世界にも参加できるようにする（④、⑳の U45、2026-11-06）

**方針**（利用者が決定）：NFT パスは同じものを使い続ける。今は継続世界を前提とする。将来世界を作り直す場合も、同じ NFT パスで新しい世界に参加できるようにする。1 NFT につき 1 アカウントの関係は保つ。

**決めていないこと**：資産・履歴を世界間でどう引き継ぐか（⑳の U11）。この案は「新しい世界で参加できる」ことだけを扱います。引き継ぐかどうか、どう引き継ぐかは決めていません。

- **対象**：⑳ `claude/funny-wozniak-cy4n64` `9d0697c9f755bfeb0e77ae243ec3f7471e9342f8`（`5380abd6ba835a89921775e77e7416143c028023` を含む）。
- **修正案の commit**：`46ff47f561e0e8a515b32d462354dffce2b16adc`（この文書はその次の commit）。
- **修正案**：`workstreams/04-execution/patches/ws20-link-every-world-20261106.patch`（9d0697c9 に当てる。sha256 `fe5b8bbcffad1b44409748317e29afa64894af2f795f1a22a0871498e3aadcf9`）。
  - ④は⑳のコードを上書きしていません。⑳の branch にも push していません。当てるかどうかは⑳が決めます。
- **鍵**：鍵の生成・導出・署名はしていません。⑳の runtime 試験（`resident_runtime_tests.rs`）は、固定の 32 byte と program が計算する address だけを使い、署名者は `is_signer` で表します。
- **結果**：
  - 当てる前：resident の試験は 6/6。
  - 当てた後：resident の試験は 9/9、`permutation-frontier` の lib 試験（`nft-experimental`）は 103/103、`frontier-abi` の `resident_binding` は 1/1。rustfmt も通過。
  - 実行していないもの：SBF での build、LiteSVM、実チェーン。

## 0. 追記（同日）：最終は、⑳の Season ごとの link（案 a）。SHA は未着

- 経過：⑳は案 a（`88d789b3`）を作った。その後、この patch を採用して `deebd3b5a89ea88daa16d7f31a0c09871a6e98f4` にした。そこから再び案 a に戻すと宣言した。④と⑳のメッセージが 2 回、行き違ったためである。
- 行き違いを止めるために、④は「コードを持つ⑳の最後の宣言で確定する」と⑳に伝えた。④は、どちらの案も利用者の条件（同じ NFT で新しい世界に参加できる、1 NFT・1 アカウント、引き継ぎは決めない）を満たすと判断している。
- 案 a の内容（⑳の宣言）：
  - link は `["nft-citizen-link", Season の address, asset]`。layout（PSFNR001、104 B）・tag・kind・エラー番号は変えない。
  - client は `linkAddress(programId, season, asset)`。`/f/residents` の `link` は「この世界に参加済み」の意味になり、`joined` と一致する。
  - 鍵なしの試験 5 件：別の世界にも参加できる、同じ世界での 2 回目は AlreadyDone、譲渡はすべての世界に効く、別の世界の link や Citizen は拒否、旧い seed の住所は使わない。
  - herald・keeper・verifier は、1 つの Season ごとに保存する。
  - 世界ごとの link の rent（104 B）は、参加する人（payer）が払う。
- まだどこにも deploy されていないので、既存の link の移行は要らない。
- 下の §2 の patch と、deebd3b5 は、置き換えられた代替案として残す。§3 の影響（譲渡、引き継ぎ、仕様の論点）は、案 a にもそのまま当てはまる。
- ⑳の SHA が届いたら、④が照合する。

## 1. 原因

- link（`["nft-citizen-link", asset]`、AccountKind 32、`PSFNR001`、104 B）は、すべての世界で共通の 1 つです。中身は `{asset, resident, citizen}` で、一度だけ書けます。
- `citizen` には、**最初に参加した世界の Citizen の住所**が入ります。
- 一方、NFT の Citizen は世界（Season）ごとに `citizen_by_tag15(住民 ID)` にあります。
- JoinResident と ResidentAct の `authorize` は、link の `citizen` が今の世界の Citizen と一致することを求めていました。そのため、2 つ目の世界では一致せず、`BadAccount` で拒否されていました（⑳の `a_second_season_cannot_log_in_with_todays_link`）。

## 2. 修正案：link を「NFT と住民アカウントの一対一の記録」に戻す

**変える所**は次の 3 ファイルです。

| ファイル | 変更 |
|---|---|
| `frontier-abi/src/resident_binding.rs` | `same_identity(record, asset, resident)` を足す。`citizen` の欄の意味を文書にする（最初の Citizen、履歴であって認可の材料ではない）。layout・magic・大きさ・`read`・`write_once`・`matches` は変えない |
| `permutation-frontier/src/resident_binding.rs` | `authorize` と、既存の link がある `join_accounts` の比較を、asset と住民アカウントだけにする。`citizen` は比べない。新しく link を作るときは、今までどおり、その世界の Citizen を最初の Citizen として書く |
| `permutation-frontier/src/resident_runtime_tests.rs` | 「2 つ目の世界は拒否される」の試験を、下の 4 件に置き換える |

**世界ごとの Citizen の本物さ**は、link の `citizen` の代わりに、次の 3 つで確かめます。3 つとも、変更前からある検査です。

1. **正しい住所**：`check_addresses` が、Season と住民 ID から求めた `citizen_by_tag15` の住所と一致するかを見る。
2. **その世界の口座**：`present_v2` が、program の所有、v2 の大きさ、magic、その Season の id を確かめる。
3. **その NFT の印**：`proc::resident::check` が、Citizen の `RESIDENT_ASSET` が asset と一致するかを見る。

この住所には、`JoinResident` が Season の PDA の署名で作る以外に、口座を作る方法がありません。財布の住民の tag とは、domain（`PSF-CIT` と `PSF-RES`）が違うので重なりません。link の `citizen` を比べなくても、他人や別の世界の Citizen で通ることはありません（下の試験）。

**試験**（`resident_runtime_tests.rs`、鍵なし）：

| 試験 | 確かめること |
|---|---|
| `the_same_nft_joins_a_later_season_with_its_one_link` | 世界 7 で参加した NFT が、同じ link で世界 8 にも参加できる。link は 1 byte も変わらず、最初の Citizen（世界 7）を指したまま。世界 8 の Citizen にも、その asset の印と同じ住民 ID がある。同じ世界での 2 回目は `AlreadyDone`。持ち主は両方の世界で行動できる。世界 7 の Citizen を世界 8 で使うと拒否される |
| `a_transfer_moves_the_one_account_in_every_season_at_once` | A から B へ譲渡すると、両方の世界で同時に、A は `Stale`・`NotCurrent` になり、B が行動できる。譲渡の後に作った世界 9 には、B だけが参加でき、A は参加できない |
| `a_later_season_refuses_a_link_of_another_asset_or_resident` | link の asset や住民を 1 bit 変えると、新しい世界での参加は `BadAccount`。戻せば参加できる。link は一度だけ書けるまま |
| `a_citizen_without_this_assets_mark_is_refused` | 印（asset）が違う Citizen では行動できない。戻せば行動できる |

既存の試験（初回の参加と RESIDENT_JOINED、今の持ち主だけが参加できる、譲渡と買い戻し、署名なし・guard なし・差し替え、session と財布の経路）は、変えずに通ります。

### 採らなかった案

| 案 | 採らない理由 |
|---|---|
| link を世界ごとにする（seed に Season を入れる） | 既存の link（最初の世界の住所）が新しい規則の住所と合わず、特別扱いが要る。「1 NFT・1 アカウント」の記録が世界の数だけ増え、世界ごとに rent もかかる。client が link の住所を計算する式も変わる |
| link の layout を新しくする（`citizen` を除いた `PSFNR002`） | 既存の link を移す必要がある。今の案と比べて安全性は上がらない |
| 今のまま（最初の世界だけ） | 利用者の方針に反する |

## 3. 影響

### 既存のデータ

- 既存の link は、中身も住所もそのままです。移行の作業はありません。
  - `citizen` の欄の意味だけが「この link が認可する Citizen」から「最初の Citizen（履歴）」に変わります。
  - AccountKind 32 の layout と magic は変わりません。ABI 割当の AccountKind 32（予約）の説明を、④がこの意味に直します。
- 最初の世界の Citizen と、その中身は変わりません。最初の世界での動きは、変更前と同じです。そこでは link の `citizen` と、正しい住所が一致しているからです。
- 実際の deploy の有無は不明です。`nft-experimental` の内側にある機能です。

### 譲渡の後の権限

- 権限（今の持ち主、世代、session）は、世界によらない住民 program の記録から、毎回読みます。この点は変わりません。
- **譲渡は、すべての世界の Citizen に同時に効きます**。新しい持ち主は、すべての世界で直ちに行動でき、前の持ち主とその session は、すべての世界で拒否されます（試験 2）。
- 新しい世界に参加できるのは、その時点の持ち主だけです。session ではできません。
- **仕様の論点（決めていない）**：作り直しの前後で世界が同時に動いている場合、1 つの NFT が複数の世界に、同時に Citizen を持てます。財布の住民も同じですが、NFT は売買されます。そのため、各世界の Citizen の持ち物が NFT と一緒に移ることを、市場でどう扱うかは別に決める必要があります（⑳の市場の論点）。

### 互換性

- **client・中継・web**（`linkAddress`、`/f/residents`、`fresident.mjs`、herald の `/h/me/{asset}`）は、もともと Citizen を「その世界と住民 ID」から計算していて、link の中身を読みません。変更は要りません。
  - ただし `/f/residents` の `link: true` は、意味が「この NFT はどこかの世界で参加したことがある」に変わります。「この世界に参加済みか」は `joined`（Citizen があるか）で判断してください。表示の文言を⑳が確かめる必要があります。
- **RESIDENT_JOINED（130）**：世界ごとに 1 回ずつ出ます。keeper の landindex、herald、verifier が世界（Season）ごとに保存していれば問題ありません。
  - herald の記録の key（`RESIDENT_JOINED:<住民 ID>`）は Season を含みません。1 つの保存先で複数の世界を扱う構成だと、重なります。
- **変更前の program**は、新しい link を同じように読めます（layout が同じ）。ただし、2 つ目の世界の参加は拒否します。program の版をまたいで混ぜることはしないでください。

### 引き継ぎについて（決めていない。この案が塞がないこと）

- 新しい世界の Citizen は、財布の住民と同じく、空の状態から始まります（持ち村・資源・記録は持ち越しません）。これは「参加できる」ことの最小限で、引き継がないと決めたわけではありません。
- 後で引き継ぐと決めた場合に使える手掛かりは、残してあります：住民 ID（不変）、link の最初の Citizen、世界ごとの RESIDENT_JOINED。
- **注意**：引き継ぎを Join の時点で行う設計（例：前の世界の Citizen から写して作る）にする場合、引き継ぎより先に空の Citizen で参加させると、後から写せなくなるおそれがあります。引き継ぎを決めるまで、新しい世界での参加を止めるかどうかも、引き継ぎと合わせた仕様の判断です。今の案は、方針どおり参加を止めていません。

## 4. ⑳が必要な変更

1. patch を当てる（上の 3 ファイル）。⑳の判断で、書き方を変えてかまいません。満たしてほしい条件は 2 つです。
   - link は 1 NFT に 1 つで、一度だけ書ける。
   - 世界ごとの Citizen は、住所・その世界・印の 3 つで確かめる。
2. 文書を直す：
   - `permutation-nft-resident-spike/docs/SEASON-SCOPE.ja.md` の §2・§4。
   - `CANDIDATE-20-REVIEW.ja.md` の「一対一の記録」の行。
   - `NFT-ACCOUNT-WIRING.ja.md` の JoinResident の説明（「同じ NFT の 2 回目」は「同じ世界での 2 回目」）。
3. `/f/residents` の `link` の意味と、web の表示文言を確かめる。
4. herald・keeper・verifier の RESIDENT_JOINED の保存が、世界ごとかどうかを確かめる。複数の世界を 1 つの保存先で扱うなら、key に Season を足す。
5. SBF での build と LiteSVM での確認（配備の前。今回は鍵を使わない条件のため実施していません）。

④がすること：ABI 割当の AccountKind 32 の説明の更新（⑳が当てた後）。番号の変更はありません。
