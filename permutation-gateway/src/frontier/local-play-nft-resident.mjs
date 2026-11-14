// LOCAL PLAY, LOCAL TEST CANDIDATE lane only ([0x4C; 32] / 0xC804; NOT an allocation): the relay's checks for a
// command played by an NFT resident's Citizen (page builder: permutation-server/web/frontier/flocalresident.mjs).
// (Not local-play-resident.mjs, which is the expedition return's "resident" route.)
//
// A submit `{schema: …-submit-resident-v1, name, subject, fields, resident: {asset, generation, resident_program},
// transaction_b64}` is sent only when ALL of these hold, on ONE read of the accounts at one slot (local-play-act.mjs
// `submit`), never from what the page says:
//   - the lane is the candidate's exact pair (any other program: refused before anything is read);
//   - the command is one of the resident's five, its intent well formed (local-play-act.mjs `localActIntent`);
//   - the transaction is signed once, by the relay's wallet (owner, actor and fee payer);
//   - the policy account is this program's, and its resident program is the one stated;
//   - the asset is Core's (the policy's), of the policy's collection, and its CURRENT owner is this wallet
//     (no pass, or the pass sold: refused — the previous holder cannot act);
//   - the resident record is the policy's resident program's for this asset, and its generation is the one signed
//     (a proof signed before a transfer: refused);
//   - the resident's Citizen (the asset's own address) is this program's and its resident mark names this asset
//     (a wallet Citizen there, or another asset: refused);
//   - the message, REBUILT with the recomputed proof, is the signed message byte for byte, and the signature verifies;
//   - the village (every command but PlaceHome) is a legacy Holding of this Season at these coordinates whose owner is
//     that resident Citizen (PlaceHome: the place is not a wide Holding).
// The wallet guard of the plain path is untouched: a submit with the ordinary schema is the wallet Citizen's, checked
// exactly as before (local-play-act.mjs `localActSubmit` / `localActAccountsCheck`).
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseTransaction } from '../../client/src/solana-tx.mjs';
import { decodeAssetOwner, decodeResident, policyAddress, residentAddress } from '../../client/src/frontier/resident.mjs';
import { citizenMark, decodePolicyRecord } from './resident-chain-gate.mjs';
import { isCandidateProgram } from './local-lane-versions.mjs';
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { profileForHash } from '../../../permutation-server/web/sdk/frontier/profile.mjs';
import { LOCAL_ACT_SUBMIT_RESIDENT_SCHEMA, LOCAL_RESIDENT_ACT_COMMANDS, LOCAL_RESIDENT_JOIN, localResidentActMessage, localResidentCitizen, localResidentProof } from '../../../permutation-server/web/frontier/flocalresident.mjs';

export { LOCAL_ACT_SUBMIT_RESIDENT_SCHEMA, LOCAL_RESIDENT_ACT_COMMANDS, LOCAL_RESIDENT_JOIN };
/** The refusals of this path (each answered BEFORE the one send: nothing sent, the bytes not consumed). */
export const LOCAL_RESIDENT_ERRORS = Object.freeze({
  LocalActResidentUnverified: [409, 'the resident\'s policy, asset or record is not what it must be'],
  LocalActResidentNotHolder: [403, 'this wallet does not hold the pass now'],
  LocalActResidentStale: [409, 'the command was signed for an earlier holder of the pass'],
  LocalActResidentCitizen: [409, 'the resident\'s Citizen is not there, or is not this pass\'s'],
});

const LEGACY_HOLDING_MAGIC = 'PSF1HOLD', WIDE_HOLDING_MAGIC = 'PSFXWHL1';
const magicOf = bytes => String.fromCharCode(...bytes.subarray(0, 8));
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const address = s => typeof s === 'string' && B58.test(s) && (() => { try { return decode(s).length === 32; } catch { return false; } })();
const exact = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

/**
 * Parse a resident submit for `pins` (the relay's own: program, season, seasonId, wallet, rulesetHash) with the plain
 * path's intent rule `intentOf` and error maker `fail`. → `{intent, resident: {asset, generation, residentProgram}, tx}`.
 * Reads nothing.
 */
