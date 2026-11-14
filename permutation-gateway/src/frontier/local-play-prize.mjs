// TEST ONLY, LOCAL-PLAY ONLY (⑰, 2026-11-15): the NFT pass prize on the local test candidate world
// (localnet-conquest-nft-sbf, program [0x4C; 32], 0xC804). It is mounted only when the world runs the TEST ONLY
// nft-experimental prize build (the runner/launcher's test-only prize option); without that nothing here exists.
// Holds no key. In the local-play style (local-play-relay.mjs), reusing its RPC client (fetchRpc: no redirect, a
// timeout, a bounded response; it answers { result } | { error }), its one-signature parse and its barrier rules:
//
//   GET  /f/local-play/prize[?asset=]        the pool as GET /f/prize serves it (prize-view.mjs poolView), and with
//                                             ?asset= the pass's Entry and NFT Citizen (passView)
//   GET  /f/local-play/prize/ledger          the TEST ONLY shares ledger the world was given (or 404)
//   POST /f/local-play/prize/claim/prepare   { schema, asset, generation } → an already-claimed Entry is answered by the
//                                             shared claimed-Entry rule (claim-outcome.mjs); otherwise the UNSIGNED message
//                                             of one ClaimResident for the pinned wallet (its share from the ledger), fee
//                                             payer the wallet: ONE ticket per message digest
//   POST /f/local-play/prize/claim/submit    { schema, message_digest, transaction_b64 }: exactly that message, one
//                                             Ed25519 signature by the pinned wallet; reserved synchronously; one send at most
//   POST /f/local-play/prize/claim/status    { schema, signature } of a claim this relay sent (strict; runner-pinned)
//
// One use per message, whatever happens: a digest that is already in the barrier is NEVER reset. Re-preparing the same
// message (same asset, generation and blockhash) while its ticket is open returns that same ticket; once reserved,
// sent, unknown or expired it is refused. A sent ticket keeps its signature (status can answer it) and is never
// dropped from the barrier; when the barrier is full of tickets that cannot be dropped, prepare is refused.
//
// What it never does: a PayResident (pass deposits stay refused, ResidentDepositsDisabled), a refund (undecided), any
// key, any non-loopback RPC, any world but the configured candidate program and Season. The program judges the owner
// and generation again on chain (ResidentStaleGeneration / ResidentNotCurrentAuthority); nothing here decides it.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { fromHex } from '../../client/src/bytes.mjs';
import { FrontierAddresses } from '../../client/src/frontier/addresses.mjs';
import { claimResidentIx, decodeEntryResident, decodePool, entryResidentAddress, POOL_STATE, poolAddress, SHARE_MODE } from '../../client/src/frontier/prize.mjs';
import { linkAddress, policyAddress, residentAddress, residentCitizen } from '../../client/src/frontier/resident.mjs';
import { decodeAccount } from '../../client/src/frontier/codec.mjs';
import { compileMessage } from '../../client/src/solana-tx.mjs';
import { claimedEntryAnswer } from './claim-outcome.mjs';
import { passView, poolView } from './prize-view.mjs';
import { isCandidateProgram } from './local-lane-versions.mjs';
import { fetchRpc, MAX_HISTORY, OPEN_TTL_MS, singleSigned } from './local-play-relay.mjs';

