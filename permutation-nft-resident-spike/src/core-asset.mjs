// Metaplex Core assets, as the verifier reads them (metaplex.com/docs/core,
// mpl-core programs/mpl-core/src/state/asset.rs, update_authority.rs):
//
//   AssetV1 { key: Key (u8) = 1, owner: Pubkey, update_authority:
//     UpdateAuthority { None = 0 | Address(Pubkey) = 1 | Collection(Pubkey) = 2 },
//     name: String (u32 len ‖ utf8), uri: String, seq: Option<u64> (u8 ‖ u64) }
//
// The account is owned by the Core program `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`.
// An asset belongs to a collection **only** when `update_authority` is
// `Collection(address)` with the expected collection address (the Core JS
// helper `collectionAddress()` reads it the same way). A transfer changes
// `owner` and nothing else, and revokes the owner-managed Transfer, Burn
// and Freeze delegates (docs/core/transfer).
//
// What is NOT read for authorization here, on purpose: name, uri, the
// off-chain JSON, the collection's name or image. Those are display data
// and anyone can mint an asset carrying the same strings into a collection
// of their own.
//
// Mock boundary: `encodeAssetV1` is used by the mock chain to produce the
// same base bytes a real asset account carries, so the decoder below is the
// one a real RPC adapter would use. Plugins (frozen state in the
// FreezeDelegate plugin, Attributes, Oracle) live after the base struct in a
// plugin registry this spike does not decode: `frozen` is read from the mock
// chain's account flags and marked as such (`source: 'mock-flag'`).
import { base58, pubkeyBytes, utf8 } from './crypto.mjs';

export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
/** mpl-core `Key` discriminators (state/mod.rs). Pinned here; re-check against the source at integration. */
export const KEY = Object.freeze({ Uninitialized: 0, AssetV1: 1, HashedAssetV1: 2, PluginHeaderV1: 3, PluginRegistryV1: 4, CollectionV1: 5 });
export const UPDATE_AUTHORITY = Object.freeze({ None: 0, Address: 1, Collection: 2 });
const UA_NAME = ['None', 'Address', 'Collection'];

const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = s => { const u = Buffer.from(utf8(s)); return Buffer.concat([u32le(u.length), u]); };

/** The Borsh bytes of an AssetV1 base struct (what the mock chain stores). */
export function encodeAssetV1({ owner, updateAuthority, name = '', uri = '', seq = null }) {
  const ua = updateAuthority ?? { type: 'None' };
  const uaCode = UPDATE_AUTHORITY[ua.type];
  if (uaCode === undefined) throw new TypeError(`update authority type ${ua.type}`);
  const parts = [Buffer.from([KEY.AssetV1]), Buffer.from(pubkeyBytes(owner)), Buffer.from([uaCode])];
  if (uaCode !== UPDATE_AUTHORITY.None) parts.push(Buffer.from(pubkeyBytes(ua.address)));
  parts.push(str(name), str(uri));
  parts.push(seq === null || seq === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u64le(seq)]));
  return new Uint8Array(Buffer.concat(parts));
}

/** The Borsh bytes of a CollectionV1 base struct `{key = 5, update_authority: Pubkey, name, uri, num_minted: u32, current_size: u32}`. */
export function encodeCollectionV1({ updateAuthority, name = '', uri = '', numMinted = 0, currentSize = 0 }) {
  return new Uint8Array(Buffer.concat([Buffer.from([KEY.CollectionV1]), Buffer.from(pubkeyBytes(updateAuthority)), str(name), str(uri), u32le(numMinted), u32le(currentSize)]));
}

class Reader {
  constructor(bytes) { this.b = Buffer.from(bytes); this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new RangeError('truncated'); }
  u8() { this.need(1); return this.b[this.o++]; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  key() { this.need(32); const v = base58(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  string() { const n = this.u32(); if (n > 1 << 16) throw new RangeError('string too long'); this.need(n); const s = new TextDecoder('utf-8', { fatal: true }).decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
}

/** Decode an AssetV1 base struct; throws on anything that is not one (the key byte included). */
export function decodeAssetV1(bytes) {
  const r = new Reader(bytes);
  const key = r.u8();
  if (key !== KEY.AssetV1) throw new RangeError(`not an AssetV1 (key ${key})`);
  const owner = r.key();
  const code = r.u8();
  const type = UA_NAME[code];
  if (!type) throw new RangeError(`update authority discriminator ${code}`);
  const updateAuthority = type === 'None' ? { type } : { type, address: r.key() };
  const name = r.string();
  const uri = r.string();
  const seqTag = r.u8();
  const seq = seqTag === 0 ? null : seqTag === 1 ? r.u64() : (() => { throw new RangeError('seq option'); })();
  return { key, owner, updateAuthority, name, uri, seq, baseLength: r.o };
}

export const ASSET_REFUSALS = Object.freeze({
  NO_ACCOUNT: 'NoAccount',          // nothing at that address (or the read did not reach the chain)
  WRONG_PROGRAM: 'WrongProgram',    // the account is not owned by the Core program (a look-alike from another program)
  NOT_AN_ASSET: 'NotAnAsset',       // the key byte is not AssetV1 (a collection, a plugin header, garbage)
  MALFORMED: 'Malformed',           // the bytes do not decode
  NOT_IN_COLLECTION: 'NotInCollection', // update authority is not Collection(expected): same name in another collection, or no collection
  FROZEN: 'Frozen',                 // frozen assets cannot move; reported, and the caller decides whether a frozen resident may act
});

/**
 * Verify one account snapshot as a resident asset of `expected` =
 * `{program, collection}`. Returns `{ok: true, holder, asset, frozen}` or
 * `{ok: false, code, detail}`. Name and uri are returned for display only
 * and never compared.
 */
export function verifyResidentAsset({ account, expected }) {
  const program = expected?.program ?? MPL_CORE_PROGRAM;
  if (!account) return { ok: false, code: ASSET_REFUSALS.NO_ACCOUNT };
  if (account.owner !== program) return { ok: false, code: ASSET_REFUSALS.WRONG_PROGRAM, detail: { programOwner: account.owner } };
  let asset;
  try {
    asset = decodeAssetV1(account.data);
  } catch (e) {
    const key = account.data?.[0];
    if (key !== undefined && key !== KEY.AssetV1) return { ok: false, code: ASSET_REFUSALS.NOT_AN_ASSET, detail: { key } };
    return { ok: false, code: ASSET_REFUSALS.MALFORMED, detail: { message: e.message } };
  }
  if (asset.updateAuthority.type !== 'Collection' || asset.updateAuthority.address !== expected.collection) {
    return { ok: false, code: ASSET_REFUSALS.NOT_IN_COLLECTION, detail: { updateAuthority: asset.updateAuthority, expected: expected.collection } };
  }
  const frozen = account.flags?.frozen === true;
  return { ok: true, holder: asset.owner, asset: { address: account.address ?? null, name: asset.name, uri: asset.uri, seq: asset.seq }, frozen, frozenSource: frozen ? 'mock-flag' : null };
}
