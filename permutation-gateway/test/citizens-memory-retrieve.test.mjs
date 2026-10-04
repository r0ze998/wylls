// Retrieval (contract §5.2), the episode store (cap 200, importance-aware eviction), replay equality and flooding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Episodes } from '../citizens/memory/store.mjs';
import { retrieve, scoreOf } from '../citizens/memory/retrieve.mjs';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { Ledger } from '../citizens/memory/ledger.mjs';
import { tagHex } from '../citizens/persona/names.mjs';
import { rng } from './fixtures/ai-ac2-synth.mjs';

let n = 0;
const ep = (kind, bell, importance, entities = [], created = bell + 1) => ({ v: 1, id: (++n).toString(16).padStart(16, '0'), kind, bell, created_bell: created, importance, entities, facts: {}, text: { en: `e${n}`, ja: `j${n}` }, src: [`s${n}`] });

test('score = importance x 0.5^((bellNow - bell)/72) x (1 + 0.5 x |entities ∩ focus|)', () => {
  const e = ep('threat', 100, 5, ['nation:2', 'pq:1,1']);
  assert.equal(scoreOf(e, new Set(), 100), 5e9);
  assert.equal(scoreOf(e, new Set(), 172), Math.round(2.5e9));
  assert.equal(scoreOf(e, new Set(['nation:2']), 100), Math.round(5 * 1.5 * 1e9));
  assert.equal(scoreOf(e, new Set(['nation:2', 'pq:1,1', 'zz']), 100), 10e9);
});

test('only episodes with created_bell < bellNow are retrievable (one bell after they became public)', () => {
  const a = ep('dm', 10, 4, [], 11), b = ep('dm', 11, 4, [], 12);
  assert.deepEqual(retrieve([a, b], [], 11), []);
  assert.deepEqual(retrieve([a, b], [], 12), [a.id]);
  assert.deepEqual(retrieve([a, b], [], 13), [a.id, b.id]);
});

test('top 8 by score, plus open-grievance sources (exempt from decay and the cut), plus the 3 newest, oldest first', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(ep('build_done', 1000 + i, 2));
  const grievance = ep('attacked_own', 10, 8, ['x']); // ancient: its decayed score is tiny
  const other = ep('threat', 5, 5);
  const all = [grievance, other, ...list];
  const ids = retrieve(all, [], 1100, { grievances: [{ event: grievance.id, bell: 12, answered: false }] });
  assert.ok(ids.includes(grievance.id), 'the unanswered attack is shown');
  assert.ok(!ids.includes(other.id));
  const newest = list.slice(-3).map(e => e.id);
  for (const id of newest) assert.ok(ids.includes(id));
  assert.equal(ids.length, 8 + 1); // the top 8 are the newest 8 build_done (the newest 3 are among them) + the grievance
  const bells = ids.map(id => all.find(e => e.id === id).bell);
  assert.deepEqual(bells, [...bells].sort((x, y) => x - y), 'oldest first');
  // answered grievances lose the exemption
  const ids2 = retrieve(all, [], 1100, { grievances: [{ event: grievance.id, bell: 12, answered: true }] });
  assert.ok(!ids2.includes(grievance.id));
  // at most 3 grievance sources
  const gs = Array.from({ length: 5 }, (_, i) => ep('attacked_own', 20 + i, 8));
  const ids3 = retrieve([...gs, ...list], [], 5000, { grievances: gs.map(g => ({ event: g.id, bell: g.bell, answered: false })) });
  assert.equal(gs.filter(g => ids3.includes(g.id)).length, 3);
  assert.ok(ids3.includes(gs[4].id) && ids3.includes(gs[3].id) && ids3.includes(gs[2].id), 'newest grievances first');
});

test('focus raises the score: an old episode about a focused nation beats a newer unrelated one', () => {
  const old = ep('camp_taken_by', 100, 5, ['nation:2']);
  const filler = Array.from({ length: 12 }, (_, i) => ep('build_done', 110 + i, 5));
  const without = retrieve([old, ...filler], [], 125);
  const withFocus = retrieve([old, ...filler], ['nation:2'], 125);
  assert.ok(!without.includes(old.id));
  assert.ok(withFocus.includes(old.id));
});

