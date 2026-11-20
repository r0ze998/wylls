// DEVNET PLAY (devnet gap P1, owner decision B7: the PLAYABLE lane on devnet) — the page's own first-village and
// wide-land commands on a devnet season, WALLET-PAID: the player's wallet is fee payer AND actor, signs once, and pays
// its own fees and rent. The gateway sponsors nothing here (no relay pool key signs, no lamport leaves the operator):
// it is a checked forwarder in front of the operator's RPC, because the page's CSP lets it talk to its own origin only
// (the herald, which proxies /gw/* to this gateway).
//
//   POST /f/devnet-play/act/context  {schema: …-info-v1}                    → the lane this gateway serves (a read of config)
//                                    {schema: …-context-v1, wallet}         → {wallet, blockhash} (one getLatestBlockhash)
//   POST /f/devnet-play/act/submit   {schema: …-submit-v1, name, subject, fields, transaction_b64}
//   POST /f/devnet-play/act/status   {schema: …-status-v1, signature}       → the chain's word on a signature it sent
//
// The checks are local play's own (local-play-act.mjs, the validator core), with this gateway's pins and the Season's
// real id instead of local play's one wallet and season 11:
//   1. the command is one of DEVNET_ACT_COMMANDS (a closed list; the wide -> wide host acts are NOT here: the devnet
//      build closes wide departures, Q-W2 = local TEST only);
//   2. the stated intent is well formed; the message REBUILT here from it with the game's own builder for the
//      transaction's ONE signer (fee payer = actor = that wallet) is the signed message byte for byte; the signature
//      verifies;
//   3. one read of the real accounts (the Citizen, and the village for a village command) at one slot;
//   4. the replay barrier (these bytes were not submitted before), then ONE sendTransaction, never again.
//
// devnet-page-war: the ORDINARY sealed march (legacy Depart 0x50) on the same terms, over its own two routes:
//   POST /f/devnet-play/march/submit {schema: …-march-submit-v1, name: 'Depart', subject, fields, transaction_b64}
//   POST /f/devnet-play/march/status {schema: …-march-status-v1, signature} → also `expired` (the blockhash read first)
// The checks are local play's march validator (local-play-march.mjs `localMarchSubmit` / `localMarchAccountsCheck`):
// the Depart rebuilt for the ONE signer with the game's builder, byte-compared, the signature verified, the seal's
// shape, the host of THIS village; then one read of the Citizen, the legacy village and its province; the replay
// barrier; ONE send. The seal stays opaque here (a drand time-lock): the march is revealed by keeper A from the public
// round, or from the owner's material the page hands to the keeper (`POST /f/reveal`), never by this gateway.
// The march's later steps (SettleDeparture, the reveal, the clash, SettleTransit, the return) are keeper A's play
// roles: nothing else of the war is served here.
// No key is held, nothing is signed here. Off unless the operator starts the gateway with `--devnet-play`
// (config.mjs devnetPlayConfigProblems: cluster devnet, an https RPC; the offline test form only on loopback).
import { createHash } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseTransaction } from '../../client/src/solana-tx.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { WIDE_CLAIM } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { fetchRpc } from './local-play-relay.mjs';
import { LocalActError, localActAccountOf, localActAccountsCheck, localActSubmit, runnerRejection, sendRefusalDetail } from './local-play-act.mjs';
import { LOCALNET_PLAYABLE_LANE } from './playable-lane-profile.mjs';
import { LocalMarchError, localMarchAccountOf, localMarchAccountsCheck, localMarchSubmit, sealBinding } from './local-play-march.mjs';

/** The commands a devnet page sends itself (the first village, its economy, the wide claim). */
export const DEVNET_ACT_COMMANDS = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster', 'FileTicket', WIDE_CLAIM]);
export const DEVNET_ACT_ROUTES = Object.freeze({ context: 'POST /f/devnet-play/act/context', submit: 'POST /f/devnet-play/act/submit', status: 'POST /f/devnet-play/act/status' });
/** devnet-page-war: the ordinary sealed march (Depart) of the devnet page, wallet-paid as the acts. */
export const DEVNET_MARCH_COMMANDS = Object.freeze(['Depart']);
export const DEVNET_MARCH_ROUTES = Object.freeze({ submit: 'POST /f/devnet-play/march/submit', status: 'POST /f/devnet-play/march/status' });
export const DEVNET_MARCH_SUBMIT_SCHEMA = 'frontier-devnet-play-march-submit-v1';
export const DEVNET_MARCH_STATUS_SCHEMA = 'frontier-devnet-play-march-status-v1';
export const DEVNET_ACT_INFO_SCHEMA = 'frontier-devnet-play-act-info-v1';
export const DEVNET_ACT_CONTEXT_SCHEMA = 'frontier-devnet-play-act-context-v1';
export const DEVNET_ACT_SUBMIT_SCHEMA = 'frontier-devnet-play-act-submit-v1';
export const DEVNET_ACT_STATUS_SCHEMA = 'frontier-devnet-play-act-status-v1';
/** Signatures kept for the status route and the replay barrier (oldest forgotten first; a blockhash lives ~1-2 min). */
export const DEVNET_ACT_MAX_HISTORY = 8192;
/** The offline test form's RPC: the in-process localnet on the M1 port range (never 41970), nothing else. */
export const DEVNET_PLAY_OFFLINE_RPC = /^http:\/\/127\.0\.0\.1:(4[1][0-9]{3})$/;
const HARD_REFUSED_HOSTS = ['mainnet', 'testnet'];

