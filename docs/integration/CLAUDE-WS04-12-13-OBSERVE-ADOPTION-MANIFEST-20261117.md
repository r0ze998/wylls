# ④ observe → ⑬ `observe-canonical` → ⑫ held report: the smallest closed adoption unit (2026-11-17)

**Fixed source:** `claude/ws12-13-observe-consistency-20261117` at `a7cd14b6`.
- On the remote; checked again.
- `17f4cca4` is not an ancestor.

**Against:** the aggregate `claude/aggregate-approved-20261117` at `19c9cbbe`.
- That aggregate descends from `6a7aea0f`.
- The common base with `a7cd14b6` is `d16048aa`.

**This is a manifest, not a merge:**
- No aggregate ref, canonical ref or `main` was changed.
- A candidate tree was built **as objects only** (no ref, not pushed): **`075701cd05d907329435a3d27d0f9ccf9b019201`**, on `19c9cbbe`.
- Making it a branch, or taking it into the aggregate, is the parent's and Lane D's decision.

**Not run:**
- no test, `cargo`, build, RPC, HTTP, world, signing or model call;
- no earlier run approval reused.

## 1. How the unit was cut (static closure, not "all 34 paths")

**The JS side:** the static `import` closure of `13-citizens/bin/observe-canonical.mjs`.
- Read as text only; no module was loaded.
- 19 local files, plus only `node:` built-ins (`fs`, `util`, `url`, `child_process`, `path`, `crypto`, `sqlite`).
- The two `permutation-gateway` files import only `node:fs` and `node:crypto`, or nothing.
- **13 of the 19 are already in the aggregate, byte for byte:**
  - 12's `src/index`, `store`, `records`, `fold`, `view` and `advise`;
  - `adapters/canonical`, `ws08-world` and `ws04-receipts`;
  - 13's `resident/frame` and `ports/ws12-canonical`;
  - `permutation-gateway/citizens/memory/config` and `mind/sanitize`.
- **The 6 that are new:**
  - `observe-canonical.mjs`
  - `ports/ws04-observe.mjs`
  - `ports/live-canonical.mjs`
  - `assembly.mjs` (imports nothing)
  - 12's `adapters/live-observation.mjs`
  - `adapters/ws04-observation.mjs` (imports nothing)

**The resident split is not in the closure:**
- `resident.mjs`, `decide-core.mjs`, `recall.mjs` and `ports/memory.mjs` are imported neither by the CLI nor by any adopted test.
- `assembly.mjs` describes the resident only as text (`REQUIREMENTS`). Those descriptions hold for the aggregate's resident: `#publicEvidence` reads `port.read(...)` (`:850`), and `ports.memory.all/append/recall` (`:389`, `:425`, `:787`).

**The Rust side:** `runexec observe store|db` compiles from 3 files.
- `src/observation.rs` (new), `src/lib.rs` (`pub mod observation`) and `src/main.rs` (the `observe` dispatch).
- It uses `frontier_abi::v2::log`, `rusqlite`, `serde`, `sha2`, `hex`, `crate::model` and `crate::ports`.
- **All of these are unchanged between `d16048aa`, `a7cd14b6` and `19c9cbbe`:**
  - `frontier-abi` tree `ed5e06ed`;
  - ④'s `Cargo.toml` `6e8d97c8` and `Cargo.lock` `6eef0e91`;
  - `model.rs`, `ports.rs`, `rust-toolchain.toml` and `.cargo/config.toml`.
- **④ does not depend on the `findex` crate:** it reads the manifest as plain JSON.

## 2. The unit: 22 paths, all `100644`

**"Aggregate":** the blob at `19c9cbbe` (— = absent). For every changed (M) path, the aggregate's blob is **the common base's**: nobody changed it in the aggregate after `d16048aa`. So **no hunk overlaps**; the M paths take `a7cd14b6`'s blob whole.