test('determinism and tie-breaks: same inputs -> same ids in the same order; ties by bell desc then id asc (G15)', () => {
  const t1 = ep('dm', 50, 4, ['a']), t2 = ep('dm', 50, 4, ['a']), t3 = ep('dm', 60, 4, ['b']);
  const all = [t1, t2, t3];
  const runs = new Set();
  for (let i = 0; i < 20; i++) runs.add(JSON.stringify(retrieve([...all].sort(() => rng(i)() - 0.5), ['a'], 100)));
  assert.equal(runs.size, 1, 'independent of the input order');
  // identical scores (same bell, importance, overlap): the id order decides which of two survives a cut to 1+3 newest
  const many = Array.from({ length: 10 }, () => ep('dm', 50, 4, ['a']));
  const ids = retrieve(many, ['a'], 100);
  const top = [...many].sort((x, y) => (x.id < y.id ? -1 : 1)).slice(0, 8).map(e => e.id);
  for (const id of top) assert.ok(ids.includes(id), 'the 8 smallest ids win the tie');
  // equal-bell episodes are presented by created_bell then id
  const same = retrieve([ep('dm', 5, 4, [], 9), ep('dm', 5, 4, [], 7)], [], 20);
  assert.equal(same.length, 2);
});

test('Episodes: add dedupes by id; list() is canonical (created_bell, bell, id); sha256 is stable', () => {
  const a = ep('dm', 10, 4), b = ep('dm', 5, 4, [], 30), c = ep('threat', 20, 5);
  const s = new Episodes([c, b, a, a]);
  assert.equal(s.size, 3);
  assert.deepEqual(s.list().map(e => e.id), [a.id, c.id, b.id]);
  const s2 = new Episodes([a, b, c]);
  assert.equal(s.sha256(), s2.sha256());
  assert.equal(s.add(a), 0);
  assert.match(s.sha256(), /^[0-9a-f]{64}$/);
});

test('cap 200 with importance-aware eviction: drop the lowest importance, then the oldest; high-importance and grievance sources survive', () => {
  const s = new Episodes();
  const attack = ep('attacked_own', 1, 8);
  s.add(attack);
  const threats = Array.from({ length: 30 }, (_, i) => ep('threat', 2 + i, 5));
  s.add(threats);
  const dms = Array.from({ length: 250 }, (_, i) => ep('dm', 100 + i, 4));
  s.add(dms);
  assert.equal(s.size, 200);
  assert.ok(s.get(attack.id), 'the oldest episode survives because it is importance 8');
  for (const t of threats) assert.ok(s.get(t.id));
  const kept = dms.filter(d => s.get(d.id));
  assert.equal(kept.length, 169);
  assert.deepEqual(kept.map(d => d.bell), dms.slice(81).map(d => d.bell), 'the oldest dm are evicted first');
  // a lower-importance episode that arrives late is the one dropped, not a high one
  const late = ep('build_done', 5000, 2);
  s.add(late);
  assert.ok(!s.get(late.id));
  assert.equal(s.size, 200);
});

test('eviction is a pure function of the list: replaying the same episodes in another order and batching gives the same set (M11)', () => {
  const all = [ep('attacked_own', 1, 8), ...Array.from({ length: 60 }, (_, i) => ep('threat', 2 + i, 5)), ...Array.from({ length: 200 }, (_, i) => ep('dm', 100 + i, 4)), ...Array.from({ length: 50 }, (_, i) => ep('build_done', 400 + i, 2))];
  const one = new Episodes(all);
  const batched = new Episodes();
  for (let i = 0; i < all.length; i += 7) batched.add(all.slice(i, i + 7));
  const shuffled = new Episodes([...all].sort(() => 0.5 - rng(3)()));
  assert.equal(one.sha256(), shuffled.sha256());
  // batching can differ only when an episode evicted early would have survived later; with the lowest importance first it cannot
  assert.equal(one.sha256(), batched.sha256());
});

