// AC6: the release job (contract 7.2, ruling R10) over AC1a's REAL records and a feed double that serves public DEPART and REVEAL rows:
// a normal march, a march that arrives later than planned (opened only once its REVEAL is public, real and planned arrival bells shown),
// a march nobody revealed (opened as "unrevealed" after the 6-bell wait), a march the brain never sent, a decision under a live Strike
// Order, one PUB/open/<bell>.json per bell with all due records and never rewritten, restart, and the opened record opening the commit.
// Rows are SYNTHETIC in the shape of the real feed's normalised DEPART and REVEAL events (their fields are checked against the captured
// rows in test/citizens-feed.test.mjs); timing numbers follow the capture: a DEPART is logged at its depart bell, a REVEAL at the arrival bell or one later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRecords, canonicalJson } from '../citizens/mind/records.mjs';
import { createRelease, releaseState, marchesOf, sentMarch, WAIT_BELLS } from '../citizens/watcher/release.mjs';
import { createFeed } from '../citizens/watcher/feed.mjs';
import { startFakeHerald, loadEvents } from './fixtures/ai-herald-fake.mjs';
import { fakeFeed, tmpDir } from './fixtures/ai-watcher-kit.mjs';

const TAG = 'aaaaaaaaaaaaaaa1';
const TAG2 = 'aaaaaaaaaaaaaaa2';
const sha = b => createHash('sha256').update(b).digest('hex');

const sealed = (over = {}) => ({
  v: 2, ai: TAG, index: 1003, bell: 400, kind: 'session', mode: 'model', reason: 'ok', wake: ['W-PULSE'], gate_score: 3, obs_digest: 'ab', situation_hash: 'sh', candidates_hash: 'ch',
  memory_hash: 'mh', inbox_root: 'ir', prompt_hash: 'ph', request_hash: 'rh', output_hash: 'oh', attempts: 1, seed: 5, sealed: true, release_bell: 405,
  choice: { ids: ['c3'], params: { c3: { stance: 'assault' } }, council: null, goal_id: 'G1', mem: ['e1'] }, retrieved: ['e1', 'e2'],
  public: { say: [], why: 'The stack is weak and the road is short.', why_withheld: null }, latency_ms: 5000, deadline_slack_ms: 30000, quota_left: 30, ...over,
});
const priv = (host, planned, over = {}) => ({
  candidates: [{ id: 'c3', kind: 'march', facts: { host_id: host, target: { p: 2, q: 0, tile: 9 }, earliest_bell: planned } }, { id: 'c1', kind: 'autopilot' }],
  remembered: [{ id: 'e1', bell: 380, text: { en: 'At bell 380 ...', ja: '鐘380で ...' } }],
  intended: [{ host_id: host, arrive_bell: planned, pq: [2, 0], tile: 9, via: 'model', target_kind: 'camp' }], ...over,
});
const depart = (host, departBell, arriveBell) => ({ kind: 'DEPART', bell: departBell, seq: `d${host}`, host_id: host, depart_bell: departBell, arrive_bell: arriveBell, dep_mass: 300_000, origin_p: 0, origin_q: 0, origin_tile: 4 });
const reveal = (host, arrive, logBell, over = {}) => ({ kind: 'REVEAL', bell: logBell, seq: `r${host}`, p: 2, q: 0, arrive, faction: 1, i: 0, host_id: host, tile: 9, displace: 0, displaced_host: null, ...over });

function world() {
  const dir = tmpDir('ai-release-');
  const records = createRecords({ aiDir: dir, randomBytes: n => Buffer.alloc(n, 7) });
  const feed = fakeFeed();
  const opened = [];
  const stats = {};
  const rel = createRelease({ feed, records, pubDir: join(dir, 'pub'), stats, onOpened: o => opened.push(o) });
  const send = (id, intent = 'depart', status = 'sent') => records.attachOutcome(id, { actions: [{ intent, sig: `sig-${id.slice(0, 6)}`, status }] });
  const addRev = ev => { feed.reveals.set(`${ev.host_id}/${ev.arrive}`, ev); feed.addEvent(ev); };
  const file = b => join(dir, 'pub', 'open', `${b}.json`);
  const read = b => JSON.parse(readFileSync(file(b), 'utf8'));
  return { dir, records, feed, rel, opened, stats, send, addRev, file, read };
}

