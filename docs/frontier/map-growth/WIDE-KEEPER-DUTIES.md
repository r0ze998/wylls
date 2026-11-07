# Wide keeper duties, first slice: proof extraction and unsigned planning (2026-11-07, revised 2026-11-08 after independent review, on `d132baec`)

## Current checkpoint: snapshot-backed runtime review (2026-11-08)

The current source passes 79 audited tests: discovery 14, duties 30, legacy guard 12, Reveal 17 and real RpcPort loopback snapshot 6. Feature-enabled library/binary and the three snapshot/duty/Reveal test targets, plus default library/binary, pass clippy with warnings denied. Public FromBeacon opening uses pre-existing recorded IBE material and shipped quicknet signatures; no keypair or signature was generated.

The opt-in runtime now uses its actual port through an additive snapshot callback. Settle/Return and bounded Reveal diagnostic review use a single response for their final account/Clock/Rent judgement. Reveal proofs are extracted only from the observer-accepted portion of shared feed pages; supplied provenance remains unverified. Public beacon reads use a separate bounded cache, and transient readiness failures have bounded next-slot retries. Unset payer funding remains unknown. Status excludes raw RPC error strings and opened material.

Every candidate is still denied by Engine review: history authenticity/completeness, live fee quotation and future balance remain unproven. No enqueue, simulation, signing, transaction sending, production gate change, main merge or deployment is introduced. Existing PSW1 feed guards can prevent further discovery; this slice does not make the game playable. The actual Keeper constructor/full tick was not executed because it uses keys; its wiring and CLI are compile-checked, while independent review-step tests use literal accounts and public vectors. UI is unchanged.

Earlier sections are historical checkpoints. Their statement that Reveal/snapshot are not tick-connected is superseded by this checkpoint and the runtime slice below; they are not a claim of live-chain verification.

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

## Third slice (2026-11-08, on `c30dc259`): public-vector opening, snapshot, fees, tick review

Four additive pieces, same feature, same rules: nothing signs, simulates,
sends or enqueues; `Engine::ensure` stays unreachable from these modules;
the legacy PSW1 guard still stops game writes; no production handler, gate,
fclient, ABI or UI file changes. **Not compiled or run by the author.**

### Real `FromBeacon` opening of a recorded public vector

The recorded seal vector `valid_spv2_32551361`
(`permutation-rules/vectors/seal-vectors-v1.json`) carries the IBE block
sealed to quicknet round 32551361 and the key `k` the stock opener
recovers from it; the shipped quicknet fixture of that round carries its
real signature. The test `from_beacon_opens_the_recorded_public_vector_and_corruptions_refuse`
assembles a wide seal from the vector's IBE block and the fixture
plaintext's body under `k` (`seal::assemble`/`body_xor`), commits under
`salt_of(k)`, lays the fixture Season out so that `T(20)` is that round
(as `wide_land_runtime_tests` does), and plans with `Opening::FromBeacon`:
the publication gate verifies the shipped signature under the published
key, `fclient::seal::open_ibe` recovers `k` (real pairing and FO check,
the stock opener), `open_body` reproduces the commitment, and the
candidate is `Crypto::IbeOpened` with the derived salt in its data. A
flipped `V` byte is `SealOpen`; a flipped body byte is `CommitMismatch`;
another shipped round's real signature is `BeaconRound`; a record with
another root is `ProofMismatch("seal_root")`. **This is a fixture over
public material, not a live chain**; nothing was generated.

### `widesnapshot`: same-response accounts, additive

`SnapshotPort` (default `Unsupported`; implemented for `fclient::rpc::RpcPort`)
returns all requested keys, the Clock and, when asked, the Rent sysvar in
**one** `getMultipleAccounts` response with its exact `context.slot`
(`SnapshotMeta`, constructed only by the module). Bounds and refusals: at
most 98 keys (`TooManyKeys`), never chunked; a response with another entry
count (`Partial`), without `context.slot` (`Malformed`), or whose Clock or
Rent entry is absent or undecodable (`MissingClock`/`MissingRent`) is
refused. `Snapshot::reads` gives the planners `Reads` with the snapshot's
Clock and Rent; a `Candidate`/`RevealCandidate` planned over it is
`coherent: true` and carries the meta. `snapshot_plan` first learns the
key set through ordinary reads, then takes one snapshot of every key plus
the fee payer, then plans over that response alone — a plan that asks for
a key the response lacks is `SnapshotIncomplete`, never patched.
**Coherence is not currency** (the context slot is what the RPC served),
not source completeness, and not permission: the review replaces
`NoCoherentSnapshot` with `SnapshotCurrencyUnknown` and every other denial
stays. An equal `min_slot` on separate calls is never coherence; the
existing `ChainPort` and every port keep their behaviour.

