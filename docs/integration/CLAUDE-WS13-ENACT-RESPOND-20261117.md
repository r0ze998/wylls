# ⑬ operator resident: enacting a respond proposal on workstream 1's board; a send held (2026-11-17)

**Branch:** `claude/ws13-enact-respond-20261117` **on `9730f8e2`** (the owner-mode unit's final tip, unchanged).
- `b1f11f5c` is the first tip.
- The first correction (`7881e8d6`, the second tip) is on top of it, and the second correction (the third tip) on top of that.
- **Adopt the final tip only:** not `b1f11f5c` or `7881e8d6` alone.

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

## Second tip: the parent's review of `b1f11f5c`

### 1. Bindings

- **Each journal line records the binding it was made under:** the wallet, the board's base URL, the program, Season, network and world id.
- **Every reuse** (intended, signed, sending, posted, refused) is checked against the current binding **before anything is done**, including the `sending` read-back.
- **A missing or different binding is `held`** ("made for another wallet, board or world"). So a past signature, post or result is never used for another identity, board or world.
- **A line state this code does not know is `held`**, never treated as a new intent.

### 2. The record from allowed fields only

- **The record is built as** `{v: 1, kind: 'respond', season: {programId, seasonId}, at, request, answer: 'accept', offer, nation}`. The proposal's record must be **exactly** `{kind: 'respond', request, answer: 'accept', offer}`, so it cannot replace `kind`, `season` or `at`.
- **Checked before signing:**
  - an unenacted proposal;
  - a choosable (not held) respond candidate for the same request;
  - the request present in this observation (open, verified, this world);
  - the offer equal to the candidate's, in whole units of the request's own resources, no more than its need;
  - workstream 1's `shapeProblem`.
- **Anything else is never signed, and nothing is written.**

### 3. What was observed and what was saved

- **Every answer carries `durable`.** When the board's answer is seen but the journal cannot be saved, the result says so (`durable: false`, with why). *(Corrected in the third tip: what the disk then says is not known.)*
- **A later call**, in the same process (each call reads the journal from disk) or after a restart, **only reads back; it never posts again.**

### 4. One call per request at a time

- **Within one process:** a second call for the same request is `held` while the first runs. *(Widened in the third tip to the whole journal.)*
- **Across processes:** **nothing is excluded** (no lock in the files). Use one process per resident directory.

**Unchanged:** the stop before any new operation and after the signature; the board's world checked before the POST; stop-A read-back only; no send, no key, no authority.

## Third tip: the parent's final review of `7881e8d6`

### 1. One call per journal, not per request

- **The defect:** the lock was per directory and request, but every request loads and saves the same `live-enact.json`. Two requests at once could save over each other's lines and lose a record already posted.
- **Now:** within one process, a call on a resident's journal holds the **whole journal**. Any second call on it (any request) is `held` with nothing done.
- **The key is the directory's real path** (`realpathSync`), so another spelling or a symbolic link to the same directory is the same journal. A directory that cannot be resolved is `held`.
- **Across processes:** still **nothing is excluded**, and nothing is promised.

### 2. The clock is part of the binding

- **The binding is now:** wallet, board, program, Season, network, world id, and **the clock** (`frame.mjs` `clockId` of the observed Season bell).
- **A new call needs an observed Season-bell clock** (`season-bell:<genesis>:<bell>`). None, a mock clock or a bare kind is `held`, and the observed world's network must be the Season's.
- **Every binding key must be a non-empty string on both sides and equal.** Unknown never matches unknown, and an older line without a clock is `held`.

### 3. A failed save is unknown, not "still sending"

- **The state store can fail after its rename** (syncing the directory), so the new state may already be on disk. A failed save is reported as **`durable: false, saved: 'unknown'`**, with what was observed kept apart (for example `state: 'posted'` because the board answered ok).
- **This applies to every save:** the intent, the signature, `sending`, posted, refused, and a read-back confirmation.
- **A later call, in this process or after a restart, reads the disk again:**
  - a `sending` line is only read back, never posted again;
  - a `posted` or `refused` line is answered as it is.
- **The result never says the disk holds a state it may not hold.**

### 4. A kept line is checked before it is used

- **Before any use, including answering a posted or refused line,** a line must be intact:
  - its own key and request;
  - its record by **the same respond schema as a new one** (exactly `{v, kind, season, at, request, answer, offer, nation}`, an accept, this Season, a time, a nation 0..5, whole-unit offer, workstream 1's `shapeProblem`);
  - from `signed` on: its signed bytes are exactly that record plus this wallet as signer and a signature, valid by `shapeProblem`, with `recordId` equal to the kept record id;
  - an `intended` line has no signature.
- **Anything else is `held`:** an old or changed record is never signed or posted, and a changed line is never answered as posted.
- **The signature itself is not verified here** (`verifySig`); the board verifies it on POST. A fresh signature is checked by the same line check before it is saved.

**Unchanged:** the one-step entry does not enact; the stop before any new operation and after the signature; the board's world before the POST; stop-A read-back only; owner or policy unknown stops (`readResidentState`); no send, key, clock read or authority.

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
4. **Concurrent writers across processes:** `live-enact.json` and `state.json` have no lock between processes (within one process the journal is held per call). Use one process at a time per resident directory. **Not guaranteed.**

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

**(second tip) Added:**
- **Bindings:** a line used with another board or world is held; a state this code does not know is held; a line without a binding is not read back.
- **The record:** extra or replaced fields, another kind, a decline, a held candidate, another request, an offer beyond the need or unlike the candidate's, an enacted proposal: never signed, nothing written.
- **Not durable:** an answer seen while the directory is read-only gives `durable: false`; the journal still says `sending`; the next call only reads back (skipped as root).
- **One call per request at a time** in a process.

**(third tip) Added:**
- **One journal per call:** another request on the same journal, or the same directory through a symbolic link, is held while a call runs. Both requests' lines are kept afterwards.
- **The clock:** none, a mock one or a bare kind is held, with nothing written; another bell is held; a line without the clock in its binding is held.
- **A kept line:** a changed record kind, Season, extra field, request, signed offer, signer, record id or key is held, never signed again or posted. A posted line whose record was changed is not answered as posted.
- **Not durable:** `saved: 'unknown'`. The case tested fails before the rename, so there the disk still says `sending`.
- **As text:** the lock by real path, the clock in the binding, no claim about the disk after a failed save, the line checked before it is answered.

## Hand-over (Lane D)

**Unit:** `claude/ws13-enact-respond-20261117`, three commits on `9730f8e2` (`b1f11f5c`, `7881e8d6`, then the final correction). Take the final tip's diff from `9730f8e2`, all `100644`:
- `workstreams/13-citizens/resident/live/enact.mjs` (A)
- `workstreams/13-citizens/test/live-enact.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-ENACT-RESPOND-20261117.md` (A)

**Not run:** anything. Nothing was signed, posted or sent.
