# Wide Economy Local Demo, phase 1: sandbox and stdio protocol (2026-11-08)

## Status

A **local, host-only, single-player** demo, written on top of `64f7cd15`.
The sandbox and stdio example were built on the Mac with Rust 1.89.0.
Its 23 audited example tests passed, including the five byte-for-byte
recorded economic cases. No keypair was generated or derived and nothing
was signed. The HTTP/browser adapter is implemented under
`permutation-gateway/screens/wide-economy-local/`; its separate README records
adapter checks. Real browser integration was exercised on the Mac in Chrome as recorded below.

These results concern an in-memory simulation with mocked signer flags,
not chain execution, actual wallet authorization or multiplayer gameplay.

What this is **not**: no economic rule, ABI, event, `wide.rs`, keeper or
original fixture was changed; no key, keypair, signature, wallet, RPC,
network, transaction, deployment or push is involved; nothing is deployable.

## What changed

| Path | Change |
|---|---|
| `permutation-frontier/Cargo.toml` | feature `local-economy-demo = ["wide-world-experimental"]`; `[[example]] local_economy_demo` with `required-features` |
| `permutation-frontier/src/lib.rs` | `compile_error!` for the Solana target and for `nft-experimental` together with the feature |
| `permutation-frontier/src/prologue.rs` | feature-gated demo clock; `now()` unchanged for every other build |
| `permutation-frontier/examples/local_economy_demo/{main,engine,protocol}.rs` | new: stdio loop, sandbox and judgement, protocol and unit tests |
| this document | new |

No dependency was added; `Cargo.lock` is not touched.

## Why a new clock hook

On the host, `Clock::get` returns `UnsupportedSysvar` (`solana-get-sysvar`
1.0.0 has no hook), and the existing `set_test_clock` is `cfg(test)` only, so
an example cannot use it. Under `local-economy-demo`:

- `prologue::set_local_demo_clock(ts, slot)` / `clear_local_demo_clock()` set
  and unset a **thread-local** value; the sandbox sets it immediately before
  a dispatch and clears it right after.
- `prologue::now()` then **never calls `Clock::get`**. Unset returns
  `UnsupportedSysvar`: fail closed. There is no wall clock, no environment
  variable and no default.
- Without the feature, `now()` is byte-for-byte what it was (the
  `cfg(test)` test clock first, then `Clock::get`); the two function bodies
  were only moved into `clock_source()`.
- `set_test_clock` is untouched and stays `cfg(test)`.
- `cfg(target_os = "solana")` with the feature is a `compile_error!`.
  The feature also refuses `nft-experimental`: the recorded Seasons carry
  program version `0x4004` (S1 `4` | wide bit `0x4000`) and the NFT bit would
  make it `0xC004`. The sandbox additionally refuses to start unless the
  build's `PROGRAM_VERSION` equals `0x4004` and the Season's stored version.

## What runs

Every Harvest, Build and Train is `permutation_frontier::dispatch` (0xDA op 3)
on six `AccountInfo`s built per call from the sandbox's **owned buffers**
(`AccountInfo::new` over `&mut` borrows that end with the call; no
`Box::leak`, no `resize` scaffolding):

`[actor s] [payer s,w] [Season r] [Citizen w] [Holding w] [Province r|w]`,
the Province writable only for walls and the tier-up (`Action::mirror_write`).

- Program `[0x12;32]`, wallet `[0xa1;32]`, payer `[0xd4;32]`: literals.
- Season 11 address: `addr::season_pda(11, stored bump, program)`, the
  Citizen, Holding and Province addresses by the public with-seed hashes
  (`citizen_by_tag15`, `holding_address`, `province_address`) from the
  fixture's own coordinate and site. No `find_program_address`, no curve
  operation, no key.
- **MOCK AUTH NO SIGNATURE**: `is_signer` is set by the sandbox. Nothing
  signs or verifies anything; the response says so in `"auth"`.
- The originals are `include_bytes!` of the `harvest` case's `season.bin`,
  `citizen_pre.bin`, `holding_pre.bin` and `province_pre.bin` under
  `frontier-node/crates/verify/tests/fixtures/wide_economy/`. Those files are
  read at compile time only and never written.

### Stores and "no restock"

