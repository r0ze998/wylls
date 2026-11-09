# Closed original-resident construction contract (2026-11-09)

## Scope

`world_index::expedition_resident_ix` defines an isolated proposal for two
60-byte envelopes: DA/7 Dissolve and DC/12 Return, each followed by the full
56-byte original host reference. These sub-operations are unallocated proposals.
The generic experimental `WideCommand`, deployed v2 decoder and NFT ResidentAct
wrapper deliberately reject them. No dispatcher, runtime activation flag,
version bit, manifest, dependency, budget or send path changed.

The new module is available only under the existing world-index experimental
feature. Its two account tables are copied exactly from the already-tested
private resident writer, which now imports them instead of keeping duplicates.
Names, order, signer flags, Acc::Any, writability and group cardinality are
unchanged. Original ownership, capture, transit and economic checks stay in the
private handler. Acc::Any means a readonly table position is a minimum canonical
plan choice, not a runtime prohibition of additional privileges.

## Client contract

The existing opt-in `fclient` experimental feature exposes
`wide_resident_draft::Draft`:

- `for_wallet` explicitly takes a wallet, payer, full original host reference and
  full wide standing key. It derives Citizen from the wallet, original Holding
  and home from the original issuer, and wide Province/roster from standing.
- `return_home` takes a payer and the same full identities. It has no Citizen
  role and invents no owner-signature requirement for the permissionless return.
- Both require the same supplied program/Season-derived world, an exact
  lossless legacy host reference and an outside-disk standing Province.
- Only Dissolve actor/payer may alias. Both output positions then carry the
  effective writable flag. Every other role collision and zero/program account
  recipient is refused.
- Private fields and readonly getters expose the proposed bytes and canonical
  minimum account roles. `admitted` and `public_dispatch_available` are always
  false. There is no Instruction, Message, Transaction or signing/send conversion.

This is public-address construction, not ownership, authentication, fresh-state,
issuance, readiness or economic validation. The supplied scope is not proof of
an authentic program or canonical live Season. There is no session/NFT path.
The separate current-account inspector and detached verifier retain their own
limits and are not silently treated as admission tokens.

## Evidence and remaining boundaries

Five isolated fclient tests pass using public address arithmetic and immutable
BRES fixture bytes. They check the two actual native invocations' host identity,
ordered account addresses and effective flags; wallet versus permissionless
roles; aliases and zero recipients; same-world/family constraints; coordinates
beyond 2^53; exact codec widths and generic/v2/NFT-wrapper refusals. Both BRES
SHA256 digests are pinned within this target.

The fixtures invoke private Rust handlers with a host argument and empty
instruction data. They prove host/account-role correspondence, **not** native
execution of these proposed wire bytes. Public instruction activation and a
playable send flow remain absent.

Four pure ABI tests pass, covering round trips, malformed lengths/versions/
operations, full original identity, context mismatch, every public/parser-wrapper
refusal and unchanged private role tables (271 tests filtered). One negative
test initially assigned the escape byte its existing value; changing that
test to flip the byte corrected the expectation. No codec behavior changed.
The interrupted connection lost one run output; after confirming no compiler
remained, the exact four tests were rerun and passed. No full ABI or workspace
suite is implied.

The continuous native boundary-to-capture-to-reserve-return test also passed
with the shared role tables and exact immutable full-lifecycle log parity.
No receipt body, state effect or existing fixture changed for this extraction.

All checks use cached Rust 1.95, offline and locked, native host target,
CARGO_INCREMENTAL=0, jobs2 and a single coordinated Cargo process. The selected
client target is `-p fclient --features wide-records-experimental --test
wide_resident_draft`; the ABI filter is
`world_index::expedition_resident_ix::tests::` under `--lib` and the existing
world-index experimental feature. No keys, signing, real transaction, RPC,
SBF, deployment, CI or public writer gate activation occurred.
