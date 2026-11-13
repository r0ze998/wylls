// The page's `marchOpen` contract (flocalplay-march.mjs): the capability read, the readiness booleans (all false
// today), and the one answer the UI reads. THIS FILE MAKES NO KEY:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/web-frontier-local-play-march-open.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../permutation-server/web/frontier/flocalplay-march.mjs';
import { LOCAL_ACT_NAMES } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import * as R from '../src/frontier/local-play-march.mjs';
import { WORLD_POST_ROUTES } from '../src/frontier/local-play-launcher.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', ORIGIN = 'http://localhost:41926', INST = 'ab'.repeat(32);
const ALL_READY = Object.freeze({ pageSend: true, keeperArrival: true, liveProven: true });
const answerOf = over => ({ schema: P.LOCAL_MARCH_CAPABILITY_SCHEMA, wallet: WALLET, instance: INST, commands: ['Depart'], reveal: 'keeper', trial: false, ...over });
const stub = (status, body, seen = []) => async (url, init) => { seen.push([url, init]); return { ok: status === 200, status, json: async () => body }; };

test('the economy list stays the six; the march has its own paths, the relay\'s and the launcher\'s', () => {
  assert.deepEqual([...LOCAL_ACT_NAMES], ['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster']);
  assert.equal(P.LOCAL_MARCH_CAPABILITY_SCHEMA, R.LOCAL_MARCH_CAPABILITY_SCHEMA);
  for (const [k, path] of [['capability', P.LOCAL_MARCH_CAPABILITY_PATH], ['submit', P.LOCAL_MARCH_SUBMIT_PATH], ['status', P.LOCAL_MARCH_STATUS_PATH]]) {
    assert.equal('/gw' + R.LOCAL_MARCH_ROUTES[k].slice(5), path); assert.ok(WORLD_POST_ROUTES.includes(path), path);
  }
});

test('the readiness booleans: pageSend and keeperArrival true (reviewed), liveProven false; frozen; only exactly-true booleans are ready', () => {
  assert.ok(Object.isFrozen(P.LOCAL_MARCH_READY));
  assert.deepEqual({ ...P.LOCAL_MARCH_READY }, { pageSend: true, keeperArrival: true, liveProven: false });
  assert.equal(P.localMarchReady(), false);
  assert.equal(P.localMarchReady(ALL_READY), true);
  for (const r of [{ ...ALL_READY, liveProven: 1 }, { pageSend: true, keeperArrival: true }, { ...ALL_READY, extra: true }, null, []]) assert.equal(P.localMarchReady(r), false, JSON.stringify(r));
  // the test-only trial stands in for liveProven ONLY; never for pageSend or keeperArrival
  const built = { pageSend: true, keeperArrival: true, liveProven: false };
  assert.equal(P.localMarchReady(built), false); assert.equal(P.localMarchReady(built, { trial: true }), true); assert.equal(P.localMarchReady(built, { trial: 1 }), false);
  assert.equal(P.localMarchReady(P.LOCAL_MARCH_READY, { trial: true }), true, 'today: built and reviewed; only the trial entry stands in for liveProven');
  assert.equal(P.localMarchReady(P.LOCAL_MARCH_READY, { trial: false }), false, 'today, without the trial entry: closed (liveProven false)');
  assert.equal(P.localMarchReady({ ...built, keeperArrival: false }, { trial: true }), false);
});

