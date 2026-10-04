// episodes_from_events on REAL herald files: the shapes AC6a captured from the paused m1-exit herald (a local test chain with
// M1 rule bots; no devnet, no humans), cut into test/fixtures/ai-ac2-captured/ (provenance: extract.mjs there).
//   verbatim herald JSON      events.json (raw /h/events rows), clash-*.json, province-*.json
//   derived from them by AC6a owners.mjs / feed.mjs   owners.json, feed-shapes.json
// Two paths must give the SAME episodes and deltas: (a) the raw files decoded by memory/herald-view.mjs, and (b) the
// objects watcher/feed.mjs (AC6a) hands over (normalised events, shaped province, clash and clashDetail).
// Which AI is which: the roles come from the case list of ai-herald-meta.json (the attacker and defender wallets of the capture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { Episodes } from '../citizens/memory/store.mjs';
import { nameOf } from '../citizens/persona/names.mjs';
import { sanitize } from '../citizens/mind/sanitize.mjs';
import { safeText } from '../citizens/memory/safe.mjs';

const DIR = new URL('./fixtures/ai-ac2-captured/', import.meta.url);
const J = f => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
const owners = J('owners.json');
const rawEvents = J('events.json').events;
const shapes = J('feed-shapes.json');

const DEFENDER = 'a51ff0cd7d92f5b6'; // nation 0, village (1,4) site 6
const ATTACKER = '9b458f555eaabcbf'; // nation 1
const CAMP_SINGLE = '4440ab2ada19fc33'; // nation 4 clears the camp at (1,-3) bell 43 alone
const RACE_0 = 'b4259bfc0fdc5239', RACE_1 = '477c74dbb1e02965'; // two armies of different nations on the camp tile of (1,4) at bell 304
const BYSTANDER_MATE = '46773bc19067b9ee', MATE_2 = 'dc8e36181e9f8b51'; // nation 0, villages in (1,4)

const ownerTable = {
  citizenOfHost: id => owners.host_owner[String(id)] ?? null,
  factionOfHost: id => owners.host_faction[String(id)] ?? null,
  holdingsOf: tag => owners.citizens[tag]?.holdings ?? [],
};
const aiOf = tag => ({ tag, wallet: `W${tag}`, faction: owners.citizens[tag].faction, home: owners.citizens[tag].home, holdings: owners.citizens[tag].holdings });
const fileOr = f => (existsSync(new URL(f, DIR)) ? J(f) : null);

function rawCtx(tag) {
  return { ai: aiOf(tag), bellNow: 100000, owners: ownerTable, province: (p, q, b) => fileOr(`province-${p},${q}-${b}.json`), clash: (p, q, b) => fileOr(`clash-${p},${q}-${b}.json`), config: { genesis_ts: owners.genesis_ts } };
}
function feedCtx(tag) {
  return { ai: aiOf(tag), bellNow: 100000, owners: ownerTable, province: (p, q, b) => shapes.province[`${p},${q},${b}`] ?? null, clash: (p, q, b) => shapes.clash[`${p},${q},${b}`] ?? null, clashDetail: (p, q, b) => shapes.clashDetail[`${p},${q},${b}`] ?? null, config: { genesis_ts: owners.genesis_ts } };
}
const viaRaw = tag => episodes_from_events({ events: rawEvents }, rawCtx(tag));
const viaFeed = tag => episodes_from_events({ events: shapes.events }, feedCtx(tag));
const nonThreat = r => r.episodes.filter(e => e.kind !== 'threat' && e.kind !== 'build_done');

test('recorded: the fixture is what the extract script says (24 raw rows, 8 citizens, 4 clash files)', () => {
  assert.equal(rawEvents.length, 24);
  assert.equal(shapes.events.length, 24);
  assert.ok(rawEvents.every(r => r.decoded && r.body_b64), 'verbatim /h/events rows');
  assert.equal(Object.keys(owners.citizens).length, 8);
});

