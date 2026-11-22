// Round 21, the REAL controller (controller.mjs) in local play, driven through its ACTIONS with FS switched by the test:
// the Form a host card's waiting send arms, waits, is cancelled, is withdrawn on a change of muster / village / world /
// key, and — when the province is in step — starts exactly ONE order (counted as the controller's own order records: each
// call of the ordinary single send `act('Muster')` records one). The test cannot present a verified local-play identity, so
// the local transport refuses that order before anything is signed or fetched (LocalActIdentity) — a fetch spy confirms no
// request that could carry an order left (only the controller's own GET reads). What this proves: the controller's own wiring (musterNow, the frozen identity and village, the shared
// driver, the send-time re-check, the explicit village passed to the order, ONE order per arming). What it does not: the
// relay's and the chain's answers, an unknown outcome held by its signature (the local-act ledger's and the driver's tests
// cover that), a browser's press. No network, no key leaves memory, no chain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { createEphemeralWallet, currentEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';

const PROGRAM = 'SysvarC1ock11111111111111111111111111111111';
const RELAY = 'http://127.0.0.1:41987';
let sends = [], reads = [], fetchSpy = null, oldFetch = null, ew = null, lp = null, pin = null;
const HOME = () => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 1, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: [500, 0, 0, 0, 0, 0, 0, 0], queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const T0 = 600 * 12 + 300;   // turn 12, half-way (far from its end)
let t = T0;
const fakeHerald = { pin: () => {}, province: async (p, q) => ({ ok: true, ...(FS.provinces.get(`${p},${q}`) ?? {}) }) };

function scene({ resolvedNext = 10 } = {}) {
  Object.assign(FS, { orders: [], mode: 'play', season: { programVersion: 3, layoutVersion: 2, endBell: 9999, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } },
    citizen: { faction: 1 }, holdings: [HOME()], activeHolding: 0, clock: { genesisTs: 0 }, chain: { now: () => t, accelerated: false }, land: { stage: 'final' }, inFlight: 0, notice: null, compose: null,
    provinces: new Map([['2,0', { seq: '1', slot: '1', bell: 12, province: { p: 2, q: 0, gen: 0, resolvedNext, entries: [], ticketCohorts: [] } }]]),
    selected: { p: 2, q: 0, idx: 20 }, hand: { pop: 'muster' }, wallet: { address: lp.address }, musterWait: null, resident: null });
  FS.nowBell = 12;
}
const behind = () => { FS.provinces.get('2,0').province = { ...FS.provinces.get('2,0').province, resolvedNext: 10 }; };
const inStep = () => { FS.provinces.get('2,0').province = { ...FS.provinces.get('2,0').province, resolvedNext: 12 }; };
const settle = ms => new Promise(r => setTimeout(r, ms));
/** The muster orders the controller recorded (one per call of the ordinary single send). */
const musters = () => (FS.orders ?? []).filter(o => o.kind === 'muster');

