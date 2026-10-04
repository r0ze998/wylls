// episodes_from_events (contract §5.2, §6.4): one test per episode kind, the hostile-act departure-bell rule and
// its collision case, deltas, idempotence. Records come from two sources and each test says which:
//   "recorded"  real files the herald served (test/fixtures/frontier/recorded: M1-era web recordings, REAL shapes),
//   "synthetic" hand-made in the real shapes (test/fixtures/ai-ac2-synth.mjs); AC6a's captured ai-herald-* fixtures
//               did not exist when AC2 was built (see AC2-NOTES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { tagHex } from '../citizens/persona/names.mjs';
import { clashFile, dec, fakeHerald, province, row } from './fixtures/ai-ac2-synth.mjs';

const REC = new URL('./fixtures/frontier/recorded/', import.meta.url);
const recorded = f => JSON.parse(readFileSync(new URL(f, REC), 'utf8'));

// --- the synthetic world: the AI is citizen A of nation 3 (Dunmar), home (1,1), site 0 on tile 20
const A = tagHex(1001n), E = tagHex(2002n), F = tagHex(3003n), M = tagHex(4004n);
const AI = { tag: A, wallet: 'AIWALLET', faction: 3, home: { p: 1, q: 1 }, holdings: [{ p: 1, q: 1, site: 0 }] };
const AH = '5000001', EH = '6000001', MH = '7000001';
const ownerMap = { [AH]: A, [EH]: E, [MH]: M };
const owners = { citizenOfHost: id => ownerMap[String(id)] ?? null, holdingsOf: t => (t === M ? [{ p: 1, q: 2, site: 0 }] : t === A ? AI.holdings : []) };
const ctxOf = (h, extra = {}) => ({ ai: AI, bellNow: 1000, owners, province: h.province, clash: h.clash, config: {}, ...extra });
const kinds = r => r.episodes.map(e => e.kind);

/** Enemy (nation 1) army EH departs at bell 100 and arrives at (1,1) tile 20 at bell 110, where the AI has its army AH (or village). */
function attackWorld({ ownPresentAtDepart = true, ownLost = 100, village = false, enemyLost = 50 } = {}) {
  const sites = [20];
  const atDepart = province({
    p: 1, q: 1, sites,
    mirror: village ? [{ state: 1, faction: 3, garrison: 300 * 1000 }] : undefined,
    entries: !village && ownPresentAtDepart ? [{ id: AH, faction: 3, tile: 20, troops: 500 }] : [],
  });
  const before = province({
    p: 1, q: 1, sites,
    mirror: village ? [{ state: 1, faction: 3, garrison: 300 * 1000 }] : undefined,
    entries: village ? [] : [{ id: AH, faction: 3, tile: 20, troops: 500 }],
  });
  const after = province({
    p: 1, q: 1, sites,
    mirror: village ? [{ state: 1, faction: 3, garrison: (300 - ownLost) * 1000 }] : undefined,
    entries: village ? [] : [{ id: AH, faction: 3, tile: 20, troops: 500 - ownLost }],
  });
  const fighters = [
    { id: EH, arrival: true, post: 400 - enemyLost, engaged: true, fate: 'Stays', tile: 20 },
    ...(village ? [] : [{ id: AH, arrival: false, post: 500 - ownLost, engaged: true, fate: 'Stays', tile: 20 }]),
  ];
  const clash = clashFile({ p: 1, q: 1, bell: 110, fighters, before, arrivals: [{ id: EH, tag: dec(E), faction: 1, tile: 20, troops: 400 }] });
  const h = fakeHerald({ provinces: { '1,1,100': atDepart, '1,1,110': after, '1,1,109': before }, clashes: [clash] });
  const events = [
    row(10, 'sigD', 100, 'DEPART', { host_id: EH }, { origin_p: 3, origin_q: 1, origin_tile: 4, depart_bell: 100, arrive_bell: 110, dep_mass: 400 * 1000 }),
    row(20, 'sigR', 110, 'REVEAL', { p: 1, q: 1, arrive: 110, faction: 1, i: 0 }, { host_id: EH, tile: 20 }),
    row(30, 'sigC', 111, 'CLASH', { p: 1, q: 1, bell: 110 }, { engagements: 2 }),
  ];
  return { h, events };
}

test('synthetic: attacked_own on an own ARMY (importance 8, trust -15, grievance 8, created_bell >= b+2)', () => {
  const { h, events } = attackWorld();
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r), ['attacked_own']);
  const [e] = r.episodes;
  assert.equal(e.bell, 110);
  assert.equal(e.created_bell, 112); // b + 2, the hostile-act evaluation bell
  assert.equal(e.importance, 8);
  assert.match(e.text.en, /^At bell 110 \S+ \(nation Borealis\) attacked your army at \(1,1\); you lost 100 troops\.$/);
  // the sanitiser's NFKC step turns the fullwidth parentheses of the templates into ASCII ones
  assert.match(e.text.ja, /^鐘110で、.+\(ボレアリス\)があなたの軍を\(1,1\)で攻撃し、あなたは兵100を失った。$/);
  assert.deepEqual(e.entities, [E, 'nation:1', 'pq:1,1'].sort());
  assert.equal(e.facts.lost, 100);
  const trust = r.deltas.find(d => d.kind === 'trust');
  assert.deepEqual([trust.who, trust.amount, trust.part, trust.episode], [E, -15, 'code', e.id]);
  const g = r.deltas.find(d => d.kind === 'grievance');
  assert.deepEqual([g.against, g.event, g.weight, g.nation], [E, e.id, 8, 1]);
  assert.deepEqual(r.collisions, []);
});