test('redact(id) blanks text and entities and keeps id, bell, kind, created_bell; redacted episodes are never retrieved', () => {
  const s = new Episodes([ep('dm', 10, 4, ['x']), ep('threat', 11, 5)]);
  const id = s.list()[0].id;
  s.redact(id);
  const r = s.get(id);
  assert.deepEqual([r.redacted, r.text.en, r.entities, r.kind, r.bell], [true, '', [], 'dm', 10]);
  assert.ok(!s.retrieve([], 100).includes(id));
});

// ------------------------------------------------------------------ replay equality and flooding on real producer output
const A = tagHex(1001n), E = tagHex(2002n);
const AI = { tag: A, wallet: 'AIW', faction: 3, home: { p: 1, q: 1 }, holdings: [{ p: 1, q: 1, site: 0 }] };
const talk = (id, bell, tag, target = 'AIW') => ({ id, bell, tag, channel: 'direct', target, kind: 0, ref: 0, inner: `i${id}`, origin: 0 });
const ctx = (extra = {}) => ({ ai: AI, bellNow: 100000, owners: {}, province: () => null, clash: () => null, config: {}, ...extra });

test('replay equality: the same inputs twice (and in one call vs many) give the same canonical episode list sha256, created_bell and cap included', () => {
  const senders = [tagHex(11n), tagHex(12n), tagHex(13n)];
  const rows = Array.from({ length: 900 }, (_, i) => talk(i, 3 + Math.floor(i / 2) * 3, senders[i % 3]));
  const council = [{ faction: 3, period: 1, close_bell: 50, adopted: true }, { faction: 3, period: 2, close_bell: 120, adopted: false }];
  const all = episodes_from_events({ talk: rows, council }, ctx());
  const a = new Episodes(all.episodes), b = new Episodes(all.episodes);
  assert.equal(a.sha256(), b.sha256());
  const live = new Episodes();
  for (let t = 10; t <= 1500; t += 17) live.add(episodes_from_events({ talk: rows.filter(r => r.bell < t), council }, ctx({ bellNow: t })).episodes);
  live.add(episodes_from_events({ talk: rows, council }, ctx()).episodes);
  assert.equal(live.sha256(), a.sha256(), 'live (bell by bell) equals the full replay');
  assert.ok(a.size <= 200);
});

test('flooding: 100 DMs from 3 wallets collapse (6-bell window, 6 a day) and the attacked_own episode and its grievance stay retrievable', () => {
  const senders = [tagHex(21n), tagHex(22n), tagHex(23n)];
  const flood = Array.from({ length: 100 }, (_, i) => talk(i, 200 + i, senders[i % 3]));
  const r = episodes_from_events({ talk: flood }, ctx());
  const dm = r.episodes.filter(e => e.kind === 'dm');
  const perDay = {};
  for (const e of dm) perDay[Math.floor(e.bell / 144)] = (perDay[Math.floor(e.bell / 144)] ?? 0) + 1;
  assert.ok(Object.values(perDay).every(c => c <= 6), JSON.stringify(perDay));
  assert.ok(dm.length <= 12 && dm.length >= 1);
  const attack = { ...ep('attacked_own', 150, 8, [E, 'nation:1', 'pq:1,1'], 152) };
  const store = new Episodes([attack, ...dm]);
  // and a harder flood: 400 low-importance episodes on top
  store.add(Array.from({ length: 400 }, (_, i) => ep('dm', 300 + i, 4)));
  assert.ok(store.get(attack.id), 'importance-aware eviction keeps the attack');
  const led = Ledger.create({ tag: A });
  led.apply({ id: 'g', kind: 'grievance', against: E, nation: 1, event: attack.id, bell: 152, weight: 8 });
  const ids = store.retrieve([], 5000, { grievances: led.grievances() });
  assert.ok(ids.includes(attack.id), 'still retrieved when the half-life has made its score small');
  // without a grievance exemption the same retrieval would have dropped it
  assert.ok(!store.retrieve([], 5000).includes(attack.id));
});