test('pure: marchesOf (one entry per host, no host id = no march), sentMarch (unknown without an outcome), releaseState waits and gives up at release_bell + 7', () => {
  assert.deepEqual(marchesOf({ intended: [{ host_id: '7', arrive_bell: 404, via: 'model', target_kind: 'camp' }, { host_id: '7', arrive_bell: 404 }, { host_id: null }, { host_id: 8, arrive_bell: 406, via: 'strike_order' }] }), [
    { host_id: '7', planned_arrive_bell: 404, via: 'model', target_kind: 'camp' }, { host_id: '8', planned_arrive_bell: 406, via: 'strike_order', target_kind: null },
  ]);
  assert.deepEqual(marchesOf({}), []);
  assert.equal(sentMarch([]), null);
  assert.equal(sentMarch([{ intent: 'build', status: 'sent' }]), false, 'an outcome without a sent march');
  assert.equal(sentMarch([{ intent: 'build', status: 'sent' }, { intent: 'depart', status: 'sent' }]), true);
  assert.equal(sentMarch([{ intent: 'depart', status: 'refused' }]), false);
  const entry = { full: { release_bell: 405, tx: [] }, priv: priv('77', 404) };
  const none = { depart: () => null, reveal: () => null };
  assert.equal(releaseState({ entry, bell: 411, find: none }).ready, false);
  const s = releaseState({ entry, bell: 412, find: none });
  assert.deepEqual([s.ready, s.waited_out, WAIT_BELLS], [true, true, 6]);
  assert.deepEqual(s.destinations[0], { host_id: '77', planned_arrive_bell: 404, via: 'model', state: 'unrevealed', destination: 'unrevealed', arrive_bell: null, depart_bell: null });
});

test('a normal march: nothing before its arrival bell has ended; at release_bell the REVEAL is public and the destination comes from it; one file, marked opened', async () => {
  const w = world();
  const { id } = w.records.add(sealed(), priv('77', 404));
  w.send(id);
  w.feed.addEvent(depart('77', 400, 404));
  // before the arrival: nothing is due, nothing is written
  assert.deepEqual(await w.rel.releaseDue(404), { bell: 404, opened: [] });
  assert.equal(existsSync(w.file(404)), false);
  // the REVEAL is logged at the arrival bell (the capture: 63 of 69 at +0, 6 at +1)
  w.addRev(reveal('77', 404, 404));
  const r = await w.rel.releaseDue(405);
  assert.deepEqual(r.opened, [id]);
  const f = w.read(405);
  assert.equal(f.bell, 405);
  assert.equal(f.records.length, 1);
  const o = f.records[0];
  assert.equal(o.id, id);
  assert.deepEqual(o.destinations, [{ host_id: '77', planned_arrive_bell: 404, via: 'model', state: 'revealed', p: 2, q: 0, tile: 9, arrive_bell: 404, depart_bell: 400 }]);
  assert.equal(o.opened_bell, 405);
  assert.equal(o.by, 'model');
  assert.deepEqual(o.choice.mem, ['e1']);
  assert.deepEqual(o.retrieved, ['e1', 'e2']);
  assert.equal(o.public.why, 'The stack is weak and the road is short.');
  assert.deepEqual(o.remembered, [{ id: 'e1', bell: 380, text: { en: 'At bell 380 ...', ja: '鐘380で ...' } }]);
  assert.equal(o.candidates.length, 2, 'the brain\'s candidate list with its facts');
  assert.equal(o.release_bell, 405, 'the committed release bell is untouched');
  assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'pub/open/index.json'), 'utf8')), { v: 1, bells: [405], latest: 405 });
  assert.equal(w.records.getPrivate(id).opened, true);
  assert.deepEqual(w.records.dueForRelease(500), []);
  assert.equal(w.opened.length, 1);
  assert.equal(w.stats.records_opened, 1);
  // the destination is the REVEAL's, never model text: the file carries the tile and province from the public row
  assert.equal(o.destinations[0].p, 2);
});

