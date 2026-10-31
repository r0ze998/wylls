# 共有コード向けの独立パッチ（未適用）

本ブランチでは**適用していない**。適用は ④（統合・実行基盤）の判断。各パッチの「確認した段階」を分けて書く：**適用確認**（`git apply --check -p1` がリポジトリ root で通る）、**実行した試験**（独立した作業コピーで実際に走らせた）、**未実施**。

| パッチ | 対象 | 内容 | 適用確認 | 実行した試験 | 未実施 |
|---|---|---|---|---|---|
| `01-relay-resident-holder-hook.patch` | `permutation-gateway/src/frontier/routes/relay.mjs` | 任意の `ctx.residents.mayAct({citizen, actor})` を、`requesterCitizen` と `sponsor()` の署名検査直後に挟む。未確認は `false` → `ResidentHolderChanged`（403）。`ctx.residents` が無ければ挙動不変 | 通る | **なし** | relay の既存テスト（`npm ci` が要る。環境導入は承認されていないため未実行）。実 gateway への接続 |
| `02-frontier-abi-citizen-v2-resident-fields.patch` | `frontier-abi/src/v2/layout/player.rs`、`frontier-abi/vectors/v2/layouts.json` | v2 Citizen の `RSV_348`（36 byte）を `RESIDENT_ASSET_TAG15`(15) `SESSION_SETTER_TAG15`(15) `RESIDENT_FLAGS`(1) `HOLDER_GEN`(4) `RSV_383`(1) に割る。定数 `RESIDENT_FLAG_BOUND`、`RESIDENT_TAG_DOMAIN`。**再生成した ABI ベクタ（layouts.json）を含む** | 通る | 独立した作業コピー（`git worktree`、detached、`7fc6bd7`）で適用 → `cargo run -p frontier-abi --bin abi-vectors`（17 ファイル書き出し）→ `cargo test -p frontier-abi`：**全部通る**（lib 87、addresses 2、contract 3（`vectors_are_fresh` 含む）、ほか 14/6/4/5/3）。host の rustc 1.89.0 | prologue の規則（別パッチ未作成）。`permutation-gateway/client/src/frontier/abi-v2-layouts.mjs`／`web/sdk/frontier/abi-v2-layouts.mjs` の再生成（`scripts/sync-web-sdk.mjs`）と、それを読む gateway テスト（`frontier-cq-sdk.test.mjs` 等）。LiteSVM（SBF ツール無し） |
| `03-agent-gateway-delegation-holder.patch` | `permutation-gateway/src/frontier/agent/gateway.mjs` | `#requireDelegation` に「agent の owner が asset の現保有者」を `ctx.residents.mayAct` で追加。譲渡後は `SessionNotDelegated` | 通る | **なし** | agent wallet の既存テスト（同上）。既存 gateway への接続 |
| `04-web-fsession-resident-holder.patch` | `permutation-server/web/frontier/fsession.mjs` | `matchesCitizen(session, citizen, now, resident?)` に第 4 引数。現保有者 ≠ 自分のウォレットなら `ResidentHolderChanged` | 通る | **なし** | `web-frontier-session.test.mjs`（同上）。⑦ の画面接続 |
| `05-ci-run-spike-tests.patch` | `.github/workflows/ci.yml` | browser-smoke ジョブの末尾で試作のテストとマニフェスト検証 | 通る | **なし**（CI は push しないと走らない） | — |

**v0.3 でも未実施のまま（一覧として残す）**：gateway/web 用の ABI 生成物（`permutation-gateway/client/src/frontier/abi-v2-layouts.mjs`、`permutation-server/web/sdk/frontier/abi-v2-layouts.mjs`）の再生成と、それを読む既存テスト（`frontier-cq-sdk.test.mjs`、`agent-wallet-*.test.mjs`、`web-frontier-session.test.mjs` ほか）。専用売買経路の命令（`List`/`Buy`/`TransferResident`）はパッチ化していない（試作のみ）。

**実施していないこと（明記）**：実 NFT（実 Core の mint・transfer・Permanent Delegate の CPI）、Frontier プログラムの prologue 変更、既存 gateway（relay・agent wallet）への接続、gateway/web の既存テストの実行、LiteSVM。これらは環境導入（`npm ci`、SBF ツール、実チェーン）が承認されていないため**未実行**で止めている。

## `ctx.residents` の契約（01・03 が呼ぶフック）

```js
// relay の context に任意で付ける。無ければ従来通り。
ctx.residents = {
  /** citizen: Citizen の address、actor: 署名した鍵（wallet か session 鍵）。
   *  true = actor は asset の現保有者、または現保有者が現在の世代で設定した未失効の session 鍵。
   *  読取が古い・失敗・asset が無い・collection 違い・世代不一致 → false（未確認は拒否）。 */
  async mayAct({ citizen, actor }) { … },
};
```

試作の対応物は `src/registry.mjs` の `holderNow` と `src/mock-chain.mjs` の `prologue`。実装時は Citizen → asset の対応（`RESIDENT_ASSET_TAG15`、または住民 Citizen の address 派生）と、RPC の commitment／`StaleRead` 基準（UNDECIDED U14）を決める。

## 02 に続けて必要になるもの（パッチに含めていない）

1. prologue の規則変更（`frontier-abi/src/prologue.rs` の `player_prologue`、`permutation-frontier/src/proc/citizen.rs` の `player`・`set_session`、新命令 `TransferResident`）：INTEGRATION-04 §2 の 1〜5、CONTRACT §10 の D。asset アカウントを命令の口座列に追加する分、`permutation-frontier/src/prologue.rs` の口座仕様（`Spec`）と `client/src/frontier/shapes.mjs` の shape 許可表も変わる。
2. `abi-v2-layouts.mjs` の再生成（`scripts/sync-web-sdk.mjs`）。
3. LiteSVM テスト（`permutation-frontier/svm-tests`）。
4. verifier（⑯、`frontier-node/crates/verify`）の actor 検査に asset の owner／setter／世代を加える。
