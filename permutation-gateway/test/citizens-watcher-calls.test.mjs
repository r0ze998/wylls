// AC6: the Strike Order (contract 6.5 steps 6 and 7): the tile from the files of bell C0 + 5, the invited list and its order, the seal
// retried until the files are served, the result at S + 2 (present, bounced, displaced, the clash on the tile), and the proof that the
// opened Call feeds AC2's episode producer (the `strike` episode and the +2 adopted-mover delta). Province files and clash details here are
// SYNTHETIC in the real feed's shape (test/fixtures/ai-watcher-kit.mjs); the council store is AC4's real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { motionRef } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { tileFor, invitedOrder, strikeResult, createCalls, INVITE_RADIUS } from '../citizens/watcher/calls.mjs';
import { ball } from '../citizens/watcher/council_gen.mjs';
import { createCensus } from '../citizens/watcher/census.mjs';
import { candidatesHash } from '../citizens/social/council.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { socialEpisodeSource } from '../citizens/mind/wiring.mjs';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { OPTIONS, SEASON, builders, fakeHerald, makeCitizen, makeClock, tmpAiDir } from './fixtures/ai-social-kit.mjs';
import { fakeFeed, fakeOwners, fakeRoster, host, province, siteTile, GENESIS } from './fixtures/ai-watcher-kit.mjs';

// ---------------------------------------------------------------- pure vectors
test('tileFor: strike = the largest enemy stack, camp = the camp tile, raid = the village tile; the hint when the file shows nothing there', () => {
  const pv = province({
    p: 4, q: 0, villages: [{ site: 2, faction: 3, garrison: 100, shield_until_bell: 0 }, { site: 6, faction: 4, garrison: 300, shield_until_bell: 0 }],
    hosts: [host({ faction: 2, tile: 20, troops: 100 }), host({ faction: 2, tile: 21, troops: 250 }), host({ faction: 4, tile: siteTile(6), troops: 50 })], camp: { tile: 44, troops: 150 },
  });
  assert.equal(tileFor({ kind: 'strike', pv, faction: 1, strikeBell: 99 }), 21);
  assert.equal(tileFor({ kind: 'camp', pv, faction: 1, strikeBell: 99 }), 44);
  assert.equal(tileFor({ kind: 'raid', pv, faction: 1, strikeBell: 99 }), siteTile(6), 'the village with the most garrison plus residents (350 against 100)');
  // nothing left in the file: the tile of bell C0 - 2 (a hint), else no tile
  const empty = province({ p: 4, q: 0 });
  assert.equal(tileFor({ kind: 'strike', pv: empty, faction: 1, strikeBell: 99, hint: { tile: 30 } }), 30);
  assert.equal(tileFor({ kind: 'camp', pv: empty, faction: 1, strikeBell: 99, hint: { tile: 31 } }), 31);
  assert.equal(tileFor({ kind: 'strike', pv: null, faction: 1, strikeBell: 99, hint: { tile: 32 } }), 32);
  assert.equal(tileFor({ kind: 'strike', pv: empty, faction: 1, strikeBell: 99 }), null);
  // a raid target whose shield stands at S is not a raid target any more: the hint
  const shielded = province({ p: 4, q: 0, villages: [{ site: 2, faction: 3, garrison: 100, shield_until_bell: 200 }] });
  assert.equal(tileFor({ kind: 'raid', pv: shielded, faction: 1, strikeBell: 99, hint: { tile: 7 } }), 7);
});

test('invitedOrder: ballot-voters first, then troops desc, ties by host id; the first six; decimal strings', () => {
  const hosts = [
    { id: '900', owner: 'a', troops: 100_000 }, { id: '800', owner: 'b', troops: 400_000 }, { id: '700', owner: 'c', troops: 400_000 },
    { id: '600', owner: 'd', troops: 50_000 }, { id: '500', owner: 'e', troops: 300_000 }, { id: '400', owner: 'f', troops: 200_000 },
    { id: '300', owner: 'g', troops: 450_000 }, { id: '200', owner: 'h', troops: 10_000 },
  ];
  // c and d voted for the winner: their hosts come first (troops desc inside the group), then the rest by troops desc, ties by host id (700 < 800)
  assert.deepEqual(invitedOrder({ hosts, voterTags: new Set(['c', 'd']) }), ['700', '600', '300', '800', '500', '400']);
  // no voters: pure troops order, tie 700 before 800
  assert.deepEqual(invitedOrder({ hosts, voterTags: new Set() }), ['300', '700', '800', '500', '400', '900']);
  assert.deepEqual(invitedOrder({ hosts, voterTags: ['h'], limit: 2 }), ['200', '300'], 'an array of voters works; the limit is honoured');
  assert.deepEqual(invitedOrder({ hosts: [], voterTags: new Set() }), []);
  // ids are compared as numbers, not as strings ("9" < "10")
  assert.deepEqual(invitedOrder({ hosts: [{ id: '10', owner: 'x', troops: 5 }, { id: '9', owner: 'y', troops: 5 }] }), ['9', '10']);
});

