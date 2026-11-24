// The Frontier's in-game key (permutation-server/web/frontier/fsession.mjs):
// the text a wallet signs pinned byte for byte (contract §9.1: never
// translated, printable ASCII, names site, cluster, program and world),
// the seed domain, keys distinct from v9's (other text, domain and storage
// prefix; web/session.mjs untouched), deriving the same key from the same
// signature, refusing a bad or altered signature, keeping keys per wallet
// and season, the Citizen check, and importing a backup.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import * as fs from '../../permutation-server/web/frontier/fsession.mjs';
import * as v9 from '../../permutation-server/web/session.mjs';
import { sha256 } from '../client/src/sha256.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

function fakeWallet(mangle = x => x) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const address = bs58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address, signMessage: async m => mangle({ signedMessage: m, signature: new Uint8Array(nodeSign(null, Buffer.from(m), privateKey)) }) };
}
const scope = { cluster: 'localnet', programId: 'J5yoiT3bVuC7pLFPJeS2yqLTouT5BHxBivvpqkG2jvAz', seasonId: '1' };
const where = { origin: 'http://127.0.0.1:41040', host: '127.0.0.1:41040' };

test('the session text is pinned byte for byte, printable ASCII, never translated', () => {
  const want = 'Wylls wants you to create an in-game key.\n'
    + 'Site: http://127.0.0.1:41040\n'
    + 'Cluster: localnet\n'
    + 'Program: J5yoiT3bVuC7pLFPJeS2yqLTouT5BHxBivvpqkG2jvAz\n'
    + 'World: 1\n'
    + 'Anyone holding this key can act as you in this world (build, train, march, explore). It cannot move tokens from your wallet.\n'
    + 'Sign only on 127.0.0.1:41040.';
  assert.equal(fs.sessionText({ ...where, ...scope }), want);
  setLang('en');
  assert.equal(fs.sessionText({ ...where, ...scope }), want, 'the language does not change it');
  assert.equal(Buffer.from(sha256(Buffer.from(want))).toString('hex'), 'b9e5a893bb0f3c65cc49bb904dbbfb1d95673c44c70a9bc853dcae4cf608e5bc', 'the pinned text\'s sha256');
  assert.throws(() => fs.sessionText({ ...where, ...scope, programId: 'Prög' }), e => e.code === 'BadSessionText');
  assert.throws(() => fs.sessionText({ ...where, ...scope, cluster: '本番' }), /printable ASCII/);
  // The source keeps the text in one place and is never passed through L`…`.
  const src = readFileSync(new URL('../../permutation-server/web/frontier/fsession.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/Wylls wants you/g) || []).length, 1);
  assert.doesNotMatch(src, /L`Wylls/);
});

// Owner Q-WW-1 (2026-11-24 23:56): the signed text says "World", not "Season". The
// key is sha256(domain ‖ signature over these bytes), so this text change makes every
// wallet derive a new key: pinned with a fixed Ed25519 wallet (signatures are
// deterministic), old text -> old key, new text -> new key.
test('Q-WW-1: the signed text names the world, never the season, and the derived key follows it', async () => {
  const text = fs.sessionText({ ...where, ...scope });
  assert.match(text, /\nWorld: 1\n/);
  assert.match(text, /act as you in this world \(/);
  assert.doesNotMatch(text, /season/i);
  const seed = Buffer.alloc(32, 7);
  const { createPrivateKey } = await import('node:crypto');
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const signOf = m => new Uint8Array(nodeSign(null, Buffer.from(m), key));
  const oldText = text.replace('\nWorld: 1\n', '\nSeason: 1\n').replace('in this world (', 'in this season (');
  const derived = m => Buffer.from(fs.seedOf(signOf(m))).toString('hex');
  assert.notEqual(derived(text), derived(oldText), 'a stored pre-change key is not the one a new signature makes');
  assert.equal(derived(text), derived(text), 'deterministic');
  // The kept key (seed) is read back as is: restore never re-signs, so a key stored
  // before the change keeps working in the world it was made for.
  const wallet = 'Wkept';
  fs.storage.set(fs.storeKey(scope, wallet), derived(oldText));
  const kept = await fs.restore(scope, wallet);
  assert.equal(kept.seedHex(), derived(oldText));
  fs.storage.del(fs.storeKey(scope, wallet));
  // The backup a player saves says World too (the hex key is what is read back).
  assert.match(kept.backupText(), /^Wylls key\nWorld: 1\n/);
  assert.match(kept.backupText(), /act as you in this world\. Keep it private\.\n$/);
  assert.doesNotMatch(kept.backupText(), /season/i);
});

test('distinct from v9: another text, seed domain and storage prefix; v9 session.mjs untouched', () => {
  assert.equal(fs.SEED_DOMAIN, 'PS/frontier-session/v1');
  assert.notEqual(fs.sessionText({ ...where, ...scope }), v9.sessionText({ host: where.host, ...scope }));
  const sig = new Uint8Array(64).fill(3);
  assert.notDeepEqual(Buffer.from(fs.seedOf(sig)), Buffer.from(v9.seedOf(sig)));
  assert.equal(fs.storeKey(scope, 'W'), 'ps-fsession:localnet:J5yoiT3bVuC7pLFPJeS2yqLTouT5BHxBivvpqkG2jvAz:1:W');
  assert.notEqual(fs.storeKey(scope, 'W'), v9.storeKey(scope, 'W'));
  assert.deepEqual(Buffer.from(fs.seedOf(sig)), Buffer.from(sha256(Buffer.concat([Buffer.from('PS/frontier-session/v1'), Buffer.from(sig)]))));
});

test('derive: the same signature makes the same key; a bad or altered signature is refused', async () => {
  const w = fakeWallet();
  const a = await fs.derive({ wallet: w, ...scope, ...where });
  const b = await fs.derive({ wallet: w, ...scope, ...where });
  assert.equal(a.publicKey, b.publicKey, 'Ed25519 signatures are deterministic');
  assert.equal(a.wallet, w.address);
  const msg = new TextEncoder().encode('Harvest');
  assert.equal(await v9.verify(a.publicKey, msg, await a.sign(msg)), true);
  await assert.rejects(fs.derive({ wallet: fakeWallet(o => ({ ...o, signature: o.signature.map((x, i) => (i ? x : x ^ 1)) })), ...scope, ...where }), e => e.code === 'WalletBadSignature');
  await assert.rejects(fs.derive({ wallet: fakeWallet(o => ({ ...o, signedMessage: new TextEncoder().encode('other') })), ...scope, ...where }), e => e.code === 'WalletAlteredMessage');
  const other = await fs.derive({ wallet: w, ...scope, ...where, seasonId: '2' });
  assert.notEqual(other.publicKey, a.publicKey, 'another season, another key');
});

test('keep, restore and forget per wallet and season; the Citizen check; backup import', async () => {
  const w = fakeWallet();
  const s = await fs.derive({ wallet: w, ...scope, ...where });
  fs.remember(s);
  const back = await fs.restore(scope, w.address);
  assert.equal(back.publicKey, s.publicKey);
  assert.equal(await fs.restore({ ...scope, seasonId: '9' }, w.address), null);
  const citizen = { session: bs58.decode(s.publicKey), sessionExpiry: 5000n };
  assert.deepEqual(fs.matchesCitizen(s, citizen, 4999), { ok: true });
  assert.deepEqual(fs.matchesCitizen(s, citizen, 5000), { ok: false, code: 'SessionExpired' });
  assert.deepEqual(fs.matchesCitizen(s, { session: new Uint8Array(32) }), { ok: false, code: 'NoSession' });
  assert.deepEqual(fs.matchesCitizen(s, { session: new Uint8Array(32).fill(1) }), { ok: false, code: 'SessionMismatch' });
  const text = s.backupText();
  assert.match(text, /Wylls key/);
  fs.forget(s);
  assert.equal(await fs.restore(scope, w.address), null);
  const { session, citizen: c } = await fs.importBackup(text, scope, [{ wallet: 'x', session: 'y' }, { wallet: w.address, session: s.publicKey }]);
  assert.equal(session.publicKey, s.publicKey);
  assert.equal(c.wallet, w.address);
  assert.equal((await fs.restore(scope, w.address)).publicKey, s.publicKey);
  await assert.rejects(fs.importBackup(text, scope, []), e => e.code === 'SessionMismatch');
  await assert.rejects(fs.importBackup('nothing here', scope, []), e => e.code === 'BadBackup');
});