test('recorded: the defender\'s village is attacked at bell 387 — attacked_own with the real garrison loss, a grievance against the attacker, trust -15 (importance 8, created at b + 2)', () => {
  const r = viaRaw(DEFENDER);
  const e = r.episodes.find(x => x.kind === 'attacked_own');
  assert.ok(e, JSON.stringify(r.unknown.slice(0, 3)));
  assert.deepEqual([e.bell, e.created_bell, e.importance], [387, 389, 8]);
  assert.equal(e.text.en, `At bell 387 ${nameOf(ATTACKER).en} (nation Borealis) attacked your village at (1,4); you lost 130 troops.`);
  assert.equal(e.text.ja, `鐘387で、${nameOf(ATTACKER).ja}(ボレアリス)があなたの村を(1,4)で攻撃し、あなたは兵130を失った。`);
  assert.deepEqual(e.entities, [ATTACKER, 'nation:1', 'pq:1,4'].sort());
  const trust = r.deltas.find(d => d.reason === 'hostile_act');
  assert.deepEqual([trust.who, trust.amount], [ATTACKER, -15]);
  const g = r.deltas.find(d => d.kind === 'grievance');
  assert.deepEqual([g.against, g.event, g.weight, g.nation, g.bell], [ATTACKER, e.id, 8, 1, 387]);
  assert.deepEqual(r.collisions, []);
});

test('recorded: the defender also remembers threats (a real DEPART of a Borealis army within 3 provinces) and the camp Borealis cleared first', () => {
  const r = viaRaw(DEFENDER);
  const t = r.episodes.find(e => e.kind === 'threat' && e.bell === 383);
  assert.equal(t.text.en, 'At bell 383 nation Borealis sent an army of 500 troops from (0,4); it arrives at bell 387; its destination is not known.');
  assert.equal(t.facts.arrive_bell, 387);
  assert.ok(!/\(1,4\)/.test(t.text.en), 'the destination is not in the episode');
  const c = r.episodes.find(e => e.kind === 'camp_taken_by');
  assert.deepEqual([c.bell, c.created_bell, c.text.en], [304, 306, 'At bell 304 nation Borealis cleared the camp at (1,4) first.']);
  // the attack at bell 388 on a nation-mate's village in the same province costs the actor -5 with the defender (a nation-mate rule delta)
  assert.ok(r.deltas.some(d => d.reason === 'nation_mate' && d.who === ATTACKER && d.amount === -5));
});

test('recorded: the attacker\'s own marches at (1,4): "fought" at bell 387 and a loss at bell 388, with real losses on both sides (R12: the enemy lost more at 387 but nothing was cleared, so it is no win)', () => {
  const r = viaRaw(ATTACKER);
  assert.ok(!r.episodes.some(e => e.kind === 'clash_own_win' && e.bell === 387), 'the old code called this a win (lost_enemy 130 > lost_own 103)');
  const fought = r.episodes.find(e => e.kind === 'clash_own_fought' && e.bell === 387);
  assert.match(fought.text.en, /^At bell 387 your army at \(1,4\) fought \S+ \(nation Aster\): you lost 103, they lost 130; nothing was cleared\.$/);
  assert.equal(fought.facts.cleared, null);
  const loss = r.episodes.find(e => e.kind === 'clash_own_loss' && e.bell === 388);
  assert.match(loss.text.en, /^At bell 388 your army at \(1,4\) lost 69 troops against \S+ \(nation Aster\); they lost 60\.$/);
  assert.deepEqual([fought.created_bell, loss.created_bell], [389, 390], 'created at the log bell of the CLASH row');
  assert.deepEqual(r.deltas, [], 'an attacker gets no trust or grievance delta from its own attack');
});

test('recorded: a lone army clears the camp at (1,-3) at bell 43: camp_cleared_own and clash_own_win against the camp', () => {
  const r = viaRaw(CAMP_SINGLE);
  assert.deepEqual(nonThreat(r).map(e => e.kind).sort(), ['camp_cleared_own', 'clash_own_win']);
  assert.equal(r.episodes.find(e => e.kind === 'camp_cleared_own').text.en, 'At bell 43 your army cleared the camp at (1,-3).');
  assert.match(r.episodes.find(e => e.kind === 'clash_own_win').text.en, /^At bell 43 your army at \(1,-3\) beat the camp: you lost 35, they lost 314\.$/);
});

