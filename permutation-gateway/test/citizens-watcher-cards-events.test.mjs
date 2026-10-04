// AC6: the Wyll cards job (contract 2.4), PUB/events/latest.json (8.3), the social wakes (3.2: W-DM, W-HALL, W-CALL) and the outbox that hands
// council-call output to the brain. Cards use AC2's real store, `personaOf` and `renderCard` and AC1a's real records; the feed, owners and
// the social rows are doubles in the real shapes (SYNTHETIC rows, labelled); one events test reads the REAL captured rows through the real feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStore } from '../citizens/memory/store.mjs';
import { personaOf } from '../citizens/persona/deal.mjs';
import { createRecords } from '../citizens/mind/records.mjs';
import { createCardsJob } from '../citizens/watcher/cards_job.mjs';
import { createEventsPub } from '../citizens/watcher/events_pub.mjs';
import { createSocialWakes, DM_WINDOW } from '../citizens/watcher/wakes.mjs';
import { createOutbox, MOTION_VALID_BELLS, BALLOT_VALID_BELLS } from '../citizens/watcher/outbox.mjs';
import { createFeed } from '../citizens/watcher/feed.mjs';
import { startFakeHerald, loadMeta } from './fixtures/ai-herald-fake.mjs';
import { fakeFeed, fakeOwners, fakeRoster, nameOfDouble, nationNameDouble, tmpDir } from './fixtures/ai-watcher-kit.mjs';

const TAG = 'aaaaaaaaaaaaaaa1';
const TAG_B = 'aaaaaaaaaaaaaaa2';
const entry = (over = {}) => ({ index: 1003, tag: TAG, wallet: 'W-A', faction: 1, persona: 'avenger', creed_variant: 2, temperament: { aggression: 67, loyalty: 72, ambition: 49, honesty: 58, risk: 61, sociability: 44, grudge: 90 }, name: { en: 'Ember Ash', ja: 'エンバー・アッシュ' }, ...over });
const EP = { v: 1, id: 'e1e1e1e1e1e1e1e1', bell: 388, created_bell: 390, kind: 'camp_taken_by', entities: ['nation:3', 'pq:2,0'], text: { en: 'At bell 388 nation Dunmar cleared the camp at (2,0) first.', ja: '鐘388で、ダンマールがあなたより先に、(2,0)の野営地を倒した。' }, importance: 5, src: ['event:1'] };
const modelRec = (over = {}) => ({
  v: 2, ai: TAG, index: 1003, bell: 400, kind: 'session', mode: 'model', reason: 'ok', wake: ['W-PULSE'], gate_score: 3, obs_digest: 'ab', situation_hash: 'sh', candidates_hash: 'ch', memory_hash: 'mh',
  inbox_root: 'ir', prompt_hash: 'ph', request_hash: 'rh', output_hash: 'oh', attempts: 1, seed: 5, sealed: false, release_bell: null,
  choice: { ids: ['c1'], params: {}, council: null, goal_id: 'G1', mem: [EP.id] }, retrieved: [EP.id], public: { say: [], why: 'Dunmar took the camp first; I hold.', why_withheld: null }, latency_ms: 5000, deadline_slack_ms: 30000, quota_left: 30, ...over,
});

// ---------------------------------------------------------------- cards
function cardsWorld() {
  const dir = tmpDir('ai-cards-');
  const stores = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const records = createRecords({ aiDir: dir, randomBytes: n => Buffer.alloc(n, 3) });
  const roster = fakeRoster({ ai: [entry(), entry({ index: 1004, tag: TAG_B, wallet: 'W-B', faction: 2, persona: 'diplomat', name: { en: 'Borealis Brook', ja: 'ボレアリス・ブルック' } })] });
  stores.episodes(TAG).add(EP);
  const changed = [];
  const mind = { statsOf: tag => ({ decisions: tag === TAG ? 5 : 0, valid: 4, actions_by_model: 2, actions_by_autopilot: 7, model_marches: 1, messages: 2, strikes_declined: 1, decisions_citing_memory: 1, mem_dropped: 0 }) };
  const job = createCardsJob({ roster, stores, records, mind: () => mind, personaOf, nameOf: nameOfDouble, nationName: nationNameDouble, config: { budgets: { reactions: 6 } }, pubDir: join(dir, 'pub'), onChanged: c => changed.push(c) });
  const card = (tag = TAG) => JSON.parse(readFileSync(join(dir, 'pub/cards', `${tag}.json`), 'utf8'));
  return { dir, stores, records, roster, job, changed, card, mind };
}

