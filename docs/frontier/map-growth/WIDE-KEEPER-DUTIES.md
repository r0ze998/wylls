# Wide keeper duties, first slice: proof extraction and unsigned planning (2026-11-07, revised 2026-11-08 after independent review, on `d132baec`)

## Current checkpoint: snapshot-backed runtime review (2026-11-08)

The current source passes 96 audited tests: discovery 14, duties 46, legacy guard 12, Reveal 18 and real RpcPort loopback snapshot 6. Feature-enabled library/binary and the three snapshot/duty/Reveal test targets, plus default library/binary, pass clippy with warnings denied. Public FromBeacon opening uses pre-existing recorded IBE material and shipped quicknet signatures; no keypair or signature was generated.

The opt-in runtime now uses its actual port through an additive snapshot callback. Settle/Return and bounded Reveal diagnostic review use a single response for their final account/Clock/Rent judgement. Reveal proofs are extracted only from the observer-accepted portion of shared feed pages; supplied provenance remains unverified. Public beacon reads use a separate bounded cache, and transient readiness failures have bounded next-slot retries. Unset payer funding remains unknown. Status excludes raw RPC error strings and opened material.

A further parity review keeps settled-but-unrevealed departures eligible for Reveal hints, validates known-ineligible payer shapes and aliases, leaves System data/nonce eligibility Unknown, and exposes downstream generation-mismatch settlement risk without changing game rules.

Explicit --follow-wide (requiring --observe-wide) now continues read-only wide observation with an independent in-memory cursor after legacy feed guards stop. It never advances legacy cursors or reopens write gates. Strict page/record/aggregate-byte limits reject before observer processing; network response allocation itself is outside these limits. Restart replays from empty observation, and source completeness remains unknown.

The archive/index interoperability test now drives real WideFindex, SQLite rebuild, archive transaction reads, keeper observer/proofs, and a snapshot-backed unsigned candidate. Raw program-filtered feed sequences (10/20/30), archive sequences (1/2/3), and event-page IDs are distinct. Observer verifies local per-identity head continuity after its first observed unverified anchor; dedicated index validates from genesis. Neither proves source authenticity. Raw sequence holes remain unknown, not automatically corrupted.

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

## Parity inspection (2026-11-08, on `acd95624`): planners against the handlers

Static, line by line, `permutation-frontier/src/proc/wide.rs`
(`settle_departure`, `settle_return`, `reveal` and the helpers they call:
`settle_season` → `prologue::season` → `read_season`/`check_season`,
`require_wide_season`, `holding_at`, `transit_at`, `province_at`,
`canonical_province`, `roster_at`, `host_entry`, `open_transits_of`,
`capture_lock_of` → `capture_locked`, `walk_wide`, `wide_admit`,
`init::is_absent` → `addr::absent`, `init::rent`) against
`wideduty::plan_settle_departure`, `wideduty::plan_return`,
`widereveal::plan_reveal` and their helpers. Nothing was run.

**No direct-handler parity discrepancy found** — a claim about the three
planners against the three handlers they mirror, and nothing wider: the
independent audit found three problems **outside** that comparison (the
reveal hint filter, the fee review's payer eligibility, the downstream
settlement of a generation mismatch), fixed below. Within the comparison,
every refusal the handlers make, the planners make at the same point with
the same inputs; every extra check the planners make is stricter (a
refusal where the handler would proceed), never looser. Checked
equivalences, in handler order:

- *Season*: `effective_status` (only Seeded moves, at or after genesis)
  then `[Running, Ended]`; the ruleset hash; the build's version with the
  wide bit — the planner: the same promotion against the observed clock,
  the pinned deployment (version + bit, ruleset). The planner refuses
  without a clock where the handler always has one (stricter).
- *Absence*: System-owned **and** no data, lamports ignored, on both sides;
  any other shape at a canonical position is `BadAccount` there and a typed
  block here.
