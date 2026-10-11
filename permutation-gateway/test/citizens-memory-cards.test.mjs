// The Wyll card (contract §2.4) and the memory store: card shape, relationships split, recent episodes, grievances,
// revealed reasons with code-rendered Remembered lines; store ingest, persistence and the published episode file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, Episodes } from '../citizens/memory/store.mjs';
import { renderCard, rememberedFor, CARD_LABEL } from '../citizens/memory/cards.mjs';
import { createSummaryStore, memoryHash } from '../citizens/memory/summary.mjs';
import { deal, loadDeck, makeSlots, personaOf } from '../citizens/persona/deal.mjs';
import { nameOf, nationName, tagHex } from '../citizens/persona/names.mjs';
import { clashFile, dec, fakeHerald, province, row } from './fixtures/ai-ac2-synth.mjs';
import { allProgress } from '../citizens/persona/goals.mjs';

const A = tagHex(1003n), E = tagHex(2002n);
const AI = { tag: A, wallet: 'AIW', faction: 3, home: { p: 1, q: 1 }, holdings: [{ p: 1, q: 1, site: 0 }] };

function attackWorld() {
  const sites = [20];
  const at = province({ p: 1, q: 1, sites, entries: [{ id: '5000001', faction: 3, tile: 20, troops: 500 }] });
  const after = province({ p: 1, q: 1, sites, entries: [{ id: '5000001', faction: 3, tile: 20, troops: 400 }] });
  const clash = clashFile({ p: 1, q: 1, bell: 110, fighters: [{ id: '6000001', arrival: true, post: 350, engaged: true, tile: 20 }, { id: '5000001', arrival: false, post: 400, engaged: true, tile: 20 }], before: at, arrivals: [{ id: '6000001', tag: dec(E), faction: 1, tile: 20, troops: 400 }] });
  const h = fakeHerald({ provinces: { '1,1,100': at, '1,1,110': after, '1,1,109': at }, clashes: [clash] });
  const events = [
    row(10, 'sigD', 100, 'DEPART', { host_id: '6000001' }, { origin_p: 3, origin_q: 1, origin_tile: 4, depart_bell: 100, arrive_bell: 110, dep_mass: 400000 }),
    row(20, 'sigR', 110, 'REVEAL', { p: 1, q: 1, arrive: 110, faction: 1, i: 0 }, { host_id: '6000001', tile: 20 }),
    row(30, 'sigC', 111, 'CLASH', { p: 1, q: 1, bell: 110 }, { engagements: 2 }),
  ];
  const ctx = { ai: AI, bellNow: 500, owners: { citizenOfHost: id => (id === '5000001' ? A : id === '6000001' ? E : null) }, province: h.province, clash: h.clash, config: {} };
  return { events, ctx };
}
const persona = () => {
  const d = deal(Buffer.alloc(32, 3), loadDeck('deck-2'), makeSlots(12)).find(x => x.persona === 'avenger');
  return { ...personaOf(d), name: nameOf(A), nation: nationName(3) };
};

test('store.ingest: episodes, trust and grievance reach the stores; a second ingest of the same batch changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const st = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const { events, ctx } = attackWorld();
  const r1 = st.ingest(A, { events }, ctx, { cursor: { event_seq: 30, bell: 112 } });
  assert.equal(r1.episodes.length, 1);
  const led = st.ledger(A);
  assert.deepEqual(led.trustOf(E), { total: -15, t_code: -15, t_model: 0 });
  assert.equal(led.grievances({ open: true }).length, 1);
  assert.deepEqual(led.snapshot().cursor, { event_seq: '30', bell: 112 });
  const before = [led.canonical(), st.episodes(A).sha256()];
  st.ingest(A, { events }, ctx);
  assert.deepEqual([led.canonical(), st.episodes(A).sha256()], before);
});

