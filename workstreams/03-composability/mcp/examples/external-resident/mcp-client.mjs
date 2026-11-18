// The resident's MCP connection: the official MCP TypeScript SDK client (Streamable HTTP + its own OAuth: discovery,
// dynamic client registration, PKCE S256, the resource indicator), with the consent signed by the resident's OWN key —
// it is the owner of the link, and the link names itself as its agent (agentId = owner). Read scope only.
// (As the SDK's examples/oauth/simpleOAuthClient.ts, with the browser step replaced by the wallet's own signature.)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

export const READ_SCOPE = 'wylls.read';

function selfConsentProvider({ issuer, key, scopes = [READ_SCOPE], linkMs = 3_600_000 }) {
  let info, tokens, verifier, code = null;
  const redirect = 'http://127.0.0.1:9/callback';   // (never opened: the code is read off the consent's answer)
  const post = async (p, b) => { const r = await fetch(`${issuer}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); const j = await r.json(); if (!r.ok && !j.redirect) throw new Error(j.error_description ?? j.error ?? `HTTP ${r.status}`); return j; };
  return {
    get redirectUrl() { return redirect; },
    get clientMetadata() { return { client_name: 'wylls external resident (reference)', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: scopes.join(' ') }; },
    clientInformation: () => info, saveClientInformation: i => { info = i; },
    tokens: () => tokens, saveTokens: t => { tokens = t; },
    saveCodeVerifier: v => { verifier = v; }, codeVerifier: () => verifier,
    async redirectToAuthorization(url) {
      const html = await (await fetch(url)).text();
      const reqId = /const reqId="([^"]+)"/.exec(html)?.[1];
      if (!reqId) throw new Error(`the authorization server gave no consent page (${html.slice(0, 120)})`);
      const st = await post('/oauth/statement', { reqId, owner: key.address, agentId: key.address, scopes, expiresAt: Date.now() + linkMs });
      if (st.rotate) throw new Error('the server asks for a capability: a read-only connection never gives one');
      const signature = Buffer.from(key.signMessage(Buffer.from(st.statementB64, 'base64'))).toString('base64');
      const done = await post('/oauth/consent', { ...st.request, signature });
      code = new URL(done.redirect).searchParams.get('code');
      if (!code) throw new Error(`consent refused: ${new URL(done.redirect).searchParams.get('error_description') ?? 'no code'}`);
    },
    get code() { return code; },
  };
}

/** Connect (OAuth on first contact) → `{client, tools, call(name, args), close()}`. */
export async function connectMcp(mcpUrl, key, opts = {}) {
  const url = new URL(mcpUrl), issuer = url.origin;
  const auth = selfConsentProvider({ issuer, key, ...opts });
  let transport = new StreamableHTTPClientTransport(url, { authProvider: auth });
  let client = new Client({ name: 'wylls-external-resident', version: '0.1.0' });
  try { await client.connect(transport); } catch (e) {
    if (!(e instanceof UnauthorizedError) || !auth.code) throw e;
    await transport.finishAuth(auth.code);
    transport = new StreamableHTTPClientTransport(url, { authProvider: auth });
    client = new Client({ name: 'wylls-external-resident', version: '0.1.0' });
    await client.connect(transport);
  }
  const { tools } = await client.listTools();
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: !!r.isError, value: r.structuredContent ?? null }; };
  return { client, tools, call, instructions: client.getInstructions?.() ?? null, close: () => client.close() };
}
