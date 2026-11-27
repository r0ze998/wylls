// test-gaps-5 (#277 fix-campreach-4, tests only): the guide's camp bound is the rules' "4 entered provinces". What
// verify-pr277 checked by hand on live world data, automated on the real frontier.wasm:
//   CR1  400 random one-camp worlds (camps 3–5 provinces away): the march-first guide names the camp exactly when the
//        rules route it (planRoute, then the program's own path_cost: ≤ 4 entered provinces, ≤ 32 steps); a camp
//        5 provinces away is never named; some 4-province camps are named; the press opens the march card on it and the
//        card's own check (checkMarch) has no 'Path' refusal for that route;
//   CR2  the march card's "Nearby destinations" (controller.mjs quickDestinations, run from its own source) offers a
//        camp 4 provinces away and never one 5 away;
//   CR3  the keep list's pending count (controller.mjs keepsPending) waits for a province 4 away, not 5.
// Behaviour is not changed here. Key-free: no wallet, no key, no request.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { tileHex, hexDistance, ringOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import * as W from '../../permutation-server/web/frontier/wasm.mjs';
import { planRoute, checkMarch } from '../../permutation-server/web/frontier/fmarch.mjs';
import { conquestObjective } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { MAX_PATH_STEPS } from '../../permutation-server/web/frontier/seal.mjs';
import { MAX_ROUTE_PROVINCES } from '../../permutation-server/web/frontier/fkeepreach.mjs';
import { keepsPending } from '../../permutation-server/web/frontier/controller.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const pd = (a, b) => hexDistance(a.p, a.q, b.p, b.q);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

