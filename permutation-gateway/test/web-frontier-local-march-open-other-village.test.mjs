// Round 28's case not covered before (2026-11-16): local play with the march gate OPEN, a host of ANOTHER of the viewer's
// villages, through the REAL controller (controller.mjs startPlay + ACTIONS['cq-march']). Before, only the closed gate
// was driven (web-frontier-cq-march-other-village, web-frontier-local-muster-wait-controller): opening it needs the
// page's memory-only wallet.
//
// KEY-USING (not key-free): the page's memory-only wallet (fephemeral-wallet.mjs) makes ONE Ed25519 key in this
// process with WebCrypto `subtle.generateKey` (extractable = false: no seed, no private bytes can be read). It is
// offered to the page through Wallet Standard events on a plain EventTarget standing in for `window`, connected as the
// local-play wallet, and destroyed after the tests. NOTHING is signed: no order is sent (the test composes only), and the
// test asserts that the one request other than a GET is the march capability POST. Every request goes to a `fetch`
// stub (loopback relay origin; no socket is opened); the capability answer is synthetic (TEST-ONLY trial). Nothing is
// stored: Node has no `localStorage` (asserted), and no file is written. No chain, no world, no launcher.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { createEphemeralWallet, currentEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { LOCAL_MARCH_CAPABILITY_PATH, LOCAL_MARCH_CAPABILITY_SCHEMA } from '../../permutation-server/web/frontier/flocalplay-march.mjs';
import { LOCAL_PLAY_PROGRAM_VERSION } from '../../permutation-server/web/frontier/flocalplay.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';

