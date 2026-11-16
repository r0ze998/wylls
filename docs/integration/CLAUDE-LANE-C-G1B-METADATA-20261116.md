# Lane C — G1b: can the page tell a /h/me read and a province envelope apart by generation? (2026-11-16)

Base: Lane C tip `86c601cd`. Branch: `claude/lane-c-g1b-metadata-20261116`.

**This is a source-only investigation.** No product code changed. No test, world, server, browser or endpoint was run.

**G1b** is the case where a village is lost in the active village's province. `/h/me` no longer lists it, but an older envelope's site mirror still counts it. The land bonus divisor is then one too high, so the bonus reads too low, until the newer envelope is read.

## Answer

**No metadata in the current code makes the comparison sound.**

- `/h/me` carries a fold-wide `latestSlot`. The `latest` province envelope carries only the province account's own last-write `slot` and `seq`, and the land record's own `slot`.
- No field on the envelope says how far the fold had got when it was read.
- No answer says whether its bytes are exact post-states, except the wide context, which only `/h/me` has.

A minimal added contract is proposed below. I implemented none of it, because it touches the server, `herald.mjs` parsing, the controller and `land.mjs`.

## The path, end to end (file:line on this tip)

### `/h/me`

| Step | Where | What it carries |
|---|---|---|
| route | `frontier-node/crates/herald/src/server.rs:144`, handler `me` 571–590 | Reads the fold to choose the Citizen. Then waits (up to 2 s) for the relay quota. Then reads the fold **again** and builds the answer from that second read. Answered `no-store`. |
| answer | `herald/src/views.rs:144–232` `me_json` (under one read guard, so one consistent snapshot) | `citizen` and each `holdings[i]` via `acct()` (views.rs:130–139): `slot` = slot of the **transaction that last wrote that account** (`Capture.slot`, fold.rs:131–135), `seq`/`head` = its event chain. Top level `latestSlot: f.st.last_slot`, the max tx slot folded. **No `foldedThrough`** (wide builds only: `wideContext.foldedThrough`, wide.rs:760). |
| client | `permutation-server/web/frontier/herald.mjs` `me` (~493–513), `get` uses `fetch(…, {cache: 'no-store'})` (herald.mjs:30) | Keeps the raw JSON as `record`. Decodes the holdings. Reads no generation field. |
| controller | `controller.mjs` `refresh()` 1300–…, `applyMeResult` 1244 | Sets `FS.holdings = me.holdings` at once. `me.record.latestSlot` is not kept as a generation. `app.mjs:3929` uses only the **season** record's `latestSlot` for the chain clock. |

### Province `latest` envelope

| Step | Where | What it carries |
|---|---|---|
| route | `server.rs:509–523` | `views::province_latest` under one read guard. Answered **`public, max-age=2`**. |
| answer | `views.rs:119–123` → `fold.rs:931–967` `envelope()` | `slot: pv.slot` (the **province account's** last-write slot), `seq`/`head` (province event chain), `bell`. `land: {key, slot, bytes}` (`slot` = the land account's last-write slot). **No fold position, no postState.** |
| client | `herald.mjs` `parseEnvelope` (~117–163) | Returns `bell, slot, seq, head, …, land: parseLand(…)`. **`env.land.slot` is dropped** (`parseLand` reads only `key` and `bytes`). |
| store | `controller.mjs:749–772` `latestEnvelope` / `loadEnvelope` | Keeps the held envelope when the new one has a lower `seq` (then `slot`, then `bell`). On a tie it takes the new one. |

**Callers that load envelopes concurrently** for the same province:
- `refresh()`, which loads them one after another;
- the map's province wants (`controller.mjs` ~1220–1228, `artWanted` is per key);
- `localSyncTick`.

These can overlap, and each response is applied when it lands.

### Fold semantics

- `Fold.apply` (`fold.rs:563–571`) sets `last_slot = max(last_slot, tx.slot)` and `folded_through = tx.seq` (the archive sequence), in archive order.
- A checkpoint (`checkpoint.rs:126–128`, `runner.rs:167`, every `checkpoint_slots` = 150 by default) stores both.
- `exact_post` (`fold.rs:72–76`, `main.rs:168`) is true only for `--source localnet`. On `--source rpc`, a capture is "state at a slot ≥ s", which the wide context labels `postState: "at-or-after-transaction"` (wide.rs:696–702).

### The program

- `FoldLand` (`permutation-frontier/src/proc/land.rs` `fold`, ~101–137) takes the province **read-only** and writes only the land account.
- The land record therefore changes with no change to the province's `seq` or `slot`.

## Why the present fields do not answer it (counterexamples)