test('the opened record opens the sealed commitment: sha256(canonical{situation_hash, candidates_hash, choice, retrieved, public} || nonce)', async () => {
  const w = world();
  const { id, published } = w.records.add(sealed(), priv('77', 404));
  w.send(id);
  w.feed.addEvent(depart('77', 400, 404));
  w.addRev(reveal('77', 404, 404));
  await w.rel.releaseDue(405);
  const o = w.read(405).records[0];
  const again = sha(Buffer.concat([Buffer.from(canonicalJson({ situation_hash: o.situation_hash, candidates_hash: o.candidates_hash, choice: o.choice, retrieved: o.retrieved, public: o.public })), Buffer.from(o.nonce, 'hex')]));
  assert.equal(again, published.commit);
});

test('a march that arrives LATER than planned: not opened until its REVEAL is public and its real arrival bell has ended; both arrival bells are shown', async () => {
  const w = world();
  const { id } = w.records.add(sealed(), priv('77', 404)); // planned 404, release_bell 405
  w.send(id);
  // the brain re-planned at obs.now + 60 s: the DEPART is logged at 400 and arrives at 406
  w.feed.addEvent(depart('77', 400, 406));
  assert.deepEqual((await w.rel.releaseDue(405)).opened, [], 'release_bell reached but the real arrival (406) is not over');
  assert.equal(existsSync(w.file(405)), false);
  assert.deepEqual((await w.rel.releaseDue(406)).opened, [], 'the arrival bell is not over, whatever the feed holds');
  w.addRev(reveal('77', 406, 406));
  assert.deepEqual((await w.rel.releaseDue(406)).repeat, true, 'one pass per bell');
  assert.deepEqual((await w.rel.releaseDue(407)).opened, [id]);
  const o = w.read(407).records[0];
  assert.deepEqual([o.destinations[0].planned_arrive_bell, o.destinations[0].arrive_bell, o.release_bell, o.opened_bell], [404, 406, 405, 407]);
  assert.equal(w.stats.records_arrived_off_plan, 1);
});

test('a march whose REVEAL is not public yet waits, even after the arrival bell; it opens at the first bell that has the row', async () => {
  const w = world();
  const { id } = w.records.add(sealed(), priv('77', 404));
  w.send(id);
  w.feed.addEvent(depart('77', 400, 404));
  for (const b of [405, 406, 407]) assert.deepEqual((await w.rel.releaseDue(b)).opened, []);
  assert.equal(w.stats.release_waiting, 3);
  w.addRev(reveal('77', 404, 405)); // logged one bell after the arrival (6 of 69 in the capture)
  assert.deepEqual((await w.rel.releaseDue(408)).opened, [id]);
  assert.equal(w.read(408).records[0].destinations[0].arrive_bell, 404);
});

test('an unrevealed march opens as "unrevealed" after the 6-bell wait counted from the end of release_bell, and not before', async () => {
  const w = world();
  const { id } = w.records.add(sealed(), priv('77', 404));
  w.send(id);
  w.feed.addEvent(depart('77', 400, 404)); // no REVEAL ever
  for (let b = 405; b <= 411; b++) assert.deepEqual((await w.rel.releaseDue(b)).opened, [], `bell ${b}`);
  const r = await w.rel.releaseDue(412); // 405 + 6 bells wait = the job of bell 412
  assert.deepEqual(r.opened, [id]);
  const d = w.read(412).records[0].destinations[0];
  assert.deepEqual([d.state, d.destination, d.p ?? null, d.arrive_bell], ['unrevealed', 'unrevealed', null, 404]);
  assert.equal(w.stats.records_unrevealed, 1);
  // M3 allows an opening up to 2 bells after release_bell + 6 for an unrevealed march: 412 is 1 bell after 411
  assert.ok(412 <= 405 + 6 + 2);
  // and with no DEPART at all (the march never left): the same wait, then unrevealed
  const v = world();
  const x = v.records.add(sealed(), priv('88', 404));
  assert.deepEqual((await v.rel.releaseDue(411)).opened, []);
  assert.deepEqual((await v.rel.releaseDue(412)).opened, [x.id]);
  assert.equal(v.read(412).records[0].destinations[0].state, 'unrevealed');
});

