// fix-campreach-4 (Q-TG4-1, D-test-gaps-4-1): the march-first guide's province bound is the rules' own. travel.rs
// path_cost counts the provinces a route's steps ENTER — at most MAX_PATH_PROVINCES 4, the starting province not counted
// unless a step re-enters it — so a march may reach a camp 4 provinces away. hud/firstbattle.mjs campInBounds dropped
// every camp more than 3 away (`> MAX_ROUTE_PROVINCES - 1`); it now asks fkeepreach.mjs provinceInReach, the one bound
// the keep list's pending count (controller.mjs keepsPending) uses too, so they cannot drift apart.
// Unchanged: #265 (only a FIGHTING camp), #273 (the march card's route question decides; the fog; the practice battle).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { tileHex, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import * as W from '../../permutation-server/web/frontier/wasm.mjs';
import { planRoute } from '../../permutation-server/web/frontier/fmarch.mjs';
import { conquestObjective } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { MAX_PATH_STEPS } from '../../permutation-server/web/frontier/seal.mjs';
import { MAX_ROUTE_PROVINCES, provinceInReach } from '../../permutation-server/web/frontier/fkeepreach.mjs';

afterEach(() => setLang('ja'));
const CJK = /[぀-ヿ㐀-鿿]/;
const root = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const web = rel => root(`permutation-server/web/frontier/${rel}`);
const pd = (a, b) => hexDistance(a.p, a.q, b.p, b.q);

// ------------------------------------------------------------------ the bound (pure)
test('provinceInReach is the rules\' province bound: up to MAX_ROUTE_PROVINCES (4) provinces away, the start not counted', () => {
  assert.equal(MAX_ROUTE_PROVINCES, 4);
  const tr = root('permutation-rules/src/frontier/travel.rs');
  assert.ok(tr.includes('pub const MAX_PATH_PROVINCES: usize = 4;'));
  // the provinces counted are those the steps ENTER (the start hex is never pushed)
  assert.ok(tr.includes('    for (i, s) in steps.iter().enumerate() {') && tr.includes('        let p = province_of(s.hex);\n        if !provinces.contains(&p) {\n            if provinces.len() == MAX_PATH_PROVINCES {'));
  assert.equal(/provinces\.push\(province_of\(start\)\)/.test(tr), false, 'the start province is not counted');
  const o = { p: 0, q: 0 };
  for (let p = -7; p <= 7; p++) for (let q = -7; q <= 7; q++) {
    const d = pd(o, { p, q });
    assert.equal(provinceInReach(o, { p, q }), d <= 4, `${p},${q} (distance ${d})`);
    assert.equal(provinceInReach({ p, q }, o), d <= 4, 'symmetric');
    // campInBounds without tiles is the province bound alone
    assert.equal(FB.campInBounds(o, { p, q }), d <= 4, `campInBounds ${p},${q}`);
  }
  assert.equal(FB.campInBounds({ p: 0, q: 0 }, { p: 4, q: -2 }), true);
  assert.equal(FB.campInBounds({ p: 0, q: 0 }, { p: 4, q: 0 }), true);
  assert.equal(FB.campInBounds({ p: 0, q: 0 }, { p: 5, q: 0 }), false);
  // the step half is unchanged: 4 provinces apart but the tiles more than 32 hexes apart
  const far = { p: 4, q: 0, tile: 60 }, near0 = { p: 0, q: 0, tile: 0 };
  assert.ok(hexDistance(tileHex(0, 0, 0).q, tileHex(0, 0, 0).r, tileHex(4, 0, 60).q, tileHex(4, 0, 60).r) > MAX_PATH_STEPS);
  assert.equal(FB.campInBounds(near0, far), false);
  // the case D-test-gaps-4-1 found: (0,0) tile 59 → (4,-2) tile 47 is within 32 hexes
  assert.equal(FB.campInBounds({ p: 0, q: 0, tile: 59 }, { p: 4, q: -2, tile: 47 }), true);
});

