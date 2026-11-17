// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// The protected resource metadata (RFC 9728) no longer advertises `resource_documentation`: it pointed to
// `<issuer>/docs`, which src/http.mjs does not route. Everything else in the metadata is unchanged. KEY-FREE: reads
// src/auth.mjs and src/http.mjs as TEXT only (importing auth.mjs would load the gateway client's modules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const auth = readFileSync(new URL('../src/auth.mjs', import.meta.url), 'utf8');
const http = readFileSync(new URL('../src/http.mjs', import.meta.url), 'utf8');
const prm = auth.slice(auth.indexOf('  protectedResource() {'), auth.indexOf('  serverMetadata() {'));
const code = prm.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'); // comments are not the object

test('P1 no resource_documentation in the returned object', () => {
  assert.ok(prm.length > 0, 'protectedResource() found');
  assert.doesNotMatch(code, /resource_documentation/);
  assert.doesNotMatch(code, /\/docs/);
});

test('P2 the rest of the metadata is unchanged', () => {
  assert.match(code, /return \{ resource: this\.resource, authorization_servers: \[this\.issuer\], scopes_supported: Object\.values\(SCOPES\), bearer_methods_supported: \['header'\],/);
  assert.match(code, /resource_name: 'Wylls \(local test stack\)' \};/);
});

test('P3 consistent with the routes: no /docs route, and the two well-known paths serve the same metadata', () => {
  assert.doesNotMatch(http, /case 'GET \/docs'/);
  assert.match(http, /case 'GET \/\.well-known\/oauth-protected-resource':\n\s+case 'GET \/\.well-known\/oauth-protected-resource\/mcp':\n\s+return send\(res, 200, auth\.protectedResource\(\)/);
});
