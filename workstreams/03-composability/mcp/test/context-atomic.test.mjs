// WRITTEN, NOT RUN (Lane C, 2026-11-17): no part of this file has been executed. It imports src/game.mjs, whose static
// closure (read, not run) reaches permutation-server/web/frontier/fland.mjs and web/lang.mjs (subjects of refused tests)
// and files that name key APIs (fplay.mjs, session.mjs, the vendored noble curves). It is therefore NOT claimed
// independent or key-free: whether and how it may run is the coordinator's decision, through the repository's key-free
// guard only, never by another route. Inside the test itself nothing reaches a network or derives an address: the
// relay is a fake `fetch`, the clock a variable, `addressesFor` an injected function (the constructor's own seam), and
// the herald client's `pin` is replaced by a recorder.
//
// Game.context() publishes a new context only after it has been built:
//   A1 a first read whose addresses cannot be built: nothing is pinned; the next read retries and pins
//   A2 a switch whose addresses cannot be built: the old context, addresses, herald pin and history stay; after the
//      TTL the next read retries and switches, recording the old context once
//   A3 unchanged: a read of the same key after the TTL does not build again; within the TTL the relay is not read
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.mjs';

function setup() {
  const st = { t: 1_000_000, relay: { programId: 'P1', seasonId: 7 }, broken: new Set(), built: [], pins: [], reads: 0 };
  const fetch = async () => { st.reads++; const body = { ...st.relay }; return { status: 200, json: async () => body }; };
  const addressesFor = (programId, seasonId) => {
    st.built.push(`${programId}:${seasonId}`);
    if (st.broken.has(programId)) throw new TypeError(`bad program id ${programId}`);
    return { programId, seasonId, of: () => `addr-${programId}` };
  };
  const game = new Game({ relay: 'http://relay.invalid', herald: 'http://herald.invalid', fetch, now: () => st.t, contextTtlMs: 15_000, addressesFor });
  game.herald.pin = (id, addresses) => { st.pins.push([id, addresses?.programId ?? null]); };
  return { game, st };
}

test('A1 first read fails to build: nothing pinned, the next read retries', async () => {
  const { game, st } = setup();
  st.broken.add('P1');
  await assert.rejects(game.context(), /bad program id P1/);
  assert.equal(game.pinned, null);
  assert.equal(game.addresses, undefined);
  assert.deepEqual([st.pins, game.contextChanges], [[], []]);
  st.broken.clear();
  const c = await game.context();
  assert.equal(c.key, 'P1:7');
  assert.equal(game.addresses.programId, 'P1');
  assert.deepEqual(st.pins, [['7', 'P1']]);
  assert.deepEqual(st.built, ['P1:7', 'P1:7'], 'built again on the retry, not skipped');
});

test('A2 a switch fails to build: the old context stays whole; after the TTL the switch is retried', async () => {
  const { game, st } = setup();
  const a = await game.context();
  st.relay = { programId: 'P2', seasonId: 8 };
  st.broken.add('P2');
  st.t += 20_000;                                    // past the TTL: the relay is read again
  await assert.rejects(game.context(), /bad program id P2/);
  assert.equal(game.pinned, a, 'the old context object is still the published one');
  assert.equal(game.addresses.programId, 'P1');
  assert.deepEqual(st.pins, [['7', 'P1']], 'the herald stays pinned to the old world');
  assert.deepEqual(game.contextChanges, [], 'no history for a switch that did not happen');
  st.broken.clear();
  st.t += 1;                                         // pinnedAt was not moved by the failure: still past the TTL
  const b = await game.context();
  assert.equal(b.key, 'P2:8');
  assert.equal(game.addresses.programId, 'P2');
  assert.deepEqual(st.pins, [['7', 'P1'], ['8', 'P2']]);
  assert.equal(game.contextChanges.length, 1);
  assert.equal(game.contextChanges[0].key, 'P1:7');
  assert.equal(game.contextChanges[0].until, b.since);
});

test('A3 unchanged: within the TTL no read; the same key after the TTL is not built again', async () => {
  const { game, st } = setup();
  const a = await game.context();
  st.t += 5_000;
  assert.equal(await game.context(), a);
  assert.equal(st.reads, 1, 'within the TTL the relay is not read');
  st.t += 20_000;
  assert.equal(await game.context(), a);
  assert.equal(st.reads, 2);
  assert.deepEqual(st.built, ['P1:7'], 'the same key is not built again');
  assert.deepEqual(st.pins, [['7', 'P1']]);
});