test('cards: the card has the label, persona, goals (null = progress not computed), the memory block and the stats; the unsealed reason is published at once with its Remembered line', () => {
  const w = cardsWorld();
  w.records.add(modelRec());
  const written = w.job.update(401);
  assert.deepEqual(written.sort(), [TAG, TAG_B].sort());
  const c = w.card();
  assert.equal(c.ai, true);
  assert.equal(c.tag, TAG);
  assert.equal(c.faction, 1);
  assert.equal(c.persona.id, 'avenger');
  assert.match(c.label.en, /AI citizen/);
  assert.equal(c.goals.length, 4);
  assert.deepEqual(c.name, { en: 'Ember Ash', ja: 'エンバー・アッシュ' });
  assert.equal(c.updated_bell, 401);
  // the published reason with the cited episode: code text, bell and the age in bells (400 - 388)
  assert.equal(c.revealed_reasons.length, 1);
  const r = c.revealed_reasons[0];
  assert.deepEqual([r.bell, r.by, r.why], [400, 'model', 'Dunmar took the camp first; I hold.']);
  assert.deepEqual(r.remembered, [{ id: EP.id, bell: 388, age_bells: 12, text: EP.text }]);
  assert.deepEqual(c.memory.recent.map(e => e.id), [EP.id]);
  assert.equal(c.memory.summary, null);
  assert.deepEqual([c.stats.decisions, c.stats.actions_by_model, c.stats.actions_by_autopilot, c.stats.model_marches, c.stats.model_marches_opened, c.stats.strikes_declined], [5, 2, 7, 1, 0, 1]);
  const idx = JSON.parse(readFileSync(join(w.dir, 'pub/cards/index.json'), 'utf8'));
  assert.deepEqual(idx.cards.map(x => [x.tag, x.persona]), [[TAG, 'avenger'], [TAG_B, 'diplomat']]);
  assert.equal(idx.bell, 401);
});

test('cards: a sealed decision shows no reason until its release; an opened march counts in model_marches_opened and its reason appears with the cited lines', () => {
  const w = cardsWorld();
  const { id } = w.records.add(modelRec({ bell: 402, sealed: true, release_bell: 406, public: { say: [], why: 'The camp is close; I go.', why_withheld: null } }), { candidates: [], remembered: [{ id: EP.id, bell: 388, text: EP.text }], intended: [] });
  w.job.update(403);
  assert.deepEqual(w.card().revealed_reasons, [], 'sealed: the reason is not published');
  assert.equal(JSON.stringify(w.card()).includes('The camp is close'), false);
  const opened = { ...w.records.open(id), opened_bell: 407, destinations: [{ host_id: '77', state: 'revealed', via: 'model', p: 2, q: 0, tile: 9, arrive_bell: 405, planned_arrive_bell: 405 }] };
  w.job.addOpened(opened);
  w.job.update(407);
  const c = w.card();
  assert.equal(c.revealed_reasons.length, 1);
  assert.equal(c.revealed_reasons[0].why, 'The camp is close; I go.');
  assert.equal(c.revealed_reasons[0].remembered[0].age_bells, 14);
  assert.equal(c.stats.model_marches_opened, 1);
  // an unrevealed march does not count as an opened march
  const { id: id2 } = w.records.add(modelRec({ bell: 410, sealed: true, release_bell: 414 }), { candidates: [], remembered: [], intended: [] });
  w.job.addOpened({ ...w.records.open(id2), destinations: [{ host_id: '78', state: 'unrevealed', via: 'model' }] });
  w.job.update(420);
  assert.equal(w.card().stats.model_marches_opened, 1);
});

