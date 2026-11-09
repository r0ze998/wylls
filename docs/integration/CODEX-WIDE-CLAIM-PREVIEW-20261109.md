# Keyless one-shot wide claim preview

Date: 2026-11-09. Starting publication: `6fe82752`.

`frontier-wide-claim-preview` is a separate binary behind
`wide-world-experimental`. It does not invoke `frontier-keeper` or open its
configuration, master seed, payer pools, journal, engine, API or duty loop.
It prints predictions, not transactions. No automatic-write, production
departure, experimental Season, SBF or mixed-family gate is changed.

## Operator interface

The binary accepts exactly these options, in either order:

```text
frontier-wide-claim-preview --rpc-url http://127.0.0.1:8899 [--request request.json|-]
```

Omitting `--request` or supplying `-` reads stdin until EOF or the byte limit.
The RPC URL is mandatory; no URL or credentials come from environment or
keeper configuration. Only numeric `127.0.0.1` and `[::1]`, HTTP, an explicit
port from 1 through 65535, and a path made of ASCII letters, digits,
`/ - _ . ~` are accepted. DNS names, `localhost`, HTTPS, userinfo, query,
fragment, whitespace and percent escapes are refused before reading accounts.
The existing transport does not support HTTPS POST. There is no curl/TLS
fallback, listener, service startup or automatic node selection.

The request is one JSON object with exactly these fields. The angle-bracket
values below are placeholders to replace with the pinned public identities;
they are not usable deployment values.

```json
{
  "program": "<program base58 public address>",
  "season": "<Season base58 public address>",
  "deployment": {
    "program_version": "<u16 decimal string with experimental bit set>",
    "ruleset_hash": "<exact 32-byte ruleset hash as 64 hex characters>"
  },
  "keeper": "<beneficiary base58 public address, never a keypair>",
  "day": "0",
  "min_slot": "80",
  "slots": [
    {
      "world": "<full 32-byte world ID as 64 hex characters>",
      "p": "129",
      "q": "0",
      "bell": "10",
      "faction": "0",
      "i": "0"
    }
  ]
}
```

Every integer is a canonical decimal **string**, including small counters.
Signs are allowed only for coordinates; leading zeroes, `+`, `-0`, exponent
notation and JSON numbers are refused. Coordinates retain the ABI's full
signed 64-bit representation and its ±2^62 bound. Day/bell are `u32`, minimum
slot is `u64`, version is `u16`, and faction/slot positions must satisfy the
handler's bounds. There must be 1–6 complete slot identities, no duplicate
canonical slots, and every world must match the pinned program/Season.
Keeper may not alias the program, System Program or requested state accounts.

The request body is at most 8 KiB. It is parsed before any RPC client/runtime
is created. Unknown fields are refused, including seed/keypair/config fields.
The JSON parser's usual duplicate-object-name behavior is unchanged: the last
occurrence wins; operators should provide each property exactly once.

## Read and output contract

The complete deduplicated set is computed before reading: Season, shared
DefencePool, keeper/day DefenceClaim, keeper public account, and one slot plus
live anchor per selection. There are at most 16 account keys plus Clock and
Rent. One `SnapshotSource` invocation uses `RpcPort`'s existing single
`getMultipleAccounts` snapshot path at `confirmed` and the supplied minimum
slot. There is no preliminary clock read, chunking, retry or missing-key repair.

The explicit bounded RpcPort constructor caps raw HTTP headers plus body at
1 MiB, reading at most one extra byte to detect overflow before parsing. The
bounded client also requires a JSON-RPC 2.0 object with the exact numeric
request ID and exactly one result/error field. Error objects require a numeric
code and string message. The pre-existing unlimited client keeps its existing
behavior. This binding was added after independent review identified that the
older parser accepted unrelated or missing-ID envelopes.

The HTTP request has its existing 20-second timeout and the preview wraps its
snapshot/planning future in 25 seconds. These timeouts do not time-limit a
user who has not yet closed stdin. No real RPC request was executed as part
of implementing this slice.

