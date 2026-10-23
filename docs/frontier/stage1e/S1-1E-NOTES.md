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

## Step 2: nations (done)

Decisions K1 and K2: each faction's villages vote on its stances and on
expelling (or readmitting) one of its own.

- **The kernel** (`permutation-rules/src/frontier/nation.rs`): eligibility
  (a member that joined `ELIGIBLE_BELLS` = 288 ago), the window
  (`WINDOW_BELLS` = 144), the readmission wait (`READMIT_BELLS` = 432),
  the pass rule (`yes > no` and `yes ≥ 3`), the 64-byte `Proposal`. It is
  a new kernel name, so `RULESET_HASH_V3` was re-pinned.
- **The ABI**: account kind 22 `Nation` (`na‖faction`, 384 B: faction,
  next id, four proposal slots); Propose 0xBB, Vote 0xBC, SettleProposal
  0xBD (class D); codes `ProposalsFull` 91, `NotVoter` 92, `ProposalState`
  93; records NATION_PROPOSED 98, NATION_VOTED 99, NATION_DECIDED 100;
  entity kind 12. The contract's proposal could not hold both the target's
  key and its tag in 64 bytes; it keeps the key and the records carry the
  tag. Code 92 was drafted as `NotEligible`, which M1's code 43 already
  names; an ABI test now keeps names unique across both code spaces.
- **The program** (`proc/nation.rs`): Propose creates the Nation at its
  first use. One vote per Citizen per proposal: `VOTED[slot]` holds the id
  voted on, and a slot's next proposal gets a new id. One open proposal
  per proposer (`PROPOSED`). SettleProposal is permissionless once the
  window closes. It re-checks that the target still qualifies (an
  expulsion of someone already expelled settles as failed), writes the
  Season's `STANCES` cell for a passed stance, and for a passed expulsion
  sets `EXPELLED_SINCE` and `FLAG_EXPELLED` on every live holding of the
  target (all must be listed, in reference order); a readmission clears
  both. Every path that gives a holding an owner (PlaceHome, a settled
  ticket or outpost, both capture paths) sets the flag from its new
  owner's Citizen. So an expelled village's new holdings carry the flag,
  and a holding captured from an expelled village drops it.
- **Off-chain**: fclient builders and events. Verifier **V25**
  (`v25_nations`) re-judges every Propose, Vote and settlement from the
  states, with tamper classes T55 (a vote counted twice) and T56 (a
  stance no proposal passed). The keeper settles closed proposals
  (`keeper/src/nations.rs`, role `settle`). The herald publishes
  `h/nations.json` (stances, proposals with tallies, the expelled). The
  gateway allows a Nation's rent on Propose and counts it in the daily
  cap, and has texts for codes 91–93.
- **Measured** (LiteSVM `tests/nation.rs`): Propose 11,957 CU (with the
  Nation's creation), Vote 6,631, SettleProposal 8,074 (an expulsion with
  one holding). The budget rows are 20,000, 12,000 and 20,000.

## Step 3: domestic raids (done)

Decision K4: a clash never raids a caravan of the raider's own faction,
so a village shows instead that its host stood where such a caravan
stood.

- **RaidDomestic (0xBE)** `P + [caravan r] [province w] [host_holding r]
  [owner_citizen r]`, data `bell u32, entry u8`. The caravan is moving
  and belongs to the actor's faction but not to the actor. Its slot had
  it on a tile at `bell`, which is resolved, at most `RAID_DECIDE_BELLS`
  ago, and not raided there before. The actor's roster host `entry` has
  stood on that tile since `bell` or earlier, and none of the owner's
  hosts stands there (`NotOnTile`). The owner's Citizen is an account the
  contract draft lacked; the escort rule needs it to name the owner's
  holdings. The owner cannot raid its own caravan: its Citizen would be
  both the writable actor and the read-only owner, so the account check
  refuses it (`BadAccount`).
- The slot's raid opens as a clash opens one (`raid_off`, `raider`), with
  `raid_pos` set to the new marker `RAID_POS_DOMESTIC` (0xFE), which no
  clash writes. RaidCaravan and DefaultRaid then settle it unchanged.
  CARAVAN_RAIDED gains `domestic` (from the marker, so even a default
  burn knows it), and the opening is logged as RAID_OPENED (101).
- **Off-chain**: fclient builder and events; V23 re-judges RaidDomestic
  (tamper T57: the raider's host moved off the tile); the herald lists the
  domestic raids in `h/nations.json` (`domesticRaids`, the newest 64).
- **Measured**: 12,059 CU with a light roster; budget row 20,000.

## Steps 4–5

Not yet built: siege arms, forts in the clash.
