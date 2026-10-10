import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trainingCost, trainingQuote, baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { render as holdingScreen, upgradeModel } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { composerMarch, marchTiming } from '../../permutation-server/web/frontier/screens/march.mjs';
import { keepModel, renderKeep, scoreRows, renderStandings, renderOutpost } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { tabs } from '../../permutation-server/web/frontier/screens/shell.mjs';
import { defendersAt } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { inspectModel } from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const resources = ['Food', 'Wood', 'Stone', 'Ore', 'Horses', 'Gold', 'Science', 'Influence'];
const stores = (values = [300, 300, 200, 100, 0, 100, 0, 0]) => values.map((n, i) => ({ value: BigInt(n * 1000), rate: baseProduction(0)[i], cap: 2000000n, t0: 1000n, frac: 0n }));
const h = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: stores(), reserve: Array(8).fill(0), queue: [], transit: [], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const entry = (extra = {}) => ({ id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 20, troops: 100000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, ...extra });
const fs = (extra = {}) => ({ mode: 'play', season: { programVersion: 3, endBell: 2016, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800 }, citizen: { faction: 0 }, holdings: [h()], nowBell: 10, chain: { now: () => 1000 }, land: { stage: 'final' }, provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [entry()], ticketCohorts: [] } }]]), ...extra });
const keep = (extra = {}) => ({ p: 4, q: 0, tile: 30, holder: 1, troops: 2500, heartland: false, consolidatedUntil: 0, contender: 0, progress: 12, requiredBells: 72, asOfBell: 10, ...extra });
const table = (scores = ['60', '120', '120', '0', '40', '10']) => ({ metric: 'province-bells', bell: 10, rows: scores.map((provinceBells, faction) => ({ faction, provinces: 2, provinceBells })) });

test('training prices match the versioned catalog and round the purchase batch, including affordability boundaries', () => {
  const catalog = readFileSync(new URL('../../permutation-rules/src/frontier/catalog.rs', import.meta.url), 'utf8');
  assert.match(catalog, /TRAIN_PROD_COST_V2: \[i64; 7\] = \[6, 7, TROOP_COST_BASE_PROD, 12, 14, 16, 10\]/);
  assert.deepEqual(trainingCost(2, 100, 2), [60, 0, 0, 30, 0, 15, 0, 0]);
  assert.deepEqual(trainingCost(2, 100, 3), [60, 0, 0, 20, 0, 10, 0, 0]);
  assert.deepEqual(trainingCost(6, 101, 3), [120, 0, 0, 66, 0, 33, 0, 0]);
  const boundary = h({ stores: stores([120, 0, 0, 65, 0, 33, 0, 0]) });
  assert.equal(trainingQuote(boundary, 6, 101, 1000, 3).affordable, false);
  assert.equal(trainingQuote(boundary, 6, 100, 1000, 3).max, 100);
  assert.equal(trainingQuote(h(), 0, 500, 1000, 3).affordable, true);
  assert.equal(trainingQuote(h(), 0, 501, 1000, 3).affordable, false);
  assert.equal(trainingCost(7, 100, 3), null);
  assert.equal(trainingCost(0, -1, 3), null);
});

test('upgrade exposes actual Town benefits and serial completion, and refuses a duplicate queued tier-up', () => {
  const rich = resources.map(resource => ({ resource, value: 20000 }));
  const m = upgradeModel(h({ queue: [{ kind: 1, arg: 0, doneAt: 1600 }] }), rich, 1000);
  assert.equal(m.next, 1); assert.equal(m.cap, 6000); assert.equal(m.slots, 3);
  assert.equal(m.wait + m.secs, 22200);
  assert.equal(m.gains.find(x => x.resource === 'Food').perHour, 20);
  assert.equal(m.gains.find(x => x.resource === 'Gold').perHour, 7);
  assert.equal(upgradeModel(h({ queue: [{ kind: 3, doneAt: 999 }] }), rich, 1000).pending, true);
  assert.equal(upgradeModel(h({ tier: 3 }), rich, 1000), null);
});

test('military screen previews the exact purchase and disables unaffordable training; upgrade is actionable when affordable', () => {
  const poor = String(holdingScreen(fs({ trainingDraft: { unit: 0, n: 501 } })));
  assert.match(poor, /訓練の費用/); assert.match(poor, /360/);
  assert.match(poor, /<button type="submit" class="btn" disabled>訓練する/);
  assert.match(poor, /約11〜21分/);
  assert.doesNotMatch(poor, /新しい軍勢は次の鐘/);
  const rich = String(holdingScreen(fs({ holdings: [h({ stores: stores(Array(8).fill(2000)) })] })));
  assert.match(rich, /data-act="build" data-item="7" >村を昇格する/);
  assert.match(rich, /村の基礎生産の増加/);
});

test('a second march validates the army’s current province and distinguishes arrival from processing time', () => {
  const home = { p: 2, q: 0, resolvedNext: 1 }, away = { p: 4, q: 0, resolvedNext: 10 };
  const s = fs({ compose: { origin: { p: 4, q: 0 }, host: entry() }, provinces: new Map([['2,0', { province: home }], ['4,0', { province: away }]]), clock: { genesisTs: 0, window: () => 600, margin: 60 }, chain: { now: () => 6500 } });
  assert.equal(composerMarch(s).province, away);
  assert.equal(composerMarch(s).resolvedNext, 10);
  assert.deepEqual(marchTiming(s, 12), { arrivalAt: 7200, resultAbout: 8460, arrivalIn: 700, resultIn: 1960 });
});

