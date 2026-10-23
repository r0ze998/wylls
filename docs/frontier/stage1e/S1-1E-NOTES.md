# Stage 1e: forts, palisades, nations (notes)

Contract: [S1-1E-CONTRACT.md](S1-1E-CONTRACT.md). Design: the owner's
choices K1–K4 (`docs/design/redesign/99-decisions.ja.md`), the memo
`docs/design/redesign/31-stage1e-plan.ja.md`. Before this:
[stage 1d](../stage1d/S1-1D-NOTES.md).

Stage 1e is built in five steps (contract §9), each committed on its own.

## Step 1: structures (done)

1d's tower became one of three structure kinds; the rest of 1e builds on
this.

- **The kernel** (`permutation-rules/src/frontier/structure.rs`, was
  `tower.rs`): the kinds (tower 1, palisade 2, fort 3), their per-citizen
  limits (2, 4, 1) and costs; the Province list now carries the kind in
  each entry; `stops(stances, nation, faction, expelled)` is the one rule
  for who a work stops; `watch` gives a walker's `wear` (stopping towers'
  coverage) and `block` (stopping palisades' tiles) for a Province;
  `march_watch` and `caravan_watch` walk with them and answer
  `Walked::Secs` or `Walked::Blocked`. Forts are ignored by the walk.
  The kernel name changed, so `RULESET_HASH_V3` was re-pinned.
- **The ABI**: account kind 21 is `Structure` (`KIND @126`); BuildStructure
  carries a `kind`; the Province gains the fort block (`FORTS @4708`, two
  14-byte records: tile, faction, gen, state, troops, pending); the
  Citizen gains the palisade and fort counters, `EXPELLED_SINCE`, `VOTED`
  and `PROPOSED` (step 2 writes them); the holding's `FLAG_EXPELLED`; the
  Season's `STANCES @516` (36 bytes, all zero = all WAR). New code
  `FortManned` (90). Vectors and the web SDK regenerated.
- **The program**: BuildStructure checks the kind and its own limit and
  cost, and a fort takes a free fort record (`StructureFull` when both are
  taken); SeizeStructure of a fort needs it fallen (no troops, none
  pending: `FortManned`) and moves the record with the account;
  CloseStructure clears it. Reveal reads the Season's stances and the
  holding's expelled flag; a step into a stopping palisade is `Path`, and
  a stopping tower wears as in 1d. A caravan route through a stopping
  palisade is `Path`.
- **Off-chain**: fclient builders and events carry the kind; verifier V24
  (`v24_structures`) judges every kind and the fort record, and replays
  Reveal and caravans through `march_watch`/`caravan_watch`; the herald's
  feed is `h/structures.json` (every live structure, with its kind; only
  towers sight); the gateway's rent and texts follow.
- **Tests**: LiteSVM `tests/structure.rs` adds building palisades and
  forts, fort seizure, the stop rule at Reveal (own palisade passes,
  hostile one is `Path`, PASS and ALLY let through, the stance is
  one-sided, an expelled owner is stopped by its own nation, a PASS tower
  wears nothing), forts not stopping marches, and a palisade stopping a
  caravan.

### Reveal's CU limit

Every season this program runs is S1 (it refuses others). Reading the
stances and the structure list costs Reveal about 300 CU even when nothing
stands, which takes the worst walk past the MC row's 26,000 (FirstOfBell
26,181). Reveal is therefore gated at the S1 limit (`REVEAL_CU_LIMIT_S1`,
28,000; 1d contract §5.6) everywhere: the LiteSVM client profile uses
`cu_limit_s1`, as fclient's `canonical_s1` and the JS client's S1 profile
already did. The worst with a full list of hostile towers in all four
Provinces stays under it (27,586).

## Steps 2–5

Not yet built: nations (proposals, votes, stances, expulsion), domestic
raids, siege arms, forts in the clash.
