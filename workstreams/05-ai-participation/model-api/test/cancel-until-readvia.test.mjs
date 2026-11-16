// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// U: the RunReceipt's own cancel.until (FATE-ACTS-5 §3: with a fate reader it fills cancel.until {lastValidBlockHeight})
//   U1 while AwaitingSigned the receipt carries the until cancelPhase computed (a block height)
//   U2 several open acts: the latest lifetime; one act without a lifetime: null (never guessed)
//   U3 once Completed the receipt's until is null
//   U4 without a cancel nothing is stored; the top-level run4Id stays null (no per-run ④ id in any contract)
// V: readVia on the acts port's answers — how ⑤ knows the state was obtained; never a chain claim
//   V1 ④'s client port: status reads by the gateway when told so; read:false, register and list are store-only;
//      not told → null
//   V2 the substitute: with a fate reader its status read is 'gateway', without one 'store-only'
// KEY-FREE: imports run-receipt.mjs (no imports) and acts-port.mjs (node:url, fate-reader.mjs with no imports); the
// ④ client, the registry and the fate reader are stub objects; loadFourActsPort (the only dynamic import) is not called.
// Nothing is signed, sent, read from disk or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localReceiptPort } from '../src/run-receipt.mjs';
import { READ_VIA, fourActsPort, localActsPort } from '../src/acts-port.mjs';

const view = keys => async () => ({ agentId: 'agent1', citizen: 'c1', policy: { version: 3 }, modeEpoch: 1, historySeq: 7,
  history: keys.map(k => ({ type: 'action', key: `ai:${k}`, source: 'ai' })), holds: [] });
const fateOf = table => async (agentId, key) => table[key];
const pending = (sig, lvbh) => ({ state: 'pending', signature: sig, signedAt: 1_762_000_000_000, lastValidBlockHeight: lvbh });

async function stopped(acts, table) {
  const port = localReceiptPort({ view: view(acts.map(a => a.requestId)), txState: async () => ({ state: 'unknown' }), fate: fateOf(table) });
  await port.open({ runId: 't1', decisionKey: 'dk1' });
  for (const a of acts) port.attachAct('t1', { requestId: a.requestId, outcome: 'sent', signature: a.signature, proposed: { name: 'Train' } });
  await port.close('t1');
  port.cancel('t1', 'before-sign');
  return port;
}

test('U1 AwaitingSigned: the receipt carries the computed until', async () => {
  const port = await stopped([{ requestId: 'p05.a', signature: 'sigA' }], { 'ai:p05.a': pending('sigA', 5000) });
  const r = await port.refreshFates('t1');
  assert.deepEqual([r.cancel.phase, r.cancel.until], ['AwaitingSigned', { lastValidBlockHeight: 5000 }]);
  assert.deepEqual(port.get('t1').cancel.until, port.cancelPhase('t1').until);
});

test('U2 the latest lifetime of the open acts; null when one is unknown', async () => {
  const two = await stopped([{ requestId: 'p05.a', signature: 'sigA' }, { requestId: 'p05.b', signature: 'sigB' }], { 'ai:p05.a': pending('sigA', 5000), 'ai:p05.b': pending('sigB', 6000) });
  assert.deepEqual((await two.refreshFates('t1')).cancel.until, { lastValidBlockHeight: 6000 });
  const gap = await stopped([{ requestId: 'p05.a', signature: 'sigA' }, { requestId: 'p05.b', signature: 'sigB' }], { 'ai:p05.a': pending('sigA', 5000), 'ai:p05.b': { state: 'pending', signature: 'sigB' } });
  const r = await gap.refreshFates('t1');
  assert.deepEqual([r.cancel.phase, r.cancel.until], ['AwaitingSigned', null]);
});

test('U3 Completed: the receipt until is null', async () => {
  const table = { 'ai:p05.a': pending('sigA', 5000) };
  const port = await stopped([{ requestId: 'p05.a', signature: 'sigA' }], table);
  await port.refreshFates('t1');
  table['ai:p05.a'] = { state: 'landed', signature: 'sigA', signedAt: 1_762_000_000_000, lastValidBlockHeight: 5000 };
  const r = await port.refreshFates('t1');
  assert.deepEqual([r.cancel.phase, r.cancel.until], ['Completed', null]);
});

test('U4 no cancel stores nothing; run4Id stays null', async () => {
  const port = localReceiptPort({ view: view(['p05.a']), txState: async () => ({ state: 'unknown' }), fate: fateOf({ 'ai:p05.a': pending('sigA', 5000) }) });
  await port.open({ runId: 't1', decisionKey: 'dk1' });
  port.attachAct('t1', { requestId: 'p05.a', outcome: 'sent', signature: 'sigA', proposed: { name: 'Train' } });
  await port.close('t1');
  const r = await port.refreshFates('t1');
  assert.deepEqual([r.cancel, port.cancelPhase('t1'), r.run4Id], [null, null, null]);
});

/** A stand-in for ④'s createActsClient: fixed receipts, no process. */
const client = { register: async a => ({ run4Id: 'act-1', runId: a.runId, state: 'registered' }), status: async () => ({ run4Id: 'act-1', state: 'pending' }), list: async runId => ({ runId, acts: [{ run4Id: 'act-1', state: 'pending' }] }) };

test('V1 ④\'s client port: readVia per answer', async () => {
  assert.deepEqual(READ_VIA, ['gateway', 'store-only']);
  const p = fourActsPort(client, { readVia: 'gateway' });
  assert.equal((await p.status({ agentId: 'a', key: 'ai:x' })).readVia, 'gateway');
  assert.equal((await p.status({ agentId: 'a', key: 'ai:x' }, { read: false })).readVia, 'store-only');
  assert.equal((await p.register({ agentId: 'a', key: 'ai:x', source: 'ai' })).readVia, 'store-only');
  assert.deepEqual((await p.list('r1')).acts.map(a => a.readVia), ['store-only']);
  assert.equal((await fourActsPort(client).status({ agentId: 'a', key: 'ai:x' })).readVia, null, 'not told: unknown');
  assert.equal((await fourActsPort(client, { readVia: 'store-only' }).status({ agentId: 'a', key: 'ai:x' })).readVia, 'store-only');
  const s = await p.status({ agentId: 'a', key: 'ai:x' });
  assert.deepEqual([s.connection, 'chain' in s], ['real', false], 'readVia says how it was read; nothing claims a chain');
});

test('V2 the substitute: gateway only with a fate reader', async () => {
  const row = { run4Id: 'act-1', agentId: 'a', key: 'ai:x' };
  const registry = { idOf: () => 'act-1', get: () => row, register: () => 'act-1', receipt: () => ({ run4Id: 'act-1', state: 'registered' }), refresh: async () => ({ run4Id: 'act-1', state: 'pending' }), byRun: () => [row] };
  const withFate = localActsPort({ registry, fate: async () => ({ state: 'pending' }) });
  assert.equal((await withFate.status({ agentId: 'a', key: 'ai:x' })).readVia, 'gateway');
  assert.equal((await withFate.status({ agentId: 'a', key: 'ai:x' }, { read: false })).readVia, 'store-only');
  const noFate = localActsPort({ registry });
  assert.equal((await noFate.status({ agentId: 'a', key: 'ai:x' })).readVia, 'store-only');
  assert.equal((await noFate.register({ agentId: 'a', key: 'ai:x', source: 'ai' })).readVia, 'store-only');
  assert.deepEqual((await noFate.list('r1')).acts.map(a => a.readVia), ['store-only']);
});
