// The resident's decision core (resident/decide-core.mjs) and its preview over a plain-data snapshot (2026-11-17).
// SOURCE-ONLY when written: not run in the session that wrote it. The snapshots come from the TEST world
// (helpers.mjs small/run over world/harness.mjs); that is a test world, not a production one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { previewDecision, publicEvidenceOf, safeFallback, todayOf, trustIndexOf, whoOf } from '../resident/decide-core.mjs';
import { recallFrom } from '../resident/recall.mjs';
import { safeFallback as residentFallback } from '../resident/resident.mjs';

const filesOf = dir => readdirSync(dir).sort().map(f => [f, statSync(path.join(dir, f)).size, statSync(path.join(dir, f)).mtimeMs]);
async function scene(bells = 6) {
  const env = await small({ residents: [{ id: 'ren', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 3, r: 1 } }] });
  await run(env, bells);
  const r = env.rs.ren;
  const obs = await r.ports.observe(r.address, {});
  const snap = { charter: r.charter, state: r.state, address: r.address, obs, episodes: r.ports.memory.all(), frame: { clock: r.ports.observe.clock, world: r.ports.observe.world }, evidence: null };
  return { env, r, obs, snap };
}

test('preview from a snapshot: candidates, the request a provider WOULD get and the default fallback; the resident is untouched', async () => {
  const { r, obs, snap } = await scene();
  const before = { state: structuredClone(r.state), charter: structuredClone(r.charter), files: filesOf(r.dir), snap: structuredClone(snap) };
  const p = previewDecision(snap);
  assert.equal(p.refused, undefined, JSON.stringify(p.refused));
  assert.deepEqual([p.mode, p.sent, p.decided, p.modelAsked], ['preview', false, false, false]);
  assert.equal(p.turn, r.state.turn + 1); assert.equal(p.bell, obs.world.bell);
  assert.ok(p.candidates.some(c => c.id === 'wait'));
  if (p.byCode) { assert.equal(p.request, null); assert.equal(p.fallback.choice, 'wait'); }
  else {
    assert.equal(p.request.purpose, 'resident.decide'); assert.deepEqual(p.request.candidates.map(c => c.id), p.candidates.map(c => c.id));
    assert.equal(p.fallback.choice, safeFallback(p.request.candidates.map(c => ({ ...c }))));
  }
  assert.match(p.fallback.by, /default code fallback/);
  assert.deepEqual(r.state, before.state); assert.deepEqual(r.charter, before.charter);
  assert.deepEqual(snap, before.snap, 'the snapshot itself is not changed');
  assert.deepEqual(filesOf(r.dir), before.files, 'no file written or touched');
});

test('a port or a callback anywhere in the snapshot is refused, so nothing handed in can be called', async () => {
  const { r, snap } = await scene(2);
  const calls = [];
  const fn = name => () => { calls.push(name); };
  for (const bad of [
    { ...snap, episodes: r.ports.memory },
    { ...snap, memory: { all: fn('memory.all'), recall: fn('memory.recall') } },
    { ...snap, evidence: { clock: snap.frame.clock, world: snap.frame.world, basis: 'chain', answers: {}, read: fn('evidence.read') } },
    { ...snap, provider: { decide: fn('provider.decide') } }, { ...snap, execution: { submit: fn('execution.submit') } }, { ...snap, sign: fn('sign') },
  ]) assert.deepEqual(previewDecision(bad).refused, ['snapshot_not_plain_data']);
  assert.deepEqual(calls, []);
});

test('missing inputs are refused by name, never filled in; evidence without the observe frame is not read', async () => {
  const { snap } = await scene(2);
  const cases = [
    [{ ...snap, charter: { ...snap.charter, goal: 'nope' } }, 'charter'], [{ ...snap, state: { ...snap.state, journal: undefined } }, 'state'],
    [{ ...snap, state: { ...snap.state, aliases: undefined } }, 'state'], [{ ...snap, address: '' }, 'address'],
    [{ ...snap, obs: { world: { ...snap.obs.world, me: undefined }, board: snap.obs.board } }, 'obs'],
    [{ ...snap, obs: { ...snap.obs, world: { ...snap.obs.world, villages: [] } } }, 'obs: no village of this resident'],
    [{ ...snap, episodes: undefined }, 'episodes'],
    [{ ...snap, frame: null, evidence: { answers: {} } }, 'frame: no clock to check the evidence against'],
    [{ ...snap, frame: { clock: snap.frame.clock }, evidence: { answers: {} } }, 'frame: no world to check the evidence against'],
    [{ ...snap, evidence: { answers: { x: { status: 'ok' } } } }, 'evidence answer for x'],
  ];
  for (const [s, why] of cases) assert.ok((previewDecision(s).refused ?? []).includes(why), `${why}: ${JSON.stringify(previewDecision(s).refused)}`);
});