### `widefees`: calculated requirements, declared assumptions

From the handler: `reveal` reads the fee evidence from the instructions
sysvar through `evidence::parse`, which yields **zero when a ComputeBudget
instruction is absent** — the prefix is keeper policy, not a mandate; it
creates the ArrivalSlot (288 B) when the arrival fills a free slot and the
ArrivalDay (144 B) when none exists, from the fee payer at the Rent
sysvar's minimum. `reveal_needs`/`duty_needs` calculate the rent of the
created accounts **only** from a same-response Rent sysvar (ABI sizes,
the runtime's `minimum_balance`, checked arithmetic), the base fee as
`5,000 × one signature assumed` (named), leave the priority fee and the
compute budget unchecked (no price is chosen; no measured row exists for
the draft band — the engine would request `CU_MAX` and the default loaded
limit), and bound the payer only from its account in the same response:
`MetLowerBound` means the balance at the context slot covers rent + base
fee and nothing about the fee or balance at send time; otherwise `Unmet`
with the shortfall or `Unknown` with the reason. The review adds
`FundingUnmet`/`FundingUnknown` accordingly and keeps
`ExecutionEvidenceUnverified` always.

### `widetick`: the bounded read-only tick review

`Keeper::enable_wide_review(Deployment)` (binary flag `--review-wide
<version_hex>:<ruleset_hash_hex>`, requires `--observe-wide`) adds one step
after `refresh_discovery`: at most `CANDIDATES_PER_TICK` (2) hints from the
observer's model per tick, round-robin, each not re-reviewed within
`REFRESH_SLOTS` (64), planned through the ordinary `ChainPort` reads
(≤ 3 rounds each plus one clock read; `coherent: false`, said so),
reviewed with the engine's public state and the fee review, recorded in a
ledger of at most 256 entries, and shown under `wide.review` in
`/v1/status` (addresses and hex identities only; no key material). The
payer named in those unsigned candidates is the zero address: no payer is
drawn. The step runs whether or not the legacy guard has fired and only
reads. **Why no snapshot here**: the keeper is generic over `ChainPort`
and the snapshot is an additive capability; requiring it would change the
keeper's bound for every port. An orchestrator with an `RpcPort` uses
`settle_departure_snapshot`/`return_snapshot`/`reveal_snapshot` directly.
A `Keeper` cannot be constructed in the keyless tests (its constructor
derives signing keys), so the step is tested directly
(`the_tick_review_plans_reviews_and_enqueues_nothing`) and the wiring is
compile-only.

### Review fixes (independent static review of the first version)

- **Sealed provenance, re-verified by every consumer.** `SnapshotMeta`
  now carries a SHA-256 digest over the whole response (requested and
  context slots, commitment, every key with presence, lamports, owner,
  executable flag and data, the Clock bytes, the Rent bytes) and is
  constructed only by `parse_snapshot_response`; `Snapshot`'s contents sit
  behind accessors. The public `Reads` stays mutable for compatibility, but
  `Reads::coherent_snapshot()` recomputes the digest over the reads it is
  given, and the planners, the fee review and the admission review decide
  coherence through it alone: an edited account, an added or removed key,
  a changed `min_slot`, a swapped clock or rent, or a meta cloned onto
  other bytes verify as nothing. `Candidate`/`RevealCandidate` hold the
  verified meta in a crate-private field (`coherent()` and `snapshot()` are
  methods); no caller constructs a candidate or sets a flag.
- **Candidate/fee/review binding.** `duty_needs`/`reveal_needs` calculate
  only when the reads re-verify as the snapshot **the candidate itself**
  carries (digest equality); otherwise rent is `Unchecked` and funding
  `Unknown`. `review_candidate(c, reads, view)` / `review_reveal(c, reads,
  view)` take the candidate and its reads and return an `Assessment`
  (review, needs, bound snapshot); the former free-form `Evidence` input
  is gone. A/B mixing (candidate of one response, reads of another) binds
  nothing and keeps `NoCoherentSnapshot`.
- **Response validation.** The request carries `minContextSlot`; the
  response's `context.slot` must be at or past it (`Stale`); the Clock and
  Rent entries must be owned by the sysvar owner, non-executable, of their
  exact lengths (40 and 17) and decodable, and the Clock's own slot must
  equal the context slot (`BadClock`, `BadRent`); duplicate requested keys
  are refused (`DuplicateKey`); cardinality exact; one request, no chunk
  merge.
- **Tick hook.** The read-only step runs **before** `publish`, whatever the
  discovery result, and the discovery result and every gate are handled
  exactly as before; the planners' lower bound is the tick's slot; the
  cap is `min(candidates_per_tick, CANDIDATES_PER_TICK)` at every step;
  the round-robin cursor advances by the positions inspected. The step is
  tested directly with a read-failing port and a three-hint model (a
  `Keeper` is not built: its constructor derives keys).
- **Rent.** The full `minimum_balance(size)` per created account is what
  the fee review requires (it never nets a prefunded account); the base
  fee stays a named one-signature lower bound;
  `ExecutionEvidenceUnverified` stays on every review.

### Second review round (independent static review of the fixed version)

- **Candidate content sealed to the snapshot.** The private snapshot field
  alone did not stop a caller from editing a candidate's public fields
  (`facts`, `duty`, `instruction`, `payer`/`fee_payer`, `min_slot`,
  `observed_clock`) and having the fee review calculate against the
  original response — e.g. `day_present = true` or `displaced = Some(..)`
  would have dropped a creation's rent. `Candidate` and `RevealCandidate`
  now hold a crate-private `Bound { meta, content }`: the verified
  `SnapshotMeta` together with a SHA-256 **content digest** computed by
  the planner over the instruction (program id, every account meta's key,
  signer and writable flags, data), every fact (`Duty`/`RevealFacts`,
  including the source provenance, publication facts and unverified
  lines), the payer (and beneficiary), `min_slot`, the observed clock and
  the status flag. The content digest never covers the bound itself, so
  there is no recursion between the snapshot binding and the content.
  `snapshot()` recomputes the content digest and returns the meta only
  when it matches; `coherent()`, `describe()`, `duty_needs`/`reveal_needs`
  and `review_candidate`/`review_reveal` all go through `snapshot()`, so a
  mutated candidate loses coherence, rent, funding and the bound
  assessment over the very reads that still verify as its snapshot. The `signed`/`automatic_send` flags are also encoded in the final content digest; modifying them loses the binding, and they never grant admission.
- **Sysvar `executable` strictness.** `fclient::rpc::parse_account`
  defaults a missing or non-boolean `executable` to `false`; the snapshot
  parser now requires the Clock and Rent JSON to carry
  `executable.as_bool() == Some(false)` before parsing the entry
  (`BadClock("executable")`/`BadRent("executable")` for missing, string,
  numeric, null or `true`). Ordinary accounts keep the generic parser's
  behaviour.
- **Rent wording.** The module doc and the `rent_rule` status line now
  distinguish the handler's **precondition** — `init::rent(size)`, the
  full minimum balance for the created size — from the creation's actual
  system transfer, which tops up only a prefunded address's shortfall. The
  review keeps requiring the full minimum as the safe bound and does not
  model the netting.
- **Provenance test fixed.** `snapshot_provenance_cannot_be_moved_onto_other_bytes`
  built its key list from the planned reads without the payer, so the
  "other response" never differed and the moved-meta assertion failed
  with identical snapshots. The test now requests the payer, asserts the
  two snapshots' digests differ and each verifies on its own, and checks
  both directions of moving a meta onto the other's bytes. The integrity
  check itself is unchanged.

### Third review round (canonical content bytes)

- **No `Debug` in the content digest.** The first content digest hashed
  `format!("{:?}")` of the facts; `WorldId`'s `Debug` prints four of its
  32 bytes, so two identities differing only later (a host, a holding, an
  origin, a standing, a destination, a displaced host, a path province, a
  return pick) hashed the same. `wideduty::Canon` is now a canonical,
  lossless encoder: scalars little-endian at full width, byte strings and
  sequences length-prefixed, options tagged, enums by a tag byte, strings
  by their bytes, identities by their full ABI bytes (`ProvinceKey` 50,
  `WideHostRef` 56, both carrying the 32-byte world). `SettleFacts`,
  `ReturnPick`, `ReturnFacts`, `Duty`, `Window`, `PublicationFacts`,
  `Provenance` and `RevealFacts` each write every field in declaration
  order; both `content()` methods (domains `…-v2`) hash the instruction,
  the facts, payer (and beneficiary), `min_slot`, the observed clock,
  `status_promoted_by_clock`, **and `signed`/`automatic_send`** — every
  exposed field. The parent's Rent `minimum_balance` boundary fix
  (`v >= u64::MAX as f64` refused) is kept.
- **Regressions.** `world_bytes_past_the_debug_prefix_are_candidate_content`
  (`wide_duties.rs`: a coherent settle and a coherent return candidate;
  the host's, origin's, standing's, holding reference's and pick host's
  world bytes 4/5/17/31 flipped with the instruction unchanged and
  `Debug` output asserted equal; every remaining return fact; each flag;
  flipped back is coherent again) and
  `world_bytes_past_the_debug_prefix_are_reveal_candidate_content`
  (`wide_reveal.rs`: a displacing arrival planned over one parsed
  response; host, destination and displaced worlds at bytes 4/5/17/31; a
  path province of a look-alike world; every remaining source, window,
  publication and label field; each flag). The earlier mutation tests
  now treat the flags as content.

### Tests added

- `from_beacon_opens_the_recorded_public_vector_and_corruptions_refuse`
  (recorded `k`, IBE block and public round signature only; nothing
  generated)
- `snapshot_parsing_refuses_partial_malformed_oversized_stale_and_bad_sysvar_responses`
  (second round: Clock/Rent `executable` missing, string, numeric, null,
  `true`; a plain account without the flag still parses)
- `snapshot_provenance_cannot_be_moved_onto_other_bytes` (every reads
  mutation and the A/B mixing cases; second round: the payer requested,
  digests asserted different, both directions of a moved meta)
- `snapshot_reveal_is_coherent_at_the_context_slot_and_the_fee_review_bounds_the_payer`
- `a_mutated_reveal_candidate_loses_its_snapshot_fee_bound_and_review`
  (second round: a funded, coherent reveal candidate; mutations of
  `day_present`, `displaced`, `day_bit_set`, `target_i`, `arrive_bell`,
  `crypto`, the publication flag, the source signature, the unverified
  lines, `fee_payer`, `beneficiary`, program id, data first/last/longer,
  account key/signer/writable/fewer/more/reordered, `min_slot`, clock
  changed/dropped, `status_promoted_by_clock`; A/B mixing of two coherent
  candidates over each other's reads and of mutated ones; the pristine
  pair still binds afterwards)
- `a_mutated_settle_candidate_loses_its_snapshot_fee_bound_and_review`
  (in `wide_duties.rs`, second round: a settle candidate planned over a
  literal-JSON snapshot parsed by `parse_snapshot_response` with the payer
  requested; the same mutation classes over `duty` fields and kind,
  `payer`, instruction, `min_slot`, clock, status flag; A/B mixing)
- `the_tick_review_plans_reviews_and_enqueues_nothing` (in `wide_duties.rs`:
  tick-slot bound, refresh window, blocked hint, read failure, hard cap and
  cursor, the settle subject key)

**Exact runtime coverage, stated.** The tick path reviews **Settle and
Return** hints over non-coherent `ChainPort` reads. It does **not** plan
Reveal (no proof, opening or beacon on that path) and does **not** use the
snapshot RPC; the snapshot planners (`settle_departure_snapshot`,
`return_snapshot`, `reveal_snapshot`) are orchestrator-callable and **not
runtime-connected**.

The earlier assertions on `unverified` now expect the coherence line to be
appended (or the currency line over a snapshot); no test constructs a
`Candidate` or `RevealCandidate` literal (the bound is crate-private). Run
the same commands as the second slice; the `--bin` build (`cargo build
--locked --offline -p keeper --features wide-world-experimental`) covers the
flag and the tick wiring, compile only.

Final validation: all 70 tests above passed on the same final source after canonical encoding and flag-binding fixes. The actual RpcPort was exercised against a local loopback HTTP stand-in, confirming one request, exact keys and configuration, context/Clock binding, stale-context refusal, foreign sysvar refusal and oversized input producing zero requests. No actual chain or keeper process was started. Independent final static review found no remaining blocker in the narrowed read-only slice.

### Limitations of this slice (stated)

- The tick path reviews with non-coherent reads; snapshot planning is
  orchestrator-only.
- The snapshot's `commitment` is the requested one (`confirmed`); the RPC
  does not echo it.
- The fee review names a one-signature base fee and reads no network fee;
  rent is calculated only with a same-response Rent sysvar; funding is a
  lower bound at the context slot.
- `FromBeacon` success is demonstrated on a recorded vector whose round
  signature is the shipped quicknet round; a live chain's anchor and
  records were not read.

## Fourth slice (2026-11-08, on `37d07ad0`): the snapshot and the reveal in the actual tick

Read only, opt in, bounded; nothing enqueued, signed, simulated or sent;
every gate as before. Written without compiling or running anything; the
parent compiles and runs it.

### The snapshot as an additive adapter

The keeper is `Keeper<P: ChainPort, D: DrandPort>`; requiring `P:
SnapshotPort` would change the bound for every port implementation.
`widesnapshot::SnapshotSource` is the **object-safe** form of `SnapshotPort`
(`snapshot_boxed` returning a pinned boxed future, a `label`), with a
blanket impl for every `SnapshotPort + Send + Sync` — the JSON-RPC port, a
fake port in a test, anything with the default `Unsupported`.
`snapshot_plan_with(port, source, …)` is `snapshot_plan` with the ordinary
reads from the `ChainPort` and the one response from the source;
`snapshot_plan` now delegates to it with `source = port`. The same planner
closures (`plan_settle_departure`, `plan_return`, `plan_reveal`), the same
three steps, the same refusals (`Snapshot(..)`, `SnapshotIncomplete(..)`),
the same sealed meta and content binding.

`Keeper::enable_wide_snapshot(Box<dyn SnapshotSource>)` attaches the
adapter to the review (needs the review); `main.rs` does so under
`--review-wide` with a second `RpcPort::localnet` to the same node. With a
source, every tick plan is judged over one `getMultipleAccounts` at the
tick's slot as `minContextSlot`; the candidate is coherent at the
response's context slot (never current; `SnapshotCurrencyUnknown` stays).
Without one, the ordinary-read planners run as before and every candidate
is non-coherent. A snapshot failure is a recorded block
(`snapshot_blocked`), never patched from other reads.

### The reveal, only from inputs that exist

The tick takes `Option<RevealInputs>` — the Season as the runtime last read
it (its clock names `tlock_round(arrive)`), a `&mut dyn PublicationSource`,
and the configured public beneficiary. `Keeper::tick` passes them only when
`self.season` is read and the review's beacon cache exists; otherwise no
reveal hint is listed and the status `missing` names exactly that.

- **Proofs**: `widetick::ProofStore` keeps ≤ `MAX_PROOFS` (64)
  `DepartProof`s, one per `(host, transit slot)`, a later sequence
  superseding, oldest evicted. `Keeper::refresh_discovery` offers every
  feed page it pulls to `ProofStore::observe_page`, which runs the existing
  `wideproof::depart_proof` (wire- and frame-bound, signatures
  **unverified**, labelled `ORIGIN_FEED`). `ProofStore::supply` stores a
  proof an orchestrator holds, labelled `ORIGIN_SUPPLIED`. The ledger
  records the origin of every reveal plan. Hints are the stored proofs
  whose march the observer's model does not show revealed, settled or
  closed (a model that knows nothing still yields the hint; the chain
  decides); a host whose latest march is in another slot yields none.
- **Publication**: `widetick::BeaconCache` (≤ `MAX_BEACON_CACHE` rounds),
  **separate** from the beacon duty's `Rounds` so a review ask never changes
  what the beacon duty asks or sends: one ask per round per slot, the served
  signature verified under the review's pinned key (the drand port's
  published key, taken at `enable_wide_review`) before use, a bad one
  counted and dropped. `DrandPublications { drand, cache }` is the
  `PublicationSource` the keeper passes. The planner's own gate still
  re-verifies the publication against the **chain's** Season pin and
  computed round; a round not served is `Block::PublicationMissing`,
  recorded with `publication_served: false`.
