// Wylls (M1) relay — free, sponsored player
// transactions for one season of the `permutation-frontier` program
// (contract §8.3). No money: the relay pool pays fees, the Citizen's rent at
// Join, the Holding-rent escrow at FileTicket and the Depart escrow, all
// test SOL, within per-citizen quotas.
//
//   node src/frontier/server.mjs --program <id> --season <n>
//        [--rpc http://127.0.0.1:41010]         the chain (frontier-localnet in the local stack)
//        [--port 41030 --public-port 41033]     operator and public listeners (both 127.0.0.1;
//                                               M1 ports only: 41000–41999, never a reserved one)
//        [--herald-peer 127.0.0.1]              the herald's loopback address (its X-Forwarded-For is trusted)
//        [--herald http://127.0.0.1:41040]      published in GET /f/season
//        [--keeper http://127.0.0.1:41050 --keeper-token-file F]   the keeper link (/f/reveal, /f/nudge)
//        [--pool-size 150 --master-seed-file F] the relay pool (pool_id "relay"; < 150 only with --dev)
//        [--gate-key-file F]                    the join-gate keypair (playtest preset; invites)
//        [--prize-program ID --prize-mint M]    the season's test-asset prize pool (x402 entry: routes/prize.mjs)
//        [--faucet-key-file F --faucet-amount N] the test mint's authority: POST /f/faucet (localnet only)
//        [--invite-secret-file F --state-file F --min-pool-sol 1 --dev]
//        [--agent-wallet --agent-custody-key-file F --agent-keys-dir D --agent-state-file F
//         --agent-inference-price N --agent-game-prices-file F --agent-reconcile-ms N]
//                                               the agent wallet (docs/agent-wallet/DESIGN.md): operator-held test
//                                               custody of the prize mint's test USDC, off by default, localnet only
//        [--agent-runner --agent-tick-ms N --agent-llm URL]   the in-process runner for agents in auto mode
//   Every flag also as FRONTIER_* (config.mjs); the operator token from
//   FRONTIER_OPERATOR_TOKEN or .local/frontier/operator-token.
//
// The relay starts no chain and sends no transaction of its own; it only
// co-signs what players built, after the checks in routes/relay.mjs.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connection } from '@solana/web3.js';
import { loadOrCreateKeypairSync } from '../../client/src/keys.mjs';
import { createStateStore, operatorToken } from '../config.mjs';
import { Custody } from './agent/custody.mjs';
import { attachAgentWallet } from './agent/gateway.mjs';
import { AgentKeyring } from './agent/keyring.mjs';
import { AgentObserver, AgentScheduler, llmDecider, ruleDecider } from './agent/runner.mjs';
import { createLlm } from '../../citizens/mind/llm.mjs';
import { createFrontierApps } from './app.mjs';
import { FRONTIER_DIR, loadFrontierConfig, secretFile } from './config.mjs';
import { InviteBook } from './invites.mjs';
import { KeeperLink } from './keeperlink.mjs';
import { PayerPool, RELAY_POOL_ID } from './payers.mjs';

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
});

/** Build and start the relay; returns `{ctx, servers, ports, close()}`. */
export async function startFrontierRelay(cfg, { connection = new Connection(cfg.rpc, 'confirmed'), log = console.log } = {}) {
  const store = createStateStore(cfg.stateFile);
  store.load();
  store.state ??= {};
  const pool = new PayerPool({ masterSeed: secretFile(cfg.masterSeedFile), n: cfg.poolSize, poolId: RELAY_POOL_ID, dev: cfg.dev, minLamports: cfg.minPayerLamports });
  const gateKey = cfg.gateKeyFile ? loadOrCreateKeypairSync(cfg.gateKeyFile) : null;
  const faucetKey = cfg.prizeProgram && cfg.faucetKeyFile ? loadOrCreateKeypairSync(cfg.faucetKeyFile) : null;
  cfg.prizeLedgerFile ??= cfg.prizeProgram ? path.join(path.dirname(cfg.stateFile), 'prize-ledger.json') : null;
  const invites = new InviteBook({ secret: secretFile(cfg.inviteSecretFile), seasonId: cfg.seasonId, store });
  const keeper = cfg.keeperUrl ? new KeeperLink({ url: cfg.keeperUrl, tokenFile: cfg.keeperTokenFile }) : null;
  const apps = createFrontierApps({ cfg, connection, pool, keeper, invites, gateKey, faucetKey, store, log });
  const agents = cfg.agentWallet ? startAgentWallet(cfg, apps.ctx, { connection, pool, log }) : null;
  const operator = http.createServer(apps.operator);
  const pub = cfg.publicPort ? http.createServer(apps.public) : null;
  const ports = { operator: await listen(operator, cfg.port, '127.0.0.1') };
  if (pub) {
    pub.requestTimeout = 15_000;
    ports.public = await listen(pub, cfg.publicPort, cfg.publicHost);
  }
  log(`frontier relay: program ${cfg.programId} season ${cfg.seasonId} (${apps.ctx.addresses.season}); pool ${pool.size} payers; `
    + `operator 127.0.0.1:${ports.operator}${pub ? `, public ${cfg.publicHost}:${ports.public}` : ''}${gateKey ? `; join gate ${gateKey.publicKey.toBase58()}` : ''}`);
  const close = () => { agents?.stop(); return Promise.all([operator, pub].filter(Boolean).map(s => new Promise(r => s.close(r)))); };
  return { ctx: apps.ctx, servers: { operator, public: pub }, ports, close, agents };
}

