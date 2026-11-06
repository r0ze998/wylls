# 統合候補 2026-11-06c（④）：⑯ への引き渡し

**前の版**：`d0e96d5394d88decf878676f37bc3782654d1045`（[06b](INTEGRATION-20261106b.ja.md) の単位 0–15）。この文書は、その後の単位と、空の環境から復元する手順と、実装済み・未接続・未検証の一覧です。

- 鍵の生成・導出・署名を伴う試験は、どこでも行っていません。CI も、push のたびに最後の commit に `[skip ci]` を入れて、起動させていません。
- main への merge、本番の配備、実際の取引は、していません。
- ⑤ e9d1551a は、公開版に入れていません（⑤が push を保留しているため）。

## 1. 単位（d0e96d53 の後）

| # | 内容 | commit / tree | 試験（鍵なし） |
|---|---|---|---|
| 16 | ⑳ 45d95e31：RESIDENT_JOINED は、その取引の JoinResident にだけ対応し、住民 ID ごとに 1 件 | `5cd4cd5de53148fb6c6e99aba3e4b5ed51877b8b` / `edeb5481c0dddabc07d98cd93efd52dbe045e816` | 単位 22 と合わせて |
| 17 | ⑥ 517796dc（GitHub `preserve/ws06-creation-517796dc`） | `8615f0737d07b92100c6286e19a1593f5fa1cfa9` / `84f85d55f7153c917aead63eb9feec8da8095fb2` | guard 付きで 8 件が合格。残りの 93 件は、すべて guard が鍵の操作の前に止めたもの（実の失敗は 0） |
| 18 | ① 3f3c8478（GitHub `preserve/ws01-coop-s1-3f3c8478`） | `20e33d259aeb463a29afd542f07e6da120c87f95` / `5eb2bc38fc48c6a23fb687bc35eb4d9be350ced9` | 164 件が合格。残りの 27 件は、すべて guard が止めたもの（実の失敗は 0） |
| 19 | ⑮ b1a09a0b（GitHub `preserve/ws15-b1a09a0b`） | `52694f8afc5f8576f08bcf2e0777d42196334b07` / `35f7f31934afb73c87efa4c59fbbb5c4e3535324` | 70/70 |
| 20 | ⑭ 7d7f2143（GitHub `preserve/ws14-7d7f2143`） | `4e4b3f8b08e9ac94b83a5663aa8392c8863b4094` / `c69822b8b801ccc08710a723580d981cf1873768` | 19/19 |
| 21 | ⑧ ca67d40e（GitHub `preserve/ws08-persistence-ca67d40e`、workstreams/08 だけ） | `4fe3117777d1f78b18a1177d820181c6b33397e2` / `8c640385c6a41964abfbbde7ba5f3621926091a6` | 32/32 |
| 22 | **verify：JoinResident（0xE1）を検証器の最後までつなぐ**（④） | `25f7a655a065623fca47da6f4d2c22b2f66a6feb` / `0fa1d8000e52200e3445f5820f49f454d8411311` | 下の §2 |
| 23 | **runexec：荷車だけの Run**（⑥の、作る工程の無い配達。④） | `30a3fd2e667a022bf3fb8193227a7981316a4ff4` / `d705c851cb53527149faacc05a0f7e9af55cadd3` | 下の §3 |

単位 17–21 は「GitHub にある最新」です。各担当のもっと新しい版は、④に届いていません（§6）。

## 2. JoinResident を検証器の最後まで（⑳ 45d95e31 ＋ ⑪ 0008 ＋ ④）

**完成の条件**は「正しい NFT の参加が通り、偽造・欠落・不一致・重複が拒否される」こと。検査ごとの担当は次のとおりです。