- **Opening**: always `Opening::FromBeacon` — the public round signature
  opens the IBE block through the stock opener. No plaintext, salt or key
  is held, derived outside the planner, or shown: the ledger stores
  `RevealCandidate::describe` (identities, counts, labels), not the
  instruction data. A test asserts the status text contains neither the
  plaintext, the salt nor the recorded `k`.

Nothing infers history or source authenticity: `HistoryUnknown`,
`SourceUnproven`, `ExecutionEvidenceUnverified`, `SignerAbsent` and
`SliceDoesNotEnqueue` stay on every reveal review; the Engine's write
gates, the legacy feed guard and the mixed legacy/wide refusal are
untouched; `DEPART_DEBIT_ENABLED` stays false.

### Bounds and status

≤ `CANDIDATES_PER_TICK` plans per tick over settles, returns and (with
inputs) reveals, in that order, same refresh window and cursor; each plan
≤ 6 read rounds + 1 clock read + ≤ 1 snapshot request + (reveal) ≤ 1 beacon
ask. `WideReview.review_payer` is the public address the unsigned
candidates name (zero unless set; the funding review bounds that account;
no CLI flag yet). The status gains `payer`, `snapshot` (source label or
`absent`, coherent count, blocked count), `reveal` (inputs at the last
step, proof store counts, plans, candidates, publications missing, the
opening and history statements) and `missing` (the exact gaps); `covers`
is composed from the configuration.