test("the resident's evidence rule over snapshot answers: chain excludes; unproven / integration-output are shown, not acted on", async () => {
  const { r, snap } = await scene(3);
  const ev = basis => ({ kind: 'snap', clock: snap.frame.clock, world: snap.frame.world, basis, basisWhy: [], answers: {} });
  const answer = basis => ({ status: 'ok', lines: [], facts: [{ commitment: 'c'.repeat(16), state: 'not_sent', due_bell: 1, verified: true, breach: true, sources: ['s'], evidenceBasis: basis }] });
  const cands = [{ id: 'x', kind: 'accept', act: { to: 'cp' }, summary: '' }];
  const port = basis => ({ ...ev(basis), read: () => answer(basis) });
  const who = c => c;
  assert.ok(publicEvidenceOf({ port: port('chain'), observe: snap.frame, cands, bell: 1, who }).breaches.has('cp'));
  for (const basis of ['unproven', 'integration-output', 'unstated']) {
    const out = publicEvidenceOf({ port: port(basis), observe: snap.frame, cands, bell: 1, who });
    assert.equal(out.breaches.size, 0, basis); assert.match(out.summary[0].notActedBecause, new RegExp(`basis ${basis}: not chain evidence`));
  }
  // through the preview: a counterparty not in the snapshot is `not_in_snapshot`, never read elsewhere
  const p = previewDecision({ ...snap, evidence: ev('unproven') });
  assert.equal(p.refused, undefined);
  assert.ok((p.evidence ?? []).every(s => s.status === 'not_in_snapshot'));
  assert.ok(!p.excluded.some(x => x.reason === 'ws12-verified-breach'));
  assert.equal(r.ports.evidenceUse, undefined);
});

test('shared rules: recall, the day counters (copy only), aliases, trust and the fallback are the resident\'s', async () => {
  const { r, obs } = await scene(4);
  const q = { focus: [r.address], bell: obs.world.bell };
  assert.deepEqual(recallFrom(r.ports.memory.all(), q), r.ports.memory.recall(q), 'the local adapter recalls through recallFrom');
  const c = { day: 0, actions: 5, messages: 2, giveAway: 1, gifts: 1, sibling: 1 };
  assert.deepEqual(todayOf(c, 144), { day: 1, actions: 0, messages: 0, giveAway: 0, gifts: 0, sibling: 0 }); assert.equal(c.actions, 5);
  const who = whoOf({ addr: new Map([['c1', 'A']]), aliases: { c2: 'B' } });
  assert.deepEqual([who('c1'), who('c2'), who('c3'), who(null)], ['A', 'B', 'c3', null]);
  const t = trustIndexOf([{ kind: 'kept', bell: 1, entities: ['c2'] }, { kind: 'broken', bell: 2, entities: ['A'] }, { kind: 'raided', bell: 7, entities: ['route:x>c2'] }], { c2: 'B' });
  assert.deepEqual([t.trust('B'), t.trust('A'), t.raided('B'), t.raided('A')], [1, -2, 7, null]);
  assert.equal(residentFallback, safeFallback, 'resident.mjs re-exports the same function');
  assert.equal(safeFallback([{ id: 'b', kind: 'build', score: 1 }, { id: 'd', kind: 'decline', score: 0 }, { id: 'wait', kind: 'wait', score: 0.5 }]), 'd');
});

test('the normal mode calls the same functions (pinned as text); the core imports nothing that acts', () => {
  const r = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  for (const s of ['return whoOf({ addr: this.addr, aliases: this.state.aliases })(citizen);', 'return trustIndexOf(this.ports.memory.all(), this.state.aliases);',
    'return requestOf({ charter: this.charter, id: this.id, citizen: this.state.citizen, obs, bell, turn, cands, wakes, evidence, mem });',
    'return publicEvidenceOf({ port: this.ports.evidence, observe: this.ports.observe, evidenceUse: this.ports.evidenceUse, cands, bell, who: c => this.#who(c) });',
    'const held = heldOf({ evidence, inFlight, failures: st.failures, bell, who: c => this.#who(c) });', 'const inFlight = inFlightOf(st.journal);',
    "export { OPEN_STATES, actionSig } from './decide-core.mjs';", "export { safeFallback } from './decide-core.mjs';"]) assert.ok(r.includes(s), s);
  assert.match(readFileSync(new URL('../resident/ports/memory.mjs', import.meta.url), 'utf8'), /recall\(\{ focus = \[\], bell \}\) \{ return recallFrom\(\[\.\.\.eps\.values\(\)\], \{ focus, bell \}\); \},/);
  const core = readFileSync(new URL('../resident/decide-core.mjs', import.meta.url), 'utf8');
  const imports = [...core.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./frame.mjs', '../../../permutation-gateway/citizens/mind/sanitize.mjs', '../world/rules.mjs', './candidates.mjs', './goals.mjs', './ports/provider.mjs', './recall.mjs']);
  assert.doesNotMatch(core, /node:fs|writeFile|appendFile|loadOrCreateKey|AgentLedger|decideWithin|\.submit\(|ports\.(join|board|execution|provider)|\.hold\(|memory\.append\(/);
  assert.match(core, /try \{ x = structuredClone\(snapshot\); \} catch \{ return \{ mode: 'preview', refused: \['snapshot_not_plain_data'\] \}; \}/);
});