before(async () => {
  globalThis.location = { hostname: '127.0.0.1' };
  ew = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });
  pin = io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: 1 });
  io.setRelay(RELAY);
  lp = { address: ew.address, programId: PROGRAM, seasonAddress: pin.addresses.season, cluster: 'localnet', worldEndsAt: Date.now() + 3_600_000, march: { instance: 'inst-1' } };
  oldFetch = globalThis.fetch;
  // (only a request that could carry an order counts as a send: anything but a GET; the controller's own reads after an
  //  order is answered — the prize's GET, for one — are reads and are kept apart)
  // (verify-pr150: and the cluster-rent read refresh() asks of the local relay — a POST whose body is exactly
  //  {schema: 'frontier-play-rent-context-v1'}, frent.mjs — is a read too: it carries no order)
  const rentRead = init => { try { const b = JSON.parse(String(init?.body ?? '')); return Object.keys(b).length === 1 && b.schema === 'frontier-play-rent-context-v1'; } catch { return false; } };
  fetchSpy = async (url, init) => { if (String(init?.method ?? 'GET').toUpperCase() !== 'GET' && !rentRead(init)) sends.push(String(url)); else reads.push(String(url));
    return new Response(JSON.stringify({ ok: false, code: 'Unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }); };
  globalThis.fetch = fetchSpy;
  // (startPlay's own poll timer is not part of this test: as web-frontier-controller.test.mjs does)
  const oldSetTimeout = globalThis.setTimeout; globalThis.setTimeout = () => 0;
  try { await C.startPlay({ herald: fakeHerald, cfg: { localPlay: lp, dev: false, herald: RELAY } }); } finally { globalThis.setTimeout = oldSetTimeout; }
});
after(() => { C.ACTIONS['muster-wait-cancel'](); globalThis.fetch = oldFetch; currentEphemeralWallet()?.destroy?.(); });

test('setup: the real local gate is open for this page (wallet, signer, relay, loopback)', () => {
  scene();
  assert.equal(currentEphemeralWallet()?.address, lp.address);
  assert.equal(FS.localPlay, lp);
});

test('the province finishing its turn: one press arms the waiting send and sends nothing; a cancel withdraws it, still nothing sent', async () => {
  scene(); sends = [];
  C.ACTIONS['muster-send-wait']();
  assert.equal(C.musterWaitArmed(), true, 'armed');
  assert.ok(FS.musterWait && FS.musterWait.untilBell === 14, 'the card knows it waits, until turn 14');
  C.ACTIONS['muster-send-wait']();
  await settle(350);
  assert.equal(musters().length, 0, 'no order while the province finishes its turn (and a second press arms nothing more)');
  C.ACTIONS['muster-wait-cancel']();
  assert.equal(C.musterWaitArmed(), false); assert.equal(FS.musterWait, null);
  inStep(); await settle(350);
  assert.equal(musters().length, 0, 'no order after the cancel'); assert.equal(sends.length, 0);
  const say = FS.notice?.text; assert.match(String(typeof say === 'function' ? say() : say ?? ''), /取り消しました/);
});

test('when the province is in step: exactly ONE send starts, for the frozen village; no second one', async () => {
  scene(); sends = [];
  C.ACTIONS['muster-send-wait']();
  assert.equal(C.musterWaitArmed(), true);
  inStep(); await settle(600);
  assert.equal(C.musterWaitArmed(), false, 'the waiting send ended');
  assert.equal(musters().length, 1, 'exactly one order');
  assert.deepEqual(musters()[0].tile, { p: 2, q: 0, tile: 20 }, 'for the frozen village and tile');
  assert.equal(musters()[0].troops, 500);
  assert.equal(musters()[0].code, 'LocalActIdentity', 'refused by the local transport before signing (this test has no verified identity)');
  assert.deepEqual(sends, [], 'no request left the page');
  await settle(400); C.ACTIONS['muster-wait-cancel']();
  assert.equal(musters().length, 1, 'no second order');
});

test('a change while it waits — troops, the village selected vs active, another relay, another runner instance — withdraws it; nothing is sent', async () => {
  const cases = [
    ['troops', () => { FS.hand = { ...FS.hand, troops: 300 }; }],
    ['selected village is not the active one', () => { FS.holdings = [HOME(), { ...HOME(), site: 5, tile: 33 }]; FS.activeHolding = 1; }],
    ['another relay', () => { io.setRelay('http://127.0.0.1:41992'); }],
    ['another runner instance on the same Season', () => { lp.march.instance = 'inst-2'; }],
    ['the card closed', () => { FS.hand = {}; }],
  ];
  for (const [name, change] of cases) {
    scene(); sends = []; io.setRelay(RELAY); lp.march.instance = 'inst-1';
    C.ACTIONS['muster-send-wait']();
    assert.equal(C.musterWaitArmed(), true, `${name}: armed`);
    change(); inStep(); await settle(400);
    assert.equal(C.musterWaitArmed(), false, `${name}: withdrawn`);
    assert.equal(musters().length, 0, `${name}: no order`); assert.deepEqual(sends, [], `${name}: nothing sent`);
  }
  io.setRelay(RELAY); lp.march.instance = 'inst-1';
});

test('an ordinary press when ready (mid-turn) sends at once; at the turn\'s very end it waits instead', async () => {
  scene({ resolvedNext: 12 }); sends = [];
  C.ACTIONS['muster-send-wait']();
  await settle(300);
  assert.equal(C.musterWaitArmed(), false, 'not armed: sent at once');
  assert.equal(musters().length, 1, 'one order at once');
  scene({ resolvedNext: 12 }); sends = []; t = 600 * 12 + 599;   // the last second of turn 12
  C.ACTIONS['muster-send-wait']();
  assert.equal(C.musterWaitArmed(), true, 'armed: not sent in the turn\'s last moments');
  await settle(250); assert.equal(musters().length, 0, 'no order in the turn\'s last moments');
  C.ACTIONS['muster-wait-cancel'](); t = T0;
});

test('outside local play\'s gate (no signer key for this wallet): nothing is armed or sent', async () => {
  scene(); sends = []; FS.wallet = { address: 'Other1111111111111111111111111111111111111' };
  C.ACTIONS['muster-send-wait']();
  assert.equal(C.musterWaitArmed(), false); await settle(200); assert.equal(musters().length, 0); assert.equal(sends.length, 0);
});

test('every troop already in a host (reserve 0): the card opens but nothing is armed or sent, settling or not', async () => {
  for (const rn of [10, 12]) {
    scene({ resolvedNext: rn }); sends = []; FS.holdings = [{ ...HOME(), reserve: [0, 0, 0, 0, 0, 0, 0, 0] }];
    C.ACTIONS['muster-send-wait']();
    assert.equal(C.musterWaitArmed(), false, `resolvedNext ${rn}: not armed`); await settle(200);
    assert.equal(musters().length, 0); assert.deepEqual(sends, []);
  }
});

test('round 27: the real controller gives the bar a per-host march answer, computed like the send\'s', () => {
  scene();
  assert.equal(typeof FS.localMarchFor, 'function');
  const r = FS.localMarchFor({ p: 2, q: 0, site: 2, gen: 0 }, 'h1');
  assert.ok(r && typeof r.open === 'boolean' && typeof r.reason === 'string', JSON.stringify(r));
  // this test page has no march capability: closed for any host, as the send would be — and the page-wide answer agrees
  assert.equal(r.open, false); assert.equal(FS.localMarch?.open, false);
});

test('round 28: in local play a march on a keep is refused before any order is drafted when the host\'s own march answer is closed', async () => {
  const H1 = String(hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }));
  scene(); FS.compose = null;
  FS.conquest = { status: 'ready', keeps: new Map(), history: new Map(), standings: null, final: null, events: [] };
  FS.season = { ...FS.season, programVersion: 3 };
  FS.provinces.get('2,0').province = { ...FS.provinces.get('2,0').province, entries: [{ id: H1, unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10 }] };
  sends = [];
  await C.ACTIONS['cq-march']({ host: H1, p: '4', q: '-1', tile: '18' }).catch(() => {});
  assert.equal(FS.compose, null, 'no order drafted');
  assert.equal(FS.notice?.code, 'LocalPlayReadOnly', 'the refusal is said');
  assert.deepEqual(sends, []);
  // a host of ANOTHER village, refused: the village is not switched (a refusal leaves the page as it was)
  const H2 = String(hostId({ p: 2, q: 0, site: 5, gen: 0, seq: 1 }));
  FS.holdings = [HOME(), { ...HOME(), site: 5, tile: 33 }]; FS.activeHolding = 0; FS.notice = null;
  FS.provinces.get('2,0').province = { ...FS.provinces.get('2,0').province, entries: [{ id: H2, unit: 0, state: 1, tile: 33, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10 }] };
  await C.ACTIONS['cq-march']({ host: H2, p: '4', q: '-1', tile: '18' }).catch(() => {});
  assert.equal(FS.activeHolding, 0, 'not switched on a refusal');
  assert.equal(FS.compose, null); assert.equal(FS.notice?.code, 'LocalPlayReadOnly'); assert.deepEqual(sends, []);
});
