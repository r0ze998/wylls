# Can findex's `observed` epochs reach WS4's held report? Not by an adopted read contract (2026-11-17, source only)

**Branch:** `claude/observed-to-ws04-held-20261117`, cut from candidate d16048aa. Report only: no code changed.

**Nothing was run:** no compile, test, syntax check, import, scanner, HTTP, RPC, world or server.

**Protected and not changed:** WS4's 7baa4d93 and bcd29aac, 13's 5b2bed58, the manifest branch a99b961f, the candidate, C and D. Nothing was merged, cherry-picked or copied.

## Where each piece is

| Piece | Branch | In the candidate? |
|---|---|---|
| findex `observed` epochs in the archive manifest (`archive.rs` `ObservedSource`, `observed_for`) | `claude/findex-observed-source-20261117` @ a99b961f | no |
| WS4's read observation `ws04-observation/0` (`runexec::observation::read_observations(db_path, after, limit)`) | `codex/ws04-read-observation-20261116` @ 7baa4d93 | no |
| WS4's frame adapter (`fclient::read_observation`) | `codex/ws04-frame-observation-20261116` @ bcd29aac (local) | no |
| 12's held report of 4's page (`heldFromWs04Observation`) → `observeLive.ws04` → 13's port summary → the command | `claude/ws12-13-live-observation-20261116` @ 5b2bed58 | no |

**There is no consumer of 4's page in the candidate,** so a reader written on the candidate would reach nothing. A reader written on top of one unmerged branch would depend on two others (the format of a99b961f, and the page of 7baa4d93).

## Why a page's records cannot be paired with an archive's epochs

**Inside one findex store the pairing is real.** In a directory opened by `Findex::open` (`archive/` + `index.sqlite`, `findex/src/lib.rs:62`), the index's `tx.seq` is the archive's sequence number:
- `index.add` takes the archive-numbered records;
- catch-up replays the archive;
- an index ahead of the durable archive is truncated back to it;
- open fails unless `index.last_seq == archive.last_seq` (`lib.rs:98–128`).

**But 4's reader breaks the chain:**
- **No store identity:** `read_observations` is given a **DB path**, not a store directory. Its page records neither the path, the store, nor the manifest. A page's `archive_sequence` (the DB's `tx.seq`) therefore cannot be shown to belong to any particular manifest's epochs. Pairing by the number alone would be a guess (as the owner said: not by seq alone).
- **Not one snapshot:** even with the same directory, the index is read in one SQLite transaction while the manifest is a separate file. The index commits at once and the archive up to a second later (group commit), so an index row can be past the durable manifest. Such a row has no epoch (`observed_for` → `None`): it is unknown, and it must stay unknown.
- **Not evidence anyway:** an epoch is the producer's kind and settings (program **as configured**, commitment **as requested**, no genesis, no endpoint; a99b961f). It is not finality, world or authenticity evidence, and it lifts none of 4's held reasons.

## Options (decisions; none made here)

1. **WS4 reads both from the store directory (recommended, when a99b961f and 7baa4d93 are adopted).** `read_observations` takes the findex store directory, opens `index.sqlite` read-only in its transaction, reads `archive/manifest.json` in the same call, and writes into the page:
   - `store_pairing: {index_last_seq, manifest_next_seq, same_directory: true}`;
   - per observation, `observed` (the epoch as given, or `null` past the manifest's end), with every held reason kept and one more: `observed_is_producer_setting_not_evidence`.

   This is 4's code, and a change to its page format (`ws04-observation/0` → a new version).
2. **12 takes a manifest beside the page, with an operator's declaration that both came from one store.** The declaration is a label, so the pairing stays `archive_pairing_declared_unproven` and nothing is gained as evidence. Not recommended.
3. **Do nothing until 4's admission evidence exists** (world binding, finality, record identity, committed frame). The epochs then matter only as diagnostics.

**Until one of these is decided:**
- every 4 observation stays held with its reasons;
- the archive's epochs are not attached to any record;
- no unknown becomes known, and no producer setting becomes chain, finality or world evidence.