The orchestrator requires the exact requested minimum slot and key set,
same-response Clock and Rent, valid sealed coherence and at most 64 KiB of
decoded account data. A custom source returning extra/missing keys, another
request's snapshot, no Rent, or an oversized account is blocked rather than
repaired or partially planned. Loopback is a transport boundary, not a claim
that the node is authoritative.

Stdout is one structured JSON value plus a newline, at most 64 KiB of JSON.
Exit 0 means a complete unsigned preview; exit 2 means an argument, input,
snapshot or planning blocker; exit 1 means stdout could not be written.
`status`, `stage`, a closed `blocker.code`, `source` and `facts` distinguish
failure stages. Raw source labels, paths, URLs, RPC/server messages and error
debug text are never included. No instruction bytes, signer flags, serialized
transaction, signature or signing payload are emitted.

Successful facts include the full selected identities, live anchors, evidence,
timing, nominal and admitted refunds, shared day cap, within-call region cap,
pool availability, predicted payment/partial flag, consumed-slot flags, claim
creation shortfall, counters and keeper/pool/claim balances. Every integral
output value is a decimal string, preserving values above JavaScript's safe
integer range. Source output includes the snapshot's context/minimum slots,
commitment, exact key count, digest, and Clock/Rent/coherence facts. Freshness,
authority and whole-world completeness are not established.

Warnings always state that the output is unsigned, fees are excluded, claim
rent is funded before the refund, and **zero payment still consumes every
selected eligible slot**. Slots are not closed and slot rent is not refunded.
Predictions do not establish fee sufficiency, allocation CPI behavior, runtime
rent transitions or transaction success.

## Static execution and dependency audit

No dependency or dependency feature was added. Offline Cargo metadata confirms
that the preview binary is explicitly registered with the required feature;
the existing keeper binary is unchanged. Cargo.lock retains SHA256
`ba8f0e3f3a6a1451ed90ea6567e828232899d352eafec2eccc35edcad9291499`.
The new binary registration
and module export use the existing `wide-world-experimental` feature. The
previous keeper build/dependency review in
`CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md` remains relevant only for the
unchanged graph/cache/toolchain. This document separately reviews the new
entry point and test bodies; the additive bounded transport is independently
reviewed with its own in-memory tests. There is no new build script, procedural
macro, constructor section, thread-local static or lazy initializer in these
three new Rust files. Built-in derives and existing `serde_json::json!` are
the only macros used in the new implementation.

The new executable's runtime path is:

1. OS argument access, closed URL validation, a bounded explicitly selected
   file/stdin read, JSON decoding and pure public identity validation.
2. `RpcPort::new_with_response_limit` stores URL/program/cap and an atomic
   request counter only. No connection occurs in this constructor.
3. `tokio::runtime::Builder::new_current_thread`, `.enable_io()`,
   `.enable_time()`, `.build()`. The pinned Tokio 1.53.1 sources were inspected:
   builder creation initializes the scheduler RNG through
   `RandomState::new().hash_one(atomic_counter)`, then xorshift state. This is
   runtime/hash-table randomization, not a wallet seed, private-key derivation
   or signing. Current-thread construction creates driver/timer/parking and
   blocking-pool bookkeeping, not application worker tasks. On Unix the
   enabled I/O driver also initializes/registers Tokio's signal wake pipe.
4. One bounded HTTP request through SnapshotSource → SnapshotPort for RpcPort
   → RpcClient::call → post_json_bounded. Numeric socket addresses avoid the
   Tokio DNS lookup/spawn-blocking branch. No HTTPS/curl GET path is reachable.
5. Snapshot parser/base64 decoding, sealed SHA-256 content digest, pure
   `wideclaim::plan_snapshot`, and closed JSON formatting. Public Season PDA
   checks and deterministic world/account hashes are reached; no private key
   material or cryptographic signing is involved.
