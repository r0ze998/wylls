# NFT 参加パス：host build の再開から通常 world・英語画面の確認と片付けまで（手順書、2026-11-14）

branch `claude/nft-pass-mint-20261114`、worktree `/Users/r0ze/Projects/wylls-nft-pass-20261114`。**この手順の 1 以降はまだ一度も実行していない。** 実行した範囲と未実行の範囲は `CLAUDE-NFT-PASS-LOCAL-WORLD-20261114.md`（§4・§5b・§5c）。ローカルだけ。公開 chain・実ウォレット・実資金は使わない。

## 0. 始める前の条件（全部そろうまで始めない）

- 領土側の作業から「world の片付けが済んだ」連絡があり、**利用者から再開の許可**がある。
- `df -k /` の空きが **約 22.5 GiB 以上**、または領土側が world を起動しない時間枠である（領土側の開始 floor は 21 GiB）。
- 自分の validator・world が動いていない：`pgrep -fl 'solana-test-validator|frontier-(stack|localnet|keeper|herald)|mint-demo.mjs'` が空。
- 使う port が空いている：既定の base 41000 で 41010–41011・41020・41030・41033・41040・41050–41051・41070・41075・41090（mint ページ）。領土側の 41980–41999 とは重ならない。

## 1. host build の再開（約 0.5〜0.9 GiB 追加の見込み、推測）

```bash
/private/tmp/claude-501/-Users-r0ze-Projects-wylls-codex-wide-inventory-20261109/5cd7cb82-5815-4cc2-9f50-2ed5e48fa0c1/scratchpad/build-host.sh > /private/tmp/claude-501/-Users-r0ze-Projects-wylls-codex-wide-inventory-20261109/5cd7cb82-5815-4cc2-9f50-2ed5e48fa0c1/scratchpad/logs/build-host-2.log 2>&1
```

- script の sha256 `6a61b5876cc5e4287502c360a8c88473d5064cf512cac9eca3fd04f77fc97b3c`。実行前に確かめる。
- 中身：release、`--offline --locked`、`CARGO_INCREMENTAL=0`、debug 0、target は `frontier-node/target-nftpass`（自分だけ。git 管理外）。7 binary：`frontier-stack`・`frontier-localnet`・`drand-replay`・`frontier-keeper`・`frontier-herald`・`frontier-viewers`・`frontier-bots`。
- **guard**：空きが 20.85 GiB を下回ると止め、`target-nftpass` だけを消す（引き下げない）。部分 target（681 MB）を引き継ぐので、最初からではない。
- 終わったら、結果・残した大きさ・`df` を領土側に知らせる。

## 2. 7 binary と来歴だけを残し、自分の中間物を片付ける

```bash
cd /Users/r0ze/Projects/wylls-nft-pass-20261114
node permutation-nft-resident-spike/archive/host-bins.mjs keep frontier-node/target-nftpass/release frontier-node/nftpass-bin
node permutation-nft-resident-spike/archive/host-bins.mjs verify frontier-node/nftpass-bin
```

- `keep`：7 binary（合計 約 38 MB の見込み）を `frontier-node/nftpass-bin/` に写し、`PROVENANCE.json`（各 sha256・大きさ、source の commit、source が commit と一致していたこと、rustc・cargo の版、`frontier-node/Cargo.lock` の hash、build の flag）を書く。source が commit と違うと拒否する。
- `verify` が `OK` のときだけ、次で自分の target を消す（約 1.1〜1.5 GiB 戻る見込み）：

```bash
rm -rf /Users/r0ze/Projects/wylls-nft-pass-20261114/frontier-node/target-nftpass
```

自分が作った再生成できる物（消してよいのは**この表のものだけ**。他の worktree・cache・target には触れない）：

| 物 | 大きさ | 扱い |
|---|---|---|
| `frontier-node/target-nftpass/` | 681 MB（部分）→ build 後 1.1〜1.5 GiB 見込み | `keep` と `verify` の後に消す |
| `frontier-node/nftpass-bin/` | 約 38 MB 見込み | 残す（world の起動に使う）。source を変えたら作り直す |
| `permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so` | 1.4 MB | 残す（sha256 `0227dbe1…`） |
| `permutation-nft-resident-spike/program/target/deploy/wylls_resident_program.so` | 165 KB | 残す（`program-artifact.mjs status` が OK） |
| `permutation-nft-resident-spike/.local/programs/mpl_core.so` | 810 KB | 残す（sha256 `515541c8…`） |
| `permutation-gateway/screens/node_modules/` | 13 MB | 画面試験の後に消してよい（`npm ci` で戻る） |
| `$TMPDIR/wylls-localnet-*`・`wylls-localnet-accounts-*` | 各 5〜25 MB | 試験が止まると自動で消える。残っていたら自分の試験の残りなので消す |
| scratchpad の `logs/` | 数 MB | 記録用。session の終わりまで残す |

## 3. 起動前の確認

```bash
cd /Users/r0ze/Projects/wylls-nft-pass-20261114
node permutation-nft-resident-spike/archive/host-bins.mjs verify frontier-node/nftpass-bin
(cd permutation-nft-resident-spike && node archive/program-artifact.mjs status)
shasum -a 256 permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so permutation-nft-resident-spike/.local/programs/mpl_core.so
FRONTIER_BIN=frontier-node/nftpass-bin frontier-node/nftpass-bin/frontier-stack check-ports --base-port 41000
```

lane の `.so` が今の source の build であること（`proc/season.rs` や lane の Rust を変えたら `scripts/build-frontier-localnet-nft-sbf.sh` で作り直す）。

