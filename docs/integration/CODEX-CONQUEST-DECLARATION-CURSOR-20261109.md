# Declaration cursor admission regression

Status: narrow native regression passed on 2026-11-09. The public conquest
lifecycle gate remains closed. This does not activate or deploy gameplay.

## Finding and fix

The continuous original-origin capture test exposed a valid-call mismatch:
`resident_ok(13, 14)` allowed declaration at bell 14 while bell 13 still needed
resolution. Declaration immediately wrote a sidecar with `declaration_bell=14`.
The strict conquest resolver then refused the required bell 13 because that
sidecar described a future declaration. No ordinary catch-up path could consume
it.

`declare_siege_context` now requires `RESOLVED_NEXT >= current_bell`, returning
`NotResident` before any live write or CPI if an older bell remains unresolved.
Both wallet and resident declaration wrappers use this same admission block.
The general resident-order rule and the resolver's future-declaration validator
are unchanged. Ordinary pending host orders still use their existing timing.
Callers must resolve all earlier bells, then declare. No historical retroactive
siege rule or account repair was introduced.

## Exact regression

New isolated module: `wide_conquest_cursor_runtime_tests.rs`.
Filter: `proc::wide::conquest_exec::cursor_runtime_tests::`.

One test function runs six literal initial-state cases through the actual
private declaration helper, official native serialization/writeback and balance
checks: original-family and wide-family sources, each with cursor 8, 9 and 10 at
current bell 10. Cursors 8/9 refuse `NotResident`; cursor 10 succeeds and creates
the current-bell siege record. The cursor-9 case explicitly verifies that the
ordinary resident rule would have allowed it.

After an expected refusal, the callback returns success solely to expose the
complete official writeback. It then compares every account, including balances,
owners, bytes and chains, with the untouched snapshot and requires no logs or
CPIs. This is stronger than checking a discarded failed context, but is not a
bank rollback test. Positive controls use already present, funded sidecars and
need no CPI. The fixtures begin already resident and stocked; they do not prove
historical opening, funding, movement or economic provenance.

Compile-only passed, then the exact function passed (1 passed, 388 filtered out;
three preexisting dead-code warnings). The separate continuous lifecycle test
uses actual pre-declaration catch-up Resolve before declaring, rather than
injecting a cursor. Source and selected test were independently reviewed before
execution.

## Execution limits

Used the existing isolated runtime-contract workspace and cached locked graph,
Rust 1.95 native aarch64-apple-darwin, offline mode, two build jobs and one test
thread. No new dependencies, private keys/keypairs, signing, crypto fixture,
transactions, RPC, SBF, CI, production manifest changes or activation changes.
Only existing public identifiers/PDA arithmetic are used. No broad suite ran.

Reproduce from `permutation-frontier/runtime-contract-tests` after source audit:

```sh
cargo +1.95.0 test --offline --locked \
  -p permutation-frontier-runtime-contract-tests --lib \
  --features public-proof-tests,system-cpi-tests \
  --target aarch64-apple-darwin --target-dir target \
  'proc::wide::conquest_exec::cursor_runtime_tests::' \
  -- --test-threads=1
```

The actual invocation used a clean environment and fixed installed
Cargo/rustc/clang/ar paths, as documented in the runtime-contract workspace.
