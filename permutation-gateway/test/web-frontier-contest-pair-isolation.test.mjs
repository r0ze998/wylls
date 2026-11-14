// TEST-ONLY contest pair, the page side: two players in ONE world (same program, Season and runner instance), each with
// its own wallet and its own relay. Nothing of one player's is taken for the other's: the unconfirmed-order ledger's scope,
// the march capability, and the gate's relay. (The relay's own refusal of another signer is proven in
// frontier-local-play-march.test.mjs / -relay / -resident; the launcher pins each relay to its wallet:
// frontier-local-play-contest-pair.test.mjs.) No world, no key, no request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localActScope, createLocalActLedger } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { localMarchOpen } from '../../permutation-server/web/frontier/flocalplay-march.mjs';

const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', SEASON = '7pshbHEvHUftsEcrGUPb9FoVXWmV1gEs1R1cZCGXjSCt';
const A = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', B = 'Avexj6jFeyqKwd6V9Y8M7PVSqQEWmFJXAnAroC1wv3FJ';
const RELAY_A = 'http://localhost:41926/gw', RELAY_B = 'http://localhost:41931/gw';
const INSTANCE = 'a'.repeat(64);
const id = address => ({ address, programId: PROGRAM, seasonAddress: SEASON });

test('the unconfirmed-order ledger: A\'s held order is never seen, asked about or released under B\'s scope', () => {
  const sa = localActScope({ identity: id(A), relay: RELAY_A }), sb = localActScope({ identity: id(B), relay: RELAY_B });
  assert.ok(sa && sb && sa !== sb);
  // even a page of B that somehow reached A's relay has another scope (its wallet), and A through B's relay too
  assert.notEqual(localActScope({ identity: id(B), relay: RELAY_A }), sa);
  assert.notEqual(localActScope({ identity: id(A), relay: RELAY_B }), sa);
  const ledger = createLocalActLedger();
  ledger.hold(sa, 'Muster|k', { name: 'Muster', signature: 'sigA' });
  assert.equal(ledger.held(sb, 'Muster|k'), null, 'B sees nothing of A\'s');
  assert.deepEqual(ledger.list(sb), []);
  assert.equal(ledger.held(sa, 'Muster|k').signature, 'sigA', 'A\'s stays A\'s');
});

test('the march capability: A\'s is refused for B (another wallet) and through another relay; B\'s own opens', () => {
  const capA = { wallet: A, instance: INSTANCE, relay: RELAY_A, trial: true };
  const capB = { wallet: B, instance: INSTANCE, relay: RELAY_B, trial: true };
  const holding = { p: 1, q: 1, site: 3 };
  const open = (capability, wallet, relay) => localMarchOpen({ capability, wallet, instance: INSTANCE, gate: { ok: true, relay }, holding, held: [], trialEntry: true });
  assert.equal(open(capA, A, RELAY_A).open, true, 'A with its own');
  assert.equal(open(capB, B, RELAY_B).open, true, 'B with its own');
  assert.equal(open(capA, B, RELAY_B).reason, 'LocalMarchNoCapability', 'A\'s capability for B: refused');
  assert.equal(open(capB, A, RELAY_A).reason, 'LocalMarchNoCapability', 'B\'s for A: refused');
  assert.equal(open(capB, B, RELAY_A).reason, 'LocalMarchNoCapability', 'B\'s capability through A\'s relay: refused');
  assert.equal(open({ ...capB, instance: 'b'.repeat(64) }, B, RELAY_B).reason, 'LocalMarchNoCapability', 'another world\'s instance: refused');
});