- *SettleDeparture*: host world; holding at the reference's canonical
  address (record coord/site re-derived); `transit_slot < 4`; the record
  present (`TransitState` ↔ `NoMarch`), the host's, `Departed`
  (`AlreadyDone` ↔ `AlreadySettled`, else `TransitState`); the origin the
  record names, canonical; the capture lock only when the origin is the
  holding's own; `resolved_next > depart_bell` (`TooEarly`); the roster
  present and paired (`validate_paired` over `live_ids`); the entry at the
  host's alias paired with its reference (`host_entry` ↔ `find_entry` +
  `entry_matches`) in state departed; `Host::march_values`; `destroyed =
  troops < DESTROYED_BELOW` with zero values stored; `ready_bell_off`
  saturating; the record chained to the origin and the holding
  (`chain_headroom`). `WideTransit::step` cannot fail from `Departed`.
- *Return*: the standing province canonical; the roster present
  (`AlreadyDone` ↔ `NoRoster`) and paired; the holding present (canonical
  for its own coord/site, world) or absent; the capture lock in the
  holding's **own** province (the standing one, or the optional tenth
  account, canonical, present — `BadAccount` ↔ `Absent("holding_province")`);
  live generation only for Provisional/Final; `open_transits_of` = every
  **present** record of the four slots in **any** state (a `Free` record
  after SettleTransit and before its close still holds its host back); the
  selection of departed Leave entries by full identity, `RETURN_MAX`;
  `HostInTransit` vs `AlreadyDone` ↔ `NothingToReturn`; the reserve's
  checked add; `Return` chains province + holding, `Stranded` the province.
- *Reveal*: `target_i < 4` and exactly that slot writable; the keeper
  prologue (fee payer signer and writable, `[Running, Ended]`); the holding
  and its record (`in_transit`, the host's coord/site); the Ended clause;
  `unpack` + `validate` (version, reserved, host, arrival bell, world, path
  bits, directions, tile, stance, retreat); the commitment via `ct_hash`;
  the destination canonical; anchor/archive/log addresses; **the handler
  proceeds with no window test when neither THE anchor nor its archive is
  present** — the planner refuses (`AnchorRequired`), stricter; with the
  anchor: bell/region, `reveal_close`, the log's region and
  `latest < seed_round`; the latch (inputs absent, `resolved_next ≤
  arrive`); `walk_wide` ↔ `walk` (identical algorithm; path accounts in
  first-entered order, ≤ `MAX_PATH_PROVINCES`); `check_arrival_bell`; the
  site under the committed tile and both shields; the four slots (owner,
  fields) and `wide_admit` ↔ `admit` (identical ranking: troops, slot key,
  host bytes; one per host, one per Citizen, fill, displace lowest);
  `SlotMoved` cannot arise (the planner sets `target_i` from the same
  decision); the ArrivalDay (owner, fields, bit, writable iff the bit is
  not set); the rent precondition `fee_payer.lamports() ≥ rent(slot if new)
  + rent(day if created)` ↔ `widefees` (full minimum per created account
  + the one-signature base fee, stricter).

Observations, not discrepancies (reported for the auditing reviewer): the
Reveal handler's no-anchor path above; `open_transits_of` treating a
settled-but-unclosed (`Free`) record as holding a Leave back (deployed
behaviour; liveness only); the planners cover three of the lifecycle's
handlers — the closes and refunds (`close_roster`, the transit/slot/day
closes, `rent_to`) have no planner and are not claimed.

### Audit findings outside the direct comparison, fixed

1. **`widereveal::proofs_for` dropped settled departures.** It filtered
   through `wideduty::settle_candidates` (departure seen **and not
   settled**), while the handler's Reveal accepts every in-transit state
   (`Departed`, `Settled`, `DestroyedAtOrigin`): a proof whose departure
   had been settled at the origin lost its reveal hint. It now keeps a
   proof while the model shows its `(host, slot)` departed, open and
   unrevealed, like `ProofStore::hints`. Test
   `proofs_for_keeps_a_settled_departure_until_revealed_or_settled`
   (`wide_duties.rs`): nothing departed → none; departed → hint;
   `DepartureSettled` → still a reveal hint and no longer a settle hint;
   `Revealed` → none; `TransitSettled` → none; another slot → none; the
   store's hints agree at every step.
2. **`widefees` called any lamports "funding".** A program-owned or
   executable payer, or the Season itself named as payer is not eligible
   for these instructions, yet `MetLowerBound` was reported from balance.
   System data accounts instead require nonce/runtime checks and are Unknown.
   `Funding::Ineligible(reason)` now names the shape (`PAYER_EXECUTABLE`,
   `PAYER_PROGRAM_OWNED`) from the bound snapshot's
   bytes, and `PAYER_ALIASES` when the payer is any other account of the
   candidate's instruction (judged from the candidate alone, snapshot or
   not); the review adds `Deny::FundingIneligible`. An ordinary wallet
   (System-owned, no data, not executable) is bounded as before; an absent
   one is `Unmet`, not ineligible. Test
   `funding_is_reported_only_for_an_eligible_ordinary_wallet`
   (`wide_duties.rs`).
