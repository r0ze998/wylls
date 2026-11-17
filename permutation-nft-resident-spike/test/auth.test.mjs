// Login and credentials: the holder, read fresh, is the only key to a resident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/errors.mjs';
import { utf8 } from '../src/crypto.mjs';
import { A, B, acquire, AGENT, login, rejects, stack, transfer } from './fixtures.mjs';

test('before publication a holder gets the waitlist answer, not a token; after it, a token bound to the epoch', async () => {
  const s = stack();
  const a = await acquire(s, A);
  const e = await rejects(() => login(s, A, a.assetId), ERR.NOT_PUBLISHED);
  assert.equal(e.extra.entitlement.onWaitlist, true);
  assert.equal(e.extra.residentId, a.residentId);
  s.registry.publish();
  const t = await login(s, A, a.assetId);
  assert.equal(t.residentId, a.residentId);
  assert.equal(t.epoch, 0);
  const who = await s.auth.authorize({ credential: t.token });
  assert.equal(who.wallet, A.publicKey);
});

test('refused logins: another wallet\'s signature, a reused nonce, an expired or altered text, another domain, a non-holder', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  // B signs A's challenge.
  let ch = s.auth.challenge({ address: A.publicKey, assetId: a.assetId });
  await rejects(() => s.auth.login({ address: A.publicKey, assetId: a.assetId, nonce: ch.nonce, text: ch.text, signature: Buffer.from(B.sign(utf8(ch.text))).toString('base64') }), ERR.BAD_SIGNATURE);
  // A valid signature over an altered text (another nonce line).
  ch = s.auth.challenge({ address: A.publicKey, assetId: a.assetId });
  const altered = ch.text.replace(/Nonce: \w+/, 'Nonce: AAAAAAAAAAAAAAAA');
  await rejects(() => s.auth.login({ address: A.publicKey, assetId: a.assetId, nonce: ch.nonce, text: altered, signature: Buffer.from(A.sign(utf8(altered))).toString('base64') }), ERR.BAD_MESSAGE);
  // A signature made for another domain's text is not this challenge's text.
  const foreign = ch.text.replace('wylls.test wants', 'evil.example wants');
  await rejects(() => s.auth.login({ address: A.publicKey, assetId: a.assetId, nonce: ch.nonce, text: foreign, signature: Buffer.from(A.sign(utf8(foreign))).toString('base64') }), ERR.BAD_MESSAGE);
  // Reuse: the same signed challenge twice (a double submit) logs in once.
  const sig = Buffer.from(A.sign(utf8(ch.text))).toString('base64');
  const body = { address: A.publicKey, assetId: a.assetId, nonce: ch.nonce, text: ch.text, signature: sig };
  const [ok, dup] = await Promise.allSettled([s.auth.login(body), s.auth.login(body)]);
  assert.equal(ok.status, 'fulfilled');
  assert.equal(dup.reason.code, ERR.NONCE_USED);
  await rejects(() => s.auth.login(body), ERR.NONCE_USED);
  // Expired challenge.
  ch = s.auth.challenge({ address: A.publicKey, assetId: a.assetId });
  s.clock.ms = 6 * 60_000;
  await rejects(() => s.auth.login({ ...body, nonce: ch.nonce, text: ch.text, signature: Buffer.from(A.sign(utf8(ch.text))).toString('base64') }), ERR.EXPIRED);
  s.clock.ms = 0;
  // A non-holder with a perfectly valid signature of its own challenge.
  await rejects(() => login(s, B, a.assetId), ERR.NOT_HOLDER);
  // A challenge for one asset cannot log into another.
  const a2 = await acquire(s, A);
  ch = s.auth.challenge({ address: A.publicKey, assetId: a.assetId });
  await rejects(() => s.auth.login({ address: A.publicKey, assetId: a2.assetId, nonce: ch.nonce, text: ch.text, signature: Buffer.from(A.sign(utf8(ch.text))).toString('base64') }), ERR.BAD_MESSAGE);
});

