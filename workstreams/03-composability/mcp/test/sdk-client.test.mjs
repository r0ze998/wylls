// [LOCAL MCP CLIENT: @modelcontextprotocol/sdk 1.32.1, SIMULATED CHAIN] The official TypeScript SDK's client
// connects over Streamable HTTP and does its own OAuth: the 401 and WWW-Authenticate, protected resource and
// authorization server discovery, dynamic client registration, PKCE S256 with the resource indicator, the code
// exchange. The owner's consent (the wallet's signatures) is driven in redirectToAuthorization, as a browser
// would. Then it lists the tools and plays the read path. This is a local client, not ChatGPT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';
import { PATCHED, server, world } from './fixture.mjs';

function provider({ s, w, scopes }) {
  let info, tokens, verifier, code = null;
  const redirect = 'http://127.0.0.1:9/callback';
  return {
    get redirectUrl() { return redirect; },
    get clientMetadata() { return { client_name: 'sdk test client', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: scopes.join(' ') }; },
    clientInformation: () => info,
    saveClientInformation: i => { info = i; },
    tokens: () => tokens,
    saveTokens: t => { tokens = t; },
    saveCodeVerifier: v => { verifier = v; },
    codeVerifier: () => verifier,
    async redirectToAuthorization(url) {
      // The browser: the consent page, the wallet's signatures, the redirect back with the code.
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('resource'), `${s.issuer}/mcp`, 'the SDK sends the resource indicator');
      const html = await (await fetch(url)).text();
      const reqId = /const reqId="([^"]+)"/.exec(html)[1];
      const post = async (p, b) => (await fetch(`${s.issuer}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
      const exp = s.clock.t + 3_600_000;
      const st = await post('/oauth/statement', { reqId, owner: w.o, agentId: w.agent.agentId, scopes, expiresAt: exp,
        grant: scopes.includes('wylls.caravan') ? { actions: ['SendCaravan'], maxSends: 2, maxCargo: Array(8).fill(500), expiresAt: exp } : undefined });
      const sign = b64 => Buffer.from(signTalk(Buffer.from(b64, 'base64'), w.owner)).toString('base64');
      const done = await post('/oauth/consent', { ...st.request, signature: sign(st.statementB64), ...(st.rotate ? { rotate: { command: st.rotate.command, signature: sign(st.rotate.bytesB64) } } : {}) });
      code = new URL(done.redirect).searchParams.get('code');
    },
    get code() { return code; },
  };
}

test('the official MCP SDK client: OAuth discovery, DCR, PKCE, then tools/list and the read path', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const auth = provider({ s, w, scopes: ['wylls.read', 'wylls.caravan'] });
    const url = new URL(`${s.issuer}/mcp`);
    let transport = new StreamableHTTPClientTransport(url, { authProvider: auth });
    const client = new Client({ name: 'sdk-test', version: '0.0.1' });
    await assert.rejects(client.connect(transport), e => e instanceof UnauthorizedError, 'first contact: 401 → the SDK starts OAuth');
    assert.ok(auth.code, 'the consent returned a code');
    await transport.finishAuth(auth.code);
    transport = new StreamableHTTPClientTransport(url, { authProvider: auth });
    const c2 = new Client({ name: 'sdk-test', version: '0.0.1' });
    await c2.connect(transport);
    assert.equal(c2.getServerVersion().name, 'wylls-mcp');
    const { tools } = await c2.listTools();
    assert.equal(tools.length, 7);
    assert.equal(tools.find(t => t.name === 'send_caravan').annotations.destructiveHint, true);
    const status = await c2.callTool({ name: 'get_village_status', arguments: {} });
    assert.equal(status.isError, false);
    assert.equal(status.structuredContent.owner, w.o);
    const sf = await c2.callTool({ name: 'check_resource_shortfall', arguments: { goal: { kind: 'vault' } } });
    assert.equal(sf.structuredContent.rows.find(r => r.resource === 'Stone').short, 150);
    const plan = await c2.callTool({ name: 'prepare_caravan', arguments: { from: status.structuredContent.storehouses[0].placeId, to: status.structuredContent.village.placeId, cargo: { Stone: 150 } } });
    assert.ok(plan.structuredContent.planId);
    if (PATCHED) {
      const sent = await c2.callTool({ name: 'send_caravan', arguments: { planId: plan.structuredContent.planId, requestId: 'sdk-req-0001' } });
      assert.equal(sent.structuredContent.state, 'accepted', JSON.stringify(sent.structuredContent));
      const op = await c2.callTool({ name: 'get_operation_status', arguments: { operationId: sent.structuredContent.operationId } });
      assert.equal(op.structuredContent.state, 'processing');
    }
    // An argument the schema does not allow is the server's to refuse, not to guess at.
    const odd = await c2.callTool({ name: 'prepare_caravan', arguments: { from: 'village:9,9,9', to: status.structuredContent.village.placeId, cargo: { Stone: 1 } } });
    assert.equal(odd.structuredContent.error.code, 'NotYourPlace');
    await c2.close();
  } finally { await s.close(); }
});
