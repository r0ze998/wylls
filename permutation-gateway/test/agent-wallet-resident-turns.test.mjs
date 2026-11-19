// One action per resident per turn (Q16-2, owner decision 2026-11-18 21:44) through the agent wallet and the relay:
// the operator AI runner (`ai`), the resident's own MCP (`mcp`) and the owner's own page racing for ONE resident in ONE
// bell — exactly one lands; the next bell they may act again; a person's Citizen without an auto agent is unaffected;
// the lease survives a restart of the relay. A KEY-USING test (scripts/ci/node-key-tests.txt): in-memory test keys
// sign; the chain is the fixtures' scripted stand-in; nothing leaves this process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { toBase64 } from '../client/src/bytes.mjs';
import { CLOCK_SYSVAR } from '../client/src/frontier/addresses.mjs';
import { shapeMessage } from '../client/src/frontier/shapes.mjs';
import { wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk } from '../client/src/talk-node.mjs';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { createResidentTurns } from '../src/frontier/resident-turns.mjs';
import { A, actionRequest, call, clockAccount, createAgent, delegate, GENESIS, ownerCommand, PROGRAM, relay, sound, VILLAGE } from './agent-wallet-fixtures.mjs';

const IP = '127.0.0.1';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-resident-turns-'));
const BELL0 = 6;   // the fixtures' clock: GENESIS + 3 600 s = bell 6

/** A relay with the lease (as server.mjs always attaches it) and one owner whose agent is in auto mode and delegated. */
async function world({ dir = tmp() } = {}) {
  const r = relay();
  r.ctx.residentTurns = createResidentTurns({ dir });
  r.ctx.chain.clockTtlMs = 0;   // (the tests move the chain clock between bells)
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const agent = await createAgent(r, owner);
  const mode = await call(r.public, 'POST', '/f/agent/command', { body: ownerCommand(owner, 'mode', { agentId: agent.agentId, params: { mode: 'auto' } }), ip: IP });
  assert.equal(mode.json.agent.mode, 'auto');
  delegate(r, o, agent.agentKey);
  const setBell = b => r.chain.set(CLOCK_SYSVAR, { data: clockAccount(GENESIS + 600 * b + 1) });
  const act = (source, over = {}) => r.gateway.submit(actionRequest(agent.agentId, { source, modeEpoch: 1, ...over }), source === 'ai' ? { runner: true } : { capability: agent.capability });
  return { r, owner, o, agent, setBell, act, dir };
}

/** The owner's own page write (POST /f/relay): Train signed by the owner's wallet for its own Citizen. */
async function ownerTrain(r, owner, n = 1) {
  const g = await call(r.public, 'GET', '/f/relay', { ip: IP });
  const actor = owner.publicKey.toBase58();
  const message = shapeMessage({ programId: PROGRAM, name: 'Train', fields: { unit: 1, n }, feePayer: g.json.feePayer, recentBlockhash: g.json.blockhash,
    accounts: { actor, season: A.season, citizen: A.citizen(actor), holding: A.holding(...VILLAGE), province: A.province(VILLAGE[0], VILLAGE[1]), frontier: A.frontier } });
  const tx = toBase64(wireTransaction(message, { [actor]: signTalk(message, owner) }));
  return call(r.public, 'POST', '/f/relay', { body: { tx }, ip: IP });
}

test('the operator runner and the resident\'s own MCP racing in one bell: exactly one lands, the other is ResidentAlreadyActed with the bell', async () => {
  const { r, o, act, setBell } = await world();
  const [ai, mcp] = await Promise.all([act('ai'), act('mcp', { name: 'Train', fields: { unit: 1, n: '2' } })]);
  const results = [ai, mcp];
  assert.equal(results.filter(x => x.status === 'sent').length, 1, JSON.stringify(results));
  const lost = results.find(x => x.status !== 'sent');
  assert.equal(lost.status, 'refused');
  assert.equal(lost.error.code, ERR.RESIDENT_ALREADY_ACTED);
  assert.equal(lost.error.bell, BELL0); assert.equal(lost.error.nextBell, BELL0 + 1); assert.equal(lost.error.citizen, A.citizen(o));
  assert.deepEqual(lost.charges, [], 'a refused turn charges nothing');
  assert.equal(r.chain.sent.length, 1, 'one transaction left the relay');
  // a third writer in the same bell (the owner's browser command through the agent wallet): refused too
  const browser = await r.gateway.submit(actionRequest(r.gateway.ledger.agents()[0].agentId, { source: 'browser', modeEpoch: 1 }), { owner: o });
  assert.equal(browser.error?.code, ERR.RESIDENT_ALREADY_ACTED);
  assert.equal(r.chain.sent.length, 1);
  // the next bell: the writer that lost acts; then the other is refused in that bell
  setBell(BELL0 + 1);
  const loser = ai.status === 'sent' ? 'mcp' : 'ai';
  assert.equal((await act(loser)).status, 'sent');
  const winner = loser === 'ai' ? 'mcp' : 'ai';
  assert.equal((await act(winner)).error?.code, ERR.RESIDENT_ALREADY_ACTED);
  setBell(BELL0 + 2);
  assert.equal((await act(winner)).status, 'sent');
  assert.equal(r.chain.sent.length, 3);
  sound(r);
});

