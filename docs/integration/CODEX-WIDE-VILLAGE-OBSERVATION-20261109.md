# Wide village RPC observation — 2026-11-09

Base: `26fcfc3b1730113dd0286b31cc0e23e7db9d23b7`.

## Scope

The original player page can request a new, explicitly labelled account
observation beside a selected captured wide village. It does not overwrite
captured history, add projected production, establish ownership/currentness,
or construct or submit orders. Coordinates and stored resource quantities
remain exact beyond JavaScript's safe integer range.

Herald's default-off `wide-live-read-experimental` feature exposes
`GET /h/wide-live/village`. Enabling it also requires `--source read-only`, a
matching existing checkpoint and wide index, and all three explicit options:
`--wide-live-rpc`, `--wide-live-ruleset`, `--wide-live-min-slot`. It accepts only
the existing experimental S1 program version `0x4004`, layout 2 and rules 12.
The configuration does not activate or migrate a Season.

The RPC destination must be literal IPv4 loopback HTTP with a nonzero port,
without a path, credentials, query or fragment. There is no startup RPC.
Each explicit request reads exactly Holding, Province, Citizen, Season and
Clock through one confirmed `getMultipleAccounts` response. The request has
a three-second timeout, 32 KiB HTTP-wire cap and 9,000-byte account-data cap.
There is no discovery, retry, repair, ingest or persistence.

The backend validates canonical selection, program owners, executable bits,
exact layouts, public addresses, world, season, generation, Citizen inventory
marker, Province mirror, rules hash/version, Clock and minimum/context slots.
The frontend independently validates the returned raw bytes and snapshot
digest. A content digest binds those bytes, not RPC truth or authentication.

The UI requires a supported Season, the configured Herald at the page's own
origin, a ready public viewer and a selected checked capture. It uses only
the fixed relative endpoint, with an explicit button and no automatic poll.
Response bytes are capped during streaming, before strict UTF-8/JSON parsing.
Failure hides earlier observed values and says unknown, not zero. Capture
cards remain separate. Selection, screen, viewer and source changes cancel
or discard stale results. An equivalent identity/capture slot can retain a
separately slot-labelled observation even if that capture's payload changes
within the same slot; this is not an authorization or currentness guarantee.

## Reviewed execution scope

The existing Rust build audits were rechecked against this exact feature:
385 selected packages, 33 build scripts, 31 procedural-macro crates. External
package versions/features match the prior audited verifier graph. Only local
root/features differ. All 378 selected cached archives match the lockfile;
all 11,365 regular extracted members match, with no extra/special entries.
No new dependency, local build hook, lockfile change or runtime initializer
was introduced. Environment/configuration checks found no wrapper, linker,
native-build or dynamic-library overrides. Existing native-default output
was reused, not a duplicate explicit-target directory.

The initial eight `herald/tests/wide_live.rs` tests were run with Rust 1.95,
offline/locked, two build jobs, fixture-export variables unset and one test
thread. They use literal public account bytes and fake SnapshotSource,
without sockets or `main`. All eight passed. Compilation took 8.89 seconds.
The positive test's actual JSON stdout was passed into the independent JS
parser with separately constructed public selection pins. Identity, digest,
slot and exact greater-than-2^53 resource assertions passed.
The default-disabled library and `frontier-herald` binary also passed
`cargo check --no-default-features` with the same offline/locked toolchain.
This compile check did not start the CLI.

After a separate source audit, two actual HTTP transport tests and one
isolated router test were added. All **11 feature-on Rust tests passed**.
The adapter sends exactly one POST with five ordered keys, confirmed/base64
and the requested minimum slot. Literal loopback fixtures verify success,
HTTP-wire overflow, missing/non-boolean executable metadata and unsupported
encoding. The fixture bounds requests to 4 KiB, joins its socket futures,
has a five-second deadline and checks for an unwanted second connection.
The unconfigured router returns 503 without changing the empty fold or
writing files. Its output path is an inert child of `/dev/null`; the
constructors only store it. Server tasks are aborted/joined before assertions.
These paths call neither CLI `main`, TestKey, ingest, fixture generators,
curl/TLS nor an external RPC. Existing dependencies suffice.
The same single unavailable-route test also passed separately with
`--no-default-features`, confirming the feature-off 503 path at runtime.

Nine focused Node tests passed: exact raw values, wallet/resident identity,
scope/metadata/data mutation refusal, explicit fetch/failure, cancellation,
source invalidation, experimental/same-origin eligibility, bounded streaming
and strict UTF-8. Existing S1 building/unit labels are reused, including the
workshop. Four selected dictionary/completeness checks passed. Tests use
public SHA256/PDA helpers, fixed bytes, fake fetch and pure display functions.
Imported key/sealing definitions are not invoked. The existing defensive
guard was used without exercising any forbidden API as a self-test.

The prior 145 selected original-map and wide-map/capture/history regressions
were rerun and all passed. Together with the nine new tests and four language
checks, this is **158 selected Node tests**, not a broad package-suite pass.

## Whole-page verification

Both original-page browser tests passed: desktop 1440×900 and touch phone
390×844, in 53.55 seconds. Normal W2 selection reaches the village card and
its explicit read button. The new observed resource/build/reserve section
appears beside unchanged capture provenance. Server failure and a malformed
digest hide earlier observations. Closing/reopening and changing the source
world discard held responses without automatic rereads. Legacy program 4
never enables or requests the observation. Viewer-change refusal is covered
by the focused reader test, not a browser disconnect flow.

The existing route, palisade, KEEP, Free City, exact wide-coordinate navigation
and synthetic R128 chart regressions remain in the run. Node/browser key-use
arrays, stored session/dev keys, page exceptions, outside-origin requests and
server writes were empty. The canonical fixture world stayed at six rings.
No forced clicks, injected player state or hidden overlays were used.

The first browser attempt exposed a synthetic-fixture error: the old golden
Season's bump byte was a placeholder zero, but the canonical public PDA bump
is 254. The new observation correctly refused it. The copied fixture now
derives the bump through the existing public address helper and asserts the
same Season address. Program/world/rules hash remain pinned; the production
parser is unchanged. A separate phone attempt met the delayed original Join
drawer after reload. The test now closes it through its visible normal close
control before selecting W2, without pressing any key action. Visible-card
assertions wait for the paint as well as the accepted state.

Local evidence: `/tmp/wylls-route-preview-20261108/wide-live-browser.log`,
the preserved `wide-live-browser-attempt1.log` / `attempt2.log`, and
`desktop/phone-wide-live-{observed,failure,malformed}.png`. These contain
synthetic public presentation data only.

## Boundaries

No real RPC account set or authenticated live chain was contacted. Synthetic
fixtures are not chain evidence. Backend tests use fake snapshots or the real
HTTP adapter against literal loopback fixtures; browser fixtures use a local
synthetic HTTP source. The Herald CLI startup and a configured positive
Herald-router-to-RPC-to-browser deployment are not exercised as one integrated
system by those tests. Never use `--test-key` for
key-free startup: that existing option constructs beacon key material.

The legacy radius/host-ID limits, SBF exclusion, production WideDepart debit
gate, automatic-send prohibition, mixed-family refusal and production
ABI/ruleset activation decisions remain unchanged. This is a usable original
UI read path, not a playable production wide world or an infinite-world
completion claim. No private key generation/derivation/signing, guard
self-test, fixture exporter, transaction, deployment or CI was run.
