# Wide keeper duties, first slice: proof extraction and unsigned planning (2026-11-07, revised 2026-11-08 after independent review, on `d132baec`)

## Current checkpoint: snapshot-backed runtime review (2026-11-08)

The current source passes 96 audited tests: discovery 14, duties 46, legacy guard 12, Reveal 18 and real RpcPort loopback snapshot 6. Feature-enabled library/binary and the three snapshot/duty/Reveal test targets, plus default library/binary, pass clippy with warnings denied. Public FromBeacon opening uses pre-existing recorded IBE material and shipped quicknet signatures; no keypair or signature was generated.

The opt-in runtime now uses its actual port through an additive snapshot callback. Settle/Return and bounded Reveal diagnostic review use a single response for their final account/Clock/Rent judgement. Reveal proofs are extracted only from the observer-accepted portion of shared feed pages; supplied provenance remains unverified. Public beacon reads use a separate bounded cache, and transient readiness failures have bounded next-slot retries. Unset payer funding remains unknown. Status excludes raw RPC error strings and opened material.

A further parity review keeps settled-but-unrevealed departures eligible for Reveal hints, validates known-ineligible payer shapes and aliases, leaves System data/nonce eligibility Unknown, and exposes downstream generation-mismatch settlement risk without changing game rules.

Explicit --follow-wide (requiring --observe-wide) now continues read-only wide observation with an independent in-memory cursor after legacy feed guards stop. It never advances legacy cursors or reopens write gates. Strict page/record/aggregate-byte limits reject before observer processing; network response allocation itself is outside these limits. Restart replays from empty observation, and source completeness remains unknown.

The archive/index interoperability test now drives real WideFindex, SQLite rebuild, archive transaction reads, keeper observer/proofs, and a snapshot-backed unsigned candidate. Raw program-filtered feed sequences (10/20/30), archive sequences (1/2/3), and event-page IDs are distinct. Observer verifies local per-identity head continuity after its first observed unverified anchor; dedicated index validates from genesis. Neither proves source authenticity. Raw sequence holes remain unknown, not automatically corrupted.

The eighth slice adds the unsigned WideGather candidate (`wideduty::plan_gather`, hinted from revealed open marches, planned over a snapshot with the Rent, reviewed and counted in the tick): the handler's latch, end bell, anchor-or-archive window, ClashInputs and ArrivalDay rules replayed from the accounts at their canonical addresses; the cursor bounded to at most eight positions before any slot is read (one packet even when every position is present) and cut before a later unsettled transit; present slots judged from their transit records; absent slots' transit positions the slot's own address; the present count the handler's scan of every position; a clear day bit over a partial record planned as the completing gather; the fee review netting a prefunded ClashInputs as the handler's top-up does. The ArrivalDay account is the only arrival evidence; missing feed events are never read as no arrivals. The ninth slice adds the unsigned WideResolve candidate (`wideduty::plan_resolve`): each observed province at its current `resolved_next` read from the chain, the window against THE anchor or its archive, the bell seed as the handler's `bell_seed` takes it (a SeedCache whose stored nonce recomputes its address and which names THE anchor and the seed round, found by a bounded 256-nonce probe; or the archive entry in both positions), the ArrivalDay bit against a complete unresolved ClashInputs, the conquest block, the roster or its absence, and the ABI's own `resolve_bell` replayed on scratch bytes for the outcome, the roster creation (full-minimum payer guard, exact) and the digests (the output digest at the observed clock). Resolve hints need a configured public resolver; a `NotGathered` bell schedules its gather so intermediate bells are not skipped. The tenth slice moves the program's pure settlement (quota, outcome, payment plan) into `frontier_abi::world_index::settle`, re-exported unchanged by the program, and adds `widesettle::plan_settle_transit`: the first WideSettleTransit candidate, for a seal that opens under THE anchor's own public round signature and a host present in the resolved final set with a fate that does not come home; payees read from the accounts, the plan from the shared functions; bad seals, absent destinations, bounces, routs, returns home and camp loot are refused, not planned. The eleventh slice wires that candidate into the tick (settle-transit hints from stored proofs of revealed open marches, listed only with the reveal inputs, planned under the same shared two-plan cap over one snapshot with the Rent sysvar, reviewed and denied like every other) and extends the planner to read the payees' shapes and replay the handler's payments and closes in its order over the running balances — program-owned recipients owed, wallets below the Rent minimum diverted to `pool_owed`, the holding's backing, overflows, the two `Sink::Never` closes, the mirrored `wide_claim_eligible` with the rules crate's `defence_refund` — refusing whatever would abort; every payment stays a nominal allocation with a predicted route, never a transfer. The twelfth slice plans the host that comes home: every final-set fate (Bounced and Retreated with the record's values), the record's outranked bounce and rout from the shared functions, and the home re-entry replayed line for line from the handler's `stage_return_home` (a paired roster's muster-pending entry under the caps, else the reserve in whole units), refusing a return without the home province, an unpaired roster, a refused claim, an unresolved record and a historical generation. **Arrival processing is still not complete.** Not compiled or run by its author.

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

## Eighth slice (2026-11-08, on `d9fb62d8`): the unsigned WideGather candidate

**Scope.** `wideduty::plan_gather(scope, payer, dest, bell, reads)` plans
the destination's gather of revealed arrivals into the wide ClashInputs —
WideGather (0xDC op 4), the deployed GatherClash over the wide records
(`proc/wide.rs::gather`, `wide_ix::GATHER`) — as an **unsigned**
`Candidate` with `Duty::Gather(GatherFacts)`, reviewed in the tick like the
settles. **WideResolve is not planned** (below). Nothing signs, simulates,
sends or queues; every Engine denial stands; `DEPART_DEBIT_ENABLED` is
untouched; no game rule, fee, custody, payout or legacy/wide boundary
changes; no fclient, ABI or program file is edited.

**The handler's rules, in its order.** The keeper prologue (the Season
Running or Ended, the pinned deployment: `season_of`); the destination a
wide province of this world at its canonical address (`province_at`);
`bell ≥ resolved_next` else `LatchClosed("destination resolved past the
bell")`; `bell < end_bell` else `SeasonEnded` (the handler's
`WrongStatus`); the reveal window of the bell **closed** for the
province's stored region: THE BellAnchor of `(bell, region)` at its
canonical address (`BellAnchor::decode`; season, bell, region checked) or,
when absent, its AnchorArchive at `(region, part_of(bell))` with the
bell's archived bit set and `A = bell_end + a_off` (the handler's
`anchor_time`), else `NoAnchor("absent" | "archive without the bell")`;
`now ≥ SeasonClock::reveal_close(bell, A)` by the **observed clock** (the
snapshot's Clock when coherent) else `WindowOpen { reveal_close, now }`;
no clock → `TimingNeedsClock`. The ClashInputs at its canonical address:
absent (the handler creates it from the fee payer: 3,008 bytes, in the
fee review's `creates`; the lamports already at the address, a prefunded
System account or nothing, are recorded as `inputs_prefunded_lamports`)
or this season's, destination's and bell's, not `FLAG_RESOLVED`
(`AlreadyResolved`), not fully gathered (`AlreadyGathered`). **The
arrival evidence is the wide ArrivalDay at its canonical address.** Its
bit set: the cursor's slots are read and written. Its bit clear (or the
day absent), the handler completes the mask **without reading a slot**
(`proc/wide.rs::gather`, `has_arrivals` false): with **no record** that
is a complete empty record the resolve does not need (it takes the
residents alone when both are absent) — not planned, `NoArrivals`, stated
as a planner policy, not a handler refusal; with a **partial record** it
is the completing gather the resolve requires (`NotGathered` otherwise)
— planned, one position, its slot unread, nothing written to the
positions (`day_bit_set: false` on the facts). The absence of feed events
is **never** read as "no arrivals"; the model's hints only say what to
read.

