// Workstream 08 (candidate): an instant-home Season whose heartland has no free first home for the viewer's nation.
// PlaceHome places only in rings 2 .. heartland_max_ring; only first homes count toward the crowding rule that grows
// the map (permutation-frontier map_growth_runtime_tests: first homes alone stop the map at ring 5). The program's
// ticket path is unchanged and still dispatched, so the page files tickets into the nation's own open rings once
// planHomes says NoFreeHome (home.mjs heartlandFull, controller needsHomeChoice, the join screen, the plate's line).
// Pure: no chain, no keys, no addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ringProvinces, ringOf, wedgeOf, homeNation } from '../../permutation-server/web/frontier/fgeo.mjs';
import { heartlandFull, seasonPlace } from '../../permutation-server/web/frontier/home.mjs';
import { planTicket } from '../../permutation-server/web/frontier/fjoin.mjs';
import { render as join } from '../../permutation-server/web/frontier/screens/join.mjs';
import { waitingLine } from '../../permutation-server/web/frontier/hud/hud.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const source = f => readFileSync(new URL(f, WEB), 'utf8');
const seed = Uint8Array.from(new Array(32).fill(1));
const v2 = { layoutVersion: 2, programVersion: 4, conquestParams: { placement: 0, heartlandMaxRing: 3 } };
const v2d = { ...v2, conquestParams: { placement: 1, heartlandMaxRing: 3 }, genesisSeed: seed };
const m1 = { layoutVersion: 1, programVersion: 1 };
const full = (faction = 0) => ({ code: 'NoFreeHome', text: 'none' });
const viewer = (over = {}) => ({
  season: v2, citizen: { faction: 0, flags: 1 }, holdings: [], wallet: { address: 'w' }, session: { key: 's' },
  sessionProblem: null, land: { stage: 'joined' }, homeChoice: { faction: 0, error: full(), candidates: [] }, ...over,
});

test('heartlandFull: an instant-home Season, a joined viewer without a village, NoFreeHome for the viewer\'s nation', () => {
  assert.equal(heartlandFull(viewer()), true);
  assert.equal(heartlandFull(viewer({ season: v2d })), true, 'the dispersed placement too');
  assert.equal(heartlandFull(viewer({ season: m1 })), false, 'M1 tickets: not an instant-home Season');
  assert.equal(heartlandFull(viewer({ citizen: null })), false, 'not joined yet: the home choice stays');
  assert.equal(heartlandFull(viewer({ holdings: [{}] })), false, 'a village already');
  assert.equal(heartlandFull(viewer({ homeChoice: { faction: 0, error: { code: 'Unavailable' } } })), false, 'a read failure is not a full heartland');
  assert.equal(heartlandFull(viewer({ homeChoice: { faction: 1, error: full() } })), false, 'another nation\'s answer');
  assert.equal(heartlandFull(viewer({ homeChoice: { faction: 0, error: null, candidates: [{}] } })), false, 'a free home');
  assert.equal(heartlandFull(null), false);
});

test('the join screen: the ticket view with its reason while the heartland is full; the instant card otherwise', () => {
  const fallback = String(join(viewer()));
  assert.match(fallback, /data-home-fallback/);
  assert.match(fallback, /自分の国の外側の土地に村の申し込みを出します/);
  assert.doesNotMatch(fallback, /data-act="home-confirm"/, 'no PlaceHome button the program would refuse');
  const instant = String(join(viewer({ homeChoice: { faction: 0, error: null, candidates: [] } })));
  assert.match(instant, /data-act="home-confirm"/);
  assert.doesNotMatch(instant, /data-home-fallback/);
});

test('the plate\'s line follows the ticket while the heartland is full', () => {
  assert.doesNotMatch(String(waitingLine(viewer())), /NoFreeHome/, 'not the home choice\'s NoFreeHome failure');
  assert.match(String(waitingLine(viewer({ homeChoice: { faction: 0, error: full() }, citizen: null }))), /NoFreeHome/,
    'before joining the home choice still speaks');
});

test('the controller: no home choice (and so autoTicket runs) while the heartland is full', () => {
  const src = source('controller.mjs');
  const body = src.slice(src.indexOf('function needsHomeChoice()'), src.indexOf('function updateHomeGrant()'));
  assert.match(body, /if \(heartlandFull\(FS\)\) return false;/);
  assert.match(src, /export async function autoTicket[\s\S]*?if \(needsHomeChoice\(\)\) \{ FS\.autoTicket = null; return; \}/);
});

// The ticket the fallback files is one FileTicket accepts: the nation's own wedge outside the heartland (the program
// checks the wedge, `wedge_allowed`), never a heartland province the dispersed placement gave another nation.
const prov = (p, q, free) => ({ p, q, siteCount: 4, sites: [10, 20, 30, 40],
  siteMirror: [0, 1, 2, 3].map(i => ({ state: i < free ? 0 : 1, gen: 0 })), ticketCohorts: [] });
const overview = (rings, freeOf) => new Map(rings.map(d => [d, { ring: d, provinces: ringProvinces(d).map(c => {
  const free = freeOf(c, d);
  return { p: c.p, q: c.q, sites: [0, 1, 2, 3].map(i => (i < free ? 0 : 1)), owners: [7, 7, 7, 7] };
}) }]));

test('planTicket after a full heartland: only the own wedge past the heartland, under both placements', async () => {
  for (const season of [v2, v2d]) {
    const place = seasonPlace(season);
    const faction = 2;
    const freeOf = (c, d) => (d <= 3 ? 0 : 4);   // the heartland full, rings 4-5 free
    const overviews = overview([2, 3, 4, 5], freeOf);
    const plan = await planTicket({ overviews, faction, ringsOpen: 6, seed: 'x', nowBell: 100, place,
      read: async (p, q) => prov(p, q, freeOf({ p, q }, ringOf(p, q))) });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.source, 'home');
    assert.ok(plan.sites.length > 0);
    for (const s of plan.sites) {
      assert.ok(ringOf(s.p, s.q) > 3, `ring ${ringOf(s.p, s.q)} is past the heartland`);
      assert.equal(wedgeOf(s.p, s.q), faction, 'the own wedge (FileTicket wedge_allowed)');
    }
    // and in the heartland no province of another nation is a candidate even if it had room
    const plan2 = await planTicket({ overviews: overview([2, 3], () => 4), faction, ringsOpen: 4, seed: 'x', nowBell: 100, place,
      read: async (p, q) => prov(p, q, 4) });
    for (const s of plan2.sites) assert.equal(homeNation(s.p, s.q, place ?? {}), faction);
  }
});
