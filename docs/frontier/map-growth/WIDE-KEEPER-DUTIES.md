# Wide keeper duties, first slice: proof extraction and unsigned planning (2026-11-07, revised 2026-11-08 after independent review, on `d132baec`)

Two **read-only, opt-in** keeper modules behind the existing feature
`wide-world-experimental`: `frontier-node/crates/keeper/src/wideproof.rs` and
`frontier-node/crates/keeper/src/wideduty.rs`. Neither signs, simulates, sends
or queues anything; the engine never sees their output; the production debit
gate (`DEPART_DEBIT_ENABLED`) stays closed; the legacy PSW1 feed guard is
untouched; the mixed legacy/wide movement stays refused. **Not compiled or run
by their author**; the parent runs the named tests. Production behaviour and
any signed execution remain unverified.

## What the slice does

**`wideproof`** recovers the one thing the wide `Departed` record does not
carry — the Depart **commitment** (32 B) and the **wide seal** (264 B) — from a
committed feed record's transaction wire, and binds them to the `Departed`
record the same instruction logged. The record carries only the seal root
`sha256(commit ‖ sha256(seal))`; the planner of a future WideReveal /
WideSettleTransit needs the two preimages, and the wire is the only place
they exist.

**`wideduty`** plans the two **permissionless** wide settlements —
WideSettleDeparture (0xDC op 3) and WideReturn (0xDC op 2) — as **unsigned**
`solana_instruction::Instruction`s from current account reads, replaying the
dispatcher's preconditions over the decoded state and naming the first one
that fails. A plan is a prediction from a read; the program decides again on
execution.

## The audit's rules, as implemented

The independent audit's findings shaped the extractor:

- **The typed reader cannot bind wire to frame.** `fclient::typed_log`
  flattens committed records across frames. `wideproof` therefore walks the
  log frames itself (same grammar as `decode_transaction`: `Program <id>
  invoke [n]`, `success`, `failed:`, `Program data:`, `Log truncated`), keeps
  the **depth-1 frames of the program** apart, and requires their count to
  equal the count of the program's **top-level instructions in the wire**
  (ComputeBudget instructions log no frame and are not counted). Instruction
  *k* of the program binds to frame *k*. Any invocation of the program at
  depth > 1 — a CPI into it — is `Unavailable::NestedInvocation` for the whole
  transaction. A frame count mismatch is `FrameCount`.
- **Exactly one `Departed` inside the Depart's own frame.** Zero or several is
  `DepartedCount(n)`. A `Departed` in another frame of the program, or in a
  foreign program's frame, is never attributed to this Depart. A failed CPI
  subtree below the frame loses what *it* logged, not what the frame logged.
