// The request guards both HTTP faces share (src/http.mjs the owner server, src/public-mcp.mjs the public one). Pure.
//
// Host (DNS rebinding, 2026-11-18): with `allowedHosts` (host names, port-agnostic, as the MCP SDKs'
// hostHeaderValidation), any other, missing or unparseable Host is refused; null = not checked.
// Origin: a request without Origin (not a browser) passes; a browser's Origin must be in the set.

export function hostChecker(allowedHosts) {
  const hostSet = allowedHosts ? new Set(allowedHosts.map(h => String(h).toLowerCase())) : null;
  return req => {
    if (!hostSet) return true;
    const h = req.headers.host;
    if (!h) return false;
    try { return hostSet.has(new URL(`http://${h}`).hostname.toLowerCase()); } catch { return false; }
  };
}

export const originChecker = allowed => req => !req.headers.origin || allowed.has(req.headers.origin);
