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
- No WideSettleTransit planning. WideReveal planning exists (the section
  below) but only from a caller-supplied opening: the reveal plaintext and
  salt are not in the wire and are never derived here.
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

## Second slice (2026-11-08, on `579f0cfc`): the Reveal candidate and the admission review

Two more read-only modules behind the same feature. **Not compiled or run
by their author**; the parent runs the named tests. Nothing signs,
simulates, sends or enqueues; the engine's `ensure`/`poll`/`send` are not
called; the production debit gate and the legacy PSW1 guard are untouched;
no UI file is touched.

### `widereveal`: an unsigned WideReveal from a proof, an opening, a public beacon and reads

`plan_reveal(scope, fee_payer, beneficiary, &DepartProof, Option<&Opening>,
Option<&Publication>, &Reads) -> Step<RevealCandidate>` and the driver
`reveal_via` (at most six read rounds, the Clock read once and separately).
Source of truth: `proc/wide.rs::reveal` and `wide_ix::REVEAL`. Revised
2026-11-08 after the independent audit found that the first version could
export a plaintext-bearing instruction on an archive alone or on a
supplied plaintext with no round signature verified.

- **Publication gate, before anything destination-bearing.** For **both**
  openings the planner exports an instruction only when: a `Publication {
  round, sig48, pk96 }` is supplied (`PublicationMissing` otherwise); its
  round is exactly `SeasonClock::tlock_round(arrive)` (`BeaconRound {
  expected, got }`); `sha256(pk96)` equals the Season's `quicknet_pk_hash`
  (`BeaconKey`); the signature verifies under that key with
  `fclient::beacon::verify` (`BeaconSignatureInvalid`); THE canonical
  BellAnchor of `(arrive, region)` is **present** (`AnchorRequired("absent")`
  or `AnchorRequired("archive-only")` otherwise — the handler would read
  the archive; the keeper does not publish on it); and the anchor's stored
  round equals the verified round (`NotCanonical("anchor")` — the stored
  round alone proves nothing). The round/key/signature checks run right
  after the Season is read, before the transit record or the plaintext is
  looked at; the driver stops after the first read round without a
  beacon. These are verifications of supplied public vectors; no key or
  signature is generated.
