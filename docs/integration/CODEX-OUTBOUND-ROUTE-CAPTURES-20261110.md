# Bounded outbound-route capture reads

Date: 2026-11-10. Experimental Herald feature: `wide-world-experimental`.

The original boundary composer can request the captured Province bytes needed
for its route without walking world pages to find ring 129. Herald now serves
`GET /h/world/wide/route?at=128,0;129,0` from the existing Fold.

## Endpoint contract

`at` contains one to four distinct `P,Q` pairs in request order. Each component
is a canonical decimal string within inclusive ±2^62. Leading zeros, `-0`,
`+1`, whitespace, fractions, exponents, missing components, duplicate
coordinates, duplicate query keys and additional query parameters are refused
with HTTP 400 `BadRoute`.

One handler invocation takes one Fold read-lock. It performs an exact index
lookup for each coordinate, followed by bounded account lookups and validation;
it never walks index pages or all captured accounts. The response reuses
`manifest_json`, including `world`, `worldDomain`, `program`, `season`,
`seasonAddress`, `snapshot`, `experimental: true`, `readOnly: true` and
`completeness: "captured"`, and adds:

```json
{
  "route": [
    {
      "p": "128",
      "q": "0",
      "state": "captured",
      "capture": {
        "address": "<canonical public Province address>",
        "slot": "<decimal u64>",
        "archiveSequence": "<decimal u64>",
        "postState": "transaction",
        "verification": "captured-unverified",
        "bytes_b64": "<captured account bytes>"
      }
    }
  ]
}
```

The existing capture serializer preserves each account's slot and archive
sequence. `postState` is `transaction` or `at-or-after-transaction`, according
to Fold configuration. Original Province captures must be exactly 4,736 bytes
with layout version 2, the configured season, matching coordinates/ring/wedge,
and the canonical original Province address. Wide captures reuse the existing
`authenticate` path and `WideProvince::read`: exactly 4,864 bytes, supported
versions/readiness, configured season/world, canonical wide address and matching
coordinate identity.

An unknown coordinate, missing capture, or invalid stored identity returns
`state: "unknown", capture: null`, including an index entry reported open whose
capture is unavailable. A recorded close returns `state: "closed", capture:
null`. Neither state fabricates terrain or proves current land availability.

Responses use `Cache-Control: no-store`. Feature-off builds return HTTP 503
`WideWorldUnavailable`; fixture clusters return HTTP 503
`FixtureWorldUnavailable`; an unavailable Season/index returns HTTP 503
`NoSeasonYet`.

The single read-lock prevents concurrent Fold mutation while assembling the
answer. It does not make captures from different transactions a coherent chain
snapshot. In particular, the index epoch/stamp can outlive mutable original
Province bytes. The response is an unverified captured observation, not replay
verification, live ownership authority, admission or permission to execute.

## Client interoperability review

A documentation-only review compared `wide.rs` and `server.rs` with
`herald.mjs`, `fexpedition-route-read.mjs`, `fexpedition-route.mjs` and
`map/wide.mjs`. No contract mismatch was found:

- `wideRoute` preserves canonical string coordinates, rejects duplicate or
  oversized requests, and URL-encodes the comma/semicolon grammar. The Axum
  query extractor and `parse_route` decode and validate the same representation.
- `parseOutboundRouteCaptures` accepts the reused manifest envelope and checks
  the source's program, season address, season ID and derived world. Its
  required `captureBounds` come from the endpoint's `snapshot.lastSlot` and
  `snapshot.foldedThrough` decimal strings.
- Requested row count/order, the three state names, null unavailable captures,
  original/wide addresses, exact byte lengths, canonical base64, verification
  label and both post-state strings agree. The parser additionally refuses a
  capture whose slot or archive sequence is ahead of the Fold bounds.
- Four wide captures contain 25,952 base64 characters before their small JSON
  envelopes, below the client's 64 KiB response limit. There is no page-walk
  fallback.
- `routeLandFromBytes` applies additional route-use restrictions to wide forts
  and structures. A valid capture rejected by those restrictions remains
  unavailable for route evaluation; this is not an endpoint format mismatch.
