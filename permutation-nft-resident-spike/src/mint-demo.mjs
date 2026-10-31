#!/usr/bin/env node
// Start the mint page on a mock chain (no network, no keys of value):
//   node src/mint-demo.mjs [--port 41990]   → open the printed URL; the test wallet is offered on the page.
import { MockChain } from './mock-chain.mjs';
import { keypair, sha256, randomAddress } from './crypto.mjs';
import { MockRpc } from './mint-rpc.mjs';
import { serveMint } from './mint-server.mjs';

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
  return { chain, authority, collection, config, rpc, start: () => serveMint({ rpc, chain, collection, config, mode: 'mock', testWallet: true, port }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.indexOf('--port');
  const stack = mockMintStack({ port: portArg > 0 ? Number(process.argv[portArg + 1]) : 41990 });
  const { url } = await stack.start();
  console.log(`mint page (mock chain): ${url}/web/mint.html\n  test knobs: POST ${url}/mock/airdrop {address, lamports} …`);
}
