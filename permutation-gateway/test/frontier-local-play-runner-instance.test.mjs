// The runner instance id on its way from the runner's public metadata line to the relays that send:
//
//   runner line 1  `runner_instance`  →  launcher `runnerInstanceOf`  →  relay command line `--runner-instance <hex>`
//   →  `parseArgs`  →  `relaysFromArgs`  →  the depart relay, the resident relay and the conquest routes alike
//
// What the id is for is tested with the relay (frontier-local-play-relay.test.mjs: a sent transaction is settled as
// "did not take effect" only by the pinned runner's own answer). Here: the wiring, and that a runner which states no
// id starts exactly as before with that settling simply off. No runner states one today (the Rust change is its
// owner's and is not made). Stand-ins only: no process, no chain, no key; runs under the no-key guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs, relaysFromArgs, conquestFromArgs, RUNNER_INSTANCE_RE } from '../src/frontier/local-play-relay-server.mjs';
import { runnerInstanceOf } from '../src/frontier/local-play-launcher.mjs';
import { createLocalPlayRelay, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { createLocalPlayResident } from '../src/frontier/local-play-resident.mjs';
import { CONQUEST_OPEN_CONDITIONS } from '../src/frontier/local-play-conquest.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], WALLET = encode(Uint8Array.from({ length: 32 }, (_, i) => 90 + i));
const ID = 'ab'.repeat(32);
const ARGS = ['--local-play', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--wallet', WALLET, '--ruleset-hash', LOCAL_PLAY_RULESET_HASH,
  '--prepare-bin', '/abs/depart', '--cu-limit', '1000000', '--loaded-limit', '67108864', '--listen-port', '41965'];
const BAD = ['', 'ab', 'AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), '00'.repeat(32), ` ${'ab'.repeat(32)}`, '0x' + 'ab'.repeat(31)];

test('the launcher takes the id from the runner\'s own line: absent → none (as before); 64 lowercase hex → that id; present but anything else → the start is refused', () => {
  // a runner that states none: every existing runner today
  for (const meta of [{}, { program: 'x', rpc_url: 'y' }, null, undefined, 'line', 7]) assert.deepEqual(runnerInstanceOf(meta), { ok: true, id: null });
  assert.deepEqual(runnerInstanceOf({ runner_instance: ID }), { ok: true, id: ID });
  // present but malformed: never passed on, never ignored
  for (const v of [...BAD, null, undefined, 7, {}, [ID], true]) assert.deepEqual(runnerInstanceOf({ runner_instance: v }), { ok: false, id: null }, JSON.stringify(v));
  // an inherited key is not the line's own
  assert.deepEqual(runnerInstanceOf(Object.create({ runner_instance: ID })), { ok: true, id: null });
  // the launcher's start: refused when not ok, the flag only with an id, placed among the relay's arguments
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("const instance = runnerInstanceOf(meta);\n    if (!instance.ok) throw fault('RunnerNotReady', 503);"));
  assert.ok(src.includes("const instanceArgs = instance.id === null ? [] : ['--runner-instance', instance.id];"));
  // (`...economyArgs`: the launcher's own `--economy` handed on in the same place — frontier-local-play-act.test.mjs)
  assert.ok(src.includes("...conquest, ...instanceArgs, ...economyArgs, ...trialArgs, '--cu-limit', '1000000', '--loaded-limit', '67108864'"))   // (2026-11-13, march lane: the test-only trial word, natural only);
  assert.equal([...src.matchAll(/'--runner-instance'/g)].length, 1, 'the flag is written in one place only');
});

test('the relay\'s command line: the flag is optional; given, it must be exactly 64 lowercase hex; it is kept apart from the closed configuration', () => {
  const plain = parseArgs(ARGS);
  assert.equal(plain.runnerInstance, null); assert.ok(!Object.hasOwn(plain.cfg, 'runnerInstance'));
  // (`economy`: the page-signed economy routes, off unless asked for in words — frontier-local-play-act.test.mjs)
  assert.deepEqual(Object.keys(plain), ['port', 'cfg', 'previewBin', 'residentBin', 'conquestBin', 'conquestCapability', 'runnerInstance', 'economy', 'marchTrial']); assert.equal(plain.economy, false); assert.equal(plain.marchTrial, false);
  const pinned = parseArgs([...ARGS, '--runner-instance', ID]);
  assert.equal(pinned.runnerInstance, ID); assert.deepEqual(pinned.cfg, plain.cfg, 'the relay\'s own configuration is the same with or without it');
  // anywhere among the arguments (the launcher puts it before --cu-limit)
  assert.equal(parseArgs([...ARGS.slice(0, 13), '--runner-instance', ID, ...ARGS.slice(13)]).runnerInstance, ID);
  for (const v of BAD) assert.throws(() => parseArgs([...ARGS, '--runner-instance', v]), /--runner-instance must be 64 lowercase hex/, JSON.stringify(v));
  assert.throws(() => parseArgs([...ARGS, '--runner-instance']), /bad argument/);
  assert.throws(() => parseArgs([...ARGS, '--runner-instance', ID, '--runner-instance', ID]), /bad argument/);
  assert.ok(RUNNER_INSTANCE_RE.test(ID));
});

test('one id to all three relays that send; none given → each is built exactly as before', () => {
  const calls = [];
  const make = { relay: a => { calls.push(['relay', a]); return 'R'; }, resident: a => { calls.push(['resident', a]); return 'S'; }, conquest: a => { calls.push(['conquest', a]); return 'C'; } };
  const cfg = parseArgs(ARGS).cfg;
  // none: no `runnerInstance` key reaches the depart or the resident factory at all
  let got = relaysFromArgs({ cfg, residentBin: '/abs/resident', conquestBin: '/abs/conquest', conquestCapability: null, runnerInstance: null }, make);
  assert.deepEqual(got, { relay: 'R', resident: 'S', conquest: 'C' });
  assert.deepEqual(calls, [['relay', { cfg }], ['resident', { cfg, residentBin: '/abs/resident' }], ['conquest', { cfg, conquestBin: '/abs/conquest', conquestCapability: null, runnerInstance: null }]]);
  // given: the same id to each
  calls.length = 0;
  relaysFromArgs({ cfg, residentBin: '/abs/resident', conquestBin: '/abs/conquest', conquestCapability: null, runnerInstance: ID }, make);
  assert.deepEqual(calls.map(([n, a]) => [n, a.runnerInstance]), [['relay', ID], ['resident', ID], ['conquest', ID]]);
  // no resident binary: no resident relay; the others unchanged
  calls.length = 0;
  got = relaysFromArgs({ cfg, runnerInstance: ID }, make);
  assert.equal(got.resident, null); assert.deepEqual(calls.map(([n]) => n), ['relay', 'conquest']);
  // the conquest routes NOT asked for (no --conquest-bin, the ordinary world): the depart and resident relays are pinned all the same
  calls.length = 0;
  got = relaysFromArgs({ cfg, residentBin: '/abs/resident', conquestBin: null, conquestCapability: null, runnerInstance: ID }, { relay: make.relay, resident: make.resident });
  assert.deepEqual([got.relay, got.resident, got.conquest], ['R', 'S', null]);
  assert.deepEqual(calls, [['relay', { cfg, runnerInstance: ID }], ['resident', { cfg, residentBin: '/abs/resident', runnerInstance: ID }]]);
  // the conquest routes' factory: called as before without an id, and with the id as one more key when there is one
  const created = [];
  conquestFromArgs({ cfg, conquestBin: '/abs/conquest', conquestCapability: null }, { create: a => { created.push(a); return 'C'; } });
  conquestFromArgs({ cfg, conquestBin: '/abs/conquest', conquestCapability: null, runnerInstance: ID }, { create: a => { created.push(a); return 'C'; } });
  assert.deepEqual(created, [{ cfg, conquestBin: '/abs/conquest', capability: null }, { cfg, conquestBin: '/abs/conquest', capability: null, runnerInstance: ID }]);
  assert.equal(conquestFromArgs({ cfg, conquestBin: null, conquestCapability: null, runnerInstance: ID }, { create: () => { throw new Error('not built'); } }), null);
});

test('the real factories take it: a relay with an id is built, a malformed one is refused, and the conquest routes stay closed either way', () => {
  const cfg = parseArgs(ARGS).cfg, adapter = { prepare: async () => ({ status: 'blocked' }), close() {} };
  assert.equal(typeof createLocalPlayRelay({ cfg, prepare: adapter, runnerInstance: ID }).status, 'function');
  assert.equal(typeof createLocalPlayRelay({ cfg, prepare: adapter }).status, 'function');
  assert.equal(typeof createLocalPlayResident({ cfg, residentBin: '/abs/resident', prepare: adapter, runnerInstance: ID }).status, 'function');
  for (const v of BAD) assert.throws(() => createLocalPlayRelay({ cfg, prepare: adapter, runnerInstance: v }), /bad runner instance/, JSON.stringify(v));
  // the id opens nothing: with or without it the conquest routes cannot be built while a condition is false
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
  for (const runnerInstance of [null, ID]) assert.throws(() => conquestFromArgs({ cfg, conquestBin: '/abs/conquest', conquestCapability: null, runnerInstance }), /closed \(not established: heapConfirmed, pageBinding\)/);
});