**The cursor, bounded before any slot is read.** `start` is the first
ungathered position of the 24; `n` is the contiguous ungathered run after
it, **at most `GATHER_MAX_POSITIONS` (8)**, fixed before the slots are
asked for, so no position outside the cursor is ever read or judged. The
bound is sized so that a cursor with every position present fits one
packet under the **widest** ComputeBudget prefix: a legacy message with
one signature is `479 + 66·n` bytes (10 fixed keys plus a slot and a
transit key per position, two account indices per position, the four
prefix instructions at full width, the 10-byte data), plus 32 when the
payer is also an instruction key (the all-zero review placeholder is the
System Program); `n = 8` is at most 1,039 of the 1,232 (`n = 11` would
not fit). `wideduty::packet_len` guards the built instruction regardless
(`Overflow("packet")`, never a trim). Positions gathered before are not
read again (the handler's `continue`; their slots are not in the cursor
at all). Each position's slot at its canonical address is absent or this
season's, destination's, bell's, faction's and index's
(`NotCanonical("slot")`; owner by `presence`); a present slot's host
transit record at the slot's bound address
(`transit_address(holding_address(host coord, site), transit_slot)`) must
be present (`Absent("transit")`), this host's and this bell's
(`NotCanonical("transit")`). The present slots are judged **in position
order**: `Departed` at the first position → `DepartureUnsettled {
position }` (the origin settles first); `Departed` later in the cursor
**cuts the cursor before it** (`cut_at_unsettled: Some(position)`): the
ready prefix is a valid gather and the handler never sees the unsettled
position; `Free` → `TransitState`; `Gathered` at this destination → taken
as is, not stamped, read-only; at another → `NotCanonical("transit")`;
`Settled` / `DestroyedAtOrigin` → stamped (`WideTransit::step(Gather)`
must accept it), writable. **An absent (or unread) slot's transit
position is the slot's own address, read-only** ("any account" in the
handler; nothing is invented). The data is the ABI's `Gather { bell,
start, n }`.

**Predictions (`GatherFacts`).** Per present slot: state, stamps,
`predicted_present` (troops after the origin's settle ≥
`DESTROYED_BELOW`), `predicted_destroyed`, troops, `arrival_stamina`. Over
the record, **as the handler scans it** (`proc/wide.rs::gather` reads
every one of the 24 positions of the written scratch and counts
`present`): the cursor's positions as this gather writes them (zeroed,
then the present slots' arrivals; untouched when the day bit is clear),
every other position as the record holds it, masked or not — a position
that does not decode fails the handler (`Unreadable("inputs position")`
here), a present arrival anywhere counts. `predicted_mask_after` (the
whole mask when the day bit is clear), `predicted_n_present`,
`predicted_complete`, `predicted_no_arrivals`, `remaining_after` (a
resolve needs every position gathered), `stamps`, the anchor source, `A`,
the reveal close and the clock the window was judged by. All of it is in
the content digest (`Duty::canon` tag 3); a candidate changed afterwards
loses its snapshot, fee bound and snapshot denial change like the others.

**The fee review nets a prefunded record (gather only).** The gather
handler has **no** guard requiring the payer to hold the full minimum
(the reveal has one): `init_with_seed` takes `init::rent(size)` as the
total and `init::top_up` transfers `total − lamports already at the
address`, refusing `Insufficient` only when the payer holds less than
that shortfall (`init.rs`). `widefees::duty_needs` therefore requires
`rent − inputs_prefunded_lamports + base fee` for a gather
(`RENT_RULE_TOP_UP`, `prefunded_lamports` on the needs); a fully prefunded
address leaves the payer the fee alone. The reveal keeps the full minimum
(`RENT_RULE_FULL`); the settles and the return create nothing
(`RENT_RULE_NONE`). Each candidate's needs name the rule.

**The live-read driver.** `drive` allows `MAX_READ_ROUNDS` (6)
evaluations: the gather asks in four waves (Season, destination, inputs
and day; anchor and archive; the cursor's slots; the present slots'
transits) and decides at the fifth; the previous bound of four made
`gather_via` fail `ReadLoop` for any present slot.

**Wiring.** `wideduty::gather_candidates(model)`: `(destination, arrival
bell)` of open marches whose `Revealed` carries an arrival bell in the
applied history, with no `Resolve` of that bell at the destination and no
closed or fully gathered ClashInputs as the records say — read hints
only. `widetick::Hint::Gather`, planned over the snapshot **with the Rent**
(the record may be created) or `gather_via`; `gather_plans` /
`gather_candidates` counters and a `gather` status entry; the duty's
reconciliation targets are the destination and every present slot's
host. `widereview::KIND_GATHER` (`wide-gather:<world>:<dest>:<bell>:<start>`,
class D, tag 0xDC). `widefees::duty_needs` adds the ClashInputs creation
when the plan found none.

**Tests** (`wide_duties.rs`, literal bytes and public addresses; a
`GatherFx` of THE anchor, the ArrivalDay bit, one present slot with a
settled transit, every other slot absent, the clock at the Season's own
reveal close):
`a_gather_candidate_carries_the_handlers_accounts_cursor_and_predictions`
(the eight fixed roles, the pairs, the writable stamped transit, the
placeholder for absent slots, the data, the predictions, the fee
`creates`, the cursor at the packet bound with one more pair over it, the
archive entry path and its window),
`a_gather_resumes_after_the_gathered_positions_and_refuses_a_finished_or_resolved_record`
(duplicates: the cursor after gathered positions, a stored present arrival
counted; a split run; the completing last part with `FLAG_NO_ARRIVALS`;
`AlreadyGathered`, `AlreadyResolved`, another bell's record),
`a_gather_blocks_on_the_handlers_refusals` (no day / clear bit / another
destination's day, the latch, the end bell, the window by one second, no
clock, no anchor, an archive without the bell, another bell's anchor,
`DepartureUnsettled`, transit absent / another host's / gathered
elsewhere / gathered here unstamped, a slot of another destination, a
foreign-owned slot, the destination absent / legacy / another world),
`a_gather_candidate_is_bound_to_its_snapshot_and_content` (coherent over
one snapshot, every hard denial, four mutations lose everything),
`gather_hints_come_from_revealed_open_marches_only`,
`the_tick_plans_a_gather_candidate_reviews_it_and_enqueues_nothing` (one
hint, one snapshot request with the planner's keys, a coherent candidate,
`creates` the ClashInputs, every hard denial, nothing pending, nothing
sent; the window open at the tick's clock → planned and blocked
`WindowOpen`). After the independent review of the first version:
`gather_via_reads_in_four_waves_through_the_port` (the real read adapter:
four waves at the requested bound with a present slot, three without, the
same instruction as the direct plan),
`a_later_unsettled_position_never_blocks_the_first_ready_packet` (a
`Departed` transit beyond the cursor is unread; inside it cuts the cursor
before it; at the first position blocks),
`the_present_count_mirrors_the_handlers_scan_of_every_position` (an
unmasked present arrival outside the cursor counts; garbage outside the
cursor fails; garbage inside is overwritten),
`a_clear_day_bit_with_a_partial_record_plans_the_completing_gather` (one
position, slot unread — an unsettled transit behind it cannot block —
mask completed, the count from the record; the day absent the same; no
record → `NoArrivals`),
`a_prefunded_clash_inputs_leaves_the_payer_the_fee_alone` (fully
prefunded: `required = 5,000`, met; a lamport short: unmet; half: the
other half plus the fee; unfunded: the minimum plus the fee); the happy
path now pins `n = GATHER_MAX_POSITIONS` and a cursor with every position
present fitting the packet with the placeholder payer. Fixture additions:
`LiteralSnapshots.clock_ts` / `rent` (the Rent served exactly when
requested), `snapshot_json_rent`, `snapshot_of_rent`, `ClockedPort` (a
fake port whose Clock is settable and whose read bounds are recorded).

**Resolve.** Not planned in this slice; the ninth slice below plans it
with the actual bell model on scratch bytes.

**Exact limits.** The candidate is unsigned and unsent; the history
before the applied records is unknown; the snapshot is coherence at a
context slot, not currency; the fee evidence the handler reads from the
instructions sysvar is the engine's prefix at send time, not checked here;
the packet bound is computed for a legacy message with one signature under
the widest prefix, not for a versioned transaction. The ArrivalDay bit is
the handler's own evidence rule, replayed from the account at its
canonical address; whether a reveal the feed never showed exists is
learned only from that account. No live game was read; nothing here makes
the game playable.

## Ninth slice (2026-11-08, on `2552d91f`): the unsigned WideResolve candidate

**Scope.** `wideduty::plan_resolve(scope, payer, beneficiary, province,
seed_nonce, reads)` plans WideResolve (0xDC op 1, `proc/wide.rs::resolve`
as it is — nine accounts, `wide_ix::RESOLVE`: `[fee_payer s,w] [season r]
[province w] [roster w] [seedcache|archive r] [anchor|archive r]
[clash_inputs r|w] [arrivalday r] [system]`; the handler's own doc
comment is stale) of an observed province's **current `resolved_next`**,
as an unsigned `Candidate` with `Duty::Resolve(ResolveFacts)`, reviewed
in the tick like the others. **WideSettleTransit is not planned**: a
resolved bell has no planned settlement; arrival processing is **not**
complete. Nothing signs, simulates, sends or queues; every Engine denial
stands; no gate, game rule, fee, custody, payout, recipient or legacy/wide
boundary changes; no fclient, ABI or program file is edited.

**The handler's rules, in its order.** The keeper prologue (`season_of`);
the province canonical and of this world (`province_at`); the bell is the
province's `resolved_next` as read (the model's `NotDue` would be
`OutOfOrder`); `bell < end_bell` else `SeasonEnded`; the reveal window
closed against THE anchor or its archive entry of the province's stored
region (the gather's `anchor_read`; `NoAnchor`, `WindowOpen`,
`TimingNeedsClock`); **the bell seed as `hold::bell_seed` takes it**: with
THE anchor present, a SeedCache of this season, bell and region whose
**stored nonce recomputes the address** it stands at, naming THE anchor's
key and `A` and the round `SeasonClock::seed_round(bell, A)`
(`NotCanonical("seedcache")` / `SeedNotReady`); with THE anchor archived,
the archive entry's seed with **the same archive account in both the seed
and the anchor positions**. The nonce is the poster's choice and is not
derivable: `plan_resolve` takes it from the caller and returns
`SeedNonceUnknown { bell, region }` without one; `find_seed_nonces` is
the legacy keeper's probe of the 256 canonical cache addresses through
`accounts` in chunks of 64 (four reads, always), returning **every**
present, program-owned, decodable cache whose stored bell, region and
nonce are the address's, in nonce order (`find_seed_nonce` is its first).
The ArrivalDay's bit as the arrival evidence: set, the
ClashInputs must be present, canonical, fully gathered and unresolved
(`NotGathered { bell }`, `AlreadyResolved`), and it is writable; absent
with the bit clear the bell runs over the residents alone; a present
complete record with the bit clear is taken (the handler takes a present
record whatever the bit says). The Season's conquest block of this
build's version (`StepParams::of_season`, `CONQUEST_VERSION`;
`ConquestParams` otherwise). The roster present and canonical
(`NotCanonical("roster")`), or absent while no entry is live
(`Absent("roster")` otherwise), modelled as the empty table under its
would-be header with the fee payer as rent recipient — as the handler
does. The province's event chain has room for the record.

**The model on scratch bytes.** `world_index::resolve::resolve_bell(pd,
roster, rd, inputs, bell, seed, frontier_ruleset(), StepParams)` over
copies of the province, the roster and the record, then the handler's
write-backs: the resolved arrivals (`write_resolved`), the resolver
(`beneficiary`) and `resolved_ts = observed clock − genesis` into the
record, the summary (bell, engagements, arrivals, destroyed, bounced, the
resolver's first eight bytes) into the province. The facts carry the
engagements, destroyed, bounced, `settled`, `n_arrivals`, the roster's
presence and **`roster_created`** (`!present && roster bytes changed`:
an arrival that stays claims an entry; the handler then requires `live
entries ≠ ∅`, mirrored), the **input digest** over the bytes as read
(`resolve_input_digest`) and the **output digest at the observed clock**
(`resolve_output_digest`): the landed record carries the execution
clock's `resolved_ts`, so the digest equals this one only when executed
at that second — said on the facts and in the status. The model's
refusals of unported S1/S2 state (a live fort, a caravan, a conquest
record, a packed pending op) are kept as `Unported(name)`; every other
model refusal is `ResolveModel(name)` (sanitized to its name in status).
The program applies its own model.

**The roster rent, exact to the handler.** When `roster_created`, the
handler requires `fee_payer.lamports() ≥ init::rent(roster size)` before
the creation (`Insufficient` otherwise) and only then tops the address up:
`widefees::duty_needs` therefore requires the roster's **full** minimum
plus the fee (`RENT_RULE_FULL`), not the gather's netting; a lamport short
of it is unmet.

**Wiring.** `wideduty::resolve_candidates(model)`: **every** observed
province not seen closed, in key order — bounded by the observer's own
province limit (`Limits::max_provinces`, 4,096 by default), never cut
here, so the tick's rotating cursor reaches each in turn under the plan
cap (the first version cut the list at 64 and would have starved every
later province for good; fixed after independent review). The plan takes
the current bell from the chain, so **resident-only bells are planned and
no intermediate bell is skipped**. `widetick`: resolve hints are listed
only once `WideReview::set_resolve_beneficiary` names the public resolver
(the all-zero address refused; no recipient is invented);
`Hint::Resolve(province)` is planned over the snapshot with the Rent,
**exactly once per tick**, under the shared two-plans-per-tick cap that
counts every plan evaluation of every duty (`plans` is the number of
`plan_*` drivers run; nothing is planned twice for one hint in one tick).
The plan is given the nonce known for the `(bell, region)` the province's
last `SeedNonceUnknown` named — the remembered one, else the first probed
one not cooling down — or none. On `SeedNonceUnknown` the tick learns the
key and, when no nonce is known for it, spends **the tick's one probe**
(`find_seed_nonces`, four reads, at most one per tick across every hint;
a second hint needing one is deferred, reading nothing,
`seed_probes_deferred`) and stores the found nonces as pending; the hint
is then retried at the **next slot** (bounded by `MAX_TRANSIENT_RETRIES`,
then the ordinary refresh). A plan that refuses its cache
(`SeedNotReady`, `NotCanonical("seedcache")`, `Unreadable("seedcache")`)
forgets the nonce if it was remembered, puts it on a **cooldown**
(`BAD_NONCE_COOLDOWN_SLOTS`, 256 slots — a cache can be posted, corrected
or superseded later, a fork can resolve; nothing is blacklisted for
good), drops the learned key so it is read again from the chain, and
retries next slot if another pending nonce is not cooling. An accepted
nonce is remembered and its cooldown entry cleared. Each attempt is a
whole plan over its own snapshot — **no nonce is ever substituted inside
a sealed snapshot**; a contradictory cache blocks. The learned-key,
remembered, pending and cooldown maps are bounded. `NotGathered { bell }`
records a
**gather follow-up** `(province,
bell)` (bounded set) listed as a gather hint from the next tick, so a bell
whose arrivals the feed never showed is still gathered and the province
advances; any other resolve outcome clears the province's follow-ups. The
hint list order is settles, returns, gathers (model ∪ follow-ups),
resolves, reveals, under the existing two-plans-per-tick cap with the
rotating cursor (no hint starves another). `widereview::KIND_RESOLVE`
(`wide-resolve:<world>:<key>:<bell>`); counters `resolve_plans`,
`resolve_candidates`, `seed_probes`; a `resolve` status entry.

**Tests** (`wide_duties.rs`, literal bytes and public math; a `ResolveFx`
whose province is the ABI's own resolvable layout — the generated terrain
and sites of a literal ring seed, every site free, a keep on a free tile,
no camp — under a Season with the quicknet clock and the `MC_LOCAL_7D`
conquest block, THE anchor at `A_TS`, a SeedCache at nonce 3 with the
Season's own seed round):
`a_resident_only_resolve_candidate_runs_the_bell_model_on_scratch_bytes`
(the nine roles, the data, the cache seed, nothing created, the input
digest recomputed by the test, a present roster taken as is, three live
read waves), `a_resolve_with_gathered_arrivals_predicts_the_roster_creation_and_its_full_rent`
(the bit set, the record complete and writable, one arrival of the keep
holder's faction on a free tile stays and claims an entry — the one
assertion that rests on the kernel's outcome — the roster created, the
full minimum plus the fee required and a lamport short unmet; no record,
a partial record, a resolved record, another bell's record refused; a
complete record with the bit clear taken),
`a_resolve_blocks_on_wrong_cache_archive_identity_and_timing` (no nonce,
the cache absent, another bell's cache, a stored nonce that recomputes
another address, another round, another anchor key, the archive path
with the same account in both positions and no nonce, an archive without
the bell, another province's roster, the province absent / legacy /
another world, the window by a second, no clock, the end bell, no
conquest block), `a_resolve_candidate_is_bound_to_its_snapshot_and_content`
(four mutations lose everything), `resolve_hints_are_the_observed_open_provinces`,
`the_tick_plans_a_resolve_after_a_bounded_nonce_probe_and_enqueues_nothing`
(no hint without a resolver; two learning reads, four probe chunks, three
reads with the nonce, one snapshot holding the cache; a coherent
candidate, every hard denial, nothing pending; the remembered nonce
needs no probe; `NotGathered` lists the gather of that bell next). After
the independent review:
`resolve_hints_rotate_over_every_observed_province_under_the_plan_cap`
(seventy observed provinces, the one ready among them wherever its key
sorts: thirty-five ticks of exactly two plans inspect all seventy once —
the ready one reaching its discovery — and thirty-five more plan it to a
candidate; the port's reads counted; the rotation then starts over),
`two_resolve_hints_share_the_plan_cap_and_the_one_probe_per_tick` (two
provinces of different regions both needing discovery: two plans and one
probe in the tick, the second hint deferred reading nothing, both
candidates over the following slots, every read counted), and
`a_refused_seed_cache_is_forgotten_and_rediscovered_with_bounded_reads`
(one plan per tick throughout: discovery stores nonces 1 and 3; 1 refused
and cooling, 3 tried next slot and accepted; the remembered 3 turning bad:
forgotten and cooling, blocked; a probe finding only cooling nonces:
blocked, nothing tried; the cache at 1 corrected and 1's cooldown over:
the **same** nonce tried again and accepted; every tick's reads and
snapshots counted). The tick test now shows discovery and the plan with
the nonce in two consecutive slots with the reads of each. After the
parent's first run: the arrival fixtures carry the doctrine's dealt
multiplier (`of_faction_v3(0).dealt_bps(Hold, arrival)`, what the reveal
writes; the kernel refuses anything outside `[BPS_ONE, COMBAT_MAX_BPS]`
as `BadMultiplier` — the fixture was wrong, not the planner), and the
literal snapshot fixture serves its context slot at the request's
`minContextSlot` when asked (`serve_at_requested_slot`), as a live RPC
does — a fixed slot 900 made every plan at a later tick `Snapshot(Stale)`
before the planner ran, which is what the four zero-candidate runtime
failures were. Runtime assertions now print the newest review entry (hint,
outcome, Block code) when a candidate was expected.

**Exact limits.** The candidate is unsigned and unsent; the model is the
ABI's, replayed here, and the program applies its own; the output digest
is at the observed clock; the nonce probe trusts the chain's account
bytes at their canonical addresses, nothing else; history before the
applied records is unknown; the snapshot is coherence at a context slot,
not currency. The kernel-dependent expectation (the lone arrival stays)
is one assertion of one test, stated as such. Not compiled or run by its
author. **WideSettleTransit is the next slice; nothing here settles an
arrival, pays a resolver or closes a record.**

## Tenth slice (2026-11-08, on `04c7f937`): the pure settlement shared, the first WideSettleTransit candidate

**Feasibility and extraction, as audited.** `proc/wide.rs::settle_transit`
is the deployed SettleTransit over the wide records: seventeen fixed
accounts and an optional Citizen, a 333-byte datum (`SettleTransit`:
slot, commit, 264-byte seal, beneficiary). Its pure part — the quota over
full identities (`wide_admit`), the outcome against the resolved final set
(`wide_valid_outcome`) and the post-judgement payment plan
(`plan_settlement`, with `WideOutcome`, `PayTo`, `SettlementPlan`) —
depended only on ABI and rules types (`WideTransit`, `WideArrival`,
`wide_slot_key`, `SlotRefusal`, `rout_survivors`, `DESTROYED_BELOW`, the
`transit_outcome` codes). It is now **one module**,
`frontier_abi::world_index::settle`, moved **unchanged**; the program
re-exports every name under its old path (`pub(crate) use`) and keeps
`plan_settlement`'s `R` signature through a one-line wrapper mapping the
ABI's `None` to its `Overflow`, so every program test path and the
handler itself are untouched in behaviour; two now-unused imports were
dropped. No duplicated economic table exists: the keeper calls the same
functions. The parts **not** extracted, deliberately: the claim rule
(`wide_claim_eligible` → `proc::defence::refund`, a program module also
serving legacy claims), the home re-entry (`stage_return_home`), the
payment effects (`pay_wide` / `init::pay_or_divert`): moving them would
be a wider program change than this slice warrants, and the first
candidate does not need them.

**The first slice: `widesettle::plan_settle_transit`.** An unsigned
candidate (`Duty::SettleTransit`, reviewed like the others) for a march
whose **seal opens publicly** and whose host is **in the resolved final
set** with a fate that does not come home. In the handler's order: the
holding canonical and present; its transit record of the proof's slot
present, the host's holding's, at the holding's generation
(`HistoricalGeneration`, the handler's `NotImplemented`), `Settled`,
`DestroyedAtOrigin` or `Gathered` (`OriginUnsettled` for `Departed`); the
proof rebound to the record field by field; the capture lock when the
home province is present (home and its roster are listed either way);
**the proof**: the reveal's publication gate (the supplied round signature
verified for `T(arrive)` under the Season's pinned key) **and the
account's own stored signature equal to it** (`AnchorSignatureMismatch`:
the handler opens under the chain's signature, and the keeper never
substitutes one), the IBE block opened under it and the body validated
against the record's host and bell (`Crypto::IbeOpened`) — a seal that
does not open or validate is the handler's **bad seal** (confiscation),
**refused** here (`BadSealUnsupported`), never planned; the committed
root; the destination the seal names **present** and canonical
(`DestinationAbsent` otherwise: the routed settlement of a never-opened
province is not planned), a `Gathered` record only against it; THE anchor
or archive entry of `(arrive, stored region)`; `now ≥ close + 600` and
`resolved_next > arrive` (`TooEarlyToSettle`); the ClashInputs of
`(dest, arrive)` present and **resolved** (`InputsUnresolved`: bounces and
routs are not planned); the host **present in its faction's final set**
(`NotInFinalSet`), its **own slot** at that position (`SlotNotOwn`); the
fate `Stays`, `Withdrew` or `Destroyed` (`FateUnsupported` for Bounced /
Retreated: the home re-entry is not planned); no camp loot
(`CampLootUnsupported`). Then the shared `wide_valid_outcome` and
`plan_settlement`: the tip to the slot's beneficiary, the march fee (when
the record says it was escrowed) to the resolver the record names, the
bond (when escrowed) to the holding's rent payer — **every payee read from
the accounts, none chosen**; the payments listed and **summed per
recipient** (the same wallet in two roles); the escrow covering the total
and the open-transit count (`EscrowShort`, `NoOpenTransit`); the event
chains' headroom (destination and holding); the slot's and the transit
record's rent recipients named, the slot's position among the six listed
wallets when it is one. The instruction: the seventeen fixed accounts in
the table's roles, the ABI's data, sized with `packet_len` against the
packet (`Overflow("packet")` when it does not fit — nothing is dropped to
make it fit; the literal fixture fits with the placeholder payer too).

**Said, not verified (wording fixed after independent review).** The
payments are the plan's **nominal allocations** over the records as read
(`nominal_payments`, `nominal_cumulative`), not verified transfers: the
payees' account shapes are not read; the handler pays a wallet, diverts an
undeliverable recipient to `pool_owed`, and **aborts** the transaction on
an arithmetic overflow, a `pool_owed` overflow or a holding balance that
cannot back a payment; the two closes (the transit record, the slot when
not kept) run under `Sink::Never` and abort when their prerequisites fail;
neither was simulated. The fee payer's lower bound covers the **fee only**
(`widefees::FUNDING_SCOPE_SETTLE_TRANSIT`): every settled lamport is the
holding's, so `MetLowerBound` is not settlement funding. The slot's claim
eligibility is **not** predicted (the defence refund rule is the
program's) — the slot is closed to its listed rent recipient, kept for a
claim or flagged, all with the same instruction; the march's history
before the applied records is unknown; the proof's source is unverified;
coherence is a context slot. Nothing signs, simulates, sends or queues;
the gates are untouched.

**Payer roles (fixed after independent review).** The fee review's alias
rule refused a payer that was also any other account of the instruction.
A settlement names five **wallet** roles — the slot's beneficiary, the
resolver, the holding's rent payer, the settle beneficiary, the transit's
rent recipient — any of which the payer may legitimately be (the legacy
keeper settles to its own beneficiary). `widefees` is now role-aware:
`needs_of` takes the duty's wallet positions
(`SETTLE_TRANSIT_WALLET_ROLES = [8, 9, 10, 11, 16]`; empty for every other
duty), excludes only a payer in a **state** position (`PAYER_ALIASES`,
judged from the instruction alone), and reports `payer_wallet_roles` and
`funding_scope` on the needs.

**Proof retention.** `ProofStore::settle_hints(model)` lists the stored
proofs whose march the model shows **revealed and open** in the proof's
slot; the store already kept proofs past their reveal (only a later
departure of the slot or the bound evicts), so the settlement has its
seal. **No tick wiring in this slice**: the hint, the publication lookup
and the plan in `widetick` are the next stage.

**Tests** (`wide_reveal.rs`, the recorded public seal vector sealed to
`away()`, the shipped quicknet signature in THE anchor, literal wallets
read back as payees):
`settle_transit_plans_a_staying_host_from_the_shared_settlement_functions`
(the seventeen roles, the 333-byte data, the plan equal to the shared
function recomputed by the test, escrow and open count, the packet with
both payers; fee and bond escrowed to the resolver and the rent payer;
the same wallet in two roles summed; the slot's rent recipient found among
the listed wallets; a gathered record against its own destination only;
Withdrew and Destroyed),
`settle_transit_refuses_everything_outside_the_slice` (origin unsettled,
another generation, destination absent, anchor without the signature, too
early by a second, destination unresolved, no clock, no publication,
record absent or unresolved, host not in the set, another host's slot or
none, a fate that comes home, camp loot, a seal that does not open,
escrow short, no open transit, a proof not this record's),
`settle_transit_candidate_is_bound_to_its_snapshot_and_content` (coherent
over one snapshot, every hard denial, five mutations — a fate, a payee, a
flag, a data byte, the caveat lines — lose everything),
`settle_transit_payer_may_hold_wallet_roles_but_never_state_roles` (the
payer as settle beneficiary and rent payer: funded as a wallet for the
fee alone, `MetLowerBound` at 5,000 and `Unmet` at 4,999 with the
settlement's lamports untouched; the payer in the holding's or the
transit's position: `Ineligible(PAYER_ALIASES)`; another payer's plan
aliases nothing); the staying-host test also pins the caveat lines and
the `nominal_*` / `funding_scope` description keys;
`wide_duties.rs`: `the_proof_store_lists_revealed_open_marches_for_settlement`.

**Exact limits.** The candidate is unsigned and unsent; only the branches
above are planned, and every other branch of the handler is a named
refusal, not a prediction; the claim eligibility and the payee shapes are
not predicted; the program applies its own code — the same functions for
the plan, its own for the effects. Not compiled or run by its author.
**Arrival processing is not complete**: no tick plans a settlement yet,
and the bad-seal, bounce, rout, return-home and camp-loot settlements are
not planned. (The tick wiring, the payee shapes and the claim rule are the
eleventh slice below; the other branches stay unplanned.)

## Eleventh slice (2026-11-08, on `01c2d245`): the settlement in the tick; payees, closes and the claim rule replayed

**The tick.** `widetick` lists `Hint::SettleTransit(host, slot)` from
`ProofStore::settle_hints(model)` — a stored proof whose march the
observer shows **revealed and open** in the proof's slot — **only with the
`RevealInputs`** (the publication source and the public beneficiary: the
settlement opens the seal under the same `tlock_round(arrive)` the reveal
did, and names the same beneficiary as the settler's; without the inputs
the hint is not listed, and the status says so). Each hint is planned by
`widesettle::plan_settle_transit` under the **same shared cap** of two
plans per tick (one plan per hint per tick; the settle-departure, return,
gather and resolve hints of the same tick share it — in the runtime test
the two hints listed before it spend the first tick's cap and the
settlement is planned on the next), with `min_slot = max(tick slot, proof
slot)`, over one snapshot **with the Rent sysvar** (the payees' divert
rule needs it); without a snapshot source the live driver
(`settle_transit_via`) reads the Rent sysvar once, separately, and its
candidate is non-coherent. The ledger entry (`settle_entry`) follows the
reveal's rules: a transient block (`is_transient`: the publication not
served, no clock, a read or snapshot failure) is retried at the next slot
at most `MAX_TRANSIENT_RETRIES` times; a candidate and every other block
wait `REFRESH_SLOTS` (a settlement has no closing window, so no shorter
refresh); a **newer proof** of the same march invalidates the entry at
once (`waits` checks the proof sequence for reveal and settle-transit
hints alike). The candidate is reviewed as a duty (`review_candidate`,
`Subject::of_duty`) and reconciled against the destination's and the
holding's observed heads. Counters `settle_plans` / `settle_candidates`
and a `settle_transit` status entry; the reveal's `publications_missing`,
`transient_retries` and `proofs_renewed` count both kinds (said in the
status). Nothing is enqueued, signed, simulated or sent; no gate changes.

**The payees' shapes and the handler's effects, replayed exactly.** The
planner now reads the five wallet roles — the slot's beneficiary, the
resolver the record names, the holding's rent payer, the settle
beneficiary, the transit record's rent recipient — and the fee payer only
when the slot would close to it (its `rent_to` at position 0; under the
review's placeholder payer that case is refused, `PayerPlaceholder`,
rather than judged against the System Program's account). An address the
chain does not hold is a zero-lamport System address, as the runtime
presents it. The handler's effects are replayed **in its order over the
running balances**, from `proc/wide.rs::settle_transit`, `pay_wide`,
`owe_wide` and `init::{pay_or_divert, move_lamports, diverts, close_to}`
read in full: the payments tip, march fee, bond, reward — the plan's own
`PayTo::PoolOwed` and a **program-owned** recipient are owed in
`pool_owed` with no lamport moved (`pay_wide`: `to.owner == program`);
otherwise `diverts(to.lamports, amount, rent(to.data_len))`, `None` being
the handler's `Overflow` (`Overflow("payee balance")`), a wallet the
payment would leave **below the Rent sysvar's minimum** for its data
length is **diverted** (the lamports stay in the holding — the sink's
`move_lamports(holding, holding)` is a no-op — and `pool_owed += amount`,
`Overflow("pool_owed")` on wrap), a wallet at or above it is paid from the
holding's lamports (`move_lamports`: `Insufficient` → `HoldingBackingShort`
with the payment, the holding's lamports and the amount); then the slot:
**kept** when claim-eligible, else **closed whole** to its immutable
`rent_to` when that is one of the six listed accounts (`close_to` under
`Sink::Never`: a recipient the whole balance would leave below its minimum
is the handler's `BadAccount` → `CloseWouldDivert("slot")`; a program-owned
recipient is paid directly, as `pay_or_divert` does for a close), else
**flagged** settled; then the transit record closed whole to its
`rent_to` the same way (`CloseWouldDivert("transit")`). The same wallet in
two roles sees each effect on the balance the previous one left; the
facts carry `payee_shapes`, the holding's lamports before and after, its
Rent minimum, `pool_owed` before and after, `predicted_balances` for every
listed wallet, `slot_disposition` (`KeptForClaim` / `ClosedTo{position,
lamports}` / `FlaggedSettled`), `transit_close_lamports`, and each
payment's `route` (`Wallet`, `OwedProgramOwned`, `DivertedBelowRent`,
`OwedPool`) — all **candidate content** (a changed route, disposition or
balance loses the snapshot). The Rent sysvar must be among the reads
(`RentSysvarMissing` otherwise: the divert rule is the sysvar's minimum,
`Rent::minimum_balance`, not a constant). One rule here is **not the
handler's**: the runtime's invariant that a program account whose lamports
changed must stay rent-exempt is checked for the holding and refused
conservatively (`HoldingBelowRentExemption{after, floor}`); it is named as
such in the facts and the code. No recipient, payout or amount is chosen
by the keeper; nothing economic is new.

**The claim rule, mirrored.** `wide_claim_eligible` is reproduced line by
line from the program: THE anchor's landing slot present (`None` once
archived → not eligible), the slot unclaimed, `now < close +
CLAIM_GRACE_BELLS × 600` (the ABI's constant, 6), `ev_slot − anchor_slot ≥
lateness_slots` (saturating), and `defence_refund(Evidence{ev_price,
ev_limit, ev_loaded, created_day: false}, DefenceParams{defence_cap_milli,
tip_min}) > 0` with `tip_min = min_tip_lamports(min_reveal_priority_milli,
reveal_cu_limit, reveal_loaded_limit)` — the rules crate's functions the
program itself imports (`permutation_rules::frontier::fees`; the program's
`defence::refund` is its u64 fast path of the same integers). The facts
carry the inputs and the verdict (`claim: ClaimRule`). An eligible slot is
kept untouched even when its rent recipient is listed, as deployed.

**Read rounds and the Rent in discovery (fixed after independent
review).** The home province and its roster are the host reference's
(the holding at the canonical address has that coordinate, checked), so
they are asked in the first round with the Season, the holding and the
transit; the destination second; the anchor, the archive, the record, the
destination's roster and the faction's four slot addresses third (the
host's position is known only once the record is read; the handler reads
one slot — the extra three reads are the keeper's, a bounded cost, not a
rule); the payees fourth. `snapshot_plan_with`'s key discovery runs over
ordinary reads whose `Reads.rent` is empty, so the planner's Rent
requirement would have refused every snapshot run: now, when a planner
says `RentSysvarMissing` during discovery and the snapshot was requested
with the Rent, the discovery reads the Rent sysvar **once** (an ordinary
read, like the clock) and evaluates again — the fifth evaluation asks, the
sixth decides, within the shared bound of six (`MAX_READ_ROUNDS`). Other
planners never say it, so their read counts are unchanged. **The final
judgement is over the one response alone**: its accounts, its Clock, its
own Rent; nothing of the discovery reads is kept, and no candidate is
blessed from mixed reads. A port that holds no Rent sysvar refuses in
discovery (`RentSysvarMissing("discovery read")`) before any snapshot is
taken.

**Close recipients that are not ordinary wallets (fixed after independent
review).** The first version credited a close's recipient without
modelling the source side: a slot whose `rent_to` is the transit record
(listed through the transit's own `rent_to`) would enlarge the record the
next close empties; a record closing to the holding would need the
holding's post-payment balance; a self-close's transfer is a no-op. None
of that is modelled in this narrow slice: a close whose recipient is a
**state account of the instruction** (every position but the six wallet
roles: the Season, the holding, the destination, the record, the slot,
the home, the anchor, the transit, the rosters, the System Program) or
**any program-owned account** is **refused** (`CloseRecipientAlias("slot"
| "transit")`), a conservative refusal that is not a handler rule and is
named as such. Ordinary **wallet** aliases stay exact in the handler's
order: a payment then a close on the same wallet, the slot's close then
the transit's (an unfunded wallet that the slot's whole balance funds
takes the transit's ten lamports next; the same wallet given the
ten-lamport slot first diverts, whatever the transit would bring).
Payments to program-owned recipients remain exact (owed, no lamport
moves).

**The fee payer among the payees (said, not guaranteed).** The fixture's
payer is also the transit record's rent recipient; in general the settler
may be any of the five wallet roles. Its shape in the reads is **before**
the transaction fee it pays, so the routes and the predicted balance for
it are conditional on that pre-fee shape (`payer_is_payee`, `payer_note`
in the description, the `UNVERIFIED` line). The prediction stays
conditional; no execution outcome is guaranteed; every gate stays closed.

**Said, not verified.** Every payment line is a **nominal** allocation
whose route is **predicted over the shapes as read at the context slot**
— never an observed or successful transfer; the program applies its own
code later against the shapes of that moment, and a payer that is also a
payee pays the transaction fee first, which the replay does not see
(`UNVERIFIED`, reworded). The fee payer's bound is the fee only. The
history before the applied records is unknown; the proof's source is
unverified; coherence is a context slot. Every candidate is still denied
by the engine review.

**Tests** (`wide_reveal.rs`; literal wallets and shapes; the recorded
public seal vector; the shipped quicknet signature; no key):
`settle_transit_predicts_payment_routes_over_the_payees_shapes_in_the_handlers_order`
(funded payees delivered and the holding down by the total; the same
wallet in two roles one lamport under the floor after the fee — the fee
diverted, the bond delivered over the balance the diverted fee left — and
one lamport more both delivered; an address not held by the chain
diverted; a program-owned recipient owed with no floor; `pool_owed` as
read the base; the description's `predicted_route`; routes, disposition
and balances as content),
`settle_transit_refuses_what_the_handlers_payments_and_closes_would_abort`
(no Rent; the holding unable to back the tip; the holding one lamport
below its minimum after and exactly at it; a diverted payment leaving a
holding at its floor untouched; a payee's balance overflow; `pool_owed`
overflow; the transit record's close diverting and taken one lamport
under; the slot's close diverting and taken whole to position 9; the
slot's recipient the payer's position — judged for a named payer, refused
under the placeholder; the transit closing to the holding or to itself,
the slot closing to the transit record, a program-owned account at the
transit's recipient position — each `CloseRecipientAlias`; the same
wallet in both close roles exact in the handler's order),
`settle_transit_mirrors_the_programs_claim_rule_for_the_slot` (the
fclient claim test's literals: kept when late by the lateness, rich,
unclaimed, within the grace — also with a listed recipient; one second
before the grace end kept, at it not; claimed, one slot short, a zero bid:
not; the default Season's `tip_min`),
`the_tick_plans_a_transit_settlement_from_a_revealed_open_march_under_the_shared_budget`
(an observer model with the march departed and revealed; without the
inputs no settle-transit hint; with them the first tick's cap spent on the
two hints before it and the settlement planned on the second tick as a
coherent denied candidate with the Rent in its snapshot, the seal and
commitment absent from the status; `payer_is_payee` false under the
placeholder; the third tick nothing; a newer proof renews; the live
driver's non-coherent denied candidate; a port without the Rent refused on
the live path and in snapshot discovery with no snapshot taken; a
generation-2 holding refused; a publication not served retried at the
next slot). The four existing settle tests keep passing
under the funded-wallet fixture (`SettleFx` gained the lamports, wallets
and Rent; its snapshot helper includes the Rent). Preserve the existing
124 keeper tests; the four new ones are the only additions. Not compiled
or run by its author.

**Exact limits.** Only the slice's branches are planned; bad seals,
absent destinations, bounces, routs, returns home and camp loot are named
refusals (the twelfth slice below plans the record's bounces, routs and
returning fates; bad seals, absent destinations, unresolved records and
camp loot stay refused). The replay is over the reads at a context slot: a payee's shape,
the holding's lamports, `pool_owed` and THE anchor can all move before any
execution, so every prediction is of the reads, not of a transaction. The
runtime's rent-exemption invariant is checked for the holding only
(the closed accounts end at zero; a wallet receiving lamports never
transitions downward). Without reveal inputs or a stored proof no
settlement is planned. **Arrival processing is still not complete**, the
game is not playable from this, and nothing is sent.

## Twelfth slice (2026-11-08, on `20c79f62`): the host that comes home — bounces, routs and the returning fates

**What the handler does, read in full.** `proc/wide.rs::settle_transit`
takes the outcome from the shared `wide_valid_outcome` (a host **in** its
faction's resolved final set has its fate; **outside** it, `wide_admit`
over the present records refusing it is the record's **outranked bounce**,
and anything it would have filled or displaced is a **rout**; no resolved
record is a rout nobody resolved) and the plan from the shared
`plan_settlement` (the table in the tenth slice; the returning values:
Bounced/Retreated from the record's `troops_after` and arrival stamina, an
outranked bounce the transit's post-origin `troops_after` /
`stamina_after`, a rout `rout_survivors(troops_after)` with stamina 0;
below `DESTROYED_BELOW` nothing returns). A host that comes home is staged
by `stage_return_home` over the home province and its roster: the unit and
the doctrine (`BadAccount` otherwise), the doctrine's Hold `dealt` as
`u16`, `from = now_bell + 1`, `ready = max(depart + ready_bell_off,
from)`; with a roster present (`roster_at`: absent is the reserve
fallback; present must be paired with the province's live entries,
`BadAccount` otherwise) the entries are scanned — states 1–2 counted in
total and for the host's faction, the first free index kept — and the
caps decide (`ROSTER_CAP` 48 total, `FACTION_CAP` 8 per faction → the
reserve); a kept index has the roster **claim** the full reference
(`claim_alias` over the regenerated table: already present or a collision
is `BadAccount`) and the muster-pending entry written (`Entry::from_host`,
`write_entry`), `n_entries` saturating up and the epoch wrapping; else
`reserve[unit] += troops / 1,000` (`Overflow` on wrap). The home province
must be present for a return (`BadAccount`); `credited` for the Return
record is the troops when an entry was staged, else the whole units ×
1,000. The stamina is dated `now_bell` when routed, the arrival when the
record holds the host, else `effective_bell(depart)`. The TransitSettled
record chains the destination and the holding; a return adds the Return
record on the home and the holding.

**What the planner now plans, exactly that.** `widesettle::
plan_settle_transit` reads the record's four positions and takes the
host's position **or 0** (the handler's `slot_i`); the slot at that index
is the host's **own** when present and its (absent or another host's is
no slot: nothing of it is read, kept or closed, `SlotDisposition::NotOwn`,
`own_slot: false`); a host **in** the set still needs its own slot
(`SlotNotOwn`: the tip to `pool_owed` for a final-set fate is not
planned). Every fate 1–5 is planned: Stays/Withdrew as before; Destroyed;
**Bounced and Retreated come home with the record's values**. Outside the
set, the **outranked bounce** (the tip to the holding's rent payer, the
transit's post-origin values home, stamina dated `effective_bell(depart)`)
and the **rout** (the tip owed to `pool_owed`, `rout_survivors`, stamina 0
dated `now_bell`) are planned from the shared functions over the record;
`Routed { resolved: false }` (an absent or unresolved record) stays
`InputsUnresolved`: the handler settles it with the tip and the fee owed
and the resolver position **unlisted**, and this planner chooses no
account for a position. The home re-entry is `stage_return_home`
**replayed line for line** over scratch copies of the home province and
its roster as read (the keeper's `stage_return_home`, documented against
the handler's): `ReturnHome` carries the troops and stamina, `routed`,
`stamina_bell`, `now_bell`, `from_bell`, `ready_bell`, `dealt_bps`, the
roster's presence, the live and own counts, the staged `entry` or `None`,
the reserve unit and its before/after, `credited_milli`,
`n_entries_after` and `roster_epoch_after`; `destroyed_on_return` says a
returning host fell below `DESTROYED_BELOW` (nothing staged, nothing
logged); `troops_logged_milli` is what the TransitSettled record logs.
Refusals where the handler fails: `ReturnNeedsHome` (the home province
absent), `RosterUnpaired` (a present roster not paired with the live
entries), `NotCanonical("roster")` (another province's or season's
roster), `RosterClaimRefused` (the roster already vouches for the host or
the alias collides), `BadUnit` / `BadFaction` (no reserve unit / no
doctrine), `ReserveOverflow`, `BadEntry`, `SeasonNotStarted` (the
handler's `now_bell` before genesis, `WrongStatus`). The chains: the
holding takes two records for a return, the home one (the destination
twice when it is the home). The budget is untouched: the home roster is
already in the first read round, the record and the four slots in the
third; still one plan per hint under the shared two-plan cap, the same
coherent snapshot with the Rent. **Position 8** (the slot's beneficiary)
is read by the handler only when the host's own slot exists; without one
the caller's beneficiary — already listed at position 11 — fills the
position and nothing is paid there (the plan's tip goes to the rent payer
or `pool_owed`). The old-generation refusal, the capture-provenance
absence, the payee replay, the closes and the claim rule are as in the
eleventh slice; no payout, owner or destination is chosen by the keeper.

**No shared extraction.** `stage_return_home` reads and writes account
bytes through the program's `Ro`/`Rw` and its `R` error type and touches
`Entry`, `WideRoster::claim` and the kernel `Host`; moving it would be a
program refactor beyond this slice, and its behaviour is small enough to
mirror line for line (the keeper's copy is documented against the
handler's lines and pinned by the tests below). The outcome and the
payment plan stay the **shared** ABI functions; nothing economic is
duplicated.

**Tests** (`wide_reveal.rs`, literal bytes, the recorded public seal
vector and the shipped quicknet signature; no key):
`settle_transit_stages_the_returning_fates_as_stage_return_home_does`
(Bounced with 150,999 milli to the reserve as 150 whole units credited
150,000; a held reserve added to; Retreated the same path; a paired empty
roster → the entry at index 0 with the exact troops, `from`/`ready`/
`dealt`, the counts up by one; the first free index after two live
entries; the 48 total cap and the 8 per-faction cap → the reserve with
the roster present; departed entries counting toward neither; below
`DESTROYED_BELOW` nothing comes home, exactly at it zero whole units; a
Destroyed fate not "destroyed on return"),
`settle_transit_plans_the_outranked_bounce_and_the_rout_from_the_record`
(a larger same-Citizen host present → the bounce: tip to the rent payer,
the transit's values home dated `effective_bell(depart)`, `NotOwn`, the
unpaid position 8 carrying the caller's beneficiary; another Citizen's
host and a free position → the rout: tip owed, `rout_survivors`, stamina
0 at `now_bell`, into the reserve or a paired roster's entry; 998 troops
routed to 499 → nothing comes home),
`settle_transit_refuses_a_return_the_handler_would_refuse` (home absent —
a staying host still plans; an unpaired roster; another province's
roster; a roster already vouching for the host; a generation-2 holding;
an unresolved record; a returning candidate over one snapshot coherent
and sealed to its staging — the entry, the reserve, the set membership,
the destroyed line — denied by the review with nothing enqueued). The
existing refusal test's two cases that this slice now plans (not in the
set; a Bounced fate) were replaced by the pins above; its `SlotNotOwn`
cases stand.

**Handler tests to run by exact name (unchanged program):**
`wide_land_native_settles_a_real_wide_seal_and_confiscates_a_bad_one`,
`wide_land_march_stages_settle_a_staged_departure_up_to_the_crypto_gate`,
`wide_land_host_musters_resolves_dissolves_and_returns_through_the_envelope`
(the WideReturn path, not the settle's). **No program test exercises the
settle's return-home, bounce or rout branch**; parity here rests on the
line-for-line reading and the keeper pins. Not compiled or run by its
author.

**Exact limits.** Bad seals, absent destinations (the routed settlement
under the region's anchor), unresolved records and the camp's loot are
still refused, not planned; a final-set host without its own slot is
refused. The staging is a prediction over the reads at a context slot: the
home province's entries, its roster, the holding's reserve and the clock
can all move before any execution. Nothing signs, simulates, sends or
queues; every candidate is denied; every gate stays closed; **arrival
processing is still not complete** and the game is not playable from
this.

## Thirteenth slice (2026-11-08, on `08969fae`): the return branches through the real dispatcher, compared with the planner

**What was missing.** No program test executed the settle handler's
return-home, bounce or rout branch; the twelfth slice's parity rested on
reading. This slice adds **host dispatcher tests** of those branches in
`permutation-frontier/src/wide_land_runtime_tests.rs`, under the existing
opt-in native build (`--features native-crypto-tests`, not `test-beacon`,
host target), over the existing literal `AccountInfo` harness and the
shipped **public** seal and beacon vectors, and a keeper test that checks
the planner's predictions against the **same** expectation file.

**The shared fixture.**
`permutation-rules/vectors/wide-settle-return-expectations-v1.json`:
world-independent rules as flat string fields (the shape of
`seal-vectors-v1.json`, parsed by the program's line scanner
`crypto::seal::tests::cases_in` — a two-line refactor of `cases` — and by
the keeper's `serde_json`): for the record's outranked bounce
(`bounce_unranked_roster_entry`: 101,000 milli, outcome 6, the transit's
stamina dated `effective_bell(depart)`, tip → rent payer, fee → resolver,
bond → rent payer, a roster entry, 101,000 credited, two records, chain
deltas holding 2 / home 1 / destination 1), the rout
(`routed_reserve_fallback_rounding`: 401,000 milli, outcome 7,
`rout_survivors` 200,500, stamina 0 at `now_bell`, tip → `pool_owed`, the
reserve under the faction cap of 8, +200 whole units, 200,000 credited),
the bounced final-set host (`bounced_final_set_roster_entry`: 300,000
milli, outcome 3, the record's stamina dated the arrival, tip → the slot's
beneficiary, a roster entry, the slot closed to its rent recipient), and
three refusals (historical generation → `NotImplemented` /
`HistoricalGeneration`; another account in the home position →
`BadAddress` / not reproducible by the planner, which derives the address;
an unpaired home roster → `BadAccount` / `RosterUnpaired`; each writing
nothing). It is a fixture of **rules**, not chain evidence: each test
derives its own literal world and checks these fields against what it
observed (dispatcher) or predicted (planner).

**The dispatcher tests** (both call `crate::dispatch` through `run_tx`,
which snapshots every account and restores it on a refusal):

- `wide_land_native_settles_unrevealed_marches_home_as_the_record_says`:
  the first native settle test's world with four marches staged as
  WideDepart writes them (the debit gate stays closed): A 300 and D 101
  and E 401 troops of Citizen a on one holding, B 200 of Citizen b on
  another; all four seals **valid** (the vector's IBE block and recovered
  key, each plaintext naming the destination); THE anchor of bell 20
  staged with the vector's round-T signature **verified against the
  production key** before staging; A and B reveal, D and E never do; the
  record gathered and resolved by a third wallet. Then, at the settle
  time: three refusals that write nothing — the holding's `GEN` set to 2
  (a fixture of what the lottery leaves) → `NotImplemented`; the
  destination province handed in the home position (test-only helper
  `settle_transit_home`) → `BadAddress`; a roster reference claimed with
  no entry (released again after) → `BadAccount`; balances, chains and
  receipts unchanged. **D** settles as the record's outranked bounce: the
  tip and the bond to the holding's rent payer (with the record's rent),
  the fee to the resolver, nothing to the slot beneficiary or the
  settler's beneficiary; the escrow and the open count down by one march;
  the record closed; A's slot at position 0 byte-identical (another
  host's slot is not read, kept or closed); `settled_mask` unchanged; a
  muster-pending entry at the first free index with 101,000 troops, the
  transit's `stamina_after`, `stamina_bell = effective_bell(6) = 7`,
  `from = 24`, `ready = max(6 + ready_bell_off, 24)`, the doctrine's Hold
  `dealt`, its reference claimed in the roster, `n_entries + 1`; two
  receipts (TransitSettled `[slot, 6, VALID]`, troops 101,000, the three
  amounts, `home_credited`; Return credited 101,000, unit 0, the entry
  index); the holding's chain + 2, the home's + 1, the destination's + 1;
  no DIVERT; replay `TransitState`. Then the home at the faction cap (D's
  entry plus seven **staged** residents of the faction, `stage_resident`,
  a test-only fixture of settled musters paired in the roster) and **E**
  settles as the rout: the tip **owed** (`pool_owed` + tip, the holding's
  lamports down by fee + bond only, no DIVERT since the holding is its own
  recipient), the fee and the bond as before, `rout_survivors(401,000) =
  200,500` → the reserve + 200 whole units, no entry, Return credited
  200,000 with entry `0xFF`; chains + 2 / + 1 / + 1; replay refused.
- `wide_land_native_settles_a_bounced_final_set_host_home`: the same
  world with `FACTION_RESIDENT_CAP` (8) resident hosts of the faction
  **staged** at the destination before its resolves (fixtures of settled
  musters, the destination's roster staged as the resolve creates it);
  the room rule bounces A and B at the resolve (`FATE_BOUNCED` in the
  record, troops intact). A then B settle: the tip to the slot's
  beneficiary, the fee to the resolver, the bond to the rent payer with
  the slot's and the record's rent (both closed to their immutable
  recipients), the position marked settled, a muster-pending entry at
  home with the record's troops and stamina dated the **arrival bell**,
  `from = 24`; two receipts; chains + 2 / + 1 / + 1; replays refused.

Every observed value that the fixture names is asserted equal to the
fixture's field, so a drift in either the handler or the fixture fails the
test.

**The keeper test**
`settle_transit_return_predictions_match_the_shared_dispatcher_expectations`
(`wide_reveal.rs`): the planner over equivalent literal fixtures (101,000
milli bounced by a larger same-Citizen host; 401,000 routed with eight
own-faction entries at home; 300,000 bounced in the final set with its own
slot whose `rent_to` is the listed payer) predicts the same outcome codes,
set membership, troops and stamina rules, payee roles, roster entry or
reserve, credited amounts and reserve deltas, slot dispositions; and
refuses `HistoricalGeneration` and `RosterUnpaired` by the fixture's
names. The chain deltas are the dispatcher's alone (the planner checks
headroom, not counts), and the home-address refusal is the dispatcher's
alone (the planner derives the address).

**How no signing is guaranteed.** The harness has no keypair and no
signer: every wallet is a literal 32-byte address with `is_signer` set by
the test on the `AccountInfo`; `run_tx` calls `crate::dispatch` directly;
the only signatures anywhere are the shipped **public** quicknet round
signatures of the seal vectors, verified against the production key with
`quick::verify` before staging, as the existing native tests do. No
network, no funds, no deployment, no production handler or gate change
(`DEPART_DEBIT_ENABLED` is read, never set; the departures are staged
fixtures in these two tests). Test-only helpers added to the harness:
`settle_transit_home`, `free_tiles`, `stage_resident`, `native_q3_scene`,
`return_expectations` / `expectation` / `expected_u64`, all under the
native cfg.

**Limits, stated.** `Retreated` is not produced: it needs a battle with a
retreat ratio (the routes end away from garrisons by construction), so
the planner's Retreated path has keeper pins only. The residents and the
departures are fixtures in the shapes the program writes, not the
program's own writes; the first native test already shows the real
WideDepart and the real posts in the open-gate build. The fixture file
pins rules, not a chain. Not compiled or run by its author; the parent
runs the three new tests by exact name under the native feature
(`cargo test -p permutation-frontier --features native-crypto-tests
map_growth_runtime_tests::wide_land::wide_land_native_settles_unrevealed_marches_home_as_the_record_says`
and `..._settles_a_bounced_final_set_host_home`; the keeper test under
`--features wide-world-experimental --test wide_reveal`). Arrival
processing is still not complete; every keeper candidate stays denied.

## Touched files

`frontier-abi/src/world_index/settle.rs` (new, tenth slice: the pure
settlement moved from the program), `frontier-abi/src/world_index/mod.rs`
(the module and its re-exports), `permutation-frontier/src/proc/wide.rs`
(tenth slice: the moved definitions replaced by `pub(crate) use` of the
ABI's and a one-line `plan_settlement` wrapper; two unused imports
dropped; no handler line changed),
`frontier-node/crates/keeper/src/widesettle.rs` (new, tenth slice;
eleventh: the payees' shapes, the replayed payments and closes, the
mirrored claim rule, `PayRoute`, `PayeeShape`, `SlotDisposition`,
`ClaimRule`, the four slots read with the record, the Rent in
`settle_transit_snapshot` / read separately in `settle_transit_via`;
twelfth: positions outside the set, the own-slot option,
`SlotDisposition::NotOwn`, `ReturnHome`, the keeper's `stage_return_home`
mirror, the return facts, the home's chain headroom),
`frontier-node/crates/keeper/src/wideproof.rs` (new),
`frontier-node/crates/keeper/src/wideduty.rs` (new; later slices: new
`Block` variants, `pub(crate)` helpers, `Reads.snapshot`/`rent`,
the crate-private `Candidate.bound` (`Bound`, the `Canon` encoder and the
`canon` methods), snapshot drivers; eighth: `plan_gather`, `gather_via`,
`gather_snapshot`, `gather_candidates`, `Duty::Gather`, `GatherFacts`,
`GatherPosition`, `GatherSlot`, `packet_len`, `GATHER_PACKET_BYTES`,
`GATHER_POSITIONS`, six `Block` variants, `candidate_with`; ninth:
`plan_resolve`, `resolve_via`, `resolve_snapshot`, `find_seed_nonce`,
`resolve_candidates`, `Duty::Resolve`, `ResolveFacts`, `AnchorRead` /
`anchor_read` shared with the gather, seven `Block` variants; eleventh:
six settle `Block` variants — `RentSysvarMissing`, `HoldingBackingShort`,
`HoldingBelowRentExemption`, `CloseWouldDivert`, `CloseRecipientAlias`,
`PayerPlaceholder`; twelfth: `ReturnNeedsHome`, `BadUnit`, `BadFaction`,
`RosterClaimRefused`),
`frontier-node/crates/keeper/src/widefees.rs` (eighth: the ClashInputs in
`duty_needs`), `frontier-node/crates/keeper/src/widereview.rs` (eighth:
`KIND_GATHER`, the `Subject` arm), `frontier-node/crates/keeper/src/widetick.rs`
(eighth: `Hint::Gather`, the gather arm, counters, the `gather` status
entry, reconciliation targets; eleventh: `Hint::SettleTransit`, the
settle-transit arm under the shared cap, `settle_entry`, `waits` for both
proof-bound hints, `settle_plans` / `settle_candidates`, the
`settle_transit` status entry, the module doc),
`frontier-node/crates/keeper/src/widereveal.rs` (new; third slice:
the crate-private `RevealCandidate.bound`, `reveal_snapshot`, the
unverified lines),
`frontier-node/crates/keeper/src/widereview.rs` (new; third slice:
`Evidence`, `review_with_evidence`, three denials),
`frontier-node/crates/keeper/src/widesnapshot.rs` (new, third slice;
fourth: `SnapshotSource`, `snapshot_plan_with`, `SnapshotError::code`,
`SnapshotFn`/`snapshot_via`/`PortSnapshot`/`SnapshotMode`; eleventh: the
one discovery Rent read when a planner says `RentSysvarMissing` under
`with_rent`),
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
Thirteenth slice (test modules and public fixtures only):
`permutation-rules/vectors/wide-settle-return-expectations-v1.json`
(new), `permutation-frontier/src/crypto/seal.rs` (the test module's
`cases` split into `cases_in(text)`),
`permutation-frontier/src/wide_land_runtime_tests.rs` (the native-cfg
helpers `settle_transit_home`, `free_tiles`, `stage_resident`, the
`Q3Scene` / `native_q3_scene` setup, the expectation readers, two native
tests). No production handler, fclient, ABI, engine, herald, web or UI
file.

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

### Eighth-slice verification checkpoint

The final Gather tree passed 110 focused keeper tests: wide_discovery 14,
wide_duties 60, wide_feed_guard 12, wide_reveal 18, wide_snapshot_rpc 6.
Feature-on lib/binaries and selected tests passed clippy; default lib/binaries
passed clippy (compilation only). Tests construct literal fixtures and unsigned
messages; no keypairs or signatures were generated. Independent handler-contract
review found no remaining preservation blocker after bounded cursor selection,
six read-plan evaluations, prefunded-rent netting and full 24-entry scratch scan.
A malformed later slot inside the bounded cursor may conservatively block a ready
prefix; no unsafe candidate is produced. Resolve and SettleTransit keeper duties
remain unimplemented, and the arrival-to-battle flow is not complete. Actual Keeper
startup/tick and real-chain submission were not executed; all send gates stay closed.

### Ninth-slice verification checkpoint

Final focused tests passed: wide_discovery 14, wide_duties 69,
wide_feed_guard 12, wide_reveal 18, wide_snapshot_rpc 6 (119 total).
Feature-on lib/binaries and selected tests, and default lib/binaries,
passed clippy. Five initially failing new tests exposed invalid literal
combat multipliers and stale fixed snapshot slots; fixtures were corrected
to actual doctrine values and explicitly requested response slots, without
weakening production checks. Independent review verified bounded two-driver
scheduling, one shared four-read nonce probe, all-province rotation, and
expiry/retry of transiently rejected nonce hints. No keypair generation,
signing, simulation, queue admission, actual Keeper startup or chain sending
was run. Resolve now produces a snapshot-bound unsigned instruction using
the shared combat kernel; SettleTransit keeper integration remains absent.

### Tenth-slice verification checkpoint

Final keeper suites passed 124 tests (14 discovery, 70 duties, 12 feed guard,
22 reveal/settlement, 6 snapshot RPC). Feature-on keeper libraries/binaries and
selected tests, and default libraries/binaries, passed clippy. The changed ABI
and program libraries passed Rust 1.89 clippy with the wide feature. Three
individually audited, exact-name host tests passed: staged march up to the crypto
gate; native public-vector valid/bad-seal settlement; native departure/beacon/
settlement flow. The native cases only verify published public cryptographic
vectors; no keypairs or signatures were generated. The stub-only test build
reported nine dead-code warnings in native-vector helpers unused in that mode.
Independent static review found no preservation blocker for this narrow unsigned
planner. Settlement runtime scheduling, actual payee execution/backing checks,
slot-claim eligibility and return-home/camp branches remain outside this slice.
No real-chain transaction, Keeper startup, main merge or deployment was performed.

### Eleventh-slice verification checkpoint

The final tree passed 128 focused keeper tests: discovery 14, duties 70,
feed guard 12, reveal/settlement 26, snapshot RPC 6. Feature-on libraries,
binaries and these selected tests passed clippy; default libraries/binaries
also passed clippy (compilation only). Independent static review found no
remaining blocker for the declared narrow slice after fixing close-source
aliases, the discovery Rent read and the read-wave budget. Initial runs
also caught status wording compatibility and two incorrect new test
expectations (snapshot count before discovery refusal and the existing
Candidate payer field); these were corrected without weakening checks.

The runtime helper test obtains a coherent settlement candidate from an
observed revealed march and a published public vector, within the shared
two-plan budget. It checks refusal without Rent, non-coherence without a
snapshot, proof refresh and cooldown, and zero enqueue. All tests use
literal accounts/public verification vectors and unsigned instructions;
no keypair generation/derivation, signing, actual Keeper startup, chain
submission, simulation or deployment ran. The program handler code is
unchanged in this slice, and the previous exact host-handler test results
were not rerun. Predictions are conditional on the read account shapes,
not execution guarantees: payer fee debit remains outside this replay.
State-account/program-owned close recipients are conservatively refused.
Return-home, bounce, rout, bad-seal and camp-loot settlements remain
unplanned; arrival processing and playable live integration are incomplete.
Every candidate remains denied for unproven source/history and absent
execution/signing authorization; production gates remain closed.

### Twelfth-slice verification checkpoint

The final tree passed 131 focused keeper tests: discovery 14, duties 70,
feed guard 12, reveal/settlement 29, snapshot RPC 6. Feature-on libraries,
binaries and these selected tests passed clippy; default libraries/binaries
also passed clippy. The new return tests cover final-set Bounced/Retreated,
resolved unranked bounce and rout, roster/reserve fallback, milli rounding,
capacity/identity refusals and candidate-content binding. An initial test
expected cumulative recipients in the wrong order; it now pins the actual
first-payment order without changing amounts or production code. A clippy
match-guard cleanup preserved the first-free-entry behavior and all tests
were rerun afterward.

Independent static review found no blocker in this declared slice: same
existing outcome/payment table, roster full-identity checks, 500-milli
return threshold and 1000-milli reserve rounding, readiness/stamina and
same-province event headroom. The program is unchanged. No test currently
executes the settle handler's return-home, bounce or rout branch itself;
parity rests on source comparison plus keeper tests, not demonstrated
handler execution. This is an important remaining verification boundary.
Bad seals, absent destinations, unresolved records, camp loot and unknown
historical generations remain refused. Predictions are over read account
shapes, not executed transfers. All source/history/send gates remain closed.
No keypair generation/derivation, signing, Keeper startup, real transaction,
simulation, main merge or deployment was performed.

### Thirteenth-slice verification checkpoint

Both new exact-name native dispatcher tests passed on the final tree:
`map_growth_runtime_tests::wide_land::wide_land_native_settles_unrevealed_marches_home_as_the_record_says`
and
`map_growth_runtime_tests::wide_land::wide_land_native_settles_a_bounced_final_set_host_home`.
They execute real Reveal/Gather/Resolve/SettleTransit dispatch against literal
host accounts and the published quicknet seal/signature vector. They check
return entries/reserve, wallet and holding balances, pool_owed, immutable rent
refunds, slot/transit close, receipts and chain increments. Refusals assert
that no write occurred before rollback. The two previously audited native
settlement/departure tests also passed after the test-only parser refactor.

The keeper's shared-expectation test passed, as did all 132 focused keeper
tests (14 discovery, 70 duties, 12 guard, 30 reveal, 6 snapshot RPC). Keeper
feature-on library/binary/changed-test clippy passed. Program lib/test clippy
was attempted but fails on six pre-existing findings in unchanged code:
items_after_test_module in proc/wide.rs; four err_expect uses and one
needless_range_loop in older wide_land_runtime_tests.rs cases. No lint
exception or unrelated code change was made.

The JSON contains fixed expectations consumed independently by dispatcher
and planner tests; it is not generated from either output. The two sides use
different complete account worlds, so this demonstrates shared semantic
results, not byte-identical whole-world execution. New dispatcher evidence
covers unranked bounce, rout, final-set Bounced and roster/faction-cap fallback.
Retreated, 500/999-milli boundaries and same-home/destination behavior still
have planner tests/static review only, not new dispatcher evidence here.
Departures/resident setup are staged fixtures, not a full fresh on-chain game.
No private signing key, keypair generation/derivation, cryptographic signing,
network submission, actual funds, production gate change or deployment was used.
