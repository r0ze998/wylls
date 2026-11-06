// The test world gives a person and a resident the same rules and the same view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { STARTER_KIT } from '../world/rules.mjs';
import { addressOf, newKeypair, signRecord } from '../resident/keys.mjs';
import { ACTION_DOMAIN, JOIN_DOMAIN } from '../world/testworld.mjs';
import { NEEDS_KEYS } from '../world/identity.mjs';

test('a resident joins by the rule a person joins by: one village, the starter kit, nothing more', { skip: NEEDS_KEYS }, async () => {
  const env = await small({ residents: [{ id: 'ren', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 3, r: 1 } }] });
  const v = env.world.view(env.ps.Kou.address).villages;
  const kit = Object.fromEntries(['Food', 'Wood', 'Stone', 'Ore', 'Arms', 'Gold', 'Science', 'Influence'].map((r, i) => [r, STARTER_KIT[i]]));
  for (const x of v) assert.deepEqual(x.stores, kit);
  // A second join with the same key is refused, so no participant gets a second kit.
  const r = env.rs.ren;
  const body = { name: 'again', pos: { q: 9, r: 9 }, key: r.address };
  assert.throws(() => env.world.join({ body, sig: signRecord(JOIN_DOMAIN, body, r.keypair) }), /AlreadyJoined|this key has a village/);
});

test('every viewer reads the same public part; nobody is labelled AI or person; own quota only for oneself', async () => {
  const env = await small({ residents: [{ id: 'ren', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 3, r: 1 } }] });
  await run(env, 5);
  const a = env.world.view(env.rs.ren.address), b = env.world.view(env.ps.Kou.address), c = env.world.view('nobody');
  const pub = v => ({ ...v, me: undefined });
  assert.deepEqual(pub(a), pub(b));
  assert.deepEqual(pub(a), pub(c));
  assert.equal(c.me, null);
  assert.notEqual(a.me.citizen, b.me.citizen);
  assert.doesNotMatch(JSON.stringify(a), /"kind":"(ai|person|resident)"|"label"/);
});

test('actions: signed by the actor, idempotent per actor and key, cancellable only before they land', { skip: NEEDS_KEYS }, async () => {
  const env = await small({ people: [{ name: 'Kou', pos: { q: 3, r: 1 } }, { name: 'Mio', pos: { q: -2, r: 0 } }] });
  const kou = env.ps.Kou;
  const body = { key: 'k1', actor: kou.address, action: { name: 'Build', fields: { item: 0 } } };
  const sig = signRecord(ACTION_DOMAIN, body, kou.keypair);
  assert.equal(env.world.submit({ body, sig }).status, 'sent');
  assert.equal(env.world.submit({ body, sig }).replayed, true);
  const other = { ...body, action: { name: 'Build', fields: { item: 1 } } };
  assert.equal(env.world.submit({ body: other, sig: signRecord(ACTION_DOMAIN, other, kou.keypair) }).error.code, 'IdempotencyConflict');
  // Mio may use the same key name in its own namespace, and cannot sign for Kou.
  const mio = env.ps.Mio;
  const mb = { key: 'k1', actor: mio.address, action: { name: 'Build', fields: { item: 0 } } };
  assert.equal(env.world.submit({ body: mb, sig: signRecord(ACTION_DOMAIN, mb, mio.keypair) }).status, 'sent');
  const forged = { key: 'k2', actor: kou.address, action: { name: 'Build', fields: { item: 2 } } };
  assert.equal(env.world.submit({ body: forged, sig: signRecord(ACTION_DOMAIN, forged, mio.keypair) }).error.code, 'BadSignature');
  // Mio withdraws before the bell; Kou's lands and cannot be withdrawn afterwards.
  assert.deepEqual(env.world.cancel('k1', mio.address), { cancelled: true });
  env.world.operator.tick();
  assert.equal(env.world.status('k1', kou.address).fate, 'landed');
  assert.equal(env.world.status('k1', mio.address).fate, 'cancelled');
  assert.deepEqual(env.world.cancel('k1', kou.address), { cancelled: false, reason: 'AlreadyLanded' });
  // Only player actions exist for a participant.
  const op = { key: 'k3', actor: kou.address, action: { name: 'Mint', fields: {} } };
  assert.equal(env.world.submit({ body: op, sig: signRecord(ACTION_DOMAIN, op, kou.keypair) }).error.code, 'ActionNotAllowed');
});

test('a resident holds its own key (0600) and no participant can use it; its ports carry no operator power', { skip: NEEDS_KEYS }, async () => {
  const env = await small({ residents: [{ id: 'ren', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 3, r: 1 } }] });
  const r = env.rs.ren;
  const keyFile = path.join(env.dir, 'ren', 'resident.key');
  const { statSync } = await import('node:fs');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.notEqual(r.address, env.ps.Kou.address);
  assert.notEqual(r.address, env.operator.address, 'the owner\'s key is not the resident\'s');
  assert.equal(readFileSync(keyFile, 'utf8').trim().length, 64);
  assert.deepEqual(Object.keys(r.ports).sort(), ['board', 'execution', 'fallback', 'join', 'memory', 'observe', 'provider']);
  for (const p of Object.values(r.ports)) if (p && typeof p === 'object') assert.ok(!('operator' in p) && !('world' in p) && !('s' in p));
  // A fresh key cannot act before joining.
  const k = newKeypair();
  const b = { key: 'x', actor: addressOf(k), action: { name: 'Build', fields: { item: 0 } } };
  assert.equal(env.world.submit({ body: b, sig: signRecord(ACTION_DOMAIN, b, k) }).error.code, 'UnknownCitizen');
});
