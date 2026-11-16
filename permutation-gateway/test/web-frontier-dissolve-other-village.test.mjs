// The host bar's 「解散」 for a host of ANOTHER of the viewer's villages (2026-11-16). Two ordinary ways put such a host in
// hand without switching the village: a plain tap on its tile (app.mjs: the selection switches only on a village's own
// tile) and its chip on a tile it shares with a host of the open village (hand-host → handHost). The bar offered the
// Dissolve — its check reads the host's own village (hud/subject.mjs dissolveCheck) — but the order named the OPEN
// village (controller.mjs dissolve: activeHolding, hostRow), and the program refuses a host that is not the holding's
// (host.rs dissolve_as → resident_host). Now dissolve first switches to the host's own village, as 「村へ戻す」 and the
// march already do. The march / return entries are pinned as text (app.mjs is the page's DOM module).
// KEY-FREE: no key is made, nothing is signed or sent — no pin is set, so the order stops at NoPin before anything is
// built; every request would go to a `fetch` stub (none is made: asserted). Nothing is stored. No chain, no world.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { handModel } from '../../permutation-server/web/frontier/hud/hand.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';

const village = (p, q, site, tile) => ({ p, q, site, gen: 0, tile, faction: 1, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const A = village(2, 0, 2, 20), B = village(5, -1, 4, 33);
const entry = (o, unit, tile, troops) => ({ id: hostId({ ...o, gen: 0 }), unit, state: 1, tile, troops, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10 });
const hostB = entry({ p: 5, q: -1, site: 4, seq: 1 }, 0, 40, 300000);        // B's host in the field of B's own province
const hostBatA = entry({ p: 5, q: -1, site: 4, seq: 2 }, 1, 20, 200000);     // B's host standing on A's village tile
const hostA = entry({ p: 2, q: 0, site: 2, seq: 1 }, 0, 20, 100000);         // A's host on A's village tile
const requests = [];
let oldFetch;
before(() => { oldFetch = globalThis.fetch; globalThis.fetch = async (url, init) => { requests.push({ url: String(url), method: String(init?.method ?? 'GET') }); return new Response('{}', { status: 503 }); }; });
after(() => { globalThis.fetch = oldFetch; });

function scene(sel, hand = null) {
  Object.assign(FS, { mode: 'play', season: { programVersion: 3, layoutVersion: 2, endBell: 9999, bellSecs: 600, minLead: 2, maxLead: 72, minRevealPriorityMilli: 1000, revealCuLimit: 40000, revealLoadedLimit: 65536, conquestParams: { keepBells: 72 } },
    citizen: { faction: 1 }, holdings: [A, B], activeHolding: 0, clock: { genesisTs: 0 }, chain: { now: () => 600 * 10 + 100 }, nowBell: 10, inFlight: 0, compose: null, notice: null, orders: [], wideSelect: null,
    provinces: new Map([['2,0', { province: { p: 2, q: 0, gen: 0, resolvedNext: 10, entries: [hostA, hostBatA], ticketCohorts: [] } }], ['5,-1', { province: { p: 5, q: -1, gen: 0, resolvedNext: 10, entries: [hostB], ticketCohorts: [] } }]]),
    conquest: null, tab: 'map', selected: { kind: 'tile', ...sel }, hand });
}
const press = async host => { await Promise.resolve(C.ACTIONS.dissolve({ host: String(host.id) })).catch(() => {}); return FS.orders?.[0] ?? null; };
const dissolveOn = m => m.buttons.find(b => b.id === 'dissolve');

test('a plain tap on the tile of another village\'s host: the bar offers 解散, and the order is that village\'s', async () => {
  scene({ p: 5, q: -1, idx: 40 });
  const m = handModel(FS);
  assert.equal(m?.kind, 'host'); assert.equal(String(m.host.id), String(hostB.id));
  assert.equal(FS.activeHolding, 0, 'the plain tap left the open village as it was');
  assert.equal(m.subject.holdingIndex, 1); assert.equal(dissolveOn(m).why, null, 'offered (its check reads the host\'s own village)');
  const o = await press(hostB);
  assert.equal(FS.activeHolding, 1, 'the host\'s own village');
  assert.deepEqual([o.name, o.host, o.unit, o.tile], ['Dissolve', String(hostB.id), 0, { p: 5, q: -1, tile: 40 }], JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.deepEqual([o.state, o.code, o.sent], ['refused', 'NoPin', false], 'stopped before anything was built (no pin in this test)');
});

test('its chip on a tile shared with the open village\'s host, then that host again (a repeated choice): each order is its own village\'s', async () => {
  scene({ p: 2, q: 0, idx: 20 }, { host: String(hostBatA.id), pop: null });
  const m = handModel(FS);
  assert.equal(String(m.host.id), String(hostBatA.id)); assert.equal(m.subject.holdingIndex, 1); assert.equal(FS.activeHolding, 0);
  assert.ok(m.chips.some(c => c.id === String(hostA.id)), 'the open village\'s host is the other chip');
  let o = await press(hostBatA);
  assert.equal(FS.activeHolding, 1); assert.deepEqual([o.host, o.unit, o.tile], [String(hostBatA.id), 1, { p: 2, q: 0, tile: 20 }]);
  FS.hand = { host: String(hostA.id), pop: null };   // the chip of A's host (hand-host: the village is not switched back)
  assert.equal(handModel(FS).subject.holdingIndex, 0); assert.equal(FS.activeHolding, 1, 'the open village is still B');
  o = await press(hostA);
  assert.equal(FS.activeHolding, 0, 'back to A\'s own village'); assert.deepEqual([o.host, o.unit, o.tile], [String(hostA.id), 0, { p: 2, q: 0, tile: 20 }]);
});

test('a march put away (compose-close) leaves no stale village: the next press is still the host\'s own', async () => {
  scene({ p: 5, q: -1, idx: 40 });
  FS.activeHolding = 1;   // (as the map tap's orderMarch switches before composing)
  C.ACTIONS.compose({ host: String(hostB.id), stay: 'map' });
  assert.deepEqual(FS.compose?.holding, { p: 5, q: -1, site: 4, gen: 0 });
  C.ACTIONS['compose-close']();
  assert.equal(FS.compose, null);
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 20 }; FS.hand = { host: String(hostA.id), pop: null };
  const o = await press(hostA);
  assert.equal(FS.activeHolding, 0); assert.deepEqual([o.host, o.unit], [String(hostA.id), 0]);
});

test('a host in none of the viewer\'s villages: nothing is switched (the program decides, as before)', async () => {
  scene({ p: 5, q: -1, idx: 40 });
  const o = await press({ id: hostId({ p: 9, q: 9, site: 1, gen: 0, seq: 7 }) });
  assert.equal(FS.activeHolding, 0); assert.equal(o.unit, null);
});

test('the source: dissolve switches before its order; the bar\'s other entries already switch (pinned as text)', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const d = c.slice(c.indexOf('  dissolve: d => {'), c.indexOf('  compose: d => {'));
  assert.match(d, /const hi = holdingIndexOfHost\(d\.host\);\n\s+if \(hi !== null && hi !== \(FS\.activeHolding \?\? 0\)\) \{ FS\.activeHolding = hi; invalidate\('rail'\); \}\n\s+const r = hostRow\(d\.host\);/);
  assert.match(d, /act\('Dissolve', \{ v: \{ holding: activeHolding\(FS\)/);
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const slice = (from, n) => a.slice(a.indexOf(from), a.indexOf(from) + n);
  const om = slice('async function orderMarch(A, hit) {', 1200);
  assert.ok(om.indexOf('FS.activeHolding = A.actor.holdingIndex') < om.indexOf('ACTIONS.compose('), 'the map tap\'s march: switch, then compose');
  const hr = slice("  'hand-return': async d => {", 600);
  assert.ok(hr.indexOf('FS.activeHolding = sub.holdingIndex') < hr.indexOf("ACTIONS['march-home']"), '「村へ戻す」: switch, then the return');
  assert.match(slice("  'hand-host': d =>", 80), /handHost\(d\.host \|\| null\)/);
  // (2026-11-16, claude/village-card-target-20261116: a chip now opens the subject's village too — handHost; dissolve's own
  //  switch stays for the plain tap on a host's tile, which does not go through handHost)
  assert.match(slice('function handHost(id) {', 1200), /const sub = hand\.subjectOf\(FS\);\n\s+if \(sub && Number\.isInteger\(sub\.holdingIndex\) && sub\.holdingIndex >= 0 && sub\.holdingIndex !== \(FS\.activeHolding \?\? 0\)\) \{ FS\.activeHolding = sub\.holdingIndex; invalidate\('rail'\); \}/);
  assert.match(a, /dissolve: d => handOrder\(\(\) => ACTIONS\.dissolve\(d\)\),/);
  assert.match(readFileSync(new URL('../../permutation-server/web/frontier/hud/hand.mjs', import.meta.url), 'utf8'), /data-act="dissolve" data-host="\$\{r\.id\}"/);
});

test('isolation: no request, nothing stored', () => {
  assert.deepEqual(requests, []);
  assert.equal(globalThis.localStorage, undefined);
});