| 検査 | 担当 | 内容 |
|---|---|---|
| V0（⑱の枠に④が足した） | ④ | 版 `0x8000\|S1`（nft-experimental の S1 build。**仮の値で、④が割り当て、統合で確定**）を、検証器が知る版にした。その季では、0xE0–0xE7 を完全な長さで decode する。JoinResident は「扱う」。CreateResidentPolicy と ResidentAct は Unverifiable。decode できなければ FAIL。**それ以外の季では、今までどおり FAIL**（UnknownInstruction） |
| V9・facts（⑳） | ⑳ | RESIDENT_JOINED の key が asset の住民 ID であること。同じ取引の最上位の JoinResident と、asset・generation・faction・shard・join_bell が一致すること。季の中で住民 ID ごとに 1 件だけであること。facts は、条件を満たす最初の 1 件からだけ NFT の Citizen を作る |
| V9（④が足した） | ④ | 成功した JoinResident に、それに対応する RESIDENT_JOINED が同じ取引に無ければ FAIL。runtime がログを切った取引なら Unverifiable |
| V0E（⑪ 0008） | ⑪ | kind 130 は、同じ取引に一致する JoinResident があるときだけ「判定される側」に数える。それ以外は UnverifiedRecord |

**試験**（すべて固定の byte。鍵は使わない）：
- 正しい参加は、V9 の両方向（記録→命令、命令→記録）で findings 0。
- 次はすべて非 PASS：key の偽造、命令の無い記録、記録の無い命令、generation・faction・asset の不一致、同じ NFT の 2 回目の参加。
- V0 の判定：季の種類ごと、長さの不足・超過、帯の中の未使用の tag、CreateResidentPolicy、ResidentAct、ResidentAct の中身が resident の命令であるもの。
- 結果：verify lib 24、unit 8、fixtures 8、camp_clear 3、missing_state 2、open_items 3、evidence 8、new_bands 6。findex 10、herald 42。

**未検証**：
- 実際の nft-experimental の Season の記録（fixture）を検証器に通した試験は、まだありません。fixture を作り直すには署名が要るので、作っていません。
- ⑳ の runtime の試験（resident 10/10）と、検証器の試験は、同じ wire（`frontier_abi::resident_wire`）と同じ記録の layout（`v2/log.rs` の RESIDENT_JOINED）を使っています。ただし、program が出した byte 列を、そのまま検証器に入れた試験ではありません。

## 3. 荷車だけの Run（⑥）

- `RunSpec.facility` を `Option<FacilityRef>` にした。`None` が荷車だけの Run で、作る材料・出来上がり・使用権を持たない（受付で拒否）。
- 荷車だけの Run の流れ：
  1. Accepted で、stock に荷が揃うのを待つ。来るはずの荷車が失われたと分かれば Failed、期限が来れば Expired。
  2. 荷を予約し、送信の段（FacilityConfirmed）へ進む。この Accepted→FacilityConfirmed の移り変わりは、荷車だけの Run にだけ許す。施設の状態（Reserved、FacilityRequested、FacilitySubmitted）には決して入らない。
  3. その後は、作る Run の発送と同じ：seq の固定、到着、Fulfilled／Partial／DeliveredUnverified／Failed。
- 施設のある spec は、今までと同じ JSON になる（digest は不変）。
- 試験（模擬のチェーン、鍵なし）：
  - 荷車だけの Run が Fulfilled になる。施設への要求は 0 回、使用権も使わない。
  - 荷が足りなければ待ち、期限で Expired になり、何も動かない。
  - 作る部分を持つ荷車だけの spec は拒否される。
  - 施設のある spec の直列化は変わらない。
- 結果：runexec 96 件が合格、9 件は ignored（署名する試験）。clippy -D warnings も通過。
- **⑥ との接続で残ること（⑥の判断・仕様）**：⑥の計画・依頼から RunSpec を作る adapter と、Receipt の欄（manifest・planHash・run・outputs・port・beneficiary）は、⑥の新しい版が届いてから作る。⑥ の `handoff/04-run-receipt.ja.md` §4 の問い（記録の置き場所、id、束、1 日の回数、緊急停止）は、仕様の判断を含むので、④は決めていない。

## 4. 空の環境からの復元と試験（⑯ 用）