test('many concurrent writers for one resident in one bell: exactly one is sent', async () => {
  const { r, act } = await world();
  const all = await Promise.all(Array.from({ length: 6 }, (_, i) => act(i % 2 ? 'ai' : 'mcp')));
  assert.equal(all.filter(x => x.status === 'sent').length, 1, JSON.stringify(all.map(x => x.error?.code ?? x.status)));
  assert.ok(all.filter(x => x.status !== 'sent').every(x => x.error.code === ERR.RESIDENT_ALREADY_ACTED));
  assert.equal(r.chain.sent.length, 1);
});

test('the owner\'s own page shares the resident while its agent is in auto mode; a person\'s Citizen without an auto agent is unaffected', async () => {
  const { r, owner, act, agent } = await world();
  assert.equal((await act('mcp')).status, 'sent');
  const page = await ownerTrain(r, owner);
  assert.equal(page.status, 409, JSON.stringify(page.json)); assert.equal(page.json.code, 'ResidentAlreadyActed'); assert.equal(page.json.bell, BELL0);
  assert.equal(r.chain.sent.length, 1);
  // the owner stops the agent (manual): its Citizen is a person's again — its page acts as often as before
  const manual = await call(r.public, 'POST', '/f/agent/command', { body: ownerCommand(owner, 'mode', { agentId: agent.agentId, params: { mode: 'manual' } }), ip: IP });
  assert.equal(manual.json.agent.mode, 'manual');
  for (const n of [1, 2]) assert.equal((await ownerTrain(r, owner, n)).status, 200);
  // a person with no agent at all, in the same bell: two page actions, both sent
  const person = Keypair.generate();
  r.chain.set(A.citizen(person.publicKey.toBase58()), { data: (await import('./agent-wallet-fixtures.mjs')).citizenAccount(person.publicKey.toBase58()) });
  for (const n of [1, 2]) { const res = await ownerTrain(r, person, n); assert.equal(res.status, 200, JSON.stringify(res.json)); }
  assert.equal(r.chain.sent.length, 5);
});

test('a refusal before the send gives the turn back; restart safety: a new relay over the same lease directory still refuses the bell', async () => {
  const dir = tmp();
  const a = await world({ dir });
  // refused before anything left (simulation fails): the turn is not spent
  const failing = a.r.chain.simulateTransaction;
  a.r.chain.simulateTransaction = async () => ({ value: { err: 'Custom', logs: ['Program log: refused'] } });
  const first = await a.act('ai');
  assert.notEqual(first.status, 'sent'); assert.notEqual(first.error?.code, ERR.RESIDENT_ALREADY_ACTED);
  a.r.chain.simulateTransaction = failing;
  assert.equal((await a.act('mcp')).status, 'sent', 'the refused attempt did not take the turn');
  // the relay restarts (a new process: new memory, the same lease directory) — same resident, same bell
  const b = await world({ dir });
  b.r.chain.set(A.citizen(a.o), { data: (await import('./agent-wallet-fixtures.mjs')).citizenAccount(a.o, { session: b.agent.agentKey }) });
  // (the restarted relay's agent acts for the same Citizen: same owner)
  b.r.gateway.ledger.agents()[0].owner = a.o;
  const again = await b.act('ai');
  assert.equal(again.error?.code, ERR.RESIDENT_ALREADY_ACTED, JSON.stringify(again));
  assert.equal(b.r.chain.sent.length, 0);
});
