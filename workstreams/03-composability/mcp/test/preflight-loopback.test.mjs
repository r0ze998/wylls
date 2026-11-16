// preflight (src/preflight.mjs) keeps "this machine only" for every request it makes, and never follows a redirect
// (2026-11-17). SOURCE-ONLY when written: not run in the session that wrote it. The fetch is a fake that records what
// would have been asked and answers from a table: no request leaves the process, no server is started, no OAuth
// client is registered anywhere, no key is made. This file imports only ../src/preflight.mjs (which imports nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preflight } from '../src/preflight.mjs';

const URL0 = 'http://127.0.0.1:9000/mcp';
const L = 'http://127.0.0.1:9000';
/** A healthy loopback server's answers; `over` replaces some, by "METHOD url". */
function server(over = {}) {
  const asked = [];
  const res = (status, body = null, headers = {}) => ({ status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => { if (body === null) throw new Error('no body'); return body; } });
  const table = {
    [`POST ${URL0}`]: () => res(401, null, { 'www-authenticate': `Bearer resource_metadata="${L}/.well-known/oauth-protected-resource"` }),
    [`GET ${L}/.well-known/oauth-protected-resource`]: () => res(200, { resource: URL0, authorization_servers: [`${L}/`] }),
    [`GET ${L}/.well-known/oauth-authorization-server`]: () => res(200, { issuer: `${L}/`, code_challenge_methods_supported: ['S256'], registration_endpoint: `${L}/register`,
      token_endpoint_auth_methods_supported: ['none'], token_endpoint: `${L}/token`, authorization_response_iss_parameter_supported: true }),
    [`POST ${L}/register`]: () => res(201, { client_id: 'c1' }),
    [`POST ${L}/token`]: () => res(400, { error: 'invalid_grant' }),
    ...over,
  };
  const fetch = async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    asked.push({ key, redirect: init.redirect });
    const h = table[key];
    if (!h) throw new Error(`unexpected request ${key}`);
    return h();
  };
  return { asked, fetch };
}
const external = a => a.filter(x => !/^\w+ http:\/\/127\.0\.0\.1:9000\//.test(x.key));

test('a healthy loopback chain still runs through, every request sent without following redirects', async () => {
  const s = server();
  const r = await preflight(URL0, { client: 'claude-code', fetch: s.fetch });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.deepEqual(s.asked.map(x => x.key), [`POST ${URL0}`, `GET ${L}/.well-known/oauth-protected-resource`, `GET ${L}/.well-known/oauth-authorization-server`,
    `POST ${L}/register`, `POST ${L}/register`, `POST ${L}/token`]);
  assert.ok(s.asked.every(x => x.redirect === 'manual'));
});

test('a URL the server names that is not on this machine is refused before it is requested, at every step', async () => {
  const PRM = `${L}/.well-known/oauth-protected-resource`, ASM = `${L}/.well-known/oauth-authorization-server`;
  const asm = over => () => ({ status: 200, headers: { get: () => null }, json: async () => ({ issuer: `${L}/`, code_challenge_methods_supported: ['S256'], registration_endpoint: `${L}/register`,
    token_endpoint_auth_methods_supported: ['none'], token_endpoint: `${L}/token`, ...over }) });
  for (const [label, over, step] of [
    ['resource_metadata', { [`POST ${URL0}`]: () => ({ status: 401, headers: { get: () => 'Bearer resource_metadata="https://outside.example/prm"' }, json: async () => null }) }, 'protected resource metadata'],
    ['authorization server', { [`GET ${PRM}`]: () => ({ status: 200, headers: { get: () => null }, json: async () => ({ resource: URL0, authorization_servers: ['https://outside.example'] }) }) }, 'authorization server metadata'],
    ['registration endpoint', { [`GET ${ASM}`]: asm({ registration_endpoint: 'https://outside.example/register' }) }, 'registration endpoint'],
    ['token endpoint', { [`GET ${ASM}`]: asm({ token_endpoint: 'https://outside.example/token' }) }, 'token endpoint'],
    ['IPv6 elsewhere', { [`GET ${ASM}`]: asm({ registration_endpoint: 'http://[2001:db8::1]/register' }) }, 'registration endpoint'],
    ['0.0.0.0', { [`GET ${ASM}`]: asm({ registration_endpoint: 'http://0.0.0.0:9000/register' }) }, 'registration endpoint'],
  ]) {
    const s = server(over);
    const r = await preflight(URL0, { client: 'claude-code', fetch: s.fetch });
    assert.equal(r.ok, false, label);
    assert.deepEqual(external(s.asked), [], `${label}: nothing outside was requested`);
    assert.ok(r.checks.some(c => c.name === `${step}: on this machine` && !c.ok), `${label}: ${JSON.stringify(r.checks.at(-1))}`);
    assert.equal(r.checks.at(-1).name, `${step}: on this machine`, `${label}: it stopped there`);
  }
});

test('a redirect answer stops the preflight; nothing after it is requested', async () => {
  for (const key of [`POST ${URL0}`, `GET ${L}/.well-known/oauth-protected-resource`, `POST ${L}/register`]) {
    const s = server({ [key]: () => ({ status: 302, headers: { get: k => (k === 'location' ? 'https://outside.example/' : null) }, json: async () => null }) });
    const r = await preflight(URL0, { client: 'claude-code', fetch: s.fetch });
    assert.equal(r.ok, false); assert.match(r.checks.at(-1).name, /: no redirect$/);
    assert.equal(s.asked.at(-1).key, key, 'the redirect was the last request');
    assert.deepEqual(external(s.asked), []);
  }
});

test('credentials in a URL, another scheme, or no URL at all: refused before any request (also with allowRemote)', async () => {
  for (const allowRemote of [false, true]) {
    for (const [endpoint, name] of [['http://user:secret@127.0.0.1:9000/register', 'no credentials in the URL'], ['file:///etc/passwd', 'http or https'],
      ['ftp://127.0.0.1/register', 'http or https'], [undefined, 'a URL'], [42, 'a URL']]) {
      const s = server({ [`GET ${L}/.well-known/oauth-authorization-server`]: () => ({ status: 200, headers: { get: () => null },
        json: async () => ({ issuer: `${L}/`, code_challenge_methods_supported: ['S256'], registration_endpoint: endpoint, token_endpoint_auth_methods_supported: ['none'], token_endpoint: `${L}/token` }) }) });
      const r = await preflight(URL0, { client: 'claude-code', fetch: s.fetch, allowRemote });
      assert.equal(r.checks.at(-1).name, `registration endpoint: ${name}`, String(endpoint));
      assert.ok(!s.asked.some(x => x.key.includes('register')), 'the registration was never requested');
      assert.ok(!JSON.stringify(r).includes('secret'), 'a credential never comes back');
    }
  }
});

test('allowRemote adds no new permission: redirects are still refused; the first URL is checked as before', async () => {
  const s = server({ [`POST ${URL0}`]: () => ({ status: 307, headers: { get: () => null }, json: async () => null }) });
  const r = await preflight(URL0, { client: 'claude-code', fetch: s.fetch, allowRemote: true });
  assert.equal(r.ok, false); assert.equal(r.checks.at(-1).name, 'MCP endpoint: no redirect');
  await assert.rejects(preflight('https://outside.example/mcp', { client: 'chatgpt', fetch: server().fetch }), /this machine only/);
});

test('every request goes through the one checked path (pinned as text)', () => {
  const src = readFileSync(new URL('../src/preflight.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/\bf\(/g) ?? []).length, 1, 'one fetch call, inside reach');
  assert.match(src, /const res = await f\(String\(target\), \{ \.\.\.init, redirect: 'manual' \}\);/);
  assert.doesNotMatch(src, /^import /m);
});
