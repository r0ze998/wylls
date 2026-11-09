# Closed legacy expedition bridge codecs

The boundary approach is approved: original homes and issued troops remain;
crossing troops use existing wide destination rules; legacy-only combat does
not change. This document describes technical representations, not pending game
rules. No runtime writer/admission or activation gate is changed. No live/on-chain state-4 marker write is admitted until the consumer work below
is complete. Private candidate handlers and isolated memory-only tests remain
behind false public gates and do not establish live admission.

## Pure API and provisional encoding

`world_index::expedition_bridge` exports `BridgeMarker`, `BridgeTransit`,
`authenticate_pair`, `PairedBridge::financial_input` and
`BridgeMarker::capture_bond_plan`. Constructors and decoders require the public
Season/program context. Fields are private; callers receive copies. No account
owner, issuance, capture authority, provenance, payment or atomicity is proven
by a successfully decoded value. A plan is a snapshot, not replay protection.

Repository source/document collision scan found no existing `PSWLEXP1` before
adding this codec. Both the marker state/version and envelope remain provisional.

- Embedded marker: exactly 96 bytes, existing Transit offsets. State 4; version
  1 in byte 93; bytes 94–95 zero. Keep unit, faction, origin coordinate/tile,
  original packed ID, departure/arrival bell, timestamp, mass, march stamina,
  dealt BPS, seal root and tip. Flags permit only existing fee/bond escrow bits.
  Result fields 40–47 and destination fields 89–92 are zero. The marker stores
  no full destination and no spendable survivors. Slot is the Holding offset.
- External bridge: exactly 304 bytes. Header 0–7 is `PSWLEXP1`, byte 8 version
  1, byte 9 slot 0–3, bytes 10–15 zero. Remaining 288 bytes are canonical
  `WideTransit`. Its tip and financial flags are always zero. Only the existing
  gathered bit may appear, and only in Gathered state. Existing `step` also
  permits Gathered without that bit: full destination/state remains authoritative.
- The issuer and origin must be same-world legacy coordinates. A recorded
  destination must be same-world wide. The slot address is existing
  `transit_address(original_legacy_holding, slot)`; no new seed/tag is allocated.
- `authenticate_pair` checks canonical original Holding/external addresses,
  slot and every immutable departure fact shared with the marker. It does not
  infer identity from a lookup alias or current destination. Tip and financial
  flags deliberately have no external copy; their authenticity comes from the
  authenticated current Holding, not a redundant field comparison.
- No live Free envelope is accepted. Pure `step` preserves rent recipient and
  departure identity and delegates lifecycle transitions to `WideTransit`.
  Final settlement closes the external account instead of serializing Free.

The four embedded and external positions are the same four positions. Codec
slot bounds and pair checks do not implement the live global quota or stop a
second host action. Those still require runtime interlocks and account checks.

## Single financial authority and capture

Original Holding escrow retains tip, march fee and bond. Marker flags alone
decide whether fee/bond remains owed. External rent belongs separately to its
immutable `rent_to`; external rent is never march escrow. The pure financial
projection copies the troop snapshot, injects marker tip only in memory and
returns fee/bond amounts from the authenticated Season's existing prices.
It rejects pending Departed state and checked-sum overflow. Pass its transit,
fee and bond to existing `plan_settlement`; never persist this temporary copy.

Capture must continue without waiting for the victim or external accounts.
The pure capture plan needs only the valid marker, current Holding escrow and
existing Season bond. It returns the same marker with the bond bit cleared,
escrow minus bond and the one refund amount. Applied again to the returned
marker, refund is zero. It does not pay, verify a recipient or apply anything;
the runtime must authenticate victim/capture and atomically perform existing
refund/diversion plus the returned changes. Reusing a stale pre-capture plan is
not safe. Re-read/pair before settlement so a stale external record cannot
cause a second bond refund. Tip and fee remain intact.

## Preserved terminal and recovery contract

