// The nation choice's free-land count under the first-home placement
// (fland.mjs freeByNation, screens/join.mjs factionCards and the confirm
// line): the same homeNation and seasonPlace the home planner and the map
// read. Under the wedge rule the six numbers are freeByWedge's exactly;
// under the dispersed rule a nation's number is its scattered provinces'
// (uneven free land across provinces, so a wedge count would be caught);
// a placement without its seed gives no number at all, never zero and never
// the wedge's. freeByWedge itself, the program's per-wedge accounting, is
// untouched. Pure: no canvas, no chain, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLACEMENT_DISPERSED, homeNation, provinceIndex, ringProvinces, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { FIRST_TICKET_RING, freeByNation, freeByWedge } from '../../permutation-server/web/frontier/fland.mjs';
import { seasonPlace } from '../../permutation-server/web/frontier/home.mjs';
import { factionCards, renderNations } from '../../permutation-server/web/frontier/screens/join.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const seed = n => new Array(32).fill(n);
const dispersed = { placement: PLACEMENT_DISPERSED, heartlandMaxRing: 3, genesisSeed: seed(1) };
const unreadable = [{ placement: 1 }, { placement: 1, genesisSeed: [1] }, { placement: 1, genesisSeed: '01'.repeat(32) }, { placement: 2, genesisSeed: seed(1) }];

/** An overview record with `n` free, unowned sites (the rest holdings), or `held` sites free but owned. */
const record = (pr, n, { held = 0 } = {}) => ({ p: pr.p, q: pr.q, sites: Array.from({ length: 12 }, (_, i) => (i < n + held ? 0 : 1)), owners: Array.from({ length: 12 }, (_, i) => (i >= n && i < n + held ? 3 : 7)) });
/** Rings 1 .. 3 with free land that differs from province to province (never the same in a wedge's provinces of one ring). */
function uneven() {
  const ov = new Map();
  for (const ring of [1, 2, 3]) ov.set(ring, { ring, provinces: ringProvinces(ring).map(pr => record(pr, (provinceIndex(pr.p, pr.q) * 7) % 9, { held: provinceIndex(pr.p, pr.q) % 2 })) });
  return ov;
}
const freeOf = rec => rec.sites.filter((s, i) => (s === 0 || s === 3) && rec.owners[i] === 7).length;
const sumBy = (ov, whose) => { const out = [0, 0, 0, 0, 0, 0]; for (const o of ov.values()) if (o.ring >= FIRST_TICKET_RING) for (const r of o.provinces) { const f = whose(r.p, r.q); if (f !== null) out[f] += freeOf(r); } return out; };

test('the wedge rule: freeByNation is freeByWedge, number for number, with and without placement 0 said', () => {
  const ov = uneven();
  const wedge = freeByWedge(ov);
  assert.deepEqual(wedge, sumBy(ov, wedgeOf), 'the wedge count itself: rings 2 and 3, free and unowned');
  assert.ok(new Set(wedge).size >= 3, 'uneven across nations');
  assert.deepEqual(freeByNation(ov), wedge);
  assert.deepEqual(freeByNation(ov, undefined), wedge);
  assert.deepEqual(freeByNation(ov, { placement: 0 }), wedge);
  assert.deepEqual(freeByNation(ov, seasonPlace({ conquestParams: { placement: 0 }, genesisSeed: seed(1) })), wedge);
  assert.deepEqual(freeByNation(new Map()), [0, 0, 0, 0, 0, 0]);
});