test('cards: autopilot decisions and reflections publish no reason; at most the last 5 reasons are on the card; a redacted episode vanishes from "Remembered"', () => {
  const w = cardsWorld();
  w.records.add(modelRec({ bell: 400, mode: 'autopilot', reason: 'below_gate', public: { say: [], why: null, why_withheld: null }, choice: { ids: ['c1'], params: {}, council: null, goal_id: null, mem: [] } }));
  w.records.add(modelRec({ bell: 401, kind: 'reflection', public: { say: [], why: 'a summary note', why_withheld: null } }));
  for (let i = 0; i < 7; i++) w.records.add(modelRec({ bell: 410 + i, public: { say: [], why: `reason ${i}`, why_withheld: null } }));
  w.job.update(420);
  const c = w.card();
  assert.deepEqual(c.revealed_reasons.map(r => r.why), ['reason 2', 'reason 3', 'reason 4', 'reason 5', 'reason 6']);
  w.stores.episodes(TAG).redact(EP.id);
  w.job.update(421);
  assert.deepEqual(w.card().revealed_reasons.at(-1).remembered, [], 'a redacted episode is not shown');
});

test('cards: rewritten only when the content changes (updated_bell is the bell of the change); a new self-summary and a goal changing state are reported once', () => {
  const w = cardsWorld();
  w.job.update(401);
  const file = join(w.dir, 'pub/cards', `${TAG}.json`);
  const m0 = statSync(file).mtimeMs;
  assert.deepEqual(w.job.update(402), [], 'nothing changed: no card written');
  assert.equal(statSync(file).mtimeMs, m0);
  assert.equal(w.card().updated_bell, 401);
  assert.deepEqual(w.changed, [], 'the first card is the baseline');
  w.stores.summary.save(TAG, 410, 'A short note about the camp.');
  assert.deepEqual(w.job.update(411), [TAG]);
  assert.equal(w.card().updated_bell, 411);
  assert.equal(w.card().memory.summary.text, 'A short note about the camp.');
  assert.deepEqual(w.changed, [{ tag: TAG, bell: 411, what: 'summary' }]);
  w.stores.ledger(TAG).s.goals[0].status = 'dropped';
  w.job.update(412);
  assert.deepEqual(w.changed.at(-1), { tag: TAG, bell: 412, what: 'goals' });
  w.job.update(413);
  assert.equal(w.changed.length, 2);
});

test('cards: budget (messages left from the persona cap, reactions left; resting when one is used up) and the restart rebuild of the opened counts from PUB/open', () => {
  const w = cardsWorld();
  const led = w.stores.ledger(TAG);
  led.s.counters = { day: 2, sessions: 1, reactions: 6, messages: 3, marches: 0 };
  w.job.update(2 * 144 + 5);
  const b = w.card().budget;
  assert.deepEqual([b.messages_left, b.reactions_left, b.resting], [5, 0, true], 'cap 6 + round(44 / 25) = 8, 3 used');
  led.s.counters = { day: 1, sessions: 0, reactions: 6, messages: 3, marches: 0 };
  w.job.update(2 * 144 + 6);
  assert.equal(w.card().budget.messages_left, 8, 'a counter of another day is not today\'s');
  // restart: the opened part is rebuilt from the published files
  mkdirSync(join(w.dir, 'pub/open'), { recursive: true });
  writeFileSync(join(w.dir, 'pub/open/index.json'), JSON.stringify({ v: 1, bells: [407], latest: 407 }));
  writeFileSync(join(w.dir, 'pub/open/407.json'), JSON.stringify({ v: 1, bell: 407, records: [{ id: 'x1', ai: TAG, bell: 402, mode: 'model', kind: 'session', public: { why: 'Earlier I went.' }, choice: { mem: [EP.id] }, destinations: [{ state: 'revealed', via: 'model' }, { state: 'revealed', via: 'strike_order' }] }] }));
  const j2 = createCardsJob({ roster: w.roster, stores: w.stores, records: w.records, mind: () => w.mind, personaOf, nameOf: nameOfDouble, nationName: nationNameDouble, pubDir: join(w.dir, 'pub') });
  j2.loadOpened();
  assert.equal(j2.openedCount(TAG), 1, 'only the model-chosen march counts');
  assert.equal(j2.reasonsOf(TAG)[0].why, 'Earlier I went.');
});

