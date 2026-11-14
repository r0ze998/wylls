// Round 28: a march on a keep for a host of another village (the real controller, an ordinary session). Before, the order
// was composed only from the active village (controller.mjs compose → hostRow), so a press for a host of another village
// did nothing at all. Now cq-march first switches to that host's own village — as the map tap and 「村へ戻す」 already do —
// and composes from there; the order fixes that village, and the send checks it as before. A host found in no village is
// still not composed. No key, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';

const village = (p, q, site, tile) => ({ p, q, site, gen: 0, tile, faction: 1, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const A = village(2, 0, 2, 20), B = village(5, -1, 4, 33);
const hostB = { id: hostId({ p: 5, q: -1, site: 4, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 33, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10 };
function scene() {
  Object.assign(FS, { mode: 'play', season: { programVersion: 3, layoutVersion: 2, endBell: 9999, bellSecs: 600, minLead: 2, maxLead: 72, minRevealPriorityMilli: 1000, revealCuLimit: 40000, revealLoadedLimit: 65536, conquestParams: { keepBells: 72 } },
    citizen: { faction: 1 }, holdings: [A, B], activeHolding: 0, clock: { genesisTs: 0 }, chain: { now: () => 600 * 10 + 100 }, nowBell: 10, inFlight: 0, compose: null, notice: null,
    provinces: new Map([['2,0', { province: { p: 2, q: 0, gen: 0, resolvedNext: 10, entries: [], ticketCohorts: [] } }], ['5,-1', { province: { p: 5, q: -1, gen: 0, resolvedNext: 10, entries: [hostB], ticketCohorts: [] } }]]),
    conquest: { status: 'ready', keeps: new Map(), history: new Map(), standings: null, final: null, events: [] }, tab: 'map' });
}

test('a host of another village: the press switches to its village and composes from there (it did nothing before)', async () => {
  scene();
  await C.ACTIONS['cq-march']({ host: String(hostB.id), p: '6', q: '-1', tile: '18' }).catch(() => {});
  assert.equal(FS.activeHolding, 1, 'the host\'s own village is now the active one');
  assert.ok(FS.compose, 'an order is composed');
  assert.equal(String(FS.compose.host.id), String(hostB.id));
  assert.deepEqual(FS.compose.holding, { p: 5, q: -1, site: 4, gen: 0 }, 'the order fixes the host\'s own village');
});

test('a host found in no village of the viewer: nothing is composed, nothing switched', async () => {
  scene();
  await C.ACTIONS['cq-march']({ host: String(hostId({ p: 9, q: 9, site: 1, gen: 0, seq: 7 })), p: '6', q: '-1', tile: '18' }).catch(() => {});
  assert.equal(FS.activeHolding, 0); assert.equal(FS.compose, null);
});

test('the source: local play asks the host\'s own march answer first, then the village switch (with the rail redrawn), then compose', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const fn = c.slice(c.indexOf("  'cq-march': async d => {"), c.indexOf("  'cq-outpost':"));
  assert.match(fn, /const hi = holdingIndexOfHost\(d\.host\);\n\s+if \(localPlay && localMarchFor\(hi !== null \? FS\.holdings\[hi\] : activeHolding\(FS\), d\.host\)\?\.open !== true\) return failed\(localPlayReadOnly\(\)\);\n\s+if \(hi !== null && hi !== \(FS\.activeHolding \?\? 0\)\) \{ FS\.activeHolding = hi; invalidate\('rail'\); \}\n\s+if \(!ACTIONS\.compose\(\{host:d\.host,stay:'map'\}\)\) return;/);
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const om = a.slice(a.indexOf('async function orderMarch(A, hit) {'), a.indexOf('async function orderMarch(A, hit) {') + 900);
  assert.match(om, /if \(FS\.localPlay && typeof FS\.localMarchFor === 'function'\) \{\n\s+const own = Number\.isInteger\(A\.actor\.holdingIndex\) \? FS\.holdings\?\.\[A\.actor\.holdingIndex\] \?\? null : null;\n\s+if \(FS\.localMarchFor\(own, A\.actor\.id\)\?\.open !== true\) \{ mapNote\(hit, \(\) => L`ローカルプレイでは、まだ命令を送れません（読み取りのみ）。`\); return; \}/);
  assert.ok(om.indexOf('FS.localMarchFor(own') < om.indexOf('ACTIONS.compose('), 'the map tap asks before composing');
});
