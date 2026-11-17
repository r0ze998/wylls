# Legacy to wide expedition: closed foundation

Status: identity resolver only. No runtime admission, account marker writer,
instruction, debit, transfer or activation is implemented by this foundation.
Existing activation gates remain closed. Four focused identity tests passed;
this does not establish a working expedition.

## Canonical family and original identity

`world_index::expedition::AccountResolver::for_season` derives the world from
the public Season/program context. `family` checks that world, then selects
Legacy for coordinate ring <= 128 and Wide otherwise. `province_address` and
`holding_address` derive the corresponding original account address. The
holding address is always based on the host's issuer reference, not its current
location. A ring-128 host at a ring-129 destination keeps its original ID,
generation, sequence, site, home and Holding. No in-disk shadow wide account is
selectable through this resolver. Existing raw wide seed helpers are not changed;
future callers must use the resolver before reading an account family.

`legacy_host_ref` and `legacy_host_id` use the existing lossless adapter. They
prove encoding only: generation validity, actual issuance (`HOST_SEQ`), owner,
Citizen slot binding, account owner/magic/size, state and capture locks still
require authenticated account checks. In particular a valid encoded sequence
is not evidence of an issued troop. `HOST_SEQ` is the next sequence to issue,
so an issued host has `seq < HOST_SEQ`, including the first host at sequence
zero. A sequence-zero holding reference is distinguished from that first host
by its use context, not its bytes. No alias substitutes for the full identity.

## One four-slot quota, not eight

The four original `H::transit(i)` records and four external records addressed by
`transit_address(original_holding, i)` must represent the SAME four positions.
Checking external absence alone cannot reserve a legacy slot and cannot prevent
duplicate assets. Every operation must authenticate the original Holding and
paired slot record before deciding occupancy. A legacy departure must not be
able to overwrite an outstanding bridge reservation. A bridge must not claim
a slot occupied by a legacy departure or any unrecognized record state.

The departure source remains a legacy entry under the normal legacy departure
and Spend combat. Only its resolved surviving mass/stamina can cross. Source
entry removal, creation of the external transit with the same full identity,
and conversion of the embedded reservation must be one atomic transition.
There must never be both a spendable legacy source entry and spendable external
troops. No source WideRoster or newly issued troop is created. Replays must not
retransfer mass or refund a bond twice. Destroyed-at-origin follows the existing
settlement outcome, not invented compensation or resurrected troops.

## Marker proposal, NOT an allocated layout or implemented codec

One candidate is embedded state 4 with version 1 at `T::RSV_93`, the next two
reserved bytes zero. The original host ID, origin coordinate/tile and departure
bell, arrival bell and timestamp bind it to the external record at the same
slot. Destination is full-width and external only. A marker would carry no
spendable troop/result fields or narrowed destination. Whether fee/bond escrow
remains on the Holding or transfers must be settled with all capture/close
paths before allocating this format; metadata alone is not an escrow contract.

This candidate is unsafe under today's legacy readers. Therefore this change
does not expose a state-4 encoder, decoder, transfer plan or account writer.
Do not globally widen `T::in_transit`: occupancy/host-lock semantics and legacy
reveal eligibility must be separate predicates. Existing states 0..3 must keep
their exact behavior.

## Concrete consumers that block a marker write

Repository source locations below are function anchors, not line-number promises.

- `frontier-abi/src/layout/player.rs`, `transit::in_transit`: only 1..3 are
  occupied to current readers; state 4 is currently false. v2 reuses this layout.
- `frontier-abi/src/prologue.rs`, `host_in_transit`: uses that predicate plus
  original host ID. `proc/host.rs` host actions and Depart depend on it.
- `permutation-frontier/src/proc/host.rs`, `depart_as`: chosen embedded slot
  requires FREE, which would refuse state 4, but the host-wide interlock still
  needs the predicate fix. `settle_departure` accepts only DEPARTED and rejects
  unknown states. Bridge settlement must consume the original Spend result
  exactly once; it cannot simply call normal settlement and leave two copies.
- `proc/reveal.rs`, reveal: accepts `T::in_transit`, then decodes legacy seal,
  legacy destination and route. A global predicate extension would accidentally
  admit the bridge marker into this legacy-only path.
- `proc/clash.rs`, transit gather loop: skips only FREE, then handles DEPARTED
  and DESTROYED explicitly; its wildcard treats state 4 like SETTLED and may
  stamp destination/wear. It must explicitly exclude the marker before writes.
