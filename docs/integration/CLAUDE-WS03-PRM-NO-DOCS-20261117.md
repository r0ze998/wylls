# ③ MCP: the protected resource metadata no longer advertises a page that does not exist (2026-11-17)

**Branch:** `claude/ws03-prm-no-docs-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `02f9bb46`. The aggregate, canonical, `main`, Lane C and Lane D refs are unchanged.

**Static change, NOT run:**
- **Not done:** no test, import, syntax check, server start, HTTP, authentication, key, signing or publishing.

**Origin:** item B1 of `CLAUDE-WS03-REAL-CONNECTION-BLOCKERS-20261117.md`.

## The inconsistency

- **What was advertised:** `src/auth.mjs` `protectedResource()` returned `resource_documentation: ${issuer}/docs`.
- **What exists:** `src/http.mjs` has no `/docs` route. The routes are the two well-known metadata paths, `oauth/*`, `owner`, `owner/*`, `link/revoke*` and `mcp`. So a client that followed the link got `404 {error: 'not_found'}`.
- **The rule:** RFC 9728 §2 lists `resource_documentation` as OPTIONAL.

## The change (`src/auth.mjs` `protectedResource()` only)

- **Removed:** the `resource_documentation` field. A comment says why, and that it returns with a real page if one is ever published.
- **Unchanged:** `resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported` and `resource_name`; the authorization server metadata; every OAuth endpoint, scope, permission and authentication rule.
- **Not created:** no new page, URL, setting or publication.

## Readers checked (read only, at `02f9bb46`)

- **`src/http.mjs`** serves `protectedResource()` at both well-known paths, unchanged.
- **`src/preflight.mjs`** reads `resource` and `authorization_servers` only.
- **`test/protocol-auth.test.mjs`** checks `resource`, `authorization_servers` and `scopes_supported`, and that both paths serve the same body. All still hold.
- **The preflight tests** use their own fake metadata.
- **Nothing in the tree reads `resource_documentation`.**

## Regression (written, NOT run): `test/protected-resource-no-docs.test.mjs`

**How:** it reads `src/auth.mjs` and `src/http.mjs` as **text**; importing `auth.mjs` would load the gateway client's modules.

| Case | What is checked |
|---|---|
| P1 | the returned object (comments stripped) has no `resource_documentation` and no `/docs` |
| P2 | the first line of the object and `resource_name` are unchanged |
| P3 | `http.mjs` has no `/docs` route, and both well-known paths still serve `protectedResource()` |

## Static counter-review (once)

- **Clients:** ChatGPT and Claude need `resource` and `authorization_servers` (and use `scopes_supported`); none needs `resource_documentation`. **That is based on the specification, not on a real client session.**
- **The `/mcp` path variant** serves the same object, so it changes the same way.
- **The comment's text** contains `${issuer}` inside a `//` comment. It is not a template string and is never sent.

**Fixed tip:** the commit that adds this report on `claude/ws03-prm-no-docs-20261117`. It changes 3 paths on `02f9bb46`: `src/auth.mjs`, `test/protected-resource-no-docs.test.mjs`, and this report.

**Not verified:** nothing was run; no real client read the metadata.