test('strikeResult: present armies of the nation, bounced and displaced counted as present and listed apart, losses of the engaged fighters on the tile per nation', () => {
  const reveals = [
    { host_id: '11', faction: 1, displace: 0, displaced_host: null }, { host_id: '12', faction: 1, displace: 0, displaced_host: null }, { host_id: '13', faction: 1, displace: 1, displaced_host: '77' },
    { host_id: '14', faction: 2, displace: 0, displaced_host: null }, // another nation arriving in the same province
  ];
  const fighter = (id, faction, tile, engaged, fate, before, after) => ({ id, faction, tile, engaged, fate, troops_before: before * 1000, troops_after: after * 1000, lost: (before - after) * 1000 });
  const detail = {
    engagements: 3,
    fighters: [fighter('11', 1, 44, true, 'Stays', 300, 220), fighter('12', 1, null, false, 'Bounced', 200, 200), fighter('13', 1, 44, true, 'Stays', 100, 90), fighter('14', 2, 44, true, 'Stays', 250, 100), fighter('99', 2, 17, true, 'Stays', 100, 10)],
  };
  const r = strikeResult({ faction: 1, p: 4, q: 0, tile: 44, strikeBell: 60, reveals, detail });
  assert.deepEqual([r.present, r.bounced, r.displaced], [3, 1, 1]);
  assert.deepEqual([r.present_hosts, r.bounced_hosts, r.displaced_hosts], [['11', '12', '13'], ['12'], ['13']]);
  assert.deepEqual(r.clash, { p: 4, q: 0, tile: 44, bell: 60, engagements: 3, fighters_on_tile: 3, engaged_on_tile: 3, lost: { 1: 90, 2: 150 } });
  // no clash record: still a result, the clash part is null
  assert.deepEqual(strikeResult({ faction: 1, p: 4, q: 0, tile: 44, strikeBell: 60, reveals: [], detail: null }), { present: 0, present_hosts: [], bounced: 0, bounced_hosts: [], displaced: 0, displaced_hosts: [], clash: null });
});

// ---------------------------------------------------------------- the job against AC4's real council
const K = 2;
const C0 = 48;
const S = C0 + 12; // 60
const hexTag = i => String(i).padStart(16, '0');
const CH = candidatesHash(OPTIONS);

