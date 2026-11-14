// src/nft-world-setup.mjs on a loopback validator with the REAL programs (Core, the resident program,
// the Frontier NFT lane), run as frontier-stack would run it: a separate process, the authority from a
// hex seed file. The first run makes the collection, the config, the TEST sale and the Frontier policy;
// a second run changes nothing; the sale then mints; the seed never appears in the output.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { keypair } from '../src/crypto.mjs';
import { localnetAvailable, startValidator, TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { decodeConfigAccount, mintResidentIx, pdas, signedTx } from '../src/resident-ix.mjs';
import { LOCALNET_NFT_PROGRAM_ID as FRONTIER } from '../src/nft-world-fixture.mjs';
import { TEST_SALE } from '../src/nft-world-setup.mjs';
import { attachMintStack } from '../src/mint-demo.mjs';

const LANE_SO = process.env.PSF_LOCALNET_NFT_SO ?? fileURLToPath(new URL('../../permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../src/nft-world-setup.mjs', import.meta.url));
const skip = !localnetAvailable() || !existsSync(LANE_SO) ? 'needs the validator, Core, the resident program and the lane .so' : false;

let v, dir, seedHex, authority;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(path.join(tmpdir(), 'wylls-nft-setup-'));
  seedHex = randomBytes(32).toString('hex');
  writeFileSync(path.join(dir, 'operator.seed'), seedHex, { mode: 0o600 });
  authority = keypair(Buffer.from(seedHex, 'hex'));
  v = await startValidator({ programId: TEST_PROGRAM_ID, setup: authority, extraPrograms: [{ id: FRONTIER, so: LANE_SO }] });
});
after(async () => { if (v) await v.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const run = args => new Promise(resolve => execFile(process.execPath, [SCRIPT, ...args], { timeout: 120_000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
const args = extra => ['--rpc', v.url, '--frontier', FRONTIER, '--resident', v.programId, '--authority-seed-file', path.join(dir, 'operator.seed'), ...extra];

test('first run: collection, config, TEST sale, policy; second run: nothing new; then the sale mints; the seed is never printed', { skip }, async () => {
  const first = await run(args(['--test-sale']));
  assert.equal(first.code, 0, first.stderr);
  const out = JSON.parse(first.stdout.trim());
  assert.deepEqual(out.steps, ['collection', 'InitConfig', 'test sale opened', 'CreateResidentPolicy']);
  assert.equal(out.authority, authority.publicKey);
  assert.deepEqual(out.sale, { open: true, priceLamports: String(TEST_SALE.priceLamports), maxSupply: String(TEST_SALE.maxSupply), perWallet: 0, test: true });
  assert.ok(!first.stdout.includes(seedHex) && !first.stderr.includes(seedHex), 'the seed is not printed');

  const second = await run(args(['--test-sale']));
  assert.equal(second.code, 0, second.stderr);
  const again = JSON.parse(second.stdout.trim());
  assert.deepEqual(again.steps, ['config (existing)', 'policy (existing)']);
  assert.equal(again.collection, out.collection);

  // The sale is the program's: a wallet mints at the TEST price.
  const buyer = keypair();
  await v.rpc.confirm(await v.rpc.airdrop(buyer.publicKey, 2_000_000_000));
  const asset = keypair();
  const { blockhash } = await v.rpc.latestBlockhash();
  const tx = signedTx({ feePayer: buyer.publicKey, blockhash, instructions: [mintResidentIx({ program: v.programId, payer: buyer.publicKey, treasury: out.treasury, asset: asset.publicKey, collection: out.collection, price: TEST_SALE.priceLamports })], signers: [buyer, asset] });
  const st = await v.rpc.confirm(await v.rpc.send(tx.wire));
  assert.ok(st && !st.err, JSON.stringify(st?.err));
  assert.equal(decodeConfigAccount((await v.rpc.account(pdas(v.programId).config)).data).terms.minted, 1n);

  // The mint page attached to the same RPC reads the same sale.
  const page = await attachMintStack({ rpcUrl: v.url, programId: v.programId });
  assert.equal(page.world.collection, out.collection);
});

test('refusals: a missing program, a non-loopback RPC, another authority\'s config', { skip }, async () => {
  const missing = await run(['--rpc', v.url, '--frontier', keypair().publicKey, '--resident', v.programId, '--authority-seed-file', path.join(dir, 'operator.seed')]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /Frontier .* is not deployed/);
  const remote = await run(['--rpc', 'https://api.devnet.solana.com', '--frontier', FRONTIER, '--resident', v.programId, '--authority-seed-file', path.join(dir, 'operator.seed')]);
  assert.match(remote.stderr, /only a loopback http RPC/);
  writeFileSync(path.join(dir, 'other.seed'), randomBytes(32).toString('hex'), { mode: 0o600 });
  const other = await run(['--rpc', v.url, '--frontier', FRONTIER, '--resident', v.programId, '--authority-seed-file', path.join(dir, 'other.seed')]);
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /not this world's/);
});
