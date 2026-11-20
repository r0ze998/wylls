// (2026-11-20, ③ public exposure) The owner server's (bin/wylls-mcp.mjs) opt-in exposure settings, all OFF when unset
// (the server is then exactly as before). Pure: no I/O; an error names the setting, never its value.
//
//   WYLLS_MCP_AUDIT=<file>          the audit log (JSON lines, 0600; src/audit.mjs: who, tool, outcome — no secret, no
//                                  argument, no wallet, no raw address)
//   WYLLS_MCP_AUDIT_IP=hash|off     client addresses as salted hashes (default) or not at all
//   WYLLS_MCP_AUDIT_SALT=<text>     a fixed salt (hashes link across restarts); default random per process
//   WYLLS_MCP_TRUST_PROXY=1         the client address (per-address limits, audit) is the right-most X-Forwarded-For entry
//   WYLLS_MCP_LINK_PER_DAY=<n>      tools/call per owner link per UTC day (on top of the 30-then-1/s burst limit)
export function ownerExposureSettings(env = {}) {
  const given = k => env[k] !== undefined && env[k] !== '';
  const out = { audit: null, auditIp: 'hash', auditSalt: null, trustProxy: false, linkPerDay: null };
  if (given('WYLLS_MCP_AUDIT')) out.audit = String(env.WYLLS_MCP_AUDIT);
  if (given('WYLLS_MCP_AUDIT_IP')) {
    if (!['hash', 'off'].includes(env.WYLLS_MCP_AUDIT_IP)) return { error: 'WYLLS_MCP_AUDIT_IP: hash or off' };
    out.auditIp = env.WYLLS_MCP_AUDIT_IP;
  }
  if (given('WYLLS_MCP_AUDIT_SALT')) out.auditSalt = String(env.WYLLS_MCP_AUDIT_SALT);
  if (given('WYLLS_MCP_TRUST_PROXY')) {
    if (env.WYLLS_MCP_TRUST_PROXY !== '1') return { error: 'WYLLS_MCP_TRUST_PROXY: 1 or unset' };
    out.trustProxy = true;
  }
  if (given('WYLLS_MCP_LINK_PER_DAY')) {
    if (!/^\d{1,9}$/.test(String(env.WYLLS_MCP_LINK_PER_DAY)) || Number(env.WYLLS_MCP_LINK_PER_DAY) < 1) return { error: 'WYLLS_MCP_LINK_PER_DAY: a whole number ≥ 1' };
    out.linkPerDay = Number(env.WYLLS_MCP_LINK_PER_DAY);
  }
  return out;
}
