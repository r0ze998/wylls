// Restarts: the off-chain state is one JSON file written atomically; the
// chain is the source of truth that the restarted process reads again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/store.mjs';
import { A, B, acquire, login, op, stack, transfer } from './fixtures.mjs';

test('after a restart from the file, holdings, waitlist, world, credentials and processed events continue; replay is idempotent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-resident-'));
  const file = path.join(dir, 'state.json');
  const s = stack({ store: new FileStore(file) });
  const a = await acquire(s, A);
  s.registry.publish();
  const ta = await login(s, A, a.assetId);
  await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'r-1' });
  // A transfer lands while the off-chain process is down (no notification reaches it).
  await transfer(s, a.assetId, A, B, { notify: false });
  const s2 = stack({ store: new FileStore(file), chain: s.chain });
  assert.equal(s2.registry.published, true);
  assert.equal(s2.world.snapshot(a.residentId).stores.food, 110);
  // Replaying the chain's events from the last processed sequence catches the missed transfer; replaying again changes nothing.
  const first = await s2.registry.replay(s.chain);
  assert.ok(first.some(r => r.applied === 'confirmed' && r.holder === B.publicKey));
  const second = await s2.registry.replay(s.chain);
  assert.deepEqual(second, []);
  assert.equal(s2.registry.resident(a.assetId).epoch, 1);
  // The old login token was in the file; the replayed transfer revoked it, so it is refused as unknown.
  const e = await s2.auth.authorize({ credential: ta.token }).catch(x => x);
  assert.equal(e.code, 'BadCredential');
  const tb = await login(s2, B, a.assetId);
  assert.equal(tb.epoch, 1);
  // The file is plain JSON and holds no secret: no private key, no raw token.
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(ta.token), false);
  assert.equal(text.includes(tb.token), false);
  assert.ok(JSON.parse(text).registry.residents[a.assetId]);
});
