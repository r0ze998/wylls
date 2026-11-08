// node --test workstreams/14-central-tower/game/centre.test.mjs
// The centre's facts read from the herald's S1 feeds. The feeds below are
// SYNTHETIC, written in the shape the herald's own source documents and
// writes (herald/src/caravan.rs, structure.rs); a test pins the field names
// to that source so a renamed field fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { centreFacts, feedProblems, provenanceOf, SCHEMA, VERIFIED } from './centre.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const place = (p, q, tile = 20, kind = 1) => ({ kind, p, q, at: 2, gen: 1, tile });
const caravan = (tag, seq, faction, provinces, cargo = [0, 100, 0, 0, 0, 0, 0, 0], extra = {}) => ({
  ownerTag: String(tag), seq, faction, src: place(...provinces[0]), dst: place(...provinces[provinces.length - 1]), steps: 7, cargo,
  arriveTs: 1790000000, runs: [], raided: false, path: Array(12).fill(0), provinces, ...extra,
});
const FEEDS = {
  caravans: {
    v: 1,
    moving: [
      caravan(11, 0, 0, [[3, 0], [2, 0], [1, 0], [0, 0], [-1, 0]]),          // through the Concord, nation 0 to nation 3
      caravan(12, 0, 1, [[2, 0], [1, 0]], [0, 0, 50, 0, 0, 0, 0, 0]),         // into a Seat (ring 1), not the Concord
      caravan(13, 0, 2, [[3, -1], [3, 0]]),                                    // stays outside
      caravan(14, 1, 4, [[0, 0], [0, -1]], [0, 0, 0, 0, 0, 0, 0, 0], { raided: true, holderTag: '99', wornBps: 0 }),  // from a vault in the Concord, raided (④'s extra fields)
    ],
    vaults: [
      { p: 0, q: 0, tile: 40, ownerTag: '21', faction: 0, gen: 1 },          // a private vault in the Concord
      { p: 1, q: 0, tile: 3, ownerTag: '22', faction: 3, gen: 1 },           // in nation 0's Seat, held by nation 3
      { p: 4, q: 0, tile: 9, ownerTag: '23', faction: 0, gen: 1 },           // outside the centre
    ],
  },
  structures: {
    v: 1,
    structures: [
      { p: 0, q: 0, tile: 30, kind: 1, faction: 2, ownerTag: '31', gen: 1, notify: 1, cover: [], sent: 0 },   // a watchtower in the Concord
      { p: 0, q: 0, tile: 31, kind: 2, faction: 2, ownerTag: '31', gen: 1, notify: 1, cover: [], sent: 0 },   // a palisade in the Concord
      { p: 5, q: 0, tile: 10, kind: 1, faction: 0, ownerTag: '32', gen: 1, notify: 1, cover: [], sent: 0 },   // outside
    ],
    sightings: [
      { seq: 1, bell: 290, tower: { p: 0, q: 0, tile: 30 }, towerFaction: 2, notify: 1, ownerTag: '31', what: 'caravan', faction: 0, p: 0, q: 0, tile: 29, subject: '11' },
      { seq: 2, bell: 291, tower: { p: 5, q: 0, tile: 10 }, towerFaction: 0, notify: 1, ownerTag: '32', what: 'depart', faction: 1, p: 5, q: 0, tile: 11, subject: '9' },
    ],
  },
};

test('the field names this reader uses are the ones the herald writes', () => {
  const car = readFileSync(`${repo}frontier-node/crates/herald/src/caravan.rs`, 'utf8');
  const str = readFileSync(`${repo}frontier-node/crates/herald/src/structure.rs`, 'utf8');
  for (const k of ['"v"', '"moving"', '"vaults"', '"ownerTag"', '"seq"', '"faction"', '"cargo"', '"raided"', '"provinces"', '"p"', '"q"', '"tile"', '"gen"']) assert.ok(car.includes(`${k}:`), `caravan.rs writes ${k}`);
  for (const k of ['"v"', '"structures"', '"sightings"', '"kind"', '"faction"', '"ownerTag"', '"tower"', '"towerFaction"', '"what"', '"bell"']) assert.ok(str.includes(`${k}:`), `structure.rs writes ${k}`);
  const kinds = readFileSync(`${repo}permutation-rules/src/frontier/structure.rs`, 'utf8');
  assert.match(kinds, /KIND_TOWER: u8 = 1;/); assert.match(kinds, /KIND_PALISADE: u8 = 2;/); assert.match(kinds, /KIND_FORT: u8 = 3;/);
});

test('what stands at the centre and who holds it', () => {
  const out = centreFacts({ ...FEEDS, observedAt: 'bell 300' });
  assert.equal(out.schema, SCHEMA);
  assert.equal(out.world.ends, false);
  assert.ok(out.facts.every(f => f.verified === VERIFIED));
  assert.deepEqual(out.facts.map(f => f.seq), out.facts.map((_, i) => i));
  const vaults = out.facts.filter(f => f.kind === 'centre.vault');
  assert.deepEqual(vaults.map(v => [v.p, v.q, v.ring, v.concord, v.faction]), [[0, 0, 0, true, 0], [1, 0, 1, false, 3]]);
  const st = out.facts.filter(f => f.kind === 'centre.structure');
  assert.deepEqual(st.map(s => [s.tile, s.structureKind, s.concord]), [[30, 'tower', true], [31, 'palisade', true]]);
  assert.equal(out.summary.vaultsInConcord, 1);
  assert.equal(out.summary.structuresInConcord, 2);
});

