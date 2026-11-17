// The live evidence port (resident/ports/live-canonical.mjs) and the observe-canonical command (bin/), keyless
// (2026-11-16). SOURCE-ONLY when written: not run in the session that wrote it. Workstream 12 is not imported:
// 12's port is a stub with its contract's shape; the command is pinned as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MOCK_CLOCK, seasonClock } from '../resident/frame.mjs';
import { liveCanonicalEvidence, wireLiveEvidence } from '../resident/ports/live-canonical.mjs';

const WORLD = { cluster: 'localnet', world_id: 'P/S' };
const CLOCK = { genesisTs: 1_000_000, bellSecs: 600, source: 'herald:/h/season@slot:40' };
const CP = '1'.repeat(32);
const asked = [];
const ws12EvidencePort = (memory, { worldBellOf }) => ({
  kind: 'stub-ws12',
  read: ({ counterparty, worldBell }) => { asked.push({ counterparty, worldBell }); return worldBellOf ? { status: 'ok', lines: [{ about: counterparty, epistemic: 'observed', text: 'x', sources: ['s'] }] } : { status: 'clock_unverified', lines: [] }; },
});
const memory = { world: WORLD, partitions: { S: {} }, knowledge: () => ({ commitments: [] }) };
const chain = s => ({ kind: 'chain', source: s });
const PROV = { world: chain('h'), clock: chain('h'), finality: { ...chain('rpc'), commitment: 'finalized', slot: 100, world_id: 'P/S' }, identity: chain('h'), records: { kind: 'integration-output', source: 'ws04-store:x' } };
const obs = (over = {}) => ({ status: 'ok', reasons: [], held: [{ receipt: 'r|facility_used|s|x', why: 'not_a_memory_input' }], memory, world: WORLD, clock: CLOCK, identity: { walletKnown: () => ({ partition: 'S', source: 'h' }) }, provenance: PROV, inputs: { eventPages: 1, eventsComplete: true }, ...over });

test('an observation that did not connect answers nothing, with its reasons', () => {
  for (const o of [null, obs({ status: 'world_unverified', memory: null, clock: null, reasons: ['season_http_503'] }), obs({ memory: null }), obs({ clock: null })]) {
    const p = liveCanonicalEvidence({ ws12EvidencePort, observation: o, residentClock: seasonClock(CLOCK) });
    assert.equal(p.basis, 'unstated');
    const r = p.read({ counterparty: CP, worldBell: 200 });
    assert.match(r.status, /^observation_/); assert.deepEqual([r.lines, r.facts], [[], []]);
  }
  assert.deepEqual(liveCanonicalEvidence({ ws12EvidencePort, observation: obs({ status: 'world_unverified', memory: null, reasons: ['season_http_503'] }) }).observation.reasons, ['season_http_503']);
});

test('connected over 4\'s receipts: lines are shown, the basis is integration-output (never chain), held receipts travel along', () => {
  const p = liveCanonicalEvidence({ ws12EvidencePort, observation: obs(), residentClock: seasonClock(CLOCK) });
  assert.equal(p.sameTime, true);
  assert.equal(p.basis, 'integration-output');
  assert.ok(p.basisWhy.some(w => /records: integration-output/.test(w)));
  assert.deepEqual([p.observation.held, [...p.observation.heldReasons]], [1, ['not_a_memory_input']]);
  const r = p.read({ counterparty: CP, worldBell: 200 });
  assert.equal(r.status, 'ok'); assert.equal(r.lines.length, 1); assert.equal(r.basis, 'integration-output');
  assert.deepEqual(r.observation, { status: 'ok', held: 1 });
});

test('a resident on another clock gets clock_unverified from 12, not a converted bell', () => {
  asked.length = 0;
  for (const residentClock of [MOCK_CLOCK, seasonClock({ ...CLOCK, bellSecs: 300 }), undefined]) {
    const p = liveCanonicalEvidence({ ws12EvidencePort, observation: obs(), residentClock });
    assert.equal(p.sameTime, false); assert.equal(p.read({ counterparty: CP, worldBell: 200 }).status, 'clock_unverified');
  }
});

test('WS19 words are not finality or completeness: complete false/null, cross_checked, coverage keep the basis off chain', () => {
  for (const extra of [{ complete: false }, { complete: null }, { cross_checked: true }, { coverage: { state: 'cross_checked', heldBack: 0 } }]) {
    const prov = { ...PROV, records: { ...chain('x'), ...extra } };
    const p = liveCanonicalEvidence({ ws12EvidencePort, observation: obs({ provenance: prov }), residentClock: seasonClock(CLOCK) });
    assert.notEqual(p.basis, 'chain', JSON.stringify(extra));
  }
});

test('wireLiveEvidence sets ports.evidence and nothing else (harness openResident\'s `wire`)', () => {
  const p = liveCanonicalEvidence({ ws12EvidencePort, observation: obs() });
  const r = { ports: { observe: 1, execution: 2 } };
  wireLiveEvidence(p)(r);
  assert.deepEqual(Object.keys(r.ports).sort(), ['evidence', 'execution', 'observe']);
  assert.equal(r.ports.evidence, p); assert.equal(r.ports.evidenceUse, undefined, 'never the fixture test switch');
  const h = readFileSync(new URL('../world/harness.mjs', import.meta.url), 'utf8');
  assert.match(h, /if \(wire\) wire\(r\);/);
  assert.match(h, /observe: Object\.assign\([^\n]+\n\s+\/\/[^\n]+\n\s+\{ world: MOCK_WORLD, clock: MOCK_CLOCK \}\)/, 'the test world is on its own clock: a live port there reads nothing');
});

test('the command: GET to the herald, one getSlot RPC, no resident or world started, 13 port without a 12 import (pinned as text)', () => {
  const c = readFileSync(new URL('../bin/observe-canonical.mjs', import.meta.url), 'utf8');
  assert.match(c, /fetch\(url, \{ method: 'GET'/);
  assert.match(c, /if \(!RPC_METHODS\.includes\(method\)\) throw/);
  assert.equal((c.match(/fetch\(/g) ?? []).length, 2);
  assert.doesNotMatch(c, /new Resident|openResident|openWorld|createServer|listen\(|writeFileSync|sendTransaction|Keypair|sign\(/);
  const port = readFileSync(new URL('../resident/ports/live-canonical.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(port, /12-memory/);
  assert.doesNotMatch(port, /evidenceUse|'chain'/, 'the port sets no basis of its own');
});