const fail = code => { throw new LocalActError(code); };
const check = (ok, code = 'LocalActInvalid') => { if (!ok) fail(code); };
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const address = s => { try { return typeof s === 'string' && s.length <= 44 && decode(s).length === 32 && encode(decode(s)) === s; } catch { return false; } };
const sha = b => createHash('sha256').update(b).digest('hex');

/**
 * What is wrong with a gateway configuration that asks for the devnet play routes (empty when they may be served):
 * `{cluster, rpc, programId, seasonId, devnetPlay, devnetPlayRulesetHash, devnetPlayOfflineRpc}`.
 * There is no default devnet RPC: the operator names one (https, no credentials in the URL, never a mainnet or
 * testnet host). `devnetPlayOfflineRpc` (TEST ONLY) allows the in-process localnet on loopback instead, so the page
 * can be proven against the exact devnet `.so` offline; it never allows any other http URL.
 */
export function devnetPlayConfigProblems(cfg) {
  if (!cfg?.devnetPlay) return [];
  const out = [];
  if (cfg.cluster !== 'devnet') out.push(`--devnet-play: cluster ${cfg.cluster}; the devnet play routes serve a devnet season only`);
  if (!address(cfg.programId)) out.push('--devnet-play needs --program (a base58 address)');
  else if (cfg.programId === LOCALNET_PLAYABLE_LANE.program) out.push('--devnet-play: the program is the localnet lane\'s [0x45; 32] (local play has its own relay)');
  if (!/^[0-9]{1,20}$/.test(String(cfg.seasonId ?? ''))) out.push('--devnet-play needs --season');
  if (!/^[0-9a-f]{64}$/.test(String(cfg.devnetPlayRulesetHash ?? ''))) out.push('--devnet-play needs --devnet-play-ruleset-hash (64 hex, the Season\'s RULESET_HASH)');
  let u = null; try { u = new URL(cfg.rpc); } catch { out.push(`--rpc ${cfg.rpc} is not a URL`); }
  if (u) {
    if (cfg.devnetPlayOfflineRpc) {
      const m = DEVNET_PLAY_OFFLINE_RPC.exec(String(cfg.rpc));
      if (!m || Number(m[1]) === 41970) out.push(`--devnet-play-offline-rpc: ${cfg.rpc} is not the in-process localnet (http://127.0.0.1:41000-41999, never 41970)`);
    } else {
      if (u.protocol !== 'https:') out.push(`--rpc ${cfg.rpc}: the devnet play routes send through an https RPC only`);
      if (u.username || u.password) out.push(`--rpc ${cfg.rpc}: no credentials in the URL`);
      const host = u.hostname.toLowerCase();
      for (const bad of HARD_REFUSED_HOSTS) if (host.includes(bad)) out.push(`--rpc ${cfg.rpc}: host ${host} is refused (${bad}); devnet only`);
    }
  }
  return out;
}

/**
 * The flow over `cfg` (devnetPlayConfigProblems must be empty) and `rpc(method, params)` → the JSON-RPC answer.
 * → `{routes, info(), context(body), submit(body), status(body), stats()}`. Constructing it reads and sends nothing.
 */