This corrects the earlier foundation document's suggested CloseHolding guard:
do NOT hold closure behind open external marches. Current legacy and wide
CloseHolding allow Ended+72h, Aborted or tombstone closing, including unsettled
escrow to the existing Holding rent payer. Preserve that behavior. Thereafter
external cleanup is rent-only to external `rent_to`; no troop restoration or
second payment from already-swept Holding escrow. If the Holding still exists,
terminal cleanup clears only the matching marker without paying its ledger.
These terminal actions are requirements, not implemented by this module.

Normal returns use original legacy issuer/Province. Captured previous-generation
returns use mandatory canonical `PREV_HOME`, credited in existing whole units
when live at that generation, else lost. Current single `PREV_GEN` / `PREV_HOME`
history remains authoritative; no invented historical refund/fallback. The
captor never receives victim returning troops. Wide-resident retirement and
stranded recovery still require family-aware handling and existing victim
protection. Successful codecs do not establish these paths.

## Required consumer changes before ANY marker account write

1. Keep `layout::transit::in_transit` states 1–3 unchanged. Add a distinct
   experimental occupancy/host-lock predicate; legacy reveal eligibility must
   stay separate. Validate marker version/reserved data; malformed state 4
   fails closed rather than becoming a free slot.
2. `frontier-abi/src/prologue.rs::host_in_transit`, program `proc/host.rs`
   resident/Depart guards, and `proc/citizen.rs::release_dormant` must see bridge
   occupancy. Depart's existing chosen-slot FREE check alone is insufficient.
3. `proc/clash.rs` transit gather wildcard must exclude marker before it reads
   result fields or stamps wear/destination. `proc/reveal.rs` and
   `proc/transit.rs` legacy paths must continue refusing marker records.
4. Bridge departure applies normal legacy pending Spend and source combat.
   After resolution, atomically consume the exact source entry once and write
   only its survivors externally. Never create an origin WideRoster or issue
   another host ID. Capture-lock, ownership, generation and issuance checks are
   mandatory. Codecs alone do not prove troop conservation.
5. `proc/conquest.rs` capture bond loop recognizes valid marker while retaining
   actual capture and immediate victim bond refund. Previous-generation return
   and `retire_host_as` need family-aware wide-resident paths; do not block
   opponent capture as a substitute.
6. `proc/wide.rs` and `wide_stranded_exec.rs` must discriminate the envelope,
   authenticate the original family before parsing, bind destinations/results,
   preserve full-reference quota/combat/lead, implement paired cleanup and the
   existing terminal-expiry rules. Existing WideClose cannot decode this record.
7. Mixed route walking must preserve legacy tower coverage/wear seconds,
   palisade stops, watch stances, faction and expulsion effects. Current wide
   geometry walking alone is not parity.
8. Node consumers require explicit feature-gated handling: fclient decode,
   keeper holdings/play/reveal_accept and wide readers, verifier seals/structure
   checks. Agents/bots inherit Holding transit lookup behavior. Pending UI/Herald
   work remains untouched.
9. Bridge writes need approved chain/event-domain handling and authenticated
   read/write receipts; a PSW1 event must not silently advance a legacy PS2 chain.

## Verification boundary

New tests use literal public identities only and cover codec separation,
round trips, old states unchanged, reserved/version/financial-field rejection,
address/slot/departure mismatch, world/family/time/state checks, capture bond
clear and re-projection, underflow/overflow, transition replay and rent-owner
preservation. These are pure tests, not live concurrency/recovery proof.
Independent static review preceded execution. The exact wide_expedition_bridge
target passed all 9 tests with Rust/Cargo1.89.0, world-index-experimental,
offline/locked mode and --test-threads=1. The initial compile found an import
path typo (layout::transit versus layout::player::transit); it was corrected
and re-reviewed before any test executed. This codec slice changes no runtime
writer/gate, dependency, key operation, signing, exporter, network, CI or
deployment. See CODEX-BRIDGE-CODECS-20261109.md for the combined verification.
