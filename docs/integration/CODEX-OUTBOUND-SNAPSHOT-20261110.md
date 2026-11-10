# Original outbound source and route snapshot

Date: 2026-11-10.

The existing original boundary composer now has a bounded read contract for
its source accounts, chosen route and Clock in one RPC response. The server
implementation is `fclient::original_outbound_snapshot`, reached through the
existing optional `frontier-original-expedition-preview` one-shot binary and
`POST /f/expedition/preview`. The existing `inspect` operation and its schema
remain unchanged.

## Request and account set

The new closed request schema is
`frontier-original-outbound-snapshot-request-v1`:

```text
schema, operation="outbound_snapshot", cluster, program, season, season_id,
deployment={program_version,ruleset_hash}, host, wallet,
origin={p,q,tile}, directions, min_slot
```

Addresses are canonical public base58 values. `host` is the full 56-byte host
reference as lowercase hex. IDs, coordinates, versions and slots are canonical
decimal strings; `origin.tile` and each direction are JSON integers. The Season
PDA is recomputed from `program` and `season_id`. Host issuer and standing origin
must both belong to the original family in this Season's derived world.

The request contains 1–32 directions, each 0–5. Rust `WideTile` geometry derives
the endpoint and the destination-first list of entered provinces, with at most
four distinct keys. The endpoint must be wide. There is no supplied arbitrary
read set or caller-selected account family.

The source roles are Season, the wallet's Citizen, the host issuer's Holding,
the issuer's original home Province, and the current original standing Province.
The home is included when the host stands elsewhere. `AccountResolver` derives
original and wide Province addresses from the full keys. Source and route
aliases are deduplicated before reading, giving at most nine account keys plus
Clock. No Rent, private material, signer, or transport account is requested.

## One response, closed report

The existing `fclient::snapshot::SnapshotSource` performs exactly one
`getMultipleAccounts` with `confirmed` commitment and the requested
`minContextSlot`. The shared parser requires the Clock slot to equal the RPC
context slot and rejects partial responses, stale context and malformed sysvars.
There is no read fallback or merge with Herald captures.

The success schema is `frontier-original-outbound-snapshot-v1`, with:

- `status: "snapshot"`, exact `scope` and `request_digest`.
- `source`: `kind: "single_snapshot_source"`, `read_calls: "1"`,
  `coherent: true`, `single_response: true`, decimal `context_slot` and
  `min_slot`, `commitment: "confirmed"`, and a complete content `digest`.
- `clock`: decimal `slot`, signed decimal `unix_timestamp`, and all 40 Clock
  bytes in canonical `bytes_b64`.
- `accounts`: `season`, `citizen`, `holding`, `home`, `standing`.
- `route`: destination-first `{key,p,q,account}` rows.

Each account contains exactly
`{address,owner,lamports,executable,bytes_b64}`. All present accounts must have
the requested program owner and `executable: false`. Source accounts must be
present, exact v2 layout/size/season, and the Season's program version and
ruleset must match the request. Present route accounts must have the expected
family and identity; a missing route account is explicitly `null`. Duplicate
role addresses carry the same account bytes and metadata from the one snapshot.

A blocked report has `status: "blocked"`, `{code}` in `blocker`, and null
`source`, `clock`, `accounts`, and `route`. Valid parsed requests retain their
scope and request digest; failures before parsing have null scope/digest. Error
codes are bounded and do not disclose RPC URLs, executable paths or stderr.

Both statuses have `observation_only: true` and
`dispatch_available`, `executable`, `admitted`, `signed`, `enqueued` all false.
Source metadata always has `authority_verified: false`,
`freshness: "unknown"`, `complete_world_view: false`. Content binding and an RPC
context do not authenticate the source, prove currency or authorize departure.
The browser evaluates resident eligibility and terrain/time rules from these
raw bytes; this endpoint does not issue an eligibility or execution verdict.

## Digest parity

The request digest is SHA-256 of the request schema, a newline, these fields
joined by newlines, and a final newline:

```text
operation, cluster, program, season, season_id,
deployment.program_version, deployment.ruleset_hash, host, wallet,
origin.p, origin.q, String(origin.tile), directions.join(","), min_slot
```

The content digest reuses `fclient::snapshot::digest_of` exactly: domain
`PSF-KEEPER-WIDE-SNAPSHOT-v1`, LE64 context and minimum slots, length-prefixed
`confirmed`, count and contents of unique account keys sorted by raw address
bytes, then `0xC1`, the 40 Clock bytes and a zero byte for absent Rent. Every
present account binds its address, presence byte, lamports, owner, executable
byte, data length and data. An absent account binds its address and zero
presence byte. The gateway recomputes this digest and rejects alias conflicts,
unexpected roles, reordered route rows, changed bytes and changed Clock values.

## Optional transport

The existing explicit executable, loopback HTTP RPC, deployment version and
ruleset configuration is reused. New requests add only `--outbound-snapshot`
before the existing `--rpc-url` argument. There is no default RPC discovery,
relay connection fallback, new listener, keeper startup, payer-pool startup or
dispatch gate change. Both operations share the existing two-child concurrency
limit, empty environment, 8 KiB request bound, combined 64 KiB stdout/stderr
bound, cancellation and 25-second timeout. The shared RPC response bound remains
1 MiB; the outbound account-data bound is 4,864 bytes per requested account.

## Focused verification

Completed checks:

- `fclient --test original_outbound_snapshot`: 5/5 pure public-byte tests,
  including one-call read-set/Clock scope, canonical geometry, remote issuer
  home inclusion, null route accounts, foreign owner/deployment/identity
  refusal, partial/stale/Clock mismatch and cross-request snapshot refusal.
- Gateway `frontier-outbound-snapshot.test.mjs` plus the existing
  `frontier-expedition-preview.test.mjs`: 25/25, with both
  `scripts/ci/no-keys-guard.mjs` and
  `permutation-gateway/screens/codex/no-key-node.mjs` preloaded.
- Offline targeted `cargo check -p keeper --features wide-world-experimental
  --bin frontier-original-expedition-preview -j2` succeeded.
- Scoped `git diff --check` succeeded.
- Native CLI build succeeded with the direct installed Rust 1.95.0 toolchain,
  `--target aarch64-apple-darwin --offline --locked -j2`, selecting only
  `--bin frontier-original-expedition-preview` and
  `--features wide-world-experimental` in package `keeper`. Output:
  `/tmp/wylls-outbound-context-target/aarch64-apple-darwin/debug/frontier-original-expedition-preview`.
  The build task did not execute the binary.

Rust validation uses isolated `/tmp/wylls-outbound-context-target`. The existing
`frontier-node/target` contained an incompatible compiler artifact; no shared
target cleanup was performed. No chain, SBF build, full suite, CI, key creation,
private-key derivation, sealing, signing or send operation was run.

The parent-owned real read-only HTTP/browser integration checks are recorded
separately when complete; pure tests and a native build do not claim a deployed
or authenticated RPC source.
