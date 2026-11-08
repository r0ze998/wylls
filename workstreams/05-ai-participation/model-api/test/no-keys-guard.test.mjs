// The guard itself (no-keys-guard.mjs): with it preloaded, every way to make, derive or sign throws before anything
// is made. Skipped (and says so) when the run was started without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mode = globalThis.__P05_NO_KEYS_GUARD__ ?? null;  // 'keys' (default) | 'strict' (P05_GUARD_DERIVE=1) | null
const on = mode !== null;
const blocked = async f => { try { await f(); return 'NOT BLOCKED'; } catch (e) { return e.code === 'NoKeysGuard' ? 'blocked' : `other: ${e.message}`; } };
const PG = new URL('../../../../permutation-gateway/', import.meta.url);
const SYS = '11111111111111111111111111111111';

test('the guard blocks key generation and signing (and, in strict mode, address derivation); sha256 stays', { skip: on ? false : 'run without the no-keys guard' }, async () => {
  const { createRequire: cr } = await import('node:module');
  const w = await import(cr(new URL('package.json', PG)).resolve('@solana/web3.js'));
  const tx = await import(new URL('client/src/solana-tx.mjs', PG).href);
  const ad = await import(new URL('client/src/frontier/addresses.mjs', PG).href);
  const crypto = await import('node:crypto');
  const { createRequire } = await import('node:module');
  const cjs = createRequire(new URL('package.json', PG))('@solana/web3.js');
  const keyChecks = {
    'Keypair.generate (import)': () => w.Keypair.generate(),
    'Keypair.generate (require)': () => cjs.Keypair.generate(),
    'Keypair.fromSeed': () => w.Keypair.fromSeed(new Uint8Array(32)),
    'crypto.generateKeyPairSync': () => crypto.generateKeyPairSync('ed25519'),
    'crypto.sign': () => crypto.sign(null, Buffer.from('x'), 'k'),
    'crypto.createPrivateKey': () => crypto.createPrivateKey('k'),
    'crypto.createHmac': () => crypto.createHmac('sha256', 'k'),
    'talk-node signTalk': async () => (await import(new URL('client/src/talk-node.mjs', PG).href)).signTalk(new Uint8Array(1), { secretKey: new Uint8Array(64) }),
  };
  for (const [name, f] of Object.entries(keyChecks)) assert.equal(await blocked(f), 'blocked', name);
  const deriveChecks = {
    'PublicKey.findProgramAddressSync': () => w.PublicKey.findProgramAddressSync([Buffer.from('a')], new w.PublicKey(SYS)),
    'PublicKey.createWithSeed': () => w.PublicKey.createWithSeed(new w.PublicKey(SYS), 'x', new w.PublicKey(SYS)),
    'solana-tx findProgramAddress': () => tx.findProgramAddress([Buffer.from('a')], SYS),
    'new FrontierAddresses': () => new ad.FrontierAddresses({ programId: SYS, seasonId: 1n }),
    'addresses withSeed': () => ad.withSeed(SYS, 'x', SYS),
  };
  // Public address calculations derive no key: allowed by default, blocked in strict mode.
  for (const [name, f] of Object.entries(deriveChecks)) assert.equal(await blocked(f), mode === 'strict' ? 'blocked' : 'NOT BLOCKED', name);
  assert.equal(crypto.createHash('sha256').update('x').digest('hex').length, 64, 'hashes stay');
});
