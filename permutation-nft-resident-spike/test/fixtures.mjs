// One assembled stack over the mock chain: collection, registry, world,
// auth, gateway, entry desk. Deterministic keys for A and B.
import { keypair, sha256, utf8 } from '../src/crypto.mjs';
import { MPL_CORE_PROGRAM } from '../src/core-asset.mjs';
import { MockChain, signTx } from '../src/mock-chain.mjs';
import { ResidentRegistry } from '../src/registry.mjs';
import { World } from '../src/world.mjs';
import { ResidentAuth } from '../src/auth.mjs';
import { ResidentGateway } from '../src/gateway.mjs';
import { EntryDesk, MockPaymentRail } from '../src/entry.mjs';
import { MemoryStore } from '../src/store.mjs';
import { residentIdOf } from '../src/ids.mjs';

export const DOMAIN = 'wylls.test';
export const A = keypair(sha256('wallet A'));
export const B = keypair(sha256('wallet B'));
export const C = keypair(sha256('wallet C'));
export const AGENT = keypair(sha256('agent key'));

export function stack({ store = new MemoryStore(), chain = null, readerOpts = {}, now = null } = {}) {
  const clock = now ?? (() => 1_800_000_000_000 + (clock.ms ?? 0));
  const authority = keypair(sha256('collection authority'));
  chain ??= new MockChain({ now: () => Math.floor(clock() / 1000) });
  const collection = chain.collectionAuthorities.size ? [...chain.collectionAuthorities.keys()][0] : chain.createCollection({ authority });
  const reader = chain.reader(readerOpts);
  const registry = new ResidentRegistry({ store, expected: { program: MPL_CORE_PROGRAM, collection }, reader, now: clock });
  const world = new World({ store, now: clock });
  chain.attachWorld(world);
  const auth = new ResidentAuth({ store, registry, domain: DOMAIN, now: clock });
  const gateway = new ResidentGateway({ chain, registry, auth, world, store, now: clock });
  const rail = new MockPaymentRail();
  const desk = new EntryDesk({ store, rail, chain, collection, authority, registry, now: clock });
  return { store, chain, collection, authority, reader, registry, world, auth, gateway, rail, desk, clock };
}

/** Mint a resident asset for `wallet` and let the registry see it (as the desk would). */
export async function acquire(s, wallet, { memo = null, guard = true } = {}) {
  const r = s.chain.mint({ collection: s.collection, to: wallet.publicKey, authority: s.authority, memo, guard });
  await s.registry.ingest({ kind: 'mint', assetId: r.assetId, signature: r.signature, slot: r.slot, to: wallet.publicKey });
  return { assetId: r.assetId, residentId: residentIdOf(r.assetId), signature: r.signature };
}

export async function login(s, wallet, assetId) {
  const ch = s.auth.challenge({ address: wallet.publicKey, assetId });
  const signature = Buffer.from(wallet.sign(utf8(ch.text))).toString('base64');
  return s.auth.login({ address: wallet.publicKey, assetId, nonce: ch.nonce, text: ch.text, signature });
}

/** Transfer on the mock chain (the program's path for a guarded asset, Core's plain transfer otherwise) and notify the registry (as an indexer would). */
export async function transfer(s, assetId, from, to, { notify = true, plain = false } = {}) {
  const guarded = s.chain.accounts.get(assetId)?.flags?.permanentTransferDelegate && !plain;
  const build = guarded ? s.chain.buildTransferResident({ assetId, from: from.publicKey, to: to.publicKey }) : s.chain.buildTransfer({ assetId, from: from.publicKey, to: to.publicKey });
  const tx = signTx(build, [from]);
  const sent = s.chain.send(tx);
  const ingested = notify ? await s.registry.ingest({ kind: 'transfer', assetId, signature: sent.signature, slot: sent.slot, from: from.publicKey, to: to.publicKey }) : null;
  return { ...sent, ingested };
}

export const op = (residentId, name, fields = {}) => ({ residentId, name, ...fields });
export const rejects = async (fn, code) => {
  try { await fn(); } catch (e) { if (e.code !== code) throw new Error(`expected ${code}, got ${e.code ?? e.message}`); return e; }
  throw new Error(`expected refusal ${code}, got success`);
};