export function localResidentSubmit(body, pins, { intentOf, fail }) {
  const check = (c, code = 'LocalActInvalid') => { if (!c) fail(code); };
  check(isCandidateProgram(pins.program), 'LocalActNotAllowed');   // (the conquest lane never takes this schema)
  check(exact(body, ['schema', 'name', 'subject', 'fields', 'resident', 'transaction_b64']) && body.schema === LOCAL_ACT_SUBMIT_RESIDENT_SCHEMA
    && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700);
  check(LOCAL_RESIDENT_ACT_COMMANDS.includes(body.name) || body.name === LOCAL_RESIDENT_JOIN, 'LocalActNotAllowed');
  const r = body.resident;
  check(exact(r, ['asset', 'generation', 'resident_program']) && address(r.asset) && address(r.resident_program)
    && Number.isInteger(r.generation) && r.generation >= 0 && r.generation <= 0xffffffff);
  let intent;
  if (body.name === LOCAL_RESIDENT_JOIN) {
    // (the NFT's first login: a faction only; no session key — the owner signs every later command itself)
    const s = body.subject, f = body.fields;
    check(exact(s, ['faction']) && Number.isInteger(s.faction) && s.faction >= 0 && s.faction <= 5 && exact(f, ['faction']) && f.faction === s.faction);
    intent = Object.freeze({ name: body.name, subject: Object.freeze({ faction: s.faction }), fields: Object.freeze({ faction: f.faction }) });
  } else intent = intentOf({ name: body.name, subject: body.subject, fields: body.fields }, { wallet: pins.wallet });
  const wire = Buffer.from(body.transaction_b64, 'base64');
  check(wire.toString('base64') === body.transaction_b64 && wire.length <= 1232);
  let tx; try { tx = parseTransaction(wire); } catch { fail('LocalActInvalid'); }
  check(tx.signatures.length === 1 && tx.signers.length === 1 && tx.signers[0] === pins.wallet, 'LocalActSigner');
  return Object.freeze({ intent, resident: Object.freeze({ asset: r.asset, generation: r.generation, residentProgram: r.resident_program }), tx });
}

/** The accounts the ONE read takes, in this order: policy, asset, record, Citizen, then the village (when it has one). */
export function localResidentAccounts(parsed, pins) {
  const A = seasonAddresses(pins.program, String(pins.seasonId));
  const citizen = localResidentCitizen(pins.program, parsed.resident.asset);
  const holding = parsed.intent.subject.holding ? A.of('Holding', parsed.intent.subject.holding) : null;
  const list = [policyAddress(pins.program), parsed.resident.asset, residentAddress(parsed.resident.residentProgram, parsed.resident.asset), citizen];
  // (JoinResident: the season's link of this asset in place of a village — it must not exist yet, like the Citizen)
  if (parsed.intent.name === LOCAL_RESIDENT_JOIN) {
    const link = localResidentProof({ programId: pins.program, seasonAddress: pins.season, asset: parsed.resident.asset, residentProgram: parsed.resident.residentProgram }).link;
    return Object.freeze({ list: [...list, link], citizen, holding: null, link });
  }
  return Object.freeze({ list: holding === null ? list : [...list, holding], citizen, holding });
}

/**
 * Every check above on the accounts as read (`rows`: `{owner, bytes} | null`, in `localResidentAccounts` order; the
 * village row is `undefined` for a command without one). → `{intent, message, signature}`; throws the refusal otherwise.
 */
export function localResidentVerify(parsed, pins, rows, { fail }) {
  const check = (c, code) => { if (!c) fail(code); };
  const [pol, asset, rec, cit, hold] = rows;
  const { resident, intent, tx } = parsed;
  // the policy: this program's, naming the stated resident program
  const policy = pol && pol.owner === pins.program ? decodePolicyRecord(pol.bytes) : null;
  check(policy !== null && policy.residentProgram === resident.residentProgram, 'LocalActResidentUnverified');
  // the asset: Core's, of the policy's collection; its owner NOW is this wallet
  const owned = asset && asset.owner === policy.coreProgram ? decodeAssetOwner(asset.bytes) : null;
  check(owned != null && encode(owned.collection) === policy.collection, 'LocalActResidentUnverified');
  check(encode(owned.owner) === pins.wallet, 'LocalActResidentNotHolder');
  // the record: the resident program's, for this asset; the generation signed is its generation now
  const record = rec && rec.owner === policy.residentProgram ? decodeResident(rec.bytes) : null;
  check(record != null && encode(record.asset) === resident.asset, 'LocalActResidentUnverified');
  check(record.generation === resident.generation, 'LocalActResidentStale');
  if (intent.name === LOCAL_RESIDENT_JOIN) {
    // the first login: neither this asset's Citizen nor its link exists yet in this Season
    check(cit === null && hold === null, 'LocalActAlreadyJoined');
  } else {
    // the Citizen at the asset's address: this program's, marked as THIS asset's resident (never a wallet Citizen)
    const mark = cit && cit.owner === pins.program ? citizenMark(cit.bytes) : null;
    check(mark != null && mark.nft === true && mark.asset === resident.asset, 'LocalActResidentCitizen');
  }
  // the message: rebuilt with the recomputed proof, byte for byte; then the wallet's signature
  const proof = { ...localResidentProof({ programId: pins.program, seasonAddress: pins.season, asset: resident.asset, residentProgram: resident.residentProgram }), residentProgram: resident.residentProgram };
  let expected;
  try {
    expected = localResidentActMessage(intent, { programId: pins.program, seasonAddress: pins.season, wallet: pins.wallet, rulesetHash: pins.rulesetHash, blockhash: tx.recentBlockhash,
      resident: { asset: resident.asset, generation: resident.generation, proof } });
  } catch (e) { fail(e?.code ?? 'LocalActInvalid'); }
  check(Buffer.from(tx.message).equals(Buffer.from(expected)), 'LocalActMessageMismatch');
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(decode(pins.wallet))]), format: 'der', type: 'spki' });
  check(edVerify(null, tx.message, key, tx.signatures[0]), 'LocalActSigner');
  // the village
  const citizenAt = localResidentCitizen(pins.program, resident.asset);
  if (intent.name === LOCAL_RESIDENT_JOIN) { /* no village: checked above (the link) */ }
  else if (intent.name === 'PlaceHome') {
    if (hold) { check(hold.owner === pins.program, 'LocalActHolding'); check(magicOf(hold.bytes) !== WIDE_HOLDING_MAGIC, 'LocalActWideHolding'); }
  } else {
    check(hold != null && hold.owner === pins.program, 'LocalActHolding');
    const magic = magicOf(hold.bytes);
    check(magic !== WIDE_HOLDING_MAGIC, 'LocalActWideHolding'); check(magic === LEGACY_HOLDING_MAGIC, 'LocalActHolding');
    let d; try { d = decodePrefix('Holding', hold.bytes, { profile: profileForHash(pins.rulesetHash) }); } catch { fail('LocalActHolding'); }
    const h = intent.subject.holding;
    check(String(d.seasonId) === String(pins.seasonId) && d.p === h.p && d.q === h.q && d.site === h.site, 'LocalActHolding');
    check(d.ownerCitizen instanceof Uint8Array && d.ownerCitizen.length === 32 && encode(d.ownerCitizen) === citizenAt, 'LocalActNotYourVillage');
  }
  return Object.freeze({ intent, message: Uint8Array.from(tx.message), signature: encode(tx.signatures[0]) });
}

