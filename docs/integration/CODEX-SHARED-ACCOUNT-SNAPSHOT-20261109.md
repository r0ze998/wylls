# Share coherent account snapshots with original-game readers

Base: `e9530370fdce33876c9dc7868d363c720cf5fe0a`.

## Change

The same-response account snapshot implementation now lives in
`fclient::snapshot`, under a new default-off `snapshot` feature. This lets a
Herald read path reuse the checked RPC observation without pulling keeper
startup, planners or runtime into Herald's production dependencies.

The shared implementation owns the parser, Clock/Rent validation, immutable
account snapshot, sealed metadata/digest, RPC adapter, object-safe source
trait and precision-preserving Rent arithmetic. The digest domain deliberately
remains `PSF-KEEPER-WIDE-SNAPSHOT-v1`, preserving its existing meaning.

Keeper enables this feature only with its existing wide opt-in. A thin
`Snapshot` newtype preserves `snapshot.reads()` and the existing keeper-facing
traits. Planner `Reads` are populated from the shared accessors and consumers
still recheck the digest against the actual bytes. No unsealed constructor,
fallback parser or second RPC read was added.

The parser, sysvar validation, Rent/meta/digest implementation and keeper
planning/discovery logic were compared against the base. They are unchanged
apart from imports and the wrapper; RPC code changes only its crate-qualified
address path. No dependency, lockfile, default feature, transaction path,
economic rule, SBF/debit/send gate or startup hook changed.

## Audited verification

The build review is a source/manifest delta over the existing native audits:
`CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md` and
`CODEX-WIDE-VERIFY-AUDIT-20261109.md`. Both lockfile hashes remain unchanged.
The feature is empty and enables no new external package or build hook.

Selected runtime paths use literal public addresses, byte codecs, JSON/base64,
public SHA256, arithmetic and fake source replies. The reviewed claim tests
retain unsigned packet sizing only; no signing, private derivation, key
generation, socket, startup, exporter or guard self-test is invoked.

**39 selected tests passed:**

- Shared reader: 2, covering context/presence/provenance, edited-byte/minimum
  refusal, cardinality, duplicates, typed errors and strict Clock/Rent metadata.
- Existing moved Rent arithmetic suite: 8, including exact values beyond
  floating-point integer precision and runtime bounds.
- Existing keeper `wide_claim`: 18.
- Existing keeper `wide_claim_preview`: 11.

The first build mistakenly selected an explicit native triple, producing a
duplicate native-output tree. Disk exhaustion stopped later keeper compilation
before completion. The two emitted fclient binaries were rerun with exactly
the audited selections and their passing counts retained. Only that newly
generated duplicate output tree was removed; source and the preexisting
default target cache were preserved. The two keeper suites then passed using
the native-default cache with installed Rust 1.95.0, offline/locked, two build
jobs and fixture-export environment variables unset. This was an environment
failure, not a passing claim about the interrupted build.

Changed files were formatted explicitly and `git diff --check` passed.
No live RPC observation, full workspace suite, CI, deployment or actual
transaction was run. A scoped real original-game observation endpoint and its
UI are separate work; extraction alone does not make a wide village current,
authenticated, actionable or playable.
