// Conquest worlds (program version 3): a first village comes from PlaceHome, which logs HOME_PLACED (frontier-abi log.rs
// kind 17: key p, q, site; payload citizen_tag, gen, final_ts, funder) and no SETTLE. The owners index, the feed's wakes and
// the episodes must attribute hosts and villages from it, for an AI member and for a human browser player alike.
//
// SYNTHETIC rows in the herald's /h/events row shape (the `decoded` field as herald/src/records.rs `record_json` writes it:
// 4-byte p/q as signed integers, 8-byte fields as decimal strings, 1-byte fields as numbers). The JOIN rows carry made-up
// citizen_tag15 values; the citizen tag is derived from them exactly as on a real season (owners.mjs citizenTagOfTag15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeed, normalizeRow, KEPT_KINDS } from '../citizens/watcher/feed.mjs';
import { createOwners, citizenTagOfTag15, parseHostId } from '../citizens/watcher/owners.mjs';
import { createCensus } from '../citizens/watcher/census.mjs';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { hexDistance, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { readJson } from './fixtures/ai-herald-fake.mjs';

const season = readJson('ai-herald-season.json');
const SEASON = { seasonAddress: season.seasonAddress, programId: season.programId };
const T15_AI = '0a'.repeat(15), T15_HUMAN = '0b'.repeat(15), T15_MATE = '0c'.repeat(15);
const AI = citizenTagOfTag15(T15_AI, SEASON), HUMAN = citizenTagOfTag15(T15_HUMAN, SEASON), MATE = citizenTagOfTag15(T15_MATE, SEASON);
const dec = hex => BigInt(`0x${hex}`).toString();

let seq = 1000;
const rowOf = (kind, name, bell, key, payload) => ({ seq: String(++seq), slot: seq, sig: `sig${seq}`, tx: 0, kind, bell, decoded: { kind, name, bell, key, payload, links: [] } });
const join = (t15, faction, bell) => rowOf(10, 'JOIN', bell, { citizen_tag15: t15 }, { wallet: (faction + 1).toString(16).padStart(2, '0').repeat(32), faction, shard: 0, session: '00'.repeat(32), expiry: '0' });
const homePlaced = (tag, at, bell, gen = 1) => rowOf(17, 'HOME_PLACED', bell, { p: at.p, q: at.q, site: at.site }, { citizen_tag: dec(tag), gen, final_ts: '1785630400', funder: '11'.repeat(32) });
const depart = (at, gen, bell, mass = 300_000) => {
  const id = hostId({ ...at, gen, seq: 1 }).toString();
  return rowOf(30, 'DEPART', bell, { host_id: id }, { origin_p: at.p, origin_q: at.q, origin_tile: 20, depart_bell: bell, arrive_bell: bell + 8, dep_mass: mass, march_stamina: 74, tip: '5000', seal_root: 'aa'.repeat(32), commit: 'bb'.repeat(32) });
};

// the AI of nation 0 at (3,0); a human of nation 1 three provinces away; a nation mate of the AI two provinces away
const AI_HOME = { p: 3, q: 0, site: 2 };
const HUMAN_HOME = { p: 0, q: 3, site: 5 };
const MATE_HOME = { p: 2, q: 0, site: 1 };
const FAR_HOME = { p: -3, q: 0, site: 0 };
const quiet = { get: async () => ({ status: 404, json: null, text: '' }) };

test('SYNTHETIC geometry: the homes are in the wedges of their nations and the human is exactly 3 provinces from the AI', () => {
  assert.equal(wedgeOf(AI_HOME.p, AI_HOME.q), wedgeOf(MATE_HOME.p, MATE_HOME.q));
  assert.notEqual(wedgeOf(AI_HOME.p, AI_HOME.q), wedgeOf(HUMAN_HOME.p, HUMAN_HOME.q));
  assert.equal(hexDistance(HUMAN_HOME.p, HUMAN_HOME.q, AI_HOME.p, AI_HOME.q), 3);
  assert.ok(hexDistance(FAR_HOME.p, FAR_HOME.q, AI_HOME.p, AI_HOME.q) > 3);
});

test('normalizeRow keeps HOME_PLACED, OUTPOST_SETTLED and CAPTURE_SETTLED with hex citizen tags', () => {
  for (const k of ['HOME_PLACED', 'OUTPOST_SETTLED', 'CAPTURE_SETTLED']) assert.ok(KEPT_KINDS.includes(k), k);
  const ev = normalizeRow(homePlaced(AI, AI_HOME, 4));
  assert.deepEqual([ev.kind, ev.p, ev.q, ev.site, ev.citizen, ev.gen, ev.bell, ev.final_ts], ['HOME_PLACED', 3, 0, 2, AI, 1, 4, '1785630400']);
  const out = normalizeRow(rowOf(88, 'OUTPOST_SETTLED', 9, { p: 4, q: 0, site: 3 }, { citizen_tag: dec(AI), order: 2, gen: 1, shield_until: '0', anchor_key: '0' }));
  assert.deepEqual([out.citizen, out.gen, out.order], [AI, 1, 2]);
  const cap = normalizeRow(rowOf(83, 'CAPTURE_SETTLED', 9, { p: 3, q: 0, site: 2 }, { outcome: 0, credited: 1, captor_tag: dec(HUMAN), victim_tag: dec(AI), new_gen: 2, slot: 2, rent_moved: '0', bonds_refunded: '0', walls_after: 0 }));
  assert.deepEqual([cap.captor, cap.victim, cap.gen], [HUMAN, AI, 2]);
  const fc = normalizeRow(rowOf(83, 'CAPTURE_SETTLED', 9, { p: 3, q: 0, site: 2 }, { outcome: 2, credited: 0, captor_tag: '0', victim_tag: dec(AI), new_gen: 2, slot: 0, rent_moved: '0', bonds_refunded: '0', walls_after: 0 }));
  assert.equal(fc.captor, null);
});

test('owners: a HOME_PLACED home is held, final at once, and names the holder of the host ids of its generation', () => {
  const o = createOwners(SEASON);
  for (const r of [join(T15_AI, 0, 0), join(T15_HUMAN, 1, 1), homePlaced(AI, AI_HOME, 2), homePlaced(HUMAN, HUMAN_HOME, 3)]) o.ingest(normalizeRow(r));
  assert.deepEqual(o.homeOf(AI), AI_HOME);
  assert.deepEqual(o.holdingsOf(AI), [{ ...AI_HOME, gen: 1, founded_bell: 2, final: true, tier: null }]);
  assert.equal(o.holderOfSite(HUMAN_HOME.p, HUMAN_HOME.q, HUMAN_HOME.site).tag, HUMAN);
  const id = hostId({ ...HUMAN_HOME, gen: 1, seq: 7 }).toString();
  assert.deepEqual(parseHostId(id), { ...HUMAN_HOME, gen: 1, seq: 7 });
  assert.equal(o.citizenOfHost(id), HUMAN);
  assert.equal(o.factionOfHost(id), 1);
  assert.equal(o.citizenOfHost(hostId({ ...HUMAN_HOME, gen: 2, seq: 7 }).toString()), null, 'another generation is not this holder');
  assert.equal(o.stats.homes, 2);
  // a capture moves the village under a new generation; the old generation's hosts stay with the old holder
  o.ingest(normalizeRow(rowOf(83, 'CAPTURE_SETTLED', 9, { p: AI_HOME.p, q: AI_HOME.q, site: AI_HOME.site }, { outcome: 0, credited: 1, captor_tag: dec(HUMAN), victim_tag: dec(AI), new_gen: 2, slot: 2, rent_moved: '0', bonds_refunded: '0', walls_after: 0 })));
  assert.equal(o.homeOf(AI), null);
  assert.equal(o.holdingsOf(HUMAN).length, 2);
  assert.equal(o.citizenOfHost(hostId({ ...AI_HOME, gen: 1, seq: 1 }).toString()), AI);
  assert.equal(o.citizenOfHost(hostId({ ...AI_HOME, gen: 2, seq: 1 }).toString()), HUMAN);
});

test('W-THREAT: a human\'s DEPART from a PlaceHome village within 3 provinces of an AI\'s PlaceHome home wakes the AI; a nation mate\'s and a far one do not', async () => {
  const feed = createFeed({ herald: quiet, season: { ...SEASON, season: season.season }, roster: { ai: [{ tag: AI, faction: 0 }] } });
  const FAR = citizenTagOfTag15('0d'.repeat(15), SEASON);
  const dHuman = depart(HUMAN_HOME, 1, 20), dMate = depart(MATE_HOME, 1, 20), dFar = depart(FAR_HOME, 1, 20);
  await feed.ingest([
    join(T15_AI, 0, 0), join(T15_HUMAN, 1, 1), join(T15_MATE, 0, 1), join('0d'.repeat(15), 3, 1),
    homePlaced(AI, AI_HOME, 2), homePlaced(HUMAN, HUMAN_HOME, 3), homePlaced(MATE, MATE_HOME, 3), homePlaced(FAR, FAR_HOME, 3),
    dHuman, dMate, dFar,
  ]);
  const wakes = feed.wakeEvents(AI, 20).filter(w => w.code === 'W-THREAT');
  assert.equal(wakes.length, 1);
  const w = wakes[0];
  assert.deepEqual([w.seq, w.distance, w.nation, w.actor, w.origin, w.weight], [dHuman.seq, 3, 1, HUMAN, { p: HUMAN_HOME.p, q: HUMAN_HOME.q }, 2]);
  assert.equal('dest' in w || 'tile' in w, false, 'the destination is sealed');
});

test('threat episode: the same human DEPART is remembered by the AI as a `threat` (wiring.mjs context: owners from the feed)', async () => {
  const feed = createFeed({ herald: quiet, season: { ...SEASON, season: season.season }, roster: { ai: [{ tag: AI, faction: 0 }] } });
  await feed.ingest([join(T15_AI, 0, 0), join(T15_HUMAN, 1, 1), join(T15_MATE, 0, 1), homePlaced(AI, AI_HOME, 2), homePlaced(HUMAN, HUMAN_HOME, 3), homePlaced(MATE, MATE_HOME, 3),
    depart(HUMAN_HOME, 1, 20), depart(MATE_HOME, 1, 20)]);
  const owners = feed.owners;
  const home = owners.homeOf(AI);
  assert.ok(home, 'the mind\'s wiring skips an AI with no home: a PlaceHome home must count');
  const ai = { tag: AI, wallet: 'AIWALLET', faction: owners.factionOfTag(AI), home: { p: home.p, q: home.q }, holdings: owners.holdingsOf(AI).map(h => ({ p: h.p, q: h.q, site: h.site })) };
  const events = feed.batchSince('0').events;
  const prepared = await feed.prepare(events);
  const res = episodes_from_events({ events }, { ai, bellNow: 30, owners, province: prepared.province, clash: prepared.clash, clashDetail: prepared.clashDetail, config: {} });
  const threats = res.episodes.filter(e => e.kind === 'threat');
  assert.equal(threats.length, 1, JSON.stringify(res.episodes.map(e => e.kind)));
  assert.deepEqual(threats[0].facts, { p: HUMAN_HOME.p, q: HUMAN_HOME.q, nation: 1, mass: 300, arrive_bell: 28 });
});

test('census: a citizen known only from HOME_PLACED is in its nation, with a final village', async () => {
  const feed = createFeed({ herald: quiet, season: { ...SEASON, season: season.season } });
  await feed.ingest([join(T15_HUMAN, 1, 1), homePlaced(HUMAN, HUMAN_HOME, 3)]);
  const roster = { ai: [], seat: null, byTag: () => null, byWallet: () => null };
  const census = createCensus({ feed, roster });
  census.start();
  assert.deepEqual(census.tagsOfNation(1), [HUMAN]);
  assert.deepEqual(census.holdingsOfNation(1), [{ ...HUMAN_HOME, tag: HUMAN, final: true }]);
  assert.equal(census.hasFinalHolding(HUMAN), true);
});
