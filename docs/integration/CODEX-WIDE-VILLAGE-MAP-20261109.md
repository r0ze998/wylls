# Original-game wide village to map navigation

Base: `b9add37e129531b20ea3d7d446727dd91c39abaa`.

## Product scope

The original player page already displayed captured wide villages in the W2/W3
inventory, but its village card had no way to locate that village on the
recorded-world map. This change connects those two existing views. It does
not add a demo, convert a captured record into live ownership, or enable orders.

The click resolves the current selected village from page state rather than
accepting coordinates or a world from HTML attributes. The recorded-map mount
retains its controller, validates the source's world/season pins and uses a
BigInt origin. A matching captured province can be selected; a holding without
a corresponding province only supplies a location marked unknown. Neither an
inventory record nor an observed event is invented into land.

The ordinary map, legacy holdings and action builders remain separate. Wide
Harvest/Build/Train/Muster/movement/other order guards remain unchanged. The
recorded map and village retain explicit captured, unverified and read-only
wording. No signature, instruction submission or real transaction is involved.

## Current playable-world boundaries

The original game continues to use legacy geometry/packed host identities,
with the hard radius-128 boundary. The wide implementation contains real host
handlers, but is not a production playable world:

- `permutation-frontier/src/lib.rs` deliberately rejects wide SBF builds.
- `proc/wide.rs::DEPART_DEBIT_ENABLED` is limited to its designated native
  test configuration. This work does not enable it.
- Keeper wide planners retain `AUTOMATIC_SEND = false`.
- Original UI wide holdings are historical fold captures, not same-response
  live RPC account observations. Their action guards and the legacy transport
  allowlists remain closed.
- Mixed legacy/wide movement, production ABI/ruleset activation and the
  remaining proof-gated full settlement path are not resolved by navigation.

The next concrete read integration is an explicitly configured, bounded
Herald endpoint that reads the pinned Season, Citizen, selected WideHolding,
own WideProvince and Clock in one RPC response. It should display a separate
"RPC observed at slot" result, not relabel historical capture as current,
authenticated or executable. Keeper already implements sealed same-response
snapshot machinery, but Herald has no runtime access to that capability;
generic extraction into fclient is a separate follow-up.

## Execution boundary

The prior whole-page audit is
[CODEX-LOCAL-BROWSER-AUDIT-20261108.md](CODEX-LOCAL-BROWSER-AUDIT-20261108.md).
The bounded runner uses installed Playwright 1.58.2, sandboxed Chromium,
secure loopback with `devWallet=off`, a fresh public-only test wallet,
read-only fixture replies and the original committed hash-checked WASM.
No npm script, lifecycle hook, dependency installation, exporter, native
cryptographic test, key API self-test or CI job is part of this slice.

The added fixture copies immutable public Citizen and WideHolding bytes and
changes their public identities only in memory. These are explicitly
synthetic UI scenarios, not an actual grown chain or authenticated capture.
The default legacy replies are unchanged when the opt-in inventory is off.
Navigation and refresh use the original controller under the existing
same-turn final-holding/no-session/no-local-march conditions; they do not seal
or submit. Public base58/hash/address operations remain within the approved
key-free path. Refusal guards supplement static review, never replace it.

## Validation

- **149 selected Node tests passed**: the prior 99 original-map regressions,
  46 wide map/capture/economy/Garrison/focus cases, and four dictionary and
  translation-completeness checks. The other 20 language tests were filtered
  out. No broad package suite or key/scanner guard self-test ran.
- **2/2 original whole-page browser tests passed**, desktop 1440×900 and
  touch phone 390×844. Actual W2 selection opens the captured-village card;
  its map action centres and selects the captured province at `(129,0)`.
- A separate holding-only fixture at `(9007199254740993,0)` remains exact on
  both pages. Its missing province is explicitly unknown and draws no land.
  Repeated selection/reopening, ordinary inventory refresh, malformed map
  captures, refused inventory and changed-world replies are covered.
- Six focused fake-DOM cases also verify newer/closed requests supersede
  older responses, invalid coordinates/source/viewer callbacks clear focus,
  bounded stale-snapshot retry retains only the validated destination, and
  late history/poll replies cannot restore an invalidated viewer.
- The existing route/palisade/KEEP/Free City and R128 renderer regressions
  remain in the browser run. Synthetic full-chart redraw medians were 126 ms
  desktop and 127 ms phone, with zero terrain/province callbacks. These are
  local load measurements, not live growth or unlimited-world performance.
- Node/browser key-use arrays, stored session/dev keys, page exceptions,
  outside-origin requests and server writes were empty. The original world
  remained at six rings and legacy holdings were unchanged. Desktop/phone
  screenshots were visually inspected, including the far unknown coordinate.
- Syntax checks, `git diff --check`, and the read-only key-path classification
  scanner passed. After explicit approval, only ten existing review digests
  were refreshed for the reviewed source delta; test membership/targets and
  the scanner/guards were unchanged. No CI was started.

Initial browser attempts exposed two test-fixture/setup mistakes: the golden
Citizen's generation-zero first binding had been labelled legacy instead of
malformed, and a normal phone Join drawer hid the resting inventory pips.
The fixture label now agrees with unchanged bytes, and the test closes that
drawer through its real visible control. No parser rule was relaxed, state
injected, element hidden or click forced. Safety assertions also held on
those unsuccessful attempts.

Local browser log and screenshots are under
`/tmp/wylls-route-preview-20261108/`, including `wide-navigation-browser.log`
and `*-wide-village-{map,unknown,exact-far}.png`. They contain synthetic
presentation fixtures only and are not required to reproduce the tests.
