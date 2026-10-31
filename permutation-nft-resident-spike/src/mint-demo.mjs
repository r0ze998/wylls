#!/usr/bin/env node
// Start the mint page on a mock chain (no network, no keys of value):
//   node src/mint-demo.mjs [--port 41990]   → open the printed URL; the test wallet is offered on the page.
import { MockChain } from './mock-chain.mjs';
import { keypair, sha256, randomAddress } from './crypto.mjs';
import { MockRpc } from './mint-rpc.mjs';
import { serveMint } from './mint-server.mjs';
import { MockAdapter, RpcAdapter } from './adapters.mjs';
import { localnetAvailable, setupWorld, startValidator, TEST_PROGRAM_ID } from './localnet.mjs';

export function mockMintStack({ port = 0, priceLamports = 100_000_000n } = {}) {
  const chain = new MockChain();
  const authority = keypair(sha256('collection authority (mock)'));
  const collection = chain.createCollection({ authority, name: 'Wylls Residents (devnet test)', uri: 'local://collection' });
  const config = {
    network: 'devnet (mock)', chainId: 'solana:devnet', genesisHash: 'MockGenesis11111111111111111111111111111111',
    explorer: 'https://explorer.solana.com', priceLamports, priceLabel: 'TEST PRICE — 試験用の仮値、本番価格ではない',
    treasury: randomAddress(), collectionAuthorityPda: randomAddress(), configPda: randomAddress(),
  };
  const rpc = new MockRpc({ chain, collection, config });
  const adapter = new MockAdapter({ rpc, chain, collection, config });
  return { chain, authority, collection, config, rpc, adapter, start: () => serveMint({ adapter, testWallet: true, port }) };
}

/** The page on a loopback solana-test-validator with the REAL Core binary and the REAL resident program (approved local environment). */
export async function localnetMintStack({ port = 0, priceLamports = 100_000_000n } = {}) {
  if (!localnetAvailable()) throw new Error('localnet needs solana-test-validator, .local/programs/mpl_core.so and program/target/deploy/wylls_resident_program.so (docs/ENV-RECORD.ja.md)');
  const v = await startValidator({ programId: TEST_PROGRAM_ID });
  const world = await setupWorld({ rpc: v.rpc, programId: v.programId, priceLamports });
  const adapter = new RpcAdapter({ rpc: v.rpc, world, programId: v.programId });
  return { validator: v, rpc: v.rpc, world, adapter, programId: v.programId, collection: world.collection, config: { treasury: world.treasury, priceLamports }, start: () => serveMint({ adapter, testWallet: true, port }), stop: () => v.stop() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 41990;
  if (process.argv.includes('--localnet')) {
    const stack = await localnetMintStack({ port });
    const { url } = await stack.start();
    console.log(`mint page (REAL program on a loopback validator): ${url}/web/mint.html\n  program ${stack.programId}, collection ${stack.collection}, rpc ${stack.rpc.url}\n  airdrop: POST ${url}/mock/airdrop {address, lamports}`);
  } else {
    const stack = mockMintStack({ port });
    const { url } = await stack.start();
    console.log(`mint page (mock chain): ${url}/web/mint.html\n  test knobs: POST ${url}/mock/airdrop {address, lamports} …`);
  }
}
