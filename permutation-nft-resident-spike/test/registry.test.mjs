// The registry: records come from chain reads only; notifications prompt a
// read; stale or missing reads grant nothing; epochs count confirmed changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/errors.mjs';
import { MPL_CORE_PROGRAM } from '../src/core-asset.mjs';
import { ResidentRegistry } from '../src/registry.mjs';
import { MemoryStore } from '../src/store.mjs';
import { residentIdOf } from '../src/ids.mjs';
import { randomAddress } from '../src/crypto.mjs';
import { A, B, acquire, rejects, stack, transfer } from './fixtures.mjs';

test('a resident exists once the chain shows the asset; a notification alone creates nothing', async () => {
  const s = stack();
  const fake = randomAddress();
  const r = await s.registry.ingest({ kind: 'mint', assetId: fake, signature: 'sig-fake-1', slot: s.chain.slot, to: A.publicKey });
  assert.equal(r.applied, 'ignored');
  assert.equal(r.reason, ERR.NO_ACCOUNT);
  assert.equal(s.registry.residents().length, 0);
  const a = await acquire(s, A);
  const rec = s.registry.resident(a.assetId);
  assert.equal(rec.residentId, residentIdOf(a.assetId));
  assert.equal(rec.holder, A.publicKey);
  assert.equal(rec.epoch, 0);
  assert.deepEqual(s.registry.waitlist().map(x => [x.residentId, x.holder, x.status]), [[a.residentId, A.publicKey, 'eligible']]);
});

test('duplicate notifications are ignored; a stale notification cannot roll the holder back', async () => {
  const s = stack();
  const a = await acquire(s, A);
  const t = await transfer(s, a.assetId, A, B);
  assert.equal(t.ingested.applied, 'confirmed');
  assert.equal(s.registry.resident(a.assetId).epoch, 1);
  const again = await s.registry.ingest({ kind: 'transfer', assetId: a.assetId, signature: t.signature, slot: t.slot, from: A.publicKey, to: B.publicKey });
  assert.equal(again.applied, 'duplicate');
  // A late replay of the mint event (older information) changes nothing: the chain says B.
  const old = await s.registry.ingest({ kind: 'mint', assetId: a.assetId, signature: a.signature, slot: 1, to: A.publicKey });
  assert.equal(old.applied, 'duplicate');
  const forged = await s.registry.ingest({ kind: 'transfer', assetId: a.assetId, signature: 'forged-claims-A-again', slot: 1, from: B.publicKey, to: A.publicKey });
  assert.equal(forged.applied, 'confirmed');
  assert.equal(forged.holder, B.publicKey, 'the chain, not the notification, names the holder');
  assert.equal(s.registry.resident(a.assetId).epoch, 1);
});

test('a lagging reader: the transfer is unconfirmed until the reader catches up; nothing is granted meanwhile', async () => {
  const s = stack({ readerOpts: { lagSlots: 2 } });
  s.chain.tick(3);
  const r = s.chain.mint({ collection: s.collection, to: A.publicKey, authority: s.authority });
  const first = await s.registry.ingest({ kind: 'mint', assetId: r.assetId, signature: r.signature, slot: r.slot, to: A.publicKey });
  assert.equal(first.applied, 'unconfirmed');
  assert.deepEqual(s.registry.waitlist().map(x => x.status), ['unconfirmed']);
  assert.equal(s.registry.entitlement(A.publicKey).onWaitlist, false, 'unconfirmed is not eligible');
  await rejects(() => s.registry.holderNow(r.assetId, { minSlot: r.slot }), ERR.STALE_READ);
  s.chain.tick(2);
  const after = await s.registry.reconcile();
  assert.equal(after[0].applied, 'confirmed');
  assert.equal(s.registry.resident(r.assetId).holder, A.publicKey);
});