### Tests added

- `the_proof_store_feeds_reveal_hints_only_with_inputs_and_blocks_without_a_publication`
  (`wide_duties.rs`): a feed page through `observe_page` (one committed
  WideDepart stored with `ORIGIN_FEED`, a wireless record counted);
  replay a no-op; a later sequence supersedes, an earlier does not;
  eviction at `MAX_PROOFS`; hints against an empty model, an open march, a
  revealed march, a later march in another slot; the tick listing the
  reveal hint only with inputs, blocked `PublicationMissing` from a source
  that serves nothing (asked once, at the computed round); a boxed
  literal-JSON `SnapshotPort` as the review's source making the settle
  coherent at the response's context slot with the tick's slot as
  `min_slot`; a stale response recorded as a snapshot block.
- `the_tick_reviews_a_reveal_only_from_a_stored_proof_a_verified_beacon_and_the_public_opening`
  (`wide_reveal.rs`): the recorded public vector's seal and the shipped
  round signature; no proof → nothing listed, beacon not asked; a supplied
  proof over ordinary reads → an `IbeOpened`, non-coherent candidate with
  every hard denial, the publication fetched once and verified, no
  plaintext/salt/`k` in the status; the refresh window; the shared-port
  snapshot source → coherent, Rent included, one snapshot call, the
  assessment bound to the response's digest, rent calculated, zero payer
  unmet; a source serving nothing → `PublicationMissing`, one ask per slot;
  a corrupted or swapped signature counted bad and never used; the real
  one cached; no inputs → no hint and the gap named.
