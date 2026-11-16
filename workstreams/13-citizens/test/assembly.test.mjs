// The read-only resident preflight (resident/assembly.mjs), keyless (2026-11-17). SOURCE-ONLY when written: not run
// in the session that wrote it. No Resident is constructed, no file written, no port called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIREMENTS, readOnlyResidentPreflight } from '../resident/assembly.mjs';
import { liveCanonicalEvidence } from '../resident/ports/live-canonical.mjs';
import { MOCK_CLOCK, MOCK_WORLD } from '../resident/frame.mjs';

const called = [];
const spy = name => new Proxy(() => {}, { apply: () => { called.push(name); }, get: (t, k) => (k === 'then' ? undefined : (...a) => { called.push(`${name}.${String(k)}`); }) });

test('nothing supplied: every required port is refused, with the line that needs it', () => {
  const r = readOnlyResidentPreflight();
  assert.deepEqual([r.assembled, r.constructed], [false, false]);
  for (const p of ['dir', 'identity', 'execution', 'observe', 'join', 'memory', 'board', 'provider', 'fallback']) assert.ok(r.refused.some(x => x.port === p), p);
  assert.ok(!r.refused.some(x => x.port === 'evidence' || x.port === 'cost'), 'optional ports are not required');
  assert.match(r.refused.find(x => x.port === 'identity').why, /makes and saves a key/);
  assert.match(r.refused.find(x => x.port === 'observe').why, /no live adapter exists/);
});

test('everything supplied (even ports that would refuse everything): still not assembled, and no port is called', () => {
  const ports = Object.fromEntries(['execution', 'observe', 'join', 'memory', 'board', 'provider', 'cost', 'fallback'].map(p => [p, spy(p)]));
  const r = readOnlyResidentPreflight({ dir: '/nowhere', identity: { address: 'x', sign: () => 'unsigned' }, ports });
  assert.equal(r.assembled, false);
  for (const p of ['execution', 'join', 'board', 'provider', 'cost', 'memory', 'dir', 'identity']) assert.match(r.refused.find(x => x.port === p).why, /not read-only/, p);
  assert.match(r.refused.find(x => x.port === 'cost').why, /supplied, refused all the same/);
  assert.deepEqual(called, [], 'the preflight reads the ports object only');
});

test("the test harness's observe port is refused as not live; the live evidence port is reported, never reaching a resident", () => {
  const observe = Object.assign(async () => ({}), { world: MOCK_WORLD, clock: MOCK_CLOCK });
  const ev = liveCanonicalEvidence({ ws12EvidencePort: () => ({ kind: 'stub', read: () => ({ status: 'ok', lines: [] }) }),
    observation: { status: 'held', reasons: ['herald_events_incomplete'], held: [{ why: 'herald_events_incomplete' }], memory: { world: { cluster: 'c', world_id: 'P/S' }, knowledge: () => ({ commitments: [] }) },
      clock: { genesisTs: 0, bellSecs: 600, source: 's' }, provenance: null, inputs: {},
      ws04: { format: 'ws04-observation/0', status: 'held', admitted: 0, pageHeld: ['not_executor_receipts'], why: [], observations: [{ held: ['finality_unproven'] }] } } });
  const r = readOnlyResidentPreflight({ ports: { observe, evidence: ev } });
  assert.ok(r.refused.some(x => x.port === 'observe' && /test world/.test(x.why)));
  assert.deepEqual(r.evidence.observation, { status: 'held', held: 1, ws04: { status: 'held', observations: 1 } });
  assert.deepEqual([r.evidence.basis, r.evidence.actsOn, r.evidence.reachesResident], ['unstated', false, false]);
  assert.deepEqual([...ev.observation.ws04.heldReasons], ['finality_unproven']);
  assert.deepEqual([...ev.observation.ws04.pageHeld], ['not_executor_receipts']);
});

test("REQUIREMENTS is Resident's own source (pinned as text); the preflight imports neither Resident nor the file system", () => {
  const r = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  for (const s of ["identity ?? keyIdentity(loadOrCreateKey(path.join(dir, 'resident.key')))", "assertPort('execution', this.ports.execution)", 'await this.ports.observe(this.address,',
    'await this.ports.join({ body, sig: this.identity.sign(JOIN_DOMAIN, body) })', 'await this.ports.board.post(it.body)', 'await decideWithin(this.ports.provider, req)',
    'this.ports.cost ?? flatCost(b.pricePerCall)', 'choice = this.ports.fallback(candidates)', 'const port = this.ports.evidence;', "createStateStore(path.join(dir, 'state.json'))"]) assert.ok(r.includes(s), s);
  assert.equal(REQUIREMENTS.length, 11);
  const a = readFileSync(new URL('../resident/assembly.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(a, /^import /m);
  assert.doesNotMatch(a, /new Resident|writeFileSync|mkdirSync|loadOrCreateKey\(/);
  const h = readFileSync(new URL('../world/harness.mjs', import.meta.url), 'utf8');
  assert.equal((h.match(/new Resident\(/g) ?? []).length, 1, 'the harness is the only constructor call in this tree (its test world)');
});
