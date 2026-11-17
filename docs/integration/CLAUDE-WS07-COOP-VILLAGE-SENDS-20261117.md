# Village card: the sends of this village's requests (2026-11-17)

**Branch:** `claude/ws07-coop-village-sends-20261117`, one commit **on `c18eee20`**: the village-requests unit, which is unchanged. Adopt it after that unit.

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, signature or world;
- every edit is a text replacement.

## The loop step

**Request → caravan prepared → send status.** ①'s board records each send a responder makes from ①'s page (`sending` records: the wallet's signature, the blockhash, the planned caravan). On every view it checks what became of each one, **for every request, whoever views**: `board.mjs` `checks` → `sendingStatus` → `chain.mjs` `sendOutcome`. **Without `--rpc`,** every outcome is `unknown`.

**The view carries the result** (`requests[].sendings[].outcome.status`). The game's card did not show it.

## What it does now (`hud/coopboard.mjs` `villageRequests`, third line)

For the requests to this village (the same world and village filter as before), the sends are counted by **①'s own outcome**:

| Outcome | Shown as | Meaning (①) |
|---|---|---|
| `landed` | 記録された | the transaction is on chain. **Not "arrived"**: arrival and fulfilment stay on the second line. |
| `failed` | 断られた | the program refused it |
| `expired` | 期限切れ | its blockhash ran out (it can no longer land) |
| `mismatch`, `seq-taken` | 確かめが要る | a transaction or caravan number that does not match the plan |
| `unknown`, or anything else | まだ確かめられない | not known yet. Never counted as one of the above. |

**What is shown:**
- **No line** when no send is recorded.
- **No advice is added:** whether to send again is said on ①'s own page, as ① words it.

**The view is read only if every send has an outcome** (`probeView`: otherwise `BadView`, said as unreadable).

**One key** is added in the same block of `lang/en-frontier-play.mjs`.

## Regression (written, NOT run)

**Appended to `web-frontier-ws07-coop-village-requests.test.mjs`:**
- the seven outcomes counted, with another village's send not counted;
- an unknown status counted as not known yet;
- no line without sends;
- a send without an outcome makes the view unreadable.

## Still in the loop

- **Arrival at the village** and the **cooperation outcome:** the second line shows ①'s fulfilment (bounds). ⑮'s verdict is held (no adopted ruleset).
- **After a restart:** the board refolds its records, and the card reads the view again (each config read marks it due). No state of the card is kept across loads.

## Hand-over (Lane D)

**Unit:** `claude/ws07-coop-village-sends-20261117`, one commit on `c18eee20`, all `100644`:
- `permutation-server/web/frontier/hud/coopboard.mjs` (M)
- `permutation-server/web/lang/en-frontier-play.mjs` (M)
- `permutation-gateway/test/web-frontier-ws07-coop-village-requests.test.mjs` (M)
- `docs/integration/CLAUDE-WS07-COOP-VILLAGE-SENDS-20261117.md` (A)

**Not run:** anything.
