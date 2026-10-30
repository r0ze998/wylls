#!/usr/bin/env node
// Starts the workstream 03 MCP server on the local test stack (no network beyond loopback by default).
//
//   WYLLS_MCP_RELAY=http://127.0.0.1:41933     the relay (agent wallet on: FRONTIER_AGENT_WALLET=1)
//   WYLLS_MCP_HERALD=http://127.0.0.1:41940    the herald
//   WYLLS_MCP_PORT=41960                        listen port (host 127.0.0.1; WYLLS_MCP_HOST to change)
//   WYLLS_MCP_ISSUER=http://127.0.0.1:41960     the public origin (https behind a tunnel for ChatGPT)
//   WYLLS_MCP_STORE=.local/wylls-mcp/store.json the JSON store (0600)
//   WYLLS_MCP_SEAL_KEY=<32 bytes base64url>     seals the agent capability at rest (required with a store file)
//   WYLLS_MCP_TEST_AS=1                         the local test authorization server (the only one implemented)
//   WYLLS_MCP_RECEIPT_PORT=local                  local, or ws04-mapped (the same tracking in ④'s proposed vocabulary; both MOCK). ④'s real adapter is not in this build
//   WYLLS_MCP_REDIRECT_PROFILES=chatgpt,loopback which clients may be redirected to (chatgpt, claude, loopback; default chatgpt,loopback)
import { JsonStore } from '../src/store.mjs';
import { Sealer } from '../src/seal.mjs';
import { Game } from '../src/game.mjs';
import { Auth } from '../src/auth.mjs';
import { createWyllsMcp } from '../src/server.mjs';
import { receiptPortFor } from '../src/receipt-port.mjs';
import { createHandler, listen } from '../src/http.mjs';

const env = process.env;
if (env.WYLLS_MCP_TEST_AS !== '1') { console.error('set WYLLS_MCP_TEST_AS=1: only the local test authorization server is implemented'); process.exit(2); }
if (env.WYLLS_MCP_STORE && !env.WYLLS_MCP_SEAL_KEY) { console.error('WYLLS_MCP_SEAL_KEY is required with a store file'); process.exit(2); }
const port = Number(env.WYLLS_MCP_PORT ?? 41960);
const host = env.WYLLS_MCP_HOST ?? '127.0.0.1';
const issuer = env.WYLLS_MCP_ISSUER ?? `http://127.0.0.1:${port}`;
const log = m => process.stderr.write(`[wylls-mcp] ${m}\n`);
const store = new JsonStore(env.WYLLS_MCP_STORE ?? null);
const game = new Game({ relay: env.WYLLS_MCP_RELAY ?? 'http://127.0.0.1:41933', herald: env.WYLLS_MCP_HERALD ?? 'http://127.0.0.1:41940' });
const redirectProfiles = env.WYLLS_MCP_REDIRECT_PROFILES ? env.WYLLS_MCP_REDIRECT_PROFILES.split(',').map(x => x.trim()).filter(Boolean) : undefined;
const auth = new Auth({ issuer, resource: `${issuer}/mcp`, store, sealer: new Sealer(env.WYLLS_MCP_SEAL_KEY ?? null), game, log, ...(redirectProfiles ? { redirectProfiles } : {}) });
log(`redirect profiles: ${auth.redirectProfiles.join(', ')}`);
const receipts = receiptPortFor(env.WYLLS_MCP_RECEIPT_PORT ?? 'local');
const mcp = createWyllsMcp({ auth, game, store, log, receipts });
log(`receipt port: ${receipts.contract}${receipts.real ? '' : ' (MOCK: this server\'s own tracking, not ④\'s ledger)'}`);
const seal = auth.sealCheck();
if (seal.unopenable) log(`warning: ${seal.unopenable} of ${seal.sealed} connection capabilities cannot be opened with this WYLLS_MCP_SEAL_KEY; their sends are held (CapabilityUnavailable) until the key is restored or the owner revokes the connection`);
await listen(createHandler({ auth, mcp, log }), { port, host });
log(`listening on http://${host}:${port}/mcp (issuer ${issuer})`);
