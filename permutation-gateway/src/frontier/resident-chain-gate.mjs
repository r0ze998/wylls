// ⑳ NFT residents (provisional, nft-experimental programs): the relay's holder
// gate read from the chain, for a Frontier program whose Seasons have NFT
// Citizens. It is what `ctx.residents` expects (routes/relay.mjs
// `residentRefusal`): `check({ citizen, actor, resident }) → { ok, code? }`.
//
// It applies the program's own holder rules (`frontier_abi::resident_auth::holder`
// and `Holder::authority`, in the same order) to the same accounts, read at
// `confirmed`, before the relay co-signs and pays the fee:
//   1. the asset: owned by the policy's Core program, an AssetV1 of the policy's
//      collection with a well-formed name and uri (else ResidentUnverified: a
//      forged collection or a look-alike program);
//   2. the transfer guard (`resident_guard::check`): a frozen Permanent Freeze
//      Delegate and a Permanent Transfer Delegate whose authority is the policy's
//      guard address, i.e. the resident program's collection-authority (else
//      ResidentUnguarded: an asset a plain Core transfer could move without a new
//      generation);
//   3. the resident record: the resident program's, 133 B, of this asset;
//   4. the signed generation equals the record's (else ResidentGenerationStale:
//      signed before a transfer, A→B→A included), then the actor is the asset's
//      owner or the owner's live session of this generation (else
//      ResidentHolderChanged: no pass, or the old holder after a transfer).
// What only the program decides: the Citizen's address and its link, the
// season and its gates, a session's expiry on the chain clock (`now` is
// optional here), and everything the inner instruction checks. A pass here is
// not authority: the program decides again in the same transaction, and a
// change that lands between this read and the transaction (a transfer racing
// the send) fails on chain, where the relay pays that one fee.
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
import { decodeResident, guardAuthorityAddress, policyAddress, residentAddress } from '../../client/src/frontier/resident.mjs';

export const RESIDENT_GATE_CODES = Object.freeze({
  UNVERIFIED: 'ResidentUnverified',          // a read failed, or an account is not what it must be
  NOT_HOLDER: 'ResidentHolderChanged',       // the signer is not the asset's owner now (no pass, or transferred away)
  STALE: 'ResidentGenerationStale',          // signed for an earlier holder generation
  WRONG_ASSET: 'ResidentAssetMismatch',      // the wrapper's asset is not the Citizen's
  NOT_NFT: 'ResidentNotNft',                 // ResidentAct around a wallet Citizen
  UNGUARDED: 'ResidentUnguarded',            // the asset lacks the resident program's transfer guard
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

const u32 = (d, o) => (o + 4 <= d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] * 2 ** 24)) : null);
const u64 = (d, o) => { const lo = u32(d, o), hi = u32(d, o + 4); return lo === null || hi === null ? null : hi * 2 ** 32 + lo; };
const utf8ok = b => { try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; } };

/** `resident_guard::asset_base_end`: where the AssetV1 base ends (key, owner, update authority, name, uri, seq), or null. */
export function assetBaseEnd(d) {
  if (d[0] !== 1 || d.length < 34) return null;
  let pos = 33;
  if (d[pos] === 0) pos += 1; else if (d[pos] === 1 || d[pos] === 2) pos += 33; else return null;
  for (let i = 0; i < 2; i++) {
    const len = u32(d, pos);
    if (len === null || pos + 4 + len > d.length || !utf8ok(d.subarray(pos + 4, pos + 4 + len))) return null;
    pos += 4 + len;
  }
  if (d[pos] === 0) return pos + 1;
  if (d[pos] === 1 && pos + 9 <= d.length) return pos + 9;
  return null;
}

/** `resident_auth::holder`'s asset test: an AssetV1 of `collection` with a readable base. The owner, or null. */
export function assetOwnerIn(d, collection) {
  if (d.length < 66 || d[0] !== 1 || d[33] !== 2 || b58(d.slice(34, 66)) !== collection || assetBaseEnd(d) === null) return null;
  return b58(d.slice(1, 33));
}

/**
 * `resident_guard::check`: the asset carries a frozen Permanent Freeze Delegate (5) and a Permanent Transfer
 * Delegate (7), both with `Address(guard)` authority, in a well-formed plugin registry. Returns null when guarded,
 * else the refusal ('NotAsset' | 'NoRegistry' | 'NotFrozen' | 'NoTransferDelegate').
 */