test('store.ingest answers a grievance: an own march whose REVEAL destination is the wrongdoer\'s army at the departure bell sets `answered` (code-set)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const st = createMemoryStore({ stateDir: join(dir, 'state') });
  const { events, ctx } = attackWorld();
  st.ingest(A, { events }, ctx);
  assert.equal(st.ledger(A).grievances({ open: true }).length, 1);
  const g = st.ledger(A).grievances()[0];
  const atD = province({ p: 3, q: 0, sites: [4], entries: [{ id: '6000001', faction: 1, tile: 9, troops: 300 }] });
  const h = fakeHerald({ provinces: { '3,0,500': atD } });
  const march = [
    row(60, 'sigD2', 500, 'DEPART', { host_id: '5000001' }, { origin_p: 1, origin_q: 1, origin_tile: 20, depart_bell: 500, arrive_bell: 504, dep_mass: 500000 }),
    row(61, 'sigR2', 504, 'REVEAL', { p: 3, q: 0, arrive: 504, faction: 3, i: 0 }, { host_id: '5000001', tile: 9 }),
  ];
  st.ingest(A, { events: [...events, ...march] }, { ...ctx, province: (p, q, b) => h.province(p, q, b) ?? ctx.province(p, q, b), bellNow: 600 });
  assert.deepEqual(st.ledger(A).grievances().map(x => [x.id, x.answered, x.answered_bell]), [[g.id, true, 504]]);
  assert.deepEqual(st.ledger(A).grievances({ open: true }), []);
});

test('store: save and reload; publish writes PUB/memory/<tag>/episodes.json whose sha256 is the canonical list hash (M11) and is skipped when unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const mk = () => createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const st = mk();
  const { events, ctx } = attackWorld();
  st.ingest(A, { events }, ctx);
  assert.equal(st.publish(A), true);
  assert.equal(st.publish(A), false, 'unchanged');
  const file = JSON.parse(readFileSync(join(dir, 'pub', 'memory', A, 'episodes.json'), 'utf8'));
  assert.equal(file.v, 1); assert.equal(file.tag, A); assert.equal(file.count, 1);
  assert.equal(file.sha256, new Episodes(file.episodes).sha256());
  assert.equal(file.sha256, st.episodes(A).sha256());
  assert.ok(!existsSync(join(dir, 'pub', 'memory', A, 'summary.json')));
  st.save(A);
  const again = mk();
  assert.equal(again.episodes(A).sha256(), st.episodes(A).sha256());
  assert.equal(again.ledger(A).canonical(), st.ledger(A).canonical());
});

test('summary store and publication: a validated summary is stored by bell, published with its label, and enters memory_hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const st = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  assert.equal(st.summary.latest(A), null);
  const s1 = st.summary.save(A, 72, 'Quiet day; one attack.');
  st.summary.save(A, 144, 'Second summary.');
  const latest = st.summary.latest(A);
  assert.deepEqual([latest.bell, latest.text], [144, 'Second summary.']);
  assert.match(s1.sha256, /^[0-9a-f]{64}$/);
  const { events, ctx } = attackWorld();
  st.ingest(A, { events }, ctx);
  st.publish(A);
  const pub = JSON.parse(readFileSync(join(dir, 'pub', 'memory', A, 'summary.json'), 'utf8'));
  assert.deepEqual([pub.bell, pub.text, pub.sha256], [144, 'Second summary.', latest.sha256]);
  assert.match(pub.label.en, /not verified, not replayed/);
  const h1 = memoryHash(st.ledger(A), ['e1'], latest.sha256), h2 = memoryHash(st.ledger(A), ['e1'], '');
  assert.notEqual(h1, h2);
  assert.equal(h1, memoryHash(st.ledger(A), ['e1'], latest.sha256));
  assert.equal(createSummaryStore({ stateDir: join(dir, 'state') }).latest(A).sha256, latest.sha256);
});

