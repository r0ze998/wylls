# Wide orphan-host recovery

Date: 2026-11-09. Base: `b778b6fbd35a36a1ad2780bf5d264f65ef96aac5`.

## Missing game operation

An orphaned wide host could remain in the province roster after its issuing
holding ceased to be live at its generation. The original game's
DisbandStranded operation had no wide command. WideReturn only handles
already departed Leave entries; it does not initiate this recovery.

This slice adds an actual host-only WideDisbandStranded handler, not a terrain
demo or a detached arithmetic preview. It reuses the existing original-game
rules in `proc::host::disband_stranded`:

- A live provisional/final holding at the host generation refuses NotDormant.
- With `retire_hosts = 1`, the live captured holding's previous generation is
  protected for its victim. This refusal does not enable wide capture/retire.
- Resident and muster-pending entries queue Forfeit at the current bell while
  the province has unresolved Season bells. The host remains until that bell's
  clash and settlement. Resident lag and an existing pending operation refuse.
- Departed entries, or entries in a province resolved to the Season end, are
  removed immediately. No troops are credited, no balances move, and the
  holding/Citizen are not changed. Immediate removal releases the paired roster
  reference; delayed removal uses the existing WideResolve settle path.
- Epoch increment, wrapping and count saturation match the existing handler.

The standing province can differ from the issuing holding's province. All
identity and canonical-address checks use full wide references, not the legacy
packed alias. The roster and the entry table must agree. A system-owned empty
holding is authenticated absence; malformed or foreign-owned data is not.

## Bounded experimental protocol

The new command is `DE FF 01 02 entry`, carried under the existing class-N
WideClose tag. Op2 was unused in the current wide envelope. It remains a
provisional experimental sub-operation, not a stable ABI allocation. No new
kind, magic, seed, address domain or production tag is introduced. The decoder
accepts an entry u8 like the legacy decoder; the handler rejects out-of-range
indices. ResidentAct does not admit the command.

Accounts are: any signer, Season, standing Province, standing Roster, issuing
Holding, and its four canonical wide transit positions. Province and Roster
are writable. Other positions are readonly.

The extra transit evidence deliberately narrows legacy parity. A matching
still-open wide transit returns HostInTransit, because erasing its paired host
would remove evidence required by WideSettleDeparture/SettleTransit. An
unrelated host's valid transit is preserved and does not block recovery.
Missing, malformed or substituted evidence is not treated as proof of no
march. This operation does not repair or settle an open transit itself.

All mutations and the existing kind-5 PSW1 Stranded receipt chain are prepared
on copies. Both mutable account borrows and lengths are checked before the
first live copy. Even a late borrow conflict or event-sequence overflow leaves
all accounts and logs unchanged, without a test rollback wrapper.

## Reader integration

The Stranded wire remains unchanged. As with the original game's STRANDED,
a notification can announce pending Forfeit or immediate removal. Its troop
amount is troops at issue, not independently proven post-clash casualties.
The keeper's read-only Presence::Stranded now includes observed_bell and
removal_unverified=true. A later Resolve does not turn the notice into an
account-removal proof. No return/settlement candidate or automatic write is
created from the notice. Public enum users constructing this variant must
supply the two new fields; this is not a claim of source-API compatibility.

The web history already treats these records as unverified observations and
renders the generic record identity. No JS source, UI write guard, key-test
review metadata or pending village-observation change was touched.

## Pre-execution review

The selected new tests, their helpers, the actual dispatch and Resolve paths
were independently read before execution. They use literal public identities,
codec-written account bytes, public Season PDA/with-seed/hash operations,
in-memory logs, scalar state transitions and assertions. The new Resolve test
has an existing roster, so its allocation branch is not reached. Literal
signer flags, cache seeds and anchor bytes are synthetic; no signature or
drand provenance is claimed. Transit fixtures call the pure WideTransit
constructor/codec, not the gated departure handler or a seal generator.

Existing 61-test Garrison/defence/cleanup regression bodies are unchanged from
the base and remain covered by their recorded runtime audits, including the
explicit host allocation stubs in those older cases. No broad native-crypto,
lifecycle, exporter or guard self-test was substituted for these filters.

Build prerequisites remain the root Cargo1.89 program audit in
`CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md` and node Cargo1.95 keeper audit in
`CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md`. No manifest, dependency, feature
or Cargo configuration changed; the new modules are ordinary Rust source, not
build hooks or constructors. The non-login shell had no compiler override.
Lock hashes remain:

- Root: `87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`.
- Node: `ba8f0e3f3a6a1451ed90ea6567e828232899d352eafec2eccc35edcad9291499`.

## Verification

- New ABI codec/table/negative-wire tests: 4 passed.
- New direct-host tests: 7 passed, including actual deferred Resolve, immediate
  removal, protected generations, replay, invalid identity/privileges, busy
  and lagged state, all four transit slots, borrow/chain failures, unrelated
  transit preservation, and a foreign home at P=9,007,199,254,740,993.
- New keeper notice/replay tests: 2 passed.
- Program Garrison/defence/cleanup/stranded aggregate: 68 passed (includes the
  seven new host tests). Only the pre-existing unused Wide::at warning remains.
- Existing ABI envelope regressions: 5 passed.
- Default program library compile check passed.
- Final selected total: 79 distinct tests passed, including 13 new tests.
- Rustfmt, git diff --check and the read-only Node review-metadata scan pass.
  The scanner remains 119 direct / 209 conservative through-src / 23 unfollowed /
  17 reviewed runnable / zero guard-only entries, with no metadata edit.

Commands use non-login shell, offline/locked, two build jobs, native Apple
host, and unset WS19_GOLDEN_WRITE/WYLLS_WIDE_ECONOMY_FIXTURES_DIR. Existing
reviewed shared target directories were reused rather than duplicated.

```sh
# Repository root, Rust 1.89.0
cargo +1.89.0 test --offline --locked -p frontier-abi \
  --features world-index-experimental --test wide_stranded -- --test-threads=1
cargo +1.89.0 test --offline --locked -p permutation-frontier \
  --features wide-world-experimental --lib \
  map_growth_runtime_tests::wide_land::wide_garrison:: -- --test-threads=1
cargo +1.89.0 check --offline --locked -p permutation-frontier --lib
# frontier-node, Rust 1.95.0
cargo +1.95.0 test --offline --locked -p keeper \
  --features wide-world-experimental --test wide_stranded_index -- --test-threads=1
```

No key generation/private derivation/signing, real transaction, deployment,
SBF build or CI ran. No browser run is claimed for this Rust-only slice.
Production SBF exclusion, experimental Season/version, Depart debit,
automatic-send and mixed-family gates remain closed.

## Remaining playable-world blockers

This is orphan recovery, not a complete playable wide-world release. Wide
siege/capture still needs a full-reference conquest record and capture/return
settlement: merely adding Declare would leave WideResolve refusing the new
record and stall the province. Cross-128/129 migration/marches, production
protocol/activation and authenticated prize accounting also remain unresolved.
No original-game UI command is enabled by this change, and the original
playable world remains the legacy radius-128 path.
