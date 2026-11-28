# ⑥ creation — chain link: implementation plan + first local slice (2026-11-29)

> **要約（日本語）。** ⑥（住人が仕組みを作り、公開し、他の人が使い直す）の「チェーンにつなぐ」とは、**公開の記録（誰が・どの名前の・どの版を・どの内容ハッシュで公開し、今どの状態か）をチェーンの口座に置くこと**です。定義の JSON そのものはチェーンに置かず、ハッシュだけを置きます。実行（荷車など）は今ある命令を使うので新しい命令は要りませんが、④ の送信（Q4、r0ze さん待ち）が先に要ります。
> 公開の記録には **program の変更**（命令 1 つ、口座 2 種、記録 2 種、版のビット 1 つ）が要るので、r0ze さんの OK と world 4 の範囲の判断が要ります（⑪(b) の Q-11B-1 と同じ扱い）。
> 今回の PR は **ローカルだけ**：計画した口座と同じ byte の形の記録を、ブラウザ（と試験）の中の「チェーンの代わり」に書き、⑥ の試作ページがそれを読み戻して一覧と照らし合わせます。**旗（`?chainlink=1`）は既定で無効**。program・devnet・鍵・SOL は一切触っていません。未決定の点は `inbox/2026-11-29-0203-item6-questions.md`（Q-6CL-1〜7）。

Code wins over this document. Base: `origin/main` `e3b7055d5`.

## 0. Status before this PR (code, not docs)

- ⑥ is a JS prototype in `workstreams/06-creation/` (manifest format, validator, local registry, adoption book, mock execution, journal-based dispatch to ③/④). Nothing outside `workstreams/` imports it; the game page (`permutation-server/web`), herald, keeper and verifier know nothing of it.
- Last ⑥ code change: #111 (2026-11-20). CI: `creation06` job (Node 20/22, key-free subset: 15 files, 110 tests before this PR).
- Owner decisions that bind ⑥: **Q6-1 = A** (chain link after the first playable devnet, together with ⑪(b)) — devnet world 3 is live, so this is unblocked. **⑪(b) Q-11B-1 = A** (world-4 upgrade, Lock/Release only) and **Q-11B-2 = A** (no Burn). ② = A (StockSwap → Vault, wallet-only issuance). Q6-2 (bundles), Q6-3 (day boundary), Q6-4 (who stops), Q6-5 (old plans as rev 1) were recommended in `reports/plan-6-9-10-12-16.md` but **never answered** (no owner line in STATE.md or inbox).

## 1. What "chain link" means for ⑥

⑥ has five kinds of record. Each one either gets an on-chain account, stays off chain, or waits on another item:

| ⑥ record | today (code) | chain link | needs |
|---|---|---|---|
| **Publication**: author, name, version, content hash, `derivedFrom`, status (listed / suspended / withdrawn) + status sequence | `src/registry.mjs` (memory / localStorage), envelopes signed with demo Ed25519 seeds | **yes — this plan**: two accounts (entry per author+name, one immutable account per version), the manifest JSON off chain, its SHA-256 on chain | program change (§3) → r0ze OK + world-4 scope |
| **Adoption** (a user pins a plan to version + hash; supersedes; end) | `src/adoption.mjs` (mock) | **later, maybe never on chain**: an adoption changes nothing the program owns; ④'s run service can keep it | Q6-3 / Q4; not in world-4 v1 (recommendation) |
| **Run request** (signed, nonce, day; runs-per-day limit) | `src/execute.mjs`, `requestRun` (mock) | **not as a ⑥ instruction**: runs are existing instructions (caravans, ② swaps) sent by ④'s runexec; a per-definition per-day count is not enforceable by the program (ADDENDUM §1 layer 3) | ④ sending (Q4, blocked on r0ze), Q6-3 |
| **Receipts / evidence** (C: "consume a confirmed result") | `src/ledger.mjs` (mock) | the evidence is the program's own log of the existing instruction (caravan arrival, swap) read by herald/④ — no new account | ④ read port of arrival settlements |
| **Bundles** (one-shot right reserving delivered goods) | `world.batches` (mock) | **no** (Q6-2 recommendation A: no new core kind; use evidence + atomic stock consumption) | Q6-2 (unanswered) |
| **New world effects** (⑥ class D) | refused by the validator | that is ⑪(b) (declarative effects), already decided for world 4 | ⑪(b) slices 2–5 |

So the **first** on-chain piece is the publication record. It is independent of ④ and of ⑪(b): a published definition can be listed, pinned, verified and forked by reference without anything running. Execution comes second and is gated by ④ (Q4).

### What the record buys (why at all)

- **Authorship without demo keys.** On chain, the author's wallet signs the transaction; the program checks `signer == author`. The prototype's own Ed25519 envelope signature becomes unnecessary for readers (they trust the chain for "who", and the content hash for "what").
- **Tamper-evident catalog.** Today the list lives in one browser's localStorage (`docs/07` §3: "台帳・世界・採用の記録そのものの改ざん — 防げない"). With the commitment on chain, any catalog server (herald) can serve the JSON and any reader checks it against the on-chain hash.
- **Versions are immutable by construction** (one account per version, created once) and **status changes are not replayable** (sequence in the entry) — the same rules `registry.mjs` enforces locally.
- It also fixes ⑪'s observation J2 (`11-creation-boundary.ja.md` §5.1): status-change signatures are not in the registry export; on chain the transaction *is* the signature.

