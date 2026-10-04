// citizens/scenario/census.mjs (unit AC5; contract section 9.5): the pure census over hand-built decoded data (camps, field
// stacks, shields, can_depart), the schedule (first bell with a final village, then every 12 bells; ready.jsonl per bell;
// summary), and a run over herald files recorded from the paused m1-exit herald (read-only GETs of a local test chain)
// served by a fake herald on 127.0.0.1:0. The census writes only under AI_DIR/census and steers nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { hexDistance, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as C from '../citizens/scenario/census.mjs';

const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/ai-census-herald-recorded.json', import.meta.url), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-census-'));

// ------------------------------------------------------------------ pure pieces
test('province distances and windows: the lattice distance, 1 + 3d(d+1) provinces within d', () => {
  assert.equal(C.provinceDistance(0, 0, 0, 0), 0);
  assert.equal(C.provinceDistance(2, 0, -1, 1), 3);
  assert.equal(C.provinceDistance(3, -3, 0, 0), 3);
  assert.equal(C.provinceDistance(1, 1, -1, -1), 4);
  assert.equal(C.provinceDistance(1, -1, -1, 1), 2);
  for (const d of [0, 1, 3, 12]) assert.equal(C.provincesWithin(5, -2, d).length, 1 + 3 * d * (d + 1));
  for (const [p, q] of C.provincesWithin(5, -2, 4)) assert.ok(C.provinceDistance(5, -2, p, q) <= 4);
  assert.equal(C.CENSUS_EVERY, 12);
  assert.equal(C.WINDOW_PROVINCES, 12);
});

test('stamina and can_depart: policy.rs on a province entry (stamina +1 per bell, cap 120, 74 charged; scouts, transits, pending and unready hosts cannot)', () => {
  assert.equal(C.staminaAt(30, 100, 100), 30);
  assert.equal(C.staminaAt(30, 100, 99), 30);
  assert.equal(C.staminaAt(30, 100, 130), 60);
  assert.equal(C.staminaAt(30, 100, 1000), 120);
  const e = { id: 7n, state: 1, fromBell: 5, pendOp: 0, readyBell: 6, unit: 0, staminaValue: 46, staminaBell: 100 };
  assert.equal(C.canDepart(e, 127), false, '46 + 27 = 73 < 74');
  assert.equal(C.canDepart(e, 128), true, '46 + 28 = 74');
  assert.equal(C.canDepart({ ...e, unit: 6 }, 400), false, 'a scout');
  assert.equal(C.canDepart({ ...e, pendOp: 2 }, 400), false);
  assert.equal(C.canDepart({ ...e, readyBell: 401 }, 400), false);
  assert.equal(C.canDepart({ ...e, fromBell: 401 }, 400), false);
  assert.equal(C.canDepart({ ...e, state: 2 }, 400), false);
  assert.equal(C.canDepart(e, 400, new Set(['7'])), false, 'in transit');
  assert.equal(C.MARCH_STAMINA, 10 + 2 * 32);
});

test('shield end: founded_ts + 48 h, + 72 h when founded after game day 7', () => {
  assert.equal(C.shieldUntilOf({ foundedTs: 1_000n, foundedDay: 0 }), 1_000 + 48 * 3600);
  assert.equal(C.shieldUntilOf({ foundedTs: 1_000n, foundedDay: 7 }), 1_000 + 48 * 3600);
  assert.equal(C.shieldUntilOf({ foundedTs: 1_000n, foundedDay: 8 }), 1_000 + 72 * 3600);
});

