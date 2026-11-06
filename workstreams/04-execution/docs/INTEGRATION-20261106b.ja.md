# 統合候補 2026-11-06b（④）：各担当の成果を一つの木に

**起点**：④ `claude/gallant-ride-cunptv` `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6`（統合候補 `ef63544c` の上）。

**鍵**：鍵の生成・導出・署名を伴う試験は、どこでも行っていません。Node の試験は `scripts/ci/no-keys-guard.mjs`（鍵の API をその場で拒否する）か、各担当の guard を付けて動かしました。Rust の試験は、鍵を使わないものだけを選んで動かしました（下の表）。

**main・deploy・実取引**：なし。

## 0. 二つの版

| 版 | branch | 内容 | push |
|---|---|---|---|
| **公開版** | `ws04/int-20261106-pub` → `claude/gallant-ride-cunptv` | ⑤ e9d1551a を**含まない** | `[skip ci]` 付きで push する（CI は起動しない） |
| **全体版** | `ws04/int-20261106`（④の手元だけ） | 公開版＋⑤ e9d1551a | **push しない**。⑤が push を保留している成果を、④の push で公開しないため。⑤か利用者の許可が出れば push する |

二つの木の差は、`workstreams/05-ai-participation/` の 114 ファイルだけです（`git diff` で確認）。

試験の結果は、全体版で取りました。公開版では、⑤に依存する試験（⑬の ws05-cost と ws04-acts の一部）が skip になります。

## 1. 統合の単位（順に、どこでも止めて再現できる）