test('synthetic: attacked_own on an own VILLAGE (garrison loss from the consecutive province files)', () => {
  const { h, events } = attackWorld({ village: true, ownLost: 120 });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r), ['attacked_own']);
  assert.match(r.episodes[0].text.en, /attacked your village at \(1,1\); you lost 120 troops\.$/);
  assert.equal(r.episodes[0].facts.target, 'village');
});

test('synthetic: a hostile act without own losses changes nothing (no episode, no delta)', () => {
  const { h, events } = attackWorld({ ownLost: 0 });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(r.episodes.filter(e => e.kind === 'attacked_own'), []);
  assert.deepEqual(r.deltas, []);
});

test('synthetic: the staging case — the AI army moved onto the target AFTER the attacker departed: a collision, no episode, no trust, no grievance', () => {
  const { h, events } = attackWorld({ ownPresentAtDepart: false });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(r.episodes.filter(e => e.kind === 'attacked_own'), []);
  assert.deepEqual(r.deltas, []);
  assert.equal(r.collisions.length, 1);
  assert.deepEqual([r.collisions[0].p, r.collisions[0].q, r.collisions[0].bell], [1, 1, 110]);
});

test('synthetic: the departure-bell rule reads the province file of the DEPARTURE bell (state A could see), not the clash bell', () => {
  const { h, events } = attackWorld();
  // the same data, but the AI army is absent in the file of bell 100 and present in every other file: collision
  const h2 = fakeHerald({ provinces: { '1,1,100': province({ p: 1, q: 1, sites: [20] }), '1,1,109': h.province(1, 1, 109), '1,1,110': h.province(1, 1, 110) }, clashes: [h.clash(1, 1, 110)] });
  const r = episodes_from_events({ events }, ctxOf(h2));
  assert.equal(r.collisions.length, 1);
  assert.deepEqual(kinds(r), []);
});

test('synthetic: the attacker\'s army must be listed engaged:true in the clash report', () => {
  const { h, events } = attackWorld();
  const c = h.clash(1, 1, 110);
  c.decoded.fighters.find(f => f.id === EH).engaged = false;
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r), []);
});

test('synthetic: an unresolved or missing record is counted unknown, never guessed', () => {
  const { h, events } = attackWorld();
  const noDepart = episodes_from_events({ events: events.filter(e => e.decoded.name !== 'DEPART') }, ctxOf(h));
  assert.deepEqual(kinds(noDepart), []);
  assert.ok(noDepart.unknown.some(u => u.what === 'depart_missing'));
  const noClash = episodes_from_events({ events }, ctxOf({ province: h.province, clash: () => null }));
  assert.ok(noClash.unknown.some(u => u.what === 'clash_missing'));
});

test('synthetic: not before b + 2 and not before the rows are public (created_bell < bellNow)', () => {
  const { h, events } = attackWorld();
  assert.deepEqual(kinds(episodes_from_events({ events }, ctxOf(h, { bellNow: 112 }))), []); // created_bell 112 is not < 112
  assert.deepEqual(kinds(episodes_from_events({ events }, ctxOf(h, { bellNow: 113 }))), ['attacked_own']);
});

test('synthetic: rows later than b + 14 are ignored (a late row cannot make a replay differ from the live run)', () => {
  const { h, events } = attackWorld();
  const late = events.map(e => (e.decoded.name === 'CLASH' ? { ...e, bell: 130, decoded: { ...e.decoded, bell: 130 } } : e));
  const r = episodes_from_events({ events: late }, ctxOf(h));
  assert.deepEqual(kinds(r), []);
});

test('synthetic: nation-mate trust -5 to the actor when a nation-mate with a village within 2 provinces is hit', () => {
  // M (nation 3, a nation-mate, village at (1,2) site 0, tile 8) loses 60 troops to E's army; the AI is not involved
  const sites = [8];
  const mirror = [{ state: 1, faction: 3, garrison: 200 * 1000 }];
  const atD = province({ p: 1, q: 2, sites, mirror }), after = province({ p: 1, q: 2, sites, mirror: [{ state: 1, faction: 3, garrison: 140 * 1000 }] });
  const clash = clashFile({ p: 1, q: 2, bell: 110, fighters: [{ id: EH, arrival: true, post: 350, engaged: true, fate: 'Stays', tile: 8 }], before: atD, arrivals: [{ id: EH, tag: dec(E), faction: 1, tile: 8, troops: 400 }] });
  const h = fakeHerald({ provinces: { '1,2,100': atD, '1,2,110': after }, clashes: [clash] });
  const events = [
    row(10, 'sigD', 100, 'DEPART', { host_id: EH }, { origin_p: 3, origin_q: 1, origin_tile: 4, depart_bell: 100, arrive_bell: 110, dep_mass: 400000 }),
    row(20, 'sigR', 110, 'REVEAL', { p: 1, q: 2, arrive: 110, faction: 1, i: 0 }, { host_id: EH, tile: 8 }),
    row(30, 'sigC', 111, 'CLASH', { p: 1, q: 2, bell: 110 }, { engagements: 1 }),
  ];
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(r.episodes, []); // nothing happened to the AI itself
  assert.equal(r.deltas.length, 1);
  assert.deepEqual([r.deltas[0].who, r.deltas[0].amount, r.deltas[0].reason], [E, -5, 'nation_mate']);
  // a nation-mate far from the AI's home (> 2 provinces) changes nothing
  const far = episodes_from_events({ events }, ctxOf(h, { ai: { ...AI, home: { p: 9, q: 9 } }, owners: { citizenOfHost: owners.citizenOfHost, holdingsOf: () => [] } }));
  assert.deepEqual(far.deltas, []);
});

