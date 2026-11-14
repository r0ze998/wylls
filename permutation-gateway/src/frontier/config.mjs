// The Frontier relay's configuration (contract §8.3, §10.3): one table of
// defaults, the flag/environment parser, and the port rule every M1 service
// follows — ports in 41000–41999, never one of the owner's reserved ports,
// and the public listener on loopback only (the herald proxies it as
// `/gw/*`, I-51).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LOCAL_DIR } from '../config.mjs';
import { decode as fromBase58 } from '../../client/src/base58.mjs';
import { expeditionPreviewConfigProblems } from './expedition-preview.mjs';
import { mintUrlProblem } from './mint-link.mjs';
import { expeditionPrepareConfigProblems } from './expedition-prepare.mjs';
import { expeditionDepartPrepareConfigProblems } from './expedition-depart-prepare.mjs';

export const FRONTIER_DIR = path.join(LOCAL_DIR, 'frontier');

/** Ports the owner's services use; no M1 process binds one (§10.3, I-26). */
export const RESERVED_PORTS = Object.freeze([4185, 4190, 4191, 4194, 18899, 17799, 28899, 27799, 26699, 5185, 5191]);
export const M1_PORT_MIN = 41000;
export const M1_PORT_MAX = 41999;

export const FRONTIER_DEFAULTS = Object.freeze({
  cluster: 'localnet',
  rpc: 'http://127.0.0.1:41010',
  programId: null,
  seasonId: null,
  /** Operator listener (loopback, every route) and public listener (loopback, the herald's /gw). */
  port: 41030,
  publicPort: 41033,
  publicHost: '127.0.0.1',
  /** The herald's loopback address: only its requests may carry a trusted X-Forwarded-For. */
  heraldPeer: '127.0.0.1',
  heraldUrl: 'http://127.0.0.1:41040',
  keeperUrl: 'http://127.0.0.1:41050',
  keeperTokenFile: null,
  /** Optional keyless inspection transport. All four are explicit; never inherit the relay RPC. */
  expeditionPreviewBin: null,
  expeditionPreviewRpc: null,
  expeditionPreviewProgramVersion: null,
  expeditionPreviewRulesetHash: null,
  /** Optional unsigned-only CLI. Public payer and budget are explicit pins. */
  expeditionPrepareBin: null,
  expeditionPrepareRpc: null,
  expeditionPrepareFeePayer: null,
  expeditionPrepareRulesetHash: null,
  expeditionPrepareCuLimit: null,
  expeditionPrepareLoadedLimit: null,
  /** Optional unsigned-only Depart CLI: its own opt-in, never inherited from the resident one above. Off by default. */
  expeditionDepartPrepareBin: null,
  expeditionDepartPrepareRpc: null,
  expeditionDepartPrepareFeePayer: null,
  expeditionDepartPrepareRulesetHash: null,
  expeditionDepartPrepareCuLimit: null,
  expeditionDepartPrepareLoadedLimit: null,
  /** Relay payer pool: 150 keys derived from the master seed, `pool_id = "relay"` (I-49 scheme). */
  poolSize: 150,
  masterSeedFile: path.join(FRONTIER_DIR, 'relay-master.seed'),
  /** The join-gate key (playtest preset: its public key is `Season.join_gate`). */
  gateKeyFile: null,
  /** The test-asset prize pool (permutation-prize): its program id and test mint; null when the season has none. */
  prizeProgram: null,
  prizeMint: null,
  /** ⑳ The NFT pass mint page the join screen links to (local test worlds only: mint-link.mjs); null: no link. */
  mintUrl: null,
  /** The test mint's authority (the local faucet); only with a prize pool, only on localnet. */
  faucetKeyFile: null,
  /** Test tokens one POST /f/faucet gives a wallet (base units), once per wallet. TEST VALUE. */
  faucetAmount: 100_000_000,
  /** The published contribution ledger (scripts/prize-settle.mjs writes it; GET /f/prize/ledger serves it). */
  prizeLedgerFile: null,
  inviteSecretFile: path.join(FRONTIER_DIR, 'invite.secret'),
  stateFile: path.join(FRONTIER_DIR, 'relay-state.json'),
  /** Explicit restart mode: require the existing state and keys, never create replacements. */
  requireExistingState: false,
  /** Public co-signing pauses (503 OperatorLowFunds) below this pool total. */
  minPoolSol: 1,
  /** A payer below this is not drawn for GET /f/relay. */
  minPayerLamports: 50_000_000,
  /** Allow a pool below 150 keys (tests, dev stacks). */
  dev: false,
  /** The agent wallet (docs/agent-wallet/DESIGN.md): off unless --agent-wallet; localnet test USDC (the prize mint) only. */
  agentWallet: false,
  /** The test custody account's keypair (created on first use, mode 0600) and the agents' key files. */
  agentCustodyKeyFile: path.join(FRONTIER_DIR, 'agent-custody.json'),
  agentKeysDir: path.join(FRONTIER_DIR, 'agent-keys'),
  /** The ledger's own state file; null: `agent-wallet.json` next to --state-file. */
  agentStateFile: null,
  /** Fixed test price of one model call (base units of the 6-decimal test mint: 10,000 = 0.01). TEST VALUE. */
  agentInferencePrice: 10_000,
  /** A JSON file `{actionName: baseUnits}` of USDC prices for game actions; none: every action stays free or resource-paid. */
  agentGamePricesFile: null,
  /** How often sent holds and withdrawals are reconciled with the chain (ms). */
  agentReconcileMs: 15_000,
  /** The in-process runner for agents in auto mode: off unless --agent-runner; the rule autopilot, or a loopback llama-server. */
  agentRunner: false,
  agentTickMs: 30_000,
  agentLlmUrl: null,
  /** The model name the runner asks the server for and records with each charge (a single-model llama-server answers with whatever it loaded: set this to what was loaded). */
  agentLlmAlias: 'gemma-4-26b-a4b-it',
  /** Opt-in: one schema branch per action with required fields and ranges (DESIGN.md §7.2). Off: the measured runs' schema. */
  agentLlmStrictSchema: false,
  /** PROPOSED test values (DESIGN.md §7.1), not production ones: the least time between two model calls of one agent, and the operator's cap on calls a day. */
  agentMinCallGapMs: 60_000,
  /** PROPOSED test value: a burst of owner commands is answered once per this gap. */
  agentOwnerCallGapMs: 10_000,
  agentMaxCallsPerDay: 200,
  /** The proposed deadline rule for unresolved model calls (DESIGN.md §6.5): null keeps them for the operator's decision. Off until the owner approves it. */
  agentUnresolvedReleaseMs: null,
});

