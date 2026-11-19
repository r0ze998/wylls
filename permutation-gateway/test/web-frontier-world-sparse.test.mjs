// A sparse world (permutation-server/web/frontier/map/world.mjs): a season record whose `rings` name their own `d`
// and are not the contiguous 0..n−1. The case that asked for it: a local world whose ONLY seeded ring is d = 128,
// with its home province (128, 0) and Frontier.ringsOpened = 129. The 128 inner rings have no seed and no land:
// none is made up, none is called open, and only ring 128's overview is asked for.
// Pure: no DOM, no fetch (injected overview answers), no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../../permutation-server/web/frontier/map/world.mjs';
import { readOverviews } from '../../permutation-server/web/frontier/map/overviews.mjs';
import { ringSize } from '../../permutation-server/web/frontier/fgeo.mjs';
import { ringOpenOf } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { readFileSync } from 'node:fs';

const ONLY_128 = { rings: [{ d: 128, seed: 'ab' }], ringsOpened: 129, rMax: 128 };
const contiguous = n => Array.from({ length: n }, (_, d) => ({ d, seed: '00' }));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('a world that seeds ring 128 alone: the home is open, the inner rings are not, nothing beyond is', () => {
  const w = W.worldOf(ONLY_128);
  assert.deepEqual(w, { ringsOpen: 129, ringsOpened: 129, rMax: 128, ringProvinces: null, seeded: [128] });
  assert.deepEqual(W.seededRings(w), [128]);
  assert.equal(W.placeOf(w, 128, 0), 'open', 'the home province of ring 128');
  for (const [p, q] of [[0, 128], [-128, 0], [64, 64], [128, -128]]) assert.equal(W.placeOf(w, p, q), 'open', `ring 128 at (${p}, ${q})`);
  // every inner ring: no seed, no land. Not open, and not "on its way" either
  for (const d of [0, 1, 2, 64, 127]) {
    assert.equal(W.placeOf(w, d, 0), 'unopened', `ring ${d}`);
    assert.equal(W.ringSeeded(w, d), false);
  }
  assert.equal(W.placeOf(w, 129, 0), 'outside', 'beyond rMax');
  assert.equal(W.ringSeeded(w, 128), true); assert.equal(W.ringSeeded(w, 129), false); assert.equal(W.ringSeeded(w, -1), false); assert.equal(W.ringSeeded(w, 1.5), false);
  // the overviews wanted: ring 128's and no other (never 0..127, never a made-up ring 0)
  assert.deepEqual(W.overviewRings(w, null), [128]);
  assert.deepEqual(W.overviewRings(w, new Map([[128, null]])), [], 'asked once when the record carries no counts');
  assert.deepEqual(W.partialRings(w), []);
  // through the page's own state (placeNow), and with the season's sync
  const FS = { record: ONLY_128, world: null, worldRings: null };
  assert.equal(W.placeNow(FS, 128, 0), 'open'); assert.equal(W.placeNow(FS, 0, 0), 'unopened');
  const s = W.worldSync(ONLY_128, new Map([[0, new Set()], [128, new Set()]]));
  assert.deepEqual(s.world, w); assert.deepEqual(s.partial, []); assert.deepEqual(s.drop.sort((a, b) => a - b), [0, 128]);
});

test('a sparse world\'s province counts are read at each ring\'s own d: beside the rings, or as a whole array', () => {
  // one count per listed ring
  const beside = W.worldOf({ ...ONLY_128, ringProvinces: [5] });
  assert.equal(beside.ringProvinces[128], 5); assert.equal(beside.ringProvinces[0], undefined, 'the count is not ring 0\'s');
  assert.deepEqual(W.partialRings(beside), [128], `ring 128 holds 5 of ${ringSize(128)} provinces`);
  assert.deepEqual(W.overviewRings(beside, new Map([[128, 5]])), []); assert.deepEqual(W.overviewRings(beside, new Map([[128, 4]])), [128], 'asked again when the count moved');
  assert.equal(W.placeOf(beside, 128, 0, () => new Set(['128,0'])), 'open'); assert.equal(W.placeOf(beside, 127, 1, () => new Set(['128,0'])), 'pending', 'a province of ring 128 not on chain yet');
  // a whole array indexed by d (129 entries): the same reading
  const whole = Array(129).fill(0); whole[128] = 5;
  const byD = W.worldOf({ ...ONLY_128, ringProvinces: whole });
  assert.equal(byD.ringProvinces[128], 5); assert.deepEqual(W.partialRings(byD), [128], 'the zero counts of unseeded rings do not make them "partly created"');
  assert.deepEqual(W.overviewRings(byD, null), [128]);
  // full ring
  const full = W.worldOf({ ...ONLY_128, ringProvinces: [ringSize(128)] });
  assert.deepEqual(W.partialRings(full), []); assert.equal(W.placeOf(full, 128, 0), 'open');
});

