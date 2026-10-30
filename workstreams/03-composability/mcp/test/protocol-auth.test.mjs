// [SIMULATED CHAIN, real HTTP on loopback] The MCP transport, discovery and OAuth: what ChatGPT's custom MCP
// connection needs (Streamable HTTP, RFC 9728/8414 metadata, PKCE S256, resource indicators, DCR, refresh
// rotation) and every way a token or a consent can be wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, connect, fx, keypair, server, world } from './fixture.mjs';
import { TOOLS } from '../src/tools.mjs';
import { revokeStatement } from '../src/auth.mjs';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';

const get = async (s, p, headers = {}) => { const r = await fetch(`${s.issuer}${p}`, { headers }); return { status: r.status, headers: Object.fromEntries(r.headers), json: await r.json().catch(() => null) }; };

test('discovery: protected resource and authorization server metadata name this resource, S256 only, DCR', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const prm = await get(s, '/.well-known/oauth-protected-resource');
    assert.equal(prm.status, 200);
    assert.equal(prm.json.resource, `${s.issuer}/mcp`);
    assert.deepEqual(prm.json.authorization_servers, [s.issuer]);
    assert.deepEqual(prm.json.scopes_supported, ['wylls.read', 'wylls.caravan']);
    assert.deepEqual((await get(s, '/.well-known/oauth-protected-resource/mcp')).json, prm.json, 'the path-suffixed form too');
    const as = await get(s, '/.well-known/oauth-authorization-server');
    assert.deepEqual(as.json.code_challenge_methods_supported, ['S256']);
    assert.ok(as.json.registration_endpoint && as.json.token_endpoint && as.json.authorization_endpoint);
    assert.deepEqual(as.json.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(as.json.authorization_response_iss_parameter_supported, true);
  } finally { await s.close(); }
});

