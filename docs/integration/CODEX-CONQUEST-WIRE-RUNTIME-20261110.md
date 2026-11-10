# Closed conquest bytes in the original-host lifecycle

The continuous original departure → wide arrival → Free City capture → resident
return path previously entered DeclareSiege, ResolveWithConquest and
SettleCapture through three test-only typed forwarders. It now serializes the
existing exact command bytes into the official native invocation and consumes
them through `wide::conquest_draft::execute_draft`.

This private router accepts only those three already-defined command types.
The existing WideCommand codec enforces their exact envelope/version/length.
The router then invokes the existing same-call account authentication, staging,
allocation and receipt paths. Public `wide::dispatch` retains the unchanged
`CONQUEST_LIFECYCLE_ENABLED = false` guard before the same command consumer.
The resident outer-wire authorization path retains its separate guard and
proof accounts. No instruction, operation number, schema, runtime privilege,
proof verdict, public gate or economic rule is added or relaxed.

The three test-only typed forwarders are removed. The duplicated native
ResolveWithConquest implementation is replaced by the same implementation the
public gated wrapper uses. Native capture replay now catches the rejection
inside an otherwise successful invocation and verifies the official writeback
is unchanged, rather than relying only on discarded failure state.

## Verification

The two continuous native tests additionally exercise the actual bytes at each
conquest stage. Each stage proves public dispatch refuses without effects,
then privately rejects truncated/extended data, bad prefix/version, unrelated
valid Return/SettleSiege/Resolve instructions, wrong account counts and every
required signer/writable privilege removed individually. Every refusal is
checked after successful official writeback with zero events/CPIs and exact
unchanged accounts. The successful path keeps the existing immutable trace,
account-role and receipt snapshots unchanged.

Three individual exact tests passed:

- `proc::wide::expedition_gather::exec::lifecycle_tests::contiguous_original_departure_boundary_combat_and_free_city_capture`
- `proc::wide::expedition_gather::exec::lifecycle_tests::contiguous_original_boundary_capture_and_resident_home_return`
- `proc::wide::public_proof_config_tests::public_proof_adapter_keeps_all_gameplay_gates_closed`

Each used the existing isolated runtime-contract manifest, installed Rust1.95,
`--offline --locked --lib --features public-proof-tests,system-cpi-tests`,
`--target aarch64-apple-darwin`, the existing runtime-contract target directory,
`-j 2`, `CARGO_INCREMENTAL=0` and the full individual test name with
`--exact --test-threads=1`. Five existing dead-code warnings remain. No broad
suite, dependency/lock/fixture change, key generation/derivation/signing, new
sealing, chain/service startup, SBF or CI run occurred.

## Remaining limits

This completes the missing bytes-to-native execution for the supported capture
branch. Return remains the existing current-generation voluntary Dissolve →
Resolve Leave → reserve-return contract. Reverse sealed movement requires its
own source transport/ownership, original-destination arrival and mixed Gather
contracts and is not implemented or simulated here. Public dispatch, browser
submission, unsupported conquest outcomes and deployable Solana-target
validation remain incomplete. Synthetic initial accounts and unchanged public
proof fixtures do not establish historical account provenance or signatures.