The fixtures' stores were set by hand to 1,900 units before the first action
(a fixture, see that directory's README). The sandbox has **no code path that
writes a store**: the only writer of the images is the commit of a judged
dispatch. A stock therefore returns only through `reset`, which reloads the
original bytes. The test `repeated_sequence_never_restocks` checks the
observable form: after one settling action, actions at the same instant
(no production possible) never raise any store and do pay something.

### Time

The demo clock starts at `1800088200` (Season genesis + bell 147) and moves
only through `advance`, which changes the clock and **no account byte**: no
accrual, no queue completion, no finality flip until the next economic action
(which is where the program settles them, as on chain). `advance` accepts
600, 3600 and 86400 seconds only, never goes backward, and is refused
(`TIME_LIMIT`) if the new time would reach the Season's end bell; the Season
is never modified.

## Judgement of a mutation

Per `act`: clone the four images (stage) → dispatch on the stage → judge →
commit the stage, or drop it.

Judged, in this order (a failure is a `fault`, nothing is committed):

1. no panic; **zero CPI** (the stub denies and counts every
   `sol_invoke_signed`); no log line other than the one `PSW1` record (the
   stub collects only that and counts every other `sol_log`/`sol_log_data`);
   every lamport balance as it was.
2. On a handler error: no record may have been logged (else `fault`); the
   response is `refused` with the program's code (`E<n>`, or `P<n>` for a
   runtime error); the stage is dropped, so memory, revision and logs are as
   they were and `recordHex` is `null`.
