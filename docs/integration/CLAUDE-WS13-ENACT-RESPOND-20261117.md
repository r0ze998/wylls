# ⑬ operator resident: enacting a respond proposal on workstream 1's board; a send held (2026-11-17)

**Branch:** `claude/ws13-enact-respond-20261117`, one commit **on `9730f8e2`** (the owner-mode unit's final tip, unchanged).

**Adoption and closure:**
- take this unit's own diff `9730f8e2..<this tip>`;
- **the product file needs:** `resident-state.mjs`, `factory.mjs` `existsForHalt` (aggregated), workstream 1's `record.mjs` (`signRecord`, `recordId`, `shapeProblem`) and the gateway's `createStateStore`, all unchanged;
- **its regression uses** `writeInitialResident` (the initial-resident unit).

**Static change, NOT run:**
- no test, syntax check, import, call, signature, POST, send, charge, key or runner;
- **nothing was enacted.**

## What is separate

- **The one-step entry** (`once.mjs`, `bin/live-once.mjs`) **stays no-charge and non-enacting**: it does not import this module.
- **Enacting is a separate API**, `resident/live/enact.mjs`, which a caller uses explicitly with a proposal from a live step.

## `enactRespond({dir, wallet, proposal, observed, nation, signer, boardUrl, fetchImpl, nowSecs})`

A `respond` proposal becomes workstream 1's signed `respond` record (`record.mjs` `signRecord`), posted once to the board (`POST /coop/records`).

**Injected, never chosen:**
- **the signer** `{address, signMessage}`: the resident's identity as its owner supplies it, and it must be this wallet. No key is read, made or chosen here.
- **the declared nation** (0..5, which workstream 1's record requires).
- **the record time** (`nowSecs`).
- **the board** (`boardUrl`, `fetchImpl`).

**The order.** Every side effect comes after a durable record of it, in the resident directory's own journal file `live-enact.json`, written through the existing state store (a temporary file, then a rename). One line per request, `respond:<request>`.
1. **Checks, nothing written:** a respond proposal; an observed world (program, Season, network); the signer for this wallet; a nation; a clock; a board. Any missing → `held`.
2. **An existing line:**
   - posted or refused: answered as it is;
   - `sending` (the post's result not known): **read back** on the board's view (my response's record id). This is a result read, so it is **allowed also while stopped**. It is **never posted again blindly**.
3. **The resident's stop now** (`readResidentState`): stopped or unknown → `held` (stop-A: no new operation).
4. **The intent is saved** (the unsigned record). A failed save → `held`, with nothing signed.
5. **Signed** (one `await`). The signed bytes and their record id are saved.
6. **After the `await`, checked again:** the stop, and the board's world (`/coop/config`: program, Season, network). Any change → `held`: **signed, not posted**, and the same bytes are kept for later. It never signs twice.
7. **`sending` saved**, then **one POST**:
   - 200 `{ok: true}` → posted;
   - 400 `{ok: false, why}` → refused (workstream 1's board answers so);
   - anything else, or no answer → **unknown** (it may have arrived), kept as `sending` and read back later.

**What a respond does and doesn't do:**
- **It moves nothing:** a respond record only says the resident will send (workstream 1). It is **not** a send, an arrival or a count.
- **Overwriting is avoided:** the board refuses the same record twice, but a new respond from the same signer replaces an earlier answer. One line per request, with the same bytes reused, means this code never makes a second record for the same request.

## `enactSend()`: held, not supported

A caravan send is **not enacted**. The reasons, from the existing code:
- workstream 1's `sendPlanned` **pins the cluster to `localnet`** (`io.setPin`);
- `sendPlanned` and `fplay.submit` take **no idempotency key**;
- the at-most-once record (workstream 1's `sending`) is posted **from the wallet's `signTransaction` hook in the board page** (`coop-ui.mjs`), and `sendOutcome` correlates by the wallet's signature. **No non-browser, non-localnet contract for that is adopted.**

Nothing is relaxed, and no new transport is made. `enactSend` returns `held` with these reasons.

## Not connected yet (concrete)

1. **The send:** a resident-side `sending` record and send under an adopted contract (signer hook, correlation, the world's cluster).
2. **Reading back a `sending` line that is not on the board:** it stays `unknown`. Re-posting the **same** signed bytes would be refused by the board as a duplicate if it had arrived, but this is not done automatically. **Whether to allow that re-post is an open decision.**
3. **Identity and authority:** the signer (the resident's key) must be supplied by its owner, and the owner's agent-wallet policy, funding and join are not connected.
4. **Concurrent writers:** `live-enact.json` and `state.json` have no lock. Use one process at a time per resident directory.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-enact.test.mjs` (new)

Temporary resident directories, a fake signer (fixed bytes, no key), a fake board.
- **Held before anything is written** (no journal file, no POST): not a respond, no world, a signer for another wallet or none, no or a bad nation, no clock, no board. When stopped: not signed, not posted.
- **Posted once:** the record's kind, request, answer, nation, signer and season. The same request again answers from the journal, never signed or posted twice.
- **Refused (400)** is refused.
- **Unknown (502, or no answer):**
  - stays `sending`;
  - is not posted again;
  - is confirmed as posted once the board's view shows my response's record id;
  - while stopped, it is still read back and nothing new is done.
- **A HALT during the signature:** held, signed, not posted.
- **The board in another world:** held. Once the world is right, the **same bytes** are posted, signed once.
- **`enactSend`:** held, with the unsupported reasons.
- **As text:**
  - `once.mjs` does not enact;
  - no send path, key, clock or mode change in `enact.mjs`;
  - the intent is saved before signing;
  - `sending` is saved before the POST.

## Hand-over (Lane D)

**Unit:** `claude/ws13-enact-respond-20261117`, one commit on `9730f8e2`, all `100644`:
- `workstreams/13-citizens/resident/live/enact.mjs` (A)
- `workstreams/13-citizens/test/live-enact.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-ENACT-RESPOND-20261117.md` (A)

**Not run:** anything. Nothing was signed, posted or sent.