// ---------------------------------------------------------------------------------------------------------------
// The residents read (candidate lane only): the passes THIS relay's wallet holds now, each with its holder generation
// and whether its Citizen exists in this Season — routes/residents.mjs `listResidents`, over the relay's own loopback
// runner. A read: it grants nothing (every command is checked again on its own read before its send).
//   POST /f/local-play/act/residents  {schema: frontier-local-play-nft-residents-v1}
//     → {wallet, policy: {coreProgram, residentProgram, collection, guardAuthority} | null, residents: [{asset, generation, citizen, joined, link}]}
import { PublicKey } from '@solana/web3.js';
import { listResidents, residentAddrs } from './routes/residents.mjs';
export const LOCAL_RESIDENTS_ROUTE = 'POST /f/local-play/act/residents';
export const LOCAL_RESIDENTS_SCHEMA = 'frontier-local-play-nft-residents-v1';

/** A web3.js-Connection-shaped reader over `ask(method, params)` (the relay's JSON-RPC to its runner): three reads. */
export function rpcConnection(ask, fail) {
  const acct = v => (v === null ? null : (() => {
    if (!v || typeof v.owner !== 'string' || !Array.isArray(v.data) || v.data[1] !== 'base64') fail('LocalActRpcUnavailable');
    return { owner: new PublicKey(v.owner), data: Buffer.from(v.data[0], 'base64') };
  })());
  return {
    async getAccountInfo(key, commitment = 'confirmed') { const r = await ask('getAccountInfo', [key.toBase58(), { encoding: 'base64', commitment }]); return acct(r.result?.value ?? null); },
    async getMultipleAccountsInfo(keys, commitment = 'confirmed') {
      const r = await ask('getMultipleAccounts', [keys.map(k => k.toBase58()), { encoding: 'base64', commitment }]);
      const v = r.result?.value; if (!Array.isArray(v) || v.length !== keys.length) fail('LocalActRpcUnavailable');
      return v.map(acct);
    },
    async getProgramAccounts(program, { commitment = 'confirmed', filters = [] } = {}) {
      const r = await ask('getProgramAccounts', [program.toBase58(), { encoding: 'base64', commitment, filters }]);
      const v = r.result; if (!Array.isArray(v) || v.length > 1000) fail('LocalActRpcUnavailable');
      return v.map(x => ({ pubkey: new PublicKey(x.pubkey), account: acct(x.account) }));
    },
  };
}

/** The read for `pins` (candidate lane only; the owner is always the relay's own wallet). */
export async function localResidentsRead(body, pins, { ask, fail }) {
  if (!isCandidateProgram(pins.program)) fail('LocalActNotAllowed');
  if (!exact(body, ['schema']) || body.schema !== LOCAL_RESIDENTS_SCHEMA) fail('LocalActInvalid');
  const A = seasonAddresses(pins.program, String(pins.seasonId));
  const out = await listResidents({ connection: rpcConnection(ask, fail), owner: pins.wallet, addrs: residentAddrs({ programId: pins.program, addresses: A }) });
  return { wallet: pins.wallet, policy: out.policy, residents: out.residents };
}
