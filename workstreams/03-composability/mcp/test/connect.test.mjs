// Connection settings for the clients named in docs 11 §1: which redirect URIs the authorization server accepts,
// and the preflight check a server must pass before a real client is connected (no client is run here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, server, world } from './fixture.mjs';
import { preflight } from '../src/preflight.mjs';
import { Auth } from '../src/auth.mjs';

async function register(s, redirect) {
  const r = await fetch(`${s.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  return r.status;
}
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';

test('redirect profiles: the default is unchanged (ChatGPT and loopback, not hosted Claude); claude is opt-in; an unknown profile is refused at start', async () => {
  const w = await world();
  const d = await server(w);
  try {
    assert.deepEqual(d.auth.redirectProfiles, ['chatgpt', 'loopback']);
    assert.equal(await register(d, CHATGPT), 201);
    assert.equal(await register(d, 'http://localhost:3118/callback'), 201, 'Claude Code: localhost, any port');
    assert.equal(await register(d, 'http://127.0.0.1:50211/callback'), 201, 'Claude Code: 127.0.0.1, any port');
    assert.equal(await register(d, CLAUDE), 400, 'hosted Claude is not accepted by default');
    assert.equal(await register(d, 'https://evil.test/callback'), 400);
  } finally { await d.close(); }
  const c = await server(w, { redirectProfiles: ['claude'] });
  try {
    assert.equal(await register(c, CLAUDE), 201);
    assert.equal(await register(c, 'http://localhost:3118/callback'), 400, 'a public profile alone does not take loopback');
    assert.equal(await register(c, CHATGPT), 400);
    assert.equal(await register(c, 'https://claude.ai/api/mcp/auth_callback/x'), 400, 'exact path only');
  } finally { await c.close(); }
  assert.throws(() => new Auth({ issuer: 'http://x.test', resource: 'http://x.test/mcp', store: { state: {} }, sealer: null, game: null, redirectProfiles: ['everyone'] }), /redirect profiles/);
  assert.throws(() => new Auth({ issuer: 'http://x.test', resource: 'http://x.test/mcp', store: { state: {} }, sealer: null, game: null, redirectProfiles: [] }), /redirect profiles/);
});

test('preflight for Claude Code on this machine: discovery, resource, S256, DCR with both loopback forms, the form token endpoint — and what it cannot check', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const r = await preflight(`${s.issuer}/mcp`, { client: 'claude-code' });
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
    assert.ok(r.checks.some(c => c.name === 'registers with redirect http://localhost:3118/callback' && c.ok));
    assert.ok(r.unverified.some(u => /client itself was not run/.test(u)));
    assert.ok(r.unverified.some(u => /http \(not https\) MCP URL/.test(u)));
    // The URL as entered must equal the resource exactly: localhost for a 127.0.0.1 server does not.
    const other = await preflight(`${s.issuer.replace('127.0.0.1', 'localhost')}/mcp`, { client: 'claude-code' });
    assert.equal(other.checks.find(c => c.name === 'resource equals the URL as entered').ok, false);
  } finally { await s.close(); }
});

test('preflight for hosted Claude and ChatGPT on a loopback server fails where it must (public https, and the default redirects for Claude)', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const gpt = await preflight(`${s.issuer}/mcp`, { client: 'chatgpt' });
    assert.deepEqual(gpt.checks.filter(c => !c.ok).map(c => c.name), ['scheme'], 'only the transport: it needs a public https URL');
    const claude = await preflight(`${s.issuer}/mcp`, { client: 'claude' });
    assert.deepEqual(claude.checks.filter(c => !c.ok).map(c => c.name).sort(), ['registers with redirect https://claude.ai/api/mcp/auth_callback', 'scheme'].sort());
  } finally { await s.close(); }
  const c = await server(w, { redirectProfiles: ['claude'] });
  try {
    const claude = await preflight(`${c.issuer}/mcp`, { client: 'claude' });
    assert.deepEqual(claude.checks.filter(x => !x.ok).map(x => x.name), ['scheme'], 'with the claude profile, only the public https URL is missing');
  } finally { await c.close(); }
  await assert.rejects(preflight('https://wylls.example/mcp', { client: 'chatgpt' }), /this machine only/);
});

test('a connection made for Claude Code (localhost redirect) still sees only its owner\'s places: a destination outside them is refused (sends to another player need the owner\'s wallet in S1; this path never makes one)', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const c = await connect(s, w, { redirect: 'http://localhost:3118/callback' });
    const { client } = await import('./fixture.mjs');
    const m = client(s, c.access_token);
    const st = (await m.tool('get_village_status')).structuredContent;
    const stranger = await m.tool('prepare_caravan', { from: st.village.placeId, to: 'vault:0,0,1', cargo: { Food: 1 } });
    assert.equal(stranger.structuredContent.error.code, 'NotYourPlace', 'S1: a send to another player needs the owner\'s wallet; this path never makes one');
  } finally { await s.close(); }
});