test('other sparse shapes: several named rings, out of order, repeated, with a ceiling; malformed ds are not rings', () => {
  const w = W.worldOf({ rings: [{ d: 128 }, { d: 3 }, { d: 0 }, { d: 3 }], ringsOpened: 130, rMax: 130, rMaxCeiling: 140 });
  assert.deepEqual(w.seeded, [0, 3, 128]); assert.equal(w.ringsOpen, 129); assert.equal(w.ringsOpened, 130); assert.equal(w.rMaxCeiling, 128, 'the ceiling stops at the hard limit');
  assert.deepEqual([0, 1, 3, 4, 128, 129, 130, 131].map(d => W.placeOf(w, d, 0)), ['open', 'unopened', 'open', 'unopened', 'open', 'pending', 'unopened', 'beyondHard']);
  assert.deepEqual(W.overviewRings(w, null), [0, 3, 128]);
  // ds that are not rings of the map are dropped, never clamped into one
  const odd = W.worldOf({ rings: [{ d: 128 }, { d: -1 }, { d: 1.5 }, { d: '7' }, { d: 129 }, { d: null }, {}] });
  assert.deepEqual(odd.seeded, [128]); assert.equal(odd.ringsOpen, 129);
  const none = W.worldOf({ rings: [{ d: 'x' }, { d: -5 }] });
  assert.deepEqual(none.seeded, []); assert.equal(none.ringsOpen, 1); assert.equal(W.placeOf(none, 0, 0), 'unopened', 'no ring is open when none is validly named');
  assert.deepEqual(W.overviewRings(none, null), []);
});

test('a contiguous record is read exactly as before: with d = index, without d, one ring, none', () => {
  const REC = { rings: contiguous(5), ringsOpened: 6, rMax: 6, ringProvinces: [1, 6, 12, 18, 24] };
  const w = W.worldOf(REC);
  assert.deepEqual(w, { ringsOpen: 5, ringsOpened: 6, rMax: 6, ringProvinces: [1, 6, 12, 18, 24] }, 'no `seeded` field: the same object as before');
  assert.equal(w.ringProvinces, REC.ringProvinces, 'the counts are the record\'s own array');
  assert.deepEqual([0, 4, 5, 6, 7].map(d => W.placeOf(w, d, 0)), ['open', 'open', 'pending', 'unopened', 'outside']);
  assert.deepEqual(W.seededRings(w), [0, 1, 2, 3, 4]); assert.deepEqual(W.overviewRings(w, null), [0, 1, 2, 3, 4]);
  assert.equal(W.ringSeeded(w, 4), true); assert.equal(W.ringSeeded(w, 5), false);
  // an older record whose rings carry no d, a mixed one whose named ds are their own index, a single ring 0, no record
  assert.deepEqual(W.worldOf({ rings: [{ seed: 'a' }, { seed: 'b' }, { seed: 'c' }] }), { ringsOpen: 3, ringsOpened: 3, rMax: null, ringProvinces: null });
  assert.deepEqual(W.worldOf({ rings: [{ d: 0 }, {}, { d: 2 }] }), { ringsOpen: 3, ringsOpened: 3, rMax: null, ringProvinces: null });
  assert.deepEqual(W.worldOf({ rings: [{ d: 0, seed: '00' }] }), { ringsOpen: 1, ringsOpened: 1, rMax: null, ringProvinces: null });
  for (const record of [undefined, null, {}, { rings: [] }, { rings: 'x' }]) assert.deepEqual(W.worldOf(record), { ringsOpen: 1, ringsOpened: 1, rMax: null, ringProvinces: null });
  assert.deepEqual(W.seededRings(null), []);
});

