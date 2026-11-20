#!/usr/bin/env node
// (2026-11-20, ③ public exposure) Starts the PUBLIC read-only MCP server: `POST /public/mcp`, the public herald's
// world data only (src/public-tools.mjs). No authorization server, no store, no relay, no capability, no write tool.
// Loopback only unless WYLLS_MCP_PUBLIC_ALLOW_REMOTE_BIND=1. Settings: bin/public-settings.mjs. Keys:
// bin/wylls-mcp-key.mjs. Policy: PUBLIC-EXPOSURE.md.
import { publicSettings } from './public-settings.mjs';
import { KeyRing, KeyFileError } from '../src/api-keys.mjs';
import { PublicReader } from '../src/public-tools.mjs';
import { createPublicMcp, createPublicHandler } from '../src/public-mcp.mjs';
import { createAudit } from '../src/audit.mjs';
import { listen } from '../src/listen.mjs';

const s = publicSettings(process.env);
if (s.error) { console.error(s.error); process.exit(2); }
const log = m => process.stderr.write(`[wylls-mcp-public] ${m}\n`);
let keys = null;
if (s.keys) {
  try { keys = new KeyRing({ file: s.keys, log }); } catch (e) { console.error(e instanceof KeyFileError ? `WYLLS_MCP_PUBLIC_KEYS: ${e.message}` : 'WYLLS_MCP_PUBLIC_KEYS: the key file could not be read'); process.exit(2); }
}
let audit = null;
try { audit = createAudit({ file: s.audit, ip: s.auditIp, salt: s.auditSalt, server: 'public' }); } catch { console.error('WYLLS_MCP_PUBLIC_AUDIT: the audit log could not be set up'); process.exit(2); }
const reader = new PublicReader({ base: s.herald });
const mcp = createPublicMcp({ reader, log });
const handler = createPublicHandler({ mcp, keys, anonymous: s.anonymous, allowedHosts: s.allowedHosts, origin: s.origin, origins: s.origins, limits: s.limits, audit, trustProxy: s.trustProxy, log });
log(`keys: ${keys ? `${keys.size} loaded` : 'none'}; anonymous: ${s.anonymous ? 'on' : 'off'}; audit: ${audit ? 'on' : 'off'}; trust proxy: ${s.trustProxy ? 'on' : 'off'}`);
log(`tools: ${mcp.tools.join(', ')}`);
if (s.remoteBind) log(`warning: listening on ${s.host}, not loopback (WYLLS_MCP_PUBLIC_ALLOW_REMOTE_BIND=1)${s.origin.startsWith('http:') ? '; the origin is http, so keys cross the network in plaintext' : ''}`);
const srv = await listen(handler, { port: s.port, host: s.host });
log(`listening on http://${s.host}:${s.port}/public/mcp (public endpoint ${s.endpoint})`);
const stop = () => srv.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
