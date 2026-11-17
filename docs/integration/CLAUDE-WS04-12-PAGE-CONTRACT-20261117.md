# ④ observe page → ⑫ held report: one shared page, a test on each side (2026-11-17)

**Branch:** `claude/ws04-12-page-contract-20261117`, on the aggregate `claude/aggregate-approved-20261117` at `180dfb55`, which carries the 22-path observe unit. The aggregate ref is Lane D's and is not changed here.

**Source only, NOT run:**
- no `cargo`, `node --test`, import, CLI run, world, RPC, key or signing;
- no earlier approval reused;
- the fixture's two body hashes were computed by hand from the PS2 layout (one Python `hashlib` call over bytes built from `frontier_abi::v2::log`'s field list); ④'s test is what checks them.

## What was missing

- **The two sides were each tested against their own hand-written page.**
  - ④'s `store_observation.rs` checks single fields of its page.
  - ⑫'s `ws04-observation.test.mjs` and `ws04-observe-cli.test.mjs` feed pages written to the serde shape by hand.
- **Nothing tied one page to both sides:** what ④ actually prints and what ⑫ accepts could drift apart with every test still green.

## The unit (4 paths, all `100644`, all new)

| Path | What it is |
|---|---|
| `workstreams/04-execution/tests/fixtures/observe-page-contract.json` | **the page**, owned by the producer: two rows from a synthetic store (one `caravan_settled`, one `caravan_raided`), the manifest's one epoch, and the store facts |
| `workstreams/04-execution/tests/observe_page_contract.rs` | **④:** builds that store and requires `read_store_observations` to give exactly that page. It checks field by field (so a difference names its place), then `store`, then the whole page, then the compact line `main.rs` prints. |
| `workstreams/12-memory/test/ws04-page-contract.test.mjs` | **⑫ and ⑬:** read the same file as runexec's stdout. 12's report has no finding of its own and every reason of 4's, verbatim. `observe-canonical` reads it in store mode with fakes only. |
| `docs/integration/CLAUDE-WS04-12-PAGE-CONTRACT-20261117.md` | this report |

**What the page carries on purpose:**
- **u64:** the owner tag `u64::MAX` and a raider of 2^63 + 5. ⑫ must keep both exact (`parseJsonU64` gives `'18446744073709551615'` and `'9223372036854775813'`).
- **Holds:** every hold. The page has 5 reasons (3 of the reader's own and 2 of the store's); each row has 4. They are compared verbatim, so none can be dropped or renamed on either side.
- **Basis:** `basis: unproven`, and `world`, `finality` and `complete` null.
- **The slot:** each row's event slot is its transaction's.
- **The store facts are mutually consistent:** `index_last_seq` 2, `next_seq` 3, stable, `index_matches_manifest`.
- **Epochs:** every row has a covering epoch whose `endpoint` and `genesis_hash` are **not** carried.

**How the store is built (④'s test):**
- the same columns, markers and manifest keys as the existing `store_observation.rs` helper, and as findex writes them;
- bodies built through `frontier_abi::v2::log::field` by name, with no hand offsets;
- lengths 68 and 99 asserted, the lengths the fixture's hashes were computed for.

## Counter-review (static, once)

**The page through ⑫'s adapter (`a7cd14b6` blob `a78ece45`), by hand:**
- every format, held and shape check passes;
- `storeAgrees` holds (stable; 2 + 1 = 3, so `index_matches_manifest`);
- each `archive_epoch` is placed (`from_seq` 1 ≤ seq, below `next_seq`, `covered_by_epoch`);
- each event slot equals its transaction slot;
- `credited` is null.

So the expected `why` is `[]` for the page and each row. **No product mismatch was found, so no product change.**

**The command (`observe-canonical`):**
- the herald fake answers 503, so `readStore` and `rpc` are never reached;
- the page's mode is the requested one (`ws04Read` has no `why`);
- the exit stays 2 (the herald part decides it).

**Rust:**
- payload slices are written as explicit `[..]`, so no coercion is relied on;
- `include_str!` reads inside ④'s own tree, so the run extraction of ④ (`rust-toolchain.toml`, `workstreams/04-execution`, `frontier-abi`, `permutation-rules`) contains it;
- cargo does not treat `tests/fixtures/` as a test target.

**Nothing is promoted:**
- no receipt, fact, coverage, basis, id or `complete` is made;
- the page is synthetic, and both tests say so.

## Running them later (each needs its own pre-run evidence and approval)

**④:** `--test observe_page_contract`, under the same guards as the observe plan (`f9e1f358` §3), with two more pins: this test and the fixture. Whether it runs under `floor21.sh` → `conquest-guard.sh` unchanged is the owner's choice; the plans so far are not approved.

**⑫:**
- one more file in the extraction: the fixture, read as text;
- the same closure as `ws04-observe-cli.test.mjs` (it imports 12's adapter and `ws04-receipts`, and 13's `observe-canonical`);
- Node 22 or later (reviver source text).

**Not one of the refused runs:** no world, runner, walls-items, muster, ⑬ guard, G or H, and no split or alternative of one. The ⑬ guard is not involved; 12's `nokey-guard.mjs` is the guard.

## Hand-over (Lane D)

- **Unit:** `claude/ws04-12-page-contract-20261117` on `180dfb55`, the four paths above, all added.
- **No path the aggregate has is changed.** Nothing else of ④, ⑫ or ⑬ is touched. Lane C's world providers and ⑦, and Lane D's ⑥, are not touched.
