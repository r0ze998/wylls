// The launcher's own address settings for bin/wylls-mcp.mjs, checked before anything is opened (2026-11-17; written
// under an execution pause, NOT run). Pure: no I/O; an error names the setting and the rule, never its value (a URL
// may carry credentials). An empty setting is the default, as an unset one (before, WYLLS_MCP_PORT='' was port 0 and
// WYLLS_MCP_ISSUER='' an empty issuer).
//
// Why: a client connects only to the exact resource this server names, `${issuer}/mcp` (auth.mjs `resource`; Claude
// Code and ChatGPT both compare it with the URL they were given, preflight.mjs checks it), and the discovery
// documents are served at the root only (http.mjs `GET /.well-known/…`). Before, the launcher took the settings as
// written: WYLLS_MCP_PORT=abc listened on NaN, WYLLS_MCP_PORT=0 on a random port while the default issuer still said
// `:0`, and an issuer with a trailing slash or a path named `…//mcp` or `…/x/mcp` — a resource no client can match,
// found only at sign-in. Now such a setting stops the launcher with one line saying which one.
//
// What it does not do: it decides no host, scheme or exposure policy (http on loopback and https behind a tunnel are
// both accepted, as before; whether a client accepts the scheme is preflight's and the client's), and it reads nothing
// from the network.

export const MCP_DEFAULTS = Object.freeze({ port: 41960, host: '127.0.0.1', relay: 'http://127.0.0.1:41933', herald: 'http://127.0.0.1:41940' });

/** A URL a setting may name, or null: http(s), no user or password, no query, no fragment. */
function httpUrl(text) {
  const t = String(text);
  // checked on the text too: URL drops a bare '?' or '#' and surrounding spaces, which would then stay in the setting
  if (t !== t.trim() || /[?#]/.test(t)) return null;
  let u;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{error: string} | {port: number, host: string, issuer: string, resource: string, relay: string, herald: string}}
 */
export function mcpSettings(env = {}) {
  const given = k => env[k] !== undefined && env[k] !== '';
  let port = MCP_DEFAULTS.port;
  if (given('WYLLS_MCP_PORT')) {
    const p = String(env.WYLLS_MCP_PORT);
    port = /^\d{1,5}$/.test(p) ? Number(p) : NaN;
    if (!(port >= 1 && port <= 65535)) return { error: 'WYLLS_MCP_PORT: a port number from 1 to 65535 (the issuer and the resource name it)' };
  }
  const host = given('WYLLS_MCP_HOST') ? String(env.WYLLS_MCP_HOST) : MCP_DEFAULTS.host;
  let issuer = `http://127.0.0.1:${port}`;
  if (given('WYLLS_MCP_ISSUER')) {
    const u = httpUrl(env.WYLLS_MCP_ISSUER);
    if (!u) return { error: 'WYLLS_MCP_ISSUER: an http or https origin, with no user, password, query or fragment' };
    if (u.pathname !== '/') return { error: 'WYLLS_MCP_ISSUER: an origin only (scheme, host and port), with no path: the resource is <issuer>/mcp and the discovery documents are at the root' };
    // as written, less one trailing slash (not u.origin, which drops a port written as the scheme's default)
    issuer = String(env.WYLLS_MCP_ISSUER).replace(/\/$/, '');
  }
  const out = { port, host, issuer, resource: `${issuer}/mcp` };
  for (const [k, name] of [['relay', 'WYLLS_MCP_RELAY'], ['herald', 'WYLLS_MCP_HERALD']]) {
    if (!given(name)) { out[k] = MCP_DEFAULTS[k]; continue; }
    if (!httpUrl(env[name])) return { error: `${name}: an http or https URL, with no user, password, query or fragment` };
    out[k] = String(env[name]);
  }
  return out;
}

/**
 * The start-up line naming the one URL a client is given (the resource, exactly). On a loopback http issuer it also
 * names the preflight for Claude Code (bin/wylls-mcp-preflight.mjs: loopback only by default); elsewhere it names
 * none (a remote check is for an approved deployment only, never suggested here).
 */
export function connectLine(resource) {
  const u = httpUrl(resource);
  const loopback = u && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  return loopback
    ? `connect a client to ${resource} (Claude Code: claude mcp add --transport http <name> ${resource}; check first: node bin/wylls-mcp-preflight.mjs ${resource} claude-code)`
    : `connect a client to ${resource}`;
}
