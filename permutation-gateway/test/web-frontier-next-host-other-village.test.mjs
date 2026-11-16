// 次の軍勢 with a host of ANOTHER of the viewer's villages in hand (2026-11-16). A plain tap on its tile or its chip on a
// shared tile leaves the open village as it was (see web-frontier-dissolve-other-village). The bar's figure counted the
// OPEN village's hosts, which the host in hand is not among: it read 1/N, and with fewer than two hosts there the button
// was refused as 「ほかに軍勢はいません」. The press (app.mjs nextHost, also the keyboard's cycleHost) jumped to the open
// village's first host. Now both use the hosts of the host's own village, and the press then switches to it as
// selectHost does. hud/hand.mjs is driven; app.mjs (the page's DOM module) is pinned as text and its step applied as written.
// KEY-FREE: no key, nothing signed or sent, no request (a `fetch` stub, asserted unused), nothing stored.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { handModel } from '../../permutation-server/web/frontier/hud/hand.mjs';
import { ownHosts, subjectOf } from '../../permutation-server/web/frontier/hud/subject.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';

const village = (p, q, site, tile) => ({ p, q, site, gen: 0, tile, faction: 1, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const A = village(2, 0, 2, 20), B = village(5, -1, 4, 33);
const entry = (o, tile, troops) => ({ id: hostId({ ...o, gen: 0 }), unit: 0, state: 1, tile, troops, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10 });
const a1 = entry({ p: 2, q: 0, site: 2, seq: 1 }, 21, 100000), a2 = entry({ p: 2, q: 0, site: 2, seq: 2 }, 22, 90000);
const b1 = entry({ p: 5, q: -1, site: 4, seq: 1 }, 40, 300000), b2 = entry({ p: 5, q: -1, site: 4, seq: 2 }, 41, 200000), b3 = entry({ p: 5, q: -1, site: 4, seq: 3 }, 23, 150000);
const requests = [];
let oldFetch;
before(() => { oldFetch = globalThis.fetch; globalThis.fetch = async u => { requests.push(String(u)); return new Response('{}', { status: 503 }); }; });
after(() => { globalThis.fetch = oldFetch; });

function scene(aHosts, sel, hand = null) {
  Object.assign(FS, { mode: 'play', season: { programVersion: 3, layoutVersion: 2, endBell: 9999, bellSecs: 600, minLead: 2, maxLead: 72 },
    citizen: { faction: 1 }, holdings: [A, B], activeHolding: 0, clock: { genesisTs: 0 }, chain: { now: () => 600 * 10 + 100 }, nowBell: 10, inFlight: 0, compose: null, orders: [], proto: null, sample: false,
    provinces: new Map([['2,0', { province: { p: 2, q: 0, gen: 0, resolvedNext: 10, entries: [...aHosts, b3], ticketCohorts: [] } }], ['5,-1', { province: { p: 5, q: -1, gen: 0, resolvedNext: 10, entries: [b1, b2], ticketCohorts: [] } }]]),
    conquest: null, tab: 'map', selected: { kind: 'tile', ...sel }, hand });
}
const next = m => m.buttons.find(b => b.id === 'next');
// app.mjs nextHost and selectHost, as written there (pinned below): the list of the subject's village, then the switch
function pressNext(dir = 1) {
  const sub = subjectOf(FS);
  const all = ownHosts(sub?.kind === 'host' ? { ...FS, activeHolding: sub.holdingIndex } : FS);
  if (!all.length) return null;
  const at = sub?.kind === 'host' ? all.findIndex(r => r.id === sub.host.id) : -1;
  const row = all[((at + dir) % all.length + all.length) % all.length];
  if (row.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = row.holdingIndex;
  FS.selected = { kind: 'tile', p: row.p, q: row.q, idx: row.tile }; FS.hand = { host: String(row.id), pop: null };
  return row;
}

test('a plain tap on another village\'s host: the figure counts that host\'s own village, and it is among them', () => {
  scene([a1, a2], { p: 5, q: -1, idx: 40 });
  const m = handModel(FS);
  assert.equal(String(m.host.id), String(b1.id)); assert.equal(FS.activeHolding, 0, 'the open village is still A');
  const own = ownHosts({ ...FS, activeHolding: 1 });
  assert.equal(own.length, 3);
  assert.equal(next(m).figure, `${own.findIndex(r => r.id === String(b1.id)) + 1}/3`, 'its place among B\'s three hosts (it read 1/2: A\'s)');
  assert.equal(next(m).why, null);
});

test('the open village has one host, the other three: 次の軍勢 is not refused as 「ほかに軍勢はいません」', () => {
  scene([a1], { p: 5, q: -1, idx: 40 });
  const m = handModel(FS);
  assert.equal(next(m).why, null); assert.match(next(m).figure, /\/3$/);
});

test('pressed again and again: it goes round the host\'s own village, the figure following, and the village switches to it', () => {
  scene([a1, a2], { p: 5, q: -1, idx: 40 });
  const own = ownHosts({ ...FS, activeHolding: 1 }).map(r => r.id);
  let k = own.indexOf(String(b1.id));
  for (let i = 0; i < own.length + 1; i++) {
    const row = pressNext(1);
    k = (k + 1) % own.length;
    assert.equal(row.id, own[k], `press ${i + 1}`);
    assert.equal(FS.activeHolding, 1, 'B, the host\'s own village');
    assert.equal(next(handModel(FS)).figure, `${k + 1}/3`);
  }
  pressNext(-1); assert.equal(subjectOf(FS).host.id, own[(k + own.length - 1) % own.length], 'and back (the keyboard\'s previous)');
});

test('a host of the open village, and the village itself in hand: as before', () => {
  scene([a1, a2], { p: 2, q: 0, idx: 21 });
  const own = ownHosts(FS).map(r => r.id);
  assert.equal(next(handModel(FS)).figure, `${own.indexOf(String(a1.id)) + 1}/2`);
  scene([a1], { p: 2, q: 0, idx: 21 });
  assert.equal(next(handModel(FS)).why !== null, true, 'one host only: refused, as before');
  scene([a1, a2], { p: 2, q: 0, idx: 20 });
  assert.equal(handModel(FS).kind, 'village');
  assert.equal(pressNext(1).holdingIndex, 0, 'from the village: its own hosts');
});

test('the source: nextHost and the bar read the subject\'s own village (pinned as text)', () => {
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const nh = a.slice(a.indexOf('function nextHost(dir) {'), a.indexOf('\n}\n', a.indexOf('function nextHost(dir) {')));
  assert.match(nh, /const sub = hand\.subjectOf\(FS\);\n\s+const all = hand\.ownHosts\(sub\?\.kind === 'host' \? \{ \.\.\.FS, activeHolding: sub\.holdingIndex \} : FS\);\n\s+if \(!all\.length\) return;\n\s+const at = sub\?\.kind === 'host' \? all\.findIndex\(r => r\.id === sub\.host\.id\) : -1;\n\s+selectHost\(all\[\(\(at \+ dir\) % all\.length \+ all\.length\) % all\.length\], \{ fly: true \}\);/);
  assert.match(a, /function cycleHost\(dir\) \{ nextHost\(dir\); \}/); assert.match(a, /'hand-next': \(\) => nextHost\(1\),/);
  const sh = a.slice(a.indexOf('function selectHost(row, { fly = false } = {}) {'), a.indexOf('function selectHost(row, { fly = false } = {}) {') + 600);
  assert.match(sh, /if \(Number\.isInteger\(row\.holdingIndex\) && row\.holdingIndex >= 0 && row\.holdingIndex !== \(FS\.activeHolding \?\? 0\)\) FS\.activeHolding = row\.holdingIndex;\n\s+FS\.selected = \{ kind: 'tile', p: row\.p, q: row\.q, idx: row\.tile \};\n\s+FS\.hand = \{ host: String\(row\.id\), pop: null \};/);
  assert.match(readFileSync(new URL('../../permutation-server/web/frontier/hud/hand.mjs', import.meta.url), 'utf8'), /const all = ownHosts\(\{ \.\.\.FS, activeHolding: sub\.holdingIndex \}\);/);
});

test('isolation: no request, nothing stored', () => {
  assert.deepEqual(requests, []); assert.equal(globalThis.localStorage, undefined);
});
