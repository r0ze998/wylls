// Workstream 04's act registry settings for bin/wylls-mcp.mjs, checked before anything is opened (2026-11-17).
// WYLLS_MCP_WS04_ACTS, WYLLS_MCP_WS04_RUNEXEC and WYLLS_MCP_WS04_DB go together: all three or none ("All three settings
// or none", bin/wylls-mcp.mjs). A setting counts as given when it is a non-empty value, as the launcher has always
// read them (`if (env.WYLLS_MCP_WS04_ACTS)`). Before this check, RUNEXEC or DB without ACTS started the server
// without the registry and said nothing. WYLLS_MCP_WS04_GATEWAY_PORT is optional with the three and is not part of
// this rule. Pure: no I/O; the answer names settings, never their values.
export const WS04_ACTS_SETTINGS = Object.freeze(['WYLLS_MCP_WS04_ACTS', 'WYLLS_MCP_WS04_RUNEXEC', 'WYLLS_MCP_WS04_DB']);

/** null when all three or none are given; otherwise the launcher's error text (setting names only). */
export function ws04ActsSettingsError(env) {
  const given = WS04_ACTS_SETTINGS.filter(k => Boolean(env?.[k]));
  if (given.length === 0 || given.length === WS04_ACTS_SETTINGS.length) return null;
  // ACTS given: the launcher's existing message, unchanged.
  if (given.includes('WYLLS_MCP_WS04_ACTS')) return 'WYLLS_MCP_WS04_ACTS needs WYLLS_MCP_WS04_RUNEXEC and WYLLS_MCP_WS04_DB';
  const missing = WS04_ACTS_SETTINGS.filter(k => !given.includes(k));
  return `the workstream 04 act registry takes ${WS04_ACTS_SETTINGS.join(', ')} together (all three or none); given: ${given.join(', ')}; missing: ${missing.join(', ')}`;
}