| # | 内容 | 公開版 commit / tree | 全体版 commit / tree | 試験（鍵なし） |
|---|---|---|---|---|
| 0 | ⑳ dc55f159 を merge（衝突 9 件はどちらの側も残す。エラー 94 と 170–175、findex の二つの修正、`/f/agent/fate` と `/f/residents`、web の財布の同期） | `739618ae21e06364082da6ba99db740be6a8acfd` / `335eba4a9cd16536a8f0a4a1a4d6d1f6f45d7b66` | 同じ | （次の行） |
| 0' | frontier-abi のエラー表の試験を、merge 後の表に合わせる | `f86fed48db0359817b24cdf8f98f693305256073` / `e1d02ac1a3a0a1e18825ebad75f02195618840ad` | 同じ | frontier-abi 102、permutation-frontier 95（既定）・105（nft-experimental）、findex lib 10、herald lib 42、fclient conquest 8 |
| 1 | CI：push と PR は鍵なし。鍵を使う段は手動の `key-tests` へ（`docs/ci/KEY-FREE-CI.ja.md`） | `525a623fa40868f706e1dee1fd5f45587d33511e` / `74ef18edc47a461b5624a784afcf2b2763b95309` | 同じ | gateway の鍵なし 1,722 件（失敗 0、guard の拒否 0）、receipt 13、exec-native 20、`check-ci-keyfree.py` 0 件 |
| 2 | ⑳ 41552f0d（NFT パスの販売条件・上限・metadata） | `a61b89c3e5f05fd2620891bf301f1c3556ffaeec` / `3acd6557667cbf5b44ef952f35ca9ca8af6c4567` | 同じ | sale-terms 3/3（guard 付き）。resident program の Rust の試験は未実施 |
| 3 | ⑤ e9d1551a（受け取った包みから） | — | `56cdb07f4f289ee09a212b8972a9426f848969a9` / `0fcf89eff73a9f64c0c9bea45f534f749554932a` | 47/48。残る 1 件は、⑤が確かめた gateway の木（560f8659）を固定する試験で、この候補の木（490ff68b）は⑤がまだ確かめていない。上書きしていない |
| 4 | ⑬ 745e7ec6 | `524e7864941dd633b795e228cfca3e9cd5010d7d` / `26568da9f6a1b563ac216a74b1773a58cedc332c` | `2f2a9c9d647a08709a0ca64e1d34acf11711f91e` / `b30fc1dcdbae94d30677ed763991cae53c8397a6` | 下の 12・13 |
| 5 | ⑫ c6877a1a（統合側にあったのは⑫自身の 4bc76d05 の版なので、⑫の最新を採った） | `777628e08d47917c727fbdc7325e929bfa1e2870` / `35d2335bfd7d2f1e9b6bb885ddaa9aa5ad16ab42` | `e06ce18b27812b7b282a9d41f6cb2b4ab2383dd1` / `2c30150915c92ea976ad41273e23496fc018e3b1` | ⑫ `tools/test-nokey.sh`：ran 49、needs-key 69（guard で止まり、走っていない）、skipped 1、FAILED 0 |
| 6 | ⑨ 8fe85cc9（統合側にあったのは⑨自身の版。世代の折り返しの保護は⑨の 004836e2 から） | `caa32b1751b0ce396bb04ff57ef29bb5908c3afe` / `6d2f80eda996509caf8fbaf4c421f04dd73c73f3` | `af8887d7fdb271e8158981427765a7247df0b707` / `dc30b96456e26337b98360ea6e4a26ddf37dc353` | kernel 35。bridge10：accounting 1、contract10 12、decided 8、lots 6。**connect10 は compile できない**（§2 の 9・10） |
| 7 | ⑩ 563407d9（統合側にあったのは⑩自身の版） | `3db28635804f750704d30ff3612c0263f18a3127` / `cb36e8a88da605ee0e2e5dd3738707ecc7131079` | `2f4d882e8e71d0b514bdfaedeb6c9d999b349873` / `988a4baddb070f4b2d079f1a986e9f0f7fdbb8aa` | custody 35、adapter-09 16 |
| 8 | ⑪ c8d694bd（統合側にあったのは⑪自身の 2aceaf47 の版。統合側の V7 の修正 f8d46ef8 は verify の中にあり、そのまま） | `5ac2af3192ae22822ab875e011db399c2a1becb5` / `c1a69d7640caea2986daacb583691c3fda19c28b` | `ad5e776a0dff49beb1540ee2f0e3d1d11a106c16` / `9301bd14573eaaf22f098c3f9b3fef3a8399335e` | ext-kernel 43 |
| 9 | verify：⑪ の 0004、続いて 0005（0001 は取り下げ、0003 は適用済み） | `e401158a880006034e4b7d56b38df26b66012e57` / `339b0650a05e8247677a2d36e3dd86890a52ad3e` | `e095c0251a768d6da221521a0335eaff7ac4c3ef` / `96aa4f15ccd445ceae45b425f8382429f1760e30` | lib 17、unit 8、fixtures 8（`march_fixture_is_fresh` は署名するので除外）、camp_clear 3、missing_state 2、open_items 3、evidence 8。試験は fixture を読む関数しか呼ばない（`world()`・`send()` は使わない）。tamper・coverage・record は未実施 |
| 10 | ABI 割当 rev 4（統合候補のコードには衝突なし。⑩の依頼への答え） | `624c002da3bfbc9fba814307d31de1d6b9e0da8f` / `24126ca2d35ff8be244e207c9ef0e6f1e987c7c8` | `cea9182f51b423232679d35a8f533aa68d5429b3` / `caa0d96e19578bf99855419d24100ecb2ad30bc4` | `abi_inventory.py`（`contracts/abi-inventory-20261106b.txt`） |

| 11 | ⑳ 9e6b0c01（findex の `enumerate()`。clippy の explicit_counter_loop） | `213fa65515e7b5a4950fdf5435f59a8dcf8bacde` / `8926b723dfb38e7b49c8704fc1f599fc5cc56800` | 未作成（全体版は⑤の判断の後に作り直す） | findex lib 10。clippy はこの環境に 1.95 の clippy が無いため未実施（⑳は workspace 全体で通ると報告） |
| 12 | ⑪ ab3a2f23（r7：patch 0006・0007、新しい帯は PASS にならない） | `8d68d89bb0382faedeadc63af2b7b96333e1bfaf` / `3c6b3cdb7f2cbd232a9f61363eaa547465d694d1` | 同上 | — |
| 13 | verify：⑪ の 0007（0004・0005 の後。V0E の UnverifiedRecord） | `4c65aaa229cea9ba2a57229cac78cc2715c5df7d` / `d90de6b4b1df14c500434d3bf7751e945256b7f3` | 同上 | lib 17、unit 8、fixtures 8、camp_clear 3、missing_state 2、open_items 3、evidence 8、new_bands 4/5。**残る 1 件は⑪の仕掛けた検査**：⑳の RESIDENT_JOINED（kind 130）を、まだどの検査も扱っていない。そのため V0E は、その記録を UnverifiedRecord とする。kind 130 を扱う検査が要る（⑪・⑳・④）。試験は消していない |

