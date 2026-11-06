// ⑳ × the existing gateway: the relay (POST /f/relay), the agent wallet (owner commands and the
// capability route MCP clients use) and the page's session check, with `ctx.residents` = the
// holder gate (src/resident-gate.mjs). Needs the three shared-core diffs of this branch
// (patches/v2/) and permutation-gateway's own dependencies (npm ci there).
//
// What is real and what is not: the relay, the agent wallet and their checks are the
// repository's own code; the Frontier chain under them is the gateway's scripted test chain
// (agent-wallet-fixtures.mjs). The resident side is either the mock (the resident program's
// rules in memory) or, in the "real" group, the REAL Metaplex Core binary and the REAL resident
// program on a loopback solana-test-validator, changed by real transactions.
//
// Run: node --test test-gateway/*.test.mjs   (from permutation-nft-resident-spike/)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResidentBindings, ResidentGate } from '../src/resident-gate.mjs';
import { actor, gatewayAvailable, mockResidents, realAvailable, realResidents } from './worlds.mjs';

const skipAll = gatewayAvailable() ? false : 'permutation-gateway dependencies are not installed (npm ci there)';
const GW = '../../permutation-gateway';
const fx = skipAll ? null : await import(`${GW}/test/agent-wallet-fixtures.mjs`);
const { shapeMessage } = skipAll ? {} : await import(`${GW}/client/src/frontier/shapes.mjs`);
const { wireTransaction } = skipAll ? {} : await import(`${GW}/client/src/solana-tx.mjs`);
const { signTalk } = skipAll ? {} : await import(`${GW}/client/src/talk-node.mjs`);
const { toBase64 } = skipAll ? {} : await import(`${GW}/client/src/bytes.mjs`);
const { accountsFor } = skipAll ? {} : await import(`${GW}/src/frontier/agent/gateway.mjs`);
const { profileForSeason } = skipAll ? {} : await import(`${GW}/client/src/frontier/profile.mjs`);
const { ERR } = skipAll ? {} : await import(`${GW}/src/frontier/agent/contract.mjs`);

const IP = '127.0.0.1';
const DAY = 86_400;
const soon = () => Math.floor(Date.now() / 1000) + DAY;

/** The relay and agent wallet over a scripted Frontier chain, with the gate over `world`. */
function stack(world, { bindingsFile = null, keyringDir = null, agentState = null, chain = undefined, requireBinding = false } = {}) {
  const r = fx.relay({ keyringDir, agentState, ...(chain ? { chain } : {}) });
  const bindings = new ResidentBindings({ file: bindingsFile });
  const gate = new ResidentGate({ reader: world.reader, bindings, program: world.program, collection: world.collection, requireBinding });
  r.ctx.residents = gate;
  return { r, gate, bindings };
}

/** A resident minted by `holder`, bound to `holder`'s Citizen (the binding is the integrator's; here, by hand). */
async function resident(world, s, holder, { frontierSession = null } = {}) {
  const asset = await world.mint(holder);
  const citizen = fx.A.citizen(holder.pub);
  s.bindings.bind(citizen, asset);
  s.r.chain.set(citizen, { data: fx.citizenAccount(holder.pub, { session: frontierSession }) });
  return { asset, citizen };
}

/** A Harvest for `owner`'s Citizen signed by `signer`, built now (pre-signed), sent when `.send()` is called. */
async function relayOp(s, { signer, owner }) {
  const g = await fx.call(s.r.public, 'GET', '/f/relay', { ip: IP });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const profile = profileForSeason(await s.r.ctx.chain.season());
  const accounts = accountsFor('Harvest', { addresses: fx.A, actor: signer.pub, owner: owner.pub, holding: fx.VILLAGE, profile });
  const message = shapeMessage({ programId: s.r.ctx.programId, name: 'Harvest', accounts, fields: {}, feePayer: g.json.feePayer, recentBlockhash: g.json.blockhash, profile });
  const tx = toBase64(wireTransaction(message, { [signer.pub]: signTalk(message, signer.web3) }));
  return { tx, send: (on = s) => fx.call(on.r.public, 'POST', '/f/relay', { body: { tx, lastValidBlockHeight: g.json.lastValidBlockHeight }, ip: IP }) };
}
const sentOk = res => { assert.equal(res.status, 200, JSON.stringify(res.json)); assert.equal(res.json.ok, true); };
const refused = (res, code) => { assert.equal(res.status, 403, JSON.stringify(res.json)); assert.equal(res.json.code, code); };