const PROGRAM = 'SysvarC1ock11111111111111111111111111111111';
const RELAY = 'http://127.0.0.1:41988';
const INSTANCE = 'ab'.repeat(32);   // a synthetic runner instance (64 hex: flocalplay-march.mjs instanceOk)
const requests = [];
let ew = null, lp = null, oldFetch = null, oldWindow, oldLocation;
const SEASON = { programVersion: LOCAL_PLAY_PROGRAM_VERSION, layoutVersion: 2, endBell: 9999, bellSecs: 600, minLead: 2, maxLead: 72, minRevealPriorityMilli: 1000, revealCuLimit: 40000, revealLoadedLimit: 65536, conquestParams: { keepBells: 72 } };
const village = (p, q, site, tile) => ({ p, q, site, gen: 0, tile, faction: 1, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const A = village(2, 0, 2, 20), B = village(5, -1, 4, 33);
const hostB = { id: hostId({ p: 5, q: -1, site: 4, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 33, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10 };
const fakeHerald = { pin: () => {}, province: async (p, q) => ({ ok: true, ...(FS.provinces?.get?.(`${p},${q}`) ?? {}) }) };
const settle = ms => new Promise(r => setTimeout(r, ms));

function scene() {
  Object.assign(FS, { mode: 'play', season: SEASON, citizen: { faction: 1 }, holdings: [A, B], activeHolding: 0, clock: { genesisTs: 0 }, chain: { now: () => 600 * 10 + 100 }, nowBell: 10, inFlight: 0, compose: null, notice: null,
    provinces: new Map([['2,0', { province: { p: 2, q: 0, gen: 0, resolvedNext: 10, entries: [], ticketCohorts: [] } }], ['5,-1', { province: { p: 5, q: -1, gen: 0, resolvedNext: 10, entries: [hostB], ticketCohorts: [] } }]]),
    conquest: { status: 'ready', keeps: new Map(), history: new Map(), standings: null, final: null, events: [] }, tab: 'map' });
}

before(async () => {
  oldWindow = globalThis.window; oldLocation = globalThis.location;
  globalThis.window = new EventTarget();
  globalThis.location = { hostname: '127.0.0.1' };
  ew = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });
  ew.announce(globalThis.window);
  const pin = io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: 1 });
  io.setRelay(RELAY);
  lp = { address: ew.address, programId: PROGRAM, seasonAddress: pin.addresses.season, seasonId: '1', cluster: 'localnet', worldEndsAt: Date.now() + 3_600_000, march: { instance: INSTANCE, trialEntry: true } };
  FS.season = SEASON;
  oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    requests.push({ url: String(url), method });
    if (method === 'POST' && String(url) === `${RELAY}${LOCAL_MARCH_CAPABILITY_PATH}`) {
      return new Response(JSON.stringify({ schema: LOCAL_MARCH_CAPABILITY_SCHEMA, wallet: lp.address, instance: INSTANCE, commands: ['Depart'], reveal: 'keeper', trial: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: false, code: 'Unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
  };
  // (startPlay's own poll timer is not part of this test, as in web-frontier-local-muster-wait-controller)
  const oldSetTimeout = globalThis.setTimeout; globalThis.setTimeout = () => 0;
  try { await C.startPlay({ herald: fakeHerald, cfg: { localPlay: lp, dev: false, herald: RELAY } }); } finally { globalThis.setTimeout = oldSetTimeout; }
  for (let i = 0; i < 50 && FS.localMarchFor?.(A, null)?.capability !== true; i++) await settle(10);
});
after(() => { globalThis.fetch = oldFetch; currentEphemeralWallet()?.destroy?.(); globalThis.window = oldWindow; globalThis.location = oldLocation; });

test('the gate opens for the memory-only wallet (TEST-ONLY trial), for a host of either village', () => {
  scene();
  assert.equal(FS.wallet?.address, lp.address, 'the memory-only wallet is the connected one');
  const a = FS.localMarchFor(A, null), b = FS.localMarchFor(B, String(hostB.id));
  assert.deepEqual([a.open, a.reason, a.trial], [true, 'open', true], JSON.stringify(a));
  assert.deepEqual([b.open, b.reason, b.trial], [true, 'open', true], JSON.stringify(b));
});

test('open gate, a host of the other village: the press switches to its village and the order fixes that village; the send-time answer is open', async () => {
  scene();
  await C.ACTIONS['cq-march']({ host: String(hostB.id), p: '6', q: '-1', tile: '18' }).catch(() => {});
  assert.equal(FS.activeHolding, 1, 'the host\'s own village is now the active one');
  assert.ok(FS.compose, 'an order is composed (it was refused before the gate opened: round 28)');
  assert.equal(String(FS.compose.host.id), String(hostB.id));
  assert.deepEqual(FS.compose.holding, { p: 5, q: -1, site: 4, gen: 0 }, 'the order fixes the host\'s own village, not the one active before');
  assert.equal(FS.localMarch?.open, true, 'the answer the send reads (the composed order\'s village and host) is open');
});

test('a host found in none of the viewer\'s villages: nothing composed, nothing switched, even with the gate open', async () => {
  scene();
  await C.ACTIONS['cq-march']({ host: String(hostId({ p: 9, q: 9, site: 1, gen: 0, seq: 7 })), p: '6', q: '-1', tile: '18' }).catch(() => {});
  assert.equal(FS.activeHolding, 0); assert.equal(FS.compose, null);
});

test('the send uses the composed order\'s village (pinned as text: the send was not run here)', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const fn = c.slice(c.indexOf('async function sendTheMarch() {'), c.indexOf('async function sendTheMarch() {') + 4000);
  assert.match(fn, /if \(localPlay && FS\.localMarch\?\.open !== true\) return failed\(localPlayReadOnly\(\)\);\n\s+const h = c\.holding \? holdingByRef\(FS\.holdings,c\.holding\) : activeHolding\(FS\);/);
  assert.match(fn, /localMarchSenderNow\(\)\.depsFor\(\{ holding: \{ p: h\.p, q: h\.q, site: h\.site \}, province: \{ p: c\.origin\.p, q: c\.origin\.q \} \}\)/);
});

test('isolation: one non-GET request (the capability POST), all to the loopback stub; nothing signed or sent; nothing stored', () => {
  const nonGet = requests.filter(r => r.method !== 'GET');
  assert.deepEqual(nonGet, [{ url: `${RELAY}${LOCAL_MARCH_CAPABILITY_PATH}`, method: 'POST' }], JSON.stringify(nonGet));
  assert.ok(requests.every(r => r.url.startsWith(`${RELAY}/`) || r.url.startsWith('/') || !/^[a-z]+:/i.test(r.url)), JSON.stringify(requests.map(r => r.url)));
  assert.equal(globalThis.localStorage, undefined, 'no browser storage in this process');
  assert.ok(!requests.some(r => /submit|context/.test(r.url)), 'no order submitted, no act context asked');
});