// ------------------------------------------------------------------ a hand-built world
const GEN = 1_000_000;
const season = bell => ({ season: '31', genesisTs: GEN, bellSecs: 600, latestUnix: GEN + bell * 600 + 17, rMax: 16 });
const holding = (p, q, tile, over = {}) => ({ state: 2, p, q, site: 3, tile, tier: 0, foundedTs: BigInt(GEN + 10 * 600), foundedDay: 0, finalTs: BigInt(GEN + 12 * 600 + 5), ...over });
const entry = (id, over = {}) => ({ id: BigInt(id), faction: 0, unit: 0, tile: 0, state: 1, troops: 200_000, staminaValue: 120, staminaBell: 10, readyBell: 11, fromBell: 11, pendOp: 0, ...over });
function world() {
  // AI A (nation 0) with a village at (2,0) tile 30; a camp 1 province away and one 5 away; an enemy stack 2 away and an enemy garrison on a site tile.
  const ov = new Map(), pv = new Map();
  const put = (p, q, o, v) => { ov.set(`${p},${q}`, o); pv.set(`${p},${q}`, v); };
  put(2, 0, { sites: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hosts: [1, 0, 0, 0, 0, 0, 0] }, { sites: Uint8Array.from([30, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), camp: { tile: 0, state: 0, troops: 0 }, entries: [entry(100, { tile: 30 }), entry(101, { tile: 30, unit: 6 })] });
  put(3, 0, { sites: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hosts: [0, 0, 0, 0, 0, 0, 1] }, { sites: Uint8Array.from([40, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), camp: { tile: 22, state: 1, troops: 250 }, entries: [] });
  put(7, 0, { sites: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hosts: [0, 0, 0, 0, 0, 0, 1] }, { sites: Uint8Array.from([40, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), camp: { tile: 5, state: 1, troops: 120 }, entries: [] });
  put(4, 0, { sites: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hosts: [0, 2, 0, 0, 0, 0, 0] }, { sites: Uint8Array.from([31, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), camp: { tile: 0, state: 0, troops: 0 }, entries: [entry(200, { faction: 1, tile: 50, troops: 310_000 }), entry(201, { faction: 1, tile: 31, troops: 900_000 }), entry(202, { faction: 1, tile: 51, unit: 6 })] });
  // A camp that is gone (state 0) in a province whose overview still says camp: not live.
  put(2, 1, { sites: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hosts: [0, 0, 0, 0, 0, 0, 0] }, { sites: Uint8Array.from([40, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), camp: { tile: 9, state: 0, troops: 0 }, entries: [] });
  return { ov, pv };
}
const input = (w, ais, bell = 30, window = 12) => ({ season: season(bell), ais, overview: (p, q) => w.ov.get(`${p},${q}`) ?? null, province: (p, q) => w.pv.get(`${p},${q}`) ?? null, window, provincesNear: C.provincesWithin });
const aiA = { entry: { index: 1000, tag: 'aa', faction: 0 }, holdings: [holding(2, 0, 30)], hosts: [{ id: '100', unit: 0, troops: 200_000, province: [2, 0], tile: 30 }, { id: '101', unit: 6, troops: 100_000, province: [2, 0], tile: 30 }], transits: [] };

test('the census of one AI: its final village and shield, hosts that can depart, the nearest live camp (distance, troops) and open-field stacks of other nations', () => {
  const c = C.censusOf(input(world(), [aiA]));
  assert.equal(c.v, 1);
  assert.equal(c.bell, 30);
  assert.equal(c.window_provinces, 12);
  const a = c.ai[0];
  assert.equal(a.tag, 'aa');
  assert.deepEqual(a.final_village, { p: 2, q: 0, site: 3, tile: 30, tier: 0, founded_ts: GEN + 6000, final_ts: GEN + 7205, final_bell: 12, shield_until: GEN + 6000 + 172_800, shield_end_bell: 10 + 288, shielded: true });
  assert.equal(a.hosts.total, 2);
  assert.equal(a.hosts.can_depart, 1, 'the combat host; the scout cannot');
  assert.deepEqual(a.hosts.rows.map(h => [h.id, h.can_depart, h.stamina]), [['100', true, 120], ['101', false, 120]]);
  assert.equal(a.hosts.rows[0].troops, 200);
  // Camps: (3,0) 1 province away, 250 troops; (7,0) 5 away; (2,1) is a ghost (state 0).
  assert.equal(a.camps.in_window, 2);
  assert.equal(a.camps.within_3_provinces, 1);
  assert.deepEqual({ ...a.camps.nearest, distance_tiles: undefined }, { p: 3, q: 0, tile: 22, troops: 250, distance_provinces: 1, distance_tiles: undefined });
  const t = tileHex(2, 0, 30), u = tileHex(3, 0, 22);
  assert.equal(a.camps.nearest.distance_tiles, hexDistance(t.q, t.r, u.q, u.r));
  // Field stacks: only the enemy host off its site tiles (200 at tile 50); not the garrison on tile 31, not the scout, not our own.
  assert.equal(a.field_stacks.in_window, 1);
  assert.deepEqual({ ...a.field_stacks.nearest[0], distance_tiles: undefined }, { p: 4, q: 0, tile: 50, faction: 1, troops: 310, distance_provinces: 2, distance_tiles: undefined });
  assert.deepEqual(c.summary, { ai: 1, with_final_village: 1, with_camp_in_window: 1, with_camp_within_3_provinces: 1, with_field_stack_in_window: 1, with_can_depart_host: 1 });
});

test('the window limits what counts (a camp 5 provinces away is outside a window of 3); an AI with no final village is listed without a window; a transit blocks a depart', () => {
  const w = world();
  const near = C.censusOf(input(w, [aiA], 30, 3)).ai[0];
  assert.equal(near.camps.in_window, 1);
  assert.equal(near.camps.nearest.p, 3);
  const none = { entry: { index: 1001, tag: 'bb', faction: 1 }, holdings: [holding(-2, 0, 30, { state: 1 })], hosts: [], transits: [] };
  const c = C.censusOf(input(w, [aiA, none]));
  assert.equal(c.ai[1].final_village, null);
  assert.equal(c.ai[1].camps.nearest, null);
  assert.equal(c.summary.ai, 2);
  assert.equal(c.summary.with_final_village, 1);
  const moving = { ...aiA, transits: [{ host: '100' }] };
  assert.equal(C.censusOf(input(w, [moving])).ai[0].hosts.can_depart, 0);
  // Another nation's view of the same stack is a stack of the first nation.
  const bNation = { entry: { index: 1002, tag: 'cc', faction: 1 }, holdings: [holding(2, 0, 30)], hosts: [], transits: [] };
  const cb = C.censusOf(input(w, [bNation])).ai[0];
  assert.equal(cb.field_stacks.in_window, 0, 'its own nation\'s stacks are not "other nations"');
  // Nothing is written by the pure core and nothing in it steers: the object is JSON.
  assert.doesNotThrow(() => JSON.stringify(C.censusOf(input(w, [aiA]))));
});

// ------------------------------------------------------------------ the schedule
function stubHerald(w, getBell, ais) {
  return {
    async season() { return { ok: true, record: season(getBell()) }; },
    async me(wallet) {
      const a = ais.find(x => x.wallet === wallet);
      return { ok: true, citizen: {}, holdings: a.holdings(getBell()), record: { hosts: a.hosts(getBell()), transits: [] } };
    },
    async overview(ring) { return { ok: true, provinces: [...w.ov.entries()].map(([k, v]) => { const [p, q] = k.split(',').map(Number); return { p, q, ...v }; }) }; },
    async province(p, q) { const pv = w.pv.get(`${p},${q}`); return pv ? { ok: true, province: pv } : { ok: false, code: 'NotFound' }; },
  };
}

test('the schedule: ready.jsonl once per new bell; the first census at the first bell with a final village, then every 12 bells; the summary counts bells to the first and second host that can depart', async () => {
  const w = world();
  let bell = 5;
  const roster = { ai: [{ index: 1000, tag: 'aa', faction: 0, wallet: 'wa' }, { index: 1001, tag: 'bb', faction: 1, wallet: 'wb' }] };
  const ais = [
    { wallet: 'wa', holdings: b => (b >= 12 ? [holding(2, 0, 30)] : []), hosts: b => (b >= 12 ? [{ id: '100', unit: 0, troops: 200_000, province: [2, 0], tile: 30 }] : []) },
    { wallet: 'wb', holdings: () => [], hosts: () => [] },
  ];
  // The second combat host of A appears (entry 110) from bell 20.
  const baseEntries = w.pv.get('2,0').entries;
  const herald = stubHerald(w, () => bell, ais);
  const origProvince = herald.province;
  herald.province = async (p, q) => {
    const r = await origProvince(p, q);
    if (r.ok && p === 2 && q === 0) return { ok: true, province: { ...r.province, entries: bell >= 20 ? [...baseEntries, entry(110, { tile: 30 })] : baseEntries } };
    return r;
  };
  const origMe = herald.me;
  herald.me = async wallet => {
    const r = await origMe(wallet);
    if (wallet === 'wa' && bell >= 20) r.record.hosts = [...r.record.hosts, { id: '110', unit: 0, troops: 200_000, province: [2, 0], tile: 30 }];
    return r;
  };
  const aiDir = path.join(tmp, 'sched');
  const state = {};
  const files = () => fs.readdirSync(path.join(aiDir, 'census')).sort();
  const poll = async (b) => { bell = b; return C.pollOnce({ aiDir, herald, roster, state }); };
  let r = await poll(-1);
  assert.deepEqual(r.wrote, [], 'before genesis there is no bell: nothing is written, not even with force');
  r = await C.pollOnce({ aiDir, herald, roster, state, force: true });
  assert.deepEqual(r.wrote, []);
  assert.ok(!fs.existsSync(path.join(aiDir, 'census')));
  r = await poll(5);
  assert.deepEqual(r.wrote, ['ready.jsonl'], 'no final village yet: no census file');
  r = await poll(5);
  assert.deepEqual(r.wrote, [], 'the same bell is not written twice');
  r = await poll(12);
  assert.deepEqual(r.wrote, ['ready.jsonl', '12.json'], 'the first bell with a final village');
  for (const b of [13, 14, 15, 20, 23]) { r = await poll(b); assert.ok(!r.wrote.includes(`${b}.json`), `bell ${b}`); }
  r = await poll(24);
  assert.ok(r.wrote.includes('24.json'), '12 bells after the first');
  r = await poll(36);
  assert.ok(r.wrote.includes('36.json'));
  assert.deepEqual(files().filter(f => /^\d+\.json$/.test(f)), ['12.json', '24.json', '36.json']);
  const lines = fs.readFileSync(path.join(aiDir, 'census', 'ready.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.filter(l => l.tag === 'aa').length, [5, 12, 13, 14, 15, 20, 23, 24, 36].length);
  assert.deepEqual(lines.find(l => l.tag === 'aa' && l.bell === 12), { bell: 12, tag: 'aa', index: 1000, final: true, final_bell: 12, hosts: 1, can_depart: 1 });
  assert.equal(lines.find(l => l.tag === 'bb' && l.bell === 12).final, false);
  const sum = JSON.parse(fs.readFileSync(path.join(aiDir, 'census', 'summary.json'), 'utf8'));
  const a = sum.ai.find(x => x.tag === 'aa');
  assert.equal(sum.first_census, 12);
  assert.equal(a.first_final_bell, 12);
  assert.equal(a.first_can_depart_bell, 12);
  assert.equal(a.second_can_depart_bell, 20);
  assert.equal(a.bells_to_first_can_depart, 0);
  assert.equal(a.bells_to_second_can_depart, 8);
  const b = sum.ai.find(x => x.tag === 'bb');
  assert.equal(b.first_final_bell, null);
  assert.equal(b.bells_to_first_can_depart, null);
  // A restart takes the schedule from the files already there.
  const restarted = {};
  r = await C.pollOnce({ aiDir, herald, roster, state: restarted });
  assert.equal(restarted.first, 12);
  assert.deepEqual(r.wrote.filter(f => f.endsWith('.json')), [], 'bell 36 is already written');
  // `force` (the --once mode) writes the census whatever the schedule says.
  r = await C.pollOnce({ aiDir, herald, roster, state: restarted, force: true });
  assert.ok(r.wrote.includes('36.json') || fs.existsSync(path.join(aiDir, 'census', `${r.bell}.json`)));
  // Everything the census wrote is under census/.
  assert.deepEqual(fs.readdirSync(aiDir), ['census']);
});

test('summarizeReady turns the per-bell lines into the first and second bell with a host that can depart', () => {
  const s = C.summarizeReady([
    { bell: 3, tag: 'x', final: false, final_bell: null, hosts: 0, can_depart: 0 },
    { bell: 4, tag: 'x', final: true, final_bell: 4, hosts: 1, can_depart: 0 },
    { bell: 9, tag: 'x', final: true, final_bell: 4, hosts: 2, can_depart: 1 },
    { bell: 15, tag: 'x', final: true, final_bell: 4, hosts: 2, can_depart: 2 },
  ], 4);
  assert.deepEqual(s.ai[0], { tag: 'x', first_final_bell: 4, first_can_depart_bell: 9, second_can_depart_bell: 15, bells_to_first_can_depart: 5, bells_to_second_can_depart: 11 });
});

// ------------------------------------------------------------------ recorded herald files
function recordedHerald() {
  return http.createServer((req, res) => {
    const f = recorded.files[req.url] ?? recorded.files[req.url.split('?')[0]];
    if (!f) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"code":"NotYet"}'); }
    res.writeHead(f.status, { 'content-type': f.type ?? 'application/octet-stream' });
    res.end(Buffer.from(f.body_b64, 'base64'));
  });
}

test('over herald files recorded from the paused m1-exit herald (a local test chain): the real shapes decode and the census reads them', async () => {
  const srv = recordedHerald();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const herald = createHerald({ base: `http://127.0.0.1:${srv.address().port}` });
    const c = await C.collectCensus({ herald, roster: recorded.roster, window: 2 });
    assert.equal(c.bell, 1034, 'the recorded season record\'s bell');
    assert.equal(c.ai.length, 2);
    const [a, b] = c.ai;
    // Bot 146 (nation 0) holds a village at province (2,4), site 10, tile 23; its shield (48 h from founding) was over.
    assert.deepEqual(a.final_village, { p: 2, q: 4, site: 10, tile: 23, tier: 0, founded_ts: 1_789_262_824, final_ts: 1_789_263_396, final_bell: 295, shield_until: 1_789_262_824 + 172_800, shield_end_bell: 583, shielded: false });
    // Read independently from the recorded bytes: each of the two hosts stands at full stamina; the combat host can depart, the scout cannot.
    assert.equal(a.hosts.total, 2);
    assert.equal(a.hosts.can_depart, 1);
    assert.deepEqual(a.hosts.rows.map(h => [h.unit, h.can_depart, h.stamina]), [[0, true, 120], [6, false, 120]]);
    assert.equal(a.hosts.rows[0].troops, 200);
    assert.equal(b.final_village.p, 1);
    assert.equal(b.final_village.q, -7);
    assert.equal(b.hosts.can_depart, 1);
    // The roster of the recording gives both a nation 0; the other nation's hosts near (1,-7) are stacks to it.
    assert.ok(b.field_stacks.in_window > 0);
    for (const s of b.field_stacks.nearest) { assert.notEqual(s.faction, 0); assert.ok(s.distance_provinces <= 2); }
    assert.equal(c.summary.with_final_village, 2);
  } finally { await new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }); }
});

test('the census source: loopback only, no write outside census/, no port bound, no outside URL', () => {
  const src = fs.readFileSync(new URL('../citizens/scenario/census.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /anthropic|openai|devnet|https?:\/\/(?!127\.0\.0\.1|\[::1\]|localhost)/i);
  assert.doesNotMatch(src, /\.listen\(|createServer/);
  assert.match(src, /is not a loopback URL/);
  const writes = [...src.matchAll(/(writeFileSync|appendFileSync|writeAtomic)\(/g)].length;
  assert.ok(writes >= 1);
  assert.doesNotMatch(src, /\bpost\b|method: 'POST'/i, 'it only reads');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