function world({ withFiles = true } = {}) {
  const clock = makeClock({ bell: C0 });
  const dir = tmpAiDir();
  const cits = { alice: makeCitizen('alice', { faction: 0 }), seat: makeCitizen('seat', { faction: 0 }), ai0: makeCitizen('ai0', { faction: 0 }), ai1: makeCitizen('ai1', { faction: 0 }), ai2: makeCitizen('ai2', { faction: 0 }) };
  const tags = { alice: hexTag(1), seat: hexTag(2), ai0: hexTag(10), ai1: hexTag(11), ai2: hexTag(12) };
  const people = Object.keys(cits).map(n => ({ tag: tags[n], wallet: cits[n].b58, faction: 0, kind: n.startsWith('ai') ? 'ai' : n === 'seat' ? 'seat' : null, holdings: [{ p: 3, q: 0, site: 1, final: true }] }));
  const owners = fakeOwners({ citizens: people });
  const roster = fakeRoster({
    ai: ['ai0', 'ai1', 'ai2'].map((n, i) => ({ index: 1000 + i, tag: tags[n], wallet: cits[n].b58, faction: 0, name: { en: n, ja: n } })),
    seat: { index: 1012, wallet: cits.seat.b58, tag: tags.seat, faction: 0, scripted: false },
  });
  const herald = fakeHerald(Object.values(cits));
  const outputs = new Map();
  let callsRef = null;
  const social = createSocial({
    herald, aiDir: dir.dir, roster: { season: SEASON, ai: roster.ai, script: { wallets: [] }, seat: roster.seat }, clock, config: { council: { period: 24, offset: 0, strike_lead: 6, human_present: true } }, season: SEASON,
    provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, random: n => new Uint8Array(n).fill(0x11),
    fixCall: a => (callsRef ? callsRef.closeCall(a.faction, a.period) : null),
  });
  const feed = fakeFeed({ owners, through: 120, head: 120 });
  const census = createCensus({ feed, roster });
  // the world at bell C0 + 5 = 53: the camp of option 2 at (4, 0), our armies around it; ownership by host id
  const hostOwner = {};
  const H = (n, ownerName, troops, tile = 12) => { const h = host({ id: 5000 + n, owner: tags[ownerName], faction: 0, tile, troops }); hostOwner[h.id] = tags[ownerName]; return h; };
  const hs = [H(1, 'ai0', 300), H(2, 'ai1', 450), H(3, 'seat', 200), H(4, 'alice', 500), H(5, 'ai2', 350), H(6, 'ai0', 100), H(7, 'ai1', 250), H(8, 'alice', 400)];
  owners.citizenOfHost = id => hostOwner[String(id)] ?? null;
  if (withFiles) {
    feed.files.set(`4,0,${C0 + 5}`, province({ p: 4, q: 0, bell: C0 + 5, camp: { tile: 44, troops: 150 } }));
    feed.files.set(`3,0,${C0 + 5}`, province({ p: 3, q: 0, bell: C0 + 5, hosts: hs.slice(0, 5) }));
    feed.files.set(`3,1,${C0 + 5}`, province({ p: 3, q: 1, bell: C0 + 5, hosts: hs.slice(5), }));
    feed.files.set(`9,9,${C0 + 5}`, province({ p: 9, q: 9, bell: C0 + 5, hosts: [host({ faction: 0, tile: 5, troops: 999 })] })); // far away: never read
  }
  const stats = {};
  const results = [];
  const calls = createCalls({ feed, social, roster, census, hintOf: (f, k, o) => (o === 2 ? { tile: 43 } : null), stats, onResult: r => results.push(r) });
  callsRef = calls;
  const b = builders(clock);
  let n = 0;
  const ballot = (c, option) => social.book.submit('ballot', b.ballot(c, { period: K, option, candidates_hash: CH, origin: c.name.startsWith('ai') ? 1 : 0 }, c.name.startsWith('ai') ? (() => { const id = `bd${n++}`; outputs.set(`${id}|0|ballot`, { type: 'ballot', bell: C0 + 3, option, period: K, faction: 0, candidates_hash: CH }); return { decision_id: id, item: 0 }; })() : {}).body);
  const motion = (c, option) => {
    const id = `md${n++}`;
    outputs.set(`${id}|0|talk`, { type: 'talk', bell: C0, text: 'I move this.' });
    return social.book.submit('talk', b.talk(c, { channel: 1, target: 0, kind: 1, ref: motionRef(K, option), origin: 1, text: 'I move this.' }, { decision_id: id, item: 0 }).body);
  };
  return { clock, dir, cits, tags, owners, roster, social, feed, census, calls, stats, results, ballot, motion, hs, hostOwner };
}

async function adopt(w, { ballots = [['ai0', 2], ['seat', 2], ['ai1', 1]] } = {}) {
  w.social.council.open({ faction: 0, period: K, c0: C0, candidates: OPTIONS });
  w.clock.set(C0 + 3);
  for (const [name, option] of ballots) await w.ballot(w.cits[name], option);
  w.clock.set(C0 + 6);
  await w.social.council.tick(C0 + 6);
}

test('closeCall at the close: the tile from the camp file of bell C0 + 5, the invited hosts within 2 provinces of the target ordered voters-first; sealed through fixCall', async () => {
  const w = world();
  w.census.start();
  await adopt(w);
  const c = w.social.memberCall(0, K);
  assert.ok(c, 'the Call is sealed at the close');
  assert.equal(c.option, 2);
  assert.equal(c.tile, 44, 'the camp tile of the file of bell C0 + 5, not the hint');
  // voters for option 2: ai0 (hosts 5001 300, 5006 100) and seat (5003 200); then by troops: alice 5004 500, ai1 5002 450 ... the first six
  // hosts: 5001 300, 5002 450, 5003 200, 5004 500, 5005 350, 5006 100, 5007 250, 5008 400
  assert.deepEqual(c.invited, ['5001', '5003', '5006', '5004', '5002', '5008']);
  assert.equal(c.invited.length, 6);
  assert.equal(c.strike_bell, S);
  assert.equal(c.follow_from, C0 + 6);
  assert.match(c.call_commit, /^[0-9a-f]{64}$/);
  // the files asked for are those of bell C0 + 5 within 2 provinces of (4, 0): never the far province
  assert.ok(w.feed.calls.every(x => x.endsWith(`,${C0 + 5}`)));
  assert.ok(!w.feed.calls.some(x => x.startsWith('9,9,')));
  assert.equal(w.feed.calls.length, 19 * 1 + 0, 'one request per province of the ball of radius 2');
  assert.equal(INVITE_RADIUS, 2);
});