- **The opening is the caller's and labelled.** `Opening::Supplied { plain,
  salt }` is checked against the proof's commitment and the record's root
  and labelled `Crypto::CommitmentOnly`: the program's own check and no
  statement about who produced the bytes. `Opening::FromBeacon` opens the
  IBE block with the stock opener (`fclient::seal::open_ibe`) under the
  **verified** round signature and the body with the ABI's `open_body`
  against the proof's commitment: `Crypto::IbeOpened`. Without an opening:
  `NoOpening`. The planner never derives a plaintext from a root.
- **The proof is rebound to the record as it is now.** The transit record
  at the proof's canonical address must be in transit, the holding's, and
  agree with the proof on host, arrival bell, seal root, standing/origin
  province, departure bell, tip, departure mass and march stamina
  (`ProofMismatch` names the field). A slot re-used by a later march is
  refused; `proofs_for` is a hint only and does not know. The proof's
  provenance (`signatures_verified: false`, its method string) is carried
  into the facts verbatim.
- **Handler checks replayed; order narrowed where it differs.** The Ended
  clause (`SeasonEnded`); `seal::unpack`/`validate` (`BadPlaintext`); the
  commitment (`CommitMismatch`); the destination from the plaintext,
  canonical and present, its stored region. **Then the path's provinces are
  derived by geometry alone** (which accounts to read) — the handler reads
  no path before the window and the latch, so the first refusal reported
  may differ from the program's. Then THE anchor and its window by the
  separately observed clock (`TimingNeedsClock`, `WindowClosed` at or past
  `A + W` or with the log at or past the seed round); the latch
  (`LatchClosed`); the mask walk over the destination and path provinces
  (`Path`) and the doctrine's travel time (`ArrivalBell`); the site and
  holding shields (`Shielded`); the quota (`AlreadyRevealed`,
  `QuotaRefused`), target slot and displaced host; the ArrivalDay, writable
  exactly when its bell bit is clear.
- **Mirrored program logic.** `walk_wide` and `wide_admit` are `pub(crate)`
  in the program; they are mirrored here over the ABI's `WideTile`,
  `path_step`, `wide_slot_key` and the kernel's travel constants, for the
  prediction only.
- **Candidate, and what it is not.** Accounts `[fee_payer s,w] [season r]
  [holding r] [transit r] [anchor r] [archive r] [beaconlog r] [inputs r]
  [dest r] [arrivalday r|w] [slot×4, exactly target writable] [ix_sysvar r]
  [system r]` plus path provinces; data `Reveal { transit_slot, target_i,
  plain, salt, ct_hash, beneficiary }`. A `RevealCandidate` is an unsigned
  instruction the handler's refusals did not fire on against these bytes —
  **not a validated or executable transaction**. `coherent: false`,
  `signed: false`, `automatic_send: false`; `facts.publication` records the
  verified round and key hash; `facts.unverified` (`UNVERIFIED`) names what
  is not checked: the fee evidence (the ComputeBudget prefix is **keeper
  policy**, not a handler mandate — the handler's evidence parser accepts
  defaults when none is present; `budget_prefix_policy` says so), the rent
  of the slot and day accounts the reveal may create, the fee payer's
  funding, the march's history before the applied records, the proof's
  source, and account/clock coherence.

### `widereview`: admission review against the engine, read only

`Subject::of_duty(&Candidate)` / `Subject::of_reveal(&RevealCandidate)` give
a stable key by full identity (`wide-settle-departure:<world>:<host>:<slot>`,
`wide-return:<world>:<standing>:<holding ref>`,
`wide-reveal:<world>:<host>:<slot>:<arrive>`, hex of canonical bytes), the
kind (`wide-settle-departure`, `wide-return`, `wide-reveal`), tag and class.
`review(subject, &EngineView)` returns the denials; `EngineView::of(&Engine,
&Subject)` reads only `feed_writes_allowed`, `allows_write_kind`,
`is_pending`, `care_unresolved`; `review_with_engine` combines them. **Six
denials are present on every review** (`HARD_DENIALS`): `SourceUnproven`,
`NoCoherentSnapshot`, `HistoryUnknown`, `ExecutionEvidenceUnverified` (fee
evidence, rent, funding), `SignerAbsent`, `SliceDoesNotEnqueue`; `admitted`
is `false` by construction; the engine's facts add `FeedWritesPaused`,
`KindNotAllowed`, `AlreadyPending`, `CareUnresolved`. **The engine does not
refuse wide kinds by itself**: `Engine::allows_write_kind` accepts any kind
while feed writes are allowed and refuses unknown kinds only while the feed
is paused (tested against a real `Engine`); the gate is this review and the
fact that nothing here builds a `WriteSpec` or calls `ensure`. The review
does not read the candidate's `coherent`/`automatic_send`/`signed` flags or
its `unverified` list: forging them changes nothing (tested). Not wired
into the keeper tick or `/v1/status`; an orchestrator calls it explicitly.

### Exact verification limitations (stated)

- The beacon signature is verified with `fclient::beacon::verify` under the
  supplied `pk96` whose hash must equal the Season's pin; the planner does
  not fetch drand, does not check the chain hash, and does not verify the
  anchor account's own `sig48` field (the anchor is matched by season,
  bell, region and stored round).
- A real wide seal opening is still not exercised: this test suite does not
  supply a valid public wide-seal vector for the positive opening path. The
  `FromBeacon` path is tested under the **verified** publication against a
  literal IBE block that the stock opener refuses (`SealOpen`); the
  positive `FromBeacon` path is untested.
- The positive **publication** path is tested with the shipped public
  quicknet rounds (`fclient/fixtures/quicknet`, real drand signatures): the
  fixture Season is laid out on the real quicknet clock so that
  `T(ARRIVE_BELL)` is the vector's round, and the Season pins the published
  key's hash. No signature was produced.
- Fee evidence, rent, payer funding, history and coherence are unverified
  and named on every candidate; the review denies on them.
- No WideSettleTransit; no status or tick wiring; no signer path at all;
  `Engine::ensure` is unreachable from these modules.

### Validation on the final local source

`frontier-node/crates/keeper/tests/wide_reveal.rs`: literal addresses, a
literal **labelled** `DepartProof` fixture (not extracted from a feed
record), a literal seal and salt, the shipped public quicknet rounds
(`fclient::beacon::FixtureDrand::load`, verified under the published key on
load), fixtures written with the ABI's encoders
(`WideProvince::write_identity`, `WideHolding::write_identity`,
`WideTransit::depart`/`step`/`to_bytes`, `WideArrivalSlot::write`,
`WideArrivalDay::write`), literal BellAnchor / BeaconLog / AnchorArchive
bytes at the layout offsets, and a fake `ChainPort` that counts and refuses
`simulate`/`send`. The engine used by the review test is
`Engine::new(Budgets::default(), EngineParams::default())` with no payer
pool and no key.

```sh
cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_reveal
cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_duties
cargo clippy --locked --offline -p keeper --features wide-world-experimental --lib --test wide_reveal --test wide_duties -- -D warnings
cargo test --locked --offline -p keeper --test wide_feed_guard
cargo clippy --locked --offline -p keeper --lib -- -D warnings
```

- `the_fixture_season_puts_the_vectors_round_at_t_of_the_arrival_bell`
- `reveal_plan_reads_in_rounds_builds_the_exact_accounts_and_labels_a_supplied_opening`
- `publication_gates_refuse_before_anything_destination_bearing_is_produced`
- `reveal_plan_rebinds_the_proof_to_the_record_as_it_is_now`
- `reveal_plan_blocks_on_opening_and_season_problems`
- `reveal_plan_judges_the_window_by_the_observed_clock_and_the_log`
- `reveal_plan_replays_latch_path_shield_quota_and_arrival_day`
- `reveal_driver_reads_in_three_rounds_at_the_bound_and_never_simulates_or_sends`
- `review_denies_every_wide_candidate_with_concrete_reasons_and_enqueues_nothing`

On the final local source, all 9 Reveal/review tests, 20 duty tests, 14 discovery tests and 12 legacy guard tests passed (55 total). The feature-enabled keeper library and both new test targets passed clippy with warnings denied; default-feature library clippy and feature-enabled binary compilation also passed. No keeper process was started. Independent static review found no remaining safety blocker in this read-only slice. The initial arrival-mismatch test expected the later proof comparison, while the publication round gate correctly refused first; both that early refusal and a current-transit arrival mismatch now have explicit assertions. Public quicknet verification succeeded, but positive FromBeacon wide-seal opening remains untested.

## Touched files

`frontier-node/crates/keeper/src/wideproof.rs` (new),
`frontier-node/crates/keeper/src/wideduty.rs` (new; second slice: new
`Block` variants and `pub(crate)` helpers),
`frontier-node/crates/keeper/src/widereveal.rs` (new, second slice),
`frontier-node/crates/keeper/src/widereview.rs` (new, second slice),
`frontier-node/crates/keeper/src/lib.rs` (four gated `pub mod` lines and
four module-table rows), `frontier-node/crates/keeper/tests/wide_duties.rs`
(new), `frontier-node/crates/keeper/tests/wide_reveal.rs` (new, second
slice), this document. No `Cargo.toml`, fclient, ABI, program, engine,
herald, web or UI file.
