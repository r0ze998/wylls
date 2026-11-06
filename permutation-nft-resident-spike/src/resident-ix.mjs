// Instructions of the resident program (program/src/lib.rs) and of Core's
// CreateCollectionV1, built without web3.js (the repository's dependency-free
// codec), for the companion server's setup and the tests. The page builds
// MintResident the same way in the browser (web/mint.mjs).
import { compileMessage, findProgramAddress, wireTransaction } from '../../permutation-gateway/client/src/solana-tx.mjs';
import { base58, pubkeyBytes, utf8 } from './crypto.mjs';
import { MPL_CORE_PROGRAM } from './core-asset.mjs';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TAG = Object.freeze({ INIT_CONFIG: 0x01, SET_PRICE: 0x02, SET_TERMS: 0x03, SET_TREASURY: 0x04, SET_METADATA: 0x05, PROPOSE_AUTHORITY: 0x06, ACCEPT_AUTHORITY: 0x07,
  MINT_RESIDENT: 0x50, TRANSFER_RESIDENT: 0x51, SET_SESSION: 0x52, OP: 0x53 });
/** The program's custom error codes (ResidentError in program/src/lib.rs). */
export const RESIDENT_ERRORS = Object.freeze({ 1000: 'BadData', 1001: 'BadAddress', 1002: 'Auth', 1003: 'NotOwner', 1004: 'StaleGen', 1005: 'PriceChanged', 1006: 'WrongTreasury', 1007: 'WrongCollection', 1008: 'AlreadyInitialized', 1009: 'NotInitialized', 1010: 'SessionExpiry',
  1011: 'NotUpgradeAuthority', 1012: 'SaleClosed', 1013: 'SupplyNotSet', 1014: 'SoldOut', 1015: 'SaleNotStarted', 1016: 'SaleEnded', 1017: 'WalletLimit', 1018: 'BadTerms', 1019: 'MetadataNotSet' });
/** The real resident account (133 B) offsets. */
export const RESIDENT = Object.freeze({ MAGIC: 0, ASSET: 1, TAG15: 33, GEN: 48, SESSION: 52, SESSION_EXPIRY: 84, SESSION_GEN: 92, SESSION_SETTER: 96, OPS: 128, BUMP: 132, LEN: 133, MAGIC_VALUE: 0xc2 });
/** The config account (106 B). */
/** Config layout v2 (program/src/lib.rs `config`): sale terms, metadata, the authority hand-over. */
export const CONFIG = Object.freeze({ MAGIC: 0, AUTHORITY: 1, TREASURY: 33, COLLECTION: 65, PRICE: 97, BUMP: 105, PENDING: 106, MAX_SUPPLY: 138, MINTED: 146,
  SALE_START: 154, SALE_END: 162, PER_WALLET: 170, OPEN: 172, NAME_LEN: 173, NAME: 174, URI_LEN: 206, URI: 207, LEN: 407, MAGIC_VALUE: 0xc3, NAME_MAX: 32, URI_MAX: 200 });
export const MINTER = Object.freeze({ MAGIC: 0, WALLET: 1, MINTED: 33, BUMP: 35, LEN: 36, MAGIC_VALUE: 0xc4 });

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
    /** The payer's per-wallet count (`["minted-by", wallet]`); created only when a per-wallet limit is set. */
    minter: wallet => findProgramAddress([utf8('minted-by'), pubkeyBytes(wallet)], program)[0],
  };
}

