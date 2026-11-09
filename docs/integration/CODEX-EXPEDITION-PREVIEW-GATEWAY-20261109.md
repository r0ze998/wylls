# Optional original-expedition inspection gateway

`POST /f/expedition/preview` connects the original game page to the separate
keyless `frontier-original-expedition-preview` inspector. It only inspects an
already-open original-host expedition at an explicitly selected wide standing
coordinate. A coordinate is a selection, not evidence that the host is there.
The native snapshot planner verifies the requested state or returns a blocker.
This endpoint does not plan the initial outbound Depart or enable execution.

## Operator configuration

The endpoint returns HTTP 503 `ExpeditionPreviewDisabled` by default. All four
settings are required together; partial or invalid configuration fails closed:

| Flag | Environment variable | Meaning |
| --- | --- | --- |
| `--expedition-preview-bin` | `FRONTIER_EXPEDITION_PREVIEW_BIN` | Absolute path to the reviewed standalone inspector executable |
| `--expedition-preview-rpc` | `FRONTIER_EXPEDITION_PREVIEW_RPC` | Explicit loopback HTTP RPC URL, matching the native CLI policy |
| `--expedition-preview-program-version` | `FRONTIER_EXPEDITION_PREVIEW_PROGRAM_VERSION` | Canonical decimal u16 version carrying the experimental wide bit |
| `--expedition-preview-ruleset-hash` | `FRONTIER_EXPEDITION_PREVIEW_RULESET_HASH` | 64 lowercase hex characters identifying the expected ruleset |

There is no inherited RPC default, binary discovery, shell command, request-file
argument, environment forwarding or automatic build. The RPC accepts only
`http://127.0.0.1:PORT` or `http://[::1]:PORT`, with a nonzero port and optional
ASCII alphanumeric `/_.~-` path. It rejects userinfo, queries, fragments,
percent escapes, DNS names, HTTPS and remote addresses.

The adapter additionally pins every request to the relay's configured cluster
label, program address and derived Season address. Cluster is a configuration
label, not proof of network identity. The native same-response Season checks
both deployment pins. Configuring a path is an operator trust decision: it must
point to the reviewed inspector, not the keeper daemon or another executable.
The wide version bit is `0x4000`, not a numeric lower-bound check: 16388 and
49152 carry it; 32768 does not.

Repository packaging is assumed, as in `docs/frontier/m1/PLAYTEST-RUNBOOK.md`.
The gateway imports the shared identity helper and its public browser modules
from the sibling `permutation-server/web` tree. A standalone copy of only the
gateway directory is insufficient, even with the endpoint disabled: retain
those sibling assets and their relative layout. No deployment was performed.

Existing relay startup still has payer/key initialization. Do not start the
relay as a way to test this feature under a no-key constraint. The isolated
adapter and route can be tested without invoking startup.

## Wire contract and binding

The request and report schemas, fixed digest field order, exact scope echo and
diagnostic vocabulary are documented in
[the native contract](CODEX-ORIGINAL-EXPEDITION-PREVIEW-20261109.md).
HTTP sends the request as JSON; only the fixed CLI arguments `--rpc-url URL`
and JSON stdin reach the subprocess. Client input cannot select executable,
RPC, arguments, file paths, operation or deployment.

All numeric request values are canonical decimal strings. The 56-byte host
reference is 112 lowercase hex characters. `original_owner` is the departure
Citizen address. `wallet` and `payer` are explicit nullable public proposals,
not signatures, verified ownership or funding commitments.

The gateway checks the returned scope and request digest independently of JSON
key order. It rejects unknown fields/codes and any admitted/signed/enqueued/send
capability. Successful facts must match the selection and coherent snapshot.
The browser and gateway share `fexpedition-identity.mjs` to recompute:

- The actual 50-byte ProvinceKey: version, world, ring/wedge/position sort key.
- Original Holding and home Province, wide standing Province and roster.
- Each of the four canonical owned-bridge addresses.
- Exact ordered account-role addresses and minimum signer/writable flags.

Role flags describe a closed proposed account table. They are not signatures or
an executable instruction. Public dispatch remains unavailable. Missing resident
history is a blocker and never proves expedition completion.

## Bounds and failure handling

- JSON body: 8192 bytes, bounded before parsing, including declared lengths.
  Other routes retain their existing 64 KiB body limit.
- Total child stdout plus stderr: 65536 bytes. Stderr is never published.
- HTTP and child deadline: 25 seconds. Disconnect, abort or shutdown kills the
  child. There are no retries or queued jobs.
- At most two children per relay context, shared across operator/public handlers.
  Capacity remains occupied until child `close`, even after a deadline.
- Public rate limit: burst four, then 0.2 inspections per second per client
  address, in addition to the global child limit. Existing loopback rate-limit
  exemption does not bypass the child limit.
- `shell:false`, empty environment, working directory `/`, fixed pipe stdio.
- Neither funds checks nor relay payer selection occurs for this route.

HTTP 200 carries a validated native `preview` or `blocked` report. Local failures
use fixed `{error, code}` responses: invalid request 400, scope mismatch 409,
busy 429, cancellation 499, deadline 504, unavailable/disabled 503, invalid or
oversized report 502. Oversized and invalid JSON bodies return 413/400. A client
that has disconnected receives no attempted response. No path, URL, stderr,
raw RPC error or OS diagnostic is forwarded.

## Verification scope

The focused test is `permutation-gateway/test/frontier-expedition-preview.test.mjs`.
It imports the real transport and route with fake EventEmitter subprocesses.
It never spawns a binary, contacts RPC, opens a socket, invokes relay startup,
creates a key, signs or sends. Tests also cover explicitly extracted HTTP/body
functions and source bindings, not a full app/config integration run. Optional
gateway dependencies are absent in this checkout, so full app/config import and
live integration are not claimed.

The actual Rust Return and Dissolve request/report goldens under
`frontier-node/crates/keeper/tests/fixtures/` are consumed unchanged. They pin
digest, deployment bit, canonical ProvinceKey/account addresses, actor/payer
alias flags, and ordered role tuples across the Rust/browser/gateway boundary.

Exact local command, from `permutation-gateway`:

```sh
node --import ../scripts/ci/no-keys-guard.mjs \
  --import ./screens/codex/no-key-node.mjs \
  --test test/frontier-expedition-preview.test.mjs
```

The second guard retains attempted-private-operation exit failure tracking.
Global scan/review metadata is intentionally untouched; this is a manually
audited focused run, not a whole-suite or CI-gate pass. No server, Rust preview
process, live RPC, CI, deployment or configuration enabling is performed here.
