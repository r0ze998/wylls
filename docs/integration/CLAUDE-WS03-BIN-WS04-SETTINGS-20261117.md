# ③ MCP launcher: ④'s act registry settings are all three or none, checked before anything opens (2026-11-17)

**Branch:** `claude/ws03-bin-ws04-settings-20261117`, from the fixed aggregate `claude/aggregate-approved-20261117` at `78f22cb5`. The aggregate, canonical, `main` and Lane D refs are unchanged. The bin was reserved with Lane D in advance.

**Static change, NOT run:**
- **Not done:** no launch of the bin, HTTP, RPC, authentication, key, import of product code, syntax check or test.
- **Not changed:** sending, billing, URLs, ports or any other setting.

## The defect

- **The rule:** `bin/wylls-mcp.mjs` says "All three settings or none" for `WYLLS_MCP_WS04_ACTS`, `WYLLS_MCP_WS04_RUNEXEC` and `WYLLS_MCP_WS04_DB` (`:40`).
- **What it enforced:** only the case where `ACTS` was given (`:43-44` at `78f22cb5`, after the store and `Auth` were already made).
- **The silent case:** with `RUNEXEC` and/or `DB` given but no `ACTS`, the server started **without** ④'s registry, on this server's own tracking, and said nothing.
- **The adopted document** (`18-ws04-seven-states.ja.md:61`) lists the four settings and "unset: not used". It does not allow half of them to be ignored.

## The change

| File | Change |
|---|---|
| `workstreams/03-composability/mcp/bin/ws04-acts-settings.mjs` (new, 100644) | `ws04ActsSettingsError(env)`, a pure function: `null` for none or all three; otherwise an error text. A value counts as given when non-empty, as the bin has always read it. |
| `workstreams/03-composability/mcp/bin/wylls-mcp.mjs` (100755 kept) | an import, plus one check right after the existing `WYLLS_MCP_TEST_AS` and `WYLLS_MCP_STORE` checks: on an error, print it and exit 2. This is before `JsonStore`, `Game`, `Auth`, the receipt port and the registry import. |
| `workstreams/03-composability/mcp/test/ws04-acts-settings.test.mjs` (new) | S1–S4, **written, not run** |

**Error text:**
- **With `ACTS` given,** the existing text is kept: `WYLLS_MCP_WS04_ACTS needs WYLLS_MCP_WS04_RUNEXEC and WYLLS_MCP_WS04_DB`.
- **Without `ACTS`,** the text names the given and missing settings.
- **Never a value:** no path, port or secret.

**Unchanged:**
- None or all three: the same start as before.
- `WYLLS_MCP_WS04_GATEWAY_PORT`: optional with the three, read by truthiness as before. It decides `readVia`.
- The lines pinned by `test/ws04-readvia.test.mjs` V5 (`gatewayPort`, `createActsClient`, `actsReadVia`, `createWyllsMcp(...)`).
- **The inner check (`:43-44` at `78f22cb5`, now `:47-48`)** (now reached only with all three given, where it does not fire) is kept as it was, as a second guard.
- Authentication, sending and billing.

## Regression (written, NOT run)

- **S1:** none, all three, all three with a gateway port, and a gateway port alone → no error.
- **S2:** all six partial combinations are refused, and no value appears in the text. `ACTS` alone gets the existing text; `RUNEXEC` with `DB` names `ACTS` as missing.
- **S3:** empty values count as not given.
- **S4:** reads the bin as text: the check comes before `new JsonStore(`, `new Game(` and the registry's dynamic import, and the `readVia` line is unchanged.
- **Imports:** only the new pure helper; the bin is read as text, never imported.

## Static counter-review (once, read only)

1. **Where it is checked:**
   - The check runs after the two existing setting checks and before every object that touches the outside: the store file (`JsonStore` reads it), `Game` (relay and herald), `Auth`, the receipt port, and the registry's dynamic `import`.
   - The static imports at the top load the same modules as before. Nothing new loads before the check, apart from the pure helper, which imports nothing.
2. **Other settings:**
   - The helper reads only the three names.
   - The gateway port's handling and the `readVia` derivation are untouched.
   - Exit code 2 matches the bin's other setting errors.
   - Whitespace-only values count as given, as the existing truthiness reading always did.
3. **Who relies on the old fallback:** no one found.
   - `git grep` over the tree at `78f22cb5` (`*.sh`, `*.mjs`, `*.yml` and the docs) finds the four `WYLLS_MCP_WS04_*` names only in this bin, `18-ws04-seven-states.ja.md:61` and the text pin in `test/ws04-readvia.test.mjs`.
   - No script or test starts the bin with a partial set.
4. **Packaging and the suite:**
   - `mcp/package.json` has no `bin` or `files` entry, so the new non-executable `bin/ws04-acts-settings.mjs` is not exposed as a command.
   - The new test matches `npm test`'s `test/*.test.mjs` and is key-free (pure import plus a text read). It has not been run.
5. **The aggregate moved meanwhile** (`c1345ef1`, Lane C's four ① paths). It changes no ③ file, so this branch's four paths are disjoint from it.

**Result:** no defect found; no further change.
