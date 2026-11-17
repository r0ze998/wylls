// Before a client is connected for real: checks a running server against what that client's official docs
// require (docs 11 §1, read 2026-10-30). It answers "would the discovery and registration steps this client does
// work here", not "does the client work": the client itself is never run.
//
//   claude-code  Claude Code (code.claude.com/docs/en/mcp; claude.com/docs/connectors/building/authentication)
//   claude       the hosted Claude apps: web, Desktop, mobile (same pages; support.claude.com 11175166)
//   chatgpt      ChatGPT (developers.openai.com/plugins/build/auth)
//
// It registers one OAuth client (DCR) per redirect it checks, so by default it runs only against a loopback
// server (this machine): `allowRemote` is for an approved deployment, never a default.
//
// (2026-11-17) "Loopback only" holds for EVERY request, not only the first. The server under test names the next
// URLs itself (WWW-Authenticate resource_metadata, the authorization server, its registration and token endpoints),
// and fetch follows redirects by default. So each request's URL is checked before it is made (http or https, no
// credentials in it, and on this machine unless allowRemote), every request is sent with `redirect: 'manual'`, and a
// redirect answer stops the preflight. A refusal is a failed check, and nothing after it is requested.

const CLIENTS = Object.freeze({
  'claude-code': { redirects: ['http://localhost:3118/callback', 'http://127.0.0.1:3118/callback'], needsHttps: false, iss: false },
  claude: { redirects: ['https://claude.ai/api/mcp/auth_callback'], needsHttps: true, iss: false },
  chatgpt: { redirects: ['https://chatgpt.com/connector_platform_oauth_redirect'], needsHttps: true, iss: true },
});
export const PREFLIGHT_CLIENTS = Object.freeze(Object.keys(CLIENTS));

const isLoopbackHost = h => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);

/**
 * `url` is the MCP endpoint exactly as it would be entered in the client. Returns
 * `{client, url, ok, checks: [{name, ok, detail}], unverified: [..]}`; `ok` is every check passing.
 */
