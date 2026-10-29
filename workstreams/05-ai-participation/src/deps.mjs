// What this workstream reads from the shared code, in one place. Everything
// here is imported, never changed: the agent wallet (permutation-gateway
// src/frontier/agent), its MCP server (mcp/agent-mcp.mjs), the game's codec
// and the citizens' sanitiser. If one of these moves, this file is the one
// to follow.
import { createRequire } from 'node:module';

export { createAgentMcp, TOOLS as MCP_TOOLS } from '../../../permutation-gateway/mcp/agent-mcp.mjs';
export { ACTION_GROUPS, AGENT_ACTIONS, ERR, NEVER_DELEGATED } from '../../../permutation-gateway/src/frontier/agent/contract.mjs';
export { accountsFor } from '../../../permutation-gateway/src/frontier/agent/gateway.mjs';
export { CANDIDATES, CATALOG_S1, affordable } from '../../../permutation-gateway/src/frontier/agent/runner.mjs';
export { ixOf, decodeIxData } from '../../../permutation-gateway/client/src/frontier/codec.mjs';
export { FrontierAddresses } from '../../../permutation-gateway/client/src/frontier/addresses.mjs';
export { rulesetFor } from '../../../permutation-gateway/client/src/frontier/profile.mjs';
export { sanitize, wrapUntrusted } from '../../../permutation-gateway/citizens/mind/sanitize.mjs';

/** The gateway's own dependencies (the same module instances its tests use). */
export const gatewayRequire = createRequire(new URL('../../../permutation-gateway/package.json', import.meta.url));
