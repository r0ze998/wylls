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
// What it does not do: it decides no scheme policy (http on loopback and https behind a tunnel are both accepted, as
// before; whether a client accepts the scheme is preflight's and the client's), and it reads nothing from the network.
//
// Exposure (2026-11-18): the listen host is loopback (127.0.0.1, localhost, ::1) unless WYLLS_MCP_ALLOW_REMOTE_BIND=1.
// The only authorization server here is the local TEST one (auth.mjs), and with an http issuer its tokens and codes
// travel in plaintext; a tunnel (https issuer) still connects to 127.0.0.1, so it needs no opt-in. And the Host header
// is checked (DNS rebinding, as the MCP SDK's createMcpExpressApp does for a localhost server): `allowedHosts` is the
// loopback names, the issuer's host name and WYLLS_MCP_ALLOWED_HOSTS (comma-separated host names, for a proxy that
// sends another Host); http.mjs refuses any other Host with 403 before anything is read.

export const MCP_DEFAULTS = Object.freeze({ port: 41960, host: '127.0.0.1', relay: 'http://127.0.0.1:41933', herald: 'http://127.0.0.1:41940' });
/** Listen hosts that are this machine only. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** Host header names always accepted (URL hostname form: IPv6 in brackets). */
export const LOOPBACK_NAMES = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
const HOST_NAME = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

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
  const remoteBind = !LOOPBACK_HOSTS.has(host);
  if (given('WYLLS_MCP_ALLOW_REMOTE_BIND') && env.WYLLS_MCP_ALLOW_REMOTE_BIND !== '1') return { error: 'WYLLS_MCP_ALLOW_REMOTE_BIND: 1 (listen on a host other than loopback) or unset' };
  if (remoteBind && env.WYLLS_MCP_ALLOW_REMOTE_BIND !== '1') return { error: 'WYLLS_MCP_HOST: a loopback host (127.0.0.1, localhost, ::1); this server has only the local test authorization server. Behind a tunnel keep it on loopback; to listen elsewhere set WYLLS_MCP_ALLOW_REMOTE_BIND=1' };
  let issuer = `http://127.0.0.1:${port}`;
  if (given('WYLLS_MCP_ISSUER')) {
    const u = httpUrl(env.WYLLS_MCP_ISSUER);
    if (!u) return { error: 'WYLLS_MCP_ISSUER: an http or https origin, with no user, password, query or fragment' };
    if (u.pathname !== '/') return { error: 'WYLLS_MCP_ISSUER: an origin only (scheme, host and port), with no path: the resource is <issuer>/mcp and the discovery documents are at the root' };
    // as written, less one trailing slash (not u.origin, which drops a port written as the scheme's default)
    issuer = String(env.WYLLS_MCP_ISSUER).replace(/\/$/, '');
  }
  const extra = given('WYLLS_MCP_ALLOWED_HOSTS') ? String(env.WYLLS_MCP_ALLOWED_HOSTS).split(',').map(x => x.trim()).filter(Boolean) : [];
  if (extra.some(h => !HOST_NAME.test(h))) return { error: 'WYLLS_MCP_ALLOWED_HOSTS: comma-separated host names (no scheme, port or path; IPv6 in brackets)' };
  const issuerHost = new URL(issuer).hostname;
  const allowedHosts = [...new Set([...LOOPBACK_NAMES, issuerHost.toLowerCase(), ...extra.map(h => h.toLowerCase())])];
  const out = { port, host, issuer, resource: `${issuer}/mcp`, remoteBind, allowedHosts };
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