3. **Generation mismatch, downstream.** The handler's Reveal accepts a
   holding whose generation is not the march host's (coordinate and site
   only), and the planner does the same — a valid Reveal is not refused and
   no game rule changed. But `WideSettleTransit` refuses exactly that
   `NotImplemented` (`proc/wide.rs`, `t.host.gen() != h.gen`), so such a
   march cannot use that normal settlement path. `WideCloseTransit` returns
   the whole transit account balance to immutable rent_to, not holding
   escrow. Season-end CloseHolding can refund remaining escrow to the
   holding rent payer after pool obligations; this is a separate path. `RevealFacts.holding_gen` (sealed
   content) and `DOWNSTREAM_GENERATION` in `unverified` state it; the
   description shows both generations and `downstream_settlement_at_risk`.
   Test
   `a_generation_mismatch_is_accepted_as_the_handler_does_and_the_downstream_risk_is_said`
   (`wide_reveal.rs`). The source/history gates are unchanged.

### Parity pins added (`wide_duties.rs`, keyless, existing fixtures)

- `season_judgement_matches_the_abi_effective_status_rule`: every stored
  status × a clock before/at/after genesis against
  `frontier_abi::layout::world::season::effective_status` and the
  `[Running, Ended]` list — plans iff allowed, promoted iff Seeded moved,
  `SeasonNotStarted` / `SeasonStatus` otherwise.
- `absence_rule_matches_the_programs_definition_at_every_position`:
  `fclient::decode::is_absent` is `addr::absent` (System-owned and empty,
  lamports ignored); the three non-absent shapes at the holding and transit
  positions are typed refusals; an unread key is `Need`, never absent.
- `a_present_transit_record_in_any_state_holds_the_return_back_as_the_handler_does`:
  `Departed`, `Settled` and `Free` records in each of the four slots hold
  the host back; another host's record does not.

## Fifth slice (2026-11-08, on `1129d1b1`): observation after the legacy feed gate

**Policy found.** `Keeper::refresh_discovery` pulls feed pages from the
legacy cursor only while both legacy indexes are unblocked; the wide
observer is shown each page before the legacy guard ingests it. Once a
legacy index blocks (the PSW1 guard that stops game writes), nothing is
pulled and the observer sees no later record. Beacon-only deployments
(no land/play/rings/archive role) never pull at all.

**`widefollow`, opt in.** `Keeper::enable_wide_follow` (needs the
observer) creates a `WideFollow` with its **own** cursor, starting after
what the observer has processed. In a tick where `refresh_discovery` did
not pull (the gate blocked, or no gameplay role — a `wide_legacy_pulled`
flag set by the pulling branches), the follower pulls at most
`PAGES_PER_TICK` (2, a hard cap) pages from its cursor and shows each to
the same observer and proof store, through the same `observe_page`,
accepted-prefix and `wideproof` extraction as the legacy pull. Nothing
else changes: no legacy cursor is read or advanced, no gate or feed
readiness moves, nothing is signed or sent, the observer keeps
`source_complete: false`, the review keeps `HistoryUnknown` and
`SourceUnproven`. Default runtime behaviour is unchanged unless the method
is called; `main.rs` exposes it as `--follow-wide`, which requires
`--observe-wide` (usage error otherwise) and nothing else.