test('caravans whose walk enters the centre', () => {
  const out = centreFacts(FEEDS);
  const tr = out.facts.filter(f => f.kind === 'centre.transit');
  assert.deepEqual(tr.map(t => [t.ownerTag, t.throughConcord, t.innermostRing, t.raided]), [['11', true, 0, false], ['12', false, 1, false], ['14', true, 0, true]]);
  assert.equal(out.summary.moving, 4);
  assert.equal(out.summary.throughInner, 3);
  assert.equal(out.summary.throughConcord, 2);
  assert.equal(out.summary.cargoConcordShare, 100 / 250);
  assert.equal(out.summary.cargoInnerShare, 150 / 250);
});

test('only towers standing at the centre give centre sightings', () => {
  const s = centreFacts(FEEDS).facts.filter(f => f.kind === 'centre.sighting');
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].what, s[0].faction, s[0].towerFaction], ['caravan', 0, 2]);
});

test('the order does not depend on the feed\'s order', () => {
  const shuffled = { caravans: { ...FEEDS.caravans, moving: [...FEEDS.caravans.moving].reverse(), vaults: [...FEEDS.caravans.vaults].reverse() }, structures: { ...FEEDS.structures, structures: [...FEEDS.structures.structures].reverse() } };
  assert.deepEqual(centreFacts(shuffled), centreFacts(FEEDS));
});

test('a feed it cannot read is refused, not guessed', () => {
  assert.ok(centreFacts({ caravans: { v: 2, moving: [], vaults: [] } }).refused.length);
  assert.ok(centreFacts({ caravans: { v: 1, moving: [{ ownerTag: 'x', provinces: [[0, 0]] }], vaults: [] } }).refused.length);
  assert.ok(feedProblems({ caravans: FEEDS.caravans, structures: { v: 1, structures: [{ p: 0 }] } }).length);
  assert.deepEqual(feedProblems(FEEDS), []);
  const noStructures = centreFacts({ caravans: FEEDS.caravans });
  assert.equal(noStructures.summary.structuresAtCentre, 0);
});

test('no winner, score or end in the output', () => {
  const text = JSON.stringify(centreFacts(FEEDS));
  assert.equal(text.match(/"(winner|victory|score|rank|prize|reward)"/), null);
});

test('the command line reads saved feeds the same way', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/ws14-centre-${process.pid}`;
  execFileSync('mkdir', ['-p', tmp]);
  const fs = { c: `${tmp}/caravans.json`, s: `${tmp}/structures.json` };
  execFileSync('sh', ['-c', `cat > ${fs.c}`], { input: JSON.stringify(FEEDS.caravans) });
  execFileSync('sh', ['-c', `cat > ${fs.s}`], { input: JSON.stringify(FEEDS.structures) });
  const out = JSON.parse(execFileSync(process.execPath, [`${dir}centre-cli.mjs`, '--caravans', fs.c, '--structures', fs.s, '--at', 'bell 300'], { encoding: 'utf8' }));
  assert.deepEqual(out, centreFacts({ ...FEEDS, observedAt: 'bell 300' }));
  execFileSync('rm', ['-rf', tmp]);
});

const STATUS = (n, slot) => ({ v: 1, foldedThrough: n, events: String(n * 3), lastSlot: slot, live: null, provinces: 37, rings: [0, 1, 2, 3], alarms: { rewrites: 0, badRecords: 0, clashMismatch: 0, clashUnchecked: 0, writeErrors: 0 } });

test('/h/status fields this reader uses are the ones the herald serves', () => {
  const srv = readFileSync(`${repo}frontier-node/crates/herald/src/server.rs`, 'utf8');
  for (const k of ['"v"', '"foldedThrough"', '"events"', '"lastSlot"', '"alarms"']) assert.ok(srv.includes(`${k}:`), `server.rs serves ${k}`);
});

test('provenance: where the herald\'s fold stood, never guessed', () => {
  const still = provenanceOf({ before: STATUS(9, 77), after: STATUS(9, 77) });
  assert.equal(still.stable, true);
  assert.deepEqual([still.before.foldedThrough, still.before.events, still.before.lastSlot], [9, '27', 77]);
  assert.equal(still.slotCommitment, 'not stated by the herald');
  const moved = provenanceOf({ before: STATUS(9, 77), after: STATUS(10, 80) });
  assert.equal(moved.stable, false);
  assert.match(moved.why, /moved/);
  const none = provenanceOf(null);
  assert.equal(none.from, null); assert.equal(none.stable, null);
  assert.equal(centreFacts(FEEDS).provenance.from, null);
  assert.equal(provenanceOf({ before: { v: 2 }, after: null }).from, null);
});

test('the command line reads a herald by public GETs and records its fold', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const body = req.url === '/h/caravans.json' ? FEEDS.caravans : req.url === '/h/structures.json' ? FEEDS.structures : req.url === '/h/status' ? STATUS(9, 77) : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'NotFound' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const text = await new Promise((resolve, reject) => execFile(process.execPath, [`${dir}centre-cli.mjs`, '--herald', url, '--at', 'bell 300'], (e, out) => (e ? reject(e) : resolve(out))));
  server.close();
  const out = JSON.parse(text);
  assert.deepEqual(seen, ['GET /h/status', 'GET /h/caravans.json', 'GET /h/structures.json', 'GET /h/status']);
  assert.equal(out.provenance.stable, true);
  assert.deepEqual(out.facts, centreFacts(FEEDS).facts);
  assert.deepEqual(out.summary, centreFacts(FEEDS).summary);
});