```
git clone https://github.com/r0ze998/wylls && cd wylls
git fetch origin claude/gallant-ride-cunptv
git checkout --detach <この文書を含む commit>     # 公開版の先端
git rev-parse HEAD HEAD^{tree}                     # 下の §5 と一致すること

# 鍵なしの検査（CI の push・PR の job と同じもの）
python3 scripts/ci/check-ci-keyfree.py
(cd permutation-gateway && npm ci --ignore-scripts)
scripts/ci/node-keyfree.sh permutation-gateway 'test/*.test.mjs' 'screens/logic.screen.mjs'
cargo test -p frontier-abi
cargo test -p permutation-frontier --lib
cargo test -p permutation-frontier --lib --features nft-experimental      # ⑳ resident 10 を含む
(cd frontier-node && cargo test -p findex --lib && cargo test -p herald --lib)
(cd frontier-node && cargo test -p verify --lib \
   && for t in unit camp_clear missing_state open_items evidence new_bands; do cargo test -p verify --test $t; done \
   && cargo test -p verify --test fixtures -- --skip march_fixture_is_fresh)   # tamper・coverage・record は署名するので除外
(cd workstreams/04-execution && cargo test --offline)                       # runexec（署名の 9 件は ignored）
(cd workstreams/04-execution/e2e-native && cargo test --locked)
sh workstreams/12-memory/tools/test-nokey.sh
(cd workstreams/04-execution && cargo build --release --offline --bin runexec)
(cd workstreams/13-citizens && WS04_ACTS_CLIENT=$PWD/../04-execution/clients/acts.mjs \
   RUNEXEC_BIN=<target>/release/runexec WS12_ROOT=$PWD/../.. \
   node --import ./test/keyless-guard.mjs --test $(ls test/*.test.mjs | grep -v ws12-public-evidence))
for d in 09-capacity/kernel 09-capacity/bridge10 10-custody/custody 10-custody/adapter-09 11-extensions/ext-kernel; do (cd workstreams/$d && cargo test); done
# ⑥ ① ⑮ ⑭ ⑧ の Node の試験（guard 付き。guard が止めた件は「鍵が要るので未実施」）
for d in 06-creation 01-national-strategy 15-coop-outcomes 14-central-tower 08-persistence; do
  (cd permutation-gateway && node --import ../scripts/ci/no-keys-guard.mjs --test $(find ../workstreams/$d -name '*.test.mjs' -o -name '*.test.js' | grep -v node_modules))
done
```

**期待する結果**：§1・§2・§3 と 06b §1 の表のとおり。
- ⑥ と ① は「pass の数＋guard が止めた数」になる。
- ⑬ は 103 件が合格し、6 件が skip（署名する試験）。⑤ を含まない公開版では、さらに ⑤ に依存する分が skip になる。

## 5. 実装済み・未接続・未検証

