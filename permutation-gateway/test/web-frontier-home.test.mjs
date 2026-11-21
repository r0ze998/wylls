import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeSites, planHomes, homeKey, loadHome, saveHome } from '../../permutation-server/web/frontier/home.mjs';
import { ringProvinces, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { useHerald, refresh } from '../../permutation-server/web/frontier/controller.mjs';
import { panelMarkup } from '../../permutation-server/web/frontier/app.mjs';
import { snapshot, diffFeed } from '../../permutation-server/web/frontier/hud/feed.mjs';

const province = (p = 2, q = 0) => ({ p, q, siteCount: 2, sites: [5, 14], siteMirror: [{ state: 0, gen: 0 }, { state: 3, gen: 2 }], ticketCohorts: [] });
const overviews = () => new Map([2, 3, 4].map(ring => [ring, { ring, provinces: ringProvinces(ring).map(p => ({ ...p, sites: [0, 3], owners: [7, 7] })) }]));

test('first home excludes reserved, closed, foreign, occupied and unresolved-ticket land', () => {
  const p = province(), faction = wedgeOf(p.p, p.q);
  assert.equal(homeSites(p, { faction, ringsOpen: 3 }).length, 2);
  assert.deepEqual(homeSites(province(1, 0)), []);
  assert.deepEqual(homeSites(p, { ringsOpen: 2 }), []);
  assert.deepEqual(homeSites(p, { faction: (faction + 1) % 6 }), []);
  p.siteMirror[0].state = 2;
  assert.deepEqual(homeSites(p).map(s => [s.site, s.gen]), [[1, 2]]);
  p.ticketCohorts = [{ filed: 2, settled: 1, bell: 10 }];
  assert.deepEqual(homeSites(p, { nowBell: 33 }), []);
  assert.equal(homeSites(p, { nowBell: 34 }).length, 1);
});

test('home candidates are real places in different nations; joined players stay in their nation', async () => {
  const args = { overviews: overviews(), read: async (p, q) => province(p, q), ringsOpen: 5, seed: 'player' };
  const fresh = await planHomes(args);
  assert.equal(fresh.candidates.length, 3);
  assert.equal(new Set(fresh.candidates.map(s => s.faction)).size, 3);
  for (const s of fresh.candidates) assert.equal(s.faction, wedgeOf(s.p, s.q));
  const joined = await planHomes({ ...args, faction: 4 });
  assert.equal(joined.candidates.length, 3);
  assert.ok(joined.candidates.every(s => s.faction === 4));
});

test('candidate reads are bounded and network failure is distinct from no free land', async () => {
  let calls = 0;
  const unavailable = await planHomes({ overviews: overviews(), read: async () => { calls++; throw new Error('offline'); } });
  assert.equal(unavailable.error, 'Unavailable');
  assert.ok(calls <= 24);
  const full = await planHomes({ overviews: overviews(), read: async (p, q) => ({ ...province(p, q), siteCount: 0 }) });
  assert.equal(full.error, 'NoFreeHome');
});

test('selected home, uncertain submission and grant acknowledgement survive reload per wallet and season', () => {
  const storage = new Map(), sc = { cluster: 'localnet', programId: 'P', seasonId: 71 };
  const key = homeKey(sc, 'A');
  saveHome(storage, key, { selected: { p: 2, q: 0, site: 1 }, pending: { kind: 'PlaceHome', signature: 'sig' }, seen: '2,0,1,0' });
  assert.equal(loadHome(storage, key).pending.signature, 'sig');
  assert.equal(loadHome(storage, key).selected.site, 1);
  assert.equal(loadHome(storage, key).seen, '2,0,1,0');
  assert.equal(loadHome(storage, homeKey(sc, 'B')).pending, null);
  assert.equal(loadHome(storage, homeKey({ ...sc, seasonId: 72 }, 'A')).seen, null);
  storage.set(key, '{broken');
  assert.equal(loadHome(storage, key).selected, null);
});

test('failed player reads retain known ownership and show a recoverable error', async () => {
  const saved = { ...FS }, citizen = { faction: 0 }, holdings = [{ p: 2, q: 0, site: 0 }];
  try {
    Object.assign(FS, { season: { programVersion: 2 }, clock: { genesisTs: 0 }, chain: { now: () => 600 }, wallet: { address: 'A' }, citizen, holdings });
    useHerald({ me: async () => ({ ok: false, code: 'Unavailable' }) });
    await refresh();
    assert.equal(FS.meStatus, 'error');
    assert.equal(FS.citizen, citizen);
    assert.equal(FS.holdings, holdings);
    assert.ok(FS.meError.text);
  } finally { Object.assign(FS, saved); useHerald(null); }
});

test('the first nation choice preserves map inspection while a confirmed home grant takes precedence', () => {
  const base = { ...FS, mode: 'play', playReady: true, titleUp: false, joinShut: false, land: { stage: 'none' }, season: { programVersion: 2 }, tab: 'map', notice: null, practice: null, report: null, compose: null, guideOpen: false, citizen: null, wallet: null, holdings: [], homeChoice: { candidates: [] }, homeGrant: null, selected: null };
  const choice = panelMarkup(base).join('');
  assert.match(choice, /aria-labelledby="join-faction"/);
  assert.equal((choice.match(/data-act="pick-faction"/g) ?? []).length, 6);
  assert.doesNotMatch(choice, /home-choice-title|onboard-title/);
  const selected = { kind: 'tile', p: 2, q: 0, idx: 5 };
  assert.match(panelMarkup({ ...base, selected }).join(''), /aria-labelledby="inspect-title"/);
  const grant = panelMarkup({ ...base, selected, holdings: [{ p: 2, q: 0, site: 0 }], homeGrant: { p: 2, q: 0, site: 0, faction: 0, state: 2, stores: [] } }).join('');
  assert.match(grant, /home-grant/);
  assert.doesNotMatch(grant, /aria-labelledby="inspect-title"|data-act="pick-faction"/);
  assert.match(grant, /data-act="home-begin"/);
});

test('a farm completion names the actual effect, even if Harvest consumed its queue between polls', () => {
  const holding = { p: 2, q: 0, site: 0, state: 2, tier: 0, queue: [{ kind: 1, arg: 0, doneAt: 160 }] };
  const prev = snapshot({ holdings: [holding] }, 159);
  const next = snapshot({ holdings: [{ ...holding, queue: [] }] }, 161);
  const completed = diffFeed(prev, next).filter(x => x.kind === 'build');
  assert.equal(completed.length, 1);
  assert.match(completed[0].text, /農場/);
  assert.doesNotMatch(completed[0].text, /伐採/);
  assert.equal(diffFeed(next, snapshot({ holdings: [{ ...holding, queue: [] }] }, 162)).length, 0);
});

// (fix-loop6, LP6-12) loop-play6: 2 of 3 `--two` worlds put the two people of one nation in opposite provinces, so a
// caravan could not reach. The TEST-ONLY contest pair now shares one order of places (its Season), every other player
// keeps its own (players spread out); the places and the placing rules are unchanged.
test('LP6-12: a local contest pair of one nation is offered the same province first; other players keep their own order', async () => {
  const { homeSeed } = await import('../../permutation-server/web/frontier/controller.mjs');
  const SEASON_ADDR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  const a = { wallet: { address: 'AAAAwallet' } }, b = { wallet: { address: 'BBBBwallet' } };
  assert.equal(homeSeed(a, null), 'AAAAwallet'); assert.equal(homeSeed(a, { seasonAddress: SEASON_ADDR }), 'AAAAwallet', 'local play, not a pair: its own');
  const first = { pair: 'first', seasonAddress: SEASON_ADDR }, second = { pair: 'second', seasonAddress: SEASON_ADDR };
  assert.equal(homeSeed(a, first), homeSeed(b, second)); assert.equal(homeSeed(a, first), `pair:${SEASON_ADDR}`);
  const faction = 3, plan = seed => planHomes({ overviews: overviews(), read: async (p, q) => province(p, q), ringsOpen: 5, seed: `${seed}|0`, faction });
  const [pa, pb] = [await plan(homeSeed(a, first)), await plan(homeSeed(b, second))];
  assert.deepEqual([pa.candidates[0].p, pa.candidates[0].q], [pb.candidates[0].p, pb.candidates[0].q], 'the same province first');
  // by their own wallets, the two would most likely have been offered different provinces (the loop-play6 case)
  const own = [];
  for (const w of ['AAAAwallet', 'BBBBwallet', 'CCCCwallet', 'DDDDwallet']) { const c = (await plan(w)).candidates[0]; own.push(`${c.p},${c.q}`); }
  assert.ok(new Set(own).size > 1, `wallet seeds spread the players: ${own}`);
  const src = (await import('node:fs')).readFileSync(new URL('../../permutation-server/web/frontier/flocalplay.mjs', import.meta.url), 'utf8');
  assert.match(src, /const playedAs = launcher && state\.pairRole \? Object\.freeze\(\{ \.\.\.playedWide, pair: state\.pairRole \}\) : playedWide;/);
});
