# Legacy home source and bridge interlocks — 2026-11-09

Base: c65180623f9a079850c2d6e4df6821f7274b5948.
This closed increment connects original legacy homes to wide Free City conquest
without replacing the home, and prepares legacy account interlocks for future
bridge movement. It does not implement boundary departure/arrival or activate
player transactions.

## Original home conquest

Source family is selected from the paired full roster reference, never whichever
account happens to decode. AccountResolver selects the canonical original v2
Holding/Province for legacy origins. The handler authenticates exact owner,
header, length, world, coordinate/site/generation, Citizen ownership, original
inventory binding, existing finality/capture lock and issued seq < HOST_SEQ.
Wide sources retain the prior full-reference allocation requirement and codec.

Original source economy pays the same arms and gold stake; no source Holding,
home slot or host is recreated. Target remains an initial wide Free City with
the existing table, isolated capture escrow and lowest free slot2/3 reservation.
Capture creates only that wide target Holding. Lapse/capture credit uses the
canonical original source generation: capped live credit, absent/stale/nonlive
burn, malformed/wrong address or owner refusal. No captor gets victim stake.

A legacy source advances its original PS2 chain using bounded240-byte kind145;
a wide source retains PSW1. The target's PSW1 record contains the identical
operation receipt. Full manifests are staged, only actual chained outputs are
normalized, and source chain preparation precedes live effects. The old
WIDTHS_V2 table is not used for the new record.

Fixtures derive the first legacy home's gen1 from actual home_site and use
founded_holding/write_holding, original slot1 and issued seq0/count1. One new
private-handler test runs declaration, real wide combat Resolve and capture,
keeping the original home/address/inventory and legacy chain while adding the
first wide Holding. Its army is already resident in the wide Province: this
is NOT evidence that boundary transport, route validation or arrival works.
Other tests cover source refusal atomicity, live/capped lapse credit and
stale/absent/malformed source cases.

## Legacy bridge occupancy

The experimental ABI classifier validates all four embedded slots and binds a
bridge marker's original packed host ID to its canonical legacy Holding.
Host locks and ReleaseDormant see bridge reservations. Existing legacy
in_transit and reveal eligibility remain states1–3, so a marker cannot enter
the legacy seal path. Valid state0–3 behavior is preserved.

Gather preflights every slot before early matches or stamping, skips a valid
bridge, and refuses malformed/unknown slots. Capture preflights immediately
after Holding authentication, before victim refunds/mutations, then uses the
same existing victim bond refund/diversion and flag clearing. Capture needs
no external bridge account and never waits for victim cooperation. No new
refund authority, money source or opponent-capture blockade is introduced.

Terminal CloseHolding remains unchanged: its normal grace/abort/tombstone
closure includes unsettled escrow. Public gates stay false. No marker writer
is added by these interlocks. Five new tests cover pure classifier/host-lock/
capture flag bookkeeping and malformed late slots; actual AccountInfo legacy
gather/opponent-capture integration is still source-reviewed, not runtime-proven.

## Selected verification

Independent static reviews traced exact source/refund handler closures,
constructor-based fixtures, legacy PS2 preparation, occupancy tests and all
new compile-time paths. They use public literal identities/PDA/address hashes,
byte codecs, scalar game economy/combat and existing bounded allocation stubs.
No private-key generation/derivation/signing, native-crypto test, exporter,
key-guard self-test, network or external process is reached.

The unchanged root1.89 dependency/build audit was reused; full cache rehash was
not repeated. Installed Cargo/Rust1.89.0, non-login shell, offline/locked mode,
two jobs, existing native cache, no explicit --target, fixture exports unset.

Final selected results:

- ABI legacy_bridge_interlocks: 5 passed.
- Program proc::wide::conquest_exec::tests::: 8 passed.
- Program proc::wide::conquest_settle_exec::tests::: 20 passed, including two
  continuous lifecycle tests. Total program selection28.
- The companion pure codec selection13 passed as documented separately.
- Across these disjoint final selections: 46 tests passed. They include existing
  regression tests and are not 46 newly added tests or a whole-repository pass.
- Compile-only permutation-frontier library checks passed for default and
  wide-world-experimental,nft-experimental.

Execution history: guard5 passed first; the initial program compile stopped
before any program test because SourceHolding.host_identity was declared u8
instead of the canonical u16. It was corrected without narrowing and re-reviewed.
A now-unused transit import was gated to its unchanged default-only use. Final
program28 and both checks passed. The existing unused Wide::at warning remains.
Scoped source/test formatting and git diff --check passed; unrelated existing
world_index/mod.rs ordering/wrapping was preserved.

No broad suites, real transactions, signing, SBF, CI or deployment ran. The
legacy-source receipt readers, complete authenticated replay, mixed route
structures, actual boundary handoff/admission/return, wide retirement/stranded
recovery, UI connection and activation validation remain outstanding. The
separate pending14 UI/Herald files and security-review metadata are untouched.

## Reviewed source SHA-256

- frontier-abi/src/prologue.rs: 4406390a06c9d00567ea6b16aae17295e6000288edc4d65508c0ef8e84fb957d
- frontier-abi/tests/legacy_bridge_interlocks.rs: 600ac3724804158f01d0c6728dabd3cd34f0268f4d7de9e553b8a33ebfae93f1
- frontier-abi/src/world_index/conquest.rs: 6afffcf9470b0d380537c17dfbbcde6b4334a8b5a3f764a5b8e330f1c0273121
- permutation-frontier/src/proc/host.rs: 741e8b3854153f5bd9dbb8aeff99db7d876cddc2b789ed01bdbc21098a520671
- permutation-frontier/src/proc/citizen.rs: 22224e701f259cd2cc6e88c02189c0eba436c0e5290f9d22c709f6ccc387b0df
- permutation-frontier/src/proc/clash.rs: e9a2d5ad93d7c56a03796a9d66d405b91b65a9794f4a8ae281b967a947f84874
- permutation-frontier/src/proc/conquest.rs: 4261baad8a7c6a803e33d372a7eaa8fbe4d8180a578ddeeb0498b8bef1604c95
- permutation-frontier/src/proc/wide_conquest_exec.rs: fd95a5798f2ffc71f7a4c098652dd74b5d770bcf7ff37bd12c5f22ce4330fd84
- permutation-frontier/src/proc/wide_conquest_exec_tests.rs: b9c3e64a03b974df35d16333deb296c58b55fde21a5417026852e36320250028
- permutation-frontier/src/proc/wide_conquest_settle_exec.rs: ed32ec9ceada134f1c22ae0712ad2a8e05c3e71fcde493990bce3c41a30ad1fe
- permutation-frontier/src/proc/wide_conquest_settle_tests.rs: 29258fa6899a71d08ee17c6745637e3a2de100ea751f6c898a0fa2672e7ac1c1
