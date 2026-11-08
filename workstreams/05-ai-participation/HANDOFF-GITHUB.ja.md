# ⑤の成果を GitHub から取る（③・④・⑬ 向け、2026-11-08）

push の後は、包み（bundle）が無くても、GitHub だけで再現できます。

## 1. ブランチ

| ブランチ | 中身 | 先端 |
|---|---|---|
| `claude/ai-participation-provider-budget` | ⑤の作業。`9a4051c79de6c5fba3c86bd515c67f3ec311b5ab`（tree `1ecc8c5c606f1a881137f3d10dc29836af33636f`）と、この文書のコミット（`[skip ci]`） | この文書のコミット |
| `claude/ai-participation-shared-on-ws04-6984acfa` | ④ `6984acfa4c0f9919c8c424a9bd5f2d59193d1639` に、⑤の共有パッチ 0002c・0003・0004b・0005・0006・0007 を `git am` した物。先端は、ファイルを変えない空のコミット（`[skip ci]`） | `e29ec011f99761594c59a6e4b0c4681c5938d443`。`permutation-gateway` の木は `477c5685ad2390c2b8a627936187f8f546423a0e` |

前提の commit は、どれも GitHub にあります。
- ⑤の基準：`45cba41e57341c61a3b2999ce33cec1fd425065b`（`preserve/ws05-provider-budget-45cba41e`）。⑤のブランチの祖先です。
- ④：`6984acfa4c0f9919c8c424a9bd5f2d59193d1639`（`claude/gallant-ride-cunptv` の履歴の中）。引渡しブランチの祖先です。
- ③：③の最新は `claude/modest-goldberg-c180fk` の `84f710d52d4eb5fee02084fb5a04378516fe4cc1`（③の報告。⑤はまだ実行していない）。

## 2. 取り方

⑤：

    git fetch origin claude/ai-participation-provider-budget
    git rev-parse 9a4051c79de6c5fba3c86bd515c67f3ec311b5ab^{tree}      # 1ecc8c5c606f1a881137f3d10dc29836af33636f
    git checkout --detach 9a4051c79de6c5fba3c86bd515c67f3ec311b5ab

④の木に⑤の共有パッチを当てた物（どちらの方法でも、同じ木になる）：

    # A. 引渡しブランチ
    git fetch origin claude/ai-participation-shared-on-ws04-6984acfa
    git rev-parse FETCH_HEAD:permutation-gateway                       # 477c5685ad2390c2b8a627936187f8f546423a0e

    # B. ⑤のブランチの patch を自分で当てる
    git fetch origin claude/gallant-ride-cunptv claude/ai-participation-provider-budget
    git checkout --detach 6984acfa4c0f9919c8c424a9bd5f2d59193d1639
    git am <⑤の木>/workstreams/05-ai-participation/patches/on-ws04-6984acfa/*.patch
    git rev-parse HEAD:permutation-gateway                             # 477c5685ad2390c2b8a627936187f8f546423a0e

③への同意の提案（③が判断する。acdcd0bf に当たる。③は `84f710d5` で⑤の契約に合わせ済みと報告している）：
`workstreams/05-ai-participation/patches/for-ws03-acdcd0bf/`

## 3. 共有パッチの中身

| パッチ | 中身 |
|---|---|
| 0002c | 同じバイト列になった時の作り直し（seq を持つ命令は除く） |
| 0003 | MCP の `source`（idempotencyKey は `${source}:${requestId}`） |
| 0004b | `agent_whoami`（読むだけ） |
| 0005 | 送り手ごとの capability（`rotate-capability`・`revoke-capability` の `params.source`、whoami の `capabilitySource`、view の `senderCapabilities`）。SendCaravan は作り直さない |
| 0006 | Citizen ごとの送信の列。SendCaravan の Duplicate は `failed`・`sent: null` で、前の送信の署名を付ける（送っていないことの証明にしない） |
| 0007 | 撤回・更新の後は、待っていた要求も送らない。一般の token の撤回（`source: 'any'`）。NFT の譲渡の後の拒否は、④の住民の確認による |

詳しくは `model-api/CONNECT-6.ja.md`〜`CONNECT-8.ja.md` にあります。

## 4. 試験（鍵の生成・導出（PDA を含む）・署名を伴わない）

**必ず⑤のガードを付けてください。** `NODE_OPTIONS` で付けると、子プロセスにも効きます。ガードは、鍵の関数・PDA と seed 付きアドレスの導出・署名を、呼ぶと例外にします。

⑤：

    cd workstreams/05-ai-participation/model-api
    G=$PWD/test/no-keys-guard.mjs
    NODE_OPTIONS="--import $G" node --test test/no-keys-guard.test.mjs test/model-api.test.mjs test/http.test.mjs \
      test/relay-tree.test.mjs test/multiprocess.test.mjs test/longrun.test.mjs test/acts-fate.test.mjs \
      test/acts-port.test.mjs test/acts-runexec.test.mjs test/safety-e2e.test.mjs test/ws13-stop.test.mjs

- ⑤の記録：54件通過、6件 skip。
- skip の6件は、④の実物の登録簿を渡した時だけ動きます：`RUNEXEC_BIN=<④の runexec>`、`FOUR_ACTS_CLIENT=<④の clients/acts.mjs>`。渡した時は 60/60 でした。
- 中継の依存（`permutation-gateway/node_modules`）が要ります。

④の木（引渡しブランチ）で：

    cd permutation-gateway
    NODE_OPTIONS="--import <⑤の木の絶対パス>/workstreams/05-ai-participation/model-api/test/no-keys-guard.mjs" \
      node --test test/agent-wallet-revoke-transfer.test.mjs test/agent-wallet-citizen-lane.test.mjs \
      test/agent-wallet-sender-capability.test.mjs test/agent-wallet-run-facts.test.mjs      # ⑤の記録：13/13

`npm test` は実行しないでください（中継の既存の試験の多くは、鍵を作ります）。

## 5. CI

- `.github/workflows/ci.yml` は、どのブランチの push でも動き、鍵を作る試験を含みます。
- このため、どちらのブランチも、先端のコミットのメッセージに `[skip ci]` を入れました。
- 同じブランチに続けて push する時も、先端に `[skip ci]` を入れてください。
