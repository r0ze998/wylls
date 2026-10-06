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

test('the first land decision and confirmed grant take precedence over unrelated map inspection', () => {
  const base = { ...FS, season: { programVersion: 2 }, tab: 'map', notice: null, practice: null, report: null, citizen: null, wallet: null, holdings: [], homeChoice: { candidates: [] }, homeGrant: null, selected: { kind: 'tile', p: 2, q: 0, idx: 5 } };
  const choice = panelMarkup(base).join('');
  assert.match(choice, /home-choice-title/);
  assert.doesNotMatch(choice, /inspector|onboard-title/);
  const grant = panelMarkup({ ...base, holdings: [{ p: 2, q: 0, site: 0 }], homeGrant: { p: 2, q: 0, site: 0, faction: 0, state: 2, stores: [] } }).join('');
  assert.match(grant, /home-grant-title/);
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
