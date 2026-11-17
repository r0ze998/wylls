// Workstream 05 (for 04 to integrate): after a revoke, a replacement or an NFT transfer, the old credential sends nothing
// — also a request that was let in before and still waited in the Citizen's lane.
// No key is generated, derived or used and nothing is signed: records are plain data, the agent "key" is the base58
// text of fixed bytes (an encoding, not a key), ctx.addresses / ctx.chain / ctx.residents are stubs that derive no
// address, and every request stops before a transaction is built (gate, or the resident check in #build). Run it with
// workstream 05's no-keys guard preloaded to make any key, derivation or signature throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLedger } from '../src/frontier/agent/ledger.mjs';
import { AgentGateway, laneOf } from '../src/frontier/agent/gateway.mjs';
import { normalisePolicy } from '../src/frontier/agent/policy.mjs';
import { encode as base58 } from '../client/src/base58.mjs';

const OWNER = 'OwnerOfTheTestAgent1111111111111111111111111';
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const AGENT_KEY = base58(KEY_BYTES);
function world({ mode = 'manual', residents = null } = {}) {
  const ledger = new AgentLedger({ store: { state: {}, save() {} } });
  ledger.create({ agentId: 'a1', owner: OWNER, agentKey: AGENT_KEY, village: [1, 2, 3], policy: normalisePolicy({ allowed: ['Train'], budget: { total: '1000', perDay: '100' } }) });
  if (mode === 'auto') ledger.setMode('a1', 'auto');
  const ctx = {
    addresses: { citizen: () => 'CitizenAddressStub' },
    chain: { season: async () => ({}), clock: async () => ({ unixTimestamp: 100n }), citizen: async () => ({ SESSION: KEY_BYTES, SESSION_EXPIRY: 10_000n }) },
    ...(residents ? { residents } : {}),
  };
  return { ledger, gateway: new AgentGateway({ ctx, ledger, keyring: null }) };
}
let n = 0;
const req = (source, rec) => ({ agentId: 'a1', source, idempotencyKey: `${source}:k${++n}`, policyVersion: rec.policy.version, ...(rec.modeEpoch !== undefined ? { modeEpoch: rec.modeEpoch } : {}), action: { name: 'Train', holding: [1, 2, 3], fields: { unit: 0, n: 1 } } });
const codeOf = async p => { try { const r = await p; return r.error?.code ?? r.status; } catch (e) { return e.code; } };
/** Holds the Citizen's lane until `open()` is called. */
function block(g, rec) { let open; const gate = new Promise(r => { open = r; }); g.lanes.run(laneOf(rec), () => gate); return open; }

test('a token revoked or replaced while its request waited in the lane: that request sends nothing (BadCapability)', async () => {
  const { gateway: g, ledger } = world();
  const rec = ledger.get('a1');
  const ai = g.rotateCapability('a1', OWNER, 'ai').capability.token;
  const mcp = g.rotateCapability('a1', OWNER, 'mcp').capability.token;
  // Control: let in, not revoked → reaches the gate (manual mode).
  let open = block(g, rec);
  let p = g.submit(req('ai', rec), { capability: ai });
  open();
  assert.equal(await codeOf(p), 'AgentStopped');
  // Revoked while waiting.
  open = block(g, rec);
  p = g.submit(req('ai', rec), { capability: ai });
  const q = g.submit(req('mcp', rec), { capability: mcp });
  g.revokeCapability('a1', OWNER, 'ai');
  open();
  assert.deepEqual([await codeOf(p), await codeOf(q)], ['BadCapability', 'AgentStopped'], 'only the revoked sender\'s waiting request stops');
  // Replaced (③'s consent again) while waiting.
  open = block(g, rec);
  const r = req('mcp', rec);
  p = g.submit(r, { capability: mcp });
  g.rotateCapability('a1', OWNER, 'mcp');
  open();
  assert.equal(await codeOf(p), 'BadCapability');
  // A refusal that charged nothing is kept as the key's answer (not in the history, as the gateway does for refusals):
  // the same key replays it, it is never sent later.
  assert.equal(ledger.request('a1', r.idempotencyKey).result.error.code, 'BadCapability');
  assert.equal((await g.submit(r, { runner: true })).replayed, true);
});

test('the general token can be revoked too; a sender\'s token goes on', async () => {
  const { gateway: g, ledger } = world();
  const rec = ledger.get('a1');
  const general = g.rotateCapability('a1', OWNER).capability.token;
  const ai = g.rotateCapability('a1', OWNER, 'ai').capability.token;
  const open = block(g, rec);
  const waiting = g.submit(req('mcp', rec), { capability: general });
  assert.equal(g.revokeCapability('a1', OWNER, 'any').revoked, true);
  open();
  assert.equal(await codeOf(waiting), 'BadCapability', 'let in by the general token before the revoke: not sent');
  assert.equal(await codeOf(g.submit(req('mcp', rec), { capability: general })), 'BadCapability');
  assert.equal(await codeOf(g.submit(req('ai', rec), { capability: ai })), 'AgentStopped');
  assert.equal(g.revokeCapability('a1', OWNER, 'any').revoked, false);
  assert.throws(() => g.revokeCapability('a1', OWNER, 'browser'), { code: 'BadRequest' });
});

test('after an NFT transfer (the resident\'s holder changed), a still-valid token sends nothing: refused before anything is built', async () => {
  let holderOk = true;
  const residents = { async check({ citizen, actor }) { assert.deepEqual([citizen, actor], ['CitizenAddressStub', AGENT_KEY]); return holderOk ? { ok: true } : { ok: false, code: 'ResidentHolderChanged' }; } };
  const { gateway: g, ledger } = world({ mode: 'auto', residents });
  const rec = ledger.get('a1');
  const ai = g.rotateCapability('a1', OWNER, 'ai').capability.token;
  holderOk = false;
  const r = await g.submit(req('ai', rec), { capability: ai });
  assert.deepEqual([r.status, r.error?.code, r.error?.resident, r.sent], ['refused', 'SessionNotDelegated', 'ResidentHolderChanged', false]);
  assert.equal(g.whoami('a1', { capability: ai }).capabilitySource, 'ai', 'the token itself still authenticates; the send is what is refused');
  // A holder check that cannot be read refuses too (never "assume unchanged").
  const { gateway: g2, ledger: l2 } = world({ mode: 'auto', residents: { async check() { throw new Error('rpc down'); } } });
  const ai2 = g2.rotateCapability('a1', OWNER, 'ai').capability.token;
  const r2 = await g2.submit(req('ai', l2.get('a1')), { capability: ai2 });
  assert.deepEqual([r2.status, r2.error?.code, r2.error?.resident], ['refused', 'SessionNotDelegated', 'ResidentUnverified']);
});
