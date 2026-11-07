# NFT custody integration preparation

Base: 1d050f79254f26095247028a29aebcf31a62ff31.
All players require an NFT pass. This commit is preparation, not playable NFT custody.

## Implemented

Nine player handlers now have internal `_as(..., auth: &Auth)` entry points,
following the existing caravan handlers. Public entry points still pass
`Auth::Wallet`. No wire tags, ResidentAct allowlist, feature defaults or versions
change. Existing accounting, canonical account checks, lot owner identity,
rent recipient and session restrictions remain in the same handler bodies.
There is no new external path into these internal entry points.

## Why removing the build refusal is insufficient

- `custody-preview` selects ruleset V4/program version 5. `nft-experimental`
  uses the S1 resident version 0x8004. Their combined version is not allocated.
- ResidentAct dispatch and ABI ACT_RUNS do not include the nine custody player
  instructions. V28 relies on that list. Adding only dispatch would desynchronise
  runtime and verifier; adding only the list would claim unsupported coverage.
- Resident authentication must read the canonical policy/link/asset/resident
  accounts on each call, check owner or current unexpired session, generation,
  Citizen/season identity and the transfer guard. Use the existing Auth route,
  never treat a bare NFT Citizen as an authenticated wallet Citizen.
- The kernel receives Citizen identity and `by_session`. Existing wallet-only
  operations must continue to reject sessions. NFT holder authorization must not
  turn a session into a holder.
- Lots and orders bind Citizen identities, not current wallet addresses. Old
  holder/session authorization must fail after transfer. Whether pre-transfer
  outstanding grantee orders persist is an asset-policy question; do not silently
  change it while wiring authentication. Preserve RENT_TO and vault generation.
- V26 custody still lacks full instruction replay and overlaps the growth check
  name. It must remain UNVERIFIABLE rather than be promoted to PASS.

## Required completion checks (no keys or signatures)

1. Allocate combined version/ruleset, update marker/build rejection rules and all
   exact-version readers together; keep preview nondeployable until accepted.
2. Route the nine player instructions through Auth::Resident and extend the
   version-aware ABI/verifier allowlist together. Permissionless settlement and
   reconciliation remain permissionless and do not need a forged player identity.
3. Exercise actual dispatch with fixed-byte AccountInfo signers, current NFT
   proof and canonical public-address calculations: valid holder, valid session
   only where allowed, expired/revoked session, wrong generation, old holder after
   transfer, wrong asset/link/season, foreign lot, stale vault generation.
4. Check failed operations leave lot/vault/cargo/order balances unchanged; retain
   quantity conservation, quotas, reservation accounting and rent destination.
5. Test default S1, NFT-only, custody-only and explicitly allocated combined
   configurations. Run targeted key-free map-growth and resident regressions,
   custody state/history tests and generated ABI freshness. Never run signing
   fixtures, SBF key creation or full unreviewed test setup.

## Validation of this preparation

A source-level inverse transform reproduces the original file byte for byte:
only authentication injection/wallet wrappers were added. Nine wrappers and nine
injected player prologues checked. Rust compile/runtime tests were not run in the
cloud environment because cargo is absent. The compile_error for combined builds
and the default custody-off setting are deliberately unchanged.
