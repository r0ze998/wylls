import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render as join } from '../../permutation-server/web/frontier/screens/join.mjs';
import { render as guide, renderScoutAction } from '../../permutation-server/web/frontier/screens/onboarding.mjs';
import { buildCards, queueSlots, introBuildAvailable, queueItemLabel } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { factsOf, hasBuilt, onboardingState, FLAG } from '../../permutation-server/web/frontier/onboarding.mjs';
import { baseProduction, queueBuildingItem } from '../../permutation-server/web/frontier/fland.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const site = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0 };
const h = (extra = {}) => ({ ...site, state: 2, tier: 0, flags: 0, production: baseProduction(0), reserve: Array(8).fill(0), queue: [], transit: [], explore: { state: 0 }, ...extra });
const fs = (extra = {}) => ({ mode: 'play', season: { programVersion: 2 }, meStatus: 'ready', citizen: null, holdings: [], provinces: new Map(), nowBell: 10, chain: { now: () => 1000 }, land: { stage: 'none' }, ui: { dismissed: [] }, homeChoice: { candidates: [site], selected: site }, ...extra });
const plain = s => String(s).replace(/<[^>]*>/g, ' ');

test('new seasons retain six nation banners before connecting, and confirm the selected nation with immediate placement', () => {
  const markup = String(join(fs()));
  assert.equal((markup.match(/data-act="pick-faction"/g) ?? []).length, 6);
  assert.match(markup, /class="banners"/);
  assert.doesNotMatch(markup, /data-act="home-pick"|ここが、あなたの村です。/);
  const ready = String(join(fs({ wallet: { address: 'W' }, joinDraft: { faction: 2 } })));
  assert.match(ready, /data-f="2"[^>]*aria-pressed="true"/);
  assert.match(ready, /data-act="home-confirm"/);
  assert.equal((ready.match(/class="btn primary/g) ?? []).length, 1);
});

test('pending placement disables duplicate confirmation; only a final holding receives the grant scene', () => {
  const waiting = String(join(fs({ wallet: { address: 'W' }, joinDraft: { faction: 0 }, homeChoice: { candidates: [site], selected: site, busy: true, pending: 'placing' } })));
  assert.match(waiting, /data-act="home-confirm" disabled/);
  assert.match(waiting, /村を準備しています/);
  assert.doesNotMatch(waiting, /ここが、あなたの村です。/);
  assert.doesNotMatch(String(join(fs({ homeGrant: h({ state: 1 }) }))), /ここが、あなたの村です。/);
  const granted = String(join(fs({ homeGrant: h(), citizen: { faction: 0 } })));
  assert.match(granted, /ここが、あなたの村です。/);
  assert.match(granted, /data-act="home-begin"/);
  assert.match(granted, /class="wait-scene/);
  assert.doesNotMatch(granted, /data-act="home-confirm"/);
});

test('an existing citizen keeps its nation, M1 keeps its lottery, and refugees cannot receive a second instant grant', () => {
  const own = fs({ wallet: { address: 'W' }, citizen: { faction: 1 }, session: {}, land: { stage: 'joined' }, homeChoice: { candidates: [site], selected: site } });
  const markup = String(join(own));
  assert.doesNotMatch(markup, /data-act="pick-faction"|data-act="home-pick"/);
  assert.match(markup, /data-act="home-confirm"/);
  const legacy = String(join(fs({ season: { programVersion: 1 }, wallet: { address: 'W' }, joinDraft: { faction: 0 } })));
  assert.match(legacy, /data-act="join"/);
  assert.doesNotMatch(legacy, /data-act="home-confirm"/);
  const refugee = String(join({ ...own, citizen: { faction: 0, flags: 33 }, land: { stage: 'refugee' } }));
  assert.doesNotMatch(refugee, /data-act="home-confirm"/, 'the instant grant is never offered a second time');
  assert.match(refugee, /新しい村/);
});

test('construction matches normal rules and the one-use introductory flag; queue capacity follows village tier', () => {
  const normal = buildCards(h(), []);
  assert.equal(normal[0].secs, 5400, 'first normal building takes 90 minutes, not 60');
  assert.equal(normal[6].secs, 14400, 'walls take four hours');
  const boosted = buildCards(h({ flags: 2 }), []);
  assert.equal(introBuildAvailable(h({ flags: 2 })), true);
  assert.equal(boosted[0].secs, 60);
  assert.equal(boosted[6].secs, 14400, 'the introduction does not accelerate walls');
  const behindWalls = buildCards(h({ flags: 2, queue: [{ kind: 4, arg: 0, doneAt: 1500 }] }), [], { now: 1000 });
  assert.equal(behindWalls[0].secs, 60);
  assert.equal(behindWalls[0].wait, 500, 'serial queue time must be shown separately from construction duration');
  const repeat = buildCards(h({ production: baseProduction(0).map((v, i) => i === 0 ? v + 12000n : v) }), []);
  assert.equal(repeat[0].secs, 7200);
  assert.equal(repeat[0].cost[1], 120, 'the second farm costs 1.5 times the base wood');
  const queuedFarm = { kind: 1, arg: 0, doneAt: 1060 };
  const queued = buildCards(h({ queue: [queuedFarm] }), []);
  assert.equal(queued[0].copies, 1, 'a queued Production/Food is a farm');
  assert.equal(queued[0].secs, 7200);
  assert.equal(queued[1].copies, 0, 'effect kind 1 does not mean the lumber Build item');
  assert.equal(queueItemLabel(queuedFarm), '農場');
  assert.equal(queueItemLabel({ kind: 4, arg: 0 }), '城壁');
  assert.equal(queueItemLabel({ kind: 3, arg: 0 }), '村の昇格');
  assert.equal(queueBuildingItem({ kind: 1, arg: 5 }), 4, 'gold resource index 5 maps to Build item 4');
  assert.equal(queueBuildingItem({ kind: 1, arg: 6 }), 5);
  assert.equal(queueBuildingItem({ kind: 2, arg: 0 }), null);
  assert.deepEqual([0, 1, 2, 3].map(queueSlots), [2, 3, 4, 4]);
});

test('the new guide requires a completed production effect, omits practice, and allows scouting during construction', () => {
  const building = h({ queue: [{ kind: 1, arg: 0, doneAt: 1060 }] });
  const s = fs({ citizen: { faction: 0, explores: 0 }, holdings: [building], land: { stage: 'final' } });
  const state = onboardingState(factsOf(s));
  assert.equal(state.current, 'build');
  assert.equal(hasBuilt(building, 1000), false);
  assert.equal(hasBuilt(building, 1060), true, 'a scheduled effect is complete even before lazy writeback');
  assert.equal(hasBuilt(h({ queue: [{ kind: 4, arg: 0, doneAt: 999 }] }), 1000), false, 'walls do not satisfy the first production building');
  assert.ok(!state.steps.some(x => x.id === 'practice'));
  const markup = String(guide(s));
  assert.match(markup, /1:00/);
  assert.match(markup, /data-act="home-scout-train"/);
  assert.equal((markup.match(/class="btn primary/g) ?? []).length, 1);
  assert.match(String(guide({ ...s, tab: 'holding' }, { open: false })), /^<section/, 'the follow-up stays expanded on the holding tab');
  assert.equal(guide({ ...s, tab: 'holding', holdings: [h()] }), '', 'build choices are already visible on the holding tab');
});

const entry = (extra = {}) => ({ id: hostId({ ...site, seq: 1 }), unit: 6, state: 1, tile: 20, troops: 100000, stamina: 120, readyBell: 10, pendOp: 0, fromBell: 10, ...extra });
const scoutState = (row, extra = {}) => fs({ citizen: { faction: 0, explores: 0 }, holdings: [h()], land: { stage: 'final' }, provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [row] } }]]), ...extra });

test('the scout guide follows training, muster, ready turn, send, receipt, and acknowledgement', () => {
  const training = scoutState(entry({ id: hostId({ ...site, site: 3, seq: 1 }) }));
  assert.match(String(renderScoutAction(training)), /home-scout-train/, 'a neighbour’s scout is not mine');
  assert.equal(factsOf(training).scoutHost, false);
  const reserve = Array(8).fill(0); reserve[6] = 100;
  assert.match(String(renderScoutAction(fs({ holdings: [h({ reserve })] }))), /home-scout-muster/);
  const forming = String(renderScoutAction(scoutState(entry({ state: 2, readyBell: 11 }))));
  assert.match(forming, /編成の反映を待っています/);
  assert.doesNotMatch(forming, /data-act="explore-open"/);
  const clock = { genesisTs: 0, window: () => 600, margin: 60 };
  const pending = scoutState(entry({ state: 2, fromBell: 11, readyBell: 11 }), { clock, nowBell: 11, chain: { now: () => 6700 } });
  const estimate = String(renderScoutAction(pending));
  assert.match(estimate, /data-home-deadline="7260"/, 'activation waits for the issued bell’s seed, not merely the next turn');
  const overdue = String(renderScoutAction({ ...pending, nowBell: 13, chain: { now: () => 7800 } }));
  assert.match(overdue, /世界の処理で編成が反映されると/);
  assert.doesNotMatch(overdue, /data-home-deadline|第14ターン/, 'an overdue activation never invents a moving next turn');
  const ready = String(renderScoutAction(scoutState(entry())));
  assert.match(ready, /data-act="explore-open"/);
  const waiting = String(renderScoutAction({ ...training, homeActionBusy: true }));
  assert.doesNotMatch(waiting, /data-act="home-scout-train"/);
  assert.match(waiting, /命令の結果を確認しています/);
  const exploring = fs({ holdings: [h({ explore: { state: 1 } })] });
  assert.doesNotMatch(String(renderScoutAction(exploring)), /data-act="settle-explore"/);
  assert.match(String(renderScoutAction({ ...exploring, exploreSeedReady: true })), /data-act="settle-explore"/);
  const completed = scoutState(entry(), { citizen: { faction: 0, explores: 1 }, holdings: [h({ production: baseProduction(0).map((v, i) => i === 0 ? v + 12000n : v) })] });
  assert.match(String(renderScoutAction(completed)), /data-flag="exploreResult"/);
  assert.equal(onboardingState(factsOf(completed)).current, 'scout');
  assert.equal(onboardingState(factsOf(completed), [FLAG.exploreResult]).current, 'march');
});

test('the first village and scout screens render fully in English', () => {
  setLang('en');
  const states = [fs(), fs({ homeGrant: h(), citizen: { faction: 0 } }), fs({ homeChoice: { candidates: [], selected: null, loading: true } })];
  for (const s of states) assert.doesNotMatch(plain(join(s)), /[぀-ヿ㐀-鿿]/);
  for (const s of [scoutState(entry()), scoutState(entry({ state: 2, readyBell: 11 })), fs({ holdings: [h({ explore: { state: 1 } })] })]) assert.doesNotMatch(plain(renderScoutAction(s)), /[぀-ヿ㐀-鿿]/);
});
