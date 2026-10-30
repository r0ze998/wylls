# ⑯ 独立検証：使用した成果物の一覧（SHA・tree・補遺・パッチ順）

作成 2026-10-30。検証担当 ⑯。この一覧は「手元で実物を確認できたもの」と「照合候補として与えられたが実物が見つからなかったもの」を分ける。

## 1. 基点

| 項目 | 値 |
|---|---|
| 共通基準 commit | `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（"Document consolidated development handoff"、2026-10-29） |
| その tree | `fb0635892650f4ae2b028ec488d14ddb75fe5eeb` |
| 基点の親（GitHub `main`） | `921429322d5aecd1a3df0dd8d82c405c87dd985a` |
| 統合候補ブランチ先端 | `origin/integrate/claude-consolidation-20261029` = `a4fc78ca3bb056c0d531d414469666aa787c8a81`（基点 + 引き継ぎ文書の更新 1 commit。コードは基点と同一） |
| 検証作業ブランチ | `claude/dreamy-ramanujan-ijj8qj`（出発点 `92142932` = `main`。本検証の追加物はこのブランチのみに置き、push しない） |
| 基点と `main` のコード差 | なし（`4cd901de` は docs 2 ファイルのみ追加。`git diff 92142932 4cd901de --stat` 参照） |

## 2. 実物が確認できた成果物

| 担当 | 候補 SHA（指示） | 手元で確認した実物 | 備考 |
|---|---|---|---|
| ③ 外部接続・コンポーザビリティ | `acdcd0bf`（後続版の可能性あり） | `origin/claude/modest-goldberg-c180fk` = `2f8ec700fa7533d7fd61c87b5a84f31d05420325`（"Workstream 03: external program calls SendCaravan by CPI, local proof"、基点 `4cd901de` の直接の子） | `acdcd0bf` は origin のどの ref からも到達不能。`2f8ec700` を③の最新版として採用。`workstreams/03-composability/` 一式。パッチ案 0001–0004 は**未適用**のまま（③自身の宣言どおり） |

③のパッチ順（③の `patches/README.ja.md`）: 0001（LiteSVM ハーネスの読込量）→ 0002（検証器の inner instruction、方針のみ）→ 0003（relay、変更不要）→ 0004（コア側の限定委任、要求整理）。本検証では **いずれも適用していない**。

## 3. 実物が見つからなかった成果物

以下の SHA は、`origin` の全 80 ブランチ（`git fetch --unshallow` 後、745 commit）、ローカルファイルシステム（`*.bundle`, `*.patch`, `ADDENDUM*`, `workstream*`）、Google Drive（`wylls`/`ADDENDUM`/`workstream`/`bundle` の検索）、Remote Control で接続可能なフォルダ（0 件）のいずれにも存在しなかった。Gmail は再認証が必要で検索できなかった。

| 担当 | 候補 SHA | 状態 | 必要なファイルと理由 |
|---|---|---|---|
| ① | `f5a953ba094c0fa9b039217ba64c0ed566f60351` | 未取得 | bundle または patch 一式。倉（預け入れ）側の契約・テスト。流れ A の「自分の材料を他人の倉へ預ける」はこれが無いと基点の Vault（S1-1B）で代替検証するしかない |
| ② | （SHA 指定なし） | 未取得 | 権利ルール（Grant）の契約文書。③が「②の Grant 未受領」と明記しており、委任の限定をコアが保証するかはこれ次第 |
| ④ | `2e536b6b`（保存版）, `967ffc01`（統合候補） | 未取得 | 実行器（Rust）の bundle。「④の代役で通した試験」と「④の Rust コードを使った試験」の区別は、実物が無い以上すべて前者（基点の gateway runner を代役とした） |
| ⑤ | `29365e602e96e6b27eb327f1ed676f7abee7ef39` | 未取得 | 自動運転の最新版。基点の `permutation-gateway/src/frontier/agent/runner.mjs`（ruleDecider/llmDecider）で代替 |
| ⑥ | `517796dc` + r2 `ADDENDUM-20261030.ja.md` | 未取得（補遺も未取得） | 作成画面と補遺。補遺が優先とされるが実物なし |
| ⑦ | `3eb5168655b84dd3319536eb547eb071b1956f2d`（v4）, 適用済み候補 `63b84bd010b93f34980334412d2e5886f6d90188` | 未取得 | 事実・記録側（流れ C）。基点の herald/verify で代替 |
| ⑧ | （SHA 指定なし） | 未取得 | 関連契約 |
| ⑨ | `2c06249389f3c479fc8463bf540888e0e98a3dff` | 未取得 | 鉱石と木材から兵器（基点の S1 workshop/arms が原型） |
| ⑩ | `fe7b485b532863b5f638fb6eeaf6168c4e3e2ca3`, コア候補 `823bb71ddfb0c6e40acf8278e314d8d694abc3a2` | 未取得 | 加工（現在鉱石のみ）。「⑩の新処理を含むプログラムが旧 v3 のハッシュを名乗る」危険は、基点の RULESET_HASH/PROGRAM_VERSION の扱いで原理だけ検証 |
| ⑪ | `93f51b69f8ae5bf3012bdc858450e9a54bd7dd52` | 未取得 | 検証器の未知タグ対策。基点の verify の未知タグ挙動で原理だけ検証 |
| ⑫ | `b79b5a5a2ad15ea730325d22d41fd61f97e61e5a` | 未取得 | allocate（認証されていない発言での受理の危険）。基点に該当機能なし → 未実行 |
| ⑬ | `19d9f72e` | 未取得 | 住民。基点の `permutation-gateway/citizens/` で代替 |
| ⑭ | `bc949430973136e693739a9abe60a286196fc0cf` | 未取得 | 内容不明 |
| ⑮ | `f68f79bbb34862d43b4d70c31aa024e5c7e55433` | 未取得 | 共同目標への寄与。基点の `achievements.mjs`（contribution ledger）が最も近い |

**取得に必要なもの（まとめて）**: 各担当の `git bundle`（`git bundle create <担当>.bundle 4cd901de..<SHA>` で十分）か `git format-patch 4cd901de..<SHA>` の一式、⑥の `ADDENDUM-20261030.ja.md`、②⑧の契約文書。置き場所は GitHub の `r0ze998/wylls` にブランチとして push されたものが最も確実（本セッションは同 repo のみ読める）。

## 4. この検証で接続した実物

- 基点 `4cd901de` のコード（`main` と同一）: オンチェーン・プログラム（`permutation-frontier`、S1 隊商 0xB0–0xB6, 0xBE）、ABI（`frontier-abi`）、規則（`permutation-rules`）、keeper・herald・verify・findex（`frontier-node`）、relay/agent wallet/MCP/citizens（`permutation-gateway`）、Web client（`permutation-server/web/frontier`）。
- ③ `2f8ec700` の文書・courier・courier-tests・relay-check（**courier-tests は本環境では未実行**：`cargo-build-sbf`/Agave が無く、導入は禁止事項）。

## 5. 実行環境の制約（未実行の理由）

- `cargo-build-sbf`（Agave 3.1.9）なし → `permutation-frontier/svm-tests`（LiteSVM）、③ `courier-tests`、`frontier-node/crates/itest` の実チェーン試験は**未実行**。プログラム本体の挙動は Rust ソースの読解と、同じ規則カーネル（`permutation-rules`）・同じ ABI を使う消費側（keeper/herald/verify/web）の実行で裏取りした。
- Rust 1.89（ルート workspace）と 1.95（`frontier-node`、rustup で取得）、Node 22、LiteSVM なし。
- ネットワーク送信・push・deploy・有料 API は行っていない。
