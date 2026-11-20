// The MCP protocol versions both servers speak (newest first). Its own module, with no imports (2026-11-20,
// verify-pr114): the public read-only server needs only this list, and importing it from server.mjs loaded the owner
// server's whole graph (game, auth, ports, relay client) into the public process. server.mjs re-exports it.
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