// ---------------------------------------------------------------- events
const SEATTAG = 'bbbbbbbbbbbbbbb0', BOTTAG = 'cccccccccccccc01', HUMTAG = 'dddddddddddddd01';
const dep = (host, bell, arrive, mass = 300_000, seq = null) => ({ kind: 'DEPART', bell, seq: seq ?? `${bell}0${host}`, host_id: String(host), depart_bell: bell, arrive_bell: arrive, dep_mass: mass, origin_p: 1, origin_q: -1, origin_tile: 4 });
function eventsWorld() {
  const owners = fakeOwners({
    citizens: [{ tag: TAG, faction: 1, kind: 'ai' }, { tag: SEATTAG, faction: 0, kind: 'seat' }, { tag: BOTTAG, faction: 2, kind: 'script' }, { tag: HUMTAG, faction: 3 }],
    hostOwner: { 11: TAG, 12: BOTTAG, 13: SEATTAG, 14: HUMTAG },
  });
  const feed = fakeFeed({ owners, head: 120, through: 120 });
  const roster = fakeRoster({ ai: [entry()], seat: { tag: SEATTAG, wallet: 'SEAT', faction: 0 } });
  const dir = tmpDir('ai-events-');
  const pub = createEventsPub({ feed, roster, nameOf: nameOfDouble, pubDir: join(dir, 'pub') });
  return { feed, owners, roster, dir, pub, read: () => JSON.parse(readFileSync(join(dir, 'pub/events/latest.json'), 'utf8')) };
}

test('events: departures and real clashes with actor tags and roster badges (ai, seat, script, none); the destination only once the REVEAL is public; newest first; the window and the cap', async () => {
  const w = eventsWorld();
  w.feed.addEvent(dep(11, 100, 104, 300_000, '5'));
  w.feed.addEvent(dep(12, 101, 105, 150_000, '6'));
  w.feed.addEvent(dep(14, 102, 106, 250_000, '7'));
  w.feed.addEvent({ kind: 'CLASH', bell: 106, seq: '9', p: 2, q: 0, clash_bell: 104, engagements: 2, arrivals: 1, real: true });
  w.feed.addEvent({ kind: 'CLASH', bell: 107, seq: '10', p: 5, q: 5, clash_bell: 105, engagements: 0, arrivals: 0, real: false });
  w.feed.clash.set('2,0,104', { fighters: [
    { id: '11', owner: TAG, faction: 1, arrival: true, engaged: true, fate: 'Stays', tile: 9, troops: 250_000 },
    { id: '13', owner: SEATTAG, faction: 0, arrival: false, engaged: true, fate: 'Stays', tile: 9, troops: 100_000 },
    { id: '14', owner: HUMTAG, faction: 3, arrival: false, engaged: false, fate: 'Stays', tile: 30, troops: 90_000 },
  ] });
  await w.pub.update(110);
  const f = w.read();
  assert.deepEqual(f.events.map(e => e.kind), ['clash', 'depart', 'depart', 'depart'], 'newest log bell first; the roll-call clash is not an event');
  const [clash, d3, d2, d1] = f.events;
  assert.deepEqual([d1.actor.tag, d1.actor.kind, d1.actor.ai, d1.actor.faction, d1.mass, d1.arrive_bell, d1.origin], [TAG, 'ai', true, 1, 300, 104, { p: 1, q: -1 }]);
  assert.deepEqual([d2.actor.kind, d2.actor.ai], ['script', false]);
  assert.deepEqual([d3.actor.kind, d3.actor.ai], [null, false], 'a citizen no list names is neither AI nor script');
  assert.equal(d1.destination, null, 'sealed until the REVEAL is public');
  assert.deepEqual(clash.actors.map(a => [a.tag, a.kind, a.ai, a.arrived, a.engaged]), [[TAG, 'ai', true, true, true], [SEATTAG, 'seat', false, false, true]], 'only the actors that took part');
  assert.deepEqual([clash.p, clash.q, clash.bell, clash.log_bell, clash.engagements, clash.arrivals], [2, 0, 104, 106, 2, 1]);
  assert.equal(clash.actors[0].troops_after, 250);
  assert.deepEqual(d1.actor.name, nameOfDouble(TAG));
  // the REVEAL becomes public: the destination appears
  w.feed.reveals.set('11/104', { kind: 'REVEAL', p: 2, q: 0, arrive: 104, host_id: '11', tile: 9 });
  assert.equal(await w.pub.update(111), true);
  assert.deepEqual(w.read().events.find(e => e.kind === 'depart' && e.host_id === '11').destination, { p: 2, q: 0, tile: 9 });
  // nothing changed: nothing is written; the window drops old events; the cap is honoured
  assert.equal(await w.pub.update(112), false);
  const small = createEventsPub({ feed: w.feed, roster: w.roster, nameOf: nameOfDouble, pubDir: join(w.dir, 'pub2'), window: 10, cap: 2 });
  const b = await small.build(110);
  assert.deepEqual(b.events.map(e => e.kind), ['clash', 'depart'], 'the cap keeps the two newest');
  assert.equal((await createEventsPub({ feed: w.feed, roster: w.roster, nameOf: nameOfDouble, pubDir: join(w.dir, 'pub3'), window: 3 }).build(110)).events.length, 0, 'a window of 3 bells before 110 holds nothing');
});

