# ⑫ canonical adapter: a receipt whose settle collides no longer writes its credit (Lane C, 2026-11-17)

**Boundary:** this is a latent consistency fix in ⑫'s adapter. Proposal P1 (`credited` in the settle record) is **not adopted**, and the current program records no `credited`. So nothing here is applied to, or reachable in, the current program, and it is not a completed real-world connection. It only makes the adapter consistent with "first wins" should P1 ever be adopted.

**Branch:** `claude/lane-c-ws12-receipt-collision-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `cb65bed45cdfbdbf1ef1474902c57e6b5bc886b6` (the origin tip when read; newer than `02f9bb46`). The aggregate, canonical and every other branch are unchanged.

**Written, not run:** no test, syntax check, import, server or world. No new trust source, ABI, binding, permission, or economy or send rule. ⑥ is not touched.

## What was audited (source at `cb65bed4`)

`workstreams/12-memory/adapters/ws04-receipts.mjs` (`receiptToFacts`, `ingestReceipts`) and `adapters/canonical.mjs` (`connectCanonical`, `finalizedSlotFrom`, `storeWorldMismatch`), with `src/store.mjs` (`Journal.append`) and `src/fold.mjs` (credits).

| Contract | What the source does | Holds? |
|---|---|---|
| Finality is never assumed | `finalizedSlotFrom` takes only `{commitment: 'finalized', slot, source}` for this `world_id`; a cross-check or `complete` is refused. Without it, every receipt is held (`connectCanonical`). Per receipt, `slot > finalizedSlot` → `not_finalized` | Yes |
| World | The memory's `cluster`/`world_id` and partition must match `/h/season`'s, the store's world binding must be declared and match, and the attestation's `world_id` must match. Otherwise all receipts are held before any write | Yes |
| Identity | An alias comes only from the resolver (`identityFromHeraldMe` → `resolverFromIdentity`, which drops conflicting tags). With none, no alias fact is written | Yes |
| Quantity | `credited: null` → no credit fact (unknown, not 0). Cargo entries must be safe integers ≥ 0 (a malformed body holds the receipt). u64 tags stay exact (`parseJsonU64`, `tagHexOf`) | Yes |
| Clock | An unmapped slot → `clock_unmapped`; an observed bell before the event → held | Yes |
| One receipt's facts against the record rules | Every fact is checked (`checkFact`) before any is written; one refusal holds the whole receipt | Yes |
| **One receipt's facts against what is already kept** | **No.** `Journal.append` gives `collision` per fact (same id, another body: the first stands). A `caravan_settled` receipt yields `identity_alias`, `caravan_settled` and `caravan_credited` (a separate id). When the settle collides, its credit was still written if no credit had been kept for that caravan | **Defect (latent)** |

**Why it matters.** `fold.mjs` (`creditBy` and the credit split) takes a vault's amount from `caravan_credited` when its place is the same as the kept settle's `dst` (`x = cr.f.data.credited[res]`).

Here is the sequence:
1. Receipt 1, `credited: null`, is kept.
2. Receipt 2 is for the same caravan and the same vault, but with another cargo or outcome, and `credited: C`.
3. Receipt 2's settle collides and is rejected, but its credit C is added.
4. The fold counts C: a credit from the body that lost, beside the settle that stood. That is against "first wins".

The fold does catch the other cases: a different place, or a holding credit different from the kept cargo, is a `record_conflict`. **The defect is reachable only with proposal P1** (`credited` in the settle record), which the program does not apply today. The adapter already reads `credited` when present.

## The fix (`adapters/ws04-receipts.mjs` `ingestReceipts`, sha256 `cd20e737…53dd3e7c`)

- When a receipt's own event fact (anything but `identity_alias`) returns `collision`, none of the receipt's later facts are written.
- The receipt is listed in `held` as `collision:<kind>; not written: <kinds>`.
- An `identity_alias` collision stops nothing, because the alias does not depend on the receipt's body (bell 0, the resolver's pairing).

**Unchanged:**
- `receiptToFacts`, the order of facts and every count except the skipped facts;
- the duplicate path (the same event read twice still offers its credit);
- `connectCanonical`, the fold and the journal.

**Existing tests (read, not run):**
- `test/adapters.test.mjs:120-123` (a forged settle with the same `credited`) asserts `collision === 1`, the last rejection is `collision`, and `qty` 3. All still hold: the credit is no longer offered, where it used to be a duplicate.
- `test/adapters-canonical.test.mjs:278-289` asserts `collision >= 1` and one settle. Still holds.
- No test asserts the duplicate count or `held` after a collision.

## Regression (`test/receipt-collision-keyfree.test.mjs`, sha256 `6902cbb4…53fe4714`, written, not run)

It is built like `test/receipt-integrity-keyfree.test.mjs`: a fake memory (`observe` only), the recorded `fixtures/ws04-receipts/happy.json` (whose settle is to a vault with `credited`), no journal, keys, network or subprocesses. Its closure is `ws04-receipts.mjs` → `src/records.mjs` (`node:crypto` `createPublicKey`/`verify` only) → `permutation-gateway/citizens/memory/config.mjs` and `…/mind/sanitize.mjs`, the same as the listed key-free test.

- **R1:** a colliding settle never offers `caravan_credited`; counts and `held` are as described.
- **R2:** a duplicate settle still offers its credit.
- **R3:** an alias collision stops nothing.
- **R4:** the rest of the feed is still read, and `facility_used` is held as before.

**Not listed:** `workstreams/12-memory/tools/keyfree-tests.txt`, which CI uses for ⑫, is not changed here. Adding the new file to it is the list owner's call.

Candidate command (for the coordinator; not run): `node --test workstreams/12-memory/test/receipt-collision-keyfree.test.mjs`.

## Hand-over

- **Base:** `cb65bed45cdfbdbf1ef1474902c57e6b5bc886b6`.
- **Branch:** `claude/lane-c-ws12-receipt-collision-20261117`. History on top of the base:
  - the code, test and first report: `f969023d7748f638932571d9f8a2cc6492d69f6b`;
  - the scope note: `ed4720e3b19b323bd39840e4632be643e248272e`;
  - this correction (report only), which is the tip.
- The product and test files are the same in every commit after `f969023d`.
- **Three paths:**
  - `workstreams/12-memory/adapters/ws04-receipts.mjs` (M);
  - `workstreams/12-memory/test/receipt-collision-keyfree.test.mjs` (A);
  - `docs/integration/CLAUDE-LANE-C-WS12-RECEIPT-COLLISION-20261117.md` (A).

## Scope (as approved)

- The atomicity contract stays the existing one: **within one receipt**, every fact is checked (`checkFact`) before any is appended. No transaction over several receipts is introduced.
- The existing sequential behaviour is kept. A valid receipt is added; a malformed one goes to `held` (with its reason); the loop then goes on to the next receipt.
- The `break` added here leaves only the inner loop over **the current receipt's** facts, after one of its own event facts collided with a fact already kept. Earlier receipts' writes are not undone or delayed, and later receipts are still read. R4 pins that.