export function guardRefusal(d, guard) {
  const base = assetBaseEnd(d);
  if (base === null) return 'NotAsset';
  if (d[base] !== 3) return 'NoRegistry';
  const reg = u64(d, base + 1);
  if (reg === null || reg < base + 9 || d[reg] !== 4) return 'NoRegistry';
  const n = u32(d, reg + 1);
  if (n === null || n > 32) return 'NoRegistry';
  const g = typeof guard === 'string' ? guard : b58(guard);
  let frozen = false, transfer = false, pos = reg + 5;
  for (let i = 0; i < n; i++) {
    const kind = d[pos], auth = d[pos + 1];
    if (kind === undefined || auth === undefined) return 'NoRegistry';
    let address = null, next;
    if (auth === 3) { if (pos + 34 > d.length) return 'NoRegistry'; address = b58(d.slice(pos + 2, pos + 34)); next = pos + 34; }
    else if (auth <= 2) next = pos + 2;
    else return 'NoRegistry';
    const offset = u64(d, next);
    if (offset === null || offset < base + 9 || offset >= reg || d[offset] !== kind) return 'NoRegistry';
    if (address === g) {
      if (kind === 5) frozen ||= d[offset + 1] === 1;
      if (kind === 7) transfer = true;
    }
    pos = next + 8;
  }
  if (u32(d, pos) === null) return 'NoRegistry';
  if (!frozen) return 'NotFrozen';
  if (!transfer) return 'NoTransferDelegate';
  return null;
}

const refuse = code => ({ ok: false, code });
const OK = Object.freeze({ ok: true });

/**
 * The gate for the Frontier program `programId`.
 * - `check({ citizen, actor, resident })`: `resident` is the classified shape's
 *   `resident` (`{generation, asset, resident, …}`) for ResidentAct, absent otherwise.
 *   Without it the call passes with no read (nothing changes for wallet players).
 * - `checkJoin({ owner, resident })`: a JoinResident's owner and signed generation (the owner itself:
 *   the program takes no session for the first login).
 * `now()` (optional, unix seconds of the chain clock) lets a session's expiry be checked here too;
 * without it a session's expiry is left to the program.
 */
export function createResidentChainGate({ programId, getAccount, now = null }) {
  if (!programId || typeof getAccount !== 'function') throw new TypeError('createResidentChainGate: programId and getAccount');
  const policyKey = policyAddress(programId);

  /** `resident_auth::holder` then `Holder::authority`, on the chain now (see the header). */
  async function holderCheck(asset, actor, signed, { sessionAllowed }) {
    const pol = await getAccount(policyKey);
    const policy = pol && pol.owner === programId ? decodePolicyRecord(pol.data) : null;
    if (!policy || policy.guardAuthority !== guardAuthorityAddress(policy.residentProgram)) return refuse(C.UNVERIFIED);
    if (signed.asset && signed.asset !== asset) return refuse(C.WRONG_ASSET);
    const a = await getAccount(asset);
    const ad = a ? Uint8Array.from(a.data) : null;
    const owner = a && a.owner === policy.coreProgram ? assetOwnerIn(ad, policy.collection) : null;
    if (!owner) return refuse(C.UNVERIFIED);
    if (guardRefusal(ad, policy.guardAuthority) !== null) return refuse(C.UNGUARDED);
    const recordKey = residentAddress(policy.residentProgram, asset);
    if (signed.resident && signed.resident !== recordKey) return refuse(C.UNVERIFIED);
    const r = await getAccount(recordKey);
    const rec = r && r.owner === policy.residentProgram ? decodeResident(r.data) : null;
    if (!rec || b58(rec.asset) !== asset) return refuse(C.UNVERIFIED);
    if (!Number.isInteger(signed.generation) || rec.generation !== signed.generation) return refuse(C.STALE);
    if (actor === owner) return OK;
    const session = b58(rec.session);
    const live = rec.session.some(x => x !== 0) && b58(rec.sessionSetter) === owner && rec.sessionGeneration === rec.generation;
    if (sessionAllowed && live && actor === session && (now === null || BigInt(Math.floor(now())) < rec.sessionExpiry)) return OK;
    return refuse(C.NOT_HOLDER);
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
      return holderCheck(mark.asset, actor, resident, { sessionAllowed: true });
    },
    async checkJoin({ owner, resident }) {
      if (!resident?.asset) return refuse(C.UNVERIFIED);
      return holderCheck(resident.asset, owner, resident, { sessionAllowed: false });
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
