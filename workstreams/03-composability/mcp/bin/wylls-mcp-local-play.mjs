#!/usr/bin/env node
// READ-ONLY MCP observation server for ONE local-play TEST world (⑤ option B: external AI residents observe over MCP,
// owner decision 2026-11-18). The same server, OAuth test authorization server and read tools as bin/wylls-mcp.mjs,
// built read-only: only `wylls.read` is granted, no write tool is listed or dispatched (no send_caravan, no
// prepare_caravan), no capability is ever asked of a relay, and nothing is sent anywhere but GETs to the world's
// public proxy. A link is the resident's own: its wallet signs the link statement, and agentId = owner.
//
//   WYLLS_MCP_TEST_AS=1 WYLLS_MCP_PORT=41440 \
//   WYLLS_MCP_HERALD=http://localhost:<world proxy port> WYLLS_MCP_RELAY=http://localhost:<world proxy port>/gw \
//   node bin/wylls-mcp-local-play.mjs
//
// WYLLS_MCP_HERALD and WYLLS_MCP_RELAY must be loopback (a local TEST world). The settings of bin/wylls-mcp.mjs that
// would write (WYLLS_MCP_WS04_*, WYLLS_MCP_ALLOW_GLOBAL_ROTATE) are refused here. The store is in memory unless
// WYLLS_MCP_STORE (+ WYLLS_MCP_SEAL_KEY) is set.
import { JsonStore } from '../src/store.mjs';
import { Sealer } from '../src/seal.mjs';
import { Auth } from '../src/auth.mjs';
import { createWyllsMcp } from '../src/server.mjs';
import { createHandler, listen } from '../src/http.mjs';
import { LocalPlayGame } from '../src/local-play-game.mjs';
import { connectLine } from './mcp-settings.mjs';
import { localPlaySettings } from './local-play-settings.mjs';

const env = process.env;
const settings = localPlaySettings(env);
if (settings.error) { console.error(settings.error); process.exit(2); }
const { port, host, issuer, resource, allowedHosts } = settings;
const log = m => process.stderr.write(`[wylls-mcp local-play read-only] ${m}\n`);
const store = new JsonStore(env.WYLLS_MCP_STORE ?? null);
const game = new LocalPlayGame({ relay: settings.relay, herald: settings.herald });
const auth = new Auth({ issuer, resource, store, sealer: new Sealer(env.WYLLS_MCP_SEAL_KEY ?? null), game, log, redirectProfiles: ['loopback'], readOnly: true });
const mcp = createWyllsMcp({ auth, game, store, log, readOnly: true });
await listen(createHandler({ auth, mcp, log, allowedHosts }), { port, host });
log(`listening on http://${host}:${port}/mcp (issuer ${issuer}); world ${settings.herald}; tools: ${mcp.tools.join(', ')}`);
log(connectLine(resource));
