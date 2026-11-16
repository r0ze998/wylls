// The preflight command (bin/wylls-mcp-preflight.mjs): its arguments, `--allow-remote`, its JSON and exit codes
// (2026-11-17). SOURCE-ONLY when written: not run in the session that wrote it. `main` is driven with a fake fetch
// that records each request; no request leaves the process, no server is started, nothing is registered anywhere.
// Imports: node:test, node:assert/strict, and the command (which imports node:url and src/preflight.mjs only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, USAGE, errorText } from '../bin/wylls-mcp-preflight.mjs';

/** A healthy server at `origin` (loopback or an approved deployment), answering from a table. */
function server(origin, { over = {}, throwOn = null } = {}) {
  const asked = [];
  const res = (status, body = null, headers = {}) => ({ status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => { if (body === null) throw new Error('no body'); return body; } });
  const table = {
    [`POST ${origin}/mcp`]: () => res(401, null, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }),
    [`GET ${origin}/.well-known/oauth-protected-resource`]: () => res(200, { resource: `${origin}/mcp`, authorization_servers: [origin] }),
    [`GET ${origin}/.well-known/oauth-authorization-server`]: () => res(200, { issuer: origin, code_challenge_methods_supported: ['S256'], registration_endpoint: `${origin}/register`,
      token_endpoint_auth_methods_supported: ['none'], token_endpoint: `${origin}/token`, authorization_response_iss_parameter_supported: true }),
    [`POST ${origin}/register`]: () => res(201, { client_id: 'c1' }),
    [`POST ${origin}/token`]: () => res(400, { error: 'invalid_grant' }),
    ...over,
  };
  const fetch = async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    asked.push({ key, redirect: init.redirect });
    if (throwOn === key) throw new TypeError('fetch failed');
    const h = table[key];
    if (!h) throw new Error(`unexpected request ${key}`);
    return h();
  };
  return { asked, fetch };
}
async function run(argv, s) {
  const out = [], err = [];
  const code = await main(argv, { print: x => out.push(x), warn: x => err.push(x), fetch: s.fetch });
  return { code, out, err, json: out.length ? JSON.parse(out.at(-1)) : null };
}
const L = 'http://127.0.0.1:9000', R = 'https://deploy.example';

test('usage errors exit 2, print nothing on stdout, and request nothing', async () => {
  for (const argv of [[], [`${L}/mcp`, 'claude-code', 'extra'], [`${L}/mcp`, '--allow-remote', '--allow-remote'], [`${L}/mcp`, '--allow-remote=1'],
    [`${L}/mcp`, '-x'], [`${L}/mcp`, '--allowRemote'], [`${L}/mcp`, 'gemini'], ['not a url'], ['--allow-remote']]) {
    const s = server(L);
    const r = await run(argv, s);
    assert.equal(r.code, 2, JSON.stringify(argv)); assert.deepEqual(r.out, []); assert.deepEqual(s.asked, []);
    assert.ok(r.err.join('\n').includes(USAGE), JSON.stringify(argv));
  }
});

test('by default a URL off this machine is refused as JSON (exit 1), nothing requested; loopback runs as before (exit 0)', async () => {
  const off = server(R);
  const r = await run([`${R}/mcp`, 'chatgpt'], off);
  assert.equal(r.code, 1); assert.equal(r.json.ok, false); assert.match(r.json.error, /this machine only/); assert.deepEqual(off.asked, []);
  const lo = server(L);
  const ok = await run([`${L}/mcp`, 'claude-code'], lo);
  assert.equal(ok.code, 0, JSON.stringify(ok.json?.checks)); assert.equal(ok.json.ok, true); assert.deepEqual(ok.err, []);
  assert.ok(lo.asked.every(x => x.redirect === 'manual'));
});

test('--allow-remote is the library\'s allowRemote and no more: the deployment is checked; redirects and credentials are still refused', async () => {
  const s = server(R);
  const r = await run([`${R}/mcp`, 'chatgpt', '--allow-remote'], s);
  assert.equal(r.code, 0, JSON.stringify(r.json?.checks)); assert.equal(r.json.ok, true);
  assert.ok(r.err.some(x => /approved deployment only/.test(x)), 'the opt-in is said on stderr');
  assert.ok(s.asked.every(x => x.key.includes(R) && x.redirect === 'manual'));
  // a redirect is still refused
  const red = server(R, { over: { [`GET ${R}/.well-known/oauth-protected-resource`]: () => ({ status: 302, headers: { get: () => null }, json: async () => null }) } });
  const rr = await run([`${R}/mcp`, 'chatgpt', '--allow-remote'], red);
  assert.equal(rr.code, 1); assert.equal(rr.json.checks.at(-1).name, 'protected resource metadata: no redirect');
  // credentials in a server-named URL are still refused, and never printed
  const cred = server(R, { over: { [`GET ${R}/.well-known/oauth-authorization-server`]: () => ({ status: 200, headers: { get: () => null }, json: async () => ({ issuer: R,
    code_challenge_methods_supported: ['S256'], registration_endpoint: 'https://user:hunter2@deploy.example/register', token_endpoint_auth_methods_supported: ['none'], token_endpoint: `${R}/token` }) }) } });
  const cr = await run([`${R}/mcp`, 'chatgpt', '--allow-remote'], cred);
  assert.equal(cr.code, 1); assert.equal(cr.json.checks.at(-1).name, 'registration endpoint: no credentials in the URL');
  assert.ok(!cr.out.join('').includes('hunter2')); assert.ok(!cred.asked.some(x => x.key.includes('register')));
});

test('a request that fails is JSON with exit 1, not a crash; the requests made before it are listed by the fake', async () => {
  const s = server(L, { throwOn: `POST ${L}/token` });
  const r = await run([`${L}/mcp`, 'claude-code'], s);
  assert.equal(r.code, 1); assert.deepEqual(r.json, { client: 'claude-code', ok: false, error: 'request failed' });
  assert.equal(s.asked.filter(x => x.key === `POST ${L}/register`).length, 2, 'the registrations before it were made (and are not undone)');
});

// (2026-11-17) An exception's own message is never printed: a fetch that throws text naming a credential (made-up
// values only) gives the fixed "request failed"; the library's own refusal keeps its fixed text. Written, not run.
test('an exception naming a credential is never printed; only fixed texts come back', async () => {
  const thrown = [new Error('connect to http://u:zq9@127.0.0.1:9000/token failed (Authorization: Bearer zq9tok)'),
    'http://u:zq9@127.0.0.1:9000/', { message: { url: 'http://u:zq9@127.0.0.1:9000/' } }, null, undefined, 42];
  for (const e of thrown) {
    const s = server(L);
    const f = async (url, init = {}) => { if (url === `${L}/token`) throw e; return s.fetch(url, init); };
    const out = [];
    const code = await main([`${L}/mcp`, 'claude-code'], { print: x => out.push(x), warn: () => {}, fetch: f });
    assert.equal(code, 1); assert.equal(JSON.parse(out.at(-1)).error, 'request failed', String(e));
    assert.ok(!out.join('').includes('zq9'), 'the made-up credential never comes back');
  }
  let ran = false;
  const getter = { get message() { ran = true; return 'http://u:zq9@127.0.0.1/'; } };
  assert.equal(errorText(getter), 'request failed'); assert.equal(ran, false, 'a message getter is never run');
  assert.match(errorText(new Error('preflight runs against a server on this machine only (it registers OAuth clients); allowRemote is for an approved deployment')), /--allow-remote is for an approved deployment$/);
});