// ---------------------------------------------------------------------------------------------- own marches
/** The AI's army AH marches from (1,1) at bell 200 and arrives at (2,1) tile 30 at bell 210. */
function marchWorld({ target = 'stack', ownLost, enemyLost, cleared = false, campTroops = 200, destroyed = false }) {
  const sites = [4];
  const before = province({ p: 2, q: 1, sites, entries: target === 'stack' ? [{ id: EH, faction: 1, tile: 30, troops: 300 }] : [], camp: target === 'camp' ? { tile: 30, troops: campTroops } : null });
  const after = province({
    p: 2, q: 1, sites,
    entries: [{ id: AH, faction: 3, tile: 30, troops: 600 - ownLost }, ...(target === 'stack' ? [{ id: EH, faction: 1, tile: 30, troops: 300 - enemyLost }] : [])],
    camp: target === 'camp' ? (cleared ? { tile: 30, state: 0, troops: 0 } : { tile: 30, troops: campTroops - enemyLost }) : null,
  });
  const fighters = [{ id: AH, arrival: true, post: 600 - ownLost, engaged: true, fate: 'Stays', tile: 30 }, ...(target === 'stack' ? [{ id: EH, arrival: false, post: 300 - enemyLost, engaged: true, fate: destroyed ? 'Destroyed' : 'Stays', tile: 30 }] : [])];
  const clash = clashFile({ p: 2, q: 1, bell: 210, fighters, before, arrivals: [{ id: AH, tag: dec(A), faction: 3, tile: 30, troops: 600 }] });
  const h = fakeHerald({ provinces: { '2,1,209': before, '2,1,210': after }, clashes: [clash] });
  const events = [row(40, 'sigC2', 211, 'CLASH', { p: 2, q: 1, bell: 210 }, { engagements: 2 })];
  if (cleared) events.push(row(39, 'sigC2', 211, 'CAMP', { p: 2, q: 1 }, { tile: 30, troops: 0, day: 1 }));
  return { h, events };
}

test('synthetic: clash_own_win — an own march fought and the enemy stack was DESTROYED (importance 6; R12: a win is a clearing, not a lead in losses)', () => {
  const { h, events } = marchWorld({ ownLost: 40, enemyLost: 300, destroyed: true });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r), ['clash_own_win']);
  const e = r.episodes[0];
  assert.equal(e.importance, 6);
  assert.equal(e.created_bell, 211);
  assert.match(e.text.en, /^At bell 210 your army at \(2,1\) beat \S+ \(nation Borealis\): you lost 40, they lost 300\.$/);
  assert.match(e.text.ja, /^鐘210で、あなたの軍は\(2,1\)で.+に勝った。あなたは兵40、相手は兵300を失った。$/);
  assert.deepEqual([e.facts.lost_own, e.facts.lost_enemy, e.facts.nation, e.facts.cleared], [40, 300, 1, 'stack']);
});

// FB5 / R12: this is the case the old code called a win (y > x). The enemy lost more, but its stack stayed on the field.
test('synthetic: R12 — the enemy lost more than we did but its stack held: clash_own_fought, never clash_own_win', () => {
  const { h, events } = marchWorld({ ownLost: 40, enemyLost: 120 });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r), ['clash_own_fought']);
  const e = r.episodes[0];
  assert.equal(e.importance, 6);
  assert.match(e.text.en, /^At bell 210 your army at \(2,1\) fought \S+ \(nation Borealis\): you lost 40, they lost 120; nothing was cleared\.$/);
  assert.match(e.text.ja, /^鐘210で、あなたの軍は\(2,1\)で.+と戦った。あなたは兵40、相手は兵120を失ったが、倒しきれなかった。$/);
  assert.ok(!/beat|勝った/.test(e.text.en + e.text.ja), 'no victory word in a clash that cleared nothing');
  assert.deepEqual([e.facts.lost_own, e.facts.lost_enemy, e.facts.cleared], [40, 120, null]);
  // boundary: one troop short of destroying the stack is still "fought"
  const t = marchWorld({ ownLost: 40, enemyLost: 299 });
  assert.deepEqual(kinds(episodes_from_events({ events: t.events }, ctxOf(t.h))), ['clash_own_fought']);
  // and the same clash with the stack destroyed is the win
  const u = marchWorld({ ownLost: 40, enemyLost: 300, destroyed: true });
  assert.deepEqual(kinds(episodes_from_events({ events: u.events }, ctxOf(u.h))), ['clash_own_win']);
});