Fail-closed rules: in a tick the legacy path pulled, the follower stands
aside (`idle_shared_feed`); before a pull its cursor catches up to the
observer's last processed sequence (`caught_up_to_observer`), so a page
the observer saw through the legacy path is never pulled again; every
page must be past the cursor and strictly increasing, else the follower
stops (`page-order`) **before** the observer sees it; when the observer
blocks — before or during a page — the follower stops
(`observer-blocked`) with its cursor at the last accepted record and the
proof store given the accepted prefix only, and stays stopped (a new
process starts both empty); a page longer than `MAX_PAGE_RECORDS` (1,000,
the RPC's page size) is **refused unread** — before the order scan, the
observer or the store sees it, the cursor unchanged — with a typed stop
(`oversized-page`) recording only the count and the first sequence; then
the **byte preflight** (`widefollow::preflight`), because the observer
fingerprints a whole record through `Debug` before decoding it: by
reading lengths alone — no `Debug`, no base64, no copy — every record's
wire (≤ 1,232 B, the packet), log lines (≤ 1,024), log line (≤ 4,096 B),
aggregate log bytes (≤ 256 KiB), error text (≤ 4,096 B), post-state
accounts (≤ 64) and aggregate post data (≤ 1 MiB), the record in all
(≤ 1 MiB) and the page in all (≤ 8 MiB) are bounded before any record is
fingerprinted, decoded or copied; a record or page past a bound is a
typed stop (`record-wire`, `record-logs`, `record-err`, `record-post`,
`record-bytes`, `page-bytes`) at that record's sequence with the cursor,
the observer and the store untouched. The bytes were received by the
port already; the preflight bounds what is done with them, not the
receipt. The legacy pull path and the observer's general behaviour are
unchanged. A feed error is counted and ends the tick, its text never in
the status;
`caught_up` is cleared at the start of every step (idle, error or stop
included) and set only by an empty page received in that step; the
observer's block is final for the follower whatever produced it — a
conflicting replay through the legacy path included — never cleared or
reinterpreted. The status under
`wide.follow` carries counts, the cursor, the last slot, the typed stop
with its sequence, and the constant lines `automatic_writes: false`,
`source_complete: false`, `history_authenticated: false`,
`legacy_cursors_touched: false`.

Tests (`wide_duties.rs`, a literal-record feed port):
`the_follower_pulls_bounded_pages_after_the_gate_and_feeds_observer_and_proofs`,
`the_follower_resumes_after_the_observers_position_and_never_repulls_it`,
`the_follower_stops_when_the_observer_blocks_and_never_pulls_past_it`,
`the_follower_refuses_a_page_that_is_not_past_its_cursor_before_the_observer_sees_it`,
`follower_feed_errors_are_counted_without_text_and_non_wide_records_pass_through`
(also: a caught-up claim does not survive an idle tick or a failed read),
`an_oversized_page_is_refused_unread_before_the_observer_or_the_store_sees_it`
(1,001 cheap records, the first out of order, never noticed; exactly 1,000
processed),
`a_legacy_replay_that_blocks_the_observer_stops_the_follower_without_reinterpretation`,
`the_byte_preflight_refuses_oversized_records_and_pages_before_the_observer`
(every bound at and just past it; each refusal through the follower with
a fine record on the same page; the page aggregate naming the crossing
record; ordinary records measured).
The `Keeper` wiring (`enable_wide_follow`, the tick hook before the review
step, the `follow` status entry, `--follow-wide`) is compile-only
coverage, as before.

Limits: the follower sees only what the program feed serves after the
gate and says so; a stopped follower does not restart in-process.

## Sixth slice (2026-11-08, on `1129d1b1`+): archive/index ↔ keeper observation parity

**Inspected.** `findex::wide_index::WideIndex` (the dedicated SQLite
index: `wide_tx`, `wide_event`, `wide_chain`, `wide_link`; chain
continuity verified **from zero** per `(entity, full key)` with
`event::advance`; contiguous sequences; slot regression refused; a
malformed record, gap, replay, wrong world or chain mismatch rolls the
batch back and latches a durable block), `WideReader` (read-only pages
pinned to `indexed_through` and the content stamp), `WideFindex` (archive
first, index second; reopen catches up from the archive; an index ahead
of the archive is refused), `fclient::typed_log` (the one decode both
sides use), against `keeper::wideindex::WideObserver`/`WideDiscovery` and
`widefollow`.

**Finding (fixed).** The typed index verifies every record's chain links
against the previous head of that province or holding; the keeper's
observer verified none — `WideDiscovery::apply` checks caps, the sequence
against its fingerprints, decoding and the model's caps, and ignores the
link tail (the test helpers even carried literal `seq 1 / head [seq; 32]`
links). A record the archive/index refuses as chain-broken therefore
still produced a keeper hint. Now `WideObserver` keeps the chains the
index keeps (`chain(target) -> ChainHead { seq, head, terminal }`), checks
each wide batch's links with the index's rule before the model applies it,
blocks on a mismatch or on a continuation after `ProvinceClosed` with the
index's wording, and commits the heads only when the model accepted the
batch. One difference, stated: the index starts from zero and requires the
first link to be sequence 1; the observer may start mid-history, so the
**first link seen** per entity is its anchor (`chain_anchored`), and
continuity is verified from there (`chain_verified`); the status says so.
Bounded by `MAX_CHAIN_KEYS` (4,096; one more blocks). `WideDiscovery::apply`
itself is unchanged (its tests still drive it directly).

**Sequences, three numberings.** The raw `ChainPort::feed` sequence is
the chain's **global** transaction order filtered to this program
(`localnet/src/chain.rs::feed` skips airdrops and other programs'
transactions after numbering; the JSON-RPC feed filters by program), so it
is not contiguous and a skipped number says nothing about the program's
history. The archive renumbers what it stores contiguously (1, 2, 3…) and
stores the source's raw cursor beside it; the typed index is contiguous
over the archive's rows and refuses a gap there. The event page cursor is
a third numbering (event ordinal). The follower therefore keeps
**increasing-only** (`page-order`) and reports skipped numbers as
`sequence_holes_unknown` — never a stop, never a claim either way: a hole
is **unknown** (another program's transaction, an airdrop, or a program
record this reader never received) and **may hide missing program
records**; a review-round `gap` stop was wrong and is removed. What the
chain check detects is exactly one case: a missing **linked** record
between two observed links of the **same** province or holding (the next
link does not continue the previous head). A missing prefix before the
anchor, a missing tail after the last record seen, a never-seen entity,
or a missing non-wide record is **not** detected.

Test `a_multi_event_transaction_separates_event_ordinals_from_archive_and_feed_cursors`
(`wide_duties.rs`; literal synthetic bodies, valid public ABI encodings
chained with `advance`, not any handler's output): one transaction with
three events and one with one → two archived transactions, four indexed
events `(event, archive_seq, ordinal)` = (1,1,0), (2,1,1), (3,1,2),
(4,2,0); a page of two ends inside transaction A with `next == 2 ==
indexed_through`, and `archive.read_after(next)` reads nothing while two
events remain — the event cursor is not a transaction cursor; the raw
source cursor is 20, a third numbering; the observer sees two
transactions and four records with chains at 4 equal to the index's head;
and atomicity stated as it is: the index rolls a page back whole, the
observer applies transaction A whole and blocks at C.

**Input-cap wording.** The observer's pre-chain cap check saves the
chain plan's work; the typed reader has already decoded the frame in
`observe_tx` (that decode is unavoidable to know the batch at all).

**Input caps before chain work.** The observer applies the model's own
input caps (`max_bodies_per_batch` 64, `max_body_bytes`, `max_batch_bytes`)
by lengths alone **before** `chain_plan`, so an oversized wide transaction
is refused with no further decode of its bodies (the typed reader decoded
the frame already), no staged scan and no head or model change; the
chain plan's staged lookups are then bounded by 64 bodies × their links.
Test `an_oversized_wide_batch_is_refused_before_any_chain_work`
(`wide_duties.rs`): 65 chained bodies in one frame (block names the cap, no
head anchored, the follower stops at it), the aggregate-bytes cap under a
tight limit, and the same two bodies accepted under the defaults.

**Wording.** The `wideindex` module doc no longer calls its inputs
"already authenticated" or the chain "the typed reader's job": inputs are
format-checked through the typed reader; the observer verifies local chain
continuity from an anchor that is verified only when it is the first link
from the zero head; nothing verifies a signature or the source's coverage.

**Build note.** `findex` is a **dev**-dependency of the keeper with its
`wide-records-experimental` feature, so test builds of the keeper compile
the findex wide modules; the production default binary (`cargo build -p
keeper` without features) is unaffected — dev-dependencies and their
features never enter it.

**Anchors, explicitly.** `ChainHead.from_genesis` is `true` only when the
first link seen for the entity was sequence 1 and `advance` from the zero
head reproduced it — the index's own first step; then the equivalence with
the index's head is earned. Any other first link is an anchor **on trust**
(`chain_anchored_unverified`): continuity after it is verified, its prefix
is unknown, and no equivalence with the typed index is claimed; the status
says so.

**Test** `archive_index_and_keeper_observation_agree_on_literal_records`
(`wide_duties.rs`; `findex` is a dev-dependency with its
`wide-records-experimental` feature, test builds only): three chained
`Departed` records (built with the ABI's `advance`; a signature unique to
the sequence on the record **and** as the wire's first signature, which
the extractor binds) carrying raw sequences 10, 20, 30, archived as 1, 2,
3 with the source cursor 30 kept, into a real `WideFindex` through a
literal `Source` labelled a fixture; the raw-feed follower reports 27
skipped numbers and stops nowhere while reaching the same heads; a
follower joining mid-history anchors on trust and claims no equivalence;
full province/holding/host identities on every event; reopen and resume at
the archived cursor; the SQLite file removed and the index **rebuilt from
the archive alone** with identical heads; the archive's own records fed to
`WideObserver` + `WideFollow` + `ProofStore`; observer chain heads equal
the index's for the province and the holding; the settle hint, the
extracted proof (record 3, `METHOD_FEED`, unverified) and the reveal hint
agree; one snapshot-backed unsigned SettleDeparture candidate over literal
accounts, coherent, with every hard denial and nothing pending; the
unknown source stated by the index, the observer and the follower; a lost
response leaves the store unpoisoned and the archive standing; and on
fresh indexes and observers: a duplicate, the same sequence with other
content, a malformed body, an archive-numbering gap (the index refuses;
the follower reports the hole and the observer blocks on the discontinuous
chain link), a chain-broken record (the index rolls back and blocks; the
observer blocks at the same record with the heads at 1; the follower stops
there) and a continuation after `ProvinceClosed`. The follower fixtures
now carry properly chained records (`Chains`), and `sign_as` keeps the
record's signature and the wire's first signature equal.

Limits: `WideReader` (the HTTP read side) is covered by the herald's own
tests, not here; the observer's mid-history anchor is a stated difference
from the index's from-zero rule; the typed index remains source-coverage
"unknown" and the keeper's review keeps `HistoryUnknown` and
`SourceUnproven` on every candidate; nothing in this slice signs, sends,
reopens a gate, or infers a generation-mismatch payout.

## Seventh slice (2026-11-08, on `500ad67a`): observed chain heads against the snapshot

**Inspected.** `proc/wide.rs::emit_wide` reads each chained account's
header chain (`layout::header::EVENT_SEQ` at 24, `EVENT_HEAD` at 32,
`layout::chain_of`), computes the next link with `event::advance` over the
record's body, writes that link into the record's tail **and** back into
the header (`set_chain`). So the last link the observer verified for a
province or holding and the account's header after that record are the
same `(seq, head)` whenever the observer's records and the chain are one
history. The observer's `ChainHead` now carries the record's `slot`, so a
response can be judged against the record's time.

**`widereconcile`, read-only.** `reconcile(scope, &observer, target,
&reads)` first requires the observer's scope (program, season, world) to
be the requested one and the target to be of that world
(`ScopeMismatch` otherwise: a foreign observer's heads are never used),
resolves the target's canonical address (province by coordinate; holding
by coordinate and site), requires the reads to be one coherent snapshot
(`Reads::coherent_snapshot`) and a usable Season, and then — **before**
any conclusion about presence — compares the response's context slot
with the slot the observed record **asserted**: an older response is
`SnapshotBehindRecord` and concludes nothing, neither a head nor an
absence nor a close (an old absence cannot confirm a later close). Then
the account: absent → `AccountClosed` (the observer saw the close) or
`AccountMissing` (no close seen: unknown which); present → not
executable, program-owned, the right shape and full identity (season,
world, coordinate; for a holding also site and **generation**, the
reference's) else `Identity(executable|owner|shape|season|world|coordinate|site|generation)`;
a present account of a province the observer saw closed →
`ClosedButPresent` (the close erases the account in its own transaction);
then the header's `(EVENT_SEQ, EVENT_HEAD)` against the observed link:
`Agree`, `ObserverBehind` (the account ahead: ordinary feed **lag**,
classified and counted apart from disagreement), `AccountBehind` (the
observed chain ahead of the account at or past the record's slot: not one
history), `HeadMismatch`; `NotObserved`, `NoCoherentSnapshot`, `NotRead`,
`Season(..)` otherwise. The description carries `meaning: cross-input
consistency…`, `source_relationship: unverified — the records and the
snapshot may come from independent sources`, `history_authenticated:
false`, `source_complete: false`, `permits: "nothing"`, the observed
anchor's status (`from_genesis`, or "taken on trust mid-history:
unverified prefix") and `record_slot_asserted`. The observer is borrowed
immutably; no account is read by the module itself; no payment or refund
recipient is inferred.

**Chain anchors, tightened.** The observer's first link seen for an
entity: sequence 0 is impossible and refused; sequence 1 must equal the
ABI's step from the zero head, a wrong head there is refused; only a
sequence past 1 is a mid-history anchor taken on trust. A refusal takes
the whole transaction — no head of it is kept, for either entity. The
discovery suite's observer-fed fixtures now carry first-step links
(`departed_from_zero`); the literal `both` links remain for the model's
own `apply` tests, which verify no chain. `ChainHead.slot` is the slot the
record **asserted** — a source claim, not proof the record landed there.

**Wiring, diagnostics only.** `WideReview::step_observing` is `step` with
the observer lent; `Keeper::tick` uses it. Each candidate summary gains a
`reconcile` array for the accounts the duty names (settle: origin province
and host's holding; return: standing province, holding reference and, when
foreign, the holding's own province; reveal: the host's holding and the
destination), judged against the reads the candidate was planned over;
the status counts `agree` / `lag` / `disagree` / `unknown` with the meaning
spelled out. **No verdict is read by any denial**: `HistoryUnknown`,
`SourceUnproven`, `SignerAbsent`, `SliceDoesNotEnqueue` and the rest stand
on every candidate, and `admitted` stays `false`. `step` itself is
unchanged (it lends no observer; the entry says `null`).

**Tests** (`wide_duties.rs`, literal bytes and public addresses):
`chain_anchors_refuse_sequence_zero_and_a_wrong_first_head_for_the_whole_transaction`
— sequence 0 on both entities; sequence 1 with the literal wrong head; the
province link right and the holding link wrong refusing the whole
transaction with no head kept; a right first step anchored from genesis;
only a sequence past 1 anchored on trust.
`reconciliation_compares_observed_heads_with_a_coherent_snapshot_as_cross_input_consistency`
— agree from genesis; nothing moved on the observer or the reads; response
older than the record; modified head; account ahead classified as lag;
account behind; wrong owner; executable; wrong generation; another
province's record at the address; absent without and with an observed
close; an old absence against a closed or an open observation judged
stale, not closed or missing; a closed province still present as
`ClosedButPresent`; a foreign-program observer and a target of another
world refused by scope; nothing observed; no coherent snapshot; address
not read; an anchor taken on trust agreeing and saying so.
`the_tick_reconciles_a_candidates_accounts_as_diagnostics_only` — two
agreements on a coherent settle candidate with every hard denial intact, a
tampered head counted as a disagreement, the account ahead counted as lag,
nothing admitted in any case, and `step` without the observer carrying
`null`.

**Exact limits.** Agreement means only that the records this observer
received and the account bytes this snapshot returned agree on where the
chain ends at that context slot; the two inputs may come from independent
sources and their relationship is not verified here. It is not evidence
that the records are authentic (no signature verified), that the history
is complete (source coverage unknown), that a record landed at the slot it
asserted, or that an anchor taken on trust is right. `SnapshotBehindRecord`
concludes nothing, presence included. No live game was read; the fixtures
are literal account bytes and chained records built with the public ABI.
Nothing here changes a gate, a cursor, a payer or a payout; the
generation-mismatch settlement question is untouched.

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
`frontier-node/crates/keeper/src/widefollow.rs` (new, fifth slice),
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
fourth: `enable_wide_snapshot_via_port` under the same flag; fifth:
`--follow-wide`, requiring `--observe-wide`),
`frontier-node/crates/keeper/src/wideindex.rs` (sixth slice: the
observer's chain heads, `ChainHead`, `chain()`, `MAX_CHAIN_KEYS`; seventh:
`ChainHead.slot`),
`frontier-node/crates/keeper/src/widereconcile.rs` (new, seventh slice),
`frontier-node/crates/keeper/Cargo.toml` (sixth slice: the `findex`
**dev**-dependency gains `features = ["wide-records-experimental"]`; no
runtime dependency change),
`frontier-node/crates/keeper/tests/wide_duties.rs` (new),
`frontier-node/crates/keeper/tests/wide_reveal.rs` (new), this document.
No fclient, ABI, program, engine, herald, web or UI file.

### Nonce qualification after independent review

System-owned data accounts are not categorically invalid fee payers: initialized nonce accounts may pay fees subject to runtime and rent-reserve checks, while a System transfer requires additional eligibility. This slice does not perform those checks or prove a positive transfer debit. Such accounts therefore produce Funding::Unknown and FundingUnknown, not Ineligible. Program-owned/executable accounts and conflicting state-account aliases remain Ineligible. Beneficiary is encoded in Reveal data, so beneficiary equal to payer is not refused as an account alias.

### Generation mismatch: why the refusal remains

Legacy capture authenticates PREV_OWNER_TAG/PREV_GEN/PREV_HOME, refunds old bonds and clears flags before owner change (CONQUEST-CONTRACT.md 293–318; proc/conquest.rs 1402–1492), and sends surviving troops only to the recorded previous home (proc/transit.rs 552–598,949–998). Wide capture and equivalent historical full-reference provenance do not yet exist. Re-founded-site mismatch is not proof of capture. Removing wide.rs generation refusal would invent ownership and escrow recipients; no such rule change was made. Terminal CloseTransit returns its whole account balance to immutable rent_to, while CloseHolding expiry can refund remaining holding escrow after pool obligations to its stored rent payer. These are distinct from normal settlement and must not be described as reimbursement of the historical departure payer.

### Seventh-slice verification checkpoint

The final modified tree passed 99 focused keeper tests: wide_discovery 14,
wide_duties 49, wide_feed_guard 12, wide_reveal 18, wide_snapshot_rpc 6.
These use literal fixtures, unsigned transactions and public address/hash
calculations; no keypair generation/derivation or signing was run. Feature-on
keeper lib/binaries and these selected tests passed clippy; default lib/binaries
also passed clippy (compilation only). Independent static review found no
remaining blocker after the executable-empty-System-account negative case.
Actual Keeper startup/tick, a real chain, browser play and production sending
were not run. Compilation of the runtime connection is not execution evidence.