test('a march the brain never sent (the outcome lists no sent depart) opens at release_bell as not_sent, without waiting for a REVEAL', async () => {
  const w = world();
  const { id } = w.records.add(sealed(), priv('77', 404));
  w.records.attachOutcome(id, { actions: [{ intent: 'depart', status: 'refused', code: 'V6' }, { intent: 'build', sig: 's', status: 'sent' }] });
  assert.deepEqual((await w.rel.releaseDue(405)).opened, [id]);
  assert.deepEqual(w.read(405).records[0].destinations, [{ host_id: '77', planned_arrive_bell: 404, via: 'model', state: 'not_sent', destination: 'not_sent', arrive_bell: null }]);
  // an outcome that has not arrived yet is unknown, not "not sent": the job waits
  const v = world();
  const x = v.records.add(sealed(), priv('77', 404));
  assert.deepEqual((await v.rel.releaseDue(405)).opened, []);
  assert.deepEqual(v.records.dueForRelease(405), [x.id], 'still due, still waiting');
});

// ---- FB5 (fix plan F1): boundary of "the real arrival bell has ended", and a two-march decision with one march refused ---------------------
test('FB5 boundary: a march is not ready at its real arrival bell even when the REVEAL is public and release_bell is long past; it is ready one bell later (arrive_bell < bell, not <=)', async () => {
  // pure
  const entry = { full: { release_bell: 400, tx: [{ intent: 'depart', status: 'sent' }] }, priv: priv('77', 404) };
  const find = { depart: () => ({ arrive_bell: 406, depart_bell: 400 }), reveal: () => ({ p: 2, q: 0, tile: 9 }) };
  assert.equal(releaseState({ entry, bell: 405, find }).ready, false, 'bell 405 < arrival 406');
  assert.equal(releaseState({ entry, bell: 406, find }).ready, false, 'the arrival bell itself has not ended: the mutant `arrive_bell <= bell` opens here');
  const at407 = releaseState({ entry, bell: 407, find });
  assert.deepEqual([at407.ready, at407.destinations[0].state, at407.destinations[0].arrive_bell], [true, 'revealed', 406]);
  // through the job: release_bell 403 is not the floor, the REVEAL is logged AT the arrival bell
  const w = world();
  const { id } = w.records.add(sealed({ release_bell: 403 }), priv('77', 404));
  w.send(id);
  w.feed.addEvent(depart('77', 400, 406));
  w.addRev(reveal('77', 406, 406));
  assert.deepEqual((await w.rel.releaseDue(406)).opened, [], 'REVEAL public at 406, release_bell 403, arrival bell 406: still not opened at 406');
  assert.deepEqual((await w.rel.releaseDue(407)).opened, [id]);
  assert.equal(w.read(407).records[0].destinations[0].arrive_bell, 406);
});

