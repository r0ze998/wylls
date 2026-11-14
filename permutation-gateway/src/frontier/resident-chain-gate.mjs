// ⑳ NFT residents (provisional, nft-experimental programs): the relay's holder
// gate read from the chain, for a Frontier program whose Seasons have NFT
// Citizens. It is what `ctx.residents` expects (routes/relay.mjs
// `residentRefusal`): `check({ citizen, actor, resident }) → { ok, code? }`.
//
// The program itself refuses every one of these cases on every instruction
// (the live Core owner, the transfer guard and the resident program's
// generation, `frontier_abi::resident_auth`). The gate refuses them before the
// relay co-signs and pays: a wallet that holds no pass, the old holder after a
// transfer, a generation signed before the transfer, a wrapper naming another
// asset than the Citizen's, and a ResidentAct around a wallet Citizen.
// It reads the chain on every wrapped call (no cache): an index or a notice
// never grants anything. A call without a wrapper (every wallet player's, on
// every world) is passed without a read: an NFT Citizen's WALLET is zero, so
// no wallet signature can act for it and the program refuses such a call.
//
// `getAccount(address) → { owner, data } | null` is the only input (a
// web3.js Connection adapts to it with `fromConnection`); nothing here holds
// a key or signs.
import { encode as b58 } from '../../client/src/base58.mjs';
import { LAYOUTS as V2 } from '../../client/src/frontier/abi-v2-layouts.mjs';
import { decodeAssetOwner, decodeResident, policyAddress, residentAddress } from '../../client/src/frontier/resident.mjs';

export const RESIDENT_GATE_CODES = Object.freeze({
  UNVERIFIED: 'ResidentUnverified',          // a read failed, or an account is not what it must be
  NOT_HOLDER: 'ResidentHolderChanged',       // the signer is not the asset's owner now (no pass, or transferred away)
  STALE: 'ResidentGenerationStale',          // signed for an earlier holder generation
  WRONG_ASSET: 'ResidentAssetMismatch',      // the wrapper's asset is not the Citizen's
  NOT_NFT: 'ResidentNotNft',                 // ResidentAct around a wallet Citizen
});
const C = RESIDENT_GATE_CODES;

const CITIZEN = V2.accounts.find(a => a.kind === 'Citizen');
const field = name => CITIZEN.fields.find(f => f.name === name);
/** frontier-abi `resident_citizen`: the asset in the first 32 bytes of RSV_348, the flag byte after, WALLET zero. */
export const CITIZEN_MARK = Object.freeze({ SIZE: CITIZEN.size, WALLET: field('WALLET').off, ASSET: 348, FLAGS: 380, FLAG_RESIDENT: 1, MAGIC: CITIZEN.magic });
if (field('RSV_348')?.off !== CITIZEN_MARK.ASSET || CITIZEN_MARK.ASSET + 32 !== CITIZEN_MARK.FLAGS) throw new Error('resident-chain-gate: the Citizen layout has no resident mark where frontier-abi puts it');

/**
 * The resident mark of a Citizen's bytes: `{ nft: false }` for a wallet Citizen,
 * `{ nft: true, asset }` for a valid NFT Citizen, `{ nft: true, asset: null }` for an
 * invalid mark (a non-zero WALLET or a zero asset: the program never writes one).
 */
export function citizenMark(data) {
  const b = Uint8Array.from(data ?? []);
  if (b.length !== CITIZEN_MARK.SIZE || String.fromCharCode(...b.slice(0, 8)) !== CITIZEN_MARK.MAGIC) return null;
  if ((b[CITIZEN_MARK.FLAGS] & CITIZEN_MARK.FLAG_RESIDENT) === 0) return { nft: false };
  const asset = b.slice(CITIZEN_MARK.ASSET, CITIZEN_MARK.ASSET + 32);
  const walletZero = b.slice(CITIZEN_MARK.WALLET, CITIZEN_MARK.WALLET + 32).every(x => x === 0);
  return { nft: true, asset: walletZero && asset.some(x => x !== 0) ? b58(asset) : null };
}

/** The policy record (`PSFNP002`, 136 B) → its four addresses, or null (as routes/residents.mjs `decodePolicy`). */
export function decodePolicyRecord(d) {
  const b = Uint8Array.from(d ?? []);
  if (b.length !== 136 || String.fromCharCode(...b.slice(0, 8)) !== 'PSFNP002') return null;
  const k = o => b58(b.slice(o, o + 32));
  return { coreProgram: k(8), residentProgram: k(40), collection: k(72), guardAuthority: k(104) };
}

const refuse = code => ({ ok: false, code });
const OK = Object.freeze({ ok: true });

/**
 * The gate for the Frontier program `programId`.
 * - `check({ citizen, actor, resident })`: `resident` is the classified shape's
 *   `resident` (`{generation, asset, resident, …}`) for ResidentAct, absent otherwise.
 *   Without it the call passes with no read (nothing changes for wallet players).
 * - `checkJoin({ owner, resident })`: a JoinResident's owner and signed generation.
 */
export function createResidentChainGate({ programId, getAccount }) {
  if (!programId || typeof getAccount !== 'function') throw new TypeError('createResidentChainGate: programId and getAccount');
  const policyKey = policyAddress(programId);

  /** The holder rules on the chain now: policy, asset (Core, collection, owner), resident record (generation). */
  async function holderCheck(asset, actor, signed) {
    const pol = await getAccount(policyKey);
    const policy = pol && pol.owner === programId ? decodePolicyRecord(pol.data) : null;
    if (!policy) return refuse(C.UNVERIFIED);
    if (signed.asset && signed.asset !== asset) return refuse(C.WRONG_ASSET);
    const a = await getAccount(asset);
    if (!a) return refuse(C.UNVERIFIED);
    const owned = a.owner === policy.coreProgram ? decodeAssetOwner(a.data) : null;
    if (!owned || b58(owned.collection) !== policy.collection) return refuse(C.UNVERIFIED);
    if (b58(owned.owner) !== actor) return refuse(C.NOT_HOLDER);
    const recordKey = residentAddress(policy.residentProgram, asset);
    if (signed.resident && signed.resident !== recordKey) return refuse(C.UNVERIFIED);
    const r = await getAccount(recordKey);
    const rec = r && r.owner === policy.residentProgram ? decodeResident(r.data) : null;
    if (!rec || b58(rec.asset) !== asset) return refuse(C.UNVERIFIED);
    if (!Number.isInteger(signed.generation) || rec.generation !== signed.generation) return refuse(C.STALE);
    return OK;
  }

  return {
    async check({ citizen, actor, resident = null }) {
      if (!resident) return OK;
      const c = await getAccount(citizen);
      if (!c || c.owner !== programId) return refuse(C.UNVERIFIED);
      const mark = citizenMark(c.data);
      if (!mark) return refuse(C.UNVERIFIED);
      if (!mark.nft) return refuse(C.NOT_NFT);
      if (!mark.asset) return refuse(C.UNVERIFIED);
      return holderCheck(mark.asset, actor, resident);
    },
    async checkJoin({ owner, resident }) {
      if (!resident?.asset) return refuse(C.UNVERIFIED);
      return holderCheck(resident.asset, owner, resident);
    },
  };
}

/** `getAccount` over a web3.js Connection (`confirmed`, as every relay read). */
export function fromConnection(connection, PublicKey) {
  return async address => {
    const info = await connection.getAccountInfo(new PublicKey(address), 'confirmed');
    return info ? { owner: info.owner.toBase58(), data: Uint8Array.from(info.data) } : null;
  };
}