const WASM = new URL('wasm/frontier.wasm', WEB);
let kernelPromise = null;
async function realKernel(t) {
  if (!existsSync(WASM)) { t.skip('frontier.wasm is not built'); return null; }
  const bytes = readFileSync(WASM);
  const sha = readFileSync(new URL('frontier.wasm.sha256', WASM), 'utf8').trim().split(/\s+/)[0];
  kernelPromise ??= W.loadKernel({ url: 'x/frontier.wasm', sha256Hex: sha, fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
  return kernelPromise;
}
const SEEDS = Array.from({ length: 12 }, (_, d) => ({ ring: d, seed: d.toString(16).padStart(2, '0').repeat(32) }));

// ------------------------------------------------------------------ a one-camp world (as web-frontier-fix-campreach-4)
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const mirror = () => Array.from({ length: 12 }, () => ({ state: 0, faction: 0, gen: 0, garrison: 0 }));
const prov = (p, q, c, entries = []) => ({ province: { p, q, resolvedNext: 10, entries, ticketCohorts: [], siteCount: 12, sites: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], siteMirror: mirror(),
  camp: c ? { state: 1, tile: c.tile, troops: c.troops, gen: 0 } : null } });
function world(kernel, from, camp) {
  const hid = hostId({ p: from.p, q: from.q, site: 2, gen: 0, seq: 1 });
  const home = { p: from.p, q: from.q, site: 2, gen: 0, tile: from.tile, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
    transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
  const entry = { id: hid, unit: 0, state: 1, tile: from.tile, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0 };
  const provinces = new Map([[`${from.p},${from.q}`, prov(from.p, from.q, null, [entry])], [`${camp.p},${camp.q}`, prov(camp.p, camp.q, camp)]]);
  return { hid, FS: { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [home], nowBell: 10, chain: { now: () => GEN + 10 * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
    provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null,
    kernel, record: { rings: SEEDS.map(s => ({ d: s.ring, seed: s.seed })) } } };
}
const NEIGH = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
/** A province exactly `d` provinces from (0,0), uniformly around the ring of that distance. */
function provinceAt(r, d) {
  let p = -d, q = d; // start at a corner, walk the ring
  const ring = [];
  for (let side = 0; side < 6; side++) for (let k = 0; k < d; k++) { ring.push({ p, q }); p += NEIGH[side][0]; q += NEIGH[side][1]; }
  return ring[int(r, 0, ring.length - 1)];
}

/** The rules' answer: a route the planner finds AND the program's own path_cost accepts (≤ 4 entered, ≤ 32 steps). */
function rulesRoute(k, from, to) {
  const x = planRoute(k, { from, to, unit: 0, seeds: SEEDS, blocked: [] });
  if (!x.ok) return null;
  const c = k.call('path_cost', { start: tileHex(from.p, from.q, from.tile), dirs: x.route.dirs, unit: 0, seeds: SEEDS });
  if (!c.ok) return null;
  return { route: x.route, provinces: c.value.provinces, steps: x.route.dirs.length };
}

test('CR1 400 random one-camp worlds on the real kernel: the guide names a camp exactly when the rules route it; never 5 provinces away; the press opens the card on it and the card\'s check accepts the route', async t => {
  const k = await realKernel(t);
  if (!k) return;
  const r = rng(277);
  const tally = { named4: 0, named3: 0, practice4: 0, practice5: 0 };
  for (let i = 0; i < 400; i++) {
    const from = { p: 0, q: 0, tile: int(r, 0, 60) };
    const d = int(r, 3, 5), cp = provinceAt(r, d), camp = { ...cp, tile: int(r, 0, 60), troops: 120 };
    const { FS, hid } = world(k, from, camp);
    const want = rulesRoute(k, from, camp);
    if (d === 5) assert.equal(want, null, `the rules never accept a march 5 provinces away (${JSON.stringify({ from, camp })})`);
    const o = conquestObjective(FS), g = guideTarget(FS);
    const why = JSON.stringify({ from, camp, d, want: want && { steps: want.steps, provinces: want.provinces.length } });
    if (want) {
      assert.ok(want.provinces.length <= MAX_ROUTE_PROVINCES && want.steps <= MAX_PATH_STEPS, why);
      assert.equal(o.go?.act, 'ob-go', `${why}\n${o.text}`);
      assert.match(o.text, /守り手 120/, why);
      assert.deepEqual(g, { step: 'camp', kind: 'march', p: camp.p, q: camp.q, tile: camp.tile, host: String(hid) }, why);
      // the card the press opens plans the same route; its own check has no 'Path' refusal for it
      assert.ok(!checkMarch({ route: want.route, season: { ...SEASON, minRevealPriorityMilli: 1000, revealCuLimit: 200000, revealLoadedLimit: 65536 }, nowBell: 10 }).includes('Path'), why);
      tally[d === 4 ? 'named4' : 'named3']++;
    } else {
      assert.equal(o.go?.act, 'practice-open', `${why}\n${o.text}`);
      assert.notEqual(g?.kind, 'march', why);
      if (d === 4) tally.practice4++; else if (d === 5) tally.practice5++;
    }
  }
  assert.ok(tally.named4 >= 10 && tally.practice5 >= 60 && tally.named3 >= 10, JSON.stringify(tally));
});

// ------------------------------------------------------------------ CR2: "Nearby destinations", run from controller.mjs's own text
/** controller.mjs quickDestinations, taken out of the file as written (brace-matched) and run on a given FS. */
function quickDestinationsOf(FS, viewTile) {
  const text = src('controller.mjs');
  const at = text.indexOf('function quickDestinations(from = null) {');
  assert.ok(at > 0, 'controller.mjs still has quickDestinations');
  let depth = 0, end = -1;
  for (let i = text.indexOf('{', at); i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) { end = i + 1; break; } }
  const fn = new Function('FS', 'viewTile', 'campInBounds', `${text.slice(at, end)}\nreturn quickDestinations;`);
  return fn(FS, viewTile, FB.campInBounds);
}

test('CR2 the march card\'s "Nearby destinations" offers a camp 4 provinces away and never one 5 away (the fog cut first)', () => {
  const r = rng(4277);
  let four = 0, five = 0;
  for (let i = 0; i < 300; i++) {
    const from = { p: 0, q: 0, tile: int(r, 0, 60) };
    const camps = [];
    for (const d of [3, 4, 4, 5, 5]) {
      let c;
      do c = { ...provinceAt(r, d), tile: int(r, 0, 60), troops: 100, d }; while (camps.some(x => x.p === c.p && x.q === c.q));
      camps.push(c);
    }
    const provinces = new Map(camps.map(c => [`${c.p},${c.q}`, prov(c.p, c.q, c)]));
    const fogged = new Set(camps.filter(() => r() < 0.2).map(c => `${c.p},${c.q}`));
    const FS = { provinces, holdings: [{ p: 0, q: 0, tile: from.tile }] };
    const quick = quickDestinationsOf(FS, (p, q) => !fogged.has(`${p},${q}`));
    const listed = quick(from).filter(x => x.kind === 'camp');
    for (const c of camps) {
      const on = listed.some(x => x.p === c.p && x.q === c.q);
      const a = tileHex(0, 0, from.tile), b = tileHex(c.p, c.q, c.tile);
      const inSteps = hexDistance(a.q, a.r, b.q, b.r) <= MAX_PATH_STEPS;
      const want = !fogged.has(`${c.p},${c.q}`) && pd(from, c) <= 4 && inSteps;
      assert.equal(on, want, JSON.stringify({ from, c, fogged: fogged.has(`${c.p},${c.q}`), inSteps }));
      if (on && pd(from, c) === 4) four++;
      if (pd(from, c) === 5) assert.equal(on, false);
      if (pd(from, c) === 5 && !fogged.has(`${c.p},${c.q}`)) five++;
    }
    // without a host (no `from`) the fog cut alone, as before
    assert.equal(quick(null).filter(x => x.kind === 'camp').length, camps.filter(c => !fogged.has(`${c.p},${c.q}`)).length);
  }
  assert.ok(four > 30 && five > 100, `${four} offered 4 away, ${five} seen 5 away (never offered)`);
});

// ------------------------------------------------------------------ CR3: the keep list waits within the same bound
test('CR3 the keep list\'s pending count waits for a province 4 from an origin and never for one 5 away', () => {
  const r = rng(3277);
  for (let i = 0; i < 300; i++) {
    const origin = { p: int(r, -3, 3), q: int(r, -3, 3) };
    const cells = [];
    for (let d = 1; d <= 6; d++) { const c = provinceAt(r, d); cells.push({ p: origin.p + c.p, q: origin.q + c.q, control: 2, heartland: false, d }); }
    for (const c of cells) {
      const one = keepsPending([c], new Map(), () => false, () => true, [origin], 1);
      assert.equal(one, c.d <= 4 ? 1 : 0, JSON.stringify({ origin, c, ring: ringOf(c.p, c.q) }));
    }
    // no origin: not narrowed
    assert.equal(keepsPending(cells, new Map(), () => false, () => true, [], 1), cells.length);
  }
});