test('before the files are served the Call stays unsealed; sealPending seals it at a later bell with the same result; nothing is sealed twice', async () => {
  const w = world({ withFiles: false });
  w.census.start();
  w.feed.state.head = C0 + 6; // the log is only a bell past the close: the files may still be late
  await adopt(w);
  assert.equal(w.social.memberCall(0, K), null, 'no file yet: no tile, no seal');
  assert.equal(w.social.council.periodOf(0, K).call, null);
  await w.calls.sealPending(C0 + 7);
  assert.equal(w.social.memberCall(0, K), null);
  // the files appear (every province of the ball exists, as inside the map; the far province is not part of it)
  const w2 = world();
  for (const [k, v] of w2.feed.files) w.feed.files.set(k, v);
  for (const c of ball(4, 0, INVITE_RADIUS)) if (!w.feed.files.has(`${c.p},${c.q},${C0 + 5}`)) w.feed.files.set(`${c.p},${c.q},${C0 + 5}`, province({ p: c.p, q: c.q, bell: C0 + 5 }));
  await w.calls.sealPending(C0 + 8);
  const c = w.social.memberCall(0, K);
  assert.equal(c.tile, 44);
  assert.equal(w.stats.calls_sealed_late, 1);
  await w.calls.sealPending(C0 + 9);
  assert.equal(w.stats.calls_sealed_late, 1, 'sealed once');
});

test('three bells after the file bell a province that is still missing counts as absent: the Call is fixed from the target file alone, or from the hint when even that is missing', async () => {
  const w = world({ withFiles: false });
  w.census.start();
  w.feed.files.set(`4,0,${C0 + 5}`, province({ p: 4, q: 0, bell: C0 + 5, camp: { tile: 44, troops: 150 } }));
  w.feed.state.head = C0 + 5 + 3;
  await adopt(w);
  const c = w.social.memberCall(0, K);
  assert.equal(c.tile, 44);
  assert.deepEqual(c.invited, [], 'no neighbour file: no invited host (counted by the report)');
  const v = world({ withFiles: false });
  v.census.start();
  v.feed.state.head = C0 + 5 + 3;
  await adopt(v);
  assert.equal(v.social.memberCall(0, K).tile, 43, 'the hint (the tile at C0 - 2)');
});

test('nothing of the target reaches the public files before the Call opens; the member read has it; at S + 2 the council file carries open and the result', async () => {
  const w = world();
  w.census.start();
  await adopt(w);
  const pub = JSON.parse(readFileSync(join(w.dir.pub, 'council', `${K}-0.json`), 'utf8'));
  assert.equal(pub.adopted, true);
  assert.equal(pub.sealed, true);
  assert.equal('open' in pub, false);
  for (const k of ['tile', 'invited', 'nonce']) assert.equal(JSON.stringify(pub).includes(`"${k}"`), false, `${k} is not public before the opening`);
  // S + 2: the Call opens
  w.clock.set(S + 2);
  await w.social.council.tick(S + 2);
  const open = w.social.council.publicOf(0, K).open;
  assert.deepEqual([open.option, open.kind, open.p, open.q, open.tile], [2, 'camp', 4, 0, 44]);
  // the result: needs the log complete through S + 2
  w.feed.state.through = S + 1;
  assert.equal(await w.calls.result(0, K), null, 'the log is not complete through S + 2 yet');
  w.feed.state.through = S + 2;
  for (const [id, f] of [['5001', 0], ['5003', 0], ['5004', 0], ['5099', 3]]) w.feed.addEvent({ kind: 'REVEAL', bell: S, seq: id, p: 4, q: 0, arrive: S, faction: f, host_id: id, tile: 44, displace: 0, displaced_host: null });
  w.feed.addEvent({ kind: 'REVEAL', bell: S, seq: '7', p: 5, q: 0, arrive: S, faction: 0, host_id: '5002', tile: 1, displace: 0, displaced_host: null }); // another province: not present
  w.feed.clash.set(`4,0,${S}`, { engagements: 2, fighters: [
    { id: '5001', faction: 0, tile: 44, engaged: true, fate: 'Stays', troops_before: 300_000, troops_after: 250_000, lost: 50_000 },
    { id: '5003', faction: 0, tile: null, engaged: false, fate: 'Bounced', troops_before: 200_000, troops_after: 200_000, lost: 0 },
    { id: '5099', faction: 3, tile: 44, engaged: true, fate: 'Stays', troops_before: 150_000, troops_after: 60_000, lost: 90_000 },
  ] });
  await w.calls.resultStep();
  const res = w.social.council.publicOf(0, K).result;
  assert.deepEqual([res.present, res.bounced, res.displaced], [3, 1, 0]);
  assert.deepEqual(res.present_hosts, ['5001', '5003', '5004']);
  assert.deepEqual(res.clash, { p: 4, q: 0, tile: 44, bell: S, engagements: 2, fighters_on_tile: 2, engaged_on_tile: 2, lost: { 0: 50, 3: 90 } });
  assert.equal(w.results.length, 1);
  assert.deepEqual([w.results[0].faction, w.results[0].period, w.results[0].call.kind], [0, K, 'camp']);
  await w.calls.resultStep();
  assert.equal(w.results.length, 1, 'written once');
  assert.equal(w.stats.strike_results, 1);
});

