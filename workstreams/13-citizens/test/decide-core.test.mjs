// The resident's decision core (resident/decide-core.mjs) and its preview (2026-11-17). SOURCE-ONLY when written: not
// run in the session that wrote it. The inputs come from the TEST world (helpers.mjs small/run: world/harness.mjs);
// that is a test world, not a production one. The preview is checked to change nothing and call nothing that acts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { previewDecision, publicEvidenceOf, todayOf, trustIndexOf, whoOf } from '../resident/decide-core.mjs';

const filesOf = dir => readdirSync(dir).sort().map(f => [f, statSync(path.join(dir, f)).size, statSync(path.join(dir, f)).mtimeMs]);
/** The resident's ports, with every port that acts replaced by a recorder that throws (none must be reached). */
function guarded(r, calls) {
  const trap = name => new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : () => { calls.push(`${name}.${String(k)}`); throw new Error(`${name}.${String(k)} reached`); }) });
  return { ...r.ports, execution: trap('execution'), board: trap('board'), provider: trap('provider'), cost: trap('cost'),
    join: () => { calls.push('join'); throw new Error('join reached'); }, fallback: () => { calls.push('fallback'); throw new Error('fallback reached'); },
    memory: { all: () => r.ports.memory.all(), recall: q => r.ports.memory.recall(q), append: () => { calls.push('memory.append'); throw new Error('memory.append reached'); } } };
}

test('preview: candidates and the request a provider WOULD get; nothing changed, written, sent, joined, spent or asked', async () => {
  const env = await small({ residents: [{ id: 'ren', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 3, r: 1 } }] });
  await run(env, 6);
  const r = env.rs.ren;
  const obs = await r.ports.observe(r.address, {});
  const before = { state: structuredClone(r.state), charter: structuredClone(r.charter), files: filesOf(r.dir) };
  const calls = [];
  const ports = guarded(r, calls);
  const p = previewDecision({ charter: r.charter, state: r.state, address: r.address, obs, memory: ports.memory, evidence: null, observe: ports.observe });
  assert.deepEqual([p.mode, p.sent, p.decided], ['preview', false, false]);
  assert.equal(p.turn, r.state.turn + 1); assert.equal(p.bell, obs.world.bell);
  assert.ok(Array.isArray(p.candidates) && p.candidates.some(c => c.id === 'wait'));
  if (p.byCode) assert.equal(p.request, null);
  else { assert.equal(p.request.purpose, 'resident.decide'); assert.match(p.request.system, /Answer JSON/); assert.deepEqual(p.request.candidates.map(c => c.id), p.candidates.map(c => c.id)); }
  assert.deepEqual(calls, [], 'no acting port was reached');
  assert.deepEqual(r.state, before.state, 'the resident state is unchanged (counters included)');
  assert.deepEqual(r.charter, before.charter);
  assert.deepEqual(filesOf(r.dir), before.files, 'no file written or touched');
});

test('the same hold rules as the resident: a chain-basis breach excludes; a non-chain basis is shown and not acted on', async () => {
  const env = await small({ residents: [{ id: 'ren', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 3, r: 1 } }] });
  await run(env, 3);
  const r = env.rs.ren;
  const obs = await r.ports.observe(r.address, {});
  const port = basis => ({ kind: 'stub', clock: r.ports.observe.clock, world: r.ports.observe.world, basis, basisWhy: basis === 'chain' ? [] : ['records: integration-output'],
    read: ({ counterparty }) => ({ status: 'ok', lines: [], facts: [{ commitment: 'c'.repeat(16), state: 'not_sent', due_bell: 1, verified: true, breach: true, sources: ['s'], evidenceBasis: basis }] }) });
  const cands = [{ id: 'x', kind: 'accept', act: { to: 'cp' }, summary: '' }];
  const who = c => c;
  const chain = publicEvidenceOf({ port: port('chain'), observe: r.ports.observe, cands, bell: obs.world.bell, who });
  assert.ok(chain.breaches.has('cp'));
  const io = publicEvidenceOf({ port: port('integration-output'), observe: r.ports.observe, cands, bell: obs.world.bell, who });
  assert.equal(io.breaches.size, 0); assert.match(io.summary[0].notActedBecause, /basis integration-output: not chain evidence/);
  const fx = publicEvidenceOf({ port: port('fixture'), observe: r.ports.observe, evidenceUse: 'fixture-for-tests-only', cands, bell: obs.world.bell, who });
  assert.ok(fx.breaches.has('cp'), 'the test switch admits a fixture, as before');
  const other = publicEvidenceOf({ port: { ...port('chain'), clock: { kind: 'season-bell', genesisTs: 0, bellSecs: 600 } }, observe: r.ports.observe, cands, bell: 1, who });
  assert.equal(other.summary[0].status, 'clock_mismatch');
});

test('helpers keep the resident\'s rules: the day counters reset on a copy only; aliases and trust as before', () => {
  const c = { day: 0, actions: 5, messages: 2, giveAway: 1, gifts: 1, sibling: 1 };
  assert.deepEqual(todayOf(c, 144), { day: 1, actions: 0, messages: 0, giveAway: 0, gifts: 0, sibling: 0 });
  assert.equal(c.actions, 5, 'the given counters are not changed');
  assert.deepEqual(todayOf(c, 10), c);
  const who = whoOf({ addr: new Map([['c1', 'A']]), aliases: { c2: 'B' } });
  assert.deepEqual([who('c1'), who('c2'), who('c3'), who(null)], ['A', 'B', 'c3', null]);
  const t = trustIndexOf([{ kind: 'kept', bell: 1, entities: ['c2'] }, { kind: 'broken', bell: 2, entities: ['A'] }, { kind: 'raided', bell: 7, entities: ['route:x>c2'] }], { c2: 'B' });
  assert.deepEqual([t.trust('B'), t.trust('A'), t.raided('B'), t.raided('A')], [1, -2, 7, null]);
});

test('the normal mode calls the same functions (pinned as text); the core imports nothing that acts', () => {
  const r = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  for (const s of ['return whoOf({ addr: this.addr, aliases: this.state.aliases })(citizen);', 'return trustIndexOf(this.ports.memory.all(), this.state.aliases);',
    'return requestOf({ charter: this.charter, id: this.id, citizen: this.state.citizen, obs, bell, turn, cands, wakes, evidence, mem });',
    'return publicEvidenceOf({ port: this.ports.evidence, observe: this.ports.observe, evidenceUse: this.ports.evidenceUse, cands, bell, who: c => this.#who(c) });',
    'const held = heldOf({ evidence, inFlight, failures: st.failures, bell, who: c => this.#who(c) });', 'const inFlight = inFlightOf(st.journal);',
    "export { OPEN_STATES, actionSig } from './decide-core.mjs';"]) assert.ok(r.includes(s), s);
  const core = readFileSync(new URL('../resident/decide-core.mjs', import.meta.url), 'utf8');
  const imports = [...core.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./frame.mjs', '../../../permutation-gateway/citizens/mind/sanitize.mjs', '../world/rules.mjs', './candidates.mjs', './goals.mjs', './ports/provider.mjs']);
  assert.doesNotMatch(core, /node:fs|writeFile|appendFile|loadOrCreateKey|AgentLedger|decideWithin|\.submit\(|ports\.(join|board|execution|provider)|\.hold\(|memory\.append\(/);
});
