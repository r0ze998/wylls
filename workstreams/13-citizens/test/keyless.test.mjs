// The keyless mode itself (runs only under test/keyless-guard.mjs, WS13_KEYLESS=1): the guard really blocks key,
// signature and HMAC functions, and the shared set-up (small(), runDemo) makes no key and writes no key file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHash, generateKeyPairSync, createPrivateKey, sign, createHmac } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { KEYLESS } from '../world/identity.mjs';
import { small, run, tmp } from './helpers.mjs';
import { runDemo } from '../demo/run-demo.mjs';
import { ACTION_DOMAIN } from '../world/testworld.mjs';

const ONLY_KEYLESS = KEYLESS ? false : 'needs the keyless guard (node --import ./test/keyless-guard.mjs)';

const files = dir => readdirSync(dir).flatMap(f => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });

test('the guard blocks key making, signing and HMAC; hashing still works', { skip: ONLY_KEYLESS }, () => {
  assert.ok(globalThis.__WS13_KEYLESS_GUARD__, 'the guard was preloaded');
  for (const f of [() => generateKeyPairSync('ed25519'), () => createPrivateKey('x'), () => sign(null, Buffer.from('x'), 'k'), () => createHmac('sha256', 'k'), () => crypto.generateKeyPairSync('ed25519')]) {
    assert.throws(f, /keyless guard/);
  }
  assert.equal(createHash('sha256').update('x').digest('hex').length, 64);
});

test('shared set-up is keyless: addresses are labels, no key file, and the world still wants the unsigned mark', { skip: ONLY_KEYLESS }, async () => {
  const env = await small({ residents: [{ id: 'ren', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 2, r: 0 } }] });
  await run(env, 3);
  assert.equal(env.world.s.keyless, true);
  assert.equal(env.rs.ren.identity.keyed, false);
  assert.equal(env.rs.ren.keypair, null);
  assert.equal(env.ps.Kou.identity.keyed, false);
  assert.match(env.rs.ren.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.deepEqual(files(env.dir).filter(f => f.endsWith('.key')), []);
  const body = { key: 'x', actor: env.ps.Kou.address, action: { name: 'Build', fields: { item: 0 } } };
  assert.equal(env.world.submit({ body, sig: 'something-else' }).error.code, 'BadSignature');
  void ACTION_DOMAIN;
});

test('the demo runs keyless end to end, with a restart and a crash, and writes no key file', { skip: ONLY_KEYLESS }, async () => {
  const out = tmp();
  const r = await runDemo({ out, bells: 120, restartAt: 50, crash: { resident: 'ren', at: 'after-submit', turn: 3 } });
  assert.equal(r.summary.mechanical.restarts.length, 2);
  assert.deepEqual(files(out).filter(f => f.endsWith('.key')), []);
  assert.ok(r.summary.mechanical.residents.asa.decisions > 5);
});