test('ownState carries only this AI\'s ledger, episodes and summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const st = createMemoryStore({ stateDir: join(dir, 'state') });
  const { events, ctx } = attackWorld();
  st.ingest(A, { events }, ctx);
  st.ledger(tagHex(9n));
  const o = st.ownState(A, { bell: 200 });
  assert.deepEqual(Object.keys(o).sort(), ['bell', 'episodes', 'ledger', 'summary', 'tag']);
  assert.equal(o.ledger.tag, A);
  assert.equal(o.episodes.size, 1);
});

test('card goals: progress null means "not computed" and is kept as null (never turned into 0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const st = createMemoryStore({ stateDir: join(dir, 'state') });
  const p = persona();
  st.ledger(A, { goals: p.goals, bell: 0 });
  st.ledger(A).setGoalProgress({ G1: null, G2: 40 });
  const card = renderCard({ tag: A, wallet: 'AIW', faction: 3, index: 1003, bell: 10, persona: p, ledger: st.ledger(A).snapshot(), episodes: st.episodes(A), summary: null, revealed: [], budget: {}, stats: {} });
  assert.equal(card.goals[0].progress, null);
  assert.equal(card.goals[1].progress, 40);
});

test('card shape (§2.4): label, tag, persona, goals with progress and the memory flag, relationships split, memory block, stats, budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const st = createMemoryStore({ stateDir: join(dir, 'state') });
  const p = persona();
  st.ledger(A, { goals: p.goals, bell: 0 });
  const { events, ctx } = attackWorld();
  st.ingest(A, { events }, ctx);
  st.ledger(A).applyModelDeltas([{ who: E, delta: -5 }], { bell: 150 });
  const progress = allProgress(p, { bellNow: 200, facts: {}, ledger: st.ledger(A).snapshot(), episodes: st.episodes(A).list() });
  const summary = st.summary.save(A, 144, 'The Avenger kept watch.');
  const card = renderCard({
    tag: A, wallet: 'AIW', faction: 3, index: 1003, bell: 200, persona: p, ledger: st.ledger(A).snapshot(), episodes: st.episodes(A), summary, progress,
    revealed: [{ bell: 150, decision_id: 'dec1', by: 'model', why: 'Answer the attack.', remembered: rememberedFor(st.episodes(A), st.episodes(A).list().map(e => e.id), 150) }],
    budget: { messages_left: 3, reactions_left: 2 }, stats: { decisions: 41, valid: 40, actions_by_model: 9, actions_by_autopilot: 112 },
  });
  assert.deepEqual(Object.keys(card), ['v', 'ai', 'label', 'tag', 'wallet', 'faction', 'index', 'name', 'persona', 'goals', 'relationships', 'memory', 'revealed_reasons', 'budget', 'stats', 'updated_bell']);
  assert.deepEqual([card.v, card.ai, card.tag, card.wallet, card.faction, card.index, card.updated_bell], [1, true, A, 'AIW', 3, 1003, 200]);
  assert.deepEqual(card.label, { ...CARD_LABEL });
  assert.match(card.label.en, /^AI citizen/);
  assert.equal(card.persona.id, 'avenger');
  assert.deepEqual(Object.keys(card.persona.temperament), ['aggression', 'loyalty', 'ambition', 'honesty', 'risk', 'sociability', 'grudge']);
  assert.deepEqual(card.goals.map(g => [g.id, g.memory, g.status]), [['G1', true, 'active'], ['G2', false, 'active'], ['G3', true, 'active'], ['G4', false, 'active']]);
  assert.ok(card.goals.every(g => g.text.en && g.text.ja && Number.isInteger(g.progress)));
  assert.deepEqual(card.relationships, [{ who: E, name: nameOf(E), kind: 'citizen', trust: -20, trust_code: -15, trust_model: -5, last_event_bell: 150 }]);
  assert.deepEqual(card.memory.summary, { bell: 144, text: 'The Avenger kept watch.', sha256: summary.sha256, label: card.memory.summary.label });
  assert.match(card.memory.summary.label.ja, /AIのモデル/);
  assert.equal(card.memory.recent.length, 1);
  assert.deepEqual(Object.keys(card.memory.recent[0]), ['id', 'bell', 'kind', 'text']);
  assert.equal(card.memory.recent[0].kind, 'attacked_own');
  assert.deepEqual(card.memory.grievances.map(g => [g.against, g.name, g.bell, g.weight, g.answered]), [[E, nameOf(E), 110, 8, false]]);
  assert.equal(card.revealed_reasons[0].by, 'model');
  assert.equal(card.revealed_reasons[0].remembered[0].age_bells, 40);
  assert.match(card.revealed_reasons[0].remembered[0].text.en, /attacked your army/);
  assert.deepEqual(card.budget, { messages_left: 3, reactions_left: 2, resting: false });
  assert.equal(card.stats.decisions_citing_memory, 0);
  assert.equal(card.stats.actions_by_model, 9);
  assert.equal(card.stats.mem_dropped, 0);
  assert.ok(!/pact|betray|promise|alliance|renown/i.test(JSON.stringify(card)), 'no pact or renown field');
  JSON.parse(JSON.stringify(card));
});

