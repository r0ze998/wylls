// (2026-11-20, ③ public exposure) The settings of the PUBLIC read-only server (bin/wylls-mcp-public.mjs), checked
// before anything is opened. Pure: no I/O; an error names the setting and the rule, never its value.
//
// Its own names (WYLLS_MCP_PUBLIC_*), so that it can run beside the owner server from one shell. The exposure rules
// are the owner server's (bin/mcp-settings.mjs, reused): loopback bind unless WYLLS_MCP_PUBLIC_ALLOW_REMOTE_BIND=1, a
// Host allow-list of loopback + the public origin's host + WYLLS_MCP_PUBLIC_ALLOWED_HOSTS.
//
//   WYLLS_MCP_PUBLIC_PORT=41961               listen port (default 41961)
//   WYLLS_MCP_PUBLIC_HOST=127.0.0.1           listen host (loopback only unless WYLLS_MCP_PUBLIC_ALLOW_REMOTE_BIND=1)
//   WYLLS_MCP_PUBLIC_ORIGIN=https://…         the public origin clients use (default http://127.0.0.1:<port>)
//   WYLLS_MCP_PUBLIC_ALLOWED_HOSTS=a,b        extra Host names (a reverse proxy that sends an internal name)
//   WYLLS_MCP_PUBLIC_HERALD=http://…          the public herald (required)
//   WYLLS_MCP_PUBLIC_KEYS=<file>              the API key file (bin/wylls-mcp-key.mjs; 0600). Without it no key works
//   WYLLS_MCP_PUBLIC_ANONYMOUS=1              also accept callers with no key (per address; stricter limits). Off
//   WYLLS_MCP_PUBLIC_RATE=30/1                per key: burst / seconds per call      WYLLS_MCP_PUBLIC_PER_DAY=5000
//   WYLLS_MCP_PUBLIC_ANON_RATE=10/3           per anonymous address                  WYLLS_MCP_PUBLIC_ANON_PER_DAY=500
//   WYLLS_MCP_PUBLIC_GLOBAL_RATE=200/0.02     the whole server (protects the herald)
//   WYLLS_MCP_PUBLIC_AUDIT=<file>             the audit log (JSON lines, 0600). Off when unset
//   WYLLS_MCP_PUBLIC_AUDIT_IP=hash|off        client addresses as salted hashes (default) or not at all
//   WYLLS_MCP_PUBLIC_AUDIT_SALT=<text>        a fixed salt (hashes link across restarts); default random per process
//   WYLLS_MCP_PUBLIC_TRUST_PROXY=1            the client address is the right-most X-Forwarded-For entry. Off
//   WYLLS_MCP_PUBLIC_ORIGINS=https://a,…      browser Origins not refused 403 besides the public origin (no CORS headers are sent: PUBLIC-EXPOSURE §5)
import { mcpSettings } from './mcp-settings.mjs';
import { parseRate } from '../src/rate-limit.mjs';
import { PUBLIC_DEFAULTS } from '../src/public-mcp.mjs';

export const PUBLIC_PORT_DEFAULT = 41961;