/** An agent of `owner` in auto mode, its key the Frontier Citizen's session; the resident session is set by the caller. */
async function agentOf(s, owner) {
  const a = await fx.createAgent(s.r, owner.web3, { policy: fx.policy(['economy']) });
  const mode = await fx.call(s.r.public, 'POST', '/f/agent/command', { body: fx.ownerCommand(owner.web3, 'mode', { agentId: a.agentId, params: { mode: 'auto' } }), ip: IP });
  assert.equal(mode.json.agent.mode, 'auto');
  fx.delegate(s.r, owner.pub, a.agentKey);
  const mcp = (key, cap = a.capability) => fx.call(s.r.public, 'POST', '/f/agent/action', { body: { capability: cap, request: fx.actionRequest(a.agentId, { key, source: 'mcp' }) }, ip: IP });
  return { ...a, mcp };
}

// ------------------------------------------------------------------ scenarios (each runs on a backend)

const scenarios = {
  async aba_relay(world, L) {
    const s = stack(world);
    const [Aw, Bw, K, K2] = ['A', 'B', 'K', 'K2'].map(x => actor(`${L}:${x}`));
    const { asset, citizen } = await resident(world, s, Aw, { frontierSession: K.pub });
    await world.setSession(Aw, asset, K.pub, soon());
    // Gen 0: the holder's wallet and the holder's session pass.
    sentOk(await (await relayOp(s, { signer: Aw, owner: Aw })).send());
    sentOk(await (await relayOp(s, { signer: K, owner: Aw })).send());
    // Pre-signed now, sent later.
    const lateA = await relayOp(s, { signer: Aw, owner: Aw });
    const lateK = await relayOp(s, { signer: K, owner: Aw });
    // A → B.
    await world.transfer(Aw, asset, Bw);
    refused(await lateA.send(), 'ResidentHolderChanged');
    refused(await lateK.send(), 'ResidentHolderChanged');
    refused(await (await relayOp(s, { signer: Aw, owner: Aw })).send(), 'ResidentHolderChanged');
    refused(await (await relayOp(s, { signer: K, owner: Aw })).send(), 'ResidentHolderChanged');
    assert.equal((await s.gate.check({ citizen, actor: Bw.pub })).ok, true, 'the gate lets the holder act (the Frontier program still names A as the Citizen\'s wallet: see the README)');
    // B's own delegation in B's generation, pre-signed.
    await world.setSession(Bw, asset, K2.pub, soon());
    assert.equal((await s.gate.check({ citizen, actor: K2.pub })).ok, true);
    const lateK2 = await relayOp(s, { signer: K2, owner: Aw });
    // B → A: nothing of generation 0 or 1 comes back.
    await world.transfer(Bw, asset, Aw);
    refused(await lateK.send(), 'ResidentHolderChanged');
    refused(await lateK2.send(), 'ResidentHolderChanged');
    refused(await (await relayOp(s, { signer: K, owner: Aw })).send(), 'ResidentHolderChanged');
    const st = await s.gate.state(citizen);
    assert.deepEqual([st.holder, st.gen, st.sessionSetter], [Aw.pub, 2, '11111111111111111111111111111111']);
    // A's own wallet signature acts for A, the holder again (its blockhash still valid): A's own authority, not a revoked key.
    sentOk(await lateA.send());
    // A delegates again in generation 2: K works again only through that new act.
    await world.setSession(Aw, asset, K.pub, soon());
    sentOk(await (await relayOp(s, { signer: K, owner: Aw })).send());
    return s;
  },

  async aba_agent_mcp(world, L) {
    const s = stack(world);
    const [Aw, Bw] = ['A', 'B'].map(x => actor(`${L}:${x}`));
    const { asset, citizen } = await resident(world, s, Aw);
    const ag = await agentOf(s, Aw);
    // The Frontier session alone is not enough: the resident's holder must have set the agent key in this generation.
    let res = await ag.mcp('m0');
    assert.equal(res.json.error?.code, ERR.SESSION_NOT_DELEGATED, JSON.stringify(res.json));
    assert.equal(res.json.error.resident, 'ResidentHolderChanged');
    await world.setSession(Aw, asset, ag.agentKey, soon());
    res = await ag.mcp('m1');
    assert.equal(res.json.status, 'sent', JSON.stringify(res.json));
    const sentBefore = s.r.chain.sent.length;
    // A → B: the MCP capability is still valid as a token, but the delegation is dead.
    await world.transfer(Aw, asset, Bw);
    res = await ag.mcp('m2');
    assert.equal(res.json.status, 'refused');
    assert.equal(res.json.error.code, ERR.SESSION_NOT_DELEGATED);
    const d = await s.r.gateway.delegation(ag.agentId);
    assert.equal(d.delegated, false);
    assert.equal(d.resident, 'ResidentHolderChanged');
    // The owner's own command route (browser) is refused the same way.
    const viaOwner = await fx.call(s.r.public, 'POST', '/f/agent/command', { body: fx.ownerCommand(Aw.web3, 'action', { agentId: ag.agentId, params: { idempotencyKey: 'o1', policyVersion: 1, action: { name: 'Harvest', holding: fx.VILLAGE, fields: {} } } }), ip: IP });
    assert.equal(viaOwner.json.status, 'refused', JSON.stringify(viaOwner.json));
    // A lost answer: the same idempotency key replays the recorded result, nothing is sent again.
    const again = await ag.mcp('m1');
    assert.equal(again.json.replayed, true);
    assert.equal(s.r.chain.sent.length, sentBefore);
    // B → A: the agent of A's generation 0 does not come back by itself.
    await world.transfer(Bw, asset, Aw);
    res = await ag.mcp('m3');
    assert.equal(res.json.status, 'refused');
    assert.equal(res.json.error.resident, 'ResidentHolderChanged');
    assert.equal(s.r.chain.sent.length, sentBefore);
    // Only the holder's new delegation in generation 2 restores it.
    await world.setSession(Aw, asset, ag.agentKey, soon());
    assert.equal((await ag.mcp('m4')).json.status, 'sent');
    fx.sound(s.r);
    return { s, citizen };
  },

  async inflight_relay(world, L) {
    const s = stack(world);
    const [Aw, Bw] = ['A', 'B'].map(x => actor(`${L}:${x}`));
    const { asset, citizen } = await resident(world, s, Aw);
    const quota = async () => (await fx.call(s.r.public, 'GET', `/f/quota?citizen=${citizen}`, { ip: IP })).json.left;
    const q0 = await quota();
    const op = await relayOp(s, { signer: Aw, owner: Aw });
    // The transfer lands while the relay simulates A's transaction.
    const orig = s.r.chain.simulateTransaction;
    s.r.chain.simulateTransaction = async (...a) => { s.r.chain.simulateTransaction = orig; await world.transfer(Aw, asset, Bw); return orig(...a); };
    const sent0 = s.r.chain.sent.length;
    refused(await op.send(), 'ResidentHolderChanged');
    assert.equal(s.r.chain.sent.length, sent0, 'nothing sent');
    assert.equal(s.r.chain.simulated >= 1, true, 'it was past the first check');
    assert.equal(await quota(), q0, 'nothing charged');
    // The replay claim was released: the same bytes are judged again (and refused again) rather than "Duplicate".
    refused(await op.send(), 'ResidentHolderChanged');
  },

  async inflight_agent(world, L) {
    const s = stack(world);
    const [Aw, Bw] = ['A', 'B'].map(x => actor(`${L}:${x}`));
    const { asset } = await resident(world, s, Aw);
    const ag = await agentOf(s, Aw);
    await world.setSession(Aw, asset, ag.agentKey, soon());
    const orig = s.r.chain.simulateTransaction;
    s.r.chain.simulateTransaction = async (...a) => { s.r.chain.simulateTransaction = orig; await world.transfer(Aw, asset, Bw); return orig(...a); };
    const res = await ag.mcp('f1');
    assert.equal(res.json.status, 'refused', JSON.stringify(res.json));
    assert.equal(res.json.error.code, 'ResidentHolderChanged');
    assert.equal(s.r.chain.sent.length, 0);
    assert.deepEqual(res.json.charges, []);
    fx.sound(s.r);
  },

  async lost_answer_relay(world, L) {
    const s = stack(world);
    const [Aw, Bw] = ['A', 'B'].map(x => actor(`${L}:${x}`));
    const { asset } = await resident(world, s, Aw);
    const op = await relayOp(s, { signer: Aw, owner: Aw });
    sentOk(await op.send());                // landed; the client never saw this answer
    const n = s.r.chain.sent.length;
    await world.transfer(Aw, asset, Bw);
    const retry = await op.send();          // the client retries the same bytes after the transfer
    assert.notEqual(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(s.r.chain.sent.length, n, 'never sent twice');
  },

  async restart(world, L) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws20-gw-'));
    try {
      const bindingsFile = path.join(dir, 'bindings.json');
      const keyringDir = path.join(dir, 'keys');
      const s = stack(world, { bindingsFile, keyringDir });
      const [Aw, Bw, K] = ['A', 'B', 'K'].map(x => actor(`${L}:${x}`));
      const { asset } = await resident(world, s, Aw, { frontierSession: K.pub });
      await world.setSession(Aw, asset, K.pub, soon());
      const ag = await agentOf(s, Aw);
      await world.setSession(Aw, asset, ag.agentKey, soon());
      assert.equal((await ag.mcp('r1')).json.status, 'sent');
      const opA = await relayOp(s, { signer: Aw, owner: Aw });
      sentOk(await opA.send());
      const lateK = await relayOp(s, { signer: K, owner: Aw });
      await world.transfer(Aw, asset, Bw);
      // The relay process restarts: a new replay cache, a new gateway over the same agent ledger, keys and bindings.
      const s2 = stack(world, { bindingsFile, keyringDir, agentState: s.r.agentStore.state, chain: s.r.chain });
      assert.equal(s2.bindings.assetOf(fx.A.citizen(Aw.pub)), asset, 'the binding survived');
      refused(await opA.send(s2), 'ResidentHolderChanged');   // the replay cache is gone; the gate still refuses
      refused(await lateK.send(s2), 'ResidentHolderChanged');
      const res = await fx.call(s2.r.public, 'POST', '/f/agent/action', { body: { capability: ag.capability, request: fx.actionRequest(ag.agentId, { key: 'r2', source: 'mcp' }) }, ip: IP });
      assert.equal(res.json.status, 'refused', JSON.stringify(res.json));
      assert.equal(res.json.error.resident, 'ResidentHolderChanged');
      // And after B → A, still nothing of generation 0 in the restarted process.
      await world.transfer(Bw, asset, Aw);
      refused(await lateK.send(s2), 'ResidentHolderChanged');
      const res2 = await fx.call(s2.r.public, 'POST', '/f/agent/action', { body: { capability: ag.capability, request: fx.actionRequest(ag.agentId, { key: 'r3', source: 'mcp' }) }, ip: IP });
      assert.equal(res2.json.status, 'refused');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
};

// ------------------------------------------------------------------ mock backend: every scenario, and the refusals only the mock can stage

describe('gateway × resident gate, mock residents', { skip: skipAll }, () => {
  for (const [name, fn] of Object.entries(scenarios)) test(`mock: ${name}`, async () => { const w = mockResidents(); await fn(w, `mock-${name}`); });

  test('mock: fail closed — an unreadable chain, a look-alike asset, a missing resident account; a Citizen that is no resident is unchanged; requireBinding refuses it', async () => {
    const w = mockResidents();
    const s = stack(w);
    const [Aw, Cw] = ['A', 'C'].map(x => actor(`mock-fail:${x}`));
    const { asset } = await resident(w, s, Aw);
    sentOk(await (await relayOp(s, { signer: Aw, owner: Aw })).send());
    w.breakReads(true);
    refused(await (await relayOp(s, { signer: Aw, owner: Aw })).send(), 'ResidentUnverified');
    w.breakReads(false);
    w.forgeCollection(asset);
    refused(await (await relayOp(s, { signer: Aw, owner: Aw })).send(), 'ResidentUnverified');
    const w2 = mockResidents();
    const s2 = stack(w2);
    const r2 = await resident(w2, s2, Aw);
    w2.drop(s2.gate.pdas.resident(r2.asset));
    refused(await (await relayOp(s2, { signer: Aw, owner: Aw })).send(), 'ResidentUnverified');
    // C has a Citizen but no resident: the relay behaves as before.
    s.r.chain.set(fx.A.citizen(Cw.pub), { data: fx.citizenAccount(Cw.pub) });
    sentOk(await (await relayOp(s, { signer: Cw, owner: Cw })).send());
    const strict = stack(w, { requireBinding: true });
    strict.r.chain.set(fx.A.citizen(Cw.pub), { data: fx.citizenAccount(Cw.pub) });
    refused(await (await relayOp(strict, { signer: Cw, owner: Cw })).send(), 'ResidentUnverified');
  });

  test('mock: an expired resident session is refused though the Frontier session is live', async () => {
    const w = mockResidents();
    const s = stack(w);
    const [Aw, K] = ['A', 'K'].map(x => actor(`mock-exp:${x}`));
    const { asset } = await resident(w, s, Aw, { frontierSession: K.pub });
    await w.setSession(Aw, asset, K.pub, Math.floor(Date.now() / 1000) - 1);
    refused(await (await relayOp(s, { signer: K, owner: Aw })).send(), 'ResidentSessionExpired');
  });

  test('page: matchesCitizen names a sold resident and a session of an earlier generation', async () => {
    const { matchesCitizen } = await import('../../permutation-server/web/frontier/fsession.mjs');
    const Aw = actor('page:A').pub, Bw = actor('page:B').pub, K = actor('page:K').pub;
    const { pubkeyBytes } = await import('../src/crypto.mjs');
    const citizen = { session: pubkeyBytes(K), sessionExpiry: 2_000_000_000 };
    const session = { wallet: Aw, publicKey: K };
    assert.deepEqual(matchesCitizen(session, citizen, 1_900_000_000), { ok: true }, 'no resident given: unchanged');
    assert.deepEqual(matchesCitizen(session, citizen, 1_900_000_000, { holder: Aw, gen: 0, session: K, sessionGen: 0, sessionSetter: Aw }), { ok: true });
    assert.equal(matchesCitizen(session, citizen, 1_900_000_000, { holder: Bw, gen: 1, session: '11111111111111111111111111111111', sessionGen: 0, sessionSetter: '11111111111111111111111111111111' }).code, 'ResidentHolderChanged');
    assert.equal(matchesCitizen(session, citizen, 1_900_000_000, { holder: Aw, gen: 2, session: '11111111111111111111111111111111', sessionGen: 0, sessionSetter: '11111111111111111111111111111111' }).code, 'ResidentSessionStale');
  });
});

// ------------------------------------------------------------------ the REAL Core binary and resident program on a loopback validator

const realSkip = skipAll || (realAvailable() ? false : 'the validator, the Core .so or the resident program build is missing (docs/ENV-RECORD.ja.md)');
describe('gateway × resident gate, REAL Core and resident program (loopback validator)', { skip: realSkip }, () => {
  let world;
  before(async () => { world = await realResidents(); });
  after(async () => { await world?.stop(); });
  for (const name of ['aba_relay', 'aba_agent_mcp', 'inflight_relay', 'inflight_agent', 'lost_answer_relay', 'restart']) {
    test(`real: ${name}`, { timeout: 240_000 }, async () => { await scenarios[name](world, `real-${name}`); });
  }
});
