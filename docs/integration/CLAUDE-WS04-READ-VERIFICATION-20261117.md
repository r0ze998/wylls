# WS04 read verification — source-detector false positive (2026-11-17, corrected 2026-11-18)

## Scope

A narrow test correction. No product code changed. Only these files were touched:

- `workstreams/13-citizens/test/ws04-observe.test.mjs` (edited)
- `docs/integration/CLAUDE-WS04-READ-VERIFICATION-20261117.md` (this note)

Not touched: `workstreams/13-citizens/resident/ports/ws04-observe.mjs`, `bin/observe-canonical.mjs`,
`resident/resident.mjs`, `test/ws04-acts-duplicate.test.mjs`, and every other worker's files.

## Existing execution (run by the coordinator, not by me)

The coordinator statically audited the full imports of both existing test files and got normal approval for them.
Both were then run together in **one** `node --test` invocation that named the two exact filenames:

- `workstreams/13-citizens/test/ws04-acts-duplicate.test.mjs`
- `workstreams/13-citizens/test/ws04-observe.test.mjs`

| file | result |
|---|---|
| `ws04-acts-duplicate.test.mjs` | 4/4 pass |
| `ws04-observe.test.mjs` | 4/5 pass |
| **total (that one invocation)** | **8/9** |

The one failure was the source-text pin in `the client is not a resident port and imports nothing`:

```js
assert.doesNotMatch(s, /12-memory|shell: true|NoRecord'|send|submit|sign\(/);
```

`sign\(` matched the `sign(` inside `Object.assign(` (lines 32, 57, 58 of `resident/ports/ws04-observe.mjs`), where the
client builds its error objects. The client never calls a `sign` function. That makes this a false positive. The 3
runtime cases with the fake `execFile` (the store/db arguments, the error codes, the refused arguments) all passed.

## Correction

The detector is now a named constant:

```js
const FORBIDDEN = /12-memory|shell['"]?\s*:\s*true|NoRecord'|send|submit|(?<!as)sign\s*\(/;
const IMPORT = /^import /m;
```

- **`sign`:** `(?<!as)sign\s*\(`. Only `sign` directly preceded by `as` (`assign`, `Object.assign`, `reassign`) is
  excluded, which is the narrow fix for the false positive. Any whitespace (space, tab, newline, mixed) between
  `sign` and `(` is now caught. That covers `sign (`, `sign\t(`, `sign\n(`, `obj.sign (`, `obj . sign  (` and
  `obj\n  .sign (`. `sign(`, `obj.sign(`, `signer.sign(` and `resign(` are still caught.
- **`shell: true`:** `shell['"]?\s*:\s*true`. This is stricter than before: it catches `shell:true`, `shell :true`,
  `shell  :  true`, a tab or newline after the colon, and a quoted key (`'shell': true`, `"shell":true`).
  `shell: false` is still accepted.
- **`send` / `submit` / `NoRecord'` / `12-memory`:** unchanged. They still match as bare substrings, so they also catch
  `send (`, `sendRawTransaction`, `submitTransaction` and so on.
- The `^import ` check and the resident check (`resident.mjs` does not mention `ws04-observe`) are unchanged.
- No assertion was removed or weakened. Apart from the `as` exclusion, every change makes the detector catch more.

The client source was checked by reading it against the new pattern. Its only `sign` occurrences are the three
`Object.assign(` calls. Its only `shell` occurrences are `shell: false` and the comment `(no shell)`.

### Self-regression test

A new test, `the source detector itself: Object.assign is accepted, every real forbidden form is still caught`, pins
the detector against literal strings.

- **Accepted (must not match):**
  - two `Object.assign(...)` lines taken from the client;
  - `Object.assign` with a space, a tab or a newline before `(`;
  - `shell: false`, `shell:false` and `shell :\tfalse`;
  - the "not sent" comment.
- **Caught (must match):**
  - `sign` with no gap, a space, a tab, a newline, or mixed whitespace before `(`;
  - `key.sign` in the same forms, plus `key . sign  (` and `key\n  .sign (`;
  - `wallet.signer.sign(`, `resign(`, `resign (` and `as sign(`;
  - `send(`, `send (`, `conn.send(`, `sendRawTransaction(`, `submit(`, `submit\t(` and `rpc.submitTransaction(`;
  - `shell: true` with every spacing listed above, including a tab or newline after the colon and the quoted keys;
  - a `12-memory` import path and `'NoRecord'`;
  - `Object.assign(e, {}); key.sign(tx)` and `Object.assign(e, {}); key.sign (tx)`. These show that an `assign` next
    to a real `sign` call is still caught.
- **Import pin:** matches `import` at the start of a line, and does not match a comment that mentions importing.

## Not run

I ran nothing: no command, no test runner, no subprocess. The corrected test file, including the new self-regression
case, has **not been executed**. If the coordinator re-runs the same single `node --test` invocation on both exact
filenames, I expect these counts:

- `ws04-observe.test.mjs`: 6/6 (the 5 existing tests plus the new one);
- `ws04-acts-duplicate.test.mjs`: 4/4 (unchanged);
- total: 10/10.

These are expectations from reading the code, not results. They stay unverified until the coordinator runs them.

## Final independent verification (2026-11-17 UTC)

After reviewing the final whitespace-aware detector, the coordinator reran the same two exact test files through normal approval review: **10/10 passed** (Duplicate 4 + observe 6), zero failure/skip/cancel. `node --check` and scoped `git diff --check` passed. The earlier unrun/expected statements describe the implementation CLI, not this final result.

This closes only these pure contract/source-scan checks. No real runexec, registry/DB, gateway, live RPC, signing, world, or resident operation was exercised. Production files are unchanged.
