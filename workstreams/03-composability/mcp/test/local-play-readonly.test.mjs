// (2026-11-18, ⑤ option B) The READ-ONLY local-play observation server: an external AI resident links to it with its
// OWN wallet (a self link, agentId = owner), reads its village with the read tools, and can do nothing else — no write
// tool is listed or dispatched, no write scope is granted, no capability is asked, no request but GETs leaves the
// server. Over the test world of fixture.mjs (real account bytes, a scripted relay that the read-only game never asks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, connect, client, RELAY, HERALD, fx } from './fixture.mjs';
import { seasonAddresses } from '../../../../permutation-server/web/frontier/faddr.mjs';
import { JsonStore } from '../src/store.mjs';
import { Sealer } from '../src/seal.mjs';
import { Auth } from '../src/auth.mjs';
import { createWyllsMcp } from '../src/server.mjs';
import { createHandler, listen } from '../src/http.mjs';
import { LocalPlayGame } from '../src/local-play-game.mjs';
import { TOOLS, READ_ONLY_INSTRUCTIONS } from '../src/tools.mjs';
import { localPlaySettings } from '../bin/local-play-settings.mjs';

async function readOnlyServer(w, { season = seasonAddresses(fx.PROGRAM, fx.SEASON_ID).season } = {}) {
  const sent = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    sent.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.origin === RELAY && u.pathname === '/gw/f/local-play/info') return { status: 200, ok: true, json: async () => ({ localPlay: true, cluster: 'localnet', program: fx.PROGRAM, season, wallet: w.o }) };
    if (u.origin === RELAY) return { status: 404, ok: false, json: async () => ({ error: 'not a local-play route' }) };
    return w.fetch(url, init);
  };
  const clock = { t: Date.now() };
  const store = new JsonStore(null);
  const game = new LocalPlayGame({ relay: `${RELAY}/gw`, herald: HERALD, fetch, contextTtlMs: 0 });
  let handler;
  const srv = await listen(async (req, res) => handler(req, res));
  const issuer = `http://127.0.0.1:${srv.address().port}`;
  const auth = new Auth({ issuer, resource: `${issuer}/mcp`, store, sealer: new Sealer(null), game, now: () => clock.t, redirectProfiles: ['loopback'], readOnly: true });
  const mcp = createWyllsMcp({ auth, game, store, now: () => clock.t, readOnly: true });
  handler = createHandler({ auth, mcp, rateLimit: { burst: 10_000, everySecs: 2 } });
  return { srv, issuer, auth, mcp, game, clock, sent, close: () => new Promise(r => srv.close(r)) };
}
const READ_NAMES = TOOLS.filter(t => t.annotations.readOnlyHint === true && t.name !== 'prepare_caravan').map(t => t.name);

test('R1 discovery offers the read scope only; a write scope is refused at authorize', async () => {
  const w = await world();
  const s = await readOnlyServer(w);
  try {
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']) {
      const m = await (await fetch(`${s.issuer}${p}`)).json();
      assert.deepEqual(m.scopes_supported, ['wylls.read'], p);
    }
    const reg = await (await fetch(`${s.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' }) })).json();
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/cb', scope: 'wylls.read wylls.caravan', state: 's', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: `${s.issuer}/mcp` });
    const r = await fetch(`${s.issuer}/oauth/authorize?${q}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /error=invalid_scope/);
  } finally { await s.close(); }
});