test('FB5 two marches, one refused by V6: the refused one opens as not_sent with the other at its arrival, not as "unrevealed" six bells later', async () => {
  const two = priv('77', 404, { intended: [{ host_id: '77', arrive_bell: 404, pq: [2, 0], tile: 9, via: 'model', target_kind: 'camp' }, { host_id: '78', arrive_bell: 405, pq: [3, 0], tile: 5, via: 'model', target_kind: 'camp' }] });
  const tx = [{ intent: 'depart', status: 'sent', sig: 's1' }, { intent: 'depart', status: 'refused', code: 'V6' }];
  // pure: 77 has its DEPART and REVEAL, 78 never left
  const entry = { full: { release_bell: 406, tx }, priv: two };
  const find = { depart: h => (h === '77' ? { arrive_bell: 404, depart_bell: 400 } : null), reveal: h => (h === '77' ? { p: 2, q: 0, tile: 9 } : null) };
  const s = releaseState({ entry, bell: 406, find });
  assert.deepEqual([s.ready, s.waited_out], [true, false], 'the old code waited for 78: ready only at release_bell + 7');
  assert.deepEqual(s.destinations.map(d => [d.host_id, d.state, d.destination ?? null]), [['77', 'revealed', null], ['78', 'not_sent', 'not_sent']]);
  // ambiguity keeps waiting: one depart sent for two intended marches and NEITHER has a public DEPART yet (which one is late is unknown)
  const none = { depart: () => null, reveal: () => null };
  assert.equal(releaseState({ entry, bell: 406, find: none }).ready, false, 'two missing DEPARTs, one refused: not decidable yet');
  assert.equal(releaseState({ entry, bell: 413, find: none }).ready, true, 'the 6-bell wait still ends it');
  // both sent, one DEPART late: nothing was refused, so nothing is not_sent
  const bothSent = { full: { release_bell: 406, tx: [{ intent: 'depart', status: 'sent', sig: 'a' }, { intent: 'depart', status: 'sent', sig: 'b' }] }, priv: two };
  const late = releaseState({ entry: bothSent, bell: 406, find });
  assert.equal(late.ready, false);
  assert.equal(late.destinations[1].state, 'pending');
  // a recall that was sent does not stand in for a refused depart
  const recall = { full: { release_bell: 406, tx: [{ intent: 'recall', status: 'sent', sig: 'r' }, { intent: 'depart', status: 'sent', sig: 'a' }, { intent: 'depart', status: 'refused', code: 'V6' }] }, priv: two };
  assert.equal(releaseState({ entry: recall, bell: 406, find }).destinations[1].state, 'not_sent');
  // through the job with real records
  const w = world();
  const { id } = w.records.add(sealed({ release_bell: 406 }), two);
  w.records.attachOutcome(id, { actions: tx });
  w.feed.addEvent(depart('77', 400, 404));
  w.addRev(reveal('77', 404, 404));
  assert.deepEqual((await w.rel.releaseDue(406)).opened, [id]);
  assert.deepEqual(w.read(406).records[0].destinations.map(d => [d.host_id, d.state]), [['77', 'revealed'], ['78', 'not_sent']]);
});

test('one open/<bell>.json per bell holds ALL records due at that bell and is never rewritten; a record due later in the same bell waits for the next one', async () => {
  const w = world();
  const a = w.records.add(sealed({ index: 1003 }), priv('77', 404));
  const b = w.records.add(sealed({ ai: TAG2, index: 1001, bell: 401, release_bell: 405 }), priv('78', 404));
  const c = w.records.add(sealed({ index: 1005, bell: 401, release_bell: 405 }), priv('79', 404));
  for (const r of [a, b, c]) w.send(r.id);
  w.feed.addEvent(depart('77', 400, 404));
  w.feed.addEvent(depart('78', 401, 404));
  w.feed.addEvent(depart('79', 401, 404));
  w.addRev(reveal('77', 404, 404));
  w.addRev(reveal('78', 404, 404));
  const first = await w.rel.releaseDue(405);
  assert.deepEqual(first.opened.length, 2, 'two are ready, the third has no REVEAL yet');
  const bytes = readFileSync(w.file(405), 'utf8');
  const mtime = statSync(w.file(405)).mtimeMs;
  assert.deepEqual(JSON.parse(bytes).records.map(r => r.index), [1001, 1003], 'sorted by AI index');
  // the third becomes ready later in the same bell: it is NOT appended (the file is served immutable)
  w.addRev(reveal('79', 404, 405));
  const again = await w.rel.releaseDue(405);
  assert.equal(again.repeat, true);
  assert.deepEqual(again.opened, []);
  assert.equal(readFileSync(w.file(405), 'utf8'), bytes);
  assert.equal(statSync(w.file(405)).mtimeMs, mtime);
  // it opens at the next bell, in its own file
  assert.deepEqual((await w.rel.releaseDue(406)).opened, [c.id]);
  assert.deepEqual(w.read(406).records.map(r => r.id), [c.id]);
  assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'pub/open/index.json'), 'utf8')).bells, [405, 406]);
  assert.equal(w.stats.open_files_written, 2);
  // a bell with nothing due writes no file
  assert.deepEqual((await w.rel.releaseDue(407)).opened, []);
  assert.equal(existsSync(w.file(407)), false);
});

