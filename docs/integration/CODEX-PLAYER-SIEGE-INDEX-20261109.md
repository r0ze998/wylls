# Index the original player's active sieges

Base: `c9359b4f980cfd5e20c30c98d989005295ac04cc`.

## Actual game read path

The conquest additions to `/h/me/{wallet}` previously scanned every siege
history in the season. They now seek the player's active participant bucket
and read only those histories. The exact global active-history count also
replaces the separate full-history siege count in `/h/status/conquest`.

`SiegeHistories` retains the complete ordered history map and derives active
key sets for each owner and attacker. A participant appearing in both roles
is indexed once. The existing view still gives the owner role precedence.
The bucket is ordered by the original signed `(i16, i16, u8, u32)` map key,
not printable history keys or row-coordinate assumptions. Free City `None`
ownership, tag zero and every simultaneously active history at a site retain
the prior semantics.

Indexed insertion removes previous participants on exact-key replacement,
including active/ended transitions. The three existing conquest outcomes and
season lapse use indexed ending, preserving the first end and removing only
that history's active memberships. Ending the latest declaration at a site
does not hide an earlier still-active declaration. Progress and follow-up rows
are read from the current history, not copied into stale presentation caches.
Clone preserves the derived index; JSON restoration rebuilds it through indexed
insertion, including duplicate checkpoint keys. Checkpoint JSON is unchanged.

This adds storage proportional to active participant memberships and logarithmic
index maintenance. It does not change combat, rewards, ownership, capture,
Free City rules, record acceptance or production write permissions.

## Source API boundary

The public Rust `Cq.sieges` field is now `SiegeHistories` rather than a raw
`BTreeMap`. Immutable method-based map reads and indexed `insert` remain
available. Unrestricted mutable-map methods, raw-map assignment and implicit
`IntoIterator` over the wrapper are not preserved. This is an intentional
source API tightening, not a claim of drop-in compatibility for hypothetical
external mutators. Repository callers were inspected; their used read methods
and insertions remain supported. No mutable dereference is exposed. Remaining
parent-module mutable-history references were audited as progress/follow-up
updates or a kind read, not owner, attacker or end changes.

## Audited execution

Independent review covered the final source before execution:

- `conquest.rs`: `169feae57549245827ec9f4740004b4236bb5b98947b697776d5239642fd7f7f`.
- `player_siege_index.rs`: `3fbb8d3dfe609c0f7f04445fc9c7416f23476a0b32e464c9a2e6465e1b1553b3`.
- `player_siege_index_tests.rs`: `a513be9b2e2c07529336fea92e270329cbae1290449c97532300302067e5c348`.

The four new tests use public literal account/record bytes and in-memory state.
They call the actual `SIEGE_DECLARED` arm of `fold_record` and the selected
Failed, Occupied and CaptureDue branches of `conquest_event`, including both
detail-bit values. Their events, tallies, player counters and alert diffs stay
in memory. They do not call `on_record`, full `Fold::apply`, program dispatch,
startup, native proof verification or full `final_file`. Season-end coverage
calls the exact pure mutation used by finalization, not its output pipeline.
`Out::new` is inert. Literal signature bytes and strings are neither generated
nor signed. Public address derivation, JSON/byte codecs and hashes are the only
cryptographic-shaped operations on these paths.

A frozen copy of the original `me_additions` loop independently supplies expected
alerts, siege rows and player rows. Its source was compared to the base after
only whitespace, fixed-wallet and import substitutions. Tests also compare the
actual complete `views::me_json` response, using the unchanged non-conquest
fields plus those independent additions. JSON restoration and clone tests do
not claim disk checkpoint IO or a live chain.

The native graph/configuration audit from the preceding inventory and host
index reports remains applicable: no manifests, lockfiles, build scripts,
dependencies or default features changed. Removing the existing empty wide ABI
feature for the default build adds no compile-time dependency path. Runs used
installed Rust 1.95.0, native cache reuse, offline/locked resolution, two build
jobs, and both fixture/export write variables unset.

From `frontier-node`, selected filters were:

```sh
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib conquest::player_siege_index_tests:: -- --test-threads=1
cargo +1.95.0 test --offline --locked -p herald --lib conquest::player_siege_index_tests:: -- --test-threads=1
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib conquest::tests:: -- --test-threads=1
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib fold::player_host_index_tests:: -- --test-threads=1
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib wide:: -- --test-threads=1
```

Final result: **26 distinct tests passed, 30 selected test executions**:
4 new under both default and wide configurations, 5 existing conquest tests,
6 player-host index regressions and 11 wide regressions. The new assertions
cover ordering, overlapping roles, zero/None, missing/disabled conquest state,
active/ended replacement, missing and repeated endings, current progress,
latest-only ending, selected actual record handlers, lapse, clone and JSON
restoration with duplicate keys. Status counts agree with the original count.

Adding 500 unrelated active histories and 500 ended histories involving the
player leaves their complete response unchanged. The lookup visits exactly
five relevant active rows both before and after growth. These synthetic
histories occupy 500 distinct legacy coordinates within radius 123, not new
land or authenticated world growth.

The first compile found a test-only private constant import; the reference was
corrected to the same public `MAX_LINKS = 12` constant. The first test run then
passed three cases and exposed out-of-range synthetic legacy coordinates in
the restoration fixture. Those coordinates were corrected without loosening
the existing radius-128 parser. Both narrow changes were independently reviewed
before rerunning. No production rule or parser was altered to obtain a pass.

Rust formatting, `git diff --check` and the read-only Node classification scan
passed. Review metadata and guards remain unchanged. No Node/browser test,
guard self-test, full workspace suite, CI, deployment or transaction was run.

## Remaining limits

This removes the remaining whole-season siege scan from the player's own
conquest additions. Work still scales with relevant returned histories and
ordered-map lookups. Complete history storage, checkpoint serialization,
season-finalization output and other status fields such as contested keeps
remain separate costs. This is not an unlimited-memory or constant-time game.
Production radius-128 gameplay, experimental wide/SBF/debit/send boundaries and
the separate pending live-observation UI are unchanged.
