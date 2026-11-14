// A loopback solana-test-validator (Agave 3.1.9, approved R1) with the real
// Metaplex Core binary and the resident program loaded, and the one-time
// setup a world needs: the collection (update authority = the program's PDA)
// and the config (test price, treasury). Everything here is local and
// throwaway: the ledger lives in a scratch directory, the setup key is a
// random in-memory key funded by the local faucet. Nothing is deployed
// anywhere and no key is written to disk by this module.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keypair, randomAddress, base58, sha256 } from './crypto.mjs';
import { MPL_CORE_PROGRAM } from './core-asset.mjs';
import { RpcClient } from './rpc-client.mjs';
import { createCollectionIx, initConfigIx, pdas, setMetadataIx, setTermsIx, signedTx } from './resident-ix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CORE_SO = path.join(ROOT, '.local', 'programs', 'mpl_core.so');
export const DEFAULT_RESIDENT_SO = path.join(ROOT, 'program', 'target', 'deploy', 'wylls_resident_program.so');
/** The test program id (the same derivation as svm-core/tests/core.rs). */
export const TEST_PROGRAM_ID = base58(sha256('wylls-resident-program id (test)'));
const VALIDATOR = path.join(process.env.HOME ?? '/root', '.local/share/solana/install/active_release/bin/solana-test-validator');

export function localnetAvailable() {
  return existsSync(VALIDATOR) && existsSync(process.env.PSF_CORE_SO ?? DEFAULT_CORE_SO) && existsSync(process.env.WYLLS_RESIDENT_SO ?? DEFAULT_RESIDENT_SO);
}

/** Start the validator on loopback; resolves when `getHealth` is ok. */
// The resident program is loaded as an upgradeable program whose upgrade
// authority is the setup key: InitConfig only accepts the program's upgrade
// authority (v0.14). The setup key is made here, in memory, for this process.
export async function startValidator({ rpcPort = 40000 + Math.floor(Math.random() * 20000), programId = TEST_PROGRAM_ID, coreSo = process.env.PSF_CORE_SO ?? DEFAULT_CORE_SO, residentSo = process.env.WYLLS_RESIDENT_SO ?? DEFAULT_RESIDENT_SO, quiet = true, setup = keypair(), extraPrograms = [], extraAccounts = [] } = {}) {
  const ledger = mkdtempSync(path.join(tmpdir(), 'wylls-localnet-'));
  const args = ['--reset', '--ledger', ledger, '--bind-address', '127.0.0.1', '--rpc-port', String(rpcPort), '--faucet-port', String(rpcPort + 1), '--limit-ledger-size', '10000',
    '--bpf-program', MPL_CORE_PROGRAM, coreSo, '--upgradeable-program', programId, residentSo, setup.publicKey];
  // More programs on the same chain (the local NFT world's Frontier lane): upgradeable under `authority`
  // (default: the setup key) so their own authority-only setup instructions can run.
  for (const x of extraPrograms) args.push('--upgradeable-program', x.id, x.so, x.authority ?? setup.publicKey);
  // Accounts present from genesis (`--account ADDRESS FILE`, the validator's JSON account format):
  // the local NFT world's preloaded Season and Frontier (src/nft-world-fixture.mjs). Written into
  // a scratch directory beside the ledger (`--reset` clears the ledger) and removed on stop.
  const accDir = extraAccounts.length ? mkdtempSync(path.join(tmpdir(), 'wylls-localnet-accounts-')) : null;
  extraAccounts.forEach((a, i) => {
    const file = path.join(accDir, `account-${i}.json`);
    writeFileSync(file, JSON.stringify({ pubkey: a.address, account: { lamports: Number(a.lamports), data: [Buffer.from(a.data).toString('base64'), 'base64'], owner: a.owner, executable: false, rentEpoch: 0, space: a.data.length } }));
    args.push('--account', a.address, file);
  });
  if (quiet) args.push('--quiet');
  const child = spawn(VALIDATOR, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-10_000); });
  const url = `http://127.0.0.1:${rpcPort}`;
  const rpc = new RpcClient(url);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`solana-test-validator exited ${child.exitCode}: ${stderr.slice(-800)}`);
    try { if ((await rpc.health()) === 'ok') break; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if ((await rpc.health().catch(() => null)) !== 'ok') { child.kill('SIGKILL'); throw new Error(`validator not healthy in time: ${stderr.slice(-800)}`); }
  const stop = async () => { child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 1500)); if (child.exitCode === null) child.kill('SIGKILL'); rmSync(ledger, { recursive: true, force: true }); if (accDir) rmSync(accDir, { recursive: true, force: true }); };
  return { url, rpc, programId, ledger, stop, child, setup };
}

/**
 * One-time world setup on a running validator: the collection whose update
 * authority is the program's collection-authority PDA, and the config with
 * the TEST price and a throwaway treasury. The setup key is random and in
 * memory; it is the config authority for the life of this process only.
 */
export async function setupWorld({ rpc, programId, priceLamports = 100_000_000n, treasury = randomAddress(), setup }) {
  if (!setup) throw new Error('setupWorld: pass the validator\'s setup key (the program\'s upgrade authority)');
  await rpc.airdrop(setup.publicKey, 10_000_000_000);
  for (let i = 0; i < 40 && (await rpc.balance(setup.publicKey)) === 0n; i++) await new Promise(r => setTimeout(r, 250));
  const p = pdas(programId);
  const collectionKey = keypair();
  const bh = await rpc.latestBlockhash();
  const tx1 = signedTx({ feePayer: setup.publicKey, blockhash: bh.blockhash, instructions: [createCollectionIx({ collection: collectionKey.publicKey, updateAuthority: p.collectionAuthority, payer: setup.publicKey, name: 'Wylls Residents (localnet test)', uri: 'https://wylls.test/collection.json' })], signers: [setup, collectionKey] });
  const sig1 = await rpc.send(tx1.wire);
  const st1 = await rpc.confirm(sig1);
  if (!st1 || st1.err) throw new Error(`create collection failed: ${JSON.stringify(st1?.err)}`);
  const bh2 = await rpc.latestBlockhash();
  const tx2 = signedTx({ feePayer: setup.publicKey, blockhash: bh2.blockhash, instructions: [initConfigIx({ program: programId, authority: setup.publicKey, price: priceLamports, treasury, collection: collectionKey.publicKey })], signers: [setup] });
  const sig2 = await rpc.send(tx2.wire);
  const st2 = await rpc.confirm(sig2);
  if (!st2 || st2.err) throw new Error(`init config failed: ${JSON.stringify(st2?.err)}`);
  // InitConfig leaves the sale closed (no supply, no metadata). This TEST world opens one with test values
  // (a fixture of the local validator, not product terms; the real terms are the config authority's).
  const bh3 = await rpc.latestBlockhash();
  const tx3 = signedTx({ feePayer: setup.publicKey, blockhash: bh3.blockhash, instructions: [
    setMetadataIx({ program: programId, authority: setup.publicKey, name: 'Wylls Resident (localnet test)', uri: 'https://wylls.test/resident.json' }),
    setTermsIx({ program: programId, authority: setup.publicKey, maxSupply: 1_000_000n, open: true }),
  ], signers: [setup] });
  const st3 = await rpc.confirm(await rpc.send(tx3.wire));
  if (!st3 || st3.err) throw new Error(`set terms failed: ${JSON.stringify(st3?.err)}`);
  return { setup, collection: collectionKey.publicKey, configPda: p.config, collectionAuthorityPda: p.collectionAuthority, treasury, priceLamports, signatures: { collection: sig1, config: sig2 }, genesisHash: await rpc.genesisHash() };
}
