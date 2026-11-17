# Wide return atomicity and original-map capture validation — 2026-11-09

Base: `a18a23c3d0d27580797c48a6c0279bae69a9dd87`.

## Concrete changes

### Return settlement cannot partially commit on a late host error

The experimental `WideReturn` handler previously copied the freed province
entries and roster, then credited the holding, before constructing all chained
receipts. A chain-sequence overflow or a later mutable-account borrow failure
could therefore leave changed host account bytes and earlier logs behind.
The ordinary snapshot-and-restore test executor concealed that distinction.
On-chain instruction failure already rolls account writes back; this change
does not introduce or claim new Solana rollback semantics.

`settle_return` now stages the complete province, roster and optional holding
images, including every chain advance and ordered receipt. It acquires all
live mutable borrows and checks lengths before the first copy. Only after all
copies complete does it emit the staged receipts. `prepare_wide` separates
record construction from logging; other handlers retain their prior behavior.

Generation eligibility, whole-troop rounding, reserve overflow rejection,
batch size, entry order and Return/Stranded receipt semantics are unchanged.
This is a specific Return fix, not proof that every wide handler is atomic.

### Captured wide provinces now agree with their actual bytes

The original recorded-world map previously accepted correctly sized,
base64-shaped all-zero account bytes behind plausible JSON summaries. A new
pure capture codec checks canonical base64, size, ABI magic/version/status,
world/season/coordinate identity, readiness and reserved fields, holding
identity/transit invariants, displayed province/holding summary fields, and
canonical public with-seed addresses. The capture cannot be ahead of the
manifest's last slot or folded archive sequence, or belong to a different
manifest snapshot. Missing bounds refuse actual wide captures. Existing
legacy-only manifests remain compatible.

This checks byte/summary consistency, not source authenticity, live ownership,
complete replay or a proved chain. The existing `captured-unverified` status
and read-only presentation remain. No event becomes land merely by naming a
coordinate, and no send or action authority is introduced.

## Verification

- **3/3 Rust direct-dispatch regressions passed**, 168 nonselected tests
  filtered. They bypass the rollback executor: province/holding chain overflow
  at the first or a later receipt, held immutable borrows on each written
  account, and successful current/stale/current generation returns with exact
  rounding, chain heads, receipt order and no replay credit. Error cases
  preserve every supplied account's bytes, lamports and owner and emit no logs.
- **137/137 focused Node regressions passed**: 99 original-map checks,
  24 existing wide-world checks, 9 economy-history checks and 5 new capture
  checks. The latter cover every wedge, coordinates above safe Number range,
  malformed headers, contradictory summaries, wrong public addresses, ahead
  captures, absent bounds and fail-closed paginated state.
- **2/2 original whole-page browser checks passed** at desktop 1440×900 and
  touch phone 390×844. The real original-page recorded-world control loads a
  captured province at `(129,0)`, selects it, reports its holding, and recentres.
  It rejects zero-filled contradictory bytes, clears old land/history and
  recovers on reopening a valid source. Existing history pagination, aborted
  stale response, route, KEEP, Free City and chart assertions still pass.
- Browser key-use arrays, Node key calls, persisted session/dev-key state and
  server writes remain empty. The canonical original world stays six rings.
  Screenshots were visually reviewed. Synthetic R128 chart redraw medians were
  125 ms desktop and 124 ms phone; these are local observations, not a real
  infinite-world performance claim.
- Rustfmt, `git diff --check` and the read-only Node classification scanner
  pass. Ten stale review digests were renewed only after reviewing the pure
  capture-parser delta. No scanner/guard self-test was executed.

## Execution audit

The selected Rust build graph was reviewed before execution, including actual
host dev-dependencies and compile-time hooks. See
`CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md` for the cache, build-script,
proc-macro, native constructor and toolchain boundary.

The new runtime fixtures are literal codec-written account images at public
PDA/with-seed addresses. Their setup installs the existing memory clock/log
stub, writes a valid full-reference identity and calls raw dispatch for Return.
That selected path reads/stages accounts and hashes public event bytes. It
does not invoke CPI, lifecycle setup, proof verification, native crypto,
fixture exporters, private-key derivation, key generation or signing.

The Node additions use built-in test/assert/file reads and the already reviewed
byte, base58 and SHA256 modules. They do not boot the app or invoke wallets,
transactions, a worker or an external service. Existing test call paths are
unchanged apart from pure capture validation. The builtin refusal guard is
defence in depth, not a substitute for this source review.

Browser execution retains the installed Playwright 1.58.2 and secure loopback
boundary in `CODEX-LOCAL-BROWSER-AUDIT-20261108.md`: `devWallet=off`, no remote
requests or certificate generation, fresh guarded context, public fixture
wallet only, GET-only server and no send action. New callbacks only copy fixed
bytes, hash public addresses, navigate the recorded view and test refusal.

## Fixture and product limits

Original immutable economy `.bin` files were neither edited nor regenerated.
Unit and browser fixtures copy them in memory and explicitly rebind public
identities for parser/presentation scenarios. Those copies are **synthetic**;
they do not establish authenticated state or a successful >128 game session.
The Return fixtures likewise test one state transition, not a full lifecycle.

Production radius128/packed-ID limits, the experimental SBF exclusion,
automatic-write/debit gates and mixed-family refusal policy are unchanged.
Wide coordinates remain bounded to ±2^62 and recorded-map pagination remains
bounded. Complete wide replay/authentication and signed-chain execution remain
unproved. No game rule, migration choice, dependency, lockfile, private NFT
prize code, production gate, transaction or deployment was changed.

Exact Rust command used after audit:

```sh
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 \
  cargo +1.89.0 test --offline --locked -p permutation-frontier \
  --features wide-world-experimental --lib \
  map_growth_runtime_tests::wide_land::wide_return_atomicity:: -- --test-threads=1
```

Browser log: `/tmp/wylls-route-preview-20261108/wide-capture-browser.log`.
The local desktop/phone `*-wide-economy.png` screenshots now show the captured
province. Prior reports describe their historical runs, not these new images.