test('card: relationships are the 8 highest |trust|; recent is the last 5 episodes (created by the card bell); resting when a daily budget is used; grievances <= 5', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const st = createMemoryStore({ stateDir: join(dir, 'state') });
  const p = persona();
  const led = st.ledger(A, { goals: p.goals });
  for (let i = 1; i <= 12; i++) led.apply({ id: `t${i}`, kind: 'trust', who: tagHex(BigInt(100 + i)), part: 'code', amount: -i * 5, bell: i });
  for (let i = 1; i <= 7; i++) led.apply({ id: `g${i}`, kind: 'grievance', against: tagHex(BigInt(100 + i)), nation: 1, event: `ev${i}`, bell: i, weight: 8 });
  const eps = new Episodes(Array.from({ length: 9 }, (_, i) => ({ v: 1, id: `${i}`.padStart(16, '0'), kind: 'dm', bell: 10 + i, created_bell: 11 + i, importance: 4, entities: [], facts: {}, text: { en: `e${i}`, ja: `j${i}` }, src: [`s${i}`] })));
  const card = renderCard({ tag: A, wallet: 'AIW', faction: 3, index: 1003, bell: 18, persona: p, ledger: led.snapshot(), episodes: eps, summary: null, budget: { messages_left: 0, reactions_left: 2 } });
  assert.equal(card.relationships.length, 8);
  assert.deepEqual(card.relationships.map(r => r.trust), [-60, -55, -50, -45, -40, -35, -30, -25]);
  assert.deepEqual(card.memory.recent.map(e => e.bell), [13, 14, 15, 16, 17]); // created_bell <= 18 leaves bells 10..17; the last 5 of them
  assert.equal(card.memory.grievances.length, 5);
  assert.equal(card.budget.resting, true);
  assert.equal(card.memory.summary, null);
});

test('card text is sanitised: a model why with markup is neutralised; no `<` `>` survive in any card string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const st = createMemoryStore({ stateDir: join(dir, 'state') });
  const p = persona();
  const card = renderCard({ tag: A, wallet: 'AIW', faction: 3, index: 1003, bell: 5, persona: p, ledger: st.ledger(A, { goals: p.goals }).snapshot(), episodes: new Episodes(), summary: { bell: 1, text: 'x <b>bold</b> {"a":1} M2 [bell 1]', sha256: 'f'.repeat(64) }, revealed: [{ bell: 2, decision_id: 'd', by: 'model', why: '<img src=x onerror=alert(1)>', remembered: [] }] });
  assert.ok(!/[<>]/.test(JSON.stringify(card).replace(/\\u003c|\\u003e/g, '')), 'no angle brackets');
  assert.ok(!/[{}\[\]]/.test(card.memory.summary.text) && !/\bM2\b/.test(card.memory.summary.text));
});
