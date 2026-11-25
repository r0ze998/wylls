import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(src, /const playedAs = launcher && state\.pairRole \? Object\.freeze\(\{ \.\.\.playedAi, pair: state\.pairRole \}\) : playedAi;/);
});

// (fix-loop6, LP6-11) B-8's real cause: a press made before the candidates were read started a forced reading, the next
// press superseded it, and the first press ended silently — 3–4 real presses in the ×60 wide picker. A press waiting
// for the reading now marks the button busy, and a press meanwhile adds nothing.
test('LP6-11: a press waiting for the candidates makes the button busy, and a second press neither restarts the reading nor ends the first', () => {
  const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
  const c = src('controller.mjs'), j = src('screens/join.mjs');
  // (fix-loop8, LP8-2: a press whose context moved during the wait is made again by itself — pressAgain — or said)
  const body = c.slice(c.indexOf('export async function confirmHome() {'), c.indexOf("if (contextSeq !== pressed) return pressAgain('context');", c.indexOf('export async function confirmHome() {')));
  assert.match(body, /if \(FS\.homeConfirmWait\) return;/, 'a press while one waits adds nothing');
  assert.match(body, /FS\.homeConfirmWait = true; invalidate\('panel'\);/);
  assert.match(body, /FS\.homeChoice\?\.loading && FS\.homeChoice\.faction === faction && Date\.now\(\) < until/, 'a reading under way for this nation is waited for');
  assert.match(body, /\} finally \{ FS\.homeConfirmWait = false; invalidate\('panel'\); \}/);
  assert.ok(body.indexOf('if (FS.homeConfirmWait) return;') < body.indexOf('await refreshHomes({ force: true })'));
  assert.equal(j.split('|| !!FS.homeConfirmWait;').length - 1, 2, 'both join screens show the wait as busy (「村を準備しています…」, the button disabled)');
});

// (verify-pr130, LP6-12) Live (`--coexist --demo --two`): the shared order gave both people the very same SITE, and the
// second PlaceHome was refused TicketState (Custom 45) — one of the two had no village at all. The pair now shares the
// province but not the site: the first role takes the first site, the second the next one, in provinces with room for both.
test('LP6-12 (verify-pr130): the contest pair is offered one province but two different sites; nobody else is affected', async () => {
  const { homeSeed, homePairRole } = await import('../../permutation-server/web/frontier/controller.mjs');
  const SEASON_ADDR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  const first = { pair: 'first', seasonAddress: SEASON_ADDR }, second = { pair: 'second', seasonAddress: SEASON_ADDR };
  assert.equal(homePairRole(first), 'first'); assert.equal(homePairRole(second), 'second');
  assert.equal(homePairRole(null), null); assert.equal(homePairRole({ seasonAddress: SEASON_ADDR }), null); assert.equal(homePairRole({ pair: 'first' }), null);
  const seed = `${homeSeed({ wallet: { address: 'A' } }, first)}|0`, faction = 3;
  const plan = (pair, prov = province) => planHomes({ overviews: overviews(), read: async (p, q) => prov(p, q), ringsOpen: 5, seed, faction, pair });
  const [pa, pb] = [await plan('first'), await plan('second')];
  assert.ok(pa.candidates.length > 0);
  const at = c => `${c.p},${c.q}`;
  assert.equal(at(pa.candidates[0]), at(pb.candidates[0]), 'the same province first');
  assert.notEqual(pa.candidates[0].site, pb.candidates[0].site, 'never the same site (the second PlaceHome would be refused TicketState)');
  // once one of the two has placed (its site taken), the other's choice in that province is still a different, free site
  const taken = pa.candidates[0];
  const after = (p, q) => { const v = province(p, q); if (`${p},${q}` === at(taken)) { v.siteCount = 3; v.sites = [5, 14, 30]; v.siteMirror = [{ state: 0, gen: 0 }, { state: 3, gen: 2 }, { state: 0, gen: 0 }]; v.siteMirror[taken.site] = { state: 1, gen: 1 }; } return v; };
  const pb2 = await plan('second', after);
  assert.equal(at(pb2.candidates[0]), at(taken)); assert.notEqual(pb2.candidates[0].site, taken.site);
  // a province with room for only one is not offered to the pair (it would put them apart or on one site)
  const one = (p, q) => ({ ...province(p, q), siteCount: 1, sites: [5], siteMirror: [{ state: 0, gen: 0 }] });
  assert.equal((await plan('first', one)).candidates.length, 0); assert.equal((await plan('second', one)).candidates.length, 0);
  assert.equal((await plan(null, one)).candidates.length > 0, true, 'everyone else still takes a one-site province');
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(c, /seed: `\$\{homeSeed\(\)\}\|\$\{old\.rotation \?\? 0\}`, rotation: old\.rotation \?\? 0, pair: homePairRole\(\),/);
});

// (fix-loop8, LP8-2 — loop-play8: 「ダンマールで始める」 pressed while 「土地の候補を読み込んでいます…」 showed; nothing for 5
//  minutes, a second press needed. The press now never ends silently: it is made again by itself, or the card says why.)
test('LP8-2: a press whose wait ends in another context, or with no candidate read, is queued again (same viewer, world, nation; no Citizen) or said', () => {
  const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
  const c = src('controller.mjs'), j = src('screens/join.mjs');
  const at = c.indexOf('export async function confirmHome() {'), body = c.slice(at, c.indexOf("pending('placing');", at));
  assert.match(c, /export const HOME_CONFIRM_AGAIN = 2;/);
  assert.ok(body.indexOf('const again = homeAgainNext ? homeAgainLeft : (homeAgainLeft = HOME_CONFIRM_AGAIN); homeAgainNext = false;') < body.indexOf('if (!instantHomeEnabled(FS.season) || FS.homeChoice?.busy) return;'), 'the budget is taken before any early return');
  assert.ok(body.includes("if (again > 0 && (viewerKey() ?? null) === viewer0 && providerWorld() === world0 && !FS.citizen && wantedHomeFaction() === faction) { homeAgainLeft = again - 1; homeAgainNext = true; return confirmHome(); }"));
  assert.ok(body.includes("if (!FS.citizen && (viewerKey() ?? null) === viewer0) { FS.homeDropped = { faction, why }; invalidate('panel'); }"), 'another wallet is never told, never joined');
  assert.ok(body.includes("if (contextSeq !== pressed) return pressAgain('context');"));
  assert.ok(body.includes("else if (!FS.homeChoice?.selected) return FS.homeChoice?.error ? undefined : pressAgain('unread');"), 'an error on the card speaks for itself');
  assert.equal((body.match(/if \(contextSeq !== pressed\) return;/g) ?? []).length, 0, 'no silent end after the wait');
  assert.ok(j.includes('data-home-dropped="${FS.homeDropped.why ?? \'context\'}"'));
  assert.match(j, /土地の候補を読み終えられなかったので、さきほどの「始める」は取り消しました（何も送っていません）。もう一度押してください。/);
  assert.match(j, /読み込みの間に世界かウォレットの状態が変わったので、さきほどの「始める」は取り消しました（何も送っていません）。もう一度押してください。/);
  assert.match(c, /FS\.homeChoice = null;\n  FS\.homeDropped = null;/, 'another viewer starts without the note');
});
