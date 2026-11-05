// The resident's side of the workstream 12 connection: public evidence read through the integration branch's
// read-only sidecar (ports/ws12-public-evidence.mjs) reaches the provider as marked, untrusted context, and changes
// nothing else: not trust, not the candidates or their scores, not what is sent. Workstream 12's memory is never
// written (it is wrapped so that any write throws). Identity mapping and the world bell are fixtures here: in the
// game they must come from workstreams 4 and 8, which have not delivered them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { small, run } from './helpers.mjs';
import { ws12PublicEvidence } from '../resident/ports/ws12-public-evidence.mjs';
import { newMemory, promise, coverage, PUBLIC } from '../../12-memory/fixtures/scenario.mjs';
import { decisionsOf } from '../demo/report.mjs';

/** Workstream 12's memory, read-only: any method other than knowledge() throws (and is counted). */
function readOnly(m) {
  const writes = [];
  const proxy = new Proxy(m, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v === 'function' && prop !== 'knowledge') return (...a) => { writes.push(String(prop)); throw new Error(`write to workstream 12: ${String(prop)}`); };
      return v;
    },
  });
  return { proxy, writes };
}

/** A capturing provider: always waits, keeps every request. */
const capture = () => { const reqs = []; return { reqs, decide: async req => { reqs.push(req); return { choice: 'wait', reason: 'capture', mem: [] }; } }; };

/** Ren with a request from Kou addressed to it, so Kou is a counterparty of the decision. */
async function withKou({ evidence = null, provider }) {
  const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 }, provider }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
    async script(bell, me) { if (bell === 2) await me.post({ kind: 'request', to: 'c1', want: { Food: 40 }, offer: { Ore: 40 }, deadlineBell: 30 }); } }] });
  if (evidence) env.rs.ren.ports.evidence = evidence(env);
  await run(env, 6);
  return env;
}

/**
 * The evidence port: the sidecar, with the two things workstreams 4/8 must supply in the game given as fixtures —
 * who a wallet is in workstream 12 (resolvePrincipal) and which world bell a resident's bell is (here the fixture's
 * bell 300, after the fixture's promise came due).
 */
const kouSidecar = (m, { mapped = true } = {}) => env => {
  const sc = ws12PublicEvidence(m, { resolvePrincipal: (who) => (mapped && who === env.ps.Kou.address ? { principal: 'B', source: 'fixture-identity-alias-B' } : null) });
  return { read: q => sc.read({ ...q, worldBell: 300 }) };
};

test('public evidence reaches the provider, marked and untrusted, with its state and sources; nothing else changes', async () => {
  const m = newMemory();
  promise(m, { vis: PUBLIC });
  coverage(m); // a verified public shortfall in the fixture
  const { proxy, writes } = readOnly(m);
  const withP = capture(), withoutP = capture();
  const a = await withKou({ provider: withP, evidence: kouSidecar(proxy) });
  const b = await withKou({ provider: withoutP });
  const req = withP.reqs.find(r => /Public records/.test(r.user));
  assert.ok(req, 'the provider was shown public records');
  assert.match(req.user, /\[verified; sources [^\]]+\]: <untrusted[^>]*>[^<]*not sent[^<]*<\/untrusted>/i);
  // Same candidates, same scores, same choice set and same trust as without the evidence.
  const shape = rs => rs.map(r => r.candidates.map(c => [c.kind, c.score]));
  assert.deepEqual(shape(withP.reqs), shape(withoutP.reqs));
  assert.equal(a.rs.ren.trust(a.ps.Kou.address), 0);
  assert.equal(b.rs.ren.trust(b.ps.Kou.address), 0);
  // Recorded in the decision for audit.
  const d = decisionsOf(a.rs.ren).find(x => x.evidence);
  assert.deepEqual(d.evidence.map(e => [e.status, e.epistemic]), [['ok', ['verified']]]);
  assert.deepEqual(writes, [], 'workstream 12 memory was never written');
});

test('an unknown public record stays "unknown" in the prompt; no broken episode, no trust change', async () => {
  const m = newMemory();
  promise(m, { vis: PUBLIC }); // a promise with no execution evidence at all
  const p = capture();
  const env = await withKou({ provider: p, evidence: kouSidecar(readOnly(m).proxy) });
  const req = p.reqs.find(r => /Public records/.test(r.user));
  assert.match(req.user, /\[unknown; sources/);
  assert.equal(env.rs.ren.ports.memory.all().filter(e => e.kind === 'broken').length, 0);
  assert.equal(env.rs.ren.trust(env.ps.Kou.address), 0);
});

test('without a sourced identity mapping nothing is shown, and the withholding is recorded', async () => {
  const m = newMemory();
  promise(m, { vis: PUBLIC });
  const p = capture();
  const env = await withKou({ provider: p, evidence: kouSidecar(m, { mapped: false }) });
  assert.ok(p.reqs.length > 0);
  assert.ok(p.reqs.every(r => !/Public records/.test(r.user)));
  const d = decisionsOf(env.rs.ren).find(x => x.evidence);
  assert.equal(d.evidence[0].status, 'identity_unverified');
});

test('a failing sidecar never blocks a decision', async () => {
  const p = capture();
  const env = await withKou({ provider: p, evidence: () => ({ read() { throw new Error('index unavailable'); } }) });
  assert.ok(decisionsOf(env.rs.ren).length > 0);
  const d = decisionsOf(env.rs.ren).find(x => x.evidence);
  assert.equal(d.evidence[0].status, 'error');
  assert.ok(p.reqs.every(r => !/Public records/.test(r.user)));
});