test('synthetic: R12 migration — config.clash_win_rule "legacy_v1" replays a pre-R12 list (a win when the enemy lost more, no facts.cleared); the default is the new rule', () => {
  const { h, events } = marchWorld({ ownLost: 40, enemyLost: 120 });
  const legacy = episodes_from_events({ events }, ctxOf(h, { config: { clash_win_rule: 'legacy_v1' } }));
  assert.deepEqual(kinds(legacy), ['clash_own_win']);
  assert.ok(!('cleared' in legacy.episodes[0].facts), 'the pre-R12 lists have no `cleared` fact: the replay must not add one');
  assert.match(legacy.episodes[0].text.en, /beat/);
  const now = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(now), ['clash_own_fought']);
  assert.notEqual(legacy.episodes[0].id, now.episodes[0].id, 'the kind is in the id: the two lists share no id for this clash');
  // equal or worse losses: the legacy rule's loss is the same as today's
  const lost = marchWorld({ ownLost: 200, enemyLost: 80 });
  assert.deepEqual(kinds(episodes_from_events({ events: lost.events }, ctxOf(lost.h, { config: { clash_win_rule: 'legacy_v1' } }))), ['clash_own_loss']);
});

test('synthetic: clash_own_loss — own lost >= enemy lost and own lost > 0 (importance 6)', () => {
  const { h, events } = marchWorld({ ownLost: 200, enemyLost: 80 });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r), ['clash_own_loss']);
  assert.match(r.episodes[0].text.en, /^At bell 210 your army at \(2,1\) lost 200 troops against .+; they lost 80\.$/);
  assert.match(r.episodes[0].text.ja, /^鐘210で、あなたの軍は\(2,1\)で.+と戦い、兵200を失った。相手は兵80を失った。$/);
  // equal losses count as a loss as well (own lost >= enemy lost)
  const t = marchWorld({ ownLost: 70, enemyLost: 70 });
  assert.deepEqual(kinds(episodes_from_events({ events: t.events }, ctxOf(t.h))), ['clash_own_loss']);
});

test('synthetic: nothing lost on either side makes no clash_own episode', () => {
  const { h, events } = marchWorld({ ownLost: 0, enemyLost: 0 });
  assert.deepEqual(kinds(episodes_from_events({ events }, ctxOf(h))), []);
});

test('synthetic: camp_cleared_own — a camp cleared in a clash in which an own army fought (importance 5), plus the own win against the camp', () => {
  const { h, events } = marchWorld({ target: 'camp', ownLost: 30, enemyLost: 200, cleared: true, campTroops: 200 });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r).sort(), ['camp_cleared_own', 'clash_own_win']);
  const c = r.episodes.find(e => e.kind === 'camp_cleared_own');
  assert.equal(c.importance, 5);
  assert.equal(c.text.en, 'At bell 210 your army cleared the camp at (2,1).');
  assert.equal(c.text.ja, '鐘210で、あなたの軍が(2,1)の野営地を倒した。');
  const w = r.episodes.find(e => e.kind === 'clash_own_win');
  assert.match(w.text.en, /beat the camp: you lost 30, they lost 200\.$/);
});

test('synthetic: an own army that did not clear the camp makes only a clash episode, and the camp "held" (R12: fewer troops lost than the camp is not a win)', () => {
  const { h, events } = marchWorld({ target: 'camp', ownLost: 20, enemyLost: 40, cleared: false });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r), ['clash_own_fought']);
  assert.equal(r.episodes[0].text.en, 'At bell 210 your army at (2,1) fought the camp: you lost 20, they lost 40; the camp held.');
  assert.equal(r.episodes[0].text.ja, '鐘210で、あなたの軍は(2,1)で野営地と戦った。あなたは兵20、相手は兵40を失ったが、野営地は残った。');
  assert.equal(r.episodes[0].facts.camp, true);
  assert.ok(!r.episodes.some(e => e.kind === 'camp_cleared_own'), 'a camp that held is not a cleared camp');
});

test('synthetic: a cleared camp is the win whatever the losses (no more "loss" for a cleared camp that cost more than it held)', () => {
  const { h, events } = marchWorld({ target: 'camp', ownLost: 300, enemyLost: 200, cleared: true, campTroops: 200 });
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r).sort(), ['camp_cleared_own', 'clash_own_win']);
  assert.equal(r.episodes.find(e => e.kind === 'clash_own_win').facts.cleared, 'camp');
});

test('synthetic: camp_taken_by — a camp inside the AI\'s observed provinces cleared by nation X in a clash with no own army (importance 5)', () => {
  const sites = [4];
  const before = province({ p: 1, q: 2, sites, camp: { tile: 15, troops: 150 } });
  const after = province({ p: 1, q: 2, sites, camp: { tile: 15, state: 0, troops: 0 } });
  const clash = clashFile({ p: 1, q: 2, bell: 300, fighters: [{ id: EH, arrival: true, post: 250, engaged: true, fate: 'Stays', tile: 15 }], before, arrivals: [{ id: EH, tag: dec(E), faction: 1, tile: 15, troops: 280 }] });
  const h = fakeHerald({ provinces: { '1,2,299': before, '1,2,300': after }, clashes: [clash] });
  const events = [row(41, 'sigX', 301, 'CAMP', { p: 1, q: 2 }, { tile: 15, troops: 0, day: 2 }), row(42, 'sigX', 301, 'CLASH', { p: 1, q: 2, bell: 300 }, { engagements: 1 })];
  const r = episodes_from_events({ events }, ctxOf(h));
  assert.deepEqual(kinds(r), ['camp_taken_by']);
  assert.equal(r.episodes[0].text.en, 'At bell 300 nation Borealis cleared the camp at (1,2) first.');
  assert.equal(r.episodes[0].text.ja, '鐘300で、ボレアリスがあなたより先に、(1,2)の野営地を倒した。');
  assert.deepEqual(r.episodes[0].entities, ['nation:1', 'pq:1,2']);
  assert.equal(r.episodes[0].importance, 5);
  // outside the observed provinces: no episode
  const far = episodes_from_events({ events }, ctxOf(h, { ai: { ...AI, holdings: [{ p: 8, q: 8, site: 0 }], home: { p: 8, q: 8 } } }));
  assert.deepEqual(kinds(far), []);
});