test('/mcp without a token: 401 with WWW-Authenticate naming the resource metadata; GET is 405; a foreign Origin is 403; no batches', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const m = client(s, 'x');
    const r = await m.rpc('initialize', {}, { auth: null });
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'], new RegExp(`^Bearer resource_metadata="${s.issuer}/\\.well-known/oauth-protected-resource"`));
    const bad = await m.rpc('tools/list', {}, { auth: 'Bearer not-a-token-of-ours-at-all' });
    assert.equal(bad.status, 401);
    assert.match(bad.headers['www-authenticate'], /error="invalid_token"/);
    assert.equal((await fetch(`${s.issuer}/mcp`)).status, 405);
    const c = await connect(s, w, { scopes: ['wylls.read'], grant: null });
    const evil = await fetch(`${s.issuer}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', authorization: `Bearer ${c.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(evil.status, 403);
    const batch = await fetch(`${s.issuer}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${c.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) });
    assert.equal(batch.status, 400);
  } finally { await s.close(); }
});

test('initialize negotiates a supported version; tools/list: one operation per tool, every annotation explicit, OAuth schemes', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const c = await connect(s, w, { scopes: ['wylls.read'], grant: null });
    const m = client(s, c.access_token);
    const init = await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.json.result.protocolVersion, '2025-06-18');
    assert.ok(init.headers['mcp-session-id']);
    assert.ok(init.json.result.instructions.length <= 512, 'the instructions fit the 512 characters ChatGPT surfaces first');
    assert.equal((await m.rpc('initialize', { protocolVersion: '1999-01-01' })).json.result.protocolVersion, '2025-11-25');
    const list = (await m.rpc('tools/list')).json.result.tools;
    assert.deepEqual(list.map(t => t.name), TOOLS.map(t => t.name));
    for (const t of list) {
      for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(typeof t.annotations[k], 'boolean', `${t.name}.${k}`);
      assert.ok(t.description.length > 40, t.name);
      assert.ok(Array.isArray(t.securitySchemes) && t.securitySchemes[0].type === 'oauth2', t.name);
      assert.match(t.name, /^(get|check|prepare|send|list)_[a-z_]+$/);
    }
    const writes = list.filter(t => !t.annotations.readOnlyHint).map(t => t.name);
    assert.deepEqual(writes, ['send_caravan'], 'one write tool');
    assert.equal(list.find(t => t.name === 'send_caravan').annotations.destructiveHint, true);
    assert.deepEqual(list.find(t => t.name === 'send_caravan').securitySchemes[0].scopes, ['wylls.read', 'wylls.caravan']);
    for (const forbidden of ['withdraw', 'deposit', 'policy', 'mode', 'transfer', 'pay']) assert.equal(list.some(t => t.name.includes(forbidden)), false, forbidden);
  } finally { await s.close(); }
});

test('OAuth: PKCE, code reuse, resource, redirect URIs, and a refresh token used twice revokes the connection', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const reg = await fetch(`${s.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    assert.equal(reg.status, 400, 'only ChatGPT\'s or loopback redirect URIs');
    const ok = await fetch(`${s.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }) });
    assert.equal(ok.status, 201, 'ChatGPT\'s redirect URI is accepted');
    // a code bound to its verifier, used once
    const c = await connect(s, w, { scopes: ['wylls.read'], grant: null });
    const again = await c.post('/oauth/token', { grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, client_id: c.clientId, redirect_uri: c.redirect }, true);
    assert.equal(again.json.error, 'invalid_grant', 'a code is used once');
    // a wrong resource at authorize: redirected back with invalid_target
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: c.redirect, scope: 'wylls.read', state: 's', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: 'https://other.example/mcp' });
    const wrong = await fetch(`${s.issuer}/oauth/authorize?${q}`, { redirect: 'manual' });
    assert.equal(wrong.status, 302);
    assert.equal(new URL(wrong.headers.get('location')).searchParams.get('error'), 'invalid_target');
    q.set('resource', `${s.issuer}/mcp`); q.set('code_challenge_method', 'plain');
    assert.equal(new URL((await fetch(`${s.issuer}/oauth/authorize?${q}`, { redirect: 'manual' })).headers.get('location')).searchParams.get('error'), 'invalid_request', 'plain PKCE refused');
    // refresh: rotated; the old one replayed revokes the link and its access tokens
    const r1 = await c.post('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.clientId }, true);
    assert.equal(r1.status, 200);
    assert.notEqual(r1.json.refresh_token, c.refresh_token);
    const m = client(s, r1.json.access_token);
    assert.equal((await m.tool('get_connection')).isError, false);
    const replay = await c.post('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.clientId }, true);
    assert.equal(replay.json.error, 'invalid_grant');
    assert.equal((await m.rpc('tools/list')).status, 401, 'the connection was revoked');
  } finally { await s.close(); }
});

test('consent: a statement signed by another key, an agent this relay does not know; the page holds no secret', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const forged = await connect(s, w, { signer: keypair() });
    assert.equal(forged.refused, 'access_denied');
    assert.match(forged.description, /not signed by the owner/);
    const other = await world();
    const notMine = await connect(s, w, { scopes: ['wylls.read'], grant: null, agentId: other.agent.agentId });
    assert.equal(notMine.refused, 'temporarily_unavailable', 'an agent unknown to this relay');
    const page = await connect(s, w, { scopes: ['wylls.read'], grant: null });
    assert.ok(page.html.includes('wylls.read'));
    assert.ok(!page.html.includes(w.agent.capability), 'the consent page carries no capability');
  } finally { await s.close(); }
});

test('consent: an agent that belongs to another owner on the same relay is refused', async () => {
  const w = await world();
  const intruder = keypair();
  const made = await fx.createAgent(w.r, intruder, { policy: fx.policy(['economy']) });
  const s = await server(w);
  try {
    // The owner signs, but names the intruder's agent: the relay's view says it is not theirs.
    const r = await connect(s, w, { scopes: ['wylls.read'], grant: null, agentId: made.agentId });
    assert.equal(r.refused, 'access_denied');
    assert.match(r.description, /another owner/);
  } finally { await s.close(); }
});

test('tokens expire; the owner\'s signed revocation stops the connection; a read-only connection cannot send (insufficient_scope)', async () => {
  const w = await world();
  const clock = { t: Date.now() };
  const s = await server(w, { clock });
  try {
    const ro = await connect(s, w, { scopes: ['wylls.read'], grant: null });
    const m = client(s, ro.access_token);
    const send = await m.tool('send_caravan', { planId: 'pln_x', requestId: 'req-00000001' });
    assert.equal(send.structuredContent.error.code, 'InsufficientScope');
    assert.match(send._meta['mcp/www_authenticate'][0], /error="insufficient_scope", scope="wylls.read wylls.caravan"/);
    clock.t += 61 * 60_000;
    const late = await m.rpc('tools/list');
    assert.equal(late.status, 401, 'an hour later the access token has expired');
    assert.match(late.headers['www-authenticate'], /expired/);
    const fresh = await connect(s, w, { scopes: ['wylls.read'], grant: null });
    const linkId = Object.keys(s.store.state.links).at(-1);
    const at = clock.t;
    const sig = Buffer.from(signTalk(revokeStatement({ linkId, owner: w.o, at }), w.owner)).toString('base64');
    const wrongSig = Buffer.from(signTalk(revokeStatement({ linkId, owner: w.o, at }), keypair())).toString('base64');
    assert.equal((await fresh.post('/link/revoke', { linkId, owner: w.o, at, signature: wrongSig })).status, 401);
    assert.equal((await fresh.post('/link/revoke', { linkId, owner: w.o, at, signature: sig })).status, 200);
    assert.equal((await client(s, fresh.access_token).rpc('tools/list')).status, 401, 'revoked at once');
    const rf = await fresh.post('/oauth/token', { grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: fresh.clientId }, true);
    assert.equal(rf.json.error, 'invalid_grant', 'and its refresh token');
  } finally { await s.close(); }
});
