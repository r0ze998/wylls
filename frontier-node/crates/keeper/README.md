# Keeper discovery compatibility guard

The legacy keeper does not implement PSW1/full-width world records. A successful
transaction containing PSW1 in this program's invocation frame now blocks both
land and play discovery. It is not counted as an empty page or "no work".

- The cursor stops before the first unsupported transaction. No part of a mixed
  PS2/PSW1 transaction is ingested. Later pages and raw-body library calls cannot
  clear the latch. Failed transactions and other programs' nested records do not
  count as this program's committed wide history.
- Missing, truncated, or unbalanced invocation provenance, malformed known
  records and unknown PS2 bodies also block discovery. The feed's account
  post-state is **not** verified by this guard. This is a compatibility refusal,
  not proof of complete chain or asset provenance.
- A journaled keeper persists the first blocker in its existing SQLite journal
  and reloads it before planning/sending game writes. A keeper without a journal
  retains it in memory and must replay from cursor zero on restart. Catch-up
  pauses game writes until an empty feed page is reached, so an earlier legacy
  prefix cannot temporarily authorize writes before a later unsupported record.
- The gate covers new work and already queued retries for land, play, conquest,
  rings, archives, closes and claims. Pending signatures are still reconciled;
  they are **not** reported as cancelled or successful. Independent beacon
  publication and payer care continue. Beacon sends remain ahead of feed reads.
- `/v1/status` exposes `discovery`, both last-applied cursors and the first
  blocker's sequence, slot, signature and reason. Metrics expose
  `frontier_keeper_discovery_blocked` and `frontier_keeper_game_writes_paused`.
  New reveal/nudge requests receive `503 DiscoveryUnavailable` while paused.
- Direct duty callers must use their index's guard. The built-in land/play
  entry points do so, and the Engine checks its durable blocker again at send.

There is intentionally no automatic reset or bypass option. Recovery requires a
reader that understands the encountered format, replay/reconciliation of the
missing discovery history and explicit migration of the blocker. **Do not delete
the transaction journal** or discard pending signatures to clear this state.

## Bounded verification

`cargo test --locked --offline -p keeper --test wide_feed_guard` runs only literal
byte fixtures, discovery parsing, SQLite persistence and planning gates. It does
not create keys, sign, send transactions, execute the program, or verify BLS.
`cargo clippy --locked --offline -p keeper --lib --test wide_feed_guard -- -D warnings`
checks the changed library and this test target. These checks are not an
end-to-end keeper/validator run or the full keeper/fclient library test suites.