/**
 * The agent wallet over the relay's context: its own state file, the
 * custody keypair (created on first use, mode 0600), the agent keyring,
 * the prices, a reconcile timer and (--agent-runner) the scheduler.
 * Returns `{gateway, scheduler, stop()}`.
 */
export function startAgentWallet(cfg, ctx, { connection, pool, log = console.log }) {
  const store = createStateStore(cfg.agentStateFile ?? path.join(path.dirname(cfg.stateFile), 'agent-wallet.json'));
  store.load();
  store.state ??= {};
  const custodyKey = loadOrCreateKeypairSync(cfg.agentCustodyKeyFile);
  // Localnet (the only cluster the config allows) reports no token balances; anywhere else they are required.
  const custody = new Custody({ connection, keypair: custodyKey, mint: cfg.prizeMint, pool, blockhashes: ctx.blockhashes, strictBalances: cfg.cluster !== 'localnet' });
  const game = cfg.agentGamePricesFile ? JSON.parse(readFileSync(cfg.agentGamePricesFile, 'utf8')) : {};
  const gateway = attachAgentWallet(ctx, { store, keyring: new AgentKeyring({ dir: cfg.agentKeysDir }), custody, prices: { inference: String(cfg.agentInferencePrice), game }, unresolvedReleaseMs: cfg.agentUnresolvedReleaseMs ?? null, log });
  const reconcile = setInterval(() => gateway.reconcile().catch(e => log(`agent wallet: reconcile failed: ${e.message}`)), cfg.agentReconcileMs);
  reconcile.unref();
  gateway.reconcile().catch(e => log(`agent wallet: reconcile at start failed: ${e.message}`));
  let scheduler = null;
  if (cfg.agentRunner) {
    const decider = cfg.agentLlmUrl ? llmDecider({ llm: createLlm({ url: cfg.agentLlmUrl }) }) : ruleDecider();
    // The observer reads the herald (public records): without a herald URL every tick asks (the old behaviour).
    const observer = cfg.heraldUrl ? new AgentObserver({ heraldUrl: cfg.heraldUrl }) : null;
    scheduler = new AgentScheduler({ gateway, decider, tickMs: cfg.agentTickMs, observer, minCallGapMs: cfg.agentMinCallGapMs, maxCallsPerDay: cfg.agentMaxCallsPerDay, log });
    scheduler.start();
    gateway.runner = { tickMs: cfg.agentTickMs, decider: decider.name, free: decider.free === true, eventDriven: !!observer, minCallGapMs: cfg.agentMinCallGapMs, maxCallsPerDay: cfg.agentMaxCallsPerDay, stats: scheduler.stats };
  }
  log(`agent wallet: custody ${custody.authority} (token account ${custody.account}, mint ${custody.mint}); ${gateway.ledger.agents().length} agent(s); `
    + `inference ${gateway.prices.inference}/call, ${Object.keys(game).length} priced game action(s); state ${store.file}`
    + (scheduler ? `; runner every ${cfg.agentTickMs} ms (${scheduler.decider.name})` : ''));
  return { gateway, scheduler, stop() { clearInterval(reconcile); scheduler?.stop(); } };
}

async function main() {
  const cfg = loadFrontierConfig(process.argv.slice(2), process.env);
  cfg.operatorToken ??= operatorToken({ file: path.join(FRONTIER_DIR, 'operator-token') });
  const relay = await startFrontierRelay(cfg);
  const stop = () => relay.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