/** Core CreateCollectionV1 (discriminator 1): `{name, uri, plugins: None}`; accounts [collection s,w] [update_authority r] [payer s,w] [system]. */
export function createCollectionIx({ collection, updateAuthority, payer, name, uri }) {
  return { programId: MPL_CORE_PROGRAM, keys: [meta(collection, true, true), meta(updateAuthority, false, false), meta(payer, true, true), meta(SYSTEM_PROGRAM, false, false)], data: cat([1], borshStr(name), borshStr(uri), [0]) };
}
/** The program's LoaderV3 ProgramData address (`[program]` under the upgradeable loader). */
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const programDataAddress = program => findProgramAddress([pubkeyBytes(program)], BPF_LOADER_UPGRADEABLE)[0];
/** InitConfig: only the program's upgrade authority may sign it (the program reads its ProgramData). */
export function initConfigIx({ program, authority, price, treasury, collection, programData = programDataAddress(program) }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(authority, true, true), meta(p.config, false, true), meta(SYSTEM_PROGRAM, false, false), meta(program, false, false), meta(programData, false, false)],
    data: cat([TAG.INIT_CONFIG], u64(price), pubkeyBytes(treasury), pubkeyBytes(collection)) };
}
export function setPriceIx({ program, authority, price }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(authority, true, false), meta(p.config, false, true)], data: cat([TAG.SET_PRICE], u64(price)) };
}
export function mintResidentIx({ program, payer, treasury, asset, collection, price }) {
  const p = pdas(program);
  return { programId: program, keys: [meta(payer, true, true), meta(treasury, false, true), meta(asset, true, true), meta(collection, false, true), meta(p.collectionAuthority, false, false), meta(p.resident(asset), false, true), meta(p.config, false, true), meta(MPL_CORE_PROGRAM, false, false), meta(SYSTEM_PROGRAM, false, false), meta(p.minter(payer), false, true)], data: cat([TAG.MINT_RESIDENT], u64(price)) };
}
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); return b; };
const authorityKeys = (program, authority) => [meta(authority, true, false), meta(pdas(program).config, false, true)];
/** SetTerms: every value is the config authority's; `open` false keeps the sale closed. */
export function setTermsIx({ program, authority, maxSupply, saleStart = 0, saleEnd = 0, perWallet = 0, open }) {
  return { programId: program, keys: authorityKeys(program, authority), data: cat([TAG.SET_TERMS], u64(maxSupply), i64(saleStart), i64(saleEnd), u16(perWallet), [open ? 1 : 0]) };
}
export function setTreasuryIx({ program, authority, treasury }) {
  return { programId: program, keys: authorityKeys(program, authority), data: cat([TAG.SET_TREASURY], pubkeyBytes(treasury)) };
}
/** SetMetadata: the NFT's name and URI (UTF-8, at most 32 and 200 bytes). */
export function setMetadataIx({ program, authority, name, uri }) {
  const n = utf8(name), u = utf8(uri);
  if (n.length > CONFIG.NAME_MAX || u.length > CONFIG.URI_MAX) throw new RangeError('name ≤ 32 B, uri ≤ 200 B');
  return { programId: program, keys: authorityKeys(program, authority), data: cat([TAG.SET_METADATA], [n.length], n, [u.length], u) };
}
export function proposeAuthorityIx({ program, authority, next }) {
  return { programId: program, keys: authorityKeys(program, authority), data: cat([TAG.PROPOSE_AUTHORITY], pubkeyBytes(next)) };
}
export function acceptAuthorityIx({ program, next }) {
  return { programId: program, keys: [meta(next, true, false), meta(pdas(program).config, false, true)], data: Uint8Array.from([TAG.ACCEPT_AUTHORITY]) };
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
  const b = Buffer.from(data);
  const key = o => base58(data.subarray(o, o + 32));
  const text = (lo, o) => b.subarray(o, o + b[lo]).toString('utf8');
  const pending = key(CONFIG.PENDING);
  return {
    authority: key(CONFIG.AUTHORITY), treasury: key(CONFIG.TREASURY), collection: key(CONFIG.COLLECTION), price: b.readBigUInt64LE(CONFIG.PRICE),
    pendingAuthority: pending === '11111111111111111111111111111111' ? null : pending,
    terms: {
      price: b.readBigUInt64LE(CONFIG.PRICE), maxSupply: b.readBigUInt64LE(CONFIG.MAX_SUPPLY), minted: b.readBigUInt64LE(CONFIG.MINTED),
      saleStart: b.readBigInt64LE(CONFIG.SALE_START), saleEnd: b.readBigInt64LE(CONFIG.SALE_END), perWallet: b.readUInt16LE(CONFIG.PER_WALLET),
      open: b[CONFIG.OPEN] === 1, name: text(CONFIG.NAME_LEN, CONFIG.NAME), uri: text(CONFIG.URI_LEN, CONFIG.URI),
    },
  };
}
export function decodeMinterAccount(data) {
  if (!data || data.length !== MINTER.LEN || data[MINTER.MAGIC] !== MINTER.MAGIC_VALUE) return null;
  return { wallet: base58(data.subarray(MINTER.WALLET, MINTER.WALLET + 32)), minted: Buffer.from(data).readUInt16LE(MINTER.MINTED) };
}
/** The getProgramAccounts memcmp bytes for `update_authority = Collection(c)`: discriminant 2 then the key. */
export const collectionFilter = collection => base58(cat([2], pubkeyBytes(collection)));
/** A custom program error code out of an RPC error (preflight) or a status error. */
export function customCode(errLike) {
  const s = JSON.stringify(errLike ?? '');
  const m = /"Custom":(\d+)/.exec(s) || /custom program error: 0x([0-9a-f]+)/i.exec(s);
  return m ? (m[0].startsWith('"Custom"') ? Number(m[1]) : parseInt(m[1], 16)) : null;
}