- `the_tick_review_plans_reviews_and_enqueues_nothing` (updated): the
  step's new `reveal` argument, the `snapshot.source: "absent"` and
  `missing` assertions.

```sh
cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_duties
cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_reveal
cargo clippy --locked --offline -p keeper --features wide-world-experimental --lib --bins --test wide_reveal --test wide_duties -- -D warnings
cargo build --locked --offline -p keeper --features wide-world-experimental
cargo test --locked --offline -p keeper --test wide_feed_guard
```

### Preliminary review fixes (before the parent's run)

1. **Supplied proofs never keep the caller's provenance.**
   `ProofStore::supply` sets `signatures_verified = false` and the method
   to `wideproof::METHOD_SUPPLIED` whatever came in; the feed path keeps
   the extractor's `METHOD_FEED`. The status never carries caller text.
2. **Reveal cooldown and invalidation.** The ledger entry carries `next`,
   a transient count and the proof sequence. A reveal whose outcome is
   transient (`widetick::is_transient`: `PublicationMissing`,
   `AnchorRequired` — THE anchor not landed or archive-only so far —,
   `TimingNeedsClock`, `SeasonNotStarted`, `SeasonDependsOnClock`, `Read`,
   `ReadLoop`, `Snapshot`, `SnapshotIncomplete`; a closed window, an
   existing reveal, key/commitment mismatches and every other refusal are
   not) is retried at the **next slot**, at most
   `MAX_TRANSIENT_RETRIES` (8) in a row, then waits
   `REVEAL_REFRESH_SLOTS` (8); a reveal candidate waits
   `REVEAL_REFRESH_SLOTS`; another block waits `REFRESH_SLOTS` (64), as
   the duties do. A **newer proof** for the same march (later sequence)
   invalidates the entry at once (`proofs_renewed`, `proof_renewed` on the
   summary).
