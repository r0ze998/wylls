#!/usr/bin/env node
// The NFT pass part of a local NFT world's setup, on a loopback chain where Core, the resident
// program and the Frontier NFT lane are already deployed with `authority` as both programs' upgrade
// authority (frontier-stack `up --nft-pass` deploys them; a test validator can too):
//   1. the resident program: a Core collection whose update authority is the program's
//      collection-authority address, InitConfig, then — only with --test-sale — metadata and an open
//      sale with TEST values (price, supply, names: printed, never product terms);
//   2. the Frontier program: CreateResidentPolicy naming Core, the resident program, that collection
//      and the resident program's guard.
// Idempotent: a step already on chain is read back and checked, not redone; a different existing
// config or policy is an error (never overwritten). Loopback RPC only. The authority is read from a
// 32-byte hex ed25519 seed file (frontier-stack's keys/operator.seed, a throwaway local key); it is
// never printed or copied. Prints one JSON line with what is on chain.
//
//   node src/nft-world-setup.mjs --rpc http://127.0.0.1:P --frontier <id> --resident <id>
//        --authority-seed-file <run>/keys/operator.seed [--test-sale] [--price-lamports N] [--treasury <addr>]
import { readFileSync } from 'node:fs';
import { keypair, randomAddress } from './crypto.mjs';
import { RpcClient } from './rpc-client.mjs';
import { MPL_CORE_PROGRAM } from './core-asset.mjs';
import { createCollectionIx, decodeConfigAccount, initConfigIx, pdas, setMetadataIx, setTermsIx, signedTx } from './resident-ix.mjs';
import { loopbackRpc } from './mint-demo.mjs';
import { createResidentPolicyIx, guardAuthorityAddress, policyAddress } from '../../permutation-gateway/client/src/frontier/resident.mjs';
import { decodePolicyRecord } from '../../permutation-gateway/src/frontier/resident-chain-gate.mjs';

/** TEST values of a local world's sale (explicit; not product terms). */
export const TEST_SALE = Object.freeze({
  priceLamports: 100_000_000n, maxSupply: 10_000n, perWallet: 0,
  collectionName: 'Wylls Residents (local test)', collectionUri: 'https://wylls.test/collection.json',
  name: 'Wylls Resident (local test)', uri: 'https://wylls.test/resident.json',
});

export function readSeed(file) {
  const t = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(t)) throw new Error(`${file}: not a 32-byte hex seed`);
  return Uint8Array.from(Buffer.from(t, 'hex'));
}

async function sendAll(rpc, authority, instructions, extraSigners = []) {
  const { blockhash } = await rpc.latestBlockhash();
  const tx = signedTx({ feePayer: authority.publicKey, blockhash, instructions, signers: [authority, ...extraSigners] });
  const sig = await rpc.send(tx.wire);
  const st = await rpc.confirm(sig);
  if (!st || st.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st?.err ?? 'no status')}`);
  return sig;
}

export async function setupNftWorld({ rpcUrl, frontier, resident, authority, testSale = false, priceLamports = TEST_SALE.priceLamports, treasury = null, log = () => {} }) {
  const rpc = new RpcClient(loopbackRpc(rpcUrl));
  for (const [name, id] of [['Core', MPL_CORE_PROGRAM], ['resident program', resident], ['Frontier', frontier]]) {
    const a = await rpc.account(id);
    if (!a?.executable) throw new Error(`${name} ${id} is not deployed on ${rpc.url}`);
  }
  if ((await rpc.balance(authority.publicKey)) < 1_000_000_000n) {
    await rpc.confirm(await rpc.airdrop(authority.publicKey, 5_000_000_000));
  }
  const p = pdas(resident);
  const out = { rpc: rpc.url, frontier, resident, core: MPL_CORE_PROGRAM, authority: authority.publicKey, steps: [] };

  // 1. The resident program's config (and its collection).
  let cfg = decodeConfigAccount((await rpc.account(p.config))?.data);
  if (!cfg) {
    const collection = keypair();
    await sendAll(rpc, authority, [createCollectionIx({ collection: collection.publicKey, updateAuthority: p.collectionAuthority, payer: authority.publicKey, name: TEST_SALE.collectionName, uri: TEST_SALE.collectionUri })], [collection]);
    await sendAll(rpc, authority, [initConfigIx({ program: resident, authority: authority.publicKey, price: priceLamports, treasury: treasury ?? randomAddress(), collection: collection.publicKey })]);
    cfg = decodeConfigAccount((await rpc.account(p.config))?.data);
    out.steps.push('collection', 'InitConfig');
    log(`resident config: collection ${cfg.collection}`);
  } else {
    if (cfg.authority !== authority.publicKey) throw new Error(`the resident config's authority is ${cfg.authority}, not this world's`);
    out.steps.push('config (existing)');
  }
  if (testSale && !cfg.terms.open) {
    await sendAll(rpc, authority, [
      setMetadataIx({ program: resident, authority: authority.publicKey, name: TEST_SALE.name, uri: TEST_SALE.uri }),
      setTermsIx({ program: resident, authority: authority.publicKey, maxSupply: TEST_SALE.maxSupply, perWallet: TEST_SALE.perWallet, open: true }),
    ]);
    cfg = decodeConfigAccount((await rpc.account(p.config))?.data);
    out.steps.push('test sale opened');
  }

  // 2. The Frontier policy.
  const want = { coreProgram: MPL_CORE_PROGRAM, residentProgram: resident, collection: cfg.collection, guardAuthority: guardAuthorityAddress(resident) };
  let pol = await rpc.account(policyAddress(frontier));
  if (!pol) {
    await sendAll(rpc, authority, [createResidentPolicyIx({ programId: frontier, authority: authority.publicKey, coreProgram: want.coreProgram, residentProgram: resident, collection: cfg.collection })]);
    pol = await rpc.account(policyAddress(frontier));
    out.steps.push('CreateResidentPolicy');
  } else {
    out.steps.push('policy (existing)');
  }
  const got = pol && pol.owner === frontier ? decodePolicyRecord(pol.data) : null;
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`the Frontier policy on chain is not this world's: ${JSON.stringify(got)}`);

  Object.assign(out, {
    collection: cfg.collection, treasury: cfg.treasury, configPda: p.config, policy: policyAddress(frontier),
    sale: { open: cfg.terms.open, priceLamports: String(cfg.price), maxSupply: String(cfg.terms.maxSupply), perWallet: cfg.terms.perWallet, test: true },
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const need = k => arg(k) ?? (() => { throw new Error(`missing ${k}`); })();
  try {
    const out = await setupNftWorld({
      rpcUrl: need('--rpc'), frontier: need('--frontier'), resident: need('--resident'),
      authority: keypair(readSeed(need('--authority-seed-file'))),
      testSale: process.argv.includes('--test-sale'),
      priceLamports: arg('--price-lamports') ? BigInt(arg('--price-lamports')) : TEST_SALE.priceLamports,
      treasury: arg('--treasury') ?? null,
      log: m => console.error(m),
    });
    console.log(JSON.stringify(out));
  } catch (e) {
    console.error(`nft-world-setup: ${e.message}`);
    process.exit(1);
  }
}