| Path | Why it is needed | Source blob (`a7cd14b6`) | In the unit | Aggregate |
|---|---|---|---|---|
| `workstreams/04-execution/src/observation.rs` | the producer (`read_observations`, `read_store_observations`) | `5c5a1d4bb639` | same | — |
| `workstreams/04-execution/src/lib.rs` | `pub mod observation` (+3 lines) | `9d45f40183d2` | same | `15868afde45d` |
| `workstreams/04-execution/src/main.rs` | `observe store\|db` dispatch (+92/−1, only the observe part) | `fbeabc5a3496` | same | `b524721cff20` |
| `workstreams/04-execution/tests/observation.rs` | the producer's decode cases | `7861f73e247d` | same | — |
| `workstreams/04-execution/tests/observe_cli.rs` | the command's exit codes and JSON (temporary files only) | `408520f78f3a` | same | — |
| `workstreams/04-execution/tests/store_observation.rs` | the store-directory reader (synthetic stores) | `e742f0641552` | same | — |
| `workstreams/04-execution/docs/READ-OBSERVATION-20261116.md` | the contract `observation.rs` names | `43aad37a02c9` | same | — |
| `workstreams/04-execution/docs/STORE-DIR-OBSERVATION-20261117.md` | the store-mode contract and its 16/16 run record | `cf94311bcfb6` | same | — |
| `workstreams/04-execution/README.ja.md` | the command's entry in ④'s README (docs only) | `12aed3477f13` | same | `85122dc90fcd` |
| `workstreams/12-memory/adapters/live-observation.mjs` | `observeLive` (the CLI's observation) | `2b61e13a41d0` | same | — |
| `workstreams/12-memory/adapters/ws04-observation.mjs` | ④'s page as a held report (with the `a7cd14b6` consistency checks) | `a78ece45f1c0` | same | — |
| `workstreams/12-memory/test/ws04-observation.test.mjs` | regression | `5a2d9fdae81e` | same | — |
| `workstreams/12-memory/test/ws04-observe-cli.test.mjs` | the CLI with fakes | `8e76baf52695` | same | — |
| `workstreams/12-memory/test/live-observation.test.mjs` | `observeLive` | `943b671d049b` | same | — |
| `workstreams/13-citizens/bin/observe-canonical.mjs` | the command | `65bbbb9b6f4d` | same | — |
| `workstreams/13-citizens/resident/ports/ws04-observe.mjs` | the runexec client | `21b36aaec657` | same | — |
| `workstreams/13-citizens/resident/ports/live-canonical.mjs` | 13's evidence port over the observation | `528e869739bc` | same | — |
| `workstreams/13-citizens/resident/assembly.mjs` | `readOnlyResidentPreflight` (the CLI imports it) | `2ce5ce6e9665` | same | — |
| `workstreams/13-citizens/test/ws04-observe.test.mjs` | the client | `7f05abd60195` | same | — |
| `workstreams/13-citizens/test/live-canonical.test.mjs` | the port | `03bea75fbd39` | same | — |
| `workstreams/13-citizens/test/assembly.test.mjs` | the preflight | `fdaa1b713f5c` | **`718bc7729338`** (one line, §3) | — |
| `docs/integration/CLAUDE-WS12-13-OBSERVE-CONSISTENCY-20261117.md` | the consistency unit's report | `73ead21462f3` | same | — |

**Text the tests read:**
- `world/harness.mjs` `7995895d` and `12-memory/fixtures/ws04-receipts/*.json` are the same in both.
- `resident.mjs` (aggregate) contains no `ws04-observe`, as `ws04-observe.test.mjs` `:54` requires.

## 3. The one change made for the aggregate (a defect of the cut, fixed in the same scope)

**The problem:**
- `assembly.test.mjs` `:49` pins ten lines of `resident.mjs`.
- One of them, `publicEvidenceOf({ port: this.ports.evidence`, exists only in the resident split, which is excluded.
- The aggregate's resident has the same read written in place: `const port = this.ports.evidence;` (`:829`).
- The other nine pins are present, once each, in the aggregate's resident.
- So without this change, the adopted test would fail on the aggregate.

```diff
-    'this.ports.cost ?? flatCost(b.pricePerCall)', 'choice = this.ports.fallback(candidates)', 'publicEvidenceOf({ port: this.ports.evidence', "createStateStore(path.join(dir, 'state.json'))"]) assert.ok(r.includes(s), s);
+    'this.ports.cost ?? flatCost(b.pricePerCall)', 'choice = this.ports.fallback(candidates)', 'const port = this.ports.evidence;', "createStateStore(path.join(dir, 'state.json'))"]) assert.ok(r.includes(s), s);
```

**Not changed:**
- `REQUIREMENTS`;
- what the test asserts about `assembly.mjs` (no import, no `new Resident`, no write, no key);
- the harness pin.

**Where it lives:** the blob `718bc7729338` is only in the candidate tree. On `a7cd14b6`'s own resident the old pin is the right one, so it is not put on that branch.

## 4. Excluded, and why

| Paths | Why not in this unit |
|---|---|
| `frontier-node/crates/findex/src/{archive,ingest,lib,wide_store}.rs`, `tests/observed_source.rs`, `docs/integration/CLAUDE-FINDEX-OBSERVED-SOURCE-20261117.md` (`a99b961f`) | **The writer side.** They make findex record `observed` epochs in its manifest. ④'s reader needs none of it. |
| `13-citizens/resident/resident.mjs`, `decide-core.mjs`, `recall.mjs`, `ports/memory.mjs`, `test/decide-core.test.mjs` | **The resident's decision split (`3c5f22d2`…).** Not imported by the command or by any adopted test. The only path both sides change is `resident.mjs`, so the aggregate keeps its own, including the `#run` mayHaveLeft fix. |
| `13-citizens/CLAUDE-LIVE-OBSERVATION-20261116.md` | **A 752-line work record** that also describes the excluded split. Its run records are cited below by commit. |

**What happens without the writer side (normal, held):**
- A manifest without `observed` (any findex without `a99b961f`) is read as having no epochs.
- Every row gets `archive_epoch: {epoch: null, why: 'before_first_epoch'}`.
- 12 shows that as given, and every row stays held. This is a diagnostic, not an error.
- A manifest findex itself would refuse is refused here too (`read_manifest`).

## 5. Run evidence, and what is new and not run

| Files | Earlier evidence | Still covers the unit's blobs? |
|---|---|---|
| ④ `observation.rs`, `observe_cli.rs`, `store_observation.rs` | one guarded run, **16/16** (4 + 5 + 7), at `6005b380` | **the same blobs** (producer, `main.rs`, `lib.rs` and the three tests). It was run in `6005b380`'s tree, not on the aggregate, where other ④ files (gateway, store, acts) differ. Compiling them together is not shown. |
| 12 `ws04-observation.test.mjs` | **8/8** at `8e2e3e85` | the earlier version only. `a7cd14b6` adds one case and changes the adapter: **not run** |
| 12 `ws04-observe-cli.test.mjs` | **4/4** at `8e2e3e85` | as above: two cases and the CLI change are **not run** |
| 12 `live-observation.test.mjs`; 13 `ws04-observe`, `live-canonical`, `assembly` tests | no run record found | **not run** |

**Running any of these needs its own pre-run evidence and approval.**

## 6. Held, and checked not to be broken by the cut

- **④'s page:** `basis: unproven`, `world`/`finality`/`complete` null, and every row and page hold kept.
- **12's handling:**
  - admits nothing and makes no receipt, chain label, coverage or attestation;
  - takes the slot as the transaction's;
  - converts no timestamp.
- **The command:**
  - GET to the herald and one `getSlot`;
  - one runexec subprocess with no shell;
  - no resident, world, server, key or signing.
- **The aggregate's resident is untouched.**
- **Not in the unit:**
  - the refused branches and steps: walls-items, muster, world, runner, the ⑬ guard, G and H, and `17f4cca4`;
  - D ③⑥ and C ⑦.

## Hand-over

- **This manifest is the only file** on `claude/ws04-12-13-observe-adoption-20261117` (on `a7cd14b6`).
- **To reproduce the candidate tree:** from `19c9cbbe`, take the 22 paths in §2 at `a7cd14b6`, then apply the §3 line to `assembly.test.mjs`. The result is tree `075701cd`.
