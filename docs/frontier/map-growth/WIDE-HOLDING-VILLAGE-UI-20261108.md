# Captured wide villages in the ordinary village UI

Date: 2026-11-08. Base: `d584424d`. Branch: `work/wide-holding-ui-20261108`.

## Scope

Wide holdings are selectable from both the desktop village rail and the phone
sheet. Their ordinary village screen shows recorded resources, construction,
and reserve troops, with exact coordinates and capture provenance. They are
strictly read-only and remain separate from executable legacy holdings.

This change does not implement wide economic orders, change game rules, enable
wide execution, or modify the keeper, verifier, or public protocol. It was
implemented in an isolated worktree. No key pair was generated or derived,
nothing was signed or submitted, and no push or CI run was started. Public PDA
and with-seed address calculations are used to check account identity.

## Read contract

Herald `/h/me` adds `wideContext` beside the existing `wideHoldings` field when
`wide-world-experimental` is enabled. The context carries the world, season,
Citizen, three inventory bindings, latest folded slot, archive sequence, and
capture mode. A null context means unavailable, not an empty inventory.
Each captured holding additionally carries its ring, slot, season, owner Citizen,
host identity version, and open transits.

`fwide.mjs` validates the pair against independently derived page pins and the
same read's decoded Citizen bytes. The optional response Citizen address is
checked when present; it is never the identity pin. Both wallet Citizens and NFT
resident Citizens are supported. The three inventory bindings must agree with
the Citizen record, with exactly one ordered entry per wide-bound slot.

For each capture, the parser checks its canonical with-seed address, then reads
all 1,344 bytes using the deployed wide layout and checks the identity against
the summary. Magic, size, layout/family versions, reserved bytes, legacy-prefix
coordinates, world, sort key, owner, slot, generation, host identity and the
no-debit gate are checked. Capture slots and archive sequences cannot be ahead
of the context. Wide coordinates stay BigInts; stored resource amounts stay
exact integers. No wide object enters `FS.holdings` or `activeHolding()`.

## Display and state

- Wide-bound slots have their own W2/W3 selectors on desktop and phone.
- Captured records show resource amounts, rates and caps as recorded; build
  queue due times have no live countdown; troop counts are captured reserves.
- Every wide card is marked captured, unverified and read-only. The capture's
  slot is compared with the fold's latest slot as a slot count, never time.
  Currentness is unverified and elapsed time is unknown.
- Missing captures and multiple matching captures are distinct from zero or an
  empty slot. Ambiguous captures expose no ledger.
- A failed inventory read shows its error code and a retry button. An unavailable
  source says that ownership is unknown. These notices appear in the desktop
  rail, phone sheet and ordinary village screen while legacy operations remain
  available. A successfully read empty wide inventory shows no warning.
- Wallet, resident or source changes clear wide state. Resident changes clear it
  synchronously before the next read; prior-viewer responses cannot restore it.
  Failed reads also clear data and selection. Legacy selection closes the wide
  card; a later capture of the same valid slot updates the card.

## Legacy-order guards

Village action and form entry points refuse orders while the selected village
is wide. `actOnce` also checks subjects before account construction and again
at send time. Function-valued account builders check the subjects they produce.
The nested subject scan terminates on cycles, skips typed-array internals, and
fails closed beyond 4,096 distinct objects.

A legacy order already authorized before unrelated navigation can finish against
its legacy subjects. A wide subject is always refused with `WideReadOnly`.
Citizen-level operations are not converted into village orders.

## Validation performed

- Key-prohibited Node guard plus six scoped files: **91/91 passed**, including
  **19** wide-village tests and existing wide-map, cards, HUD, holding
  projection and language tests.
- Herald `wide_capture` integration file: **10/10 passed**, including the new
  context identity/inventory/latest-slot test. Fixtures use fixed public data.
- Scoped clippy for the herald library and `wide_capture`, with the wide feature
  and `-D warnings`: **passed**.
- Herald library `cargo check` with the wide feature disabled: **passed**.
- All changed JS modules and the new test passed `node --check`.
- The three edited Rust files passed `rustfmt +1.95.0 --check`.
- `git diff --check`: **passed**.
- Independent source review found no remaining confirmed issue after fixes for
  phone selection, immediate NFT clearing, independently pinned Citizen identity,
  nested subjects, and visible unavailable/failed reads.

Reproduction from the repository root:

```sh
node --import ./scripts/ci/no-keys-guard.mjs --test \
  permutation-gateway/test/web-frontier-wide-holding-ui.test.mjs \
  permutation-gateway/test/web-frontier-wide-world.test.mjs \
  permutation-gateway/test/web-frontier-cards.test.mjs \
  permutation-gateway/test/web-frontier-hud.test.mjs \
  permutation-gateway/test/web-frontier-holding-projection.test.mjs \
  permutation-gateway/test/web-lang.test.mjs

export CARGO_TARGET_DIR=/tmp/wylls-wide-holding-ui-target-20261108
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
cargo +1.95.0 test --locked --offline --manifest-path frontier-node/Cargo.toml \
  -p herald --features wide-world-experimental --test wide_capture -- --test-threads=1
cargo +1.95.0 clippy --locked --offline --manifest-path frontier-node/Cargo.toml \
  -p herald --features wide-world-experimental --lib --test wide_capture -- -D warnings
```

Only a dedicated target directory was used after checking available disk space.
Existing shared build caches were not deleted or repurposed.

### Known validation limits

`node scripts/ci/scan-node-key-tests.mjs --check` reports a stale exclusion list.
The identical failure was confirmed in the untouched base worktree. The list and
CI configuration were not changed; the scoped tests were run with the existing
key-prohibition guard. Full `npm test`, workspace tests and CI were not run.

Controller tests use the real controller with a fake herald and stubbed
transport. The relay is unset, test sessions do not sign, and no first-time NFT
join or march is staged. Function-valued accounts and late mutation are covered
by pure guards and source assertions rather than a real sealed march.

The Node tests cover markup and state. Subsequent real-browser fixture QA and
its production CSS fixes are recorded in `WIDE-HOLDING-BROWSER-QA-20261108.md`.
Full app boot, a live herald, real wallet interactions, chain execution and
deployment remain unverified. This work does not make wide villages playable or prove live
ownership. The latest slot is the fold's last folded slot, which may lag a live
source. Recorded economy values are deliberately not projected to the present.

## Integration surface

Herald: `src/wide.rs`, `src/views.rs`, `tests/wide_capture.rs`. Browser:
`fwide.mjs`, `screens/wideholding.mjs`, `fcodec.mjs`, `fstate.mjs`,
`controller.mjs`, `app.mjs`, `screens/holding.mjs`, `hud/hud.mjs`,
`fi18n.mjs`, `frontier.css`, and `lang/en-frontier.mjs`. The new Node test is
`permutation-gateway/test/web-frontier-wide-holding-ui.test.mjs`.

Keeper code is untouched. Concurrent edits to herald views, controller resident
handling, village composition or the English dictionary may need manual merge.
The language additions also fill existing missing wide-history labels found by
the scoped language regression. The `wide_capture` helper's string comparison
was made allocation-free to satisfy scoped clippy.