test('a decision made under a live Strike Order: sealed with release_bell S + 2, opened then (not before), with no destination of its own; a follow march shows its REVEAL', async () => {
  const w = world();
  const S = 60;
  // a hold decision under the Strike Order: nothing marched, nothing intended
  const hold = w.records.add(sealed({ index: 1004, bell: 56, release_bell: S + 2, choice: { ids: ['c2'], params: {}, council: null, goal_id: 'G1', mem: [] } }), { candidates: [{ id: 'c2', kind: 'hold' }], remembered: [], intended: [] });
  // an autopilot follow march of the Strike Order: arrives exactly at S
  const follow = w.records.add(sealed({ index: 1005, bell: 56, mode: 'autopilot', reason: 'below_gate', release_bell: S + 2, choice: { ids: ['c1'], params: {}, council: null, goal_id: null, mem: [] }, public: { say: [], why: null, why_withheld: null } }), priv('91', S, { intended: [{ host_id: '91', arrive_bell: S, pq: [4, 0], tile: 44, via: 'strike_order', target_kind: null }] }));
  w.send(follow.id);
  w.feed.addEvent(depart('91', 56, S));
  w.addRev(reveal('91', S, S, { p: 4, q: 0, tile: 44 }));
  assert.deepEqual((await w.rel.releaseDue(S + 1)).opened, [], 'not before S + 2: release_bell is the floor');
  const r = await w.rel.releaseDue(S + 2);
  assert.deepEqual(r.opened.sort(), [hold.id, follow.id].sort());
  const o = w.read(S + 2).records;
  const h = o.find(x => x.id === hold.id), f = o.find(x => x.id === follow.id);
  assert.deepEqual(h.destinations, []);
  assert.deepEqual([f.destinations[0].via, f.destinations[0].p, f.destinations[0].q, f.destinations[0].tile, f.destinations[0].arrive_bell], ['strike_order', 4, 0, 44, S]);
  assert.equal(f.by, 'autopilot');
  assert.equal(f.release_bell, S + 2);
});

test('a decision made while the Strike Order is over and its record still sealed (release_bell in the past) opens at the next job; a restart finds the file and does not write it again', async () => {
  const w = world();
  const { id } = w.records.add(sealed({ bell: 70, release_bell: 62, choice: { ids: ['c2'], params: {}, council: null, goal_id: 'G1', mem: [] } }), { candidates: [], remembered: [], intended: [] });
  assert.deepEqual((await w.rel.releaseDue(71)).opened, [id]);
  const bytes = readFileSync(w.file(71), 'utf8');
  // a second process over the same directory: the bell's file exists, the record is marked, nothing is rewritten
  const records2 = createRecords({ aiDir: w.dir, randomBytes: n => Buffer.alloc(n, 7) });
  const rel2 = createRelease({ feed: w.feed, records: records2, pubDir: join(w.dir, 'pub') });
  const r = await rel2.releaseDue(71);
  assert.equal(r.existing, true);
  assert.equal(readFileSync(w.file(71), 'utf8'), bytes);
  assert.deepEqual(records2.dueForRelease(100), []);
  // a crash between the write and the mark: the file exists, the record is not marked -> the restart marks it
  const w2 = world();
  const x = w2.records.add(sealed({ bell: 70, release_bell: 62 }), { candidates: [], remembered: [], intended: [] });
  mkdirSync(join(w2.dir, 'pub/open'), { recursive: true });
  writeFileSync(w2.file(72), JSON.stringify({ v: 1, bell: 72, records: [{ id: x.id }] }));
  assert.equal((await w2.rel.releaseDue(72)).existing, true);
  assert.equal(w2.records.getPrivate(x.id).opened, true, 'the record named by the file is marked opened, not opened again');
  assert.deepEqual(w2.records.dueForRelease(100), []);
});