export async function preflight(url, { client = 'claude-code', fetch: f = fetch, allowRemote = false } = {}) {
  const want = CLIENTS[client];
  if (!want) throw new Error(`client: one of ${PREFLIGHT_CLIENTS.join(', ')}`);
  const u = new URL(url);
  if (!allowRemote && !isLoopbackHost(u.hostname)) throw new Error('preflight runs against a server on this machine only (it registers OAuth clients); allowRemote is for an approved deployment');
  const checks = [];
  // (2026-11-17) A detail may quote what the server under test sent (its resource, its issuers, an error text). Only
  // text is ever shown, with the user:password part of any URL in it removed (up to the LAST "@" before the path, as
  // URL parsing reads it; with or without "//"); a value that is not text is shown by its type alone, and nothing
  // inside it is read. So a credential the server names never comes back in the result. A missing detail stays
  // absent. The `url` field stays the URL exactly as the caller entered it.
  const shown = d => (typeof d === 'string'
    ? d.replace(/([A-Za-z][A-Za-z0-9+.-]*:[\/\\]*)[^\s\/\\?#"<>]*@/g, '$1[credentials removed]@')
    : `(not text: ${Array.isArray(d) ? 'array' : typeof d})`);
  const check = (name, ok, detail = null) => { checks.push({ name, ok: Boolean(ok), ...(detail !== null && detail !== undefined ? { detail: shown(detail) } : {}) }); return Boolean(ok); };
  /** A value for a detail written as text: itself if it is text, else its type (never String() of an object). */
  const textOf = v => (typeof v === 'string' ? v : v === undefined ? 'undefined' : v === null ? 'null' : `(not text: ${Array.isArray(v) ? 'array' : typeof v})`);
  const json = async (res) => { try { return await res.json(); } catch { return null; } };
  const stop = () => ({ client, url, ok: false, checks, unverified: [] });
  /** One request, only to a URL that keeps the contract above; null (with a failed check) when refused. */
  const reach = async (step, target, init = {}) => {
    let t;
    try { t = new URL(target); } catch { check(`${step}: a URL`, false, 'not a URL: nothing requested'); return null; }
    if (t.protocol !== 'http:' && t.protocol !== 'https:') { check(`${step}: http or https`, false, `${t.protocol} refused: nothing requested`); return null; }
    if (t.username || t.password) { check(`${step}: no credentials in the URL`, false, 'refused: nothing requested'); return null; }
    if (!allowRemote && !isLoopbackHost(t.hostname)) { check(`${step}: on this machine`, false, `${t.hostname} is not this machine: nothing requested (allowRemote is off)`); return null; }
    const res = await f(String(target), { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) { check(`${step}: no redirect`, false, `status ${res.status}: redirects are not followed`); return null; }
    return res;
  };

  // Transport: hosted clients reach the server from their cloud over public HTTPS; Claude Code runs here.
  check('scheme', want.needsHttps ? u.protocol === 'https:' : (u.protocol === 'https:' || isLoopbackHost(u.hostname)),
    want.needsHttps ? 'this client needs a public https URL (a loopback URL cannot be reached from its cloud)' : 'https, or http on this machine');

  // 1. An unauthenticated call is a 401 pointing at the protected resource metadata (a 200 is ignored by Claude).
  const r401 = await reach('MCP endpoint', url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'wylls-preflight', version: '0' } } }) });
  if (!r401) return stop();
  const www = r401.headers.get('www-authenticate') ?? '';
  const prmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1] ?? null;
  check('401 with resource_metadata', r401.status === 401 && prmUrl, `status ${r401.status}`);
  if (!prmUrl) return { client, url, ok: false, checks, unverified: [] };

  // 2. The protected resource names this URL exactly, and its first authorization server.
  const prmRes = await reach('protected resource metadata', prmUrl);
  if (!prmRes) return stop();
  const prm = await json(prmRes);
  check('resource equals the URL as entered', prm?.resource === url, `resource ${textOf(prm?.resource)}`);
  const issuer = prm?.authorization_servers?.[0] ?? null;
  check('an authorization server (the first is used)', issuer, issuer);
  if (!issuer) return { client, url, ok: false, checks, unverified: [] };

  // 3. Authorization server metadata.
  if (typeof issuer !== 'string') { check('authorization server is a URL string', false); return stop(); }
  const asmRes = await reach('authorization server metadata', `${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`);
  if (!asmRes) return stop();
  const asm = await json(asmRes);
  check('issuer matches', asm?.issuer === issuer, asm?.issuer);
  check('PKCE S256 advertised', asm?.code_challenge_methods_supported?.includes('S256'));
  check('DCR (registration_endpoint)', typeof asm?.registration_endpoint === 'string');
  check('public clients (token_endpoint_auth_method none)', asm?.token_endpoint_auth_methods_supported?.includes('none'));
  if (want.iss) check('iss in authorization responses (RFC 9207, for the stable redirect)', asm?.authorization_response_iss_parameter_supported === true);
  const cimd = asm?.client_id_metadata_document_supported === true;

  // 4. Registration with this client's redirect URIs.
  for (const redirect of want.redirects) {
    const reg = await reach('registration endpoint', asm?.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: `wylls-preflight (${client})`, token_endpoint_auth_method: 'none' }) });
    if (!reg) return stop();
    const body = await json(reg);
    check(`registers with redirect ${redirect}`, reg.status === 201 && body?.client_id, reg.status === 201 ? null : body?.error_description ?? `status ${reg.status}`);
  }
  // The token endpoint takes form bodies (RFC 6749): a bad grant must come back as an OAuth error, not 415.
  const tok = await reach('token endpoint', asm?.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'preflight-not-a-token' }).toString() });
  if (!tok) return stop();
  const tb = await json(tok);
  check('token endpoint: form body, invalid_grant for a bad refresh token', tok.status === 400 && tb?.error === 'invalid_grant', `status ${tok.status} ${tb?.error === undefined || tb?.error === null ? '' : textOf(tb.error)}`);

  const unverified = [
    'the client itself was not run: its screens, its consent prompt for write tools, and how its model picks tools are not checked',
    ...(cimd ? [] : ['CIMD is not advertised: the client falls back to DCR (both docs allow it)']),
    ...(client === 'claude-code' ? ['whether Claude Code accepts an http (not https) MCP URL on this machine: its docs allow http only for the token endpoint on loopback, and say nothing of the MCP URL'] : []),
    ...(client === 'chatgpt' ? ['which ChatGPT plans and roles can add a custom MCP server (help.openai.com could not be read)'] : []),
  ];
  return { client, url, ok: checks.every(c => c.ok), checks, unverified };
}
