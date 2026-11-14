// TEST ONLY, LOCAL-PLAY ONLY (⑰, 2026-11-15): the NFT pass prize on the local test candidate world
// (localnet-conquest-nft-sbf, program [0x4C; 32], 0xC804). It is mounted only when the world runs the TEST ONLY
// nft-experimental prize build (the runner/launcher's test-only prize option); without that nothing here exists.
// Holds no key. In the local-play style (local-play-relay.mjs): the page's one pinned wallet signs and pays.
//
//   GET  /f/local-play/prize[?asset=]        the pool as GET /f/prize serves it (prize-view.mjs poolView), and with
//                                             ?asset= the pass's Entry and NFT Citizen (passView)
//   GET  /f/local-play/prize/ledger          the TEST ONLY shares ledger the world was given (or 404)
//   POST /f/local-play/prize/claim/prepare   { asset, generation } → an already-claimed Entry is answered by the shared
//                                             claimed-Entry rule (claim-outcome.mjs); otherwise the UNSIGNED message of
//                                             one ClaimResident for the pinned wallet (its share from the ledger), fee
//                                             payer the wallet, remembered for one submit
//   POST /f/local-play/prize/claim/submit    { message_digest, transaction_b64 }: exactly that message, one Ed25519
//                                             signature by the pinned wallet, verified here; then sendTransaction to the
//                                             loopback runner. One use per message.
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

export const LOCAL_PRIZE_ROUTES = Object.freeze({
  view: 'GET /f/local-play/prize', ledger: 'GET /f/local-play/prize/ledger',
  prepare: 'POST /f/local-play/prize/claim/prepare', submit: 'POST /f/local-play/prize/claim/submit',
});
export const PREPARE_SCHEMA = 'frontier-local-play-prize-claim-prepare-v1';
export const SUBMIT_SCHEMA = 'frontier-local-play-prize-claim-submit-v1';
/** How long a prepared, unsubmitted claim stays submittable (wall clock). */
export const PREPARED_TTL_MS = 60_000;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isKey = s => typeof s === 'string' && B58.test(s) && (() => { try { return decode(s).length === 32; } catch { return false; } })();
const exact = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => k in o);
const fault = (code, status, message) => Object.assign(new Error(message ?? code), { code, status });

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
 * `rpc(method, params)` (loopback JSON-RPC), `readLedger()` → the TEST ONLY ledger object or null, `now()` ms.
 * Returns { view, ledger, prepare, submit } handlers (plain async functions over request bodies; the mounting relay owns HTTP).
 */
export function createLocalPlayPrize({ cfg, rpc, readLedger = async () => null, now = () => Date.now() }) {
  const problems = localPrizeConfigProblems(cfg);
  if (problems.length) throw fault('LocalPrizeConfig', 503, problems.join('; '));
  const addresses = new FrontierAddresses({ programId: cfg.programId, seasonId: cfg.seasonId });
  const pool = poolAddress(cfg.prizeProgram, cfg.programId, cfg.seasonId);
  const prepared = new Map(); // message digest → { wire message bytes, expires, used }

  const account = async k => {
    const v = (await rpc('getAccountInfo', [k, { encoding: 'base64', commitment: 'confirmed' }]))?.value ?? null;
    return v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null;
  };
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
      const claimed = claimedEntryAnswer({ entry: { ...entry, pool: entry.pool }, pool, owns: e => e.asset === body.asset,
        mine: e => e.claimedBy === cfg.wallet && e.claimGeneration === body.generation });
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
      const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const message = compileMessage({ feePayer: cfg.wallet, recentBlockhash: value.blockhash, instructions: [ix] });
      const digest = createHash('sha256').update(message).digest('hex');
      prepared.set(digest, { message: Uint8Array.from(message), expires: now() + PREPARED_TTL_MS, used: false });
      return { status: 'prepared', schema: SUBMIT_SCHEMA, message_digest: digest, message_b64: Buffer.from(message).toString('base64'), route: LOCAL_PRIZE_ROUTES.submit };
    },

    async submit(body) {
      if (!exact(body, ['schema', 'message_digest', 'transaction_b64']) || body.schema !== SUBMIT_SCHEMA) throw fault('BadRequest', 400);
      const pre = prepared.get(body.message_digest);
      if (!pre) throw fault('LocalPrizeUnknownMessage', 404, 'not a message this relay prepared');
      if (pre.used) throw fault('LocalPrizeMessageUsed', 409, 'this prepared claim was already submitted');
      if (now() > pre.expires) throw fault('LocalPrizeMessageExpired', 410, 'this prepared claim expired; prepare again');
      const wire = Buffer.from(String(body.transaction_b64), 'base64');
      // Exactly one signature, then exactly the prepared message, signed by the pinned wallet.
      if (wire.length < 1 + 64 || wire[0] !== 1) throw fault('LocalPrizeBadTransaction', 400, 'one signature');
      const sig = wire.subarray(1, 65), msg = wire.subarray(65);
      if (!msg.equals(Buffer.from(pre.message))) throw fault('LocalPrizeMessageChanged', 400, 'not the prepared message');
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(decode(cfg.wallet))]), format: 'der', type: 'spki' });
      if (!edVerify(null, msg, key, sig)) throw fault('LocalPrizeBadSignature', 400, 'not signed by the pinned wallet');
      pre.used = true; // reserved before the send: a second submit never sends twice
      const signature = await rpc('sendTransaction', [wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
      if (signature !== encode(sig)) throw fault('SendOutcomeUnknown', 503, 'the runner returned a different signature');
      return { status: 'submitted', signature };
    },
  };
}