test('the dispersed rule: a nation\'s number is its scattered provinces\', not its wedge\'s; the seed decides which', () => {
  const ov = uneven();
  const want = sumBy(ov, (p, q) => homeNation(p, q, dispersed));
  assert.deepEqual(freeByNation(ov, dispersed), want);
  assert.deepEqual(freeByNation(ov, seasonPlace({ conquestParams: { placement: 1, heartlandMaxRing: 3 }, genesisSeed: Uint8Array.from(seed(1)) })), want, 'the decoded Season\'s seed');
  assert.notDeepEqual(want, freeByWedge(ov), 'the wedge count would be wrong');
  assert.notDeepEqual(freeByNation(ov, { ...dispersed, genesisSeed: seed(2) }), want, 'another seed, other provinces, other numbers');
  assert.deepEqual(freeByWedge(ov), sumBy(ov, wedgeOf), 'freeByWedge keeps counting the wedge');
  assert.deepEqual(freeByNation(ov, dispersed), want, 'and freeByNation does not change it');
  // one province alone with free land: it counts for the nation whose first homes it takes, and for no other
  const pr = ringProvinces(2).find(x => homeNation(x.p, x.q, dispersed) !== wedgeOf(x.p, x.q));
  const alone = new Map([[2, { ring: 2, provinces: ringProvinces(2).map(x => record(x, x.p === pr.p && x.q === pr.q ? 5 : 0)) }], [3, { ring: 3, provinces: ringProvinces(3).map(x => record(x, 0)) }]]);
  const n = freeByNation(alone, dispersed), w = freeByWedge(alone);
  assert.equal(n[homeNation(pr.p, pr.q, dispersed)], 5);
  assert.equal(n[wedgeOf(pr.p, pr.q)], 0, 'the wedge\'s nation gets none of it');
  assert.equal(w[wedgeOf(pr.p, pr.q)], 5, 'while the per-wedge accounting still puts it in the wedge');
  assert.equal(n.reduce((a, b) => a + b, 0), 5);
  // ring 1 never counts, under either rule
  const ring1 = new Map([[1, { ring: 1, provinces: ringProvinces(1).map(x => record(x, 12)) }]]);
  assert.deepEqual(freeByNation(ring1, dispersed), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(freeByNation(ring1), [0, 0, 0, 0, 0, 0]);
});

test('a placement without its seed: the count is unavailable (null), never zero and never the wedge\'s', () => {
  const ov = uneven();
  for (const place of unreadable) assert.equal(freeByNation(ov, place), null, JSON.stringify(place));
  assert.equal(freeByNation(ov, seasonPlace({ conquestParams: { placement: 1 } })), null);
  assert.equal(freeByNation(new Map(), { placement: 1 }), null, 'with no overviews either: unavailable, not "no free land"');
});

test('the nation choice shows the nation\'s count, and says the count is not known when the seed is missing', () => {
  setLang('ja');
  const ov = uneven();
  const base = { clock: { genesisTs: 1000 }, chain: { now: () => 2000 }, wallet: { address: 'w' }, joinDraft: { faction: 2 }, overviews: ov };
  // the wedge rule (an M1 season and a conquest season with placement 0): the numbers as before
  for (const season of [{ programVersion: 3 }, { programVersion: 3, conquestParams: { placement: 0 }, genesisSeed: seed(1) }]) {
    const cards = factionCards({ ...base, season });
    assert.deepEqual(cards.map(c => c.free), freeByWedge(ov));
    assert.match(String(renderNations({ ...base, season })), new RegExp(`村を置ける場所があと約 ${freeByWedge(ov)[2]} あります`));
  }
  // the dispersed rule: the nation's own number (not the wedge's), the chosen nation's in the confirm line
  const season = { programVersion: 3, conquestParams: { placement: 1, heartlandMaxRing: 3 }, genesisSeed: Uint8Array.from(seed(1)) };
  const cards = factionCards({ ...base, season });
  assert.deepEqual(cards.map(c => c.free), freeByNation(ov, dispersed));
  assert.notDeepEqual(cards.map(c => c.free), freeByWedge(ov));
  const page = String(renderNations({ ...base, season }));
  assert.match(page, new RegExp(`村を置ける場所があと約 ${freeByNation(ov, dispersed)[2]} あります`));
  assert.doesNotMatch(page, /いまは分かりません/);
  // the seed missing: no number on any card, and the line says the count is not known (no "about 0", no wedge number)
  const blind = { programVersion: 3, conquestParams: { placement: 1, heartlandMaxRing: 3 } };
  assert.ok(factionCards({ ...base, season: blind }).every(c => c.free === null));
  const unknown = String(renderNations({ ...base, season: blind }));
  assert.match(unknown, /この国の土地に村を置ける場所の数は、いまは分かりません。/);
  assert.doesNotMatch(unknown, /村を置ける場所があと約/);
  assert.match(unknown, /data-act="home-confirm"/, 'the choice itself is not blocked by an unknown count: the program decides the placement');
  // nothing chosen: no line either way
  // (the count's own words only: the season's deadline line — workstream 07's seasonterms — may say 「あと約」 of time)
  assert.doesNotMatch(String(renderNations({ ...base, season: blind, joinDraft: null })), /村を置ける場所の数は、いまは分かりません|村を置ける場所があと約/);
  setLang('en');
  assert.match(String(renderNations({ ...base, season: blind })), /is not known yet/);
  setLang('ja');
});

test('join.mjs reads the nation\'s count through the placement; the program\'s per-wedge accounting stays where it is', () => {
  const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url), src = f => readFileSync(new URL(f, WEB), 'utf8');
  assert.match(src('screens/join.mjs'), /freeByNation\(FS\.overviews \?\? new Map\(\), seasonPlace\(FS\.season\), \{ ringsOpen: Number\.isInteger\(open\) \? homeRingsOpen\(FS\.season, open\) : Infinity \}\)/);
  assert.doesNotMatch(src('screens/join.mjs'), /freeByWedge|homeWedge/);
  assert.match(src('onboarding.mjs'), /const free = freeByWedge\(overviews\);/, 'the adjacent-wedge offer (§5.9) still reads the wedge');
  assert.match(src('fland.mjs'), /export function freeByWedge\(overviews\) \{\n  const out = \[0, 0, 0, 0, 0, 0\];\n  for \(const ov of overviews\.values\(\)\) \{\n    if \(!ov\?\.provinces \|\| ov\.ring < FIRST_TICKET_RING\) continue;\n    for \(const pr of ov\.provinces\) \{\n      const w = wedgeOf\(pr\.p, pr\.q\);/, 'freeByWedge unchanged');
});