test('an unsealed or foreign record is never opened by the job; opening never touches a record that is not sealed', async () => {
  const w = world();
  w.records.add({ ...sealed(), sealed: false, release_bell: null, bell: 399 }, priv('77', 404));
  assert.deepEqual((await w.rel.releaseDue(500)).opened, []);
  assert.equal(existsSync(w.file(500)), false);
});

// ---------------------------------------------------------------- the same job over the REAL captured rows (paused m1-exit herald, test chain) through the real feed
test('REAL rows: a captured DEPART and its REVEAL through the real feed release a sealed decision at the end of the real arrival bell, with the destination of the public REVEAL', async () => {
  const rows = loadEvents().events;
  const reveals = rows.filter(r => r.decoded.name === 'REVEAL');
  const departs = rows.filter(r => r.decoded.name === 'DEPART');
  const pair = reveals.map(r => ({ r, d: departs.find(d => d.decoded.key.host_id === r.decoded.payload.host_id && d.decoded.payload.arrive_bell === r.decoded.key.arrive) })).find(x => x.d);
  assert.ok(pair, 'the capture holds a DEPART with its REVEAL');
  const { r: rv, d: dp } = pair;
  const host = rv.decoded.payload.host_id;
  const departBell = dp.decoded.payload.depart_bell;
  const arrive = rv.decoded.key.arrive;
  const h = await startFakeHerald();
  try {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const dir = tmpDir('ai-release-real-');
    const records = createRecords({ aiDir: dir, randomBytes: n => Buffer.alloc(n, 7) });
    const { id } = records.add(sealed({ bell: departBell, release_bell: arrive + 1 }), priv(host, arrive));
    records.attachOutcome(id, { actions: [{ intent: 'depart', sig: 's', status: 'sent' }] });
    const rel = createRelease({ feed, records, pubDir: join(dir, 'pub') });
    assert.deepEqual((await rel.releaseDue(arrive)).opened, [], 'the arrival bell has not ended');
    const out = await rel.releaseDue(arrive + 1);
    assert.deepEqual(out.opened, [id]);
    const o = JSON.parse(readFileSync(join(dir, 'pub/open', `${arrive + 1}.json`), 'utf8')).records[0];
    const d = o.destinations[0];
    assert.deepEqual([d.state, d.p, d.q, d.tile, d.arrive_bell, d.depart_bell], ['revealed', rv.decoded.key.p, rv.decoded.key.q, rv.decoded.payload.tile, arrive, departBell]);
  } finally {
    await h.close();
  }
});

test('REAL rows: a captured DEPART with no REVEAL in the data is opened as unrevealed only after the wait', async () => {
  const rows = loadEvents().events;
  const revealed = new Set(rows.filter(r => r.decoded.name === 'REVEAL').map(r => `${r.decoded.payload.host_id}/${r.decoded.key.arrive}`));
  const dp = rows.filter(r => r.decoded.name === 'DEPART').find(d => !revealed.has(`${d.decoded.key.host_id}/${d.decoded.payload.arrive_bell}`));
  if (!dp) return; // the excerpt holds no such row on this capture
  const host = dp.decoded.key.host_id;
  const departBell = dp.decoded.payload.depart_bell;
  const arrive = dp.decoded.payload.arrive_bell;
  const h = await startFakeHerald();
  try {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const dir = tmpDir('ai-release-real2-');
    const records = createRecords({ aiDir: dir, randomBytes: n => Buffer.alloc(n, 7) });
    const rb = arrive + 1;
    const { id } = records.add(sealed({ bell: departBell, release_bell: rb }), priv(host, arrive));
    records.attachOutcome(id, { actions: [{ intent: 'depart', sig: 's', status: 'sent' }] });
    const rel = createRelease({ feed, records, pubDir: join(dir, 'pub') });
    for (let b = rb; b < rb + 7; b++) assert.deepEqual((await rel.releaseDue(b)).opened, [], `bell ${b}`);
    assert.deepEqual((await rel.releaseDue(rb + 7)).opened, [id]);
    assert.equal(JSON.parse(readFileSync(join(dir, 'pub/open', `${rb + 7}.json`), 'utf8')).records[0].destinations[0].state, 'unrevealed');
  } finally {
    await h.close();
  }
});
