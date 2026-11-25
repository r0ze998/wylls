// The read-only local-play MCP server's settings (bin/wylls-mcp-local-play.mjs), checked before anything is opened. Pure.
import { mcpSettings } from './mcp-settings.mjs';

/** The read-only settings, or `{error}`: bin/wylls-mcp.mjs's own checks, then the local-play rules. Pure. */
export function localPlaySettings(env = {}) {
  if (env.WYLLS_MCP_TEST_AS !== '1') return { error: 'set WYLLS_MCP_TEST_AS=1: only the local test authorization server is implemented' };
  for (const k of ['WYLLS_MCP_WS04_ACTS', 'WYLLS_MCP_WS04_RUNEXEC', 'WYLLS_MCP_WS04_DB', 'WYLLS_MCP_ALLOW_GLOBAL_ROTATE', 'WYLLS_MCP_ALLOW_REMOTE_BIND']) if (env[k] !== undefined && env[k] !== '') return { error: `${k}: not taken by the read-only local-play server` };
  if (env.WYLLS_MCP_STORE && !env.WYLLS_MCP_SEAL_KEY) return { error: 'WYLLS_MCP_SEAL_KEY is required with a store file' };
  if (!env.WYLLS_MCP_HERALD || !env.WYLLS_MCP_RELAY) return { error: 'WYLLS_MCP_HERALD and WYLLS_MCP_RELAY: the local-play world proxy, and its /gw' };
  const s = mcpSettings(env);
  if (s.error) return s;
  const loop = u => { try { const x = new URL(u); return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname); } catch { return false; } };
  if (!loop(s.herald) || !loop(s.relay)) return { error: 'WYLLS_MCP_HERALD / WYLLS_MCP_RELAY: loopback http only (a local TEST world)' };
  if (!/\/gw$/.test(s.relay)) return { error: 'WYLLS_MCP_RELAY: the world proxy\'s /gw (e.g. http://localhost:41412/gw)' };
  // (ws13-territory) WYLLS_MCP_PAGE_ORIGIN: the launcher page's origin. With it get_territory_status is offered: its one
  // extra read is the page's own read-only account read on the world's relay, which the world proxy takes only from that origin.
  let pageOrigin = null;
  if (env.WYLLS_MCP_PAGE_ORIGIN !== undefined && env.WYLLS_MCP_PAGE_ORIGIN !== '') {
    let u = null; try { u = new URL(env.WYLLS_MCP_PAGE_ORIGIN); } catch { u = null; }
    if (!u || !loop(env.WYLLS_MCP_PAGE_ORIGIN) || u.origin !== env.WYLLS_MCP_PAGE_ORIGIN) return { error: 'WYLLS_MCP_PAGE_ORIGIN: the launcher page\'s loopback origin, nothing after the port (e.g. http://localhost:41920)' };
    pageOrigin = u.origin;
  }
  return { ...s, pageOrigin };
}