3. On success: exactly one record, and
   - Season byte-identical; account sizes unchanged;
   - Citizen: only `BUCKET_MILLI`, `BUCKET_T` and `LAST_ACTION_TS` differ,
     header untouched, stamp = now;
   - Holding: trailer, header up to the chain, prefix identity, owner and
     order, ticket bell, escrow..pool-owed unchanged; owner-action stamp =
     now; state unchanged or provisional → final;
   - Province: byte-identical unless a mirror item; for walls and the tier-up
     the header before the chain, identity and size are kept and at most 32
     bytes outside the chain header changed (a sanity bound; the mirror rule
     itself is the program's, not re-implemented here);
   - the record decodes (`WideRecord::decode`), has the action's kind, the
     right bell and the holding's economy key;
   - its receipt equals an `EconomyReceipt` rebuilt with the existing ABI
     helpers: `input_digest` over the complete Season, Citizen, Holding and
     Province **before**, `output_digest` over the complete **after** bytes,
     the finality bit from the before/after state bytes;
   - the holding chain advanced by exactly one link equal to the stored
     chain; the province chain likewise for mirror items and unchanged
     otherwise; `verify_chain` over the one record reproduces both.

This is a sanity check by the same ABI code that wrote the receipt, not an
independent oracle. It is also not proof of authentication (there is none).

## Protocol `wylls-local-economy-v1`

One ASCII line per command on stdin, at most **256 bytes** (checked while
reading into a fixed array, before any allocation; the rest of a longer line
is discarded unstored and answered `LINE_TOO_LONG`). One compact JSON line per
response on stdout, nothing else on stdout. End of input exits cleanly; a
last line **without its newline is dropped** (a truncated command must never
run). Errors go to stderr only at start-up or on an I/O failure.

```text
get
act REV harvest
act REV build ITEM            ITEM 0..=8
act REV train UNIT COUNT      UNIT 0..=6, COUNT 1..=1000
advance REV SECONDS           SECONDS 600 | 3600 | 86400
reset REV
```

- Single spaces, printable ASCII only (one trailing CR tolerated); empty,
  extra, missing, signed, zero-padded, hex or overflowing fields are
  `refused` with a fixed code: `BAD_COMMAND`, `BAD_ENCODING`,
  `BAD_REVISION`, `BAD_ITEM`, `BAD_UNIT`, `BAD_COUNT`, `BAD_SECONDS`,
  `LINE_TOO_LONG`.
- `COUNT <= 1000` is a **transport budget, not a game rule**; so are the three
  time skips. There are no custom accounts, paths, instruction bytes, times or
  program ids on the wire.
- `REV`: canonical decimal, at most 2^53 - 1. A mutation must carry the
  current revision (`STALE_REVISION` otherwise), the revision is compared
  first and incremented **only on success** (`reset` and `advance` included),
  and is never reused. It is capped at 1,000,000 (`REVISION_LIMIT`, a
  refusal, never a wrap).
- `reset` reloads the original bytes and the initial time verbatim and
  **keeps counting the revision up**.

Response (fixed schema, hex and digits only, no serializer):

```json
{"protocol":"wylls-local-economy-v1","mode":"local-only","auth":"MOCK_AUTH_NO_SIGNATURE",
 "status":"ok|refused|fault","revision":0,"now":"1800088200","command":"get|act|advance|reset|invalid",
 "action":null,"code":null,"seasonHex":"..","citizenHex":"..","holdingHex":"..","provinceHex":"..","recordHex":null}
```

(shown wrapped; the real line has no whitespace.) `recordHex` holds the one
`PSW1` record body only after a successful `act`; `get`, `advance`, `reset`,
refusals and faults carry `null`. `action` is one of three fixed names or
`null`; `code` is `null` or a fixed token (`[A-Za-z0-9_]` only). A response is
under 64 KiB by construction (about 2 x 10 KB of state).

After a `fault` the sandbox stays as it was and keeps answering; a fault is a
defect to investigate, not a game outcome.

## Tests (in the example)

`cargo test --example` unit tests, none using a key API, an environment
variable or a fixture export:

- start state is `harvest/pre`; clock 1800088200 = bell 147; the harvest
  record's receipt time equals it;
- **golden**: for each of the five recorded cases a separate copy of that
  case's pre-state is loaded (test only), the recorded action is replayed at
  the recorded time, and the Citizen, Holding, Province, Season and the
  record are compared byte for byte with the recorded post-state and
  `record.bin`;
- repeated sequence without restock; Build queues until an advance and a
  touch; Train credits the reserve; insufficient funds refused with every
  byte and log unchanged; invalid actions refused before any dispatch;
  unset clock fails closed; unexpected CPI, extra log, lamport change, panic,
  record count, tampered record and tampered stage are faults that commit
  nothing; only mirror items touch the province;
- protocol: grammar table, 256-byte bound across buffer fills, EOF mid-line,
  stable `get`, stale and malformed requests leaving state and revision alone,
  reset keeping the revision climbing, season-bounded time skips that touch no
  account, revision cap, compact fixed-schema JSON.

## Validation commands

Use fresh, dedicated target directories, as in
`WIDE-ECONOMY-EXECUTION-20261108.md`.

```sh
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
export CARGO_TARGET_DIR=/tmp/wylls-local-demo-check
cargo +1.89.0 test  --offline --locked -p permutation-frontier --features local-economy-demo --example local_economy_demo -- --test-threads=1
cargo +1.89.0 check --offline --locked -p permutation-frontier --lib                         # default build unchanged
cargo +1.89.0 check --offline --locked -p permutation-frontier --features wide-world-experimental --lib
cargo +1.89.0 clippy --offline --locked -p permutation-frontier --features local-economy-demo --lib -- -D warnings
# expected to FAIL to compile (the guards):
cargo +1.89.0 check --offline --locked -p permutation-frontier --features local-economy-demo,nft-experimental --lib
# a manual session (stdin only):
printf 'get\nact 0 harvest\nget\n' | cargo +1.89.0 run --offline --locked -p permutation-frontier --example local_economy_demo --features local-economy-demo
```

Also re-run the existing wide-economy host suite
(`map_growth_runtime_tests::wide_land::wide_economy::`) to confirm the
`prologue.rs` change did not disturb the test clock.

## Remaining risks

- `std::panic::catch_unwind` around a dispatch relies on unwinding; a build
  with `panic = "abort"` turns a handler panic into process exit, not a fault.
- The golden tests assume the recorded fixtures replay under this build's
  program code; they are the first thing to check if they fail, and a failure
  there means the fixtures or the program drifted, not that the sandbox is
  wrong.
- Some tests assert economic facts they cannot compute by hand (that item 0
  and the trains are affordable from the 1,900 stock; that a Build matures
  within 60 days; that two actions at the same instant are accepted). They
  read values from the state rather than hard-coding them, but a rule that
  differs from the recorded behaviour would show up as a failing test.
- The Province judgement for mirror items is a bound, not the mirror rule.
- The fixtures' hand-set stores are a demo premise, not an economic result.
- Process-global syscall stubs and collectors are serialised by a lock inside
  the sandbox; running tests with more than one thread is expected to work
  but is untested, hence `--test-threads=1` above.


## Validation recorded on 2026-11-08

- Rust example: 23/23 passed after formatting, including all five golden cases.
- Default library and wide-world-experimental library: both compile checks passed.
- Local demo example: clippy with `-D warnings` passed. The fixed-field
  wire renderer has a documented too-many-arguments exception.
- `local-economy-demo,nft-experimental`: compilation was refused by the
  intended version guard. No Solana target was compiled or deployed.
- Browser/Node adapter: five focused, no-keys-guard suites passed, 48/48.
  Their fake-host regressions are distinct from the real-host smoke below.
- Actual Chrome + real stdio host: Harvest (rev 1), Build farm (rev 2),
  Train 10 spears (rev 3), advance one day (rev 4), and Harvest (rev 5).
  The queue completed, food's hourly rate changed from 40 to 52 and the
  reserve remained 10. Additional trains spent resources rather than
  replenishing them; the fourth 1,000-spear request was refused E21 with
  revision 8 unchanged. Reset restored the original account bytes and
  clock while advancing to revision 9.
- Opening the page from another app initially returned 403. Only top-level
  static GET/HEAD navigation was corrected. Exact Host, cross-site API
  blocking, strict mutation Origin/header rules and CSP remain in place.
- Screenshot: `.local/wide-economy-demo/browser-smoke-reset.jpg` (local
  evidence, not a repository fixture).

The tests used no keypair generation/derivation or signing. The browser
flow was local simulated authorization, with no wallet, RPC or chain
transaction. Existing static practice and localnet processes were not
changed. Full wide/runtime suites were not run as part of this check.