// ---------------------------------------------------------------------------------------------- recorded rows
test('recorded: threat — a real DEPART row from another nation within 3 provinces of the AI home (importance 5, destination not in the text)', () => {
  const ev = recorded('events-0.json').events.filter(r => r.decoded.name === 'DEPART');
  assert.equal(ev.length, 1);
  const real = ev[0]; // host 158333969367041 leaves (0,2) at bell 8 for bell 10 with dep_mass 100000 (= 100 troops)
  const prov = normFile('province-0,2-10.json'); // the recorded province file stands in for bells 7..10 (its Site mirror holds nation 1)
  const ctx = { ai: { tag: A, wallet: 'W', faction: 3, home: { p: 1, q: 1 }, holdings: [{ p: 1, q: 1, site: 0 }] }, bellNow: 100, owners: { citizenOfHost: () => null }, province: () => prov, clash: () => null, config: {} };
  const r = episodes_from_events({ events: [real] }, ctx);
  assert.deepEqual(kinds(r), ['threat']);
  const e = r.episodes[0];
  assert.equal(e.text.en, 'At bell 8 nation Borealis sent an army of 100 troops from (0,2); it arrives at bell 10; its destination is not known.');
  assert.equal(e.text.ja, '鐘8で、ボレアリスが(0,2)から兵100の軍を出した。到着は鐘10。行き先は不明。');
  assert.deepEqual([e.bell, e.created_bell, e.importance], [8, 8, 5]);
  assert.deepEqual(e.entities, ['nation:1', 'pq:0,2']);
  assert.deepEqual(e.facts, { p: 0, q: 2, nation: 1, mass: 100, arrive_bell: 10 });
  // beyond 3 provinces from the home: no episode; the AI's own nation: no episode
  assert.deepEqual(kinds(episodes_from_events({ events: [real] }, { ...ctx, ai: { ...ctx.ai, home: { p: 5, q: 5 }, holdings: [] } })), []);
  assert.deepEqual(kinds(episodes_from_events({ events: [real] }, { ...ctx, ai: { ...ctx.ai, faction: 1 } })), []);
  // the boundary itself (the capture has no departure at exactly 4): the origin (0,2) is 3 provinces from (3,2) and 4 from (4,2)
  const at = (p, q) => ({ ...ctx, ai: { ...ctx.ai, home: { p, q }, holdings: [{ p, q, site: 0 }] } });
  assert.deepEqual(kinds(episodes_from_events({ events: [real] }, at(3, 2))), ['threat'], 'distance 3 is remembered');
  assert.deepEqual(kinds(episodes_from_events({ events: [real] }, at(4, 2))), [], 'distance 4 is not');
});

import { normProvince } from '../citizens/memory/herald-view.mjs';
const normFile = f => normProvince(recorded(f));

test('recorded: the real clash of bell 10 at (0,2) (an own army, a real camp, partial damage) gives clash_own_loss against the camp', () => {
  const clash = recorded('clash-0,2-10.json');
  const prov = normFile('province-0,2-10.json');
  const myTag = tagHex(BigInt('460685346920574999')); // the citizen_tag inside the real ClashInputs arrival record
  const ctx = {
    ai: { tag: myTag, wallet: 'W', faction: 1, home: { p: 0, q: 2 }, holdings: [{ p: 0, q: 2, site: 0 }] }, bellNow: 100,
    owners: { citizenOfHost: id => (String(id) === '158333969367041' ? myTag : null) }, province: () => prov, clash: () => clash, config: {},
  };
  const events = [row(900, 'sigCl', 11, 'CLASH', { p: 0, q: 2, bell: 10 }, { engagements: 1 })]; // synthetic row around the real clash file
  const r = episodes_from_events({ events }, ctx);
  assert.deepEqual(kinds(r), ['clash_own_loss']);
  // real numbers: the army entered with 100000 milli-troops and left with 53038 (46 lost); the camp (tile 15) fell from 394 to 376 (18 lost)
  assert.equal(r.episodes[0].text.en, 'At bell 10 your army at (0,2) lost 46 troops against the camp; they lost 18.');
  assert.equal(r.episodes[0].created_bell, 11);
});