| 14 | ⑨ 872fe6a2（connect10 を外して⑩に合わせた。他人の再送には NotUser を返す修正は残した） | `34cee632a89b8e5d571eaa01a1aae8406f345e61` / `4f2d607be40bac20cd972d34855ac2e89bafc8ff` | 未作成 | ⑨ kernel 43、bridge10 28、⑩ adapter-09 16。**9・10 は一致した** |

全体版の merge の commit message には「WS05=この木」で取った結果が書いてあります。公開版は同じ message を使っていますが、⑤の木は含みません。

### ⑯ への再現手順（公開版）

```
git fetch origin claude/gallant-ride-cunptv
git checkout --detach <上の表の公開版 commit>
git rev-parse HEAD^{tree}                       # 表の tree と一致すること
# 鍵なしの検査（CI の push と PR の job と同じ）
python3 scripts/ci/check-ci-keyfree.py
(cd permutation-gateway && npm ci --ignore-scripts) && scripts/ci/node-keyfree.sh permutation-gateway 'test/*.test.mjs' 'screens/logic.screen.mjs'
cargo test -p frontier-abi; cargo test -p permutation-frontier --lib; cargo test -p permutation-frontier --lib --features nft-experimental
(cd frontier-node && cargo test -p findex --lib && cargo test -p herald --lib)
(cd frontier-node && cargo test -p verify --lib && for t in unit camp_clear missing_state open_items evidence; do cargo test -p verify --test $t; done && cargo test -p verify --test fixtures -- --skip march_fixture_is_fresh)
(cd workstreams/04-execution/e2e-native && cargo test --locked)
sh workstreams/12-memory/tools/test-nokey.sh
(cd workstreams/13-citizens && WS04_ACTS_CLIENT=$PWD/../04-execution/clients/acts.mjs RUNEXEC_BIN=<runexec> WS12_ROOT=$PWD/../.. node --import ./test/keyless-guard.mjs --test $(ls test/*.test.mjs | grep -v ws12-public-evidence))
(cd workstreams/09-capacity/kernel && cargo test); (cd workstreams/10-custody/custody && cargo test); (cd workstreams/10-custody/adapter-09 && cargo test)
(cd workstreams/11-extensions/ext-kernel && cargo test)
```

`<runexec>` は `cd workstreams/04-execution && cargo build --release --bin runexec` で作ります（鍵を使いません）。

## 2. 同じ版でつなぐ組（完全 SHA と受け口）