## 2. Prior art (GitHub) — four ways to put a published artefact on chain

| approach | example | what is on chain | fit for ⑥ |
|---|---|---|---|
| raw record under an authority | SPL Record — https://github.com/solana-program/record (`RecordData { version, authority }` + raw bytes) | the whole payload | ✗ a ⑥ manifest is 1.5–2.9 KB of JSON (`fixtures/ok/`); rent ≈ 0.012–0.021 SOL per version, and the program would have to validate JSON |
| small fields + off-chain URI | Metaplex Token Metadata — https://github.com/metaplex-foundation/mpl-token-metadata (name, symbol, `uri`) | a pointer; content not hash-bound by default | △ pointer without commitment: the JSON can change under the same URI |
| PDA per (authority, target) holding a commitment | OtterSec verified builds — https://github.com/otter-sec/otter-verify (`seeds = [PDA_SEED, authority, program]` → `BuildParams { commit, … }`) | a commit hash + metadata, updatable in place by the signer | ◎ for the entry (status, newest); in-place update is wrong for versions |
| immutable name@version → content hash | EthPM — https://github.com/ethpm/ethpm-spec (registry: name + version → content-addressed manifest URI) | name, version, content hash; versions never rewritten | ◎ for versions |

**Chosen:** EthPM's immutable `name@version → content hash` for version accounts + otter-verify's "PDA per author/target, signer = author" for the entry; the JSON stays off chain (Metaplex-style), but bound by hash (unlike Metaplex). This is also exactly what `registry.mjs` already does in memory, so no ⑥ semantics change.

## 3. The planned on-chain shape (proposal; needs r0ze OK + world-4 scope)

Accounts follow the v2 conventions of `frontier-abi` (8-byte magic, season id u64, layout version u16, little-endian; cf. the Grant layout in `frontier-abi/src/v2/rights.rs`), with-seed addresses of the world's Season PDA (`tag ‖ hex(15 raw bytes)` ≤ 32 chars).

**CreationEntry** `PSF6CENT`, seed `ce`‖hex(sha256("wylls.creation.entry/1" ‖ author ‖ name)[0..15]), 176 B (rent-exempt 2,115,840 lamports):

| off | field | |
|---|---|---|
| 0 | magic `PSF6CENT` | |
| 8 | season_id u64 | the world |
| 16 | layout version u16 = 1 | |
| 18 | status u8 | 0 listed, 1 suspended, 2 withdrawn |
| 19 | name_len u8, 20 name [40] | `[a-z0-9][a-z0-9-]{2,39}` |
| 60 | status_seq u32 | = registry `statusLog.length` (publishes + status changes) |
| 64 | author [32] | the wallet that must sign |
| 96 | version_count u32 | |
| 100 | newest major/minor/patch u32 ×3 | |
| 112 | newest content hash [32] | |
| 144 | created_slot u64, 152 status_slot u64 | |
| 160 | status_day u32 | Q6-3 decides what a "day" is (bell-day recommended) |
| 164 | reserved [12] | zero |

**CreationVersion** `PSF6CVER`, seed `cv`‖hex(sha256("wylls.creation.version/1" ‖ entry hash (all 32 bytes) ‖ major ‖ minor ‖ patch as u32 LE)[0..15]), 192 B (rent-exempt 2,227,200 lamports), written once:

| off | field | |
|---|---|---|
| 0 | magic `PSF6CVER` | |
| 8 | season_id u64 | |
| 16 | layout version u16 = 1 | |
| 18 | name_len u8 | |
| 19 | flags u8 | bit 0 = derived_from set; other bits zero |
| 20 | major / minor / patch u32 ×3 | |
| 32 | author [32] | |
| 64 | name [40] | zero padded |
| 104 | **content hash** [32] | SHA-256 of ⑥'s canonical JSON (`src/canonical.mjs`) |
| 136 | derived_from content hash [32] | zero unless flag bit 0 |
| 168 | published_slot u64, 176 published_day u32 | |
| 180 | reserved [12] | zero |

(verify-pr329: the first draft's version seed was `cv`‖hex(entry hash[0..3] ‖ major ‖ minor ‖ patch). Only 24 bits named the entry, so anyone could grind a name of their own whose 3 bytes match a victim's (about 2^24 hashes, 100 s in Node) and take the victim's version accounts first. That attack was shown in the stand-in. All 32 bytes are now hashed and 120 bits kept.)

**Instruction** (one tag, sub-op byte): `CreationRecord` — `0 Publish { name, version, content_hash, derived_from? }`, `1 SetStatus { name, status, seq }`. Program checks only what it owns: signer = author, version account absent, version > entry newest, seq = entry status_seq. Definition validation, dependencies and bump size stay off chain (the program cannot parse ⑥ JSON, and must not).

**Number space** (`frontier-abi/src/feature_registry.rs`, rev 8): only **one** instruction tag is free (`0xEF`); ⑪'s Ext band 0xE8–0xED is fully planned. Proposal: tag `0xEF` with a sub-op byte (Q-6CL-2 B is the alternative: share ⑪'s registry instructions). Records: 120 `CREATION_PUBLISHED`, 121 `CREATION_STATUS` (free 120–129). AccountKind 33/34 (after Nft 31–32). Errors 180–185 (free 180–199). Version bit `0x0100` (⑪ proposed `0x0200`). None of this is allocated yet.