test('the map source: a ring is open by the world\'s seeded rings, and rings counted from the centre stop at the first gap', () => {
  // the renderer's own test of a ring (map/fmap.mjs ringOpenOf), fed what app.mjs's source() gives it
  const sparse = W.worldOf(ONLY_128), open = ringOpenOf({ ringsOpen: sparse.ringsOpen, seeded: sparse.seeded ?? null });
  assert.equal(open(128), true); for (const d of [0, 1, 64, 127, 129, 200]) assert.equal(open(d), false, `ring ${d}`);
  const whole = W.worldOf({ rings: contiguous(5) }), was = ringOpenOf({ ringsOpen: whole.ringsOpen, seeded: whole.seeded ?? null });
  assert.deepEqual([0, 4, 5].map(was), [true, true, false], 'a contiguous world: below ringsOpen, as before');
  assert.deepEqual([0, 4, 5].map(ringOpenOf({ ringsOpen: 5 })), [true, true, false], 'a source without `seeded` is the old source');
  assert.deepEqual([0, 1].map(ringOpenOf({})), [true, false]); assert.deepEqual([0, 1].map(ringOpenOf(null)), [true, false]);
  assert.deepEqual([0, 3, 4, 128].map(ringOpenOf({ ringsOpen: 129, seeded: [0, 3, 128] })), [true, true, false, true]);
  // rings counted from the centre (the rings a first village may be placed in)
  assert.equal(W.contiguousRings(sparse), 0, 'ring 128 alone: no ring from the centre');
  assert.equal(W.contiguousRings(whole), 5); assert.equal(W.contiguousRings(W.worldOf({ rings: [{ d: 0 }, { d: 1 }, { d: 128 }] })), 2); assert.equal(W.contiguousRings(null), 0);
});