test('recorded: build_done — a real BUILD row of an own holding becomes an episode at the bell its done_at falls in', () => {
  const ev = recorded('events-0.json').events;
  const build = ev.find(r => r.decoded.name === 'BUILD');
  const genesis = Number(ev.find(r => r.decoded.name === 'SEASON_CREATED').decoded.payload.genesis_ts);
  const ctx = { ai: { tag: A, wallet: 'W', faction: 1, home: { p: 0, q: 2 }, holdings: [{ p: 0, q: 2, site: 0 }] }, bellNow: 100, owners: {}, province: () => null, clash: () => null, config: { genesis_ts: genesis } };
  const r = episodes_from_events({ events: [build] }, ctx);
  assert.deepEqual(kinds(r), ['build_done']);
  assert.equal(r.episodes[0].bell, Math.floor((1785637760 - genesis) / 600)); // bell 12
  assert.equal(r.episodes[0].text.en, 'At bell 12 your farm was finished.');
  assert.equal(r.episodes[0].text.ja, '鐘12で、あなたの農場が完成した。');
  assert.equal(r.episodes[0].importance, 2);
  // not an own holding: nothing
  assert.deepEqual(kinds(episodes_from_events({ events: [build] }, { ...ctx, ai: { ...ctx.ai, holdings: [{ p: 9, q: 9, site: 0 }] } })), []);
  // not yet finished at bellNow 12: the episode is not produced (created_bell 12 is not < 12)
  assert.deepEqual(kinds(episodes_from_events({ events: [build] }, { ...ctx, bellNow: 12 })), []);
});

// ---------------------------------------------------------------------------------------------- talk and council
const talkRow = (id, bell, tag, channel, target, kind = 0, ref = 0, inner = `in${id}`) => ({ id, bell, tag, channel, target, kind, ref, inner, origin: 0 });
const quiet = { province: () => null, clash: () => null };

test('synthetic: dm — the first message of a sender in each 6-bell window, at most 6 a game day, no excerpt (importance 4)', () => {
  const talk = [talkRow(1, 100, E, 'direct', 'AIWALLET'), talkRow(2, 101, E, 'direct', 'AIWALLET'), talkRow(3, 105, E, 'direct', 'AIWALLET'), talkRow(4, 106, E, 'direct', 'AIWALLET'),
    talkRow(5, 100, F, 'direct', 'AIWALLET'), talkRow(6, 100, F, 'direct', 'OTHERWALLET'), talkRow(7, 100, E, 'world', 0), talkRow(8, 100, A, 'direct', 'AIWALLET')];
  const r = episodes_from_events({ talk }, ctxOf(quiet));
  const dm = r.episodes.filter(e => e.kind === 'dm');
  assert.deepEqual(dm.map(e => [e.bell, e.entities[0]]).sort(), [[100, E], [100, F], [105, E]].sort()); // E at 100 and 105 (windows 96..101 and 102..107), F at 100
  assert.match(dm[0].text.en, /^At bell \d+ \S+ sent you a message\.$/);
  assert.match(dm[0].text.ja, /^鐘\d+で、\S+があなたにメッセージを送った。$/);
  assert.equal(dm[0].importance, 4);
  assert.equal(dm[0].created_bell, dm[0].bell);
  // per game day cap 6
  const many = Array.from({ length: 20 }, (_, i) => talkRow(100 + i, 10 + i * 6, tagHex(BigInt(7000 + i)), 'direct', 'AIWALLET'));
  const dms = episodes_from_events({ talk: many }, ctxOf(quiet)).episodes.filter(x => x.kind === 'dm');
  const perDay = new Map();
  for (const e of dms) perDay.set(Math.floor(e.bell / 144), (perDay.get(Math.floor(e.bell / 144)) ?? 0) + 1);
  assert.deepEqual([...perDay.entries()].sort((a, b) => a[0] - b[0]), [[0, 6]]); // bells 10..124 are all game day 0: 20 senders, 6 episodes
});

test('synthetic: dm of a redacted record keeps id, bell, kind, created_bell and blanks text and entities (§6.3)', () => {
  const talk = [talkRow(1, 100, E, 'direct', 'AIWALLET', 0, 0, 'REDACTED')];
  const r = episodes_from_events({ talk }, ctxOf(quiet, { config: { redactions: new Set(['REDACTED']) } }));
  const [e] = r.episodes;
  assert.equal(e.redacted, true);
  assert.deepEqual([e.text.en, e.text.ja, e.entities, e.src], ['', '', [], ['talk:REDACTED']]);
  assert.equal(e.kind, 'dm');
});

