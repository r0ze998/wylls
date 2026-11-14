#!/usr/bin/env node
// Start the mint page on a mock chain (no network, no keys of value):
//   node src/mint-demo.mjs [--port 41990]   → open the printed URL; the test wallet is offered on the page.
//   node src/mint-demo.mjs --localnet [--port 41990]   → its own loopback validator with the real programs.
//   node src/mint-demo.mjs --rpc http://127.0.0.1:P [--program ID] [--port 41990]   → attach, read-only, to a
//     loopback chain where the resident program is already configured (the local NFT world).
import { MockChain } from './mock-chain.mjs';
import { keypair, sha256, randomAddress } from './crypto.mjs';
import { MockRpc } from './mint-rpc.mjs';
import { serveMint } from './mint-server.mjs';
import { MockAdapter, RpcAdapter } from './adapters.mjs';
import { localnetAvailable, setupWorld, startValidator, TEST_PROGRAM_ID } from './localnet.mjs';
import { RpcClient } from './rpc-client.mjs';
import { decodeConfigAccount, pdas } from './resident-ix.mjs';

export function mockMintStack({ port = 0, priceLamports = 100_000_000n } = {}) {
  const chain = new MockChain();
  const authority = keypair(sha256('collection authority (mock)'));
  const collection = chain.createCollection({ authority, name: 'Wylls Residents (devnet test)', uri: 'local://collection' });
  const config = {
    network: 'devnet (mock)', chainId: 'solana:devnet', genesisHash: 'MockGenesis11111111111111111111111111111111',
    explorer: 'https://explorer.solana.com', priceLamports, priceLabel: 'TEST PRICE — 試験用の仮値、本番価格ではない',
    treasury: randomAddress(), collectionAuthorityPda: randomAddress(), configPda: randomAddress(),
    // A TEST fixture for the mock chain only (not product terms): an open sale with a large supply.
    terms: { open: true, maxSupply: 1_000_000n, minted: 0n, saleStart: 0n, saleEnd: 0n, perWallet: 0, name: 'Wylls Resident (mock)', uri: 'local://resident.json' },
  };
  const rpc = new MockRpc({ chain, collection, config });
  const adapter = new MockAdapter({ rpc, chain, collection, config });
  return { chain, authority, collection, config, rpc, adapter, start: () => serveMint({ adapter, testWallet: true, testKnobs: true, port }) };
}

/** The page on a loopback solana-test-validator with the REAL Core binary and the REAL resident program (approved local environment). */
export async function localnetMintStack({ port = 0, priceLamports = 100_000_000n } = {}) {
  if (!localnetAvailable()) throw new Error('localnet needs solana-test-validator, .local/programs/mpl_core.so and program/target/deploy/wylls_resident_program.so (docs/ENV-RECORD.ja.md)');
  const v = await startValidator({ programId: TEST_PROGRAM_ID });
  const world = await setupWorld({ rpc: v.rpc, programId: v.programId, priceLamports, setup: v.setup });
  const adapter = new RpcAdapter({ rpc: v.rpc, world, programId: v.programId });
  return { validator: v, rpc: v.rpc, world, adapter, programId: v.programId, collection: world.collection, config: { treasury: world.treasury, priceLamports }, start: () => serveMint({ adapter, testWallet: true, testKnobs: true, port }), stop: () => v.stop() };
}

/** Only a loopback RPC: attaching never points the page at devnet, mainnet or another host. */
export function loopbackRpc(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`--rpc: not a URL: ${url}`); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`--rpc: only a loopback http RPC (127.0.0.1, localhost, [::1]); got ${u.host}`);
  return u.toString().replace(/\/$/, '');
}

/**
 * The page on a chain someone else started and configured (the local NFT world's chain:
 * frontier-localnet or a validator), read-only: no key, no setup. The collection, treasury, price
 * and sale terms come from the resident program's config account on that chain.
 */
export async function attachMintStack({ rpcUrl, programId = TEST_PROGRAM_ID, port = 0, network = 'local NFT world (real programs, loopback)' } = {}) {
  const rpc = new RpcClient(loopbackRpc(rpcUrl));
  if ((await rpc.call('getHealth', [])) !== 'ok') throw new Error(`${rpc.url}: not healthy`);
  const prog = await rpc.account(programId);
  if (!prog?.executable) throw new Error(`${programId}: no resident program on ${rpc.url}`);
  const cfg = decodeConfigAccount((await rpc.account(pdas(programId).config))?.data);
  if (!cfg) throw new Error(`${programId}: the config is not initialized on ${rpc.url} (InitConfig first)`);
  const world = { collection: cfg.collection, treasury: cfg.treasury, priceLamports: cfg.price, configPda: pdas(programId).config, collectionAuthorityPda: pdas(programId).collectionAuthority, genesisHash: await rpc.genesisHash() };
  const adapter = new RpcAdapter({ rpc, world, programId, network });
  return { rpc, world, adapter, programId, start: () => serveMint({ adapter, testWallet: true, testKnobs: true, port }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 41990;
  const rpcArg = process.argv.indexOf('--rpc');
  if (rpcArg > 0) {
    const progArg = process.argv.indexOf('--program');
    const stack = await attachMintStack({ rpcUrl: process.argv[rpcArg + 1], programId: progArg > 0 ? process.argv[progArg + 1] : TEST_PROGRAM_ID, port });
    const { url } = await stack.start();
    console.log(`mint page (attached, read-only, to ${stack.rpc.url}): ${url}/web/mint.html\n  program ${stack.programId}, collection ${stack.world.collection}`);
  } else if (process.argv.includes('--localnet')) {
    const stack = await localnetMintStack({ port });
    // Ctrl-C / SIGTERM: stop the validator this process started and remove its ledger (no orphan left).
    let stopping = false;
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      try { await stack.stop(); } finally { process.exit(0); }
    });
    const { url } = await stack.start();
    console.log(`mint page (REAL program on a loopback validator): ${url}/web/mint.html\n  program ${stack.programId}, collection ${stack.collection}, rpc ${stack.rpc.url}\n  airdrop: POST ${url}/mock/airdrop {address, lamports}`);
  } else {
    const stack = mockMintStack({ port });
    const { url } = await stack.start();
    console.log(`mint page (mock chain): ${url}/web/mint.html\n  test knobs: POST ${url}/mock/airdrop {address, lamports} …`);
  }
}
