# Expedition dispatch and reverse runtime integration

This increment follows local commit `80543d01`. The requested development
continues in the existing worktree; saved commits, unrelated work and running
services were preserved. Public push remains pending and was not retried.

## Actual dispatcher and unsigned client

The new opt-in `expedition-dispatch-experimental` runtime routes a distinct
version-2 envelope through the actual dispatcher to authenticated expedition
consumers. Its full Season must be version `0x4804`. Default builds, the older
wide build, raw private commands and Solana builds retain their existing
refusals. This is a host-development execution revision, not a stable ABI
allocation or deployable game. See the
[dispatch contract and native evidence](CODEX-EXPERIMENTAL-EXPEDITION-DISPATCH-20261110.md).

Independent review found a collision between the initial wrapper detector and
valid legacy payloads beginning `ff02`, such as ring/P coordinate 767. The
dispatcher now preserves successful existing command decoding before trying the
new envelope. Explicit regressions cover both paths. The wrapper also checks
full Season layout, program ownership, exact version, class and inner codec;
existing consumers repeat their account and authorization checks.

The fclient feature of the same name adds
`experimental_expedition_message::{prepare_depart, prepare_resident}`. It uses
the existing canonical wallet proposals to compile real Solana Instructions and
unsigned Messages for Depart, Dissolve and Return. It retains ordered roles,
handles actor=payer aliases and keeps the payer first in the required public
signer list. It wraps the exact inner command, includes the explicit existing
budget prefix, then applies packet/lock/signer/blockhash checks. Target program,
Season and the experimental version must match; older/default versions fail.
Budget values are caller-selected and are not measured Solana compute limits.

The adapter is absent from default builds. Existing proposal modules remain
non-executing and their raw bytes remain closed. No new signing, seal generation,
wallet/session, transaction submission, browser send control or relay allowlist
was added. A Prepared message still reports no admission, verified deployment
or relay submission. Four selected key-free fclient tests passed, including
both actor/payer cases, both resident actions, exact inner bytes/roles, budget
and target rejection, expired observations and account-lock limits.

## Reverse runtime pieces

The reverse producer now allocates a distinct transit and reserves real funds
through the native System adapter. It authenticates the original issuing host
separately from its wide standing position and explicit original destination.
The original Holding's reserved marker prevents old writers from spending the
same host. Origin settlement consumes the actual resolved Spend row and frees
its paired wide roster entry. Three selected native producer tests passed.
The intermediate resolved row is produced with the real Spend kernel inside
the fixture; a complete Resolve invocation is not claimed. See the
[reverse producer contract](CODEX-REVERSE-PRODUCER-20261110.md).

Reverse Reveal and Gather use the original destination's canonical arrival
quota and ClashInputs rather than introducing a second set of arrival slots.
The original issuer's full reference is converted losslessly to its original
host ID. Plaintext/commitment and route checks use the distinct reverse record;
wear is applied once when surviving troops enter the original combat input.
Separate receipt domains bind complete account observations and existing
history-chain advances. These records are not yet generic indexer events.

The initial Gather implementation required an already allocated ClashInputs,
whereas Reveal correctly requires it absent. The integration closes that gap:
Gather can create the original 1280-byte ClashInputs through actual native
System CPI after fee, rent, role and borrow preflight. The continuous native
test starts from an explicitly literal origin-Settled reverse state, creates
the original 96-byte ArrivalDay and 160-byte ArrivalSlot through Reveal, and
passes those actual output accounts unchanged to Gather. Only the test clock
advances. Gather creates ClashInputs, writes the combat row and stamps the
reverse record Gathered. Repeating Gather changes no account and invokes no
CPI. This is a verified producer/consumer segment, not a complete journey from
an original-page click through combat and final settlement. See the
[six Reveal tests and continuous evidence](CODEX-REVERSE-REVEAL-RUNTIME-20261110.md).

Eight separate Gather tests cover the existing-account path, current owner and
full host identity, once-only wear, destroyed-origin troops, inconsistent replay,
late borrow failures, raw history/balance manifests, chain overflow and creation
preflight. The continuous Reveal test additionally covers actual CI allocation.

The public-ciphertext fixtures used here are deliberately invalid encrypted
seals. Their public plaintext/commitment can exercise departure and Reveal
rules, but cannot establish a successful later seal opening. No valid seal was
created or opening key recovered. Literal initial owner/resident/settled-origin
account states are declared fixture inputs, not proven producer histories.

## Retained-slot failure

The independent failure-v3 writer preserves eligible claim evidence, or closes
the arrival slot under the existing immutable rent-recipient rules. Native
writeback continues through the existing defence claim and close path, including
an observed 98,852-lamport claim, premature close refusal, replay refusal and
exact remaining slot/rent state. Destroyed v1 and Stays/Withdrew v2 codecs and
semantics are retained. See the
[retained failure evidence](CODEX-EXPEDITION-RETAINED-FAILURE-RUNTIME-20261110.md).

This writer is also reachable as the twelfth explicit experimental dispatch
kind, `SettleRetainedFailure = 11`, on the exact new Season revision. A separate
native test compares every resulting account and log against the private entry
for both slot retention and closure; missing privileges and substituted
wire/Season revisions are refused without writeback changes.

## Selected verification

| Scope and configuration | Passing cases |
| --- | ---: |
| Experimental dispatch with System CPI feature | 7 |
| Existing wide build, new dispatch feature absent | 4 |
| Retained failure ABI/native and v1/v2 refusal regressions | 6 |
| Retained failure actual experimental dispatcher parity | 1 |
| Reverse departure/origin native System CPI and refusal cases | 3 |
| Reverse Gather native account/creation-preflight cases | 8 |
| Reverse Reveal, including System CPI and continuous Gather | 6 |
| fclient unsigned experimental message construction | 4 |

These are 39 selected test executions across the listed configurations;
shared dispatch tests run in both feature configurations, so this is not a
claim of 39 unique test functions. Repeated debugging/reruns are not counted.
Checks used installed Rust 1.95, cached offline/locked dependencies, native
arm64 target, at most two build jobs per Cargo invocation, no incremental
compilation and serial test threads. Only the selected key-free modules or
exact cases ran. No broad suite was executed.

Temporary fixture corrections (minimum tip, fixture account owners, readiness
and canonical region) preserved production guards instead of weakening them.
The declared public snapshots remain distinct from a complete producer history.
Independent reviewers checked failure-v3, versioned dispatch, client messages,
reverse identity/producer and arrival logic. The corrected compatibility issue
and the closed allocation gap are recorded above.

## Execution boundary

The original browser still cannot perform a live wide departure/return. The
host-only dispatcher and private reverse consumers are distinct from a
deployed signed transaction. Reverse final economic settlement, capture and
terminal handling, previous-generation cases, mixed legacy keeper/reader
support, indexer/verifier integration and a complete successful seal-opening
journey remain incomplete. Reverse markers deliberately make old occupancy
readers refuse instead of interpreting a reserved host as spendable; this can
block older Holding actions until reverse-aware cleanup exists.

Stable protocol allocation, measured SBF/crypto/runtime limits, deployment,
matching browser/relay admission and signed-chain validation remain necessary.
No signing/key generation/secret derivation, new valid seal, CI, chain start,
SBF build/run, deployment or push was performed in this increment.
