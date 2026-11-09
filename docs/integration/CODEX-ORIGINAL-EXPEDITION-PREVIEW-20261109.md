# Original-expedition keyless preview contract

This is an optional read-only inspection of an already-open original-host bridge
or a selected wide resident. It does not plan the initial outbound Depart.
No keeper startup, payer initialization, key generation, signatures, live RPC
execution during testing, transaction construction, sends or public gate changes.

## Request and transport

Binary: `frontier-original-expedition-preview --rpc-url URL`, stdin JSON only.
The URL is server-owned explicit HTTP loopback (127.0.0.1 or [::1] with a nonzero
numeric port and restricted path). No request URL/path/config or file arguments.
Feature: existing `wide-world-experimental`. No dependency changes.
Limits: request 8192 bytes, output 65536 bytes, RPC response 1048576 bytes,
account data 65536 bytes, one snapshot of exactly ten accounts plus Clock,
25-second internal async timeout. No retry or partial snapshot repair.

Exact request fields:

- schema: `frontier-original-expedition-request-v1`
- operation: `inspect`
- cluster: 1..32 lowercase ASCII letters/digits/hyphens; configuration label,
  not verified network identity
- program, season, original_owner: canonical nonzero base58 addresses;
  original_owner is the departure Citizen, not a wallet
- deployment: exact fields program_version (canonical u16 decimal string carrying
  the wide bit), ruleset_hash (64 lowercase hex characters)
- host: 112 lowercase hex characters encoding the full 56-byte original host
- standing: exact p/q fields, canonical signed decimal i64 strings; outside disk
  in the world derived from the supplied program and Season
- min_slot: canonical u64 decimal string, zero allowed without freshness claim
- wallet, payer: explicit nullable canonical public addresses, proposals only

The immutable request derives its canonical read destinations before reading.
The same-response Season must match both deployment pins; no arbitrary version
with the wide bit suffices. The original host must roundtrip through the legacy
identity adapter. No shadow wide Holding is substituted.

Request digest is lowercase SHA256 of UTF8:
`frontier-original-expedition-request-v1` + newline + the following fields joined
with newlines + one terminal newline:
operation, cluster, program, season, deployment.program_version,
deployment.ruleset_hash, host, original_owner, standing.p, standing.q, min_slot,
wallet (empty when null), payer (empty when null).
This binds display responses, not authority or authentication.

## Report

Exact top-level fields: schema, status, stage, request_digest, scope, source,
blocker, facts, draft, draft_blocker, dispatch_available, admitted, signed,
enqueued, automatic_send, completion_proven, history_verified.

Schema is `frontier-original-expedition-preview-v1`; status is preview/blocked.
Stage is arguments/request/runtime/snapshot/plan/output. Scope is the complete
validated request echo and request_digest is the digest above. They are present
for all snapshot/planner results including timeout, null only for failures before
request validation, runtime setup, or defensive oversized-output fallback.

Source has exact fields kind (`single_snapshot_source`), read_calls ("0"/"1"),
coherent, single_response, context_slot (decimal string/null), digest (hex/null),
authority_verified (false), freshness (`unknown`), complete_world_view (false).
Only a bounded, correctly bound, reverified sealed snapshot marks coherent true.

Blocker is null or {code, optional field}; vocabulary is closed in the Rust
module. No source labels, URL/path, arbitrary error text or error Debug/Display
values are serialized. Facts is the existing `wideexpedition::Report::describe`
object. Missing resident is `ResidentMissingHistoryRequired`, never completion.

Draft is null or {kind:`closed-resident-role-draft`, action:Dissolve/Return,
roles:[{name,address,signer,writable}],dispatch_available:false,admitted:false}.
No instruction data, transaction or signer is returned. For OwnerDissolve only,
a proposed wallet must derive the original Citizen; this does not authenticate
the wallet. ReturnOriginalReserve only needs the payer proposal. Other stages
have no draft. Payer flags/balance and wallet signatures are not checked.
Draft blocker vocabulary: NoResidentDraftAtThisStage, PayerProposalRequired,
WalletProposalRequired, WalletCitizenMismatch, DraftAccountContract.
All top-level capability booleans are always false. Exact byte/snapshot evidence
and present ownership checks are conditional on the supplied RPC, not proof of
original history, execution readiness or chain provenance.

## Verification

Independent source and exact test-path review found no blocking issue. Final
selected checks passed: 12 new preview tests, one isolated CLI options test,
16 existing original-expedition planner regressions, and five existing closed
resident-draft regressions (34 total). Tests use audited literal public initial
account fixtures and an in-memory SnapshotSource only. CLI argument tests call
only the parser, never executable main or RPC. No full workspace or live-network
acceptance is implied.

Four immutable JSON fixtures under `keeper/tests/fixtures/` contain actual
Rust request/report output for Return and Dissolve. The final test compares the
complete serialized request/report bytes with `include_bytes!`. The temporary
stdout capture test was removed; no exporter or update mode remains. These
fixtures anchor gateway/frontend contract tests to actual Rust version pins,
request digest, 50-byte standing identity and canonical account roles. The
version bit is the ABI's `0x4000`; the fixture version is 16388.

Tests used cached Rust 1.95 with explicit compiler/doc-tool paths, a clean
command environment, explicit `aarch64-apple-darwin` target, offline/locked,
CARGO_INCREMENTAL=0 and two jobs. An initial compile-only attempt used a PATH
rustc wrapper and failed during a stable-toolchain refresh before compiling our
code. Subsequent fully pinned compilation and final tests passed. A separately
authorized official stable reinstall later restored ordinary cargo/rustc 1.99.1;
global settings and pinned 1.89/1.95 executable hashes stayed unchanged. These
selected project tests used 1.95, not the repaired stable toolchain. No dependency
or lock changed; the only manifest addition declares the default-off standalone
binary. No keeper startup, live RPC, signing, transactions, SBF, deployment or
CI was run.

The public writer gate remains closed. The endpoint is optional and disabled
without explicit operator binary/RPC/deployment configuration; this checkpoint
does not configure a running gateway or make resident actions executable.