test('keep progress is conditional and protected/unknown keeps never offer an attack', () => {
  const s = fs();
  assert.equal(keepModel(s, keep()).remaining, 60);
  assert.match(String(renderKeep(s, keep())), /data-act="cq-march"/);
  assert.match(String(renderKeep(s, keep())), /占拠を保てた場合/);
  assert.doesNotMatch(String(renderKeep(s, keep({ heartland: true }))), /data-act="cq-march"/);
  assert.doesNotMatch(String(renderKeep(s, keep({ consolidatedUntil: 20 }))), /data-act="cq-march"/);
  assert.doesNotMatch(String(renderKeep(s, keep({ consolidatedUntil: null }))), /data-act="cq-march"/);
  assert.doesNotMatch(String(renderKeep(s, null)), /data-act="cq-march"/);
  const foreign = entry({ id: hostId({ p: 2, q: 0, site: 3, gen: 0, seq: 1 }) });
  const noArmy = fs({ provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [foreign] } }]]) });
  assert.doesNotMatch(String(renderKeep(noArmy, keep())), /data-act="cq-march"/);
});

test('rankings go by provinces held, share a rank on equal provinces, reject old Dominion and do not announce a premature winner', () => {
  // equal provinces: one shared rank; the time held only orders the rows inside it
  const rows = scoreRows(table());
  assert.deepEqual(rows.map(r => [r.faction, r.rank]), [[1, 1], [2, 1], [0, 1], [4, 1], [5, 1], [3, 1]]);
  // more provinces wins whatever the time held
  const byArea = table(); byArea.rows[3].provinces = 3; byArea.rows[0].provinces = 1;
  assert.deepEqual(scoreRows(byArea).map(r => [r.faction, r.rank]), [[3, 1], [1, 2], [2, 2], [4, 2], [5, 2], [0, 6]]);
  assert.equal(scoreRows({ ...table(), metric: 'dominion' }), null);
  assert.equal(scoreRows({ ...table(), rows: table().rows.slice(0, 5) }), null);
  const huge = scoreRows(table(['9007199254740993', '9007199254740992', '1', '2', '3', '4']));
  assert.deepEqual(huge.slice(0, 2).map(r => [r.faction, r.rank]), [[0, 1], [1, 1]]);
  const ongoing = String(renderStandings(fs({ conquest: { standings: table(), final: table() } })));
  assert.doesNotMatch(ongoing, /同点首位|の勝利/);
  const finishing = String(renderStandings(fs({ nowBell: 2016, conquest: { standings: table() } })));
  assert.match(finishing, /得点の確定を待っています/);
  const finished = String(renderStandings(fs({ nowBell: 2016, conquest: { final: table() } })));
  assert.match(finished, /同点首位/);
  assert.match(finished, /州・時間/);
});

test('outpost waits for eligibility, respects current site and pending state, and never asserts ownership', () => {
  const site = { p: 4, q: 0, site: 2 };
  assert.doesNotMatch(String(renderOutpost(fs(), site)), /data-act="cq-outpost"/);
  const ready = String(renderOutpost(fs({ conquest: { outpost: { eligible: true, target: site } } }), site));
  assert.match(ready, /data-act="cq-outpost" data-p="4" data-q="0" data-site="2" >/);
  assert.match(ready, /資源は申請時に支払います/);
  assert.match(ready, /期限切れ.*返還されません/);
  assert.doesNotMatch(ready, /あなたの村になりました/);
  const wrong = String(renderOutpost(fs({ conquest: { outpost: { eligible: true, target: { ...site, site: 3 } } } }), site));
  assert.match(wrong, /data-site="2" disabled/);
});

test('combat preview includes confirmed keep defenders and camp troops retain their whole-unit encoding', () => {
  const province = { p: 4, q: 0, sites: [], entries: [], camp: { state: 1, tile: 30, troops: 300 } };
  const s = fs({ selected: { p: 4, q: 0, idx: 30 }, provinces: new Map([['4,0', { province }]]), conquest: { keeps: new Map([['4,0', keep()]]) } });
  assert.equal(defendersAt(s, { p: 4, q: 0, tile: 30 }).total, 2800);
  assert.equal(inspectModel(s).tile.camp.troops, 300);
});

test('conquest, upgrade and military copy is translated, and nation navigation is only offered for CQ', () => {
  setLang('en');
  const s = fs({ conquest: { standings: table(), keeps: new Map([['4,0', keep()]]), outpost: { eligible: true } } });
  for (const markup of [renderStandings(s), renderKeep(s, keep()), renderOutpost(s, { p: 4, q: 0, site: 2 }), holdingScreen(s)]) assert.doesNotMatch(String(markup).replace(/<[^>]*>/g, ''), /[぀-ヿ㐀-鿿]/);
  assert.ok(tabs(s).some(t => t.id === 'nation'));
  assert.ok(!tabs({ ...s, season: { programVersion: 2 } }).some(t => t.id === 'nation'));
});