/** Whether an M1 service may bind `port` (§10.3); the reason if not. */
export function portProblem(port, what = 'port') {
  if (!Number.isInteger(port)) return `${what} ${port} is not a port`;
  if (port === 0) return null; // tests: an ephemeral port on 127.0.0.1
  if (RESERVED_PORTS.includes(port)) return `${what} ${port} is reserved (owner's services)`;
  if (port < M1_PORT_MIN || port > M1_PORT_MAX) return `${what} ${port} is outside ${M1_PORT_MIN}–${M1_PORT_MAX}`;
  return null;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Flags that take no value. */
const BOOLEAN_FLAGS = Object.freeze({ dev: 'dev', 'agent-wallet': 'agentWallet', 'agent-runner': 'agentRunner', 'agent-llm-strict-schema': 'agentLlmStrictSchema', 'require-existing-state': 'requireExistingState' });

/**
 * The relay's configuration from flags (`--rpc URL --program ID --season N
 * --port P --public-port Q --herald-peer A --keeper URL --keeper-token-file F
 * --pool-size N --master-seed-file F --gate-key-file F --invite-secret-file F
 * --state-file F --min-pool-sol X --dev --agent-wallet --agent-custody-key-file F
 * --agent-keys-dir D --agent-state-file F --agent-inference-price N --agent-game-prices-file F
 * --agent-reconcile-ms N --agent-runner --agent-tick-ms N --agent-llm URL`) over FRONTIER_*
 * environment variables over the defaults. Throws on a bad value.
 */
export function loadFrontierConfig(argv = [], env = {}) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (BOOLEAN_FLAGS[name]) { flags[BOOLEAN_FLAGS[name]] = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    flags[name] = argv[++i];
  }
  const pick = (flag, envName, dflt) => flags[flag] ?? env[envName] ?? dflt;
  const int = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${what}: ${v} is not a non-negative integer`);
    return n;
  };
  const d = FRONTIER_DEFAULTS;
  const cfg = {
    cluster: pick('cluster', 'FRONTIER_CLUSTER', d.cluster),
    rpc: pick('rpc', 'FRONTIER_RPC', d.rpc),
    programId: pick('program', 'FRONTIER_PROGRAM_ID', d.programId),
    seasonId: pick('season', 'FRONTIER_SEASON_ID', d.seasonId),
    port: int(pick('port', 'FRONTIER_RELAY_PORT', d.port), '--port'),
    publicPort: int(pick('public-port', 'FRONTIER_RELAY_PUBLIC_PORT', d.publicPort), '--public-port'),
    publicHost: pick('public-host', 'FRONTIER_RELAY_PUBLIC_HOST', d.publicHost),
    heraldPeer: pick('herald-peer', 'FRONTIER_HERALD_PEER', d.heraldPeer),
    heraldUrl: pick('herald', 'FRONTIER_HERALD_URL', d.heraldUrl),
    keeperUrl: pick('keeper', 'FRONTIER_KEEPER_URL', d.keeperUrl),
    keeperTokenFile: pick('keeper-token-file', 'FRONTIER_KEEPER_TOKEN_FILE', d.keeperTokenFile),
    expeditionPreviewBin: pick('expedition-preview-bin', 'FRONTIER_EXPEDITION_PREVIEW_BIN', d.expeditionPreviewBin),
    expeditionPreviewRpc: pick('expedition-preview-rpc', 'FRONTIER_EXPEDITION_PREVIEW_RPC', d.expeditionPreviewRpc),
    expeditionPreviewProgramVersion: pick('expedition-preview-program-version', 'FRONTIER_EXPEDITION_PREVIEW_PROGRAM_VERSION', d.expeditionPreviewProgramVersion),
    expeditionPreviewRulesetHash: pick('expedition-preview-ruleset-hash', 'FRONTIER_EXPEDITION_PREVIEW_RULESET_HASH', d.expeditionPreviewRulesetHash),
    expeditionPrepareBin: pick('expedition-prepare-bin', 'FRONTIER_EXPEDITION_PREPARE_BIN', d.expeditionPrepareBin),
    expeditionPrepareRpc: pick('expedition-prepare-rpc', 'FRONTIER_EXPEDITION_PREPARE_RPC', d.expeditionPrepareRpc),
    expeditionPrepareFeePayer: pick('expedition-prepare-fee-payer', 'FRONTIER_EXPEDITION_PREPARE_FEE_PAYER', d.expeditionPrepareFeePayer),
    expeditionPrepareRulesetHash: pick('expedition-prepare-ruleset-hash', 'FRONTIER_EXPEDITION_PREPARE_RULESET_HASH', d.expeditionPrepareRulesetHash),
    expeditionPrepareCuLimit: pick('expedition-prepare-cu-limit', 'FRONTIER_EXPEDITION_PREPARE_CU_LIMIT', d.expeditionPrepareCuLimit),
    expeditionPrepareLoadedLimit: pick('expedition-prepare-loaded-limit', 'FRONTIER_EXPEDITION_PREPARE_LOADED_LIMIT', d.expeditionPrepareLoadedLimit),
    expeditionDepartPrepareBin: pick('expedition-depart-prepare-bin', 'FRONTIER_EXPEDITION_DEPART_PREPARE_BIN', d.expeditionDepartPrepareBin),
    expeditionDepartPrepareRpc: pick('expedition-depart-prepare-rpc', 'FRONTIER_EXPEDITION_DEPART_PREPARE_RPC', d.expeditionDepartPrepareRpc),
    expeditionDepartPrepareFeePayer: pick('expedition-depart-prepare-fee-payer', 'FRONTIER_EXPEDITION_DEPART_PREPARE_FEE_PAYER', d.expeditionDepartPrepareFeePayer),
    expeditionDepartPrepareRulesetHash: pick('expedition-depart-prepare-ruleset-hash', 'FRONTIER_EXPEDITION_DEPART_PREPARE_RULESET_HASH', d.expeditionDepartPrepareRulesetHash),
    expeditionDepartPrepareCuLimit: pick('expedition-depart-prepare-cu-limit', 'FRONTIER_EXPEDITION_DEPART_PREPARE_CU_LIMIT', d.expeditionDepartPrepareCuLimit),
    expeditionDepartPrepareLoadedLimit: pick('expedition-depart-prepare-loaded-limit', 'FRONTIER_EXPEDITION_DEPART_PREPARE_LOADED_LIMIT', d.expeditionDepartPrepareLoadedLimit),
    poolSize: int(pick('pool-size', 'FRONTIER_RELAY_POOL', d.poolSize), '--pool-size'),
    masterSeedFile: pick('master-seed-file', 'FRONTIER_RELAY_SEED_FILE', d.masterSeedFile),
    gateKeyFile: pick('gate-key-file', 'FRONTIER_GATE_KEY_FILE', d.gateKeyFile),
    prizeProgram: pick('prize-program', 'FRONTIER_PRIZE_PROGRAM', d.prizeProgram),
    prizeMint: pick('prize-mint', 'FRONTIER_PRIZE_MINT', d.prizeMint),
    mintUrl: pick('mint-url', 'FRONTIER_MINT_URL', d.mintUrl),
    faucetKeyFile: pick('faucet-key-file', 'FRONTIER_FAUCET_KEY_FILE', d.faucetKeyFile),
    faucetAmount: int(pick('faucet-amount', 'FRONTIER_FAUCET_AMOUNT', d.faucetAmount), '--faucet-amount'),
    prizeLedgerFile: pick('prize-ledger-file', 'FRONTIER_PRIZE_LEDGER_FILE', d.prizeLedgerFile),
    inviteSecretFile: pick('invite-secret-file', 'FRONTIER_INVITE_SECRET_FILE', d.inviteSecretFile),
    stateFile: pick('state-file', 'FRONTIER_RELAY_STATE', d.stateFile),
    requireExistingState: flags.requireExistingState === true,
    minPoolSol: Number(pick('min-pool-sol', 'FRONTIER_MIN_POOL_SOL', d.minPoolSol)),
    minPayerLamports: int(pick('min-payer-lamports', 'FRONTIER_MIN_PAYER_LAMPORTS', d.minPayerLamports), '--min-payer-lamports'),
    dev: !!(flags.dev ?? (env.FRONTIER_DEV === '1' || d.dev)),
    agentWallet: !!(flags.agentWallet ?? (env.FRONTIER_AGENT_WALLET === '1' || d.agentWallet)),
    agentCustodyKeyFile: pick('agent-custody-key-file', 'FRONTIER_AGENT_CUSTODY_KEY_FILE', d.agentCustodyKeyFile),
    agentKeysDir: pick('agent-keys-dir', 'FRONTIER_AGENT_KEYS_DIR', d.agentKeysDir),
    agentStateFile: pick('agent-state-file', 'FRONTIER_AGENT_STATE_FILE', d.agentStateFile),
    agentInferencePrice: int(pick('agent-inference-price', 'FRONTIER_AGENT_INFERENCE_PRICE', d.agentInferencePrice), '--agent-inference-price'),
    agentGamePricesFile: pick('agent-game-prices-file', 'FRONTIER_AGENT_GAME_PRICES_FILE', d.agentGamePricesFile),
    agentReconcileMs: int(pick('agent-reconcile-ms', 'FRONTIER_AGENT_RECONCILE_MS', d.agentReconcileMs), '--agent-reconcile-ms'),
    agentRunner: !!(flags.agentRunner ?? (env.FRONTIER_AGENT_RUNNER === '1' || d.agentRunner)),
    agentTickMs: int(pick('agent-tick-ms', 'FRONTIER_AGENT_TICK_MS', d.agentTickMs), '--agent-tick-ms'),
    agentLlmUrl: pick('agent-llm', 'FRONTIER_AGENT_LLM_URL', d.agentLlmUrl),
    agentLlmAlias: pick('agent-llm-alias', 'FRONTIER_AGENT_LLM_ALIAS', d.agentLlmAlias),
    agentLlmStrictSchema: !!(flags.agentLlmStrictSchema ?? (env.FRONTIER_AGENT_LLM_STRICT_SCHEMA === '1' || d.agentLlmStrictSchema)),
    agentMinCallGapMs: int(pick('agent-min-call-gap-ms', 'FRONTIER_AGENT_MIN_CALL_GAP_MS', d.agentMinCallGapMs), '--agent-min-call-gap-ms'),
    agentOwnerCallGapMs: int(pick('agent-owner-call-gap-ms', 'FRONTIER_AGENT_OWNER_CALL_GAP_MS', d.agentOwnerCallGapMs), '--agent-owner-call-gap-ms'),
    agentMaxCallsPerDay: int(pick('agent-max-calls-per-day', 'FRONTIER_AGENT_MAX_CALLS_PER_DAY', d.agentMaxCallsPerDay), '--agent-max-calls-per-day'),
    agentUnresolvedReleaseMs: (v => (v === null || v === undefined || v === '' ? null : int(v, '--agent-unresolved-release-ms')))(pick('agent-unresolved-release-ms', 'FRONTIER_AGENT_UNRESOLVED_RELEASE_MS', d.agentUnresolvedReleaseMs)),
    operatorToken: env.FRONTIER_OPERATOR_TOKEN ?? null,
  };
  const bad = checkFrontierConfig(cfg);
  if (bad.length) throw new Error(`frontier relay config: ${bad.join('; ')}`);
  return cfg;
}

/** Problems with a configuration (empty when it may run). */
export function checkFrontierConfig(cfg) {
  const out = [...expeditionPreviewConfigProblems(cfg), ...expeditionPrepareConfigProblems(cfg), ...expeditionDepartPrepareConfigProblems(cfg)];
  for (const [p, what] of [[cfg.port, '--port'], [cfg.publicPort, '--public-port']]) {
    const e = portProblem(p, what);
    if (e) out.push(e);
  }
  if (cfg.port && cfg.port === cfg.publicPort) out.push('--port and --public-port must differ');
  // I-51: the public listener is reached through the herald's /gw proxy only.
  if (!LOOPBACK.has(cfg.publicHost)) out.push(`--public-host ${cfg.publicHost}: the public listener binds loopback only (the herald proxies it)`);
  if (!LOOPBACK.has(cfg.heraldPeer) && !/^127\./.test(cfg.heraldPeer)) out.push(`--herald-peer ${cfg.heraldPeer} must be a loopback address`);
  if (!cfg.dev && cfg.poolSize < 150) out.push(`--pool-size ${cfg.poolSize}: the relay pool has at least 150 keys (--dev for less)`);
  if (cfg.poolSize < 1) out.push('--pool-size must be at least 1');
  if (!cfg.programId) out.push('--program is required');
  if (cfg.seasonId === null || cfg.seasonId === undefined || !/^\d{1,20}$/.test(String(cfg.seasonId))) out.push('--season (the season id) is required');
  if (!!cfg.prizeProgram !== !!cfg.prizeMint) out.push('--prize-program and --prize-mint go together');
  { const p = mintUrlProblem(cfg.mintUrl, cfg.cluster); if (p) out.push(p); }
  if (cfg.faucetKeyFile && cfg.cluster !== 'localnet') out.push('--faucet-key-file: the test-token faucet exists on localnet only');
  if (!(cfg.minPoolSol >= 0)) out.push('--min-pool-sol must be ≥ 0');
  if (cfg.agentWallet) {
    // Test custody only: the prize mint is the local test USDC; no live cluster, no live money.
    if (!cfg.prizeMint) out.push('--agent-wallet needs --prize-mint (the local test USDC mint)');
    if (cfg.cluster !== 'localnet') out.push('--agent-wallet: the test custody exists on localnet only');
    if (cfg.agentReconcileMs < 1_000) out.push('--agent-reconcile-ms must be at least 1000');
  }
  if (cfg.agentRunner) {
    if (!cfg.agentWallet) out.push('--agent-runner needs --agent-wallet');
    if (cfg.agentTickMs < 1_000) out.push('--agent-tick-ms must be at least 1000');
  }
  if (cfg.agentLlmUrl) {
    let host = null;
    try { host = new URL(cfg.agentLlmUrl).hostname; } catch { host = null; }
    if (!host || !LOOPBACK.has(host)) out.push(`--agent-llm ${cfg.agentLlmUrl}: a local model server on loopback only`);
  }
  return out;
}

/** A 32-byte secret kept in `file` (created with mode 0600 the first time). */
export function secretFile(file, { create = true } = {}) {
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(t)) throw new Error(`${file}: not 32 bytes of hex`);
    return Buffer.from(t, 'hex');
  }
  if (!create) throw new Error(`${file} does not exist`);
  mkdirSync(path.dirname(file), { recursive: true });
  const b = randomBytes(32);
  writeFileSync(file, `${b.toString('hex')}\n`, { mode: 0o600 });
  return b;
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = v => Number.isSafeInteger(v) && v >= 0;
const signature64 = v => {
  try { return typeof v === 'string' && v.length <= 128 && fromBase58(v).length === 64; } catch { return false; }
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Match quota.mjs's burst calculation without importing its HTTP route
// dependencies during a file-only resume preflight.
const dailyOverride = Number(process.env.FRONTIER_RELAY_TXS_PER_DAY) || 0;
const quotaBurst = dailyOverride > 0 ? Math.max(60, dailyOverride * 2) : 60;

/** Reject malformed persisted budgets and one-time grants before a resumed listener opens. */
export function validateRelayRecords(state, { prize = false } = {}) {
  if (!Number.isSafeInteger(quotaBurst) || !isObject(state) || !isObject(state.quota) || !isObject(state.invitesUsed)
      || !isObject(state.relayPending)
      || (prize && (!isObject(state.faucet) || !isObject(state.claimPending)))
      || (state.faucet != null && !isObject(state.faucet))
      || (state.claimPending != null && !isObject(state.claimPending))) {
    throw new Error('relay quota/invite/faucet records or claim records are invalid; refusing resume');
  }
  for (const [key, attempt] of Object.entries(state.relayPending)) {
    const validReplayKey = key.startsWith('sig:') ? signature64(key.slice(4)) : /^msg:[0-9a-f]{64}$/.test(key);
    if (!validReplayKey || !isObject(attempt)
        || !['unknown', 'submitted', 'finalized'].includes(attempt.status)
        || (attempt.status === 'finalized' && !['landed', 'failed'].includes(attempt.outcome))
        || (attempt.outcome !== undefined && (attempt.status !== 'finalized' || !['landed', 'failed'].includes(attempt.outcome)))
        || !signature64(attempt.signature)
        || !nonnegative(attempt.lastValidBlockHeight)
        || typeof attempt.kind !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(attempt.kind)
        || typeof attempt.quotaKey !== 'string' || attempt.quotaKey.length < 1 || attempt.quotaKey.length > 300
        || !nonnegative(attempt.day)
        || typeof attempt.moved !== 'string' || attempt.moved.length > 20 || !/^(0|[1-9][0-9]*)$/.test(attempt.moved)
        || BigInt(attempt.moved) > 0xffff_ffff_ffff_ffffn) {
      throw new Error('relay signed-attempt record is invalid; refusing resume');
    }
  }
  for (const [key, record] of Object.entries(state.quota)) {
    if (!/^(citizen|addr):.{1,256}$/.test(key) || !isObject(record)
        || !nonnegative(record.day) || !nonnegative(record.left) || record.left > quotaBurst
        || !nonnegative(record.lamports)) {
      throw new Error('relay quota record is invalid; refusing resume');
    }
  }
  for (const [nonce, usedAt] of Object.entries(state.invitesUsed)) {
    if (!/^[0-9a-f]{24}$/.test(nonce) || !nonnegative(usedAt)) {
      throw new Error('relay used-invite record is invalid; refusing resume');
    }
  }
  for (const [wallet, grant] of Object.entries(state.faucet ?? {})) {
    let canonicalWallet = false;
    try { canonicalWallet = new PublicKey(wallet).toBase58() === wallet; } catch { /* invalid key */ }
    if (!canonicalWallet || !isObject(grant)
        || !['pending', 'landed'].includes(grant.status)
        || typeof grant.amount !== 'string' || grant.amount.length > 20
        || !/^[1-9][0-9]*$/.test(grant.amount)
        || BigInt(grant.amount) > 0xffff_ffff_ffff_ffffn
        || !signature64(grant.signature)
        || !nonnegative(grant.at)) {
      throw new Error('relay faucet record is invalid; refusing resume');
    }
  }
  for (const [wallet, claim] of Object.entries(state.claimPending ?? {})) {
    let canonicalWallet = false;
    try { canonicalWallet = new PublicKey(wallet).toBase58() === wallet; } catch { /* invalid key */ }
    if (!canonicalWallet || !isObject(claim)
        || !['pending', 'landed'].includes(claim.status)
        || !signature64(claim.signature)
        || !nonnegative(claim.at)) {
      throw new Error('relay claim record is invalid; refusing resume');
    }
  }
}

/** A missing signed-deposit journal is unsafe to treat as an empty one after restart. */
export function validateAgentDepositSends(wallet) {
  if (!isObject(wallet?.depositSends) || !isObject(wallet.agents)
      || !isObject(wallet.deposits) || !isObject(wallet.ownerNonces)) {
    throw new Error('agent wallet signed-deposit records are invalid; refusing resume');
  }
  for (const [signature, send] of Object.entries(wallet.depositSends)) {
    if (!signature64(signature) || !isObject(send) || send.signature !== signature
        || typeof send.agentId !== 'string' || !Object.hasOwn(wallet.agents, send.agentId)
        || !signature64(send.ownerSignature)
        || typeof send.amount !== 'string' || send.amount.length > 20 || !/^[1-9][0-9]*$/.test(send.amount)
        || BigInt(send.amount) > 0xffff_ffff_ffff_ffffn
        || (send.lastValidBlockHeight !== null && !nonnegative(send.lastValidBlockHeight))
        || (send.slotFloor !== null && !nonnegative(send.slotFloor))
        || !['pending', 'landed', 'failed', 'expired'].includes(send.state)
        || !nonnegative(send.at)
        || (send.decidedAt !== undefined && !nonnegative(send.decidedAt))
        || (send.state === 'pending' && send.decidedAt !== undefined)) {
      throw new Error('agent wallet signed-deposit record is invalid; refusing resume');
    }
  }
}
export const runIdentity = cfg => ({
  programId: String(cfg.programId), seasonId: String(cfg.seasonId),
  prizeProgram: cfg.prizeProgram ?? null, prizeMint: cfg.prizeMint ?? null,
});
export const sameRun = (saved, cfg) => isObject(saved)
  && Object.entries(runIdentity(cfg)).every(([key, value]) => saved[key] === value);

function existingObject(file, name) {
  if (!file || !existsSync(file)) throw new Error(`${name} is missing; refusing relay resume`);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(value)) throw new Error(`${name} is invalid; refusing relay resume`);
  return value;
}

/** Read a saved keypair without the create-on-miss behavior used by a new run. */
export function existingKeypair(file, name) {
  if (!file || !existsSync(file)) throw new Error(`${name} is missing; refusing relay resume`);
  const bytes = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error(`${name} is invalid; refusing relay resume`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

/** Fail before any listener, new key, or state store is created on an explicit resume. */
export function requireExistingRelayFiles(cfg) {
  if (!cfg.requireExistingState) return;
  const state = existingObject(cfg.stateFile, 'relay state');
  if (!sameRun(state.runIdentity, cfg)) {
    throw new Error('relay state identity or quota/invite/faucet records are invalid; refusing resume');
  }
  validateRelayRecords(state, { prize: !!cfg.prizeProgram });
  const masterSeed = secretFile(cfg.masterSeedFile, { create: false });
  const inviteSecret = secretFile(cfg.inviteSecretFile, { create: false });
  if (state.runIdentity.masterSeedSha256 !== sha256(masterSeed)
      || state.runIdentity.inviteSecretSha256 !== sha256(inviteSecret)) {
    throw new Error('relay state and saved secrets disagree; refusing resume');
  }
  const gate = cfg.gateKeyFile ? existingKeypair(cfg.gateKeyFile, 'join gate key') : null;
  const faucet = cfg.faucetKeyFile ? existingKeypair(cfg.faucetKeyFile, 'faucet key') : null;
  if (state.runIdentity.gate !== (gate?.publicKey.toBase58() ?? null)
      || state.runIdentity.faucet !== (faucet?.publicKey.toBase58() ?? null)) {
    throw new Error('relay state and saved keys disagree; refusing resume');
  }
  if (!cfg.agentWallet) return;
  const agentFile = cfg.agentStateFile ?? path.join(path.dirname(cfg.stateFile), 'agent-wallet.json');
  const agent = existingObject(agentFile, 'agent wallet state');
  if (!sameRun(agent.runIdentity, cfg) || !isObject(agent.agentWallet)
      || !isObject(agent.agentWallet.agents) || !isObject(agent.agentWallet.deposits)
      || !isObject(agent.agentWallet.ownerNonces)) {
    throw new Error('agent wallet state identity or records are invalid; refusing resume');
  }
  validateAgentDepositSends(agent.agentWallet);
  const custody = existingKeypair(cfg.agentCustodyKeyFile, 'agent custody key');
  if (agent.runIdentity.custody !== custody.publicKey.toBase58()) {
    throw new Error('agent wallet state and custody key disagree; refusing resume');
  }
  for (const [id, record] of Object.entries(agent.agentWallet.agents)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id) || !isObject(record)) {
      throw new Error('agent wallet has an invalid agent record; refusing resume');
    }
    const file = path.join(cfg.agentKeysDir, `${id}.key`);
    if (!existsSync(file)) throw new Error('an agent signing key is missing; refusing resume');
    const seed = readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(seed)
        || Keypair.fromSeed(Buffer.from(seed, 'hex')).publicKey.toBase58() !== record.agentKey) {
      throw new Error('an agent signing key disagrees with saved state; refusing resume');
    }
  }
  // Reconciliation currently reports startup failure only to the log. Do
  // not start a runner or accept commands with an unproved restored budget.
  throw new Error('agent wallet resume is not supported until initial reconciliation is required');
}

/** First-run marker, written before opening a listener or accepting a sponsor request. */
export function persistInitialRelayState(store, cfg, { masterSeed, inviteSecret, gate = null, faucet = null }) {
  store.state ??= {};
  store.state.quota ??= {};
  store.state.invitesUsed ??= {};
  store.state.relayPending ??= {};
  if (cfg.prizeProgram) {
    store.state.faucet ??= {};
    store.state.claimPending ??= {};
  }
  store.state.runIdentity = {
    ...runIdentity(cfg), gate, faucet,
    masterSeedSha256: sha256(masterSeed), inviteSecretSha256: sha256(inviteSecret),
  };
  store.save();
}
