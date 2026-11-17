# ⑬ operator resident: saved respond results read back without a key, signer or proposal (2026-11-17)

**Branch:** `claude/ws13-enact-read-20261117` **on `39951015`** (the enact-lock unit, unchanged).
- `72945fa6` is the first tip.
- The correction (the second tip) is on top of it.
- **Adopt the final tip only:** the aggregate's `72945fa6` alone is not the final state.

**Static change, NOT run:**
- no test, syntax check, import, call, read, lock, signature, POST, send, charge, key or runner;
- **nothing was enacted.**

## The gap

- `enactRespond` reads back a `sending` line only inside a full call, which needs a signer, a proposal and an observation.
- After a stop or a restart, there was no entry that only reads what was already submitted.

## `resident/live/enact-read.mjs` (new), `readRespondResults({dir, wallet, boardUrl, heraldUrl, fetchImpl, worldFromSeason})`

**Explicit inputs only:** the wallet, the board, the herald, `fetchImpl` and workstream 12's `worldFromSeason` (injected, as `factory.mjs` does). Nothing is chosen.

### 1. Local first, nothing outside

- **The lock file's metadata:** `lstat` only, giving `lock.present`. Its content is not read, and nothing about it is decided or changed.
- **`live-enact.json`:** one read of the whole file. The state store writes it by temporary file and rename, so the read sees one whole version. **No lock is taken.**
- **Each line is classified from the journal alone,** with **`enact.mjs`'s own checks**, exported as they are (`sameBinding`, `lineProblem`, `LINE_STATES`). Each line must have:
  - a known state;
  - a complete recorded binding (wallet, board, program, Season, network, world, clock);
  - that binding's wallet and board equal to the ones given;
  - its record and signature intact against that binding.

### 2. Outside, only for `sending` lines

**Only when some line is a `sending` that passed the local checks** (a post that may have arrived, whose result only the board can tell), it reads:
- the herald's `/h/season`: the world (`worldFromSeason`) and the Season bell's clock (`frame.mjs`);
- the board's `/coop/config`: program, Season and network (`enact.mjs` `boardWorldIs`);
- then **one** `/coop/view?viewer=<wallet>`, only when some `sending` line was made under the world and clock now.

**No other line causes a read:** an empty journal, intents only, signed-not-posted, posted or refused as journaled, or lines that are not intact or not for this wallet and board read **nothing outside** (`read: 'nothing outside…'`).

### 3. The result: the journal's word and the board's view apart

Each line has:
- `journal: {state, recordId}`: what the journal says;
- `board`: `{read: false, why}`, `{read: true, seen: true}` or `{read: true, seen: false, why}`: what the view shows now;
- `result`, as below.

| Result | When | Read outside |
|---|---|---|
| `held` | a state this code does not know; no complete binding; another wallet or board than given; not intact | no |
| `intent` | `intended`: nothing was signed; not taken further | no |
| `signed-not-posted` | `signed`: `enactRespond` saves `sending` before its one POST, so this was never posted by it. **Never raised to a submission**, not looked up | no |
| `posted` / `refused` | as the journal says | no |
| `unknown` (not compared) | a `sending` line, but the world or clock now not read, or the board not in this world now | `/h/season`, `/coop/config` |
| `held` | a `sending` line made under another world or clock than now | `/h/season`, `/coop/config` |
| `confirmed` | a `sending` line whose record id the view shows for this request and this wallet, with the request on the view exactly once | all three |
| `unknown` | a `sending` line otherwise: the request not on the view, or on it twice; another record of this wallet; responses or the view not read. **Never "not sent", "failed" or "absent"** | all three |

**No journal now:** `{ok: true, journal: 'not there now', lines: []}`, with nothing read outside. The result says only that the journal is not there now: **whether anything was enacted before (a removed or moved journal) is not known, and it is no evidence that nothing was enacted or sent.** *(Corrected: the first tip's "nothing was enacted from this directory" claimed more than that.)*

**Never done:**
- take or remove a lock;
- write the journal or `state.json`;
- observe for candidates, propose, sign, post or re-send.

**A confirmed line stays `sending` in the journal.** `enactRespond` updates it on its next call, under its lock. The result says `wrote: 'nothing…'`.

**Stop-A:** a stopped resident is not asked. Reading the result of an earlier post is allowed while stopped, and nothing new is done.

**`enact.mjs`:** one added line exports the checks and constants above. Its behaviour is unchanged.

## Limits (stated)

- **No lock is taken**, so a writer running at the same time may change the journal after the read (`lock.present` tells that one may be active).
- **`confirmed` is the board's view now.** It is not a chain fact, and not finality.
- **Nothing calls this reader:** there is no runner, CLI or loop.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-enact-read.test.mjs` (new)

Lines made by `enactRespond` with a fake signer and board. The reader is given a fake herald and board that record every call.
- **A `sending` line, with the resident stopped:**
  - `unknown` (board read, not seen) while the view does not show it, then `confirmed`;
  - exactly GET `/h/season`, `/coop/config`, `/coop/view`;
  - the journal and `state.json` byte-identical, no lock made.
- **Unknown, never "not sent":**
  - another record of this wallet;
  - the request twice or absent;
  - responses not read;
  - the view malformed.
- **A `sending` line not compared:**
  - the herald down, not a continuous world, or the board in another Season: `unknown`, and the view is not read;
  - another Season or bell now: `held`.
- **No read outside at all:**
  - another board or wallet given (`held`);
  - posted (`board.read: false`);
  - a changed line (`held`);
  - signed-not-posted (made by `enactRespond` held after signing);
  - an intent;
  - no journal (`journal: 'not there now'`, no claim about the past).
- **A lock there:** only looked at, left untouched.
- **As text:**
  - no POST, signing, writing, lock taking, observation, step, clock or key;
  - `enact.mjs`'s own checks imported;
  - the lock looked at by `lstat` only;
  - nothing outside before the `sending` check;
  - no claim from a missing journal.

## Hand-over (Lane D)

**Unit:** `claude/ws13-enact-read-20261117`, two commits on `39951015` (`72945fa6`, then the correction). The aggregate already holds `72945fa6`, so take the correction's own diff `72945fa6..<final tip>`; or, from `39951015`, the final tip's diff. All `100644`:
- `workstreams/13-citizens/resident/live/enact-read.mjs` (M in the correction)
- `workstreams/13-citizens/test/live-enact-read.test.mjs` (M in the correction)
- `docs/integration/CLAUDE-WS13-ENACT-READ-20261117.md` (M in the correction)
- `workstreams/13-citizens/resident/live/enact.mjs` (unchanged by the correction: one export line from `72945fa6`)

**Not run:** anything. Nothing was read, signed, posted or sent.
