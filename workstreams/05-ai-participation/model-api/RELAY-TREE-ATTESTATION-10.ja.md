# ⑤：relay の木の証明（probe の前提）の見直し（2026-11-08）

**判断ではありません。** D1・D3・D5・R はどれも決めていません。新しい route、自動運転の行動の拡大、本物の token、live の probe は、どれもしていません。

`VERIFIED_RELAY_TREES`（`src/access-check.mjs`）の1つの項目は、「その木そのもので、probe が gate で拒否され、hold・build・send に進まないことを読んで確かめた」という証明です。

- 項目は probe を有効にしません。有効にするのは、運用者の opt-in（`probe.enabled`）だけです。
- `agent_whoami` を持つ中継は、そちらの読むだけの確認で調べられ、probe は送られません。

## 1. 対象（GitHub から取り直して確かめた）

| 物 | 値 |
|---|---|
| ④の統合候補 | `claude/gallant-ride-cunptv` の `7535a17e135ff3b18f7ad1160599f1473b334794`。tree `1960174902f4e90ac61a004264954757a528cd1e`。ブランチの先端と一致 |
| その `permutation-gateway` | `52ccd7fc13daba4d2e4af111a65b644b4f0e8ae2` |
| ⑤の引渡し `e29ec011` の `permutation-gateway` | `477c5685ad2390c2b8a627936187f8f546423a0e` |
| 基準 `4cd901de` の `permutation-gateway` | `560f8659fdc091d6870c35539333acf59381acf8`（④の指摘のとおり。既存の項目の説明もそのとおり） |

## 2. 見たこと

- **`477c5685` と `52ccd7fc` の違い：** `permutation-gateway/src/` の中で違うファイルは**ありません**。違うのは次だけです。
  - 生成された ABI の表 7つ（`client/src/frontier/abi-*.mjs`）
  - `screens/`
  - `test/`
- **ABI の表：** 7つのうち 6つは、代理の財布の import の閉包に入ります（`abi-v2-logs` は入らない）。
  - 代理の財布が扱う 17 の名前（`AGENT_ACTIONS`・`NEVER_DELEGATED`・`SetSession`・`SendCaravan`）について、`ixOf(name, profile)` を profile 1 と 3 で比べました。違いは **0**。
  - `AGENT_ACTIONS`・`NEVER_DELEGATED`・`ACTION_GROUPS`・`SOURCES` も同じでした。
  - `SetSession` は、今も `NEVER_DELEGATED` に入っています。
- **probe の前提を、候補のコードで読み直しました**（⑤の 0005〜0007 で増えた所を含む）：
  - `submit`：parse → 認証（`BadCapability`）→ 冪等の照合 → Citizen の列 → `#run`
  - `#run`：資格の確かめ直し（`BadCapability` で拒否するだけ）→ `#gate` → **その後で** hold。どの拒否も hold の前で返ります
  - `#gate`：mode → 期限 → policy の版（厳密な一致）→ mode epoch（厳密な一致）→ `checkAllowed` → 村
  - `parseActionRequest`：`policyVersion` は正の整数、`modeEpoch` は 0 以上の整数で、上限はありません（probe の `MAX_SAFE_INTEGER` は通る）
  - policy の版は 1 から始まり、更新ごとに 1 ずつ増えます（`ledger.mjs`）。probe の版と一致することはありません
  - `checkAllowed` は、`NEVER_DELEGATED` を条件なしで拒否します
  - 拒否の記録は今までどおりです：冪等の記録が1件。履歴・hold・送信・請求はなし（請求の無い拒否は履歴に書かない）
- **新しい道：** `6984acfa` から後に `src/` で変わったのは⑤のパッチだけで、`submit` を新しく呼ぶ所も、鍵の束（keyring）を新しく使う所もありません。

## 3. 直したこと

- `VERIFIED_RELAY_TREES` に、見直した木を2つ足しました。どちらも subtree 全体の id で、説明付きです。削った物・範囲を狭めた物はありません。
  - `477c5685`：⑤の引渡し
  - `52ccd7fc`：④の候補
- 試験の pin（`test/relay-tree.mjs`）は、固定の値ではなく、**disk の上の `permutation-gateway` の木そのもの**にしました。
  - 理由：⑤のディレクトリは、⑤のブランチ（基準の gateway）でも④の統合（patch 済みの gateway）でも同じ中身なので、固定の値ではどちらかで必ず食い違います。
  - `relay-tree.test.mjs` が確かめること：
    - disk の木が、見直し済みの項目にあること
    - `RELAY_TREE` を指定したなら、それが disk の木と同じであること
    - 各項目が 40 桁の id で、説明があること
    - 手元にある commit の木が、証明した値と一致すること
  - 確かめ方は弱めていません：見直していない木では、試験は落ちます。

## 4. 試験（鍵の生成・導出・署名なし。厳しい mode のガード `P05_GUARD_DERIVE=1`）

| どこで | 結果 |
|---|---|
| ④の候補 `7535a17e`（⑤の直した3ファイルだけを重ねた） | relay-tree 2/2。⑤の全体：`runexec` なしで 55件通過・6件 skip、代わりの `runexec` で 61/61。gateway の鍵を使わない試験 13/13 |
| 同じ所に、見直していないファイルを1つ足した | relay-tree が落ちる（「not a reviewed relay tree」） |
| 同じ所で、`RELAY_TREE` を基準の木にした | relay-tree が落ちる（disk の木と違う） |
| ⑤のブランチ | ⑤の全体：`runexec` なしで 55件通過・6件 skip、代わりの `runexec` で 61/61 |

**ビルドの出どころ（正直に）：**
- ④の候補の `runexec` は、**ビルドしていません**。候補は 18 の新しい crate（`solana-address`・`curve25519-dalek` など）が要り、この環境に無いので、crates.io からの取得（環境の変更）が要ります。
- 代わりの物：`6984acfa` から offline でビルドした `runexec` を、④の候補の `clients/acts.mjs` と一緒に使いました。
- 代わりに使ってよい根拠：`acts.rs` と `clients/acts.mjs` は、`6984acfa` から候補まで変わっていません。`main.rs` で増えたのは run の受付だけです。ただし、これは候補のバイナリそのものではありません。

## 5. 提案と止めている物

- ④の候補の `runexec` で試すには、`cargo fetch --locked` で crate を取得する許可が要ります。
- probe を本物の中継に送ることは、していません（opt-in のまま）。