6. The existing planner estimates packet size through `wideduty::packet_len`
   → public compute-budget/message construction → `Transaction::new_unsigned`
   → bincode wire length. This uses zero signature placeholders and no
   `tx::sign`, `try_sign`, keypair constructor, simulation or submission.
   Neither this internal instruction nor its unsigned bytes is emitted.
7. JSON stdout write and explicit flush, then process exit. Runtime is dropped
   before reporting. `main.rs` was inspected only to establish non-reuse; its
   seed/pool/journal/reconciliation/duty startup is not called.

The new integration target has 11 tests. Its only async executor is a
current-thread Tokio runtime with I/O/time left disabled, driving an in-memory
fake SnapshotSource. Fixture construction uses literal public addresses,
public PDA checks, byte codecs and public hashing. The fake encodes the
synthetic accounts and invokes `parse_snapshot_response`; no listener or
real RpcPort request is made. No testkit, localnet fixture, keypair, private
derivation, signing, subprocess, native-crypto test, exporter or real transaction
is called. Successful preview tests reach only the unsigned size-estimate
path above. Tests cover exact one-call arguments and input immutability,
no-read validation failures, byte limits, full-width integer precision, URL
restrictions, partial/stale/bad sysvars, wrong key/minimum/Rent snapshots,
error/label redaction, zero-pay consumption, deployment/funding blockers,
missing/claimed accounts and oversized snapshot data.

The binary's narrowly named `argument_tests` module adds six pure parser
tests (the invalid-Unicode case is Unix-only). They supply in-memory argument
iterators to `options`, testing missing URL/values, repeated/unknown/extra
flags, both option orderings, stdin selection, non-Unicode URL rejection and
numeric-loopback URL policy. They do not call `run` or `main`, read arguments
from the environment, open files/stdin, construct Tokio, connect or spawn.

## Validation status

Focused validation completed after final static review:

- Bounded transport/envelope/constructor tests: **14 passed**.
- New synthetic-source preview integration target: **11 passed**.
- New binary's pure argument parser: **6 passed**.
- Previously audited claim-planner regression target: **18 passed**.
- Actual compiled CLI refusal smoke: **3 passed**, for absent RPC URL,
  rejected credential-bearing URL and invalid request JSON. Each returned
  exit 2, no stderr, a closed blocker code and `read_calls: "0"`, before any
  client/runtime construction. Only inline stdlib subprocess/JSON checks ran.
- Rustfmt and `git diff --check` pass. No successful live-RPC CLI smoke, daemon,
  native-crypto suite, broad workspace suite, key operation, transaction,
  dependency installation or CI ran.

The selected paths were reviewed before execution. The bounded transport
suite uses only in-memory byte-slice AsyncRead, JSON values and configuration
constructors. It covers exact/over/zero wire limits, headers/chunk framing,
enormous advertised Content-Length, unchanged constructor defaults, strict
response IDs/versions and result/error shape. Its Tokio runtime has no I/O or
timer driver. No socket or request function runs in these tests.

The focused commands, not authorization for unreviewed workspace tests, are:

```sh
# frontier-node; native installed 1.95.0, unchanged audited config/cache
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 \
  cargo +1.95.0 test --offline --locked -p keeper \
  --features wide-world-experimental --test wide_claim_preview -- --test-threads=1

# Same constraints; only the new bin's pure argument-parser test module
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 \
  cargo +1.95.0 test --offline --locked -p keeper \
  --features wide-world-experimental --bin frontier-wide-claim-preview \
  argument_tests:: -- --test-threads=1

# Same constraints; only in-memory transport/envelope/constructor tests
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 \
  cargo +1.95.0 test --offline --locked -p fclient --lib \
  bounded_response_tests:: -- --test-threads=1
```

Cargo may compile registered binaries for this integration target, but does
not execute their `main` functions. The three separate CLI smoke cases above
exercise only pre-read refusal paths, not the valid-input network branch.
Do not substitute an unfiltered keeper
library/workspace suite, a native-crypto feature, a guard self-test or a real
preview CLI invocation. No snapshot-file ingestion, receipt, refund dispatch,
deployment, complete Season replay or production activation is added here.
