# WideGarrison gameplay slice — 2026-11-09

Base: `b7f733b545b06a311b76f8285d30149e52412910`.

## Gameplay gap closed on the experimental host

Wide holdings could train reserve troops and build walls, and WideResolve
already modeled holding garrisons, but no player operation moved those reserves
into defensive service. `WideGarrison` now ports the deployed
`proc/host.rs::garrison_as` behavior into the experimental wide runtime.

The actor must pass the existing wallet/session or resident authorization,
own the canonical holding, and supply its own canonical province and wide
inventory binding. Existing live/finality, capture-lock, resident-lag, positive
delta, reserve availability, pending-slot and garrison-capacity checks apply.
Only unit 0 (Spearman) reserve is debited, in whole troops. The existing kernel
converts that amount to milli-troops and queues it for the current bell;
reinforcements become active after that bell's clash. No withdrawal action,
price, timing, capacity, combat rule or migration policy was introduced.

The Citizen bucket/action stamp, touched holding and province garrison are
staged together. Full input/output receipts and both event-chain advances are
computed first. All mutable borrows and lengths are checked before copying any
live bytes; receipts are logged only after all copies complete. Late chain or
borrow failures cannot leave a partially applied Garrison operation on the
host. This guarantee is specific to this handler, not every wide instruction.

## Provisional ABI, not an external allocation

The integrator allocation policy is
`workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md`.
The existing wide module explicitly treats its namespace as provisional and
feature-gated. Its versioned sub-operation envelope already avoids consuming
new top-level tags. Garrison uses the unused `0xDA FF 01 04` operation with an
exact 8-byte signed delta (12 bytes total), class P, the existing six-account
mirror-write shape. The deployed v2 decoder still refuses it.

Its event is isolated PSW1 version 0x82, kind 17, never a legacy PS2 kind.
The key is a full holding reference with sequence zero, not a phantom host.
Province and Holding are both chained. The distinct 82-byte receipt contains
version 1, positive whole-troop delta, timestamp, lazy-finality flag and complete
input/output state digests. New Garrison-specific domains separate those
commitments from economy receipts; only output holding/province chain fields
are normalized. Existing economy receipts cannot be interpreted as Garrison,
and the economy-only verifier explicitly refuses Garrison.

No production tag, legal right, shared external allocation or game-rule choice
was finalized. Existing experimental version checks remain mandatory.

## Original-game reader integration

- Keeper discovery records the observed holding/province only. It creates no
  host, transit, duty or automatic-write authority.
- Findex retains all 17 kinds with canonical full identities and event chains.
- ResidentAct classification recognizes the runtime's new allowed command.
- The original recorded-world history decodes Garrison strictly and describes
  queued troop reinforcement in Japanese/English. The row has no host-action
  button, send control or implication of verified current ownership.
- Generic Herald, fclient and wide-chain readers use the ABI's new shape
  without a separate interpretation or a relaxed gate.

## Verification

- New ABI suite: **3/3 passed**. Canonical envelope/receipt, invalid widths and
  ranges, resident wrapping, deployed-decoder refusal, full identity, links,
  input commitments and output normalization.
- Selected existing ABI compatibility checks: **3/3 passed**. Strict event
  version/round-trip, all payload widths, economy identity and cardinality.
- Direct-dispatch runtime suite: **7/7 passed**, 171 other tests filtered.
  Train → Garrison → actual no-arrivals WideResolve at `(129,0)` changes reserve
  to pending reinforcement, then active garrison only after resolving its bell.
  Other checks cover same-bell aggregation, exact other-unit reserves and chains,
  receipt recomputation, invalid delta, insufficient reserve, owner/signature,
  capacity, resident lag, pending-slot exhaustion, finality/capture lock, both
  chain overflows, late mutable borrows and literal session expiry.
- Four selected reader tests: **4/4 passed**, one each for keeper observation,
  findex attribution, ResidentAct classification and dispatch parity.
- Economy-only verifier rejection: **1/1 passed**, 65 other tests filtered,
  under its separate `wide-economy-experimental` feature. An initial command
  using `wide-world-experimental` selected zero tests and is not counted.
- Focused guarded Node regressions: **139/139 passed**, including two new
  literal-wire Garrison tests and the earlier original-map/wide suites.
- Original complete-page desktop and touch-phone browser checks: **2/2 passed**.
  The real history displays queued Garrison quantities without actions;
  pagination, close/reopen, stale-response abort, malformed-source recovery,
  wide capture navigation, route, Free City, KEEP and R128 chart checks pass.
  No key calls, persisted session/dev-key data or server writes were observed.

The first browser attempt exposed an old fixture loop hardcoded to five rows,
so the new sixth row was never served. The loop now uses the fixture length;
no assertion was removed. The first runtime resolve attempt exposed incomplete
synthetic province setup (an implicit keep at the site's tile and a stale score
cursor). Only the fixture was corrected to an explicit no-keep state and the
current score cursor. No gameplay behavior was changed to make a test pass.

## Safety audit and exact limits

All executed test paths were reviewed before execution. Root Cargo1.89 build
paths are covered by `CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md`; ABI has no
dev dependencies and is a subset. Reader Cargo1.95 paths are covered by
`CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md`. Source/feature/cache audit is
not independent certification of the installed compiler or native binaries.

Runtime fixtures write literal account images and simulated signer flags.
Public PDA/with-seed hashing is used. Train and Garrison run direct dispatch
without rollback helpers. The Resolve fixture supplies a literal pre-verified
Anchor/SeedCache, absent arrival inputs/day and a present empty roster, so it
reads the cache without proof cryptography or CPI. This is not verified drand
provenance, a played full lifecycle or chain authentication.

Reader tests use literal bytes, public hashes, an in-memory keeper model and a
temporary SQLite database. No signing/provider/planner executes. Node and
browser additions are pure parsing/display and GET-only synthetic fixtures
under the prior secure loopback, installed Playwright and devWallet=off audit.
No guard self-test, fixture exporter, dependency change, key operation, real
transaction, deployment or CI was run. Immutable binary fixtures are unchanged.

The browser Garrison row has synthetic receipt digests/links solely to test
presentation; it is not a native-output or replay-valid vector. Hostile-arrival
combat and Garrison-specific NFT runtime authorization tests are still absent.
The NFT route and reader classification are wired, but not a claim that those
unexecuted scenarios passed. Complete Garrison replay verification remains
unimplemented; generic wide verification still reports unmodelled gameplay.

Production radius128/packed-ID constraints, SBF exclusion, experimental Season
creation limitations, departure-debit and automatic-send gates, mixed-family
refusals, finite wide-coordinate and page bounds remain. This closes a concrete
host-side defensive action gap, not production >128 play or a true infinite map.

Local browser evidence: `/tmp/wylls-route-preview-20261108/wide-garrison-browser-final.log`
and desktop/phone `*-wide-economy.png` screenshots. Earlier reports describe
their earlier runs. The read-only Node classification scanner and diff/rustfmt
checks are part of final validation; no full workspace suite was executed.

Runtime repeat command, after re-review of changed source/configuration:

```sh
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 \
  cargo +1.89.0 test --offline --locked -p permutation-frontier \
  --features wide-world-experimental --lib \
  map_growth_runtime_tests::wide_land::wide_garrison:: -- --test-threads=1
```

ABI used `-p frontier-abi --features world-index-experimental --test wide_garrison`
plus the individually reviewed compatibility filters. Reader commands used
Cargo1.95, the exact named tests only and the features recorded above. Node
used the builtin refusal guard with 16 explicitly named regression files;
browser used `node --test permutation-gateway/screens/codex-route-preview.screen.mjs`.