- The parsed result retains `observationOnly: true`,
  `coherentSnapshotVerified: false`, `provenanceVerified: false` and
  `executable: false`.

This review did not launch a service or browser and did not repeat the parent's
JS/browser integration checks. It is a source-level contract comparison, not a
live HTTP end-to-end acceptance result.

## Seven exact Rust tests

All seven invocations passed. Six feature-on invocations each ran one test with
73 filtered out; the feature-off invocation ran one test with 55 filtered out.
The tests are in `herald/src/wide_route_tests.rs` and
`herald/src/wide_route_http_tests.rs`.

| Exact test suffix | Evidence |
| --- | --- |
| `route_parser_enforces_canonical_exact_bounds_distinctness_and_four_limit` | Canonical syntax, 2^53+1, inclusive ±2^62, out-of-range/duplicate rejection and maximum four. |
| `route_returns_original_and_wide_captures_in_request_order_with_manifest_scope` | Mixed original/wide capture bytes, far coordinates, exact request order, decimal metadata, both post-state labels and equality with the complete manifest envelope. |
| `route_missing_closed_and_unrelated_index_entries_do_not_fabricate_land` | Unknown and known-open missing captures remain unknown; explicit close is null; adding 1,024 unrelated index entries leaves requested route rows unchanged; missing Season is unavailable. |
| `route_refuses_mismatched_original_or_wide_capture_identities` | Wrong magic/season/version/coordinate/address and relevant original ring/wedge or wide world/readiness fields are refused; a short original capture is unavailable. |
| `route_handler_refuses_bad_queries_fixture_and_missing_season_without_listener` | Actual query extraction and handler reject duplicate/extra query parameters and bad coordinates; fixture/missing-Season codes and no-store. |
| `route_handler_preserves_exact_unknown_coordinates_and_scope_without_listener` | Percent-encoded separators, four rows, exact far-coordinate strings, original/wide boundary, null unknown captures and manifest scope through the handler. |
| `route_handler_feature_off_is_unavailable_without_listener` | Default build returns HTTP 503 `WideWorldUnavailable`, with no-store. |

The following reproduces the exact test selections and build flags used. Run
from this checkout's `frontier-node` directory. `route_test` is only a compact
shell spelling of the seven individual Cargo invocations; each uses installed
Rust 1.95 directly, offline locked dependencies, the native aarch64 target,
two build jobs, disabled incremental compilation and one test thread.

```sh
cd frontier-node
route_test() {
  CARGO_INCREMENTAL=0 \
  RUSTC=/Users/r0ze/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin/rustc \
  /Users/r0ze/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin/cargo test \
    --offline --locked --target aarch64-apple-darwin -j 2 -p herald --lib \
    "$@" -- --exact --test-threads=1
}

route_test --features wide-world-experimental wide::wide_route_tests::route_parser_enforces_canonical_exact_bounds_distinctness_and_four_limit
route_test --features wide-world-experimental wide::wide_route_tests::route_returns_original_and_wide_captures_in_request_order_with_manifest_scope
route_test --features wide-world-experimental wide::wide_route_tests::route_missing_closed_and_unrelated_index_entries_do_not_fabricate_land
route_test --features wide-world-experimental wide::wide_route_tests::route_refuses_mismatched_original_or_wide_capture_identities
route_test --features wide-world-experimental server::wide_route_http_tests::route_handler_refuses_bad_queries_fixture_and_missing_season_without_listener
route_test --features wide-world-experimental server::wide_route_http_tests::route_handler_preserves_exact_unknown_coordinates_and_scope_without_listener
route_test server::wide_route_http_tests::route_handler_feature_off_is_unavailable_without_listener
```

These tests use literal public byte arrays, public PDA/with-seed derivations,
in-memory captures and inert `Out` paths. Handler tests call the handler and
query extractor directly; none opens a listener. No fixture generator, Fold
transaction dispatch, key generation/private derivation, signing, sealing,
chain startup, SBF build, CI or full suite was executed. Formatting and
`git diff --check` passed for the endpoint changes. No dependencies or lockfile
were changed by this endpoint work.