test('events: REAL captured rows through the real feed give departures and clashes with owners from public records only', async () => {
  const meta = loadMeta();
  const h = await startFakeHerald();
  try {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const roster = fakeRoster({ ai: [] });
    const dir = tmpDir('ai-events-real-');
    const pub = createEventsPub({ feed, roster, nameOf: nameOfDouble, pubDir: join(dir, 'pub'), window: 2000, cap: 2000 });
    const b = await pub.build(feed.headBell());
    const departs = b.events.filter(e => e.kind === 'depart');
    const clashes = b.events.filter(e => e.kind === 'clash');
    assert.ok(departs.length > 50, `departures: ${departs.length}`);
    assert.ok(clashes.length >= 3, `real clashes: ${clashes.length}`);
    assert.ok(departs.every(d => /^\d+$/.test(d.host_id) && Number.isInteger(d.arrive_bell) && d.mass > 0));
    assert.ok(departs.some(d => d.actor.tag && d.actor.faction !== null), 'owners resolved from the public JOIN and SETTLE rows');
    assert.ok(departs.every(d => d.actor.ai === false), 'no roster: nobody is labelled AI');
    assert.ok(clashes.every(c => c.actors.every(a => a.arrived || a.engaged)));
    // a departure whose REVEAL is in the data shows its destination; the sealed bytes of the DEPART never appear
    assert.ok(departs.some(d => d.destination && Number.isInteger(d.destination.tile)));
    assert.equal(JSON.stringify(b).includes('seal'), false);
    void meta;
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- wakes
const row = (over = {}) => ({ id: over.id ?? 1, bell: 100, wallet: 'W-X', tag: TAG_B, channel: 3, target: 'W-A', kind: 0, ref: 0, text: 'hello', inner: `in${over.id ?? 1}`, ...over });

function wakeWorld(rows = [], council = null) {
  const roster = fakeRoster({ ai: [entry()] });
  const state = { rows };
  const w = createSocialWakes({ rows: () => state.rows, council, roster, nameOf: () => ({ en: 'Ember Ash', ja: 'エンバー・アッシュ' }) });
  return { w, state };
}

test('W-DM: a direct message to the AI, once per sender per 6 bells, delivered once; not its own message, not another recipient, not a motion', () => {
  const { w, state } = wakeWorld([
    row({ id: 1, bell: 100 }), row({ id: 2, bell: 102, wallet: 'W-X' }), // the same sender within 6 bells: counted once
    row({ id: 3, bell: 103, wallet: 'W-Y', tag: 'aaaaaaaaaaaaaaa3' }), // another sender
    row({ id: 4, bell: 103, target: 'W-OTHER' }), row({ id: 5, bell: 103, tag: TAG, wallet: 'W-A' }), // not to the AI / from itself
    row({ id: 6, bell: 104, channel: 1, target: 0, kind: 1, ref: 2 * 256 + 1, text: 'motion' }), // a motion elsewhere
  ]);
  const got = w.wakes(TAG, 104);
  assert.deepEqual(got.map(x => [x.code, x.seq]), [['W-DM', 'in1'], ['W-DM', 'in3']]);
  assert.equal(got[0].weight, 2);
  assert.equal(w.wakes(TAG, 104).length, 0, 'delivered once');
  state.rows.push(row({ id: 7, bell: 110 })); // 8 bells after the sender's last counted message (102 is not counted, 100 is): counts again
  assert.deepEqual(w.wakes(TAG, 110).map(x => x.seq), ['in7']);
  state.rows.push(row({ id: 8, bell: 112 }));
  assert.deepEqual(w.wakes(TAG, 112), [], 'the same sender within 6 bells');
  assert.equal(DM_WINDOW, 6);
  assert.deepEqual(w.wakes('ffffffffffffffff', 112), [], 'not on the roster: no wake');
});

test('W-DM: a message that lands after the step of its own bell is delivered at the next one; an old one (outside the lookback) is not', () => {
  const { w } = wakeWorld([row({ id: 1, bell: 100 })]);
  assert.deepEqual(w.wakes(TAG, 99), [], 'not yet');
  assert.deepEqual(w.wakes(TAG, 101).map(x => x.code), ['W-DM']);
  const old = wakeWorld([row({ id: 1, bell: 100 })]);
  assert.deepEqual(old.w.wakes(TAG, 120), [], 'older than the lookback of 8 bells');
});

test('W-HALL: a nation-channel message that names the AI (either language, any case) or a motion in its nation; not another nation, not its own', () => {
  const { w } = wakeWorld([
    row({ id: 1, bell: 100, channel: 1, target: 1, text: 'Is EMBER ASH ready?', tag: TAG_B }),
    row({ id: 2, bell: 100, channel: 1, target: 1, text: 'エンバー・アッシュ、どう思う？', tag: TAG_B }),
    row({ id: 3, bell: 100, channel: 1, target: 1, text: 'The harvest is good.', tag: TAG_B }), // names nobody
    row({ id: 4, bell: 100, channel: 1, target: 2, text: 'Ember Ash!', tag: TAG_B }), // another nation's hall
    row({ id: 5, bell: 101, channel: 1, target: 1, kind: 1, ref: 3 * 256 + 2, text: 'I move option 2', tag: TAG_B }), // a motion in its nation
    row({ id: 6, bell: 101, channel: 1, target: 1, kind: 1, ref: 3 * 256 + 2, text: 'my own motion', tag: TAG }),
  ]);
  const got = w.wakes(TAG, 101);
  assert.deepEqual(got.map(x => [x.code, x.seq, x.motion]), [['W-HALL', 'in1', false], ['W-HALL', 'in2', false], ['W-HALL', 'in5', true]]);
  assert.equal(got[0].weight, 1);
});

test('W-CALL: a Strike Order adopted and sealed in the AI\'s nation wakes it once, while members may follow it ([follow_from, S - 1]); other nations never', () => {
  const council = {
    latest: f => (f === 1 ? { period: 4, outcome: { adopted: true }, call: { sealed: true } } : null),
    publicOf: () => ({ adopted: true, sealed: true, follow_from: 126, strike_bell: 132, period: 4 }),
  };
  const { w } = wakeWorld([], council);
  assert.deepEqual(w.wakes(TAG, 125), [], 'before follow_from');
  const got = w.wakes(TAG, 127);
  assert.deepEqual(got.map(x => [x.code, x.weight, x.period]), [['W-CALL', 3, 4]]);
  assert.deepEqual(w.wakes(TAG, 128), [], 'once per period');
  const late = wakeWorld([], council).w;
  assert.deepEqual(late.wakes(TAG, 132), [], 'at S the follow window is over');
  const none = wakeWorld([], { latest: () => null, publicOf: () => null }).w;
  assert.deepEqual(none.wakes(TAG, 127), []);
  const unsealed = wakeWorld([], { latest: () => ({ period: 4, outcome: { adopted: true }, call: null }), publicOf: () => ({ adopted: true, sealed: false, follow_from: 126, strike_bell: 132 }) }).w;
  assert.deepEqual(unsealed.wakes(TAG, 127), [], 'no sealed Call to follow yet');
});

// ---------------------------------------------------------------- outbox
function outboxWorld() {
  const dir = tmpDir('ai-outbox-');
  const records = createRecords({ aiDir: dir, randomBytes: n => Buffer.alloc(n, 5) });
  const stats = {};
  const outbox = createOutbox({ records, stats });
  const base = { v: 2, ai: TAG, index: 1003, kind: 'session', mode: 'model', reason: 'ok', wake: [], gate_score: 0, sealed: false, choice: { ids: ['c1'], params: {}, council: null, goal_id: 'G1', mem: [] }, retrieved: [], public: { say: [], why: 'w', why_withheld: null }, situation_hash: 's', candidates_hash: 'c' };
  const session = bell => records.add({ ...base, bell }, { candidates: [], social: { talk: [] } });
  const council = (kind, bell, extra) => {
    const rec = { ...base, bell, kind };
    if (kind === 'motion') return records.add(rec, { candidates: [], social: { talk: [{ item: 0, kind: 1, channel: 1, target: 1, text: 'I move option 2.', lang: 'en', ref: 2 * 256 + 2, bell, seq: bell * 16 }] } });
    return records.add(rec, { candidates: [], social: { ballot: [{ item: 0, option: 2, period: 2, nonce: 'ab'.repeat(16) }] } });
  };
  return { records, outbox, stats, session, council };
}
const MOTION = bell => ({ season: 31, bell, seq: bell * 16, channel: 1, target: 1, kind: 1, ref: 2 * 256 + 2, origin: 1, lang: 'en', text: 'I move option 2.', item: 0 });
const BALLOT = { season: 31, period: 2, faction: 1, option: 2, candidates_hash: '11'.repeat(32), nonce: 'ab'.repeat(16), origin: 1, item: 0 };

test('outbox: the motion of a council call rides on the next decide answer of the same AI; the provenance is registered under that answer\'s record; the cached answer is never mutated', () => {
  const w = outboxWorld();
  const c = w.council('motion', 100);
  w.outbox.push({ tag: TAG, kind: 'motion', period: 2, decision_id: c.id, bell: 100, motion: MOTION(100), ballot: null });
  assert.equal(w.outbox.pendingCount(TAG), 1);
  const s = w.session(101);
  const ans = { v: 1, decision_id: s.id, mode: 'autopilot', reason: 'below_gate', choice: { ids: ['c1'], params: {}, mem: [] }, social: { say: [], motion: null, ballot: null } };
  const out = w.outbox.decorate({ ai: { tag: TAG }, bell: 101 }, ans);
  assert.notEqual(out, ans);
  assert.equal(ans.social.motion, null, 'the cached answer is untouched');
  assert.deepEqual([out.social.motion.item, out.social.motion.decision_id, out.social.motion.text], [0, c.id, 'I move option 2.']);
  const p = w.records.provenance(s.id, 0, 'talk');
  assert.deepEqual([p.text, p.kind, p.channel, p.ref, p.decision_bell], ['I move option 2.', 1, 1, 2 * 256 + 2, 101], 'the session record vouches for the motion, within one bell of it');
  assert.equal(w.outbox.pendingCount(TAG), 0);
  // a second answer has nothing more; an AI with nothing pending gets the same object back
  assert.equal(w.outbox.decorate({ ai: { tag: TAG }, bell: 102 }, ans), ans);
  assert.equal(w.outbox.decorate({ ai: { tag: TAG_B }, bell: 101 }, ans), ans);
  assert.equal(w.stats.outbox_attached, 1);
});

test('outbox: a motion item continues the numbering after the say items; the ballot rides along with item 0 and its own provenance (option, period, nonce)', () => {
  const w = outboxWorld();
  const c = w.council('motion', 100);
  const b = w.council('ballot', 103);
  w.outbox.push({ tag: TAG, kind: 'motion', period: 2, decision_id: c.id, bell: 100, motion: MOTION(100), ballot: null });
  w.outbox.push({ tag: TAG, kind: 'ballot', period: 2, decision_id: b.id, bell: 103, motion: null, ballot: BALLOT });
  const s = w.session(103);
  w.records.getPrivate(s.id).priv.social.talk.push({ item: 0, kind: 0, channel: 1, target: 1, text: 'hello', lang: 'en', ref: 0, bell: 103, seq: 1 }, { item: 1, kind: 0, channel: 1, target: 1, text: 'again', lang: 'en', ref: 0, bell: 103, seq: 2 });
  const ans = { v: 1, decision_id: s.id, mode: 'model', choice: { ids: [], params: {}, mem: [] }, social: { say: [{ item: 0 }, { item: 1 }], motion: null, ballot: null } };
  const out = w.outbox.decorate({ ai: { tag: TAG }, bell: 103 }, ans);
  assert.equal(out.social.motion, null, 'the motion expired: its bell is 3 bells old (a motion is valid for 1)');
  assert.equal(w.stats.outbox_expired, 1);
  assert.equal(out.social.ballot.item, 0);
  const bp = w.records.provenance(s.id, 0, 'ballot');
  assert.deepEqual([bp.option, bp.period, bp.nonce], [2, 2, 'ab'.repeat(16)]);
  // a motion that is still valid: numbered after the two say items
  const w2 = outboxWorld();
  const c2 = w2.council('motion', 100);
  w2.outbox.push({ tag: TAG, kind: 'motion', period: 2, decision_id: c2.id, bell: 100, motion: MOTION(100), ballot: null });
  const s2 = w2.session(101);
  const out2 = w2.outbox.decorate({ ai: { tag: TAG }, bell: 101 }, { v: 1, decision_id: s2.id, social: { say: [{ item: 0 }, { item: 1 }], motion: null, ballot: null } });
  assert.equal(out2.social.motion.item, 2);
  assert.equal(w2.records.provenance(s2.id, 2, 'talk').text, 'I move option 2.');
  assert.deepEqual([MOTION_VALID_BELLS, BALLOT_VALID_BELLS], [1, 2]);
});

test('outbox: an answer without a record, an item for a bell that has not come, a council record that vanished: nothing is attached and nothing breaks', () => {
  const w = outboxWorld();
  w.outbox.push({ tag: TAG, kind: 'motion', period: 2, decision_id: 'nope', bell: 100, motion: MOTION(100), ballot: null });
  const s = w.session(101);
  const ans = { decision_id: s.id, social: { say: [], motion: null, ballot: null } };
  assert.equal(w.outbox.decorate({ ai: { tag: TAG }, bell: 101 }, ans), ans);
  assert.equal(w.stats.outbox_no_provenance, 1);
  assert.equal(w.outbox.decorate({ ai: { tag: TAG }, bell: 101 }, { social: {} }).decision_id, undefined);
  assert.equal(w.outbox.decorate(null, ans), ans);
  const early = outboxWorld();
  early.outbox.push({ tag: TAG, kind: 'motion', period: 2, decision_id: 'x', bell: 105, motion: MOTION(105), ballot: null });
  assert.equal(early.outbox.take(TAG, 104).length, 0);
  assert.equal(early.outbox.pendingCount(TAG), 1, 'kept for its bell');
  assert.equal(existsSync('/nonexistent'), false);
});
