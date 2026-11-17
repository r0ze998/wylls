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
//   WYLLS_MCP_ALLOW_GLOBAL_ROTATE=1             on a relay WITHOUT per-sender capabilities, allow write connections that
//                                              rotate the agent's one capability (stops the autopilot's). Off by default.
//   WYLLS_MCP_WS04_ACTS=<④ clients/acts.mjs>   register operations in workstream 04's act registry (off when unset), with:
//   WYLLS_MCP_WS04_RUNEXEC=<runexec>            ④'s binary; WYLLS_MCP_WS04_DB=<runs.db> ④'s run store;
//   WYLLS_MCP_WS04_GATEWAY_PORT=<n>             the relay's 127.0.0.1 port that runexec reads GET /f/agent/fate from
//   WYLLS_MCP_COOP_PUBLIC_BOARD=1               opt in to get_cooperation_status (off when unset), with:
//   WYLLS_MCP_COOP_BOARD=<url>                  the public cooperation board's base; WYLLS_MCP_COOP_CLUSTER=<cluster>
//                                              the cluster it must report (bin/coop-read-settings.mjs; COOP-READ-ADAPTER.md)
import { JsonStore } from '../src/store.mjs';
import { Sealer } from '../src/seal.mjs';
import { Game } from '../src/game.mjs';
import { Auth } from '../src/auth.mjs';
import { createWyllsMcp } from '../src/server.mjs';
import { receiptPortFor } from '../src/receipt-port.mjs';
import { createHandler, listen } from '../src/http.mjs';
import { pathToFileURL } from 'node:url';
import { ws04ActsSettingsError } from './ws04-acts-settings.mjs';
import { mcpSettings, connectLine } from './mcp-settings.mjs';
import { coopReadSettings } from './coop-read-settings.mjs';
import { createCoopReadAdapter } from '../src/coop-read-adapter.mjs';

const env = process.env;
if (env.WYLLS_MCP_TEST_AS !== '1') { console.error('set WYLLS_MCP_TEST_AS=1: only the local test authorization server is implemented'); process.exit(2); }
if (env.WYLLS_MCP_STORE && !env.WYLLS_MCP_SEAL_KEY) { console.error('WYLLS_MCP_SEAL_KEY is required with a store file'); process.exit(2); }
// ④'s act registry: all three settings or none, refused here before the store, the relay or the registry is touched.
const ws04SettingsError = ws04ActsSettingsError(env);
if (ws04SettingsError) { console.error(ws04SettingsError); process.exit(2); }
// The port, host, issuer, relay and herald (2026-11-17): checked before anything is opened. The resource clients must
// be given is exactly <issuer>/mcp; a setting that cannot name one is refused here, not found at sign-in.
const settings = mcpSettings(env);
if (settings.error) { console.error(settings.error); process.exit(2); }
const { port, host, issuer, resource } = settings;
// The opt-in cooperation board read: checked here too, before anything is opened. Off unless all three are set.
const coopSettings = coopReadSettings(env);
if (coopSettings.error) { console.error(coopSettings.error); process.exit(2); }
let coopRead = null;
if (coopSettings.enabled) {
  try {
    coopRead = { adapter: createCoopReadAdapter({ publicViewConfirmed: true, baseUrl: coopSettings.baseUrl, fetch: (...a) => globalThis.fetch(...a) }), cluster: coopSettings.cluster };
  } catch { console.error('WYLLS_MCP_COOP_BOARD: the cooperation board read could not be set up with this base'); process.exit(2); }
}
const log = m => process.stderr.write(`[wylls-mcp] ${m}\n`);
const store = new JsonStore(env.WYLLS_MCP_STORE ?? null);
const game = new Game({ relay: settings.relay, herald: settings.herald });
const redirectProfiles = env.WYLLS_MCP_REDIRECT_PROFILES ? env.WYLLS_MCP_REDIRECT_PROFILES.split(',').map(x => x.trim()).filter(Boolean) : undefined;
const auth = new Auth({ issuer, resource, store, sealer: new Sealer(env.WYLLS_MCP_SEAL_KEY ?? null), game, log, ...(redirectProfiles ? { redirectProfiles } : {}), allowGlobalRotate: env.WYLLS_MCP_ALLOW_GLOBAL_ROTATE === '1' });
log(`redirect profiles: ${auth.redirectProfiles.join(', ')}`);
const receipts = receiptPortFor(env.WYLLS_MCP_RECEIPT_PORT ?? 'local');
// Workstream 04's act registry, through ④'s own client (never re-implemented here). All three settings or none.
let acts = null;
let actsReadVia = null;
if (env.WYLLS_MCP_WS04_ACTS) {
  if (!env.WYLLS_MCP_WS04_RUNEXEC || !env.WYLLS_MCP_WS04_DB) { console.error('WYLLS_MCP_WS04_ACTS needs WYLLS_MCP_WS04_RUNEXEC and WYLLS_MCP_WS04_DB'); process.exit(2); }
  const { createActsClient } = await import(pathToFileURL(env.WYLLS_MCP_WS04_ACTS).href);
  const gatewayPort = env.WYLLS_MCP_WS04_GATEWAY_PORT ? Number(env.WYLLS_MCP_WS04_GATEWAY_PORT) : null;
  acts = createActsClient({ bin: env.WYLLS_MCP_WS04_RUNEXEC, db: env.WYLLS_MCP_WS04_DB, gatewayPort });
  // The same value ④'s client tests (`read && gatewayPort`): a port it would use → 'gateway', else 'store-only' (a
  // non-number or 0 included). Never bridge (this loader does not ask for ④'s test bridge).
  actsReadVia = gatewayPort ? 'gateway' : 'store-only';
  log(`④ act registry: ${env.WYLLS_MCP_WS04_DB} (runexec act; source mcp)`);
}
const mcp = createWyllsMcp({ auth, game, store, log, receipts, acts, actsReadVia, coopRead });
log(coopRead ? `cooperation board read: on (${coopSettings.origin}, cluster ${coopSettings.cluster}; public GETs, get_cooperation_status)` : 'cooperation board read: off');
log(`receipt port: ${receipts.contract}${receipts.real ? '' : ' (MOCK: this server\'s own tracking, not ④\'s ledger)'}`);
const seal = auth.sealCheck();
if (seal.unopenable) log(`warning: ${seal.unopenable} of ${seal.sealed} connection capabilities cannot be opened with this WYLLS_MCP_SEAL_KEY; their sends are held (CapabilityUnavailable) until the key is restored or the owner revokes the connection`);
await listen(createHandler({ auth, mcp, log }), { port, host });
log(`listening on http://${host}:${port}/mcp (issuer ${issuer})`);
// The one URL a client is given (the resource, exactly), and on loopback the Claude Code preflight for it.
log(connectLine(resource));