test('synthetic: motion — a motion in the AI\'s nation council, own or another\'s, with the option kind (importance 4)', () => {
  const council = [{ faction: 3, period: 2, options: [{ option: 1, kind: 'camp' }, { option: 2, kind: 'strike' }, { option: 3, kind: 'raid' }] }];
  const talk = [talkRow(1, 200, E, 'nation', 3, 1, (2 << 8) | 2), talkRow(2, 201, A, 'nation', 3, 1, (2 << 8) | 1), talkRow(3, 202, E, 'nation', 4, 1, (2 << 8) | 1), talkRow(4, 203, E, 'nation', 3, 0, 0)];
  const r = episodes_from_events({ talk, council }, ctxOf(quiet));
  const m = r.episodes.filter(e => e.kind === 'motion');
  assert.equal(m.length, 2); // another nation's council and a plain `say` do not count
  assert.match(m.find(e => e.bell === 200).text.en, /^At bell 200 \S+ moved option 2 \(strike\) in your nation's council\.$/);
  assert.match(m.find(e => e.bell === 201).text.en, /moved option 1 \(camp\)/);
  assert.match(m.find(e => e.bell === 200).text.ja, /^鐘200で、\S+があなたの国の評議会で案2\(攻撃\)を提案した。$/);
  assert.equal(m[0].importance, 4);
});

test('integ-B: a motion\'s option kind is read from the options of its period as they were at the opening, not from a closed council file: the live producer (council still open) and a replay from the final files (council closed) give the same episode', () => {
  const opts = [{ faction: 3, period: 2, options: [{ option: 1, kind: 'camp' }, { option: 2, kind: 'strike' }] }];
  const talk = [talkRow(1, 200, E, 'nation', 3, 1, (2 << 8) | 2)];
  const live = episodes_from_events({ talk, council: [], council_options: opts }, ctxOf(quiet)); // the period is still open: no closed file yet
  const closed = [{ faction: 3, period: 2, close_bell: 204, adopted: false, options: opts[0].options }];
  const replay = episodes_from_events({ talk, council: closed, council_options: opts }, ctxOf(quiet));
  const a = live.episodes.find(e => e.kind === 'motion'), b = replay.episodes.find(e => e.kind === 'motion');
  assert.match(a.text.en, /moved option 2 \(strike\)/);
  assert.deepEqual(a, b, 'identical episode, id and text');
  // without council_options the producer still reads the closed files (the earlier behaviour)
  assert.match(episodes_from_events({ talk, council: closed }, ctxOf(quiet)).episodes.find(e => e.kind === 'motion').text.en, /\(strike\)/);
});

test('synthetic: council_result — adopted or nothing; the text carries NO option, ballot count or target (importance 4)', () => {
  const council = [
    { faction: 3, period: 4, close_bell: 300, adopted: true, strike_bell: 306, options: [{ option: 1, kind: 'camp', p: 7, q: 8 }], tally: { 1: 5, 2: 1 }, ballots: [{ wallet: 'x', option: 1 }] },
    { faction: 3, period: 5, close_bell: 372, adopted: false },
    { faction: 2, period: 4, close_bell: 300, adopted: true },
  ];
  const r = episodes_from_events({ council }, ctxOf(quiet));
  const cr = r.episodes.filter(e => e.kind === 'council_result');
  assert.equal(cr.length, 2);
  assert.equal(cr[0].text.en, 'At bell 300 your nation\'s council adopted a Strike Order (its target stays sealed until the strike).');
  assert.equal(cr[0].text.ja, '鐘300で、あなたの国の評議会が攻撃命令を採用した(行き先は、攻撃の時まで秘密)。');
  assert.equal(cr[1].text.en, 'At bell 372 your nation\'s council adopted nothing.');
  for (const e of cr) {
    assert.equal(e.importance, 4);
    assert.deepEqual(e.entities, ['nation:3']);
    assert.ok(!JSON.stringify(e).includes('"p":7') && !/\b7\b.*\b8\b/.test(e.text.en));
  }
});

test('synthetic: strike — the Strike Order opened at S + 2 (importance 6); result and whether an own army took part; mover trust +2', () => {
  const sites = [4];
  const before = province({ p: 4, q: 0, sites, entries: [{ id: EH, faction: 1, tile: 12, troops: 500 }] });
  const after = province({ p: 4, q: 0, sites, entries: [{ id: AH, faction: 3, tile: 12, troops: 570 }, { id: EH, faction: 1, tile: 12, troops: 330 }] });
  const mine = { id: AH, arrival: true, post: 570, engaged: true, fate: 'Stays', tile: 12 };
  const theirs = { id: EH, arrival: false, post: 330, engaged: true, fate: 'Stays', tile: 12 };
  const mateHost = '8000001';
  const mate = { id: mateHost, arrival: true, post: 270, engaged: true, fate: 'Stays', tile: 12 };
  const clash = clashFile({ p: 4, q: 0, bell: 306, fighters: [mine, theirs, mate], before, arrivals: [{ id: AH, tag: dec(A), faction: 3, tile: 12, troops: 600 }, { id: mateHost, tag: dec(M), faction: 3, tile: 12, troops: 300 }] });
  const h = fakeHerald({ provinces: { '4,0,305': before, '4,0,306': after }, clashes: [clash] });
  const council = [{ faction: 3, period: 4, close_bell: 300, adopted: true, strike_bell: 306, open: { option: 2, p: 4, q: 0, tile: 12 } }];
  const talk = [talkRow(1, 290, M, 'nation', 3, 1, (4 << 8) | 2), talkRow(2, 291, F, 'nation', 3, 1, (4 << 8) | 3), talkRow(3, 292, A, 'nation', 3, 1, (4 << 8) | 2)];
  const events = [row(50, 'sigS', 307, 'CLASH', { p: 4, q: 0, bell: 306 }, { engagements: 3 })];
  const r = episodes_from_events({ events, council, talk }, ctxOf(h));
  const s = r.episodes.find(e => e.kind === 'strike');
  assert.ok(s);
  assert.equal(s.importance, 6);
  assert.equal(s.bell, 306);
  assert.equal(s.created_bell, 308); // S + 2
  assert.equal(s.text.en, 'At bell 306 your nation\'s Strike Order opened at (4,0); troops lost: yours 60, theirs 170; your army took part.');
  assert.equal(s.text.ja, '鐘306で、あなたの国の攻撃命令が(4,0)で開かれた。失った兵:あなた60、相手170。あなたの軍は参戦した。'); // NFKC: the fullwidth colon is ASCII
  // +2 toward the citizen who moved the adopted option (M, option 2); not toward F (option 3) nor the AI itself
  const movers = r.deltas.filter(d => d.reason === 'adopted_mover');
  assert.deepEqual(movers.map(d => [d.who, d.amount]), [[M, 2]]);
  // without an own army: "did not take part"
  // the same clash, but the army AH belongs to another citizen (the owner of an arrival comes from the public ClashInputs record)
  const clash2 = clashFile({ p: 4, q: 0, bell: 306, fighters: [mine, theirs, mate], before, arrivals: [{ id: AH, tag: dec(F), faction: 3, tile: 12, troops: 600 }, { id: mateHost, tag: dec(M), faction: 3, tile: 12, troops: 300 }] });
  const h2 = fakeHerald({ provinces: { '4,0,305': before, '4,0,306': after }, clashes: [clash2] });
  const noAi = episodes_from_events({ events, council, talk }, ctxOf(h2, { owners: { citizenOfHost: () => null } }));
  assert.match(noAi.episodes.find(e => e.kind === 'strike').text.en, /your army did not take part\.$/);
});

test('synthetic: a Strike Order that produced no clash is remembered only at S + 14 (the CLASH row could still arrive)', () => {
  const council = [{ faction: 3, period: 4, close_bell: 300, adopted: true, strike_bell: 306, open: { option: 2, p: 4, q: 0, tile: 12 } }];
  const early = episodes_from_events({ council }, ctxOf(quiet, { bellNow: 315 }));
  assert.deepEqual(early.episodes.filter(e => e.kind === 'strike'), []);
  const late = episodes_from_events({ council }, ctxOf(quiet, { bellNow: 321 }));
  const s = late.episodes.find(e => e.kind === 'strike');
  assert.equal(s.created_bell, 320);
  assert.match(s.text.en, /troops lost: yours 0, theirs 0; your army did not take part\.$/);
});

// ---------------------------------------------------------------------------------------------- answered grievances, idempotence
test('synthetic: an own march whose REVEAL destination is the wrongdoer\'s army at the departure bell answers the grievance (code-set)', () => {
  const sites = [4];
  const atD = province({ p: 3, q: 0, sites, entries: [{ id: EH, faction: 1, tile: 9, troops: 300 }] });
  const h = fakeHerald({ provinces: { '3,0,500': atD } });
  const events = [
    row(60, 'sigD2', 500, 'DEPART', { host_id: AH }, { origin_p: 1, origin_q: 1, origin_tile: 20, depart_bell: 500, arrive_bell: 504, dep_mass: 500000 }),
    row(61, 'sigR2', 504, 'REVEAL', { p: 3, q: 0, arrive: 504, faction: 3, i: 0 }, { host_id: AH, tile: 9 }),
  ];
  const og = [{ id: 'g1', against: E, nation: 1, bell: 480 }, { id: 'g2', against: F, nation: 4, bell: 480 }, { id: 'g3', against: E, nation: 1, bell: 600 }];
  const r = episodes_from_events({ events }, ctxOf(h, { config: { openGrievances: og }, owners: { citizenOfHost: id => (String(id) === AH ? A : String(id) === EH ? E : null), holdingsOf: () => [] } }));
  const ans = r.deltas.filter(d => d.kind === 'answered');
  assert.deepEqual(ans.map(d => d.grievance), ['g1']); // g2 names another citizen; g3 is later than the march
  assert.equal(ans[0].bell, 504);
});

test('synthetic: idempotent — the same batch twice, or a superset batch, gives the same ids; deltas the same ids', () => {
  const w = attackWorld();
  const a = episodes_from_events({ events: w.events }, ctxOf(w.h));
  const b = episodes_from_events({ events: w.events }, ctxOf(w.h));
  assert.deepEqual(a, b);
  const extra = [...w.events, row(99, 'sigZ', 111, 'BUILD', { p: 9, q: 9, site: 0 }, { item: 0, done_at: 5 })];
  const c = episodes_from_events({ events: extra }, ctxOf(w.h, { config: { genesis_ts: 0 } }));
  assert.deepEqual(c.episodes.map(e => e.id), a.episodes.map(e => e.id));
  assert.deepEqual(c.deltas.map(d => d.id), a.deltas.map(d => d.id));
});

test('synthetic: the episode id is sha256("wylls-ai-episode/v1" ‖ tag ‖ kind ‖ u32 bell ‖ u32 created_bell ‖ canonical(src))[0..8]', async () => {
  const { episodeId } = await import('../citizens/memory/episodes.mjs');
  const { createHash } = await import('node:crypto');
  const w = attackWorld();
  const e = episodes_from_events({ events: w.events }, ctxOf(w.h)).episodes[0];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const want = createHash('sha256').update('wylls-ai-episode/v1').update(A).update('attacked_own').update(u32(e.bell)).update(u32(e.created_bell)).update(JSON.stringify([...e.src].sort())).digest('hex').slice(0, 16);
  assert.equal(e.id, want);
  assert.equal(episodeId(A, 'attacked_own', e.bell, e.created_bell, e.src), want);
  assert.match(e.id, /^[0-9a-f]{16}$/);
});