test('an opened Call feeds AC2: the strike episode (the target, losses, took part) and the +2 adopted-mover delta for the mover of the adopted option', async () => {
  const w = world();
  w.census.start();
  w.clock.set(C0);
  w.social.council.open({ faction: 0, period: K, c0: C0, candidates: OPTIONS });
  await w.motion(w.cits.ai0, 2);
  await w.motion(w.cits.ai2, 1);
  w.clock.set(C0 + 3);
  for (const [name, option] of [['ai0', 2], ['seat', 2], ['ai1', 1]]) await w.ballot(w.cits[name], option);
  w.clock.set(C0 + 6);
  await w.social.council.tick(C0 + 6);
  w.clock.set(S + 2);
  await w.social.council.tick(S + 2);
  assert.ok(w.social.council.publicOf(0, K).open);
  const src = socialEpisodeSource({ book: w.social.book, council: w.social.council });
  const councils = src.councils(0);
  assert.equal(councils.length, 1);
  assert.deepEqual([councils[0].period, councils[0].adopted, councils[0].strike_bell, councils[0].open.p, councils[0].open.q, councils[0].open.option], [K, true, S, 4, 0, 2]);
  // ai1 (a member who voted for another option) remembers the Strike Order and trusts the mover of the adopted option a little more
  const ai = { tag: w.tags.ai1, wallet: w.cits.ai1.b58, faction: 0, home: { p: 3, q: 0 }, holdings: [{ p: 3, q: 0, site: 1 }] };
  const res = episodes_from_events({ events: [], talk: src.talk(), council: councils }, { ai, bellNow: S + 30, owners: w.owners, province: () => null, clash: () => null, config: { genesis_ts: GENESIS } });
  const strike = res.episodes.find(e => e.kind === 'strike');
  assert.ok(strike, `episodes: ${res.episodes.map(e => e.kind)}`);
  assert.match(strike.text.en, /Strike Order opened at \(4,0\)/);
  assert.equal(res.episodes.some(e => e.kind === 'council_result' && /adopted a Strike Order/.test(e.text.en)), true);
  const mover = res.deltas.find(d => d.reason === 'adopted_mover');
  assert.ok(mover, 'the +2 adopted-mover delta exists once the Call is opened');
  assert.deepEqual([mover.who, mover.amount, mover.bell], [w.tags.ai0, 2, S + 2]);
  // before the opening the same producer has neither the strike episode nor the delta (and the close episode names no target)
  const early = episodes_from_events({ events: [], talk: src.talk(), council: councils.map(({ open, ...rest }) => rest) }, { ai, bellNow: S + 30, owners: w.owners, province: () => null, clash: () => null, config: { genesis_ts: GENESIS } });
  assert.equal(early.episodes.some(e => e.kind === 'strike'), false);
  assert.equal(early.deltas.some(d => d.reason === 'adopted_mover'), false);
  const closeText = early.episodes.find(e => e.kind === 'council_result').text.en;
  assert.doesNotMatch(closeText, /\(\d+,\s*-?\d+\)/);
});
