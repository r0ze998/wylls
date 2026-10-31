// The verifier: the right program, the right collection, the current owner;
// never the name, the image or the metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_REFUSALS, decodeAssetV1, encodeAssetV1, encodeCollectionV1, KEY, MPL_CORE_PROGRAM, verifyResidentAsset } from '../src/core-asset.mjs';
import { keypair, randomAddress } from '../src/crypto.mjs';
import { A, B, stack } from './fixtures.mjs';

test('AssetV1 base struct: encode and decode round-trip; the key byte is checked', () => {
  const col = randomAddress();
  const bytes = encodeAssetV1({ owner: A.publicKey, updateAuthority: { type: 'Collection', address: col }, name: 'Wylls Resident #1', uri: 'local://1', seq: 7n });
  const d = decodeAssetV1(bytes);
  assert.equal(d.key, KEY.AssetV1);
  assert.equal(d.owner, A.publicKey);
  assert.deepEqual(d.updateAuthority, { type: 'Collection', address: col });
  assert.equal(d.name, 'Wylls Resident #1');
  assert.equal(d.seq, 7n);
  assert.equal(d.baseLength, bytes.length);
  const none = decodeAssetV1(encodeAssetV1({ owner: A.publicKey, updateAuthority: { type: 'None' } }));
  assert.deepEqual(none.updateAuthority, { type: 'None' });
  assert.throws(() => decodeAssetV1(encodeCollectionV1({ updateAuthority: A.publicKey })), /not an AssetV1 \(key 5\)/);
  assert.throws(() => decodeAssetV1(bytes.subarray(0, 40)), /truncated/);
});

test('verifier: a genuine asset of the collection passes with its holder; name and uri are display only', () => {
  const s = stack();
  const real = s.chain.mint({ collection: s.collection, to: A.publicKey, authority: s.authority, name: 'Anything at all', uri: 'local://whatever' });
  const v = verifyResidentAsset({ account: s.chain.accounts.get(real.assetId), expected: { program: MPL_CORE_PROGRAM, collection: s.collection } });
  assert.equal(v.ok, true);
  assert.equal(v.holder, A.publicKey);
  assert.equal(v.asset.name, 'Anything at all');
});

test('verifier: look-alikes are refused by provenance, whatever their strings say', () => {
  const s = stack();
  const expected = { program: MPL_CORE_PROGRAM, collection: s.collection };
  const check = id => verifyResidentAsset({ account: s.chain.accounts.get(id) ?? null, expected });
  // Same name and uri, owned by another program.
  assert.equal(check(s.chain.mintLookalike({ kind: 'other-program', collection: s.collection, to: A.publicKey })).code, ASSET_REFUSALS.WRONG_PROGRAM);
  // Same name and uri, a Core asset in a collection of the same name.
  const other = check(s.chain.mintLookalike({ kind: 'other-collection', collection: s.collection, to: A.publicKey }));
  assert.equal(other.code, ASSET_REFUSALS.NOT_IN_COLLECTION);
  assert.equal(other.detail.updateAuthority.type, 'Collection');
  assert.notEqual(other.detail.updateAuthority.address, s.collection);
  // A Core asset with no collection (update authority = an address).
  assert.equal(check(s.chain.mintLookalike({ kind: 'no-collection', collection: s.collection, to: A.publicKey })).code, ASSET_REFUSALS.NOT_IN_COLLECTION);
  // The collection account itself passed off as an asset.
  assert.equal(check(s.collection).code, ASSET_REFUSALS.NOT_AN_ASSET);
  // Garbage under the Core program.
  assert.equal(check(s.chain.mintLookalike({ kind: 'garbage', collection: s.collection, to: A.publicKey })).code, ASSET_REFUSALS.MALFORMED);
  // Nothing there.
  assert.equal(check(randomAddress()).code, ASSET_REFUSALS.NO_ACCOUNT);
  // The expected collection is the only one: the same bytes against another expected collection fail.
  const real = s.chain.mint({ collection: s.collection, to: B.publicKey, authority: s.authority });
  assert.equal(verifyResidentAsset({ account: s.chain.accounts.get(real.assetId), expected: { program: MPL_CORE_PROGRAM, collection: randomAddress() } }).code, ASSET_REFUSALS.NOT_IN_COLLECTION);
});

test('mint: only the collection authority mints into the collection', () => {
  const s = stack();
  assert.throws(() => s.chain.mint({ collection: s.collection, to: A.publicKey, authority: keypair() }), /not the collection authority/);
});