export function createDevnetPlayAct({ cfg, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), now = () => Date.now() }) {
  const problems = devnetPlayConfigProblems({ ...cfg, devnetPlay: true });
  if (problems.length) throw new Error('devnet play refused: ' + problems.join('; '));
  const seasonId = String(cfg.seasonId);
  const A = seasonAddresses(cfg.programId, seasonId);
  const base = Object.freeze({ program: cfg.programId, season: A.season, seasonId, rulesetHash: cfg.devnetPlayRulesetHash });
  const seen = new Map();   // digest → {signature, name, at}; also the status route's list
  const remember = (digest, e) => { seen.set(digest, e); while (seen.size > DEVNET_ACT_MAX_HISTORY) seen.delete(seen.keys().next().value); };
  const ask = async (method, params) => { let r; try { r = await rpc(method, params); } catch { fail('LocalActRpcUnavailable'); } if (!r || r.error !== undefined) fail('LocalActRpcUnavailable'); return r; };
  return Object.freeze({
    routes: DEVNET_ACT_ROUTES,
    /** The lane this gateway serves (its own configuration; nothing is read). */
    info: () => ({ schema: DEVNET_ACT_INFO_SCHEMA, cluster: 'devnet', program: base.program, season: base.season, season_id: seasonId, ruleset_hash: base.rulesetHash, commands: [...DEVNET_ACT_COMMANDS],
      march: { commands: [...DEVNET_MARCH_COMMANDS], reveal: 'keeper' } }),

    async context(body) {
      if (exact(body, ['schema']) && body.schema === DEVNET_ACT_INFO_SCHEMA) return this.info();
      check(exact(body, ['schema', 'wallet']) && body.schema === DEVNET_ACT_CONTEXT_SCHEMA && address(body.wallet));
      const r = await ask('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const v = r.result?.value, slot = r.result?.context?.slot;
      if (!address(v?.blockhash) || !Number.isSafeInteger(v.lastValidBlockHeight) || v.lastValidBlockHeight < 0 || !Number.isSafeInteger(slot) || slot < 0) fail('LocalActRpcUnavailable');
      return { wallet: body.wallet, blockhash: { hash: v.blockhash, last_valid_block_height: String(v.lastValidBlockHeight), context_slot: String(slot) } };
    },

    async submit(body) {
      check(exact(body, ['schema', 'name', 'subject', 'fields', 'transaction_b64']) && body.schema === DEVNET_ACT_SUBMIT_SCHEMA && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700);
      check(DEVNET_ACT_COMMANDS.includes(body.name), 'LocalActNotAllowed');
      // (the transaction's ONE signer is the wallet the message is rebuilt for; anything else is refused by the core)
      let signer = null;
      try { const t = parseTransaction(Buffer.from(body.transaction_b64, 'base64')); if (t.signers.length === 1) signer = t.signers[0]; } catch { fail('LocalActInvalid'); }
      check(address(signer), 'LocalActSigner');
      const pins = Object.freeze({ ...base, wallet: signer });
      const ok = localActSubmit(body, pins, { schema: DEVNET_ACT_SUBMIT_SCHEMA }), digest = sha(ok.message);
      check(!seen.has(digest), 'LocalActMessageUsed');
      const { intent } = ok;
      const citizenAt = A.of('Citizen', { wallet: pins.wallet });
      // (the wide claim's subject holding is its anchor: the first home, a legacy village of this Citizen — checked as one)
      const holdingAt = intent.subject.holding ? A.of('Holding', intent.subject.holding) : null;
      const asked = holdingAt === null ? [citizenAt] : [citizenAt, holdingAt];
      const got = await ask('getMultipleAccounts', [asked, { encoding: 'base64', commitment: 'confirmed' }]);
      const slot = got.result?.context?.slot, rows = got.result?.value;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== asked.length) fail('LocalActRpcUnavailable');
      localActAccountsCheck(intent, pins, { citizenAt, holdingAt },
        [localActAccountOf(rows[0]), holdingAt === null ? undefined : localActAccountOf(rows[1])]);
      check(!seen.has(digest), 'LocalActMessageUsed');   // (re-checked after the await; synchronous from here to the send)
      remember(digest, Object.freeze({ signature: ok.signature, name: intent.name, at: now() }));
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', name: intent.name, signature: ok.signature, status_route: DEVNET_ACT_ROUTES.status }; }
      if (sent?.error) throw new LocalActError(runnerRejection(sent.error) ? 'LocalActRejected' : 'LocalActSendRefused', sendRefusalDetail(sent.error, ok.signature));
      return { status: sent?.result === ok.signature ? 'submitted' : 'unknown', name: intent.name, signature: ok.signature, status_route: DEVNET_ACT_ROUTES.status };
    },

    async status(body) {
      check(exact(body, ['schema', 'signature']) && body.schema === DEVNET_ACT_STATUS_SCHEMA && typeof body.signature === 'string' && body.signature.length <= 100);
      check([...seen.values()].some(e => e.signature === body.signature), 'LocalActUnknownSignature');
      const r = await ask('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]);
      const value = r.result?.value, slot = r.result?.context?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== 1) fail('LocalActRpcUnavailable');
      const s = value[0];
      if (s === null) return { signature: body.signature, status: 'pending', context_slot: slot };
      if (typeof s !== 'object' || Array.isArray(s) || !Object.hasOwn(s, 'err') || !Number.isSafeInteger(s.slot) || s.slot < 0
          || !['processed', 'confirmed', 'finalized'].includes(s.confirmationStatus)) fail('LocalActRpcUnavailable');
      return { signature: body.signature, status: s.err !== null ? 'failed' : s.confirmationStatus, err: s.err, slot: s.slot, context_slot: slot };
    },

    /** ONE page-signed Depart (the wallet the only signer, fee payer AND actor), checked as local play's march. */
    async marchSubmit(body) {
      const mfail = (code, detail) => { throw new LocalMarchError(code, detail); };
      if (!(exact(body, ['schema', 'name', 'subject', 'fields', 'transaction_b64']) && body.schema === DEVNET_MARCH_SUBMIT_SCHEMA && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700)) mfail('LocalMarchInvalid');
      if (!DEVNET_MARCH_COMMANDS.includes(body.name)) mfail('LocalMarchNotAllowed');
      let signer = null;
      try { const t = parseTransaction(Buffer.from(body.transaction_b64, 'base64')); if (t.signers.length === 1) signer = t.signers[0]; } catch { mfail('LocalMarchInvalid'); }
      if (!address(signer)) mfail('LocalMarchSigner');
      const pins = Object.freeze({ ...base, wallet: signer });
      const ok = localMarchSubmit(body, pins, { schema: DEVNET_MARCH_SUBMIT_SCHEMA }), digest = sha(ok.message);
      if (seen.has(digest)) mfail('LocalMarchMessageUsed');
      const citizenAt = A.of('Citizen', { wallet: pins.wallet });
      const holdingAt = A.of('Holding', ok.intent.subject.holding), provinceAt = A.of('Province', ok.intent.subject.province);
      let got; try { got = await rpc('getMultipleAccounts', [[citizenAt, holdingAt, provinceAt], { encoding: 'base64', commitment: 'confirmed' }]); } catch { mfail('LocalMarchRpcUnavailable'); }
      const slot = got?.result?.context?.slot, rows = got?.result?.value;
      if (got?.error !== undefined || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== 3) mfail('LocalMarchRpcUnavailable');
      localMarchAccountsCheck(ok.intent, pins, { citizenAt, holdingAt }, rows.map(localMarchAccountOf));
      if (seen.has(digest)) mfail('LocalMarchMessageUsed');   // (re-checked after the await; synchronous from here to the send)
      remember(digest, Object.freeze({ signature: ok.signature, name: 'Depart', blockhash: ok.blockhash, at: now() }));
      const binding = sealBinding(ok.intent);
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', name: 'Depart', signature: ok.signature, ...binding, status_route: DEVNET_MARCH_ROUTES.status }; }
      if (sent?.error) throw new LocalMarchError(runnerRejection(sent.error) ? 'LocalMarchRejected' : 'LocalMarchSendRefused', sendRefusalDetail(sent.error, ok.signature));
      return { status: sent?.result === ok.signature ? 'submitted' : 'unknown', name: 'Depart', signature: ok.signature, ...binding, status_route: DEVNET_MARCH_ROUTES.status };
    },

    /** The chain's word on a march this gateway sent; `expired` once its blockhash is no longer valid and it is unknown. */
    async marchStatus(body) {
      const mfail = code => { throw new LocalMarchError(code); };
      if (!(exact(body, ['schema', 'signature']) && body.schema === DEVNET_MARCH_STATUS_SCHEMA && typeof body.signature === 'string' && body.signature.length <= 100)) mfail('LocalMarchInvalid');
      const entry = [...seen.values()].find(e => e.signature === body.signature && e.name === 'Depart');
      if (!entry) mfail('LocalMarchUnknownSignature');
      const q = async (m, p) => { let r; try { r = await rpc(m, p); } catch { mfail('LocalMarchRpcUnavailable'); } if (!r || r.error !== undefined) mfail('LocalMarchRpcUnavailable'); return r; };
      const v = await q('isBlockhashValid', [entry.blockhash, { commitment: 'processed' }]);
      const expired = v.result?.value === false;
      const r = await q('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]);
      const value = r.result?.value, slot = r.result?.context?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== 1) mfail('LocalMarchRpcUnavailable');
      const s = value[0];
      if (s === null) return { signature: body.signature, status: expired ? 'expired' : 'pending', context_slot: slot };
      if (typeof s !== 'object' || Array.isArray(s) || !Object.hasOwn(s, 'err') || !Number.isSafeInteger(s.slot) || s.slot < 0
          || !['processed', 'confirmed', 'finalized'].includes(s.confirmationStatus)) mfail('LocalMarchRpcUnavailable');
      return { signature: body.signature, status: s.err !== null ? 'failed' : s.confirmationStatus, err: s.err, slot: s.slot, context_slot: slot };
    },

    stats: () => ({ history: seen.size }),
  });
}