**Who sees it how:**

- **page**: reads entries/versions (getProgramAccounts by magic, or the herald's list), fetches each manifest JSON from the catalog, accepts it only if `contentHash(manifest)` = on-chain hash (`matchEnvelope`), shows chain-vs-catalog disagreements instead of hiding them (`crossCheck`).
- **herald**: indexes the two records from the program log (`CREATION_PUBLISHED`, `CREATION_STATUS`) into a catalog; stores and serves the JSON by hash (where the JSON lives = Q-6CL-3).
- **verifier (⑯)**: the records move no resources, so VX/VG replay is unaffected; a native rule set ("C1 signer = author; C2 versions written once and increasing; C3 status seq +1 per change") can be checked from the log alone. Not part of this slice.
- **④ runexec / ③ MCP**: resolve a plan's `{author, name, version, hash}` against the chain instead of a local registry before sending existing instructions (after Q4).

## 4. What needs a program change vs what can be done now

| piece | program change? | status |
|---|---|---|
| account layouts, seeds, encode/decode, local stand-in, read-back, page panel, flag | no | **this PR (slice 1)** |
| Rust mirror of the layout in `frontier-abi` (behind a new `creation-experimental` feature, test-only) + parity test vs the JS bytes | no (ABI crate only, not routed by the program) | slice 2 (local, no OK needed) |
| herald index + JSON-by-hash store, page reading herald (local `play-local` only) | no | slice 3 (local) |
| verifier native rules C1–C3 from the log | no | slice 4 (local) |
| `CreationRecord` handler on `0xEF`, accounts, errors, records, version bit, in a **localnet-only lane** | **yes** | slice 5 — **needs r0ze OK + world-4 scope (Q-6CL-1)** |
| devnet world 4 | yes | upgrade + new world; r0ze's confirmation, SOL |
| adoption / run requests on chain | yes (if ever) | not planned for world 4 (Q-6CL-5) |
| execution of ⑥ plans in the game | no new instruction; needs ④ sending (Q4) | blocked on r0ze (Q4) |

## 5. Slice 1 (this PR) — local, behind a flag, off by default

- `src/chainlink/record.mjs` — the two layouts (byte-exact, pinned offsets), seeds, local addresses (`local:<seed>`; the real address needs the Season PDA and program id), rent.
- `src/chainlink/localchain.mjs` — `LocalChain`: `publish`/`setStatus` with the program's own checks (signer = author, write-once versions, newer versions, current sequence), a log of `CREATION_PUBLISHED`/`CREATION_STATUS` records, plain-JSON state; one slot per accepted call. A refused call writes nothing.
- `src/chainlink/linked.mjs` — `LinkedRegistry`: with a chain, the off-chain registry decides first (on a clone), then the "transaction" lands in both or in neither; without a chain, a pass-through. It does **not** import `registry.mjs`, so no existing key-free review digest changed.
- `src/chainlink/catalog.mjs` — `readCatalog`, `matchEnvelope`, `crossCheck` (what page/herald do).
- `src/chainlink/flag.mjs` — on only for exactly `"1"`: `WYLLS_CREATION_CHAINLINK` (Node), `?chainlink=1` or localStorage `wylls.creation.chainlink` (page). No Node caller uses the env flag yet.
- `proto/app.mjs`, `proto/index.html` — with the flag, publish and status changes go through `LinkedRegistry` (signer = current person's public key), the 「世界と台帳」 tab shows 「チェーンの記録（ローカルの模擬・world 4 の案）」 and the cross-check; the chain state is kept under its own localStorage key. Flag off: same calls, same stored JSON, the box stays hidden.
- Tests: `test/chainlink-record.test.mjs` (11, key-free), `test/chainlink-registry.test.mjs` (6, real Registry with envelopes **pre-signed** by `cli/chainlink-fixture.mjs` into `fixtures/chainlink/signed.json`; verification only; key-free CI via a reviewed closure entry). `proto/e2e-chainlink.mjs <port>` (Playwright, local only): 14 checks, flag off and on.

## 6. Risks

- The layout is a proposal; slice 2 must pin the Rust side to the same bytes before any program work.
- `status_day` depends on Q6-3 (undecided); the field is there, its meaning is not.
- The local "signer" is stated by the caller (nothing is signed): the stand-in shows the rules, not their security.
- One free tag left (`0xEF`): if ⑥ takes it, the next feature needs a new tag-space decision (two-byte tags or sub-ops).