test('R2 a self link: the resident\'s own wallet signs, reads its own village; only read tools exist', async () => {
  const w = await world();
  const s = await readOnlyServer(w);
  try {
    const tok = await connect(s, w, { scopes: ['wylls.read'], grant: null, agentId: w.o });
    assert.equal(tok.scope, 'wylls.read');
    const c = client(s, tok.access_token);
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.json.result.instructions, READ_ONLY_INSTRUCTIONS);
    assert.ok(READ_ONLY_INSTRUCTIONS.length <= 512);
    const list = (await c.rpc('tools/list', {})).json.result.tools;
    assert.deepEqual(list.map(t => t.name), READ_NAMES);
    assert.ok(list.every(t => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false));
    for (const name of ['send_caravan', 'prepare_caravan']) {
      const r = (await c.rpc('tools/call', { name, arguments: { planId: 'p', requestId: 'req-00000001', from: 'a', to: 'b', cargo: {} } })).json;
      assert.equal(r.error?.code, -32602, `${name} is not a tool here`);
    }
    const conn = (await c.tool('get_connection')).structuredContent;
    assert.deepEqual([conn.owner, conn.agentId, conn.write, conn.scopes], [w.o, w.o, false, ['wylls.read']]);
    assert.equal(conn.context.current.localPlay, true);
    const st = await c.tool('get_village_status');
    assert.equal(st.isError, false, JSON.stringify(st.structuredContent));
    assert.deepEqual([st.structuredContent.owner, st.structuredContent.village.p, st.structuredContent.village.q, st.structuredContent.village.site], [w.o, w.P, w.Q, w.SITE]);
    assert.equal(st.structuredContent.agent.mode, 'self');
    assert.equal((await c.tool('check_resource_shortfall', { goal: { kind: 'vault' } })).isError, false);
    // nothing but GETs left the server, and never to the agent wallet's routes
    assert.ok(s.sent.length > 0 && s.sent.every(x => x.startsWith('GET ')), s.sent.join('\n'));
    assert.ok(!s.sent.some(x => /\/f\/agent|\/f\/season/.test(x)), 'no agent wallet route is read');
  } finally { await s.close(); }
});

test('R3 a link naming another wallet as its agent is refused (self links only)', async () => {
  const w = await world();
  const s = await readOnlyServer(w);
  try {
    const r = await connect(s, w, { scopes: ['wylls.read'], grant: null, agentId: w.stranger });
    assert.equal(r.refused, 'access_denied');
    assert.match(r.description, /itself only/);
    const forged = await connect(s, w, { scopes: ['wylls.read'], grant: null, agentId: w.o, signer: (await import('./fixture.mjs')).keypair() });
    assert.equal(forged.refused, 'access_denied', 'a statement not signed by the owner\'s own key');
  } finally { await s.close(); }
});

test('R4 a herald of another Season than the world\'s relay pins: nothing is read as this world', async () => {
  const w = await world();
  const s = await readOnlyServer(w, { season: w.stranger });
  try {
    const tok = await connect(s, w, { scopes: ['wylls.read'], grant: null, agentId: w.o });
    const st = await client(s, tok.access_token).tool('get_village_status');
    assert.equal(st.isError, true);
    assert.equal(st.structuredContent.error.code, 'ContextUnavailable');
  } finally { await s.close(); }
});

test('R5 the read-only game sends nothing, and a read-only Auth takes no capability option', async () => {
  const g = new LocalPlayGame({ relay: 'http://localhost:1/gw', herald: 'http://localhost:1', fetch: async () => { throw new Error('no request may be made'); } });
  assert.equal((await g.submit({}, {})).json.code, 'ReadOnly');
  assert.equal((await g.ownerCommand({})).json.code, 'ReadOnly');
  assert.equal(await g.actFate('a', 'k'), null);
  assert.deepEqual((await g.agentView('not-an-address')).status, 404);
  await assert.rejects(g.agent({ owner: 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', agentId: 'C676sUVBzYBPsrUhf931tBwdM4XczCaG4jpChGnmMSwJ' }), e => e.code === 'NotOwner');
  assert.throws(() => new Auth({ issuer: 'http://127.0.0.1:1', resource: 'http://127.0.0.1:1/mcp', store: new JsonStore(null), sealer: new Sealer(null), game: g, readOnly: true, allowGlobalRotate: true }), /read-only/);
});

test('R6 the read-only server\'s settings: loopback world proxy and its /gw; no write option', () => {
  const ok = { WYLLS_MCP_TEST_AS: '1', WYLLS_MCP_PORT: '41440', WYLLS_MCP_HERALD: 'http://localhost:41412', WYLLS_MCP_RELAY: 'http://localhost:41412/gw' };
  assert.equal(localPlaySettings(ok).relay, 'http://localhost:41412/gw');
  for (const [k, v] of [['WYLLS_MCP_TEST_AS', ''], ['WYLLS_MCP_HERALD', 'http://10.0.0.2:41412'], ['WYLLS_MCP_RELAY', 'http://localhost:41412'], ['WYLLS_MCP_RELAY', 'https://example.com/gw'],
    ['WYLLS_MCP_WS04_ACTS', '/x'], ['WYLLS_MCP_ALLOW_GLOBAL_ROTATE', '1'], ['WYLLS_MCP_ALLOW_REMOTE_BIND', '1'], ['WYLLS_MCP_STORE', '/tmp/s.json']]) {
    assert.ok(localPlaySettings({ ...ok, [k]: v }).error, `${k}=${v}`);
  }
});