test('the capability read: believed only for this wallet and the launcher\'s instance; one POST; anything else null', async () => {
  const seen = [];
  assert.deepEqual(await P.readLocalMarchCapability({ origin: ORIGIN, wallet: WALLET, expectedInstance: INST, request: stub(200, answerOf({}), seen) }), { wallet: WALLET, instance: INST, trial: false, relay: ORIGIN });
  assert.deepEqual(await P.readLocalMarchCapability({ origin: ORIGIN, wallet: WALLET, expectedInstance: INST, request: stub(200, answerOf({ trial: true })) }), { wallet: WALLET, instance: INST, trial: true, relay: ORIGIN });
  assert.equal(seen.length, 1); assert.equal(seen[0][0], ORIGIN + '/gw/f/local-play/march/capability');
  assert.deepEqual(JSON.parse(seen[0][1].body), { schema: P.LOCAL_MARCH_CAPABILITY_SCHEMA }); assert.equal(seen[0][1].credentials, 'omit'); assert.equal(seen[0][1].method, 'POST');
  const no = async (args, why) => assert.equal(await P.readLocalMarchCapability({ origin: ORIGIN, wallet: WALLET, expectedInstance: INST, request: stub(200, answerOf({})), ...args }), null, why);
  await no({ request: stub(404, { code: 'NotFound' }) }, 'not served');
  await no({ request: stub(200, answerOf({ instance: 'cd'.repeat(32) })) }, 'another instance');
  await no({ request: stub(200, answerOf({ wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' })) }, 'another wallet');
  await no({ request: stub(200, answerOf({ commands: ['Depart', 'Reveal'] })) }, 'more commands');
  await no({ request: stub(200, answerOf({ reveal: 'page' })) }, 'another reveal');
  await no({ request: stub(200, { ...answerOf({}), extra: 1 }) }, 'longer');
  await no({ request: stub(200, answerOf({ trial: 'yes' })) }, 'a trial that is not a boolean');
  { const b = answerOf({}); delete b.trial; await no({ request: stub(200, b) }, 'no trial key (an older relay)'); }
  await no({ expectedInstance: null }, 'no launcher statement');
  await no({ expectedInstance: '0'.repeat(64) }, 'zero instance');
  await no({ origin: ORIGIN + '/x' }, 'not an exact origin');
  await no({ request: async () => { throw new Error('down'); } }, 'failure');
  await no({ request: () => new Promise(() => {}), timeoutMs: 5 }, 'timeout');
});

test('marchOpen: closed by default; each condition decides in order; open only when all hold', () => {
  const cap = { wallet: WALLET, instance: INST, trial: false, relay: ORIGIN }, gate = { ok: true, relay: ORIGIN }, holding = { p: 2, q: 0, site: 11 }, instance = INST;
  const keys = ['open', 'reason', 'capability', 'ready', 'trial', 'held'];
  const a0 = P.localMarchOpen();
  assert.deepEqual(Object.keys(a0), keys); assert.ok(Object.isFrozen(a0));
  assert.deepEqual({ ...a0, held: [...a0.held] }, { open: false, reason: 'LocalMarchNoCapability', capability: false, ready: false, trial: false, held: [] });
  // TODAY, without the trial: an instance-verified capability, a good gate and village — still closed (liveProven false)
  const today = P.localMarchOpen({ capability: cap, wallet: WALLET, instance, gate, holding });
  assert.deepEqual([today.open, today.reason, today.capability, today.ready], [false, 'LocalMarchNotReady', true, false]);
  // (with readiness given by a test only) the rest, in order
  const at = over => P.localMarchOpen({ capability: cap, wallet: WALLET, instance, ready: ALL_READY, gate, holding, ...over });
  // the capability is bound to the relay and the instance it was read for: a switch discards it
  assert.equal(at({ gate: { ok: true, relay: 'http://localhost:41931/gw' } }).reason, 'LocalMarchNoCapability', 'another relay');
  assert.equal(at({ instance: 'cd'.repeat(32) }).reason, 'LocalMarchNoCapability', 'another instance');
  assert.equal(at({ instance: null }).reason, 'LocalMarchNoCapability', 'no launcher statement now');
  assert.equal(at({ capability: { ...cap, relay: undefined } }).reason, 'LocalMarchNoCapability', 'a capability not bound to a relay');
  assert.equal(at({ wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' }).reason, 'LocalMarchNoCapability');
  assert.equal(at({ gate: { ok: false, code: 'LocalDepartSigner' } }).reason, 'LocalMarchGate');
  assert.equal(at({ holding: { p: 200, q: 0, site: 1 } }).reason, 'LocalMarchWideHolding');
  assert.equal(at({ holding: null }).reason, 'LocalMarchWideHolding');
  const h = at({ held: ['sig1'] }); assert.deepEqual([h.open, h.reason, [...h.held]], [false, 'LocalMarchHeld', ['sig1']]);
  const o = at({}); assert.deepEqual([o.open, o.reason, o.trial], [true, 'open', false]);
  // THE TEST-ONLY TRIAL: built (pageSend, keeperArrival) but not liveProven; it opens only with BOTH the page's entry and the relay's word
  const built = { pageSend: true, keeperArrival: true, liveProven: false }, tcap = { ...cap, trial: true };
  const tr = over => P.localMarchOpen({ capability: tcap, wallet: WALLET, instance, ready: built, gate, holding, ...over });
  assert.deepEqual([tr({}).open, tr({}).reason], [false, 'LocalMarchNotReady'], 'the relay\'s word alone does not open it');
  assert.equal(P.localMarchOpen({ capability: cap, wallet: WALLET, instance, ready: built, gate, holding, trialEntry: true }).reason, 'LocalMarchNotReady', 'the page\'s entry alone does not open it');
  assert.equal(tr({ trialEntry: 'true' }).reason, 'LocalMarchNotReady');
  const t = tr({ trialEntry: true }); assert.deepEqual([t.open, t.reason, t.trial], [true, 'open', true]);
  assert.equal(tr({ trialEntry: true, holding: { p: 200, q: 0, site: 1 } }).reason, 'LocalMarchWideHolding', 'the trial changes no other condition');
  assert.equal(tr({ trialEntry: true, held: ['s'] }).reason, 'LocalMarchHeld');
  const td = P.localMarchOpen({ capability: tcap, wallet: WALLET, instance, gate, holding, trialEntry: true });
  assert.deepEqual([td.open, td.reason, td.trial], [true, 'open', true], 'today\'s readiness: open on a trial world only (both the page\'s entry and the relay\'s word)');
  assert.equal(P.localMarchOpen({ capability: tcap, wallet: WALLET, instance, gate, holding }).reason, 'LocalMarchNotReady', 'today: the relay\'s word without the page\'s entry stays closed');
  assert.deepEqual([...P.LOCAL_MARCH_REASONS], ['LocalMarchNoCapability', 'LocalMarchNotReady', 'LocalMarchGate', 'LocalMarchWideHolding', 'LocalMarchHeld', 'open']);
});

test('the module: no key made, no browser storage, no retry loop, no conquest flag', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay-march.mjs', import.meta.url), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // (2026-11-13: the module now also holds the page's local Depart, which signs with the live memory wallet; it makes no key)
  for (const w of ['generateKey', 'Keypair', 'localStorage', 'sessionStorage', 'browserStorage', 'sendMarchRetrying', 'nudge', 'heapConfirmed', 'pageBinding', 'setInterval']) assert.ok(!src.includes(w), w);
  assert.match(src, /LOCAL_MARCH_READY = Object\.freeze\(\{ pageSend: true, keeperArrival: true, liveProven: false \}\);/);
});