| 範囲 | 実装済み（この候補で動く） | 未接続 | 未検証 |
|---|---|---|---|
| ⑳ NFT パスと 0xE1 | program（世界ごとの link、JoinResident、ResidentAct）、検証器の 0xE1（§2） | ResidentAct の中身の命令を、検査が扱っていない（Unverifiable） | nft-experimental の Season の fixture での照合。SBF・LiteSVM |
| ⑪ 検証器 | 0004・0005・0007・0008 | V0E の CPI の内側の命令の判定（③・④） | tamper・coverage・record（署名） |
| ⑨・⑩ Lot 表 | 一つの表。⑨ 872fe6a2 と ⑩ 563407d9 で一致 | ⑩ の core 0013（V26）は、⑩ の先端にも入っていない。ABI rev 4 の番号での作り直しは⑩の作業 | — |
| ⑫・⑬ 記憶 | 同じ木で接続（④の登録簿・⑤・⑫） | — | ⑤ を含む全体版は手元だけ |
| ③・⑤ 権限 | ④の登録簿（`runexec act`、`clients/acts.mjs`）、`GET /f/agent/fate` | **送り手ごとの資格情報（③ 0008 と ⑤ 0005）の一本化**：③ 7923f900 と ⑤ 276a392b が未着 | — |
| ⑥ 荷車だけの Run | ④ の Run（§3） | ⑥ の計画→RunSpec の adapter と Receipt の欄 | ⑥ の新しい版との照合 |
| ①・⑮ 実出力 | GitHub の版の①（3f3c8478）・⑮（b1a09a0b）が同じ木にある | ⑮ の `fold()` の実出力を ① が読む経路（① の新しい版、⑮ cb87e30c が未着） | ⑮ cb87e30c |
| ⑧・⑱・⑲ 世界と履歴 | ⑧ の persistence（文書と試験）、統合の基準にある⑧の ContinuousWorld、⑱ の V0、⑲ は基準に入っている分だけ | ⑧ の cont-verify・continuous の新しい版（GitHub の古い版は、core の 37 ファイルで衝突する）、⑱ b71b8197、⑲ 4ee79ecc | 同左 |
| ⑰ 賞金 | RecordNation（④）、prize の再現試験 | ⑰ 9abceecd（SDK・精算・`--risks`）が未着 | 規則の判断が要る件（D・E・K1–K3、NFT 住民の受取） |

## 6. 届いていない成果物（必要なもの）

| 担当 | 必要なもの | 用途 |
|---|---|---|
| ③ | `7923f900060208ed340ea59b322e7e18bef21999` を含む bundle（基点の commit 付き）、または共有パッチ 0008 と、それが当たる commit | 資格情報の一本化 |
| ⑤ | `ws05-276a392b-delivery.tar.gz`（SHA-256 `f71112b0edddd3e902770994cb80cbe97a6c0c3b47b440e69225853f5f72ae70`）：`ws05-since-e9d1551a.bundle`、`shared-patches-on-ws04-8e96f24d/` の 0002c・0003・0004b・0005 | 同上 |
| ⑥ | 最新の commit（GitHub は 10-30 の 517796dc のまま） | 計画→RunSpec の adapter |
| ① | 最新の commit（⑮ の `fold()` を読む版） | ①・⑮ の実出力 |
| ⑮ | `cb87e30c`（⑯ が復元した薄型 bundle、または⑮ の bundle） | 同上 |
| ⑭ | `b31803ff`、`5f4c0b99`（未 push） | ⑭ の最新 |
| ⑧ | 3 つの branch を合わせた tree `00aff806…` の commit（bundle）と BeaconLog の最小差分 | ⑧ の継続世界の最新 |
| ⑱ | `b71b8197`（⑯ が phase 9 で重ねた版） | 履歴の検証 |
| ⑲ | `4ee79ecc`（bundle ws19-on-8e96f24d、SHA-256 `4b00b549…0accc`） | MagicBlock の接続 |
| ⑰ | `9abceecdfece14e4dd979525ac0b517d10c7bf87`（④の上の RecordNation 対応と `--risks`）、または `wylls-17-rn-on-ws04.tgz`（SHA-256 `464144b8…6cc42`） | 賞金 |
| ② | `2c58034a` | 権利 |
| ⑦ | integ-v17 bundle（SHA-256 `3fa1ec99…`） | UI |

## 7. 決めていないこと（仕様。④は決めない）

- NFT 住民の賞金の受取（shares の Claim は財布の Citizen を前提にしている。譲渡の後は誰の権利か）。
- 賞金の D（終了後の Pay）・E（Aborted の資金）・K1–K3（州の閉鎖と集計の順序）。
- ⑥ の §4（記録の置き場所・id・束・1 日の回数・緊急停止）。
- ③・⑤・⑰ の push の可否（repository は公開。外部の配備の痕跡は無いが、GitBook の Git Sync は確認できない）。
- CI の変更を main と全担当の branch に入れるかどうか。
- nft-experimental の版の値（`0x8000|S1`）を、統合で確定するかどうか。
