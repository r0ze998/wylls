# ⑬ operator resident: saved respond results read back without a key, signer or proposal (2026-11-17)

**Branch:** `claude/ws13-enact-read-20261117`, one commit **on `39951015`** (the enact-lock unit, unchanged).

**Static change, NOT run:**
- no test, syntax check, import, call, read, lock, signature, POST, send, charge, key or runner;
- **nothing was enacted.**

## The gap

- `enactRespond` reads back a `sending` line only inside a full call, which needs a signer, a proposal and an observation.
- After a stop or a restart, there was no entry that only reads what was already submitted.

## The fix: `resident/live/enact-read.mjs` (new), `readRespondResults({dir, wallet, boardUrl, heraldUrl, fetchImpl, worldFromSeason})`

**Explicit inputs only:** the wallet, the board, the herald, `fetchImpl` and workstream 12's `worldFromSeason` (injected, as `factory.mjs` does). Nothing is chosen.

**Reads, and nothing else:**
1. **The lock file's metadata:** `lstat` only. It says whether a writer may be changing the journal now (`lock.present`). Its content is not read, and nothing about it is decided or changed.
2. **`live-enact.json`:** one read of the whole file. The state store writes it by temporary file and rename, so the read sees one whole version. **No lock is taken**, so with a writer running this is the version at the read.
3. **The herald's `/h/season`:** the world (`worldFromSeason`) and the Season bell's clock (`frame.mjs` `seasonClock`, `clockId`).
4. **The board's `/coop/config`:** its program, Season and network (`enact.mjs` `boardWorldIs`).
5. **One `/coop/view?viewer=<wallet>`.**

**Each line**, judged with **`enact.mjs`'s own checks**, exported as they are (`sameBinding`, `lineProblem`, `LINE_STATES`), not copied:

| Result | When |
|---|---|
| `held` | a state this code does not know; made under another wallet, board, world or clock (or does not say); not intact. **Not compared.** |
| `unknown` (not compared) | the world or clock now is not read, or the board is not in this world now. The view is not read. |
| `intent` | `intended`: nothing was signed. **Not taken further.** |
| `posted` / `refused` | as the journal says, with what the view shows (`board`). |
| `confirmed` | a `sending` (or `signed`) line whose record id the view shows **for this request and this wallet, with the request on the view exactly once**. |
| `unknown` | anything else: the request not on the view, or on it twice; another record of this wallet there; responses or the view not read. **Never "not sent", "failed" or "absent".** |

**Never done:**
- take or remove a lock;
- write the journal or `state.json`;
- observe for candidates, propose, sign, post or re-send.

**A confirmed line stays as the journal says** (`sending`). `enactRespond` updates it on its next call, under its lock. The result says `wrote: 'nothing…'`.

**Stop-A:** a stopped resident is not asked. Reading results is allowed while stopped, and nothing new is done.

**`enact.mjs`:** one added line exports the checks and constants above. Its behaviour is unchanged.

## Limits (stated)

- **No lock is taken**, so a writer running at the same time may change the journal after the read. `lock.present` tells that a writer may be active or left a lock.
- **`confirmed` is the board's view now.** It is not a chain fact, and not finality.
- **Nothing calls this reader:** there is no runner, CLI or loop.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-enact-read.test.mjs` (new)

Lines made by `enactRespond` with a fake signer and board. The reader is given a fake herald and board.
- **A `sending` line, with the resident stopped:**
  - `unknown` while the view does not show it, then `confirmed`;
  - exactly GET `/h/season`, `/coop/config`, `/coop/view`;
  - the journal and `state.json` byte-identical, no lock made.
- **Unknown, never "not sent":**
  - another record of this wallet;
  - the request twice or absent;
  - responses not read;
  - the view malformed.
- **Not compared:**
  - the herald down, not a continuous world, or the board in another Season: `unknown`, and the view is not read;
  - another Season, another bell, or another board: `held`.
- **Posted** (seen), a changed line `held`, an intent-only line `intent` (left `intended`).
- **No journal:** `ok`, with no lines. **A lock there:** only looked at, left untouched.
- **As text:** no POST, signing, writing, lock taking, observation, step, clock or key; `enact.mjs`'s own checks imported; the lock looked at by `lstat` only.

## Hand-over (Lane D)

**Unit:** `claude/ws13-enact-read-20261117`, one commit on `39951015`. Take its own diff `39951015..<tip>`, all `100644`:
- `workstreams/13-citizens/resident/live/enact.mjs` (M: one export line)
- `workstreams/13-citizens/resident/live/enact-read.mjs` (A)
- `workstreams/13-citizens/test/live-enact-read.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-ENACT-READ-20261117.md` (A)

**Not run:** anything. Nothing was read, signed, posted or sent.
