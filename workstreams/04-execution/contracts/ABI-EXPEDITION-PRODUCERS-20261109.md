# Closed expedition producer supplement, 2026-11-09

Experimental/unfinalized reservation supplement to ABI-ALLOCATION-20261106.ja.md.
Parent integration authorized this conflict-free technical reservation. No
production allocation, existing account layout, public admission or gate changes.

Current tree inspected at 0b1f3e0f plus uncommitted candidates. Scanned actual
wide instruction constants/parser, legacy/v2/resident kind tables, registry and
inventory, and repository Rust/proposal/patch text. No existing EE envelope
operation1, DC envelope operation11 or PS2 kind147 allocation was found. Existing
EE legacy-shaped Reveal and DC operations1–6/8–10 remain unchanged. Kind145
remains conquest-only and146 remains the original-chain departure/origin receipt.

- ExpeditionReveal: EE FF 01 01,238 bytes, class W, top-level only. Existing
  Reveal payload fields follow the four-byte envelope. Exactly16–19 accounts:
  payer, Season, original Holding, owned external v2, anchor, archive, beaconlog,
  inputs, destination Province, day, four explicitly discriminated slots,
  instruction sysvar, System and zero–three ordered path accounts.
- ExpeditionGather: DC FF 01 0B,10 bytes, class D, top-level only. bell u32,
  start u8,n u8;1<=n and start+n<=24. Exactly8+3n accounts: payer, Season,
  destination Province, anchor/archive, inputs, day, instruction sysvar, System;
  then slot/original Holding/owned external triples. Not native Gather pairs.
- Neither command is a ResidentAct/player admission. Public dispatch remains
  unconditional NotImplemented. Native readers/claim paths are not widened.

PS2 kind147, version1, producer version1: header6, version/action/reserved4,
destination key50, optional Reveal identity153 (host56, original Citizen32,
original Holding32, owned external32, transit slot1), operation receipt100,
tail count0. Reveal is exactly314 bytes; Gather161. Their pre-tail313/160 bytes
are explicit provisional exceptions to the advisory128-byte ceiling. Both fit
the800-byte program event buffer, but require a dedicated bounded emitter.
Existing strict PS2/v2 decoders reject kind147. The general PSW1 emitter is not
the emitter for this receipt. No chain header advances: only unchained slot,
day, ClashInputs, external and payer lamports change. Never invent legacy or
wide entity links for these operations.

The operation ID binds separate INPUT/OUTPUT digests under expedition-producer
domains, not conquest or departure domains. Manifest schema version1 commits
one account leaf per consecutive one-based wire role: public address, owner,
presence, actual signer/writable flags, lamports, explicit data length and ALL
raw data. Leaves fold in role order, beginning with the exact account count.
Aliases must agree on owner/presence/lamports/data, retain every role, and reflect
the same staged output everywhere. No account bytes or chain headers are
normalized. This preserves v1/v2 discriminators, full owner and tower wear.

Context binds program and Season addresses, target/full Reveal identity,
exact command bytes, clock timestamp/slot/bell, whole Season bytes and real
operation evidence. Length delimiters are explicit. Each hash uses existing
borrowed scatter-slice SHA256, with at most14 slices; no aggregate account-data
copy is built. This is not a measured SBF heap/compute claim.

Reveal outcomes bind raw/watched/travel seconds, wear, selected slot,
creation/day-write/displacement, target rent minima, actual prefund-adjusted
slot/day transfers and total payer debit. Gather outcomes bind inputs creation,
target rent/actual transfer/debit, arrivals mask, actually stamped positions,
present count and no-arrivals flag. prepare checks readonly preservation,
alias consistency and those transfer deltas against before/after manifests.
Runtime must still validate ownership/writable privileges, every layout,
route/seal/stance rules, provenance, economic transitions and atomic commit.
A staged plan alone is not an emitted or committed result.

Prospective pure test target: wide_expedition_producer. Its closure uses only
ABI codecs, integer checks, public PDA/hash paths and literal fixtures. No
key generation, secret derivation, signing, native crypto, runtime transaction,
network, build or test execution is part of this implementation work.

## Integrator verification

The five selected pure ABI tests passed after independent static review. Private
Reveal/Gather writer tests also passed with full manifests on existing accounts.
No public dispatch, creation CPI, production gate or existing kind was enabled.
See docs/integration/CODEX-BOUNDARY-PRODUCERS-20261109.md for exact scope.