export function publicSettings(env = {}) {
  const given = k => env[k] !== undefined && env[k] !== '';
  const map = { WYLLS_MCP_PUBLIC_PORT: 'WYLLS_MCP_PORT', WYLLS_MCP_PUBLIC_HOST: 'WYLLS_MCP_HOST', WYLLS_MCP_PUBLIC_ORIGIN: 'WYLLS_MCP_ISSUER',
    WYLLS_MCP_PUBLIC_ALLOWED_HOSTS: 'WYLLS_MCP_ALLOWED_HOSTS', WYLLS_MCP_PUBLIC_ALLOW_REMOTE_BIND: 'WYLLS_MCP_ALLOW_REMOTE_BIND', WYLLS_MCP_PUBLIC_HERALD: 'WYLLS_MCP_HERALD' };
  const inner = { WYLLS_MCP_PORT: String(PUBLIC_PORT_DEFAULT) };
  for (const [k, v] of Object.entries(map)) if (given(k)) inner[v] = env[k];
  const s = mcpSettings(inner);
  // the owner server's messages name its own settings: say ours
  if (s.error?.startsWith('WYLLS_MCP_HOST: a loopback host')) return { error: 'WYLLS_MCP_PUBLIC_HOST: a loopback host (127.0.0.1, localhost, ::1); behind a reverse proxy or tunnel keep it on loopback; to listen elsewhere set WYLLS_MCP_PUBLIC_ALLOW_REMOTE_BIND=1 (an owner decision for a public season)' };
  if (s.error) return { error: Object.entries(map).reduce((m, [ours, theirs]) => m.replaceAll(theirs, ours), s.error) };
  if (!given('WYLLS_MCP_PUBLIC_HERALD')) return { error: 'WYLLS_MCP_PUBLIC_HERALD: the public herald\'s http or https URL is required' };
  const out = { port: s.port, host: s.host, origin: s.issuer, endpoint: `${s.issuer}/public/mcp`, remoteBind: s.remoteBind, allowedHosts: s.allowedHosts, herald: s.herald, limits: {} };
  for (const [k, name] of [['keyRate', 'WYLLS_MCP_PUBLIC_RATE'], ['anonRate', 'WYLLS_MCP_PUBLIC_ANON_RATE'], ['globalRate', 'WYLLS_MCP_PUBLIC_GLOBAL_RATE']]) {
    if (!given(name)) { out.limits[k] = PUBLIC_DEFAULTS[k]; continue; }
    const r = parseRate(env[name]);
    if (!r) return { error: `${name}: burst/seconds, e.g. 30/1` };
    out.limits[k] = r;
  }
  for (const [k, name] of [['keyPerDay', 'WYLLS_MCP_PUBLIC_PER_DAY'], ['anonPerDay', 'WYLLS_MCP_PUBLIC_ANON_PER_DAY']]) {
    if (!given(name)) { out.limits[k] = PUBLIC_DEFAULTS[k]; continue; }
    if (!/^\d{1,9}$/.test(String(env[name])) || Number(env[name]) < 1) return { error: `${name}: a whole number ≥ 1` };
    out.limits[k] = Number(env[name]);
  }
  const flag = name => {
    if (!given(name)) return false;
    if (env[name] !== '1') return null;
    return true;
  };
  for (const [k, name] of [['anonymous', 'WYLLS_MCP_PUBLIC_ANONYMOUS'], ['trustProxy', 'WYLLS_MCP_PUBLIC_TRUST_PROXY']]) {
    const f = flag(name);
    if (f === null) return { error: `${name}: 1 or unset` };
    out[k] = f;
  }
  out.keys = given('WYLLS_MCP_PUBLIC_KEYS') ? String(env.WYLLS_MCP_PUBLIC_KEYS) : null;
  if (!out.keys && !out.anonymous) return { error: 'WYLLS_MCP_PUBLIC_KEYS: a key file is required unless WYLLS_MCP_PUBLIC_ANONYMOUS=1 (nobody could call the server)' };
  out.audit = given('WYLLS_MCP_PUBLIC_AUDIT') ? String(env.WYLLS_MCP_PUBLIC_AUDIT) : null;
  out.auditIp = given('WYLLS_MCP_PUBLIC_AUDIT_IP') ? String(env.WYLLS_MCP_PUBLIC_AUDIT_IP) : 'hash';
  if (!['hash', 'off'].includes(out.auditIp)) return { error: 'WYLLS_MCP_PUBLIC_AUDIT_IP: hash or off' };
  out.auditSalt = given('WYLLS_MCP_PUBLIC_AUDIT_SALT') ? String(env.WYLLS_MCP_PUBLIC_AUDIT_SALT) : null;
  out.origins = given('WYLLS_MCP_PUBLIC_ORIGINS') ? String(env.WYLLS_MCP_PUBLIC_ORIGINS).split(',').map(x => x.trim()).filter(Boolean) : [];
  for (const o of out.origins) {
    let u = null;
    try { u = new URL(o); } catch { /* refused below */ }
    if (!u || !['http:', 'https:'].includes(u.protocol) || u.origin !== o) return { error: 'WYLLS_MCP_PUBLIC_ORIGINS: comma-separated origins (scheme://host[:port], no path)' };
  }
  return out;
}