test('an unreachable chain refuses reads and keeps notifications pending', async () => {
  let down = true;
  const s = stack({ readerOpts: { fail: () => down } });
  const r = s.chain.mint({ collection: s.collection, to: A.publicKey, authority: s.authority });
  const n = await s.registry.ingest({ kind: 'mint', assetId: r.assetId, signature: r.signature, slot: r.slot, to: A.publicKey });
  assert.equal(n.applied, 'unconfirmed');
  assert.equal(n.reason, ERR.CHAIN_UNAVAILABLE);
  await rejects(() => s.registry.holderNow(r.assetId), ERR.CHAIN_UNAVAILABLE);
  down = false;
  assert.equal((await s.registry.reconcile())[0].applied, 'confirmed');
});

test('epochs: every confirmed holder change counts, a buy-back included; the resident id never changes', async () => {
  const s = stack();
  const a = await acquire(s, A);
  await transfer(s, a.assetId, A, B);
  await transfer(s, a.assetId, B, A);
  const rec = s.registry.resident(a.assetId);
  assert.equal(rec.epoch, 2);
  assert.equal(rec.holder, A.publicKey);
  assert.equal(rec.residentId, a.residentId);
  assert.equal(s.registry.residents().length, 1);
});

test('one asset, one record: concurrent first observations do not duplicate; two assets never share an id', async () => {
  const s = stack();
  const r = s.chain.mint({ collection: s.collection, to: A.publicKey, authority: s.authority });
  const out = await Promise.all([1, 2, 3, 4].map(() => s.registry.observe(r.assetId)));
  assert.equal(s.registry.residents().length, 1);
  assert.deepEqual(out.map(o => o.residentId), new Array(4).fill(residentIdOf(r.assetId)));
  const r2 = s.chain.mint({ collection: s.collection, to: A.publicKey, authority: s.authority });
  await s.registry.observe(r2.assetId);
  assert.equal(s.registry.residents().length, 2);
  assert.notEqual(residentIdOf(r.assetId), residentIdOf(r2.assetId));
  // A forced collision (same resident id claimed by another asset) is refused, never merged.
  s.registry.db.byResidentId[residentIdOf(r2.assetId)] = randomAddress();
  delete s.registry.db.residents[r2.assetId];
  await rejects(() => s.registry.observe(r2.assetId), ERR.RESIDENT_ID_COLLISION);
});

test('publishing flips one flag and touches no record; a wallet with no asset is neither waitlisted nor allowed in', async () => {
  const s = stack();
  const a = await acquire(s, A);
  const before = JSON.stringify(s.registry.db.residents);
  assert.equal(s.registry.entitlement(A.publicKey).onWaitlist, true);
  assert.equal(s.registry.entitlement(B.publicKey).onWaitlist, false);
  s.registry.publish();
  assert.equal(JSON.stringify(s.registry.db.residents), before);
  assert.equal(s.registry.entitlement(A.publicKey).canLogin, true);
  assert.equal(s.registry.entitlement(B.publicKey).canLogin, false);
  assert.equal(s.registry.resident(a.assetId).epoch, 0);
});

test('a state file of another collection is refused, so residents of two collections are never mixed', async () => {
  const s = stack();
  await acquire(s, A);
  assert.throws(() => new ResidentRegistry({ store: s.store, expected: { program: MPL_CORE_PROGRAM, collection: randomAddress() }, reader: s.reader }), /another collection/);
  const fresh = new ResidentRegistry({ store: new MemoryStore(), expected: { program: MPL_CORE_PROGRAM, collection: s.collection }, reader: s.reader });
  assert.equal(fresh.residents().length, 0);
});

test('a burnt or vanished asset keeps its record marked gone and refuses everything', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.chain.accounts.delete(a.assetId);
  s.chain.history.get(a.assetId).push({ slot: s.chain.slot, account: null });
  await rejects(() => s.registry.holderNow(a.assetId), ERR.NO_ACCOUNT);
  assert.ok(s.registry.resident(a.assetId).gone);
  assert.equal(s.registry.waitlist().length, 0);
});