test('the page reads the world\'s extent, not the record\'s length: source, roster, minimap, home rings, fog and hover', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), fmap = read('map/fmap.mjs');
  assert.doesNotMatch(app, /rings\?\.length|rings\.length/, 'no place of the page counts rings by the record\'s length');
  assert.match(app, /const worldNow = \(\) => FS\.world \?\? worldOf\(FS\.record\);\nconst ringsOpenNow = \(\) => Math\.max\(1, worldNow\(\)\.ringsOpen\);\nconst seededNow = \(\) => seededRings\(worldNow\(\)\);/);
  assert.match(app, /return \{ overviews: FS\.overviews, ringsOpen: ringsOpenNow\(\), seeded: worldNow\(\)\.seeded \?\? null, own,/, 'the map source carries the seeded rings');
  assert.equal(app.split('for (const d of seededNow()) rosterRef.ensure(d);').length - 1, 2, 'the roster is asked for the seeded rings only (both places)');
  assert.match(app, /rings: ringsOpenNow\(\), seeded: worldNow\(\)\.seeded \?\? null, own:/, 'the minimap is given the seeded rings'); assert.match(app, /minimap\.frameOf\(ringsOpenNow\(\) \+ 1, r\.width\);/);
  assert.equal(app.split('homeRingsOpen(FS.season, ').length - 1, 1); assert.equal(app.split('homeRingsOf(FS, ').length - 1, 1, 'the tap: home.mjs homeRingsOf (wide-local-playable)'); assert.equal(app.split('contiguousRings(worldNow())').length - 1, 2, 'home rings are counted from the centre without a gap');
  assert.match(app, /function loadOverviews\(herald, rings = overviewRings\(FS\.world, FS\.overviewTaken\)\)/, 'the boot asks for the overviews the world wants');
  // the renderer: every "is this ring open" goes through the seeded test; ringsOpen alone still bounds sheet, sea and camera
  assert.match(fmap, /const ringIsOpen = ringOpenOf\(src\);/);
  assert.match(fmap, /fogLevel\(\{ ringOpen: ringIsOpen\(ringOf\(p, q\)\),/); assert.match(fmap, /return ringIsOpen\(ringOf\(at\.p, at\.q\)\) \? 'clear' : 'unopened';/);
  assert.match(fmap, /const open = ringIsOpen\(ringOf\(pr\.p, pr\.q\)\);/); assert.match(fmap, /ringOpenOf\(src\)\(ringOf\(this\.hover\.p, this\.hover\.pq\)\) \? this\.hover : null;/);
  assert.doesNotMatch(fmap, /ringOf\([^)]*\) < \(?(src\.)?ringsOpen/, 'no bare "ring < ringsOpen" test of openness is left');
});

test('the overview queue reads ring 128 of the sparse world and refuses the inner rings it is asked for', async () => {
  const FS = { world: W.worldOf(ONLY_128), overviews: new Map(), holdings: [] }, calls = [], pending = [];
  const herald = { overview: ring => new Promise(resolve => { calls.push(ring); pending.push(() => resolve({ ok: true, ring, provinces: [] })); }) };
  // the default request: what the world says is wanted
  const byDefault = readOverviews(FS, { herald });
  await flush(); assert.deepEqual(calls, [128]);
  // an explicit request for rings 0..3 and 128 (a caller that counts rings from zero): only 128 is a ring of this world
  const explicit = readOverviews(FS, { herald, rings: [0, 1, 2, 3, 128, 129] });
  await flush(); assert.deepEqual(calls, [128], 'no read of an unseeded ring; the read of 128 is shared');
  pending.splice(0).forEach(f => f()); await flush();
  assert.deepEqual(await byDefault, [true]); assert.deepEqual(await explicit, [true], 'one answer: the one valid ring');
  assert.deepEqual([...FS.overviews.keys()], [128]); assert.deepEqual([...FS.overviewTaken.keys()], [128]);
  assert.deepEqual(await readOverviews(FS, { herald, rings: [0] }), [], 'ring 0 alone: nothing to read');
  assert.equal(calls.length, 1);
  // the world grows contiguous later (a fresh record): the old sparse reads do not carry over as "all rings"
  FS.world = W.worldOf({ rings: contiguous(2) });
  const grown = readOverviews(FS, { herald }); await flush();
  assert.deepEqual(calls.slice(1).sort(), [0, 1]); pending.splice(0).forEach(f => f()); await flush(); assert.deepEqual(await grown, [true, true]);
});

test('the survey of a sparse world: the seeded ring is charted, the unseeded inner rings are cloud, for a viewer and for a spectator', async () => {
  const { buildSurvey, openSurvey, createSurveyor, L0, L1, L3 } = await import('../../permutation-server/web/frontier/map/survey.mjs');
  const { surveyInput } = await import('../../permutation-server/web/frontier/map/viewer.mjs');
  const world = W.worldOf(ONLY_128);
  // what the page hands the survey: the world's extent and its seeded rings, not the record's length (1)
  const play = surveyInput({ mode: 'play', record: ONLY_128, world, holdings: [] });
  assert.equal(play.ringsOpen, 129); assert.deepEqual(play.seeded, [128]);
  const fromRecord = surveyInput({ mode: 'play', record: ONLY_128, holdings: [] });
  assert.equal(fromRecord.ringsOpen, 129, 'no FS.world yet: read from the record'); assert.deepEqual(fromRecord.seeded, [128]);
  const watch = surveyInput({ mode: 'spectate', record: ONLY_128, world });
  assert.deepEqual(watch, { mode: 'spectate', ringsOpen: 129, seeded: [128] });
  // a viewer: ring 128 is on the chart, rings 0 and 64 and 127 are not there, ring 129 is beyond the map
  const s = buildSurvey({ ringsOpen: play.ringsOpen, seeded: play.seeded });
  assert.equal(s.province(128, 0).kind, 'chart'); assert.equal(s.levelOf(128, 0), L1);
  for (const [p, q] of [[0, 0], [64, 0], [127, 0], [129, 0]]) {
    assert.equal(s.province(p, q).kind, 'cloud', `ring ${p}`); assert.equal(s.levelOf(p, q, 0), L0, `ring ${p} tile`);
  }
  // a spectator: every tile of the one ring in sight, nothing of the inner rings
  const o = openSurvey(watch.ringsOpen, watch.seeded);
  assert.equal(o.province(128, 0).kind, 'sight'); assert.equal(o.levelOf(128, 0, 0), L3);
  assert.equal(o.province(0, 0).kind, 'cloud'); assert.equal(o.levelOf(0, 0, 0), L0);
  // the surveyor carries the membership through, and a change of membership alone is a new survey
  const surveyor = createSurveyor({ storage: { get: () => null, set: () => {} } });
  const a = surveyor(watch);
  assert.equal(a.province(0, 0).kind, 'cloud'); assert.equal(a.province(128, 0).kind, 'sight');
  const b = surveyor({ mode: 'spectate', ringsOpen: 129 });
  assert.notEqual(b, a); assert.equal(b.province(0, 0).kind, 'sight', 'a contiguous world of 129 rings has its centre');
  // a contiguous world is handed exactly what it was: no `seeded` key at all
  const plain = surveyInput({ mode: 'spectate', record: { rings: contiguous(3) } });
  assert.deepEqual(plain, { mode: 'spectate', ringsOpen: 3 });
  assert.equal(buildSurvey({ ringsOpen: 3 }).province(0, 0).kind, 'chart');
});

test('the march route refresh reads the sparse world\'s own ring, and 0 .. n − 1 of a contiguous one', async () => {
  const source = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  // (fd1367e1, ⑦ 2026-11-17: a refresh is also for one pinned world — `overviewWorld` — and applies a season record only
  //  when it is the pinned world's and no later answer was applied: the block now names providerWorld, recordOfPin and
  //  the askSeason / seasonStale / takeSeason order, handed in below as the block's other dependencies are)
  const start = source.indexOf('let overviewRefresh = null, overviewSource = null, overviewWorld = null;');
  const end = source.indexOf('// ------------------------------------------------------------------ the composer', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /const rings = world\?\.seeded \? \[\.\.\.world\.seeded\] : Array\.from\(\{ length: count \}/);
  assert.match(block, /if \(r\?\.ok && r\.record && recordOfPin\(r\.record\) && !seasonStale\(seq\)\) \{\n\s*applySeasonRecord\(FS, r\.record,/);
  const run = async (record, { ofPin = true } = {}) => {
    const asked = [];
    let seasonAsked = 0, seasonTaken = 0;
    const FS = { record: null, world: null, overviews: new Map(), season: {}, nowBell: 5, clock: null };
    const herald = { season: async () => ({ ok: true, record }) };
    const isolated = new Function('FS', 'herald', 'applySeasonRecord', 'readOverviews', 'conquestEnabled', 'invalidate',
      'providerWorld', 'recordOfPin', 'askSeason', 'seasonStale', 'takeSeason',
      `${block}\nreturn { refresh: refreshOverviews };`);
    const api = isolated(FS, herald, (fs, rec) => { fs.record = rec; fs.world = W.worldOf(rec); },
      async (_fs, { rings }) => { asked.push(...rings); return rings.map(() => true); }, () => false, () => {},
      () => '0|localnet|P|S', () => ofPin,
      // (the order of season answers, as controller.mjs keeps it)
      () => { seasonAsked += 1; return seasonAsked; }, seq => !(seq > seasonTaken), seq => { if (!(seq > seasonTaken)) return false; seasonTaken = seq; return true; });
    await api.refresh(5);
    return asked;
  };
  assert.deepEqual(await run(ONLY_128), [128]);
  assert.deepEqual(await run({ rings: [{ d: 2, seed: '00' }, { d: 128, seed: '00' }], ringsOpened: 129 }), [2, 128]);
  assert.deepEqual(await run({ rings: contiguous(3) }), [0, 1, 2]);
  // a record of another world is not applied: the page knows no ring of it, and reads only what it had (here: ring 0)
  assert.deepEqual(await run(ONLY_128, { ofPin: false }), [0], "another world's sparse ring is not read as this world's");
});