test('recorded: two armies of different nations arrive on the camp tile at bell 304 — each wins against the camp, and the meeting is a collision, never a hostile act', () => {
  for (const [tag, other] of [[RACE_0, RACE_1], [RACE_1, RACE_0]]) {
    const r = viaRaw(tag);
    assert.deepEqual(nonThreat(r).map(e => e.kind).sort(), ['camp_cleared_own', 'clash_own_win'], tag);
    assert.equal(r.collisions.length, 1, tag);
    assert.equal(r.collisions[0].actor, other);
    assert.ok(!r.episodes.some(e => e.kind === 'attacked_own'));
    assert.ok(!r.deltas.some(d => d.kind === 'grievance'), 'no grievance from a collision');
  }
});

test('recorded: bystander nation-mates in (1,4) remember the camp taken first; the village attacks cost the attacker -5 each with them', () => {
  for (const tag of [BYSTANDER_MATE]) {
    const r = viaRaw(tag);
    assert.ok(r.episodes.some(e => e.kind === 'camp_taken_by' && e.bell === 304));
    assert.equal(r.deltas.filter(d => d.reason === 'nation_mate').length, 2);
    assert.ok(!r.episodes.some(e => e.kind === 'attacked_own'));
  }
  const r2 = viaRaw(MATE_2);
  const own = r2.episodes.find(e => e.kind === 'attacked_own');
  assert.deepEqual([own.bell, own.created_bell], [388, 390]);
  assert.match(own.text.en, /attacked your village at \(1,4\); you lost 60 troops\.$/);
});

test('recorded: the raw files and the objects watcher/feed.mjs hands over give IDENTICAL episodes and deltas for every AI of the capture', () => {
  for (const tag of Object.keys(owners.citizens)) {
    if (!owners.citizens[tag].home) continue;
    const a = viaRaw(tag), b = viaFeed(tag);
    assert.deepEqual(b.episodes, a.episodes, `episodes of ${tag}`);
    assert.deepEqual(b.deltas, a.deltas, `deltas of ${tag}`);
    assert.deepEqual(b.collisions, a.collisions, `collisions of ${tag}`);
    assert.equal(new Episodes(b.episodes).sha256(), new Episodes(a.episodes).sha256());
  }
});

test('recorded: every episode on real data satisfies the invariants (ids, importance table, created_bell >= bell, sanitised text, pseudonymous entities only)', () => {
  const importance = { attacked_own: 8, strike: 6, clash_own_win: 6, clash_own_loss: 6, clash_own_fought: 6, camp_cleared_own: 5, camp_taken_by: 5, threat: 5, dm: 4, motion: 4, council_result: 4, build_done: 2 };
  let n = 0;
  for (const tag of Object.keys(owners.citizens)) {
    if (!owners.citizens[tag].home) continue;
    for (const e of viaRaw(tag).episodes) {
      n++;
      assert.match(e.id, /^[0-9a-f]{16}$/);
      assert.equal(e.importance, importance[e.kind]);
      assert.ok(e.created_bell >= e.bell, `${e.kind}`);
      assert.ok(!/[<>{}\[\]]/.test(e.text.en + e.text.ja));
      for (const ent of e.entities) assert.match(ent, /^([0-9a-f]{16}|nation:\d|pq:-?\d+,-?\d+)$/);
    }
  }
  assert.ok(n >= 25, `${n} episodes seen`);
});

test('recorded: bellNow gates everything — at the clash bell nothing about the attack exists yet, one bell after b + 2 it does', () => {
  const ctx = (bellNow) => ({ ...rawCtx(DEFENDER), bellNow });
  assert.ok(!episodes_from_events({ events: rawEvents }, ctx(389)).episodes.some(e => e.kind === 'attacked_own'));
  assert.ok(episodes_from_events({ events: rawEvents }, ctx(390)).episodes.some(e => e.kind === 'attacked_own'));
});

test('recorded: the memory unit\'s stand-in sanitiser (memory/safe.mjs) and the real one (mind/sanitize.mjs) agree on every episode text of the capture, EN and JA', () => {
  let n = 0;
  for (const tag of Object.keys(owners.citizens)) {
    if (!owners.citizens[tag].home) continue;
    for (const e of viaRaw(tag).episodes) {
      for (const l of ['en', 'ja']) {
        n++;
        assert.equal(sanitize(e.text[l], { limit: 0 }), safeText(e.text[l], { kind: 'trusted' }), `${e.kind} ${l}`);
      }
    }
  }
  assert.ok(n >= 50, `${n} texts compared`);
});