test('a login with a stale chain read is refused as unconfirmed, not granted on memory', async () => {
  const s = stack({ readerOpts: { lagSlots: 1 } });
  const r = s.chain.mint({ collection: s.collection, to: A.publicKey, authority: s.authority });
  s.chain.tick(2);
  await s.registry.observe(r.assetId);
  s.registry.publish();
  // Someone tells us a transfer happened at the tip; the reader has not seen it: the holder cannot be confirmed either way.
  s.registry.resident(r.assetId).holderSince.slot = s.chain.slot;
  const e = await rejects(() => login(s, A, r.assetId), ERR.UNCONFIRMED);
  assert.equal(e.extra.readSlot, s.chain.slot - 1);
});

test('after a transfer, every credential of the seller is refused and revoked: login token, capability, delegation, session key', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const t = await login(s, A, a.assetId);
  const cap = await s.auth.issueCapability({ loginToken: t.token, label: 'mcp' });
  await s.auth.recordDelegation({ loginToken: t.token, agentKey: AGENT.publicKey });
  assert.ok(s.auth.peek(cap.token));
  await transfer(s, a.assetId, A, B);
  // The registry confirmed the change: the login, the capability and the delegation of epoch 0 are revoked at once.
  assert.equal(s.auth.db.revoked.filter(r => r.reason.startsWith('holder changed')).length, 3);
  assert.equal(s.auth.peek(cap.token), null);
  await rejects(() => s.auth.authorize({ credential: t.token }), ERR.BAD_CREDENTIAL);
  await rejects(() => s.auth.authorize({ credential: cap.token }), ERR.BAD_CREDENTIAL);
  await rejects(() => s.auth.authorize({ credential: { agentKey: AGENT.publicKey, assetId: a.assetId } }), ERR.BAD_CREDENTIAL);
  // The buyer logs in under the new epoch; the seller's token is not revived by a buy-back.
  const tb = await login(s, B, a.assetId);
  assert.equal(tb.epoch, 1);
  await transfer(s, a.assetId, B, A);
  await rejects(() => s.auth.authorize({ credential: t.token }), ERR.BAD_CREDENTIAL);
  await rejects(() => s.auth.authorize({ credential: tb.token }), ERR.BAD_CREDENTIAL);
  // When the registry has NOT heard of the transfer (no notification), authorize learns it from the chain and refuses as OwnerChanged.
  const a2 = await acquire(s, A);
  const t2 = await login(s, A, a2.assetId);
  await transfer(s, a2.assetId, A, B, { notify: false });
  const e = await rejects(() => s.auth.authorize({ credential: t2.token }), ERR.OWNER_CHANGED);
  assert.equal(e.extra.holder, B.publicKey);
  assert.equal(s.auth.peek(t2.token), null, 'revoked by the fresh read inside authorize');
  const ta = await login(s, A, a.assetId);
  assert.equal(ta.epoch, 2);
});

test('a capability or a delegation can only be issued under a live login of the current holder', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const t = await login(s, A, a.assetId);
  await transfer(s, a.assetId, A, B, { notify: false });
  await rejects(() => s.auth.issueCapability({ loginToken: t.token }), ERR.OWNER_CHANGED);
  await rejects(() => s.auth.recordDelegation({ loginToken: t.token, agentKey: AGENT.publicKey }), ERR.BAD_CREDENTIAL);
});

test('credentials survive a restart of the off-chain process and are still checked against the chain', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const t = await login(s, A, a.assetId);
  const s2 = stack({ store: s.store.reopen(), chain: s.chain });
  assert.equal((await s2.auth.authorize({ credential: t.token })).wallet, A.publicKey);
  await transfer(s2, a.assetId, A, B, { notify: false });
  await rejects(() => s2.auth.authorize({ credential: t.token }), ERR.OWNER_CHANGED);
});