- `proc/transit.rs`, `settle_transit`: accepts SETTLED or DESTROYED, rejects
  DEPARTED/unknown. Bridge arrival/recovery requires its own authenticated paired
  cleanup and cannot use the legacy destination fields.
- `proc/conquest.rs`, capture settlement: refunds embedded bonds only where
  `in_transit(state)` is true and the escrow flag is set. Simply omitting the
  marker can strand a bond; duplicating escrow flags can pay twice. Both current
  and previous-generation records must have exactly one refund owner.
- `proc/conquest.rs`, `retire_host_as`: legacy Province entries and legacy
  previous-home refs are the retirement inputs. It cannot retire an external
  transit or a wide resident by itself; paired previous-generation handling is
  required. (It does not directly use `in_transit`.)
- `proc/citizen.rs`, `release_dormant`: blocks only embedded `in_transit`
  records. State 4 currently allows release/close despite an external transit.
- `proc/citizen.rs`, `close_holding` / `close_holding_sink`: existing end/grace,
  abort and tombstone closing sweeps/closes the Holding INCLUDING unsettled
  escrow. Preserve this terminal rule rather than adding an open-marker guard.
  Later external cleanup must be rent-only to its immutable rent recipient;
  a deleted origin cannot be used to recover swept escrow or settle troops.
  CloseCitizen still needs bridge inventory/lifecycle analysis, beyond its
  existing wide ticket/capture reservation checks.
- `world_index/holding.rs`, `WideHolding::read`: refuses nonfree embedded
  transits under the wide identity layout. That is not a legacy bridge parser.

## Route, return and activation obligations

Mixed routes must resolve each province by its own full coordinate/world and
read its canonical family, not treat all provinces as wide. Legacy route tower
coverage, watched seconds and wear, stopping palisades, watch stances, faction
and expulsion effects (`proc/reveal.rs` walk/WalkWho and structure watch) must
survive the crossing. Current wide walking does not establish this parity.

Destination arrivals use the existing wide full-reference ordering, quota,
combat and lead rules. No new arrival quotas, economic rules, gifted homes or
outposts are introduced. In-disk-only fighting remains legacy.

Before opening any gate, specify and test atomic paired transitions for return
to the original legacy issuer, captured issuer / previous generation, missing
issuer, stale generation, stranded destination, end/grace, abort, tombstone and
rent cleanup. Verify ownership and original immutable rent recipient; do not
invent a refund recipient or compensation rule. Replay, account substitution,
wrong slot, missing pair and mismatched departure metadata must fail closed.
No runtime write is safe until these recovery and interlock contracts agree.

## Verification scope

`frontier-abi/tests/wide_expedition.rs` uses public literal identifiers only.
It covers every original province, all sites at boundary identities, exact
legacy address/ID round trips, both sides of ring 128/129, coordinates beyond
2^53, wrong worlds and invalid packed IDs. This is identity coverage, not
evidence of a working expedition lifecycle. Independent source review traced
all four tests and their local callees: bounded geometry/ID arithmetic, seed
encoding, public SHA256 and assertions only. The module introduces no runtime
constructor, compile-time initializer, dependency or build script.

Executed successfully with Rust/Cargo1.89.0: cargo test --offline --locked
-p frontier-abi --features world-index-experimental --test wide_expedition
-- --test-threads=1. Four tests passed, zero filtered, zero failures. Existing
root compile-time/cache audit was reused under unchanged-cache assumptions;
full cache rehashing was not repeated. Non-login shell, two jobs, existing
native cache, no explicit --target, fixture-export variables unset. Scoped
rustfmt passed for the new source and tests; git diff --check passed.
world_index/mod.rs has preexisting module/re-export ordering and import wrapping
formatter differences, reproduced against the parent commit even with ordering
disabled. Those unrelated lines are preserved; its only edit is the new export.
A whole-file rustfmt pass for that module is not claimed.
No signing, private-key derivation, native
crypto, exporter, transaction, CI or deployment was executed.

Reviewed source SHA-256:


- frontier-abi/src/world_index/expedition.rs: 91de188ecd56bbb1fefd2143d8ddb7cce5b872fb685c47da8c637ee1d3f0df9e
- frontier-abi/src/world_index/mod.rs: 1b0bc799b10edcbbcff402adc9d3b40102f15df3534f01c70be8281feb058e2e
- frontier-abi/tests/wide_expedition.rs: c2097b46b193590875058d5e35fc5936662a61cbaae7887e47d456caa64c2181
