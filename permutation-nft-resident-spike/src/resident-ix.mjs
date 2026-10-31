// Instructions of the resident program (program/src/lib.rs) and of Core's
// CreateCollectionV1, built without web3.js (the repository's dependency-free
// codec), for the companion server's setup and the tests. The page builds
// MintResident the same way in the browser (web/mint.mjs).
import { compileMessage, findProgramAddress, wireTransaction } from '../../permutation-gateway/client/src/solana-tx.mjs';
import { base58, pubkeyBytes, utf8 } from './crypto.mjs';
import { MPL_CORE_PROGRAM } from './core-asset.mjs';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TAG = Object.freeze({ INIT_CONFIG: 0x01, SET_PRICE: 0x02, MINT_RESIDENT: 0x50, TRANSFER_RESIDENT: 0x51, SET_SESSION: 0x52, OP: 0x53 });
/** The program's custom error codes (ResidentError in program/src/lib.rs). */
export const RESIDENT_ERRORS = Object.freeze({ 1000: 'BadData', 1001: 'BadAddress', 1002: 'Auth', 1003: 'NotOwner', 1004: 'StaleGen', 1005: 'PriceChanged', 1006: 'WrongTreasury', 1007: 'WrongCollection', 1008: 'AlreadyInitialized', 1009: 'NotInitialized', 1010: 'SessionExpiry' });
/** The real resident account (133 B) offsets. */
export const RESIDENT = Object.freeze({ MAGIC: 0, ASSET: 1, TAG15: 33, GEN: 48, SESSION: 52, SESSION_EXPIRY: 84, SESSION_GEN: 92, SESSION_SETTER: 96, OPS: 128, BUMP: 132, LEN: 133, MAGIC_VALUE: 0xc2 });
/** The config account (106 B). */
export const CONFIG = Object.freeze({ MAGIC: 0, AUTHORITY: 1, TREASURY: 33, COLLECTION: 65, PRICE: 97, BUMP: 105, LEN: 106, MAGIC_VALUE: 0xc1 });

const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return new Uint8Array(b); };
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v)); return new Uint8Array(b); };
const i64 = v => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return new Uint8Array(b); };
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map(p => Buffer.from(p))));
const borshStr = s => { const u = Buffer.from(utf8(s)); return cat(u32(u.length), u); };
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

export function pdas(program) {
  return {
    config: findProgramAddress([utf8('config')], program)[0],
    collectionAuthority: findProgramAddress([utf8('collection-authority')], program)[0],
    resident: asset => findProgramAddress([utf8('resident'), pubkeyBytes(asset)], program)[0],
  };
}

/** Core CreateCollectionV1 (discriminator 1): `{name, uri, plugins: None}`; accounts [collection s,w] [update_authority r] [payer s,w] [system]. */
export function createCollectionIx({ collection, updateAuthority, payer, name, uri }) {
  return { programId: MPL_CORE_PROGRAM, keys: [meta(collection, true, true), meta(updateAuthority, false, false), meta(payer, true, true), meta(SYSTEM_PROGRAM, false, false)], data: cat([1], borshStr(name), borshStr(uri), [0]) };
}
export function initConfigIx({ program, authority, price, treasury, collection }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(authority, true, true), meta(p.config, false, true), meta(SYSTEM_PROGRAM, false, false)], data: cat([TAG.INIT_CONFIG], u64(price), pubkeyBytes(treasury), pubkeyBytes(collection)) };
}
export function setPriceIx({ program, authority, price }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(authority, true, false), meta(p.config, false, true)], data: cat([TAG.SET_PRICE], u64(price)) };
}
export function mintResidentIx({ program, payer, treasury, asset, collection, price }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(payer, true, true), meta(treasury, false, true), meta(asset, true, true), meta(collection, false, true), meta(p.collectionAuthority, false, false), meta(p.resident(asset), false, true), meta(p.config, false, false), meta(MPL_CORE_PROGRAM, false, false), meta(SYSTEM_PROGRAM, false, false)], data: cat([TAG.MINT_RESIDENT], u64(price)) };
}
export function transferResidentIx({ program, owner, asset, collection, to }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(owner, true, false), meta(owner, true, true), meta(asset, false, true), meta(collection, false, true), meta(p.collectionAuthority, false, false), meta(p.resident(asset), false, true), meta(to, false, false), meta(MPL_CORE_PROGRAM, false, false), meta(SYSTEM_PROGRAM, false, false)], data: new Uint8Array([TAG.TRANSFER_RESIDENT]) };
}
export function setSessionIx({ program, owner, asset, session, expiry }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(owner, true, false), meta(asset, false, false), meta(p.resident(asset), false, true)], data: cat([TAG.SET_SESSION], pubkeyBytes(session), i64(expiry)) };
}
export function opIx({ program, actor, asset, gen, nonce = 0 }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(actor, true, false), meta(asset, false, false), meta(p.resident(asset), false, true)], data: cat([TAG.OP], u32(gen), [nonce]) };
}

/** A signed legacy transaction: `feePayer` first, every keypair in `signers` signs. */
export function signedTx({ feePayer, blockhash, instructions, signers }) {
  const message = compileMessage({ feePayer, recentBlockhash: blockhash, instructions });
  const sigs = {};
  for (const kp of signers) sigs[kp.publicKey] = kp.sign(message);
  return { wire: wireTransaction(message, sigs), signature: base58(sigs[feePayer]) };
}

/** Decode the real resident account; null if it is not one. */
export function decodeResidentAccount(data) {
  if (!data || data.length !== RESIDENT.LEN || data[RESIDENT.MAGIC] !== RESIDENT.MAGIC_VALUE) return null;
  const b = Buffer.from(data);
  return { asset: base58(data.subarray(RESIDENT.ASSET, RESIDENT.ASSET + 32)), tag15: Buffer.from(data.subarray(RESIDENT.TAG15, RESIDENT.TAG15 + 15)).toString('hex'), gen: b.readUInt32LE(RESIDENT.GEN), session: base58(data.subarray(RESIDENT.SESSION, RESIDENT.SESSION + 32)), sessionExpiry: b.readBigInt64LE(RESIDENT.SESSION_EXPIRY), sessionGen: b.readUInt32LE(RESIDENT.SESSION_GEN), sessionSetter: base58(data.subarray(RESIDENT.SESSION_SETTER, RESIDENT.SESSION_SETTER + 32)), ops: b.readUInt32LE(RESIDENT.OPS) };
}
export function decodeConfigAccount(data) {
  if (!data || data.length !== CONFIG.LEN || data[CONFIG.MAGIC] !== CONFIG.MAGIC_VALUE) return null;
  return { authority: base58(data.subarray(CONFIG.AUTHORITY, CONFIG.AUTHORITY + 32)), treasury: base58(data.subarray(CONFIG.TREASURY, CONFIG.TREASURY + 32)), collection: base58(data.subarray(CONFIG.COLLECTION, CONFIG.COLLECTION + 32)), price: Buffer.from(data).readBigUInt64LE(CONFIG.PRICE) };
}
/** The getProgramAccounts memcmp bytes for `update_authority = Collection(c)`: discriminant 2 then the key. */
export const collectionFilter = collection => base58(cat([2], pubkeyBytes(collection)));
/** A custom program error code out of an RPC error (preflight) or a status error. */
export function customCode(errLike) {
  const s = JSON.stringify(errLike ?? '');
  const m = /"Custom":(\d+)/.exec(s) || /custom program error: 0x([0-9a-f]+)/i.exec(s);
  return m ? (m[0].startsWith('"Custom"') ? Number(m[1]) : parseInt(m[1], 16)) : null;
}