3. **Minimum slot.** A reveal's reads and snapshot use
   `max(tick slot, proof slot)`; the summary records `min_slot`.
4. **Observer-accepted prefix, bounded extraction.** The observer now
   records `WideObserver::accepted_prefix` for the last page it was shown:
   `0` when it was already blocked, when the page came from another
   program, or when the page failed its order validation (the observer
   validates the whole page before applying any record, so `[8, 10, 9]`
   applies nothing); `k` when record `k` blocked it mid-page (records
   `0..k` processed, exact replays included); the page's length otherwise.
   `refresh_discovery` passes that number to `ProofStore::observe_page`,
   which offers exactly those records (a numeric sequence threshold is
   **not** used: a blocked observer at 100 shown a later page of 50s
   yields nothing). Records past the prefix are `dropped_unaccepted`,
   records past `MAX_EXTRACT_PER_PAGE` (64) on a page are
   `dropped_over_bound`; the status shows `records_seen`,
   `records_offered` and both drops. The observer's cursor, fingerprints
   and replay behaviour are unchanged.
5. **No raw error text in status.** `SnapshotError::code()` is a typed
   code (variant plus numbers or static strings; `Rpc` carries nothing);
   `snapshot_plan_with` puts that code in `Block::Snapshot`;
   `widetick::block_code` reduces `Read`, `Snapshot` (unknown or
   non-alphanumeric codes become `Snapshot(Other)`), `SealOpen`,
   `BadPlaintext` and `MarchValues` to their names and prints every other
   variant (static strings and numbers only) as is. Tests assert a
   credential-bearing URL in a port or RPC error never reaches the status.