// ------------------------------------------------------------------ the real rules (frontier.wasm)
const WASM = new URL('../../permutation-server/web/frontier/wasm/frontier.wasm', import.meta.url);
let kernelPromise = null;
async function realKernel(t) {
  if (!existsSync(WASM)) { t.skip('frontier.wasm is not built'); return null; }
  const bytes = readFileSync(WASM);
  const sha = readFileSync(new URL('frontier.wasm.sha256', WASM), 'utf8').trim().split(/\s+/)[0];
  kernelPromise ??= W.loadKernel({ url: 'x/frontier.wasm', sha256Hex: sha, fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
  return kernelPromise;
}
const SEEDS = Array.from({ length: 12 }, (_, d) => ({ ring: d, seed: d.toString(16).padStart(2, '0').repeat(32) }));
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, n) => Math.floor(r() * n);

const FROM = { p: 0, q: 0, tile: 59 }, CAMP4 = { p: 4, q: -2, tile: 47 };

test('the real kernel routes a march 4 provinces away and path_cost accepts it; campInBounds keeps every route the program accepts', async t => {
  const k = await realKernel(t);
  if (!k) return;
  const x = planRoute(k, { from: FROM, to: CAMP4, unit: 0, seeds: SEEDS, blocked: [] });
  assert.ok(x.ok, 'the rules route (0,0) t59 → (4,-2) t47');
  assert.equal(pd(FROM, CAMP4), 4);
  const c = k.call('path_cost', { start: tileHex(FROM.p, FROM.q, FROM.tile), dirs: x.route.dirs, unit: 0, seeds: SEEDS });
  assert.ok(c.ok, 'the program\'s own check accepts it');
  assert.equal(c.value.provinces.length, 4, 'it enters 4 provinces');
  assert.equal(c.value.provinces.some(v => v.p === 0 && v.q === 0), false, 'the start province is not among them');
  assert.equal(FB.campInBounds(FROM, CAMP4), true);
  // 600 random pairs up to 5 provinces apart: every route the program accepts is in bounds (sound), and no route the
  // program accepts lies 5 provinces away (the bound is tight on the province side)
  const r = rng(4242);
  let at4 = 0, accepted = 0;
  for (let i = 0; i < 600; i++) {
    const from = { p: pick(r, 7) - 3, q: pick(r, 7) - 3, tile: pick(r, 61) };
    const to = { p: from.p + pick(r, 11) - 5, q: from.q + pick(r, 11) - 5, tile: pick(r, 61) };
    const d = pd(from, to);
    if (d > 5) continue;
    const y = planRoute(k, { from, to, unit: 0, seeds: SEEDS, blocked: [] });
    if (!y.ok) continue;
    const v = k.call('path_cost', { start: tileHex(from.p, from.q, from.tile), dirs: y.route.dirs, unit: 0, seeds: SEEDS });
    if (!v.ok) continue;
    accepted++;
    assert.ok(d <= 4, `no accepted route 5 provinces away (${JSON.stringify({ from, to })})`);
    if (d === 4) at4++;
    assert.equal(FB.campInBounds(from, to), true, `an accepted route of ${y.route.dirs.length} steps from ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
  }
  assert.ok(accepted > 100, `${accepted} accepted routes`);
  assert.ok(at4 > 0, `some accepted routes go 4 provinces away (${at4})`);
});

// ------------------------------------------------------------------ the guide end to end (the real kernel as the march card's planner)
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const HID = hostId({ p: 0, q: 0, site: 2, gen: 0, seq: 1 });
const HOME = { p: 0, q: 0, site: 2, gen: 0, tile: FROM.tile, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const entry = { id: HID, unit: 0, state: 1, tile: FROM.tile, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0 };
const mirror = (held = 0) => Array.from({ length: 12 }, (_, i) => ({ state: i < held ? 1 : 0, faction: 0, gen: 0, garrison: 0 }));
const prov = (p, q, c, entries = []) => ({ province: { p, q, resolvedNext: 10, entries, ticketCohorts: [], siteCount: 12, sites: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], siteMirror: mirror(c?.held ?? 0),
  camp: c ? { state: 1, tile: c.tile, troops: c.troops, gen: 0 } : null } });
const world = (kernel, camps, extra = {}) => {
  const provinces = new Map([['0,0', prov(0, 0, null, [entry])]]);
  for (const c of camps) provinces.set(`${c.p},${c.q}`, prov(c.p, c.q, c));
  return { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [HOME], nowBell: 10, chain: { now: () => GEN + 10 * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
    provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null,
    kernel, record: { rings: SEEDS.map(s => ({ d: s.ring, seed: s.seed })) }, ...extra };
};
const host = { id: HID, unit: 0, troops: 300, p: 0, q: 0, tile: FROM.tile };

test('the only fighting camp in sight is 4 provinces away and routable: the guide names it (JA + EN), not the practice battle', async t => {
  const k = await realKernel(t);
  if (!k) return;
  const s = world(k, [{ ...CAMP4, troops: 120 }]);
  const c = FB.campChoice(s, host, { rough: () => false, reach: () => true });
  assert.deepEqual(c?.camp, { p: 4, q: -2, tile: 47, troops: 120 }, 'campChoice keeps it');
  const o = conquestObjective(s);
  assert.equal(o.go.act, 'ob-go', o.text);
  assert.match(o.text, /守り手 120/);
  assert.doesNotMatch(o.text, /まだこの軍勢が届きません/);
  assert.deepEqual(guideTarget(s), { step: 'camp', kind: 'march', p: 4, q: -2, tile: 47, host: String(HID) });
  setLang('en');
  const en = conquestObjective(s);
  assert.equal(en.go.act, 'ob-go');
  assert.doesNotMatch(en.text, CJK);
  assert.doesNotMatch(en.text, /season/i);
  assert.doesNotMatch(en.text, /No camp in reach yet/);
});

test('#273 kept: a camp 5 provinces away is never named (practice battle); a 4-province camp under the fog is not a candidate', async t => {
  const k = await realKernel(t);
  if (!k) return;
  const s5 = world(k, [{ p: 5, q: -2, tile: 47, troops: 120 }]);
  assert.equal(FB.campChoice(s5, host, { rough: () => false, reach: () => true }), null, 'out of bounds before the planner is asked');
  const o = conquestObjective(s5);
  assert.equal(o.go.act, 'practice-open');
  assert.match(o.text, /^見えている蛮族の野営地には、まだこの軍勢が届きません（1 回の進軍で行けるのは 4 州・32 マスまでです）。/);
  setLang('en');
  assert.match(conquestObjective(s5).text, /^No camp in reach yet: no barbarian camp in sight is within this host's reach \(one march goes at most 4 provinces and 32 tiles\)\./);
  setLang('ja');
  // the fog is unchanged: unseen → not a candidate, even within reach
  const s4 = world(k, [{ ...CAMP4, troops: 120 }]);
  assert.equal(FB.campChoice(s4, host, { seen: (p, q) => !(p === 4 && q === -2), reach: () => true }), null);
  // the planner still decides: a 4-province camp it refuses is not named
  assert.equal(FB.campChoice(s4, host, { reach: () => false }), null);
  // #265 kept: a 4-province camp in a province of 12 holdings sits out
  const s12 = world(k, [{ ...CAMP4, troops: 120, held: 12 }]);
  assert.equal(FB.campChoice(s12, host, { reach: () => true }), null);
});

// ------------------------------------------------------------------ the page's wiring (source pins)
test('one province bound on the page: campInBounds and keepsPending ask provinceInReach; no hand-written "- 1" bound is left', () => {
  const fb = web('hud/firstbattle.mjs'), ctl = web('controller.mjs'), kr = web('fkeepreach.mjs');
  assert.match(kr, /export const provinceInReach = \(from, to\) => hexDistance\(from\.p, from\.q, to\.p, to\.q\) <= MAX_ROUTE_PROVINCES;/);
  assert.match(fb, /import \{ provinceInReach \} from '\.\.\/fkeepreach\.mjs';/);
  assert.match(fb, /export function campInBounds\(r, \{ p, q, tile \}\) \{[\s\S]{0,200}if \(!provinceInReach\(\{ p: rp, q: rq \}, \{ p, q \}\)\) return false;/);
  assert.match(ctl, /const near = c => from\.length === 0 \|\| from\.some\(o => provinceInReach\(o, c\)\);/);
  // "Nearby destinations" filters camps through campInBounds (so the same bound)
  assert.match(ctl, /if \(from\) return out\.filter\(d => d\.kind !== 'camp' \|\| campInBounds\(from, d\)\);/);
  const dir = new URL('../../permutation-server/web/frontier/', import.meta.url);
  const walk = (u, out = []) => { for (const e of readdirSync(u, { withFileTypes: true })) { if (e.isDirectory()) { if (e.name !== 'wasm' && e.name !== 'vendor') walk(new URL(`${e.name}/`, u), out); } else if (e.name.endsWith('.mjs')) out.push(new URL(e.name, u)); } return out; };
  for (const f of walk(dir)) assert.doesNotMatch(readFileSync(f, 'utf8'), /MAX_ROUTE_PROVINCES\s*-\s*1/, f.pathname);
});