| 組 | 使う版 | 受け口（どこでつなぐか） | 状態 |
|---|---|---|---|
| **3・5・6** | ③ GitHub 上は `preserve/ws03-mcp-acdcd0bf` `acdcd0bf795d10a65f6b8192076c4f8d6357e557`（＋`claude/modest-goldberg-c180fk` `2f8ec700fa7533d7fd61c87b5a84f31d05420325`）。⑤ `e9d1551aa049f25c54fd6ebc24185d93a2d8ac4c`（全体版に含む）。⑥ `preserve/ws06-creation-517796dc` `517796dce6dec5c1496775d73ad84a0cb8befa09`。④ はこの候補 | ④ の実行登録簿（`runexec act register\|status\|list --db`、終了コード 0／2／3／4／1、`clients/acts.mjs` の `createActsClient`）、`GET /f/agent/fate`（7 状態）。**MCP と AI の資格情報を送り手ごとに分ける relay の受け口は、③ 7923f900 の 0008 と ⑤ 276a392b の共有パッチを一本化してから決める**。⑥：荷車だけの Run（量と到着の判定）を④の Run に足す必要がある | **③ 7923f900 と ⑤ 276a392b が届いていない**ため、一本化は未着手。③と⑤に、`[skip ci]` 付きの push での受け渡しを依頼済み |
| **12・13** | ⑫ `c6877a1a62a7a90891c8f268194a39593fafe541`、⑬ `745e7ec661450654b83d893b3440ecda314ea517`、⑤ `e9d1551a`、④ この候補 | `WS04_ACTS_CLIENT`＋`RUNEXEC_BIN`（④）、`WS05_E9D1551A`（⑤の木）、`WS12_ROOT`（⑫の木）。どれも全体版の木そのものを指せばよい | 全体版で、⑬ は 110 件中 103 件が合格、6 件が skip（署名する試験）、1 件は guard を二重に付けたためだけの失敗（⑬ の guard だけなら 4/4）。⑫ は FAILED 0 |
| **1・14・15** | ① GitHub `preserve/ws01-coop-s1-3f3c8478` `3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52`。⑭ GitHub `preserve/ws14-7d7f2143` `7d7f2143d6f2696a3bc323d1d619b1d6961a7b18`（最新の b31803ff・5f4c0b99 は未 push）。⑮ GitHub `preserve/ws15-b1a09a0b` `b1a09a0b15dd44f587b1158fc40dd3f17577fcca`（⑯ が bundle から復元した cb87e30c は④に未着） | ⑮ の `fold()` の出力（協力の成果の判定）を、① と ⑭ が同じ版で読む | **⑮ cb87e30c、⑭ b31803ff・5f4c0b99 が④に未着**。三者とも、まだこの候補に入っていない |
| **9・10** | ⑨ `872fe6a2195267415684351126cd9abb6effcd2a`（8fe85cc9 の後）、⑩ `563407d96e74934fd82141bf9ad09980ea94bf75`（両方この候補に入っている） | 一つの Lot 表（⑩ custody の lot module と adapter-09、⑨ の bridge10） | **一致した（単位 14）**。⑨ が connect10 を外して ⑩ の adapter に合わせた。⑨ kernel 43、bridge10 28、⑩ adapter-09 16 が合格 |

## 2b. 公開と配備の確認（2026-11-06、GitHub の API を読むだけ）

- repository は **公開（public）**。
- commit の status は 0 件（④ 8e96f24d・232a5aa7、⑯ b9a4bfeb）。check run は `github-actions` だけで、`[skip ci]` の commit は 0 件。deployments は 0 件。
- vercel・netlify・Pages の設定は repository の中にない。GitBook の設定は `claude/determined-ride-engpa4` にだけある。
- GitHub の外にある GitBook の Git Sync の設定と、Pages の API（proxy に拒まれた）は、確かめられていない。

## 3. 届いていない成果（統合済みとして扱わない）

| 担当 | SHA | 状態 |
|---|---|---|
| ③ | `7923f900060208ed340ea59b322e7e18bef21999`（共有パッチ 0008） | 未着 |
| ⑤ | `276a392b00a5981f09f5c921befc7a69e5fb04f4`（delivery ws05-276a392b） | 未着 |
| ⑰ | `9abceecdfece14e4dd979525ac0b517d10c7bf87`（④の上の RecordNation 対応と `--risks`）、本線 `10fbabc3166bf5c7ed64ce6549655e4160f50dd6` | 未着（包みは利用者宛て） |
| ⑮ | `cb87e30c` | 未着（⑯は bundle から復元したが、GitHub にない） |
| ⑭ | `b31803ff`、`5f4c0b99` | 未 push |
| ⑱ | `b71b8197` | 未着 |
| ⑲ | `4ee79ecc`（bundle ws19-on-8e96f24d） | 未着 |
| ② | `2c58034a` | 未着 |
| ⑦ | integ-v17 bundle | 未着（push 保留中） |
| ⑧ | 3 つの branch を合わせた tree `00aff806…` | 未着 |
EOF
cd /tmp/claude-0/-home-user-wylls/5555dbe6-e2d1-5bc2-a85b-6ed2bdfcb441/scratchpad/int-pub && git add workstreams/04-execution/docs/INTEGRATION-20261106b.ja.md && printf 'ws04 docs: integration 2026-11-06b — units with SHA/tree, repro steps for 16, shared versions for 3-5-6, 12-13, 1-14-15, 9-10, what has not arrived [skip ci]\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01C5Nj2aHp7d9xEM41j6obNp\n' > ../msg-u10.txt && git commit -q -F ../msg-u10.txt && git log -1 --format='%H %T %s' | cut -c1-120; git log -1 --format=%B | grep -c "\[skip ci\]"; git merge-base --is-ancestor origin/claude/gallant-ride-cunptv HEAD && echo fast-forward