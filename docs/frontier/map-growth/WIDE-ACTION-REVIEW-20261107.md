# Wide action review in the game UI

The recorded-world sheet (`permutation-server/web/frontier/map/widemode.mjs`)
now lets a reader select a host-bearing PSW1 observation for full-identity
operation review. This is preparation, **not connected transaction execution**.
The existing legacy wallet, session, relay, and confirmation paths are unchanged.

`map/wideactions.mjs` consumes a pinned parsed history page. It retains the full
56-byte host, 56-byte holding, 50-byte observed standing province, world,
indexed-through sequence, and snapshot. It rechecks identity bytes and their
raw-record attribution. A legacy destination is rejected, and another world is
rejected. It does not infer current ownership, troop counts, standing location,
return eligibility or account currentness from historical events.

- Departure remains disabled: the production debit gate is off. The native
  unit-test gate is not a runtime capability; SBF departure is unsupported.
- Return remains disabled: no authenticated current account capture or complete
  account-meta construction is available in this UI. Its displayed unsigned
  bytes `dcff0102` are the exact provisional WideReturn envelope. Return operates
  on a holding and roster, not the selected individual host.
- `wideDepartData` produces only the ABI's 366 public instruction bytes from an
  issued review plus explicit slot, arrival bell, bigint tip, commitment and
  seal. It never generates a seal, key, transaction, signature or submission.
  These bytes are neither approval nor a deployability claim.

The review clears on loading, error, source change and stale-page selection.
Close prevents old controls from acting. Repeated selection replaces the review.
No history coordinate is inserted into the land map.

Validation: `node --test permutation-gateway/test/web-frontier-wide-world.test.mjs`
passes 24 fixed-public-data tests, including the new review, exact ABI offsets,
integer bounds, mixed-family refusal and DOM interruption/repetition checks.
The DOM harness is not browser/visual acceptance, and no live transaction or
wallet interaction was attempted. No full client/signing tests were run.