- **Bounds before any decoder.** Conservative, stated limits
  (`wideproof::MAX_*`): the wire at most the transaction packet (1,232 B);
  a one-byte signature count of 1–127; a **legacy** message (a versioned
  message's first byte has its top bit set and is refused before `from_wire`);
  at most 1,024 log lines of at most 4,096 bytes; at most 64 data lines per
  program frame; a base64 body at most the encoded `event::MAX_BODY`;
  invocation depth at most 5 (the runtime's); at most 256 account keys and
  **no duplicate key**.
- **`from_wire` is only bincode.** After the bounds: the legacy re-encoding
  must reproduce the bytes exactly (trailing bytes and non-canonical
  short-vecs fail this); the header arithmetic (`num_required_signatures ≥
  1`, readonly counts within bounds, keys ≥ signers); every program index
  and account index in range; no signer named as a program; the fee payer
  writable; the signature count equal to the header; **the first signature
  byte-equal to the record's**. No signature is verified, no key is created
  or derived; the identity check only stops a wire that belongs to another
  record from being bound to this one, and the proof says so
  (`provenance.signatures_verified: false`).
- **Every program record first.** `fclient::typed_log::decode_transaction`
  must accept the whole transaction before the frame-specific binding runs:
  a malformed `PS2` or `PSW1` line or an unknown data tag in **any** frame of
  the program — the Depart's or another instruction's — is
  `Unavailable::Records`. A well-formed `PS2` record beside the `Departed` is
  allowed (it is not a wide record).
- **Committed only.** `err` set → `RolledBack`; a failed depth-1 frame with
  `err: None` → `Frame` (inconsistent record); `Log truncated` → `Truncated`.
- **ResidentAct is a direct inner handler, not a CPI.** A 0xDD instruction is
  unwrapped only when `WideCommand::decode` gives a `ResidentAct` whose inner
  command is a `Depart`, and only when the account list is the `DEPART` table
  (13 positions) followed by **exactly four unsigned, read-only** proof
  accounts (`resident_act` splits the last four off). **The actor signs under
  an act too**: `depart_as` runs `check_accounts(DEPART)` under both
  authorities and the resident start requires the actor's and the payer's
  signature flags (the earlier exemption was wrong and is removed).
- **Flags as the prologue checks them.** Every signer position signed; every
  `Wr::W` position writable; a `Wr::R` position of a program-account
  category (`Acc::Kind`/`Either`, e.g. the Season and the Citizen) not
  writable; a `Wr::R` wallet or `Any` position **may** be writable, so an
  actor that is also the payer and a standing province that is also the
  holding's own are valid writable aliases (tested); and of the four
  `Wr::Either` transit positions the **departing slot's must be writable**
  (the handler writes that record); another slot's writability is the
  handler's.
- **Exact match.** Host reference (56 B), transit slot, arrival bell and tip
  equal between record and instruction; the record's header bell equals its
  payload's departure bell; `seal_root(commit, ct_hash(seal))` (the ABI's own
  functions) equals the record's root; the record's standing key, the host
  and the scope's world agree; **the host's and the standing province's rings
  are wide** (`≥ FIRST_WIDE_RING`, checked explicitly, not inferred from the
  PDA equalities); the seal's first byte carries the handler's flag syntax
  (`seal_flag_ok`: bit 7 set, bit 6 clear); the accounts at the dispatcher's
  positions are the canonical addresses: Season = scope, holding =
  `holding_address(host coord, site)`, standing province =
  `province_address(record standing)`, system, holding's own province =
  `province_address(host coord)`, all four transit records in slot order,
  roster = `roster_address(record standing)`.
- **Nothing inferred from the wire.** `dep_mass`, `march_stamina`, `fee` and
  `bond` are copied from the **record**; the current owner is not read at
  all. A root mismatch is reported as a mismatch, not as any statement about
  the seal's contents.
- **One Depart per transaction** in this slice (`SeveralDeparts` otherwise).

## The planners, against the handlers

Source of truth: `permutation-frontier/src/proc/wide.rs`, `settle_departure`
and `settle_return`. Both planners are pure over a `Reads` map (address →
`Option<Account>`, `None` = absent) and return `Step::Need(addresses)` until
they have what the next check depends on, then `Step::Done(Result<Candidate,
Block>)`. The async drivers `settle_departure_via` / `return_via` loop over
`ChainPort::accounts(keys, min_slot)` (at most four rounds) and call
`ChainPort::clock` once, separately. They never call `simulate` or `send`.

**The Season, for both** (`settle_season`): present, program-owned,
decodable, at the PDA of its stored id and bump. Effective status: stored
`Running` or `Ended` pass; stored `Seeded` is promoted to `Running` by the
handler's own rule (`now ≥ genesis_ts`) **against the separately observed
clock only** — no clock observed → `SeasonDependsOnClock`; clock before
genesis → `SeasonNotStarted`; promoted → the candidate carries
`status_promoted_by_clock: true` beside `coherent: false` (the observation
is the handler's rule applied to a clock that is not one context with the
reads; no equivalence with execution is claimed). The deployment is
**pinned** by the caller (`Scope.deployment: Option<Deployment {
program_version, ruleset_hash }}`): no pin → `DeploymentUnpinned`; the
Season's `program_version` must equal the pinned one exactly
(`ProgramVersion { expected, got }`) and carry the wide bit; its ruleset
hash must equal the pinned one (`RulesetHash`). The planner never chooses a
deployment.

**SettleDeparture** (`plan_settle_departure(scope, payer, host, slot, reads)`),
in the handler's order after the Season: host of this world (`World`); slot
below four (`BadSlot`); the holding at its canonical address present, this
season's and world's (`Absent`, `ForeignOwner`, `Unreadable`,
`NotCanonical`); the transit record of the slot present (`NoMarch`), the
host's (`TransitOtherHost`), state `Departed` (`AlreadySettled` once
settled, `TransitState` otherwise); the origin the record names, canonical
and present; the capture lock read in the origin **only when it is the
holding's own** (`CapturePending`); `resolved_next > depart_bell`
(`TooEarly`); the roster present and paired with the entry table
(`RosterUnpaired`); the entry at the host's alias (`NotResident`), vouched
for by the roster (`EntryUnpaired`), in state 3 (`EntryState`); the kernel's
`Host::march_values` (`MarchValues`); and the event chains of the origin
and the holding with room for one record each (`ChainOverflow`). The
candidate's six accounts are exactly `[payer s,w] [season r]
[origin_province w] [holding w] [roster w] [transit w]` with
`SettleDeparture { host, transit_slot }.to_bytes()`. The facts carry the
kernel's post-clash values (`kernel_troops_milli`, `kernel_stamina`),
`predicted_destroyed = kernel troops < 500`, and **what the record would
store**: `troops_after_milli` and `stamina_after` — both **zero when
destroyed** — and `ready_bell_off = ready_bell − depart_bell` saturated at 0
and `u16::MAX`.

**It is permissionless.** The holding's current generation and owner are
**not** compared with the host's reference; a transferred Citizen or a
re-founded site does not block. (Tested.)

**Return** (`plan_return(scope, payer, standing, holding_ref, reads)`): Season
as above; the standing province canonical, present, this world's (a legacy
Province v2 at the position is `Unreadable("province")`: the legacy/wide
boundary, refused as the program refuses it); the roster present (`NoRoster`
= the handler's `AlreadyDone`) and paired; the holding **present or absent**:
present → world, canonical, the capture lock read in **its own** province —
the standing one when the hosts return where their holding is, else the
**tenth account** (`holding_province`), which the planner asks for exactly
then and refuses `Absent` when missing — and `live = Some(gen)` iff the record
is provisional or final; absent → `live = None`. All **four** transit records
at their canonical addresses, each absent or decodable (`Unreadable`). Then
the handler's selection in entry order: state-3 `Leave` entries whose roster
reference (alias checked) names this holding by world, coordinate and site;
a host with **any present** transit record is skipped (`skipped_in_transit`);
`credited = live == Some(ref.gen)`; at most `RETURN_MAX` (3) picks. None
picked → `HostInTransit` if any was skipped, else `NothingToReturn`. The
reserve credit is pre-checked with the handler's checked add
(`ReserveOverflow`). The event chains must have room for every record the
return would log: the province takes one record per picked entry (`Return`
or `Stranded`), the holding one per **credited** entry (`ChainOverflow`,
including the multi-pick case; an absent holding or all-stranded picks
touch no holding chain). Accounts: `[payer s,w] [season r] [province w]
[roster w] [holding w] [transit r]×4` plus `[holding_province r]` for a
foreign return; data `Return.to_bytes()`. An absent holding is still named
at its canonical address (nine accounts); its hosts strand, and the facts
say so.

**Coherence.** `ChainPort::accounts(min_slot)` is a lower bound, not a
context slot, and the clock is another call. Every `Candidate` carries
`min_slot`, `observed_clock` (if the driver read one), `coherent: false`,
`signed: false`, `automatic_send: false`; `wideduty::AUTOMATIC_SEND` is a
constant `false`. A candidate is not evidence the instruction would succeed.

**Observer tie (opt-in, read-only).** `settle_candidates(&WideDiscovery)`
lists `(host, slot)` pairs whose `Departed` was seen without a
`DepartureSettled` and whose march is open; `return_candidates` lists
`(standing, holding_ref)` pairs with a host whose last presence was a
Dissolve. Both are hints of what to **read**; nothing is done with them here,
and nothing in `lib.rs` consumes them (the two modules are exported only).

## What this slice does not do (stated, not filled)

- No signing, simulation, sending, engine queueing, journaling, or status /
  CLI wiring. The keeper tick does not call these modules.
- No WideReveal / WideSettleTransit planning: the recovered commitment and
  seal are returned to the caller as data; the reveal plaintext and salt are
  not in the wire and are not derived.
- The Season's exact program version and ruleset hash are **checked against
  a caller-supplied pin only**; the planner does not know or choose the
  deployed build, and blocks without a pin.
- `RETURN_MAX` is mirrored from `permutation_frontier::proc::clash::RETURN_MAX`
  (a program constant the keeper crate cannot import) for the prediction
  only; the program applies its own.
- One Depart per transaction; several within the supported bounds are `SeveralDeparts`. The two-sealed-instruction test exceeds the packet bound and is refused earlier as oversized; that bound is not relaxed.
- A stored `Seeded` season is judged by the separately observed clock, which
  is labelled as such (`status_promoted_by_clock`, `coherent: false`); no
  claim of equivalence with the handler's clock at execution.
- A `Candidate` compares nothing with the wall clock and reads no log as
  authorization.
- The wire and log bounds are conservative choices of this slice
  (`wideproof::MAX_*`), not protocol constants; a real record beyond them is
  reported unavailable, never trimmed.

## Validation (local host, fixed public data)

`frontier-node/crates/keeper/tests/wide_duties.rs`: literal addresses,
literal 64-byte signature bytes, transactions built with `fclient::tx::message`
and `Transaction::new_unsigned` (no key, no signing), account fixtures written
with the ABI's own encoders (`WideProvince::write_identity`,
`WideHolding::write_identity`, `WideRoster::write_header`/`claim`,
`WideTransit::depart`/`to_bytes`, `entry::write_entry`), literal log lines, and
a fake `ChainPort` that counts and refuses `simulate`/`send`.

```sh
cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_duties
cargo clippy --locked --offline -p keeper --features wide-world-experimental --lib --test wide_duties -- -D warnings
cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_discovery
cargo test --locked --offline -p keeper --test wide_feed_guard
cargo clippy --locked --offline -p keeper --lib -- -D warnings
```

- `settle_plan_asks_for_reads_in_two_steps_then_builds_the_exact_six_accounts`
- `settle_plan_is_permissionless_over_owner_and_generation`
- `settle_plan_blocks_exactly_where_the_handler_refuses`
- `settle_plan_requires_the_pinned_deployment_and_judges_seeded_only_by_the_observed_clock` (new)
- `settle_plan_predicts_the_stored_values_and_refuses_chains_without_headroom` (new)
- `return_plan_credits_a_live_holding_at_the_reference_generation_and_strands_otherwise`
- `return_plan_adds_the_tenth_account_for_a_foreign_holding_and_reads_its_lock_there`
- `return_plan_reads_all_four_transit_positions_and_settles_at_most_return_max_in_entry_order`
- `return_plan_refuses_event_chains_without_room_for_every_record_it_would_log` (new)
- `return_plan_refuses_the_legacy_wide_boundary_and_other_worlds`
- `the_driver_reads_through_the_port_at_the_requested_bound_and_never_simulates_or_sends`
- `proof_binds_the_commitment_and_seal_of_a_plain_depart_to_its_departed_record`
- `proof_unwraps_a_resident_act_only_with_exactly_four_readonly_proof_accounts`
- `proof_enforces_the_prologue_flags_under_both_authorities_and_accepts_wallet_aliases` (new)
- `proof_validates_every_program_record_through_the_typed_reader_first` (new)
- `proof_refuses_legacy_rings_bad_seal_flags_and_out_of_bound_inputs` (new)
- `proof_is_unavailable_on_rollback_missing_or_non_canonical_wire`
- `proof_requires_exactly_one_departed_inside_the_depart_instructions_own_frame`
- `proof_refuses_every_field_account_or_world_mismatch`
- `candidates_come_from_the_discovery_model_as_hints_only`

On the final local source, the 20 wide-duty tests, 14 existing discovery tests, and 12 existing legacy guard tests passed (46 total). Feature-enabled library and new-test clippy passed with warnings denied, as did default-feature library clippy. The feature-enabled keeper binary compiled but was not started. Independent static review found no remaining blocker in the corrected areas. Two initial failures were refusal-reason ordering and an oversized two-Depart fixture; validation remains strict and the tests now require the explicit correct refusal. This is unsigned planning over supplied bytes, not handler execution, a running keeper, a browser walkthrough, or a real chain transaction.

## Touched files

`frontier-node/crates/keeper/src/wideproof.rs` (new),
`frontier-node/crates/keeper/src/wideduty.rs` (new),
`frontier-node/crates/keeper/src/lib.rs` (two gated `pub mod` lines and two
module-table rows), `frontier-node/crates/keeper/tests/wide_duties.rs` (new),
this document. No `Cargo.toml`, fclient, ABI, program, herald, web or UI file.
