// Two resident backends for the gateway regression tests, driven the same way:
//   mockResidents()     the resident program's rules in memory (Core AssetV1 bytes and the
//                       real 133-byte resident layout), with a switch that breaks every read;
//   realResidents()     the REAL Metaplex Core binary and the REAL resident program on a
//                       loopback solana-test-validator (src/localnet.mjs), driven by real
//                       transactions; the gate reads them over JSON-RPC.
// The Frontier side (Citizen, relay, agent wallet) is the gateway's own scripted chain in
// both cases: the Frontier program is not on the validator.
// Keys: throwaway, from fixed test seeds (the same seed gives the gateway's web3 Keypair).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { MPL_CORE_PROGRAM, encodeAssetV1 } from '../src/core-asset.mjs';
import { keypair, randomAddress, fromHex } from '../src/crypto.mjs';
import { residentTag15 } from '../src/ids.mjs';
import { localnetAvailable, setupWorld, startValidator, TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { RESIDENT, mintResidentIx, pdas, setSessionIx, signedTx, transferResidentIx, customCode } from '../src/resident-ix.mjs';
import { pubkeyBytes } from '../src/crypto.mjs';

const gwRequire = createRequire(new URL('../../permutation-gateway/package.json', import.meta.url));
export const gatewayAvailable = () => { try { gwRequire.resolve('@solana/web3.js'); return true; } catch { return false; } };
export const realAvailable = () => gatewayAvailable() && localnetAvailable();

/** A test actor from a label: the spike's signer (resident program) and the gateway's web3 Keypair, one key. */
export function actor(label) {
  const seed = createHash('sha256').update(`ws20-gateway-test:${label}`).digest();
  const { Keypair } = gwRequire('@solana/web3.js');
  const spike = keypair(seed);
  const web3 = Keypair.fromSeed(seed);
  if (web3.publicKey.toBase58() !== spike.publicKey) throw new Error('seed mismatch');
  return { label, pub: spike.publicKey, spike, web3 };
}

const ZERO = '11111111111111111111111111111111';

/** The real resident account layout (program/src/lib.rs, 133 bytes). */
function encodeResident({ asset, gen, session = ZERO, sessionExpiry = 0, sessionGen = 0, sessionSetter = ZERO, ops = 0 }) {
  const b = Buffer.alloc(RESIDENT.LEN);
  b[RESIDENT.MAGIC] = RESIDENT.MAGIC_VALUE;
  Buffer.from(pubkeyBytes(asset)).copy(b, RESIDENT.ASSET);
  Buffer.from(residentTag15(asset)).copy(b, RESIDENT.TAG15);
  b.writeUInt32LE(gen, RESIDENT.GEN);
  Buffer.from(pubkeyBytes(session)).copy(b, RESIDENT.SESSION);
  b.writeBigInt64LE(BigInt(sessionExpiry), RESIDENT.SESSION_EXPIRY);
  b.writeUInt32LE(sessionGen, RESIDENT.SESSION_GEN);
  Buffer.from(pubkeyBytes(sessionSetter)).copy(b, RESIDENT.SESSION_SETTER);
  b.writeUInt32LE(ops, RESIDENT.OPS);
  return new Uint8Array(b);
}

export function mockResidents() {
  const program = TEST_PROGRAM_ID;
  const collection = randomAddress();
  const p = pdas(program);
  const accounts = new Map();
  const residents = new Map();   // asset → {holder, gen, session, sessionExpiry, sessionGen, sessionSetter}
  let broken = false;
  const write = asset => {
    const r = residents.get(asset);
    accounts.set(asset, { owner: MPL_CORE_PROGRAM, data: encodeAssetV1({ owner: r.holder, updateAuthority: { type: 'Collection', address: collection }, name: 'Wylls Resident (test)', uri: 'https://wylls.test/resident.json' }) });
    accounts.set(p.resident(asset), { owner: program, data: encodeResident({ asset, ...r }) });
  };
  return {
    kind: 'mock', program, collection,
    reader: { account: async a => { if (broken) throw new Error('rpc unavailable (test)'); return accounts.get(a) ?? null; } },
    breakReads(on) { broken = on; },
    async mint(holder) { const asset = randomAddress(); residents.set(asset, { holder: holder.pub, gen: 0 }); write(asset); return asset; },
    async setSession(holder, asset, key, expiry) {
      const r = residents.get(asset);
      if (r.holder !== holder.pub) throw Object.assign(new Error('NotOwner'), { custom: 1003 });
      Object.assign(r, { session: key, sessionExpiry: expiry, sessionGen: r.gen, sessionSetter: holder.pub }); write(asset);
    },
    async transfer(from, asset, to) {
      const r = residents.get(asset);
      if (r.holder !== from.pub) throw Object.assign(new Error('NotOwner'), { custom: 1003 });
      residents.set(asset, { holder: to.pub, gen: r.gen + 1 }); write(asset);   // session, expiry, session gen and setter cleared
    },
    /** Make the asset look like someone else's collection (provenance refusal). */
    forgeCollection(asset) { const a = accounts.get(asset); accounts.set(asset, { ...a, data: encodeAssetV1({ owner: residents.get(asset).holder, updateAuthority: { type: 'Collection', address: randomAddress() } }) }); },
    drop(address) { accounts.delete(address); },
    async stop() {},
  };
}

export async function realResidents() {
  const v = await startValidator({ programId: TEST_PROGRAM_ID });
  const rpc = v.rpc;
  const world = await setupWorld({ rpc, programId: v.programId, priceLamports: 1_000_000n, setup: v.setup });
  const program = v.programId;
  const fund = async who => { const s = await rpc.airdrop(who.pub, 2_000_000_000); await rpc.confirm(s, { tries: 240 }); };
  const send = async (instructions, signers) => {
    const bh = await rpc.latestBlockhash();
    const tx = signedTx({ feePayer: signers[0].publicKey, blockhash: bh.blockhash, instructions, signers });
    let sig;
    try { sig = await rpc.send(tx.wire); } catch (e) { throw Object.assign(new Error(`refused: ${e.message}`), { custom: customCode(e.data ?? e.message) }); }
    const st = await rpc.confirm(sig, { tries: 240 });
    if (!st || st.err) throw Object.assign(new Error(`failed: ${JSON.stringify(st?.err)}`), { custom: customCode(st?.err) });
    return sig;
  };
  const funded = new Set();
  const ensure = async who => { if (!funded.has(who.pub)) { await fund(who); funded.add(who.pub); } };
  return {
    kind: 'real', program, collection: world.collection, rpc,
    reader: { account: a => rpc.account(a) },
    async mint(holder) {
      await ensure(holder);
      const asset = keypair();
      await send([mintResidentIx({ program, payer: holder.pub, treasury: world.treasury, asset: asset.publicKey, collection: world.collection, price: world.priceLamports })], [holder.spike, asset]);
      return asset.publicKey;
    },
    async setSession(holder, asset, key, expiry) { await ensure(holder); return send([setSessionIx({ program, owner: holder.pub, asset, session: key, expiry })], [holder.spike]); },
    async transfer(from, asset, to) { await ensure(from); return send([transferResidentIx({ program, owner: from.pub, asset, collection: world.collection, to: to.pub })], [from.spike]); },
    async stop() { await v.stop(); },
  };
}