export const LOCAL_PRIZE_ROUTES = Object.freeze({
  view: 'GET /f/local-play/prize', ledger: 'GET /f/local-play/prize/ledger',
  prepare: 'POST /f/local-play/prize/claim/prepare', submit: 'POST /f/local-play/prize/claim/submit', status: 'POST /f/local-play/prize/claim/status',
});
export const PREPARE_SCHEMA = 'frontier-local-play-prize-claim-prepare-v1';
export const SUBMIT_SCHEMA = 'frontier-local-play-prize-claim-submit-v1';
export const STATUS_SCHEMA = 'frontier-local-play-prize-claim-status-v1';
export { MAX_HISTORY, OPEN_TTL_MS };

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isKey = s => typeof s === 'string' && B58.test(s) && (() => { try { return decode(s).length === 32; } catch { return false; } })();
const exact = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => k in o);
const fault = (code, status, message, extra = {}) => Object.assign(new Error(message ?? code), { code, status }, extra);
const sha = b => createHash('sha256').update(b).digest('hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Loopback only: 127.0.0.0/8 or localhost, http. */
export function loopbackRpc(url) {
  try { const u = new URL(url); return u.protocol === 'http:' && (u.hostname === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(u.hostname)); } catch { return false; }
}

/** What is wrong with the configuration (empty: fine). TEST ONLY and the candidate program only. */
export function localPrizeConfigProblems(cfg) {
  const p = [];
  if (cfg?.testOnly !== true) p.push('testOnly must be true (the TEST ONLY nft-experimental prize build only)');
  if (!loopbackRpc(cfg?.rpc)) p.push('rpc must be a loopback http URL');
  if (!isKey(cfg?.programId) || !isCandidateProgram(cfg.programId)) p.push('programId must be the local test candidate program');
  if (!Number.isSafeInteger(cfg?.seasonId) || cfg.seasonId < 0) p.push('seasonId: a safe integer');
  if (!isKey(cfg?.prizeProgram)) p.push('prizeProgram: a base58 key');
  if (!isKey(cfg?.wallet)) p.push('wallet: the page\'s pinned wallet (base58)');
  return p;
}

/**
 * `rpc(method, params)` → { result } | { error } (fetchRpc's contract; the default), `readLedger()` → the TEST ONLY ledger
 * or null, `now()` ms, `runnerInstance` (64 hex, optional): the one runner this world's status answers must name.
 */
export function createLocalPlayPrize({ cfg, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), readLedger = async () => null, now = () => Date.now(), runnerInstance = null }) {
  const problems = localPrizeConfigProblems(cfg);
  if (problems.length) throw fault('LocalPrizeConfig', 503, problems.join('; '));
  if (runnerInstance !== null && (typeof runnerInstance !== 'string' || !/^[0-9a-f]{64}$/.test(runnerInstance) || /^0{64}$/.test(runnerInstance))) throw fault('LocalPrizeConfig', 503, 'bad runner instance');
  const addresses = new FrontierAddresses({ programId: cfg.programId, seasonId: cfg.seasonId });
  const pool = poolAddress(cfg.prizeProgram, cfg.programId, cfg.seasonId);
  const walletKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(decode(cfg.wallet))]), format: 'der', type: 'spki' });
  /** The barrier: digest → { message, lastValid (bigint), at, state: open|reserved|used|expired|expired_unlanded, signature?, sentSlot? }. */
  const tickets = new Map();

  /** One RPC answer, unwrapped: { error } and a missing result are refusals (never "nothing there" by accident). */
  async function call(method, params, code = 'LocalPrizeRpcUnavailable') {
    let r;
    try { r = await rpc(method, params); } catch { throw fault(code, 503, `${method}: the runner did not answer`); }
    if (!r || r.error || !('result' in r)) throw fault(code, 503, `${method}: ${r?.error?.message ?? 'no result'}`);
    return r.result;
  }
  const account = async k => {
    const v = (await call('getAccountInfo', [k, { encoding: 'base64', commitment: 'confirmed' }]))?.value ?? null;
    return v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null;
  };
  const expireOpen = () => { const t = now(); for (const e of tickets.values()) if (e.state === 'open' && t - e.at > OPEN_TTL_MS) e.state = 'expired'; };
  /** Drop only never-sent tickets (`expired`) whose last valid height the runner has passed. A sent ticket is never dropped. */
  const retire = height => { for (const [d, e] of tickets) if (e.state === 'expired' && height !== null && height > e.lastValid) tickets.delete(d); };
  const heightNow = async () => { try { const h = await call('getBlockHeight', [{ commitment: 'confirmed' }]); return Number.isSafeInteger(h) && h >= 0 ? BigInt(h) : null; } catch { return null; } };

  async function readPool() {
    const a = await account(pool);
    const p = a && a.owner === cfg.prizeProgram ? decodePool(a.data) : null;
    if (!p || p.gameProgram !== cfg.programId || p.seasonId !== BigInt(cfg.seasonId)) throw fault('LocalPrizeNoPool', 404, 'no TEST ONLY prize pool for this world');
    return p;
  }
  const prizeOf = p => ({ program: cfg.prizeProgram, pool, vault: p.vault, mint: p.mint });
  async function passOf(asset) {
    const citizen = residentCitizen(addresses, asset);
    const [e, c] = await Promise.all([account(entryResidentAddress(cfg.prizeProgram, pool, asset)), account(citizen)]);
    const entry = e && e.owner === cfg.prizeProgram ? decodeEntryResident(e.data) : null;
    const citizenAccount = c && c.owner === cfg.programId ? decodeAccount('Citizen', c.data, { seasonId: addresses.seasonId }) : null;
    return { citizen, entry, view: passView({ asset, citizen, citizenAccount, entry }) };
  }

  return {
    async view(query = {}) {
      const p = await readPool();
      const body = poolView(prizeOf(p), p);
      if (query.asset !== undefined) {
        if (!isKey(query.asset)) throw fault('BadAsset', 400);
        body.pass = (await passOf(query.asset)).view;
      }
      return { ok: true, testOnly: true, pool: body };
    },

    async ledger() {
      const l = await readLedger();
      if (!l || l.testOnly !== true) throw fault('LocalPrizeNoLedger', 404, 'no TEST ONLY ledger published for this world');
      return l;
    },

    async prepare(body) {
      if (!exact(body, ['schema', 'asset', 'generation']) || body.schema !== PREPARE_SCHEMA || !isKey(body.asset)
          || !Number.isInteger(body.generation) || body.generation < 0 || body.generation > 0xffffffff) throw fault('BadRequest', 400);
      const p = await readPool();
      if (p.state !== POOL_STATE.SHARES) throw fault('SharesNotPosted', 409, 'the shares are not posted yet');
      if (p.mode === SHARE_MODE.REFUND) throw fault('ResidentRefundUndecided', 409, 'a pass refund is undecided; nothing to claim');
      const { citizen, entry } = await passOf(body.asset);
      if (!entry) throw fault('ResidentNoEntry', 404, 'this pass has no Entry in the pool');
      // A claimed Entry is closed for good: answered by the shared rule (the claimer at its generation: already; anyone else: claimedByOther).
      const claimed = claimedEntryAnswer({ entry, pool, owns: e => e.asset === body.asset, mine: e => e.claimedBy === cfg.wallet && e.claimGeneration === body.generation });
      if (claimed.kind !== 'unclaimed') return { status: claimed.kind, ...claimed };
      const ledger = await readLedger();
      const m = ledger?.testOnly === true ? (ledger.shares?.members ?? []).find(x => x.asset === body.asset) : null;
      if (!m || !Number.isInteger(m.nation) || !Array.isArray(m.proof)) throw fault('ResidentNoShare', 404, 'this pass has no share in the TEST ONLY ledger');
      const policy = policyAddress(cfg.programId);
      const pol = await account(policy);
      // resident_policy (frontier-abi resident_policy.rs): magic PSFNP002 (0..8), core (8..40), resident program (40..72), …
      if (!pol || pol.owner !== cfg.programId || pol.data.length !== 136 || pol.data.subarray(0, 8).toString('latin1') !== 'PSFNP002') throw fault('ResidentPolicy', 503, 'the world has no resident policy');
      const residentProgram = encode(pol.data.subarray(40, 72));
      const ix = claimResidentIx({ prize: prizeOf(p), owner: cfg.wallet, asset: body.asset, citizen, link: linkAddress(cfg.programId, addresses.season, body.asset),
        policy, resident: residentAddress(residentProgram, body.asset), generation: body.generation, nation: m.nation, points: BigInt(m.points), proof: m.proof.map(fromHex) });
      const bh = (await call('getLatestBlockhash', [{ commitment: 'confirmed' }]))?.value;
      if (!bh || typeof bh.blockhash !== 'string' || !Number.isSafeInteger(bh.lastValidBlockHeight)) throw fault('LocalPrizeRpcUnavailable', 503, 'no blockhash');
      const message = Buffer.from(compileMessage({ feePayer: cfg.wallet, recentBlockhash: bh.blockhash, instructions: [ix] }));
      const digest = sha(message);
      expireOpen();
      // ONE ticket per digest: never reset. Open → the same ticket again; anything else → refused (with its signature).
      const known = tickets.get(digest);
      if (known) {
        if (known.state === 'open' && known.message.equals(message)) return { status: 'prepared', schema: SUBMIT_SCHEMA, message_digest: digest, message_b64: known.message.toString('base64'), route: LOCAL_PRIZE_ROUTES.submit, again: true };
        throw fault(known.state === 'expired' ? 'LocalPrizeMessageExpired' : 'LocalPrizeMessageUsed', 409, 'this claim message was already used or expired; nothing is resent',
          known.signature ? { signature: known.signature } : {});
      }
      if (tickets.size >= MAX_HISTORY) { retire(await heightNow()); if (tickets.size >= MAX_HISTORY) throw fault('LocalPrizeBusy', 429, 'too many claim tickets are still unsettled'); }
      tickets.set(digest, { message, lastValid: BigInt(bh.lastValidBlockHeight), at: now(), state: 'open' });
      return { status: 'prepared', schema: SUBMIT_SCHEMA, message_digest: digest, message_b64: message.toString('base64'), route: LOCAL_PRIZE_ROUTES.submit };
    },

    async submit(body) {
      if (!exact(body, ['schema', 'message_digest', 'transaction_b64']) || body.schema !== SUBMIT_SCHEMA
          || typeof body.message_digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.message_digest)
          || typeof body.transaction_b64 !== 'string' || body.transaction_b64.length > 1700) throw fault('BadRequest', 400);
      expireOpen();
      const t = tickets.get(body.message_digest);
      if (!t) throw fault('LocalPrizeUnknownMessage', 404, 'not a message this relay prepared');
      // Synchronous up to the reservation: no await can let a second submit through.
      if (t.state === 'expired') throw fault('LocalPrizeMessageExpired', 410, 'this prepared claim expired; prepare again');
      if (t.state !== 'open') throw fault('LocalPrizeMessageUsed', 409, 'this prepared claim was already submitted', t.signature ? { signature: t.signature } : {});
      const wire = Buffer.from(body.transaction_b64, 'base64');
      if (wire.toString('base64') !== body.transaction_b64 || wire.length > 1232) throw fault('LocalPrizeBadTransaction', 400);
      let parsed;
      try { parsed = singleSigned(wire); } catch { throw fault('LocalPrizeBadTransaction', 400, 'one signature'); }
      const { signature, message } = parsed;
      if (sha(message) !== body.message_digest || !Buffer.from(message).equals(t.message)) throw fault('LocalPrizeMessageChanged', 400, 'not the prepared message');
      if (!edVerify(null, message, walletKey, signature)) throw fault('LocalPrizeBadSignature', 400, 'not signed by the pinned wallet');
      t.state = 'reserved';
      // Before anything is sent: a failure to read a valid height gives the reservation back; past the last valid height it expires.
      const height = await heightNow();
      if (height === null) { t.state = 'open'; throw fault('LocalPrizeRpcUnavailable', 503, 'the runner did not answer'); }
      if (height > t.lastValid) { t.state = 'expired'; throw fault('LocalPrizeMessageExpired', 410); }
      // From here the message is consumed: one send at most; the signature is recorded before sending.
      const sig = encode(signature);
      t.state = 'used'; t.signature = sig; t.sentSlot = height;
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', signature: sig, status_route: LOCAL_PRIZE_ROUTES.status }; }
      if (sent?.error) throw fault('LocalPrizeSendRefused', 409, String(sent.error.message ?? '').slice(0, 300), { signature: sig });
      if (sent?.result !== sig) return { status: 'unknown', signature: sig, status_route: LOCAL_PRIZE_ROUTES.status };
      return { status: 'submitted', signature: sig, status_route: LOCAL_PRIZE_ROUTES.status };
    },

    /** The runner's status of a claim this relay sent; with a pinned runner, only an answer naming that instance counts. */
    async status(body) {
      if (!exact(body, ['schema', 'signature']) || body.schema !== STATUS_SCHEMA || typeof body.signature !== 'string') throw fault('BadRequest', 400);
      const t = [...tickets.values()].find(e => e.signature === body.signature);
      if (!t) throw fault('LocalPrizeUnknownSignature', 404, 'not a claim this relay sent');
      if (t.state === 'expired_unlanded') return { signature: body.signature, status: 'expired_unlanded', context_slot: t.settledSlot };
      const r = await call('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]);
      const ctx = r?.context, value = r?.value, slot = ctx?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== 1) throw fault('LocalPrizeRpcUnavailable', 503, 'malformed status');
      if (runnerInstance !== null && ctx.instance !== runnerInstance) throw fault('LocalPrizeRunnerChanged', 503, 'the answer is not from the runner this claim was sent to');
      const s = value[0];
      if (s === null) {
        const settled = runnerInstance !== null && t.state === 'used' && typeof t.sentSlot === 'bigint' && BigInt(slot) > t.lastValid && BigInt(slot) >= t.sentSlot;
        if (settled) { t.state = 'expired_unlanded'; t.settledSlot = slot; }
        return { signature: body.signature, status: settled ? 'expired_unlanded' : 'pending', context_slot: slot };
      }
      if (typeof s !== 'object' || !Object.hasOwn(s, 'err') || !Object.hasOwn(s, 'slot') || !Object.hasOwn(s, 'confirmationStatus')
          || !Number.isSafeInteger(s.slot) || s.slot < 0 || s.slot > slot || !['processed', 'confirmed', 'finalized'].includes(s.confirmationStatus)) throw fault('LocalPrizeRpcUnavailable', 503, 'malformed status');
      return { signature: body.signature, status: s.err !== null ? 'failed' : s.confirmationStatus, err: s.err, slot: s.slot, context_slot: slot };
    },

    /** Counts only (tests): no digest, message or signature. */
    stats() { expireOpen(); return { tickets: tickets.size, open: [...tickets.values()].filter(e => e.state === 'open').length }; },
  };
}
