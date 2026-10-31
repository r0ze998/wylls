# 共有コード向けの独立パッチ（未適用）

本ブランチでは**適用していない**。各パッチは `git apply --check -p1` をリポジトリ root で通ることを確認済み（2026-10-31、`main` 由来の `claude/funny-wozniak-cy4n64` HEAD 上）。適用順は任意。適用は ④（統合先）の判断。

| パッチ | 対象 | 内容 | 確認したこと |
|---|---|---|---|
| `01-relay-resident-holder-hook.patch` | `permutation-gateway/src/frontier/routes/relay.mjs` | `ctx.residents`（任意）の `mayAct({citizen, actor})` を、`requesterCitizen`（settle の請求者）と `sponsor()`（プレイヤー命令の authority）の署名検査の直後に挟む。読取が古い／失敗なら `false` を返す実装とし、`ResidentHolderChanged`（403）で拒否。`ctx.residents` が無ければ挙動不変 | `git apply --check`。relay のテストは未実行（gateway の `npm ci` を本環境で行っていない） |
| `02-frontier-abi-citizen-v2-resident-fields.patch` | `frontier-abi/src/v2/layout/player.rs` | v2 Citizen の `RSV_348`（36 byte）を `RESIDENT_ASSET_TAG15`(15) `SESSION_SETTER_TAG15`(15) `RESIDENT_FLAGS`(1) `RSV_379`(5) に割る。定数 `RESIDENT_FLAG_BOUND`、`RESIDENT_TAG_DOMAIN` | 一時適用して `cargo check -p frontier-abi` と `cargo test -p frontier-abi`（host）を実行し、元に戻した。結果は本 README 末尾 |
| `03-agent-gateway-delegation-holder.patch` | `permutation-gateway/src/frontier/agent/gateway.mjs` | `#requireDelegation` に「agent の owner が asset の現保有者であること」を `ctx.residents.mayAct` で追加。譲渡後は `SessionNotDelegated` で何も hold・署名しない | `git apply --check` |
| `04-web-fsession-resident-holder.patch` | `permutation-server/web/frontier/fsession.mjs` | `matchesCitizen(session, citizen, now, resident?)` に第 4 引数を足し、現保有者が自分のウォレットでなければ `ResidentHolderChanged` を返す（「鍵を作り直す」案内を出さない）。既存呼び出しは不変 | `git apply --check`。`web-frontier-session.test.mjs` は未実行 |
| `05-ci-run-spike-tests.patch` | `.github/workflows/ci.yml` | browser-smoke ジョブの末尾で試作のテストとマニフェスト検証を実行 | `git apply --check` |

## `ctx.residents` の契約（01・03 が呼ぶフック）

```js
// relay の context に任意で付ける。無ければ従来通り。
ctx.residents = {
  /** citizen: Citizen の address、actor: 署名した鍵（wallet か session 鍵）。
   *  true = actor は asset の現保有者、または現保有者が設定した未失効の session 鍵。
   *  読取が古い・失敗・asset が無い・collection 違い → false（未確認は拒否）。 */
  async mayAct({ citizen, actor }) { … },
};
```

試作の対応物は `src/registry.mjs` の `holderNow` と `src/mock-chain.mjs` の `prologue`。実装時は Citizen → asset の対応（`RESIDENT_ASSET_TAG15`、または住民 Citizen の address 派生）と、RPC の commitment／`StaleRead` 基準（UNDECIDED U14）を決める。

## 02 に続けて必要になるもの（パッチに含めていない）

1. prologue の規則変更（`frontier-abi/src/prologue.rs` の `player_prologue`、`permutation-frontier/src/proc/citizen.rs` の `player` と `set_session`）：INTEGRATION-04 §2 の 1〜4。asset アカウントを命令の口座列に追加する分、`permutation-frontier/src/prologue.rs` の口座仕様（`Spec`）と `client/src/frontier/shapes.mjs` の shape 許可表も変わる。
2. `permutation-gateway/client/src/frontier/abi-v2-layouts.mjs` の再生成（`scripts/sync-web-sdk.mjs`）と、ABI ベクタの更新。
3. LiteSVM テスト（`permutation-frontier/svm-tests`）：本環境には SBF ツール（`cargo-build-sbf` 3.1.9）が無く未実行。
4. verifier（`frontier-node/crates/verify`）の actor 検査に asset の owner／setter を加える。

## 02 の確認結果（2026-10-31、host の rustc 1.89.0、一時適用の後に元へ戻した）

| コマンド | 結果 |
|---|---|
| `cargo check -p frontier-abi` | 通る |
| `cargo test -p frontier-abi --lib` | 87 passed |
| `cargo test -p frontier-abi`（統合テスト込み） | `tests/contract.rs::vectors_are_fresh` が **FAILED**：レイアウトを変えたので、コミット済みの ABI ベクタが古い。適用時は `cargo run -p frontier-abi --bin abi-vectors` でベクタを書き直し、`-- --check` で確認する（`frontier-abi/Cargo.toml:13`）。他は通る（addresses 2 passed、contract の残り 2 passed） |
| LiteSVM（`permutation-frontier/svm-tests/run.sh`） | 未実行（SBF ツール無し） |

つまり 02 は「レイアウト定数の追加として正しく、ベクタの再生成を伴う」。prologue の規則は含まない（上の 1）。