- **C1 — `me.latestSlot` vs `env.slot`.** These are different quantities. `env.slot` is the province's own last-write slot, so an unchanged province read a moment after `/h/me` has `env.slot < latestSlot` forever. Comparing them would call every quiet province stale.
- **C2 — holding or Citizen `slot` vs `env.slot`.** `env.slot ≥ citizen.slot` would prove the envelope includes the loss only if the losing transaction writes both the Citizen and the province mirror. I have not verified that for every way a village is lost (capture, release, expulsion). Even if it holds, the Citizen is rewritten by unrelated later transactions, so a fresh envelope with `env.slot < citizen.slot` is common. That would be a false stale.
- **C3 — `latestSlot` vs `latestSlot`, if the envelope got one.** Several transactions share a slot. Two snapshots with equal `last_slot` can differ in content, which `folded_through` (archive seq) separates.
- **C4 — at-or-after post-state (`--source rpc`).** Captured bytes may be newer than their transaction, so a fold position does not bound what the bytes show. A Citizen captured late may already show the loss, while the province captured at a higher fold position still predates it. Even a `foldedThrough` comparison is proof only when `postState` is `"transaction"`.
- **C5 — land-only changes.** Because FoldLand writes only the land account, two `latest` answers can carry the same province `seq`/`slot`/`bell` and different land records. `latestEnvelope` takes whichever lands last on a tie. A slower, older response for that province can therefore put the older land record back after the newer one. This is a separate gap (G1c): ordering by code, timing not observed.
- **C6 — a page-side read counter.** It orders by when a read finishes, not by which snapshot the server answered from. Concurrent requests can finish in either order. `/h/me` itself answers from a snapshot taken after its up-to-2 s quota wait. So the counter cannot tell which fold state either answer came from (as the coordinator said).
- **C7 — a herald restart.** It resumes from a checkpoint (≤ 150 slots behind by default), so `folded_through` can be lower than an answer served before the restart. Whether the server answers before it catches up is **not verified**. A comparison would then err on the side of hiding. Whether two heralds behind one address share archive numbering is **not verified**.
- **C8 — caches.** `max-age=2` on `latest`. The page's `fetch(…, {cache: 'no-store'})` skips the browser cache, but a proxy or CDN in front is **not verified**. A fold position on the answer would expose a cached old one; nothing does now.

## Minimal added contract (proposal; not implemented)

1. **Server, `views::province_latest` only**, not `Fold::envelope()`.
   - `envelope()` also writes the **immutable** per-bell files at `close_bell` (`fold.rs:969–976`). A varying field there would trip the rewrite alarm.
   - Add `foldedThrough: f.st.folded_through.to_string()` and `postState: post_state_text(f)` (wide.rs:696, made `pub(crate)`) to the `latest` answer.
2. **Server, `views::me_json`.** Add the same `foldedThrough` and `postState` at the top level, with no feature gate. `wideContext` already has them, but only in wide builds.
3. **Client, `herald.mjs`.**
   - `parseEnvelope`: return `foldedThrough` (checked u64 string, as `fwide.mjs:212` `parseU64`) and `postState`. Keep `land.slot` beside the parsed land.
   - `me`: return `foldedThrough` and `postState` from the record.
   - An absent field means "unknown", never 0.
4. **Controller (main CC's file).**
   - `applyMeResult` keeps `FS.meAt = {foldedThrough, postState}`.
   - `latestEnvelope` compares `foldedThrough` first, when both have it, then the present `seq`/`slot`/`bell`. This also closes C5.
5. **`land.mjs`.** `landSummary` draws the home line only when `env.foldedThrough ≥ FS.meAt.foldedThrough` and both say `postState === 'transaction'`.
   - If either is unknown or at-or-after, there is no proof. The choice is then "show as today" or "no line"; that is a product decision for the coordinator, not made here.
6. **Tests to add with it:**
   - a server unit test that `latest` and `/h/me` carry the fields, and the immutable per-bell file does not;
   - pure-data page tests for C1, C3, C5 and the unknown/at-or-after cases.

This is fold-position metadata the server already holds. It needs no rule change, and it makes no claim about the program's transactions (C2).

## Not verified

- Which transactions write both the Citizen and the province mirror when a village is lost (C2).
- Whether the herald serves before catching up after a restart, and archive numbering across several heralds (C7).
- Proxy/CDN behaviour with `max-age=2` against a `no-store` fetch (C8).
- How often concurrent loads of one province actually overlap (C5, C6): read from code only, not observed.
- The `permutation-gateway/client` and `sdk/frontier` copies of `herald.mjs` were not traced; the page uses `web/frontier/herald.mjs`.