## 4. 通常 world の起動（AnnounceSeason → CreateSeason → keeper・herald・relay・mint ページ）

```bash
cd /Users/r0ze/Projects/wylls-nft-pass-20261114
FRONTIER_BIN=frontier-node/nftpass-bin frontier-node/nftpass-bin/frontier-stack up \
  --run-id nftpass-1 --base-port 41000 --nft-pass --conquest --beacon test-key \
  --bots 0 --viewers 0 --so permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so --keep-running
```

- foreground で動き続ける（専用の terminal で）。run の物は `frontier-node/.local/frontier/nftpass-1/`。
- 期待する順：localnet（Core・住民 program・lane を deploy）→ drand（test key）→ AnnounceSeason・CreateSeason（版 `S1|0x8000`）→ **pass の setup**（`logs/nft-setup.log`、run state の `nft_pass`）→ keeper → relay（`--mint-url http://127.0.0.1:41090/web/mint.html`）→ herald → **mint ページ**（41090）。
- 失敗したとき：`up` は自分で全 component を止める（`stop_all`、mint ページも含む）。それでも 7 の後片付けを行う。
- 容量：world の ledger と snapshot が増える。`df` を見続け、21 GiB を割りそうなら止める（領土側の floor）。

## 5. 英語画面での確認：発行 → 選択 → 参加 → 操作

テスト用の鍵を 2 つ（A と B）、その場で作る（使い回さない、記録しない）：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。

1. **同じ鍵を 2 つの画面に**（実ウォレットなら不要な手順。ゲーム画面の Dev Wallet と発行ページの試験ウォレットは別 origin の localStorage を使うため）：
   - ゲーム画面 `http://127.0.0.1:41040/frontier/` の devtools で `localStorage.setItem('ps-dev-wallet', '<A の hex>'); localStorage.setItem('ps-lang', 'en')`、再読込。
   - 発行ページ `http://127.0.0.1:41090/web/mint.html` で `localStorage.setItem('wylls-testwallet-seed', '<A の hex>')`、再読込。両方で同じアドレスが表示されること。
2. **パス未保有の表示**：ゲーム画面で Dev Wallet を接続 → 「Enter with a resident NFT」のカードに「This wallet holds no resident NFT (entry pass). Get one on the mint page, then join with it here.」と「Open the mint page」「I got one: check again」。リンク先が 41090 の発行ページ。
3. **発行**：発行ページで「TEST PRICE」の表示を確認 → `POST http://127.0.0.1:41090/mock/airdrop {address, lamports}` で test SOL → 接続 → mint → 「登録完了」。
4. **選択**：ゲーム画面で「I got one: check again」→ NFT の行が出る。国を選ぶ → 「Join with this NFT」→ ウォレットの署名（Dev Wallet は自動）→ 「Playing as an NFT」。
5. **操作**：NFT 住民として最初の行為（最初の村の配置など、画面が案内するもの）を 1 つ行い、成立することを確認。herald の `/h/me` がその NFT Citizen（asset の印）を返す。
6. **譲渡と拒否**：A から B へ TransferResident（発行ページに譲渡の画面は無いので、spike の `transferResidentIx` を Node から A の試験鍵で送る）。その後：
   - A の画面で行為 → 拒否（relay が `ResidentHolderChanged` か `ResidentGenerationStale` で費用を払わずに止める）。
   - B の鍵を別の browser profile のゲーム画面に入れる → 「Play this NFT」（参加済み）→ 行為が成立する。同じ Citizen であること。
   - B の profile で、パスを持たない鍵の場合は 2 の表示に戻ること。
7. 画面の記録は scratchpad に残し、公開しない。

自動化するなら：`permutation-gateway/screens` の固定 `playwright-core` で、上の localStorage の設定を `addInitScript` で入れる（spike の browser 試験と同じ方法）。

## 6. 片付け（毎回）

```bash
cd /Users/r0ze/Projects/wylls-nft-pass-20261114
FRONTIER_BIN=frontier-node/nftpass-bin frontier-node/nftpass-bin/frontier-stack down --run-id nftpass-1
pgrep -fl 'frontier-(stack|localnet|keeper|herald|bots|viewers)|drand-replay|mint-demo.mjs' || echo none
lsof -nP -iTCP:41000-41099 -sTCP:LISTEN || echo free
du -sh frontier-node/.local/frontier/nftpass-1
df -k /
```

- `down` は mint ページも止める（`stop_all`・`down` の順の最初の方）。
- run の directory（`frontier-node/.local/frontier/nftpass-1/`）は自分の試験の物。記録に要る物（`state.json`・`events`・`logs/nft-setup.log`）を scratchpad に写してから消す。`--nft-pass` の world は resume できない（拒否する）。
- browser の localStorage の試験鍵（`ps-dev-wallet`・`wylls-testwallet-seed`）を消す。
- 結果と `df` を領土側に知らせる。

## 7. 途中で止まったとき

| 状態 | すること |
|---|---|
| host build が watchdog で止まった | script が自分の target を消している。`df` を記録し、必要な追加容量を報告する。guard は下げない |
| `up` が setup で失敗（`nft pass setup failed` か 180 s の期限切れ） | `up` が全 component を止める。`logs/nft-setup.log` を読む。6 の確認をしてから run directory を片付ける |
| mint ページの port が 30 s で開かない | 同上（run は失敗として止まる） |
| 単体の `mint-demo.mjs --localnet` を使った | Ctrl-C か SIGTERM で validator と ledger が消える（`mint-demo-cleanup.test.mjs`）。残っていれば `pgrep -fl solana-test-validator` で自分の物だけ止める |