6. **The placeholder payer.** `WideReview::review_payer` is
   `Option<Address>`; `set_review_payer` refuses the all-zero address (the
   System Program). Unset, the candidates name the placeholder, it is not
   requested in the snapshot, and `widefees` reports
   `Funding::Unknown(NO_PAYER)` whatever that account holds; the status
   says `payer: unset…` and lists it under `missing`.
   The `PortSnapshot` adapter's future captures the port borrow and an
   owned copy of the keys (never the unnameable intersection of two
   independent borrows, which failed to compile as E0700).
7. **The keeper's own port as the source.** `widesnapshot::SnapshotMode<P>`
   (`Off` | `ViaPort(SnapshotFn<P>)` | `Separate(Box<dyn SnapshotSource>)`)
   lives on the `Keeper`. `enable_wide_snapshot_via_port` (bound
   `P: SnapshotPort`, used by `main.rs`) stores a function pointer to the
   port's own `snapshot`; the tick wraps the port in `PortSnapshot` and
   passes it to the step. `enable_wide_snapshot(Box<..>)` remains the
   explicit separate-source form, labelled as a relation the keeper does
   **not** verify. The step takes `Option<&dyn SnapshotSource>`; the
   review stores no source. The status shows `snapshot_mode`.

Tests added: `a_supplied_proof_never_keeps_the_callers_provenance_claims`,
`proof_extraction_follows_the_observers_accepted_prefix_not_a_sequence_threshold`
(a real `WideObserver`: the out-of-order page `[8, 10, 9]` yields nothing,
an observer blocked at 100 yields nothing from `[50, 51]`, a mid-page
block keeps the records before it, an exact replay is accepted again with
no state change, a foreign program's page is refused, the per-page bound),
`reveal_hints_retry_next_slot_bounded_and_a_new_proof_invalidates_the_entry`,
`status_never_serialises_raw_error_text`,
`the_placeholder_payer_is_never_funding_and_cannot_be_set`,
`the_keepers_own_port_serves_the_snapshot_through_the_function_pointer`
(all `wide_duties.rs`);
`reveal_readiness_blocks_retry_next_slot_while_closed_windows_wait`
(`wide_reveal.rs`: the classification of every readiness and refusal
block; THE anchor absent at slot 7 → `AnchorRequired`, next slot; landed
by slot 8 → an `IbeOpened` candidate on the first retry; a candidate then
waits the reveal refresh; a closed window and `AlreadyRevealed` are not
retried before the full refresh; one beacon fetch throughout); the
`Revealed` fixture in `wide_duties.rs` uses the ABI's link-less record
shape; the reveal tick test supplies a forged provenance
and asserts the normalised one, and asserts the placeholder is not
requested and funding is unknown; the existing tick tests take the new
`snapshot` argument and the four-entry `missing` list.

### Remaining blockers and limits (stated)

- No end-to-end keeper process was built or run by the author; a `Keeper`
  is not constructed in these tests (its constructor derives keys).
- Setting a public review payer is an API (`set_review_payer`), not yet a
  CLI flag; unset, funding is simply not reviewed.
- The proof store's feed origin depends on the legacy discovery pulling
  pages (`refresh_discovery` returns early without land/play/rings/archive
  roles, and pulls nothing while the legacy indexes are blocked); then no
  proof is extracted and the status says so. Records past the per-page
  bound are dropped, not deferred to a later tick.
- The publication source verifies the served signature under the drand
  port's published key; a season pinned to another key gets `BeaconKey`
  from the planner's gate, as before.
- Reveal hints from the store are not pruned when the chain reveals the
  march; the planner answers `AlreadyRevealed` (a non-transient block,
  64-slot wait) until the model sees the record.

## Touched files

`frontier-node/crates/keeper/src/wideproof.rs` (new),
`frontier-node/crates/keeper/src/wideduty.rs` (new; later slices: new
`Block` variants, `pub(crate)` helpers, `Reads.snapshot`/`rent`,
the crate-private `Candidate.bound` (`Bound`, the `Canon` encoder and the
`canon` methods), snapshot drivers),
`frontier-node/crates/keeper/src/widereveal.rs` (new; third slice:
the crate-private `RevealCandidate.bound`, `reveal_snapshot`, the
unverified lines),
`frontier-node/crates/keeper/src/widereview.rs` (new; third slice:
`Evidence`, `review_with_evidence`, three denials),
`frontier-node/crates/keeper/src/widesnapshot.rs` (new, third slice;
fourth: `SnapshotSource`, `snapshot_plan_with`, `SnapshotError::code`,
`SnapshotFn`/`snapshot_via`/`PortSnapshot`/`SnapshotMode`),
`frontier-node/crates/keeper/src/widefees.rs` (new, third slice; fourth:
the placeholder-payer rule `NO_PAYER`),
`frontier-node/crates/keeper/src/wideproof.rs` (fourth: `METHOD_FEED`,
`METHOD_SUPPLIED`),
`frontier-node/crates/keeper/src/widetick.rs` (new, third slice; fourth:
`ProofStore`, `BeaconCache`, `PublicationSource`, `DrandPublications`,
`RevealInputs`, `block_code`, the snapshot argument, reveal hints and
retries, the composed status),
`frontier-node/crates/keeper/src/lib.rs` (gated `pub mod` lines and
module-table rows; third slice: the `wide_review` field,
`enable_wide_review`, the tick step, the `review` status entry; fourth:
`wide_beacon`, `wide_snapshot`, `enable_wide_snapshot_via_port`,
`enable_wide_snapshot`, the proof store fed from `refresh_discovery` with
the observer's block sequence, reveal inputs and the snapshot passed to the
step, `snapshot_mode` in the status),
`frontier-node/crates/keeper/src/main.rs` (third slice: `--review-wide`;
fourth: `enable_wide_snapshot_via_port` under the same flag),
`frontier-node/crates/keeper/tests/wide_duties.rs` (new),
`frontier-node/crates/keeper/tests/wide_reveal.rs` (new), this document.
No `Cargo.toml`, fclient, ABI, program, engine, herald, web or UI file.
