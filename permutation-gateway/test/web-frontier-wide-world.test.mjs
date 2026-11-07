// The recorded wide world, read-only (permutation-server/web/frontier/map/
// wide.mjs and the herald client's wideWorld/wideWorldPage): coordinates
// are BigInts from decimal strings and never pass through Number (2⁶² and
// 2⁵³ + 1 survive); ring, wedge and position are recomputed as frontier-abi
// `WideCoord::ring_position` does and the herald's are not believed; the
// world namespace is recomputed from the public Season address and
// program; a sample world, another season, another world, a stale
// snapshot, a wrong page, a repeat, a disorder and a lying ring are each
// refused by name; a walk joins bounded pages in order, is cut at its page
// limit, drops its answer after a reset or an abort, and keeps nothing of
// a page it refused; a herald without the world says so. Fixed data only:
// no keys, no network (a fake fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWideInt, ringOfWide, ringPosition, compareRingOrder, worldIdOf, parseWideManifest, parseWidePage, WideWalk, loadWide,
  sourcePins, originAt, ORIGIN_CONCORD, relativeTo, layoutWide, nearestTo, formatCoord, describeWalk, WideError, WIDE_BOUND, WORLD_DOMAIN, PAGE_MAX,
} from '../../permutation-server/web/frontier/map/wide.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';
import { encode as toB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';

// ------------------------------------------------------------------ fixed data (the herald's fixture season: program 0x5E…, a Season PDA stands in as fixed bytes)
const PROGRAM = toB58(new Uint8Array(32).fill(0x5e));
const SEASON_ADDR = toB58(new Uint8Array(32).fill(3));
const WORLD = worldIdOf(SEASON_ADDR, PROGRAM);
const OTHER_WORLD = worldIdOf(toB58(new Uint8Array(32).fill(4)), PROGRAM);
const STAMP = 'ab'.repeat(32);
const SNAP = { epoch: '4', stamp: STAMP };
const CURSOR = '0c'.repeat(106);
const CURSOR2 = '0d'.repeat(106);

const entry = (p, q, ring, wedge, pos, extra = {}) => ({
  p: String(p), q: String(q), ring: String(ring), wedge, pos: String(pos), state: 'open', revision: '1', observedAt: '0',
  legacy: { p, q, index: null, ring, region: 3, openedBell: 0, slot: 10 + ring, address: SEASON_ADDR },
  ...extra,
});
/** The fixture's four Provinces in ring order: (2,0) w0 p0; (1,1) w0 p1; (0,2) w1 p0; (3,0). */
const E = [entry(2, 0, 2, 0, 0), entry(1, 1, 2, 0, 1), entry(0, 2, 2, 1, 0), entry(3, 0, 3, 0, 0)];

const manifest = (over = {}) => ({
  v: 1, experimental: true, readOnly: true, completeness: 'captured', world: WORLD, worldDomain: WORLD_DOMAIN,
  season: '5', program: PROGRAM, seasonAddress: SEASON_ADDR, snapshot: SNAP, recorded: 4, refused: 0,
  legacy: { rMax: 16, rMaxHard: 128, ringsOpened: 4, provinces: 4 }, page: { path: '/h/world/wide/page', max: 256, default: 64 }, ...over,
});
const page = (entries, { after = null, next = null, world = WORLD, snapshot = SNAP, limit = 64 } = {}) => ({ v: 1, world, snapshot, after, limit, entries, next });

const refused = (fn, code) => {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert.ok(e instanceof WideError, `expected a WideError ${code}, got ${e}`);
  assert.equal(e.code, code);
};

// ------------------------------------------------------------------ integers and geometry
test('a coordinate is a canonical decimal string and never a Number', () => {
  assert.equal(parseWideInt('0'), 0n);
  assert.equal(parseWideInt('-1'), -1n);
  assert.equal(parseWideInt('4611686018427387904'), 1n << 62n);
  assert.equal(parseWideInt('-4611686018427387904'), -(1n << 62n));
  assert.equal(parseWideInt('9007199254740993'), (1n << 53n) + 1n);
  for (const bad of ['+1', '01', '-0', '', ' 1', '1 ', '1.0', '1e3', '0x10', '4611686018427387905', 1, 1n, null, undefined, '١']) refused(() => parseWideInt(bad), 'BadCoord');
  assert.equal(WIDE_BOUND, 4611686018427387904n);
});

test('ring, wedge and position are exact past 2^53 and equal the legacy rule within the disk', () => {
  // 2^53 + 1 is not a double: Number loses it, BigInt keeps it
  const big = (1n << 53n) + 1n;
  assert.notEqual(BigInt(Number(big)), big);
  assert.equal(ringOfWide(big, 0n), big);
  assert.equal(ringOfWide(1n << 62n, -1n), 1n << 62n);
  assert.equal(ringOfWide(-(1n << 62n), 1n << 62n), 1n << 62n);
  assert.deepEqual(ringPosition(0n, 0n), { ring: 0n, wedge: 0, pos: 0n });
  // the fixture's provinces, as the Rust tests pin them
  assert.deepEqual(ringPosition(2n, 0n), { ring: 2n, wedge: 0, pos: 0n });
  assert.deepEqual(ringPosition(1n, 1n), { ring: 2n, wedge: 0, pos: 1n });
  assert.deepEqual(ringPosition(0n, 2n), { ring: 2n, wedge: 1, pos: 0n });
  assert.deepEqual(ringPosition(3n, 0n), { ring: 3n, wedge: 0, pos: 0n });
  assert.deepEqual(ringPosition(-1n, 0n), { ring: 1n, wedge: 3, pos: 0n });
  assert.deepEqual(ringPosition(1n << 62n, 0n), { ring: 1n << 62n, wedge: 0, pos: 0n });
  assert.deepEqual(ringPosition(0n, 1n << 62n), { ring: 1n << 62n, wedge: 1, pos: 0n });
  // ring order: the fixture's order, then a far one last
  const order = [[3n, 0n], [0n, 2n], [1n, 1n], [2n, 0n], [big, 0n], [0n, 0n]].map(([p, q]) => ({ p, q, ...ringPosition(p, q) })).sort(compareRingOrder);
  assert.deepEqual(order.map(x => [x.p, x.q]), [[0n, 0n], [2n, 0n], [1n, 1n], [0n, 2n], [3n, 0n], [big, 0n]]);
  assert.equal(compareRingOrder(ringPosition(2n, 0n), ringPosition(2n, 0n)), 0);
  assert.equal(formatCoord(1n << 62n, -1n), 'P 4611686018427387904, Q -1');
});

test('the world namespace is the public season bytes under the herald domain', () => {
  const want = toHex(sha256(WORLD_DOMAIN, new Uint8Array(32).fill(3), new Uint8Array(32).fill(0x5e)));
  assert.equal(WORLD, want);
  assert.equal(WORLD.length, 64);
  assert.notEqual(WORLD, '0'.repeat(64));
  assert.equal(worldIdOf(SEASON_ADDR, PROGRAM), WORLD, 'deterministic');
  assert.notEqual(worldIdOf(SEASON_ADDR, toB58(new Uint8Array(32).fill(0x5f))), WORLD, 'another program, another world');
  assert.notEqual(OTHER_WORLD, WORLD);
  refused(() => worldIdOf(toB58(new Uint8Array(31)), PROGRAM), 'BadAddress');
});

// ------------------------------------------------------------------ the manifest
test('a manifest is checked against its own namespace and the page pins; a sample never passes', () => {
  const m = parseWideManifest(manifest(), { seasonId: '5', seasonAddress: SEASON_ADDR, programId: PROGRAM });
  assert.equal(m.world, WORLD);
  assert.equal(m.season, '5');
  assert.deepEqual(m.snapshot, { epoch: 4n, stamp: STAMP });
  assert.equal(m.recorded, 4);
  assert.equal(m.page.max, 256);
  assert.equal(m.legacy.rMaxHard, 128);
  // the page max is capped at the index's
  assert.equal(parseWideManifest(manifest({ page: { max: 9999 } })).page.max, PAGE_MAX);
  refused(() => parseWideManifest(manifest({ sample: { world: 'sample', rate: 60 } })), 'SampleWorld');
  refused(() => parseWideManifest(manifest({ proto: { claims: true } })), 'SampleWorld');
  refused(() => parseWideManifest(manifest({ world: OTHER_WORLD })), 'WorldMismatch');
  refused(() => parseWideManifest(manifest({ program: toB58(new Uint8Array(32).fill(9)) })), 'WorldMismatch');
  refused(() => parseWideManifest(manifest(), { seasonId: '6' }), 'WrongSeason');
  refused(() => parseWideManifest(manifest(), { seasonAddress: toB58(new Uint8Array(32).fill(4)) }), 'WrongSeason');
  refused(() => parseWideManifest(manifest(), { programId: toB58(new Uint8Array(32).fill(4)) }), 'WrongSeason');
  refused(() => parseWideManifest(manifest({ world: '0'.repeat(64) })), 'BadManifest');
  refused(() => parseWideManifest(manifest({ completeness: 'all' })), 'BadManifest');
  refused(() => parseWideManifest(manifest({ readOnly: false })), 'BadManifest');
  refused(() => parseWideManifest(manifest({ experimental: undefined })), 'BadManifest');
  refused(() => parseWideManifest(manifest({ v: 2 })), 'BadManifest');
  refused(() => parseWideManifest(manifest({ worldDomain: 'other' })), 'BadManifest');
  refused(() => parseWideManifest(manifest({ snapshot: { epoch: 4, stamp: STAMP } })), 'BadManifest');
  refused(() => parseWideManifest(null), 'BadManifest');
});

// ------------------------------------------------------------------ a page
test('a page is bound to its world, snapshot and cursor, ordered, exact and without repeats', () => {
  const opts = { world: WORLD, snapshot: { epoch: 4n, stamp: STAMP }, limit: 64 };
  const p = parseWidePage(page(E), opts);
  assert.equal(p.entries.length, 4);
  assert.deepEqual(p.entries.map(e => [e.p, e.q]), [[2n, 0n], [1n, 1n], [0n, 2n], [3n, 0n]]);
  assert.equal(typeof p.entries[0].p, 'bigint');
  assert.equal(p.entries[0].key, '2,0');
  assert.deepEqual(p.entries[2].legacy.slot, 12);
  assert.equal(p.next, null);
  // a full page with a cursor
  const full = parseWidePage(page(E.slice(0, 2), { next: CURSOR, limit: 2 }), { ...opts, limit: 2 });
  assert.equal(full.next, CURSOR);
  const second = parseWidePage(page(E.slice(2), { after: CURSOR, limit: 2 }), { ...opts, limit: 2, after: CURSOR, previous: full.entries[1] });
  assert.equal(second.entries.length, 2);
  // refusals, each by name
  refused(() => parseWidePage(page(E, { world: OTHER_WORLD }), opts), 'WorldChanged');
  refused(() => parseWidePage(page(E, { snapshot: { epoch: '5', stamp: STAMP } }), opts), 'StaleSnapshot');
  refused(() => parseWidePage(page(E, { snapshot: { epoch: '4', stamp: 'cd'.repeat(32) } }), opts), 'StaleSnapshot');
  refused(() => parseWidePage(page(E, { after: CURSOR }), opts), 'WrongPage');
  refused(() => parseWidePage(page(E), { ...opts, after: CURSOR }), 'WrongPage');
  refused(() => parseWidePage(page([E[0], E[0]]), opts), 'DuplicateEntry');
  refused(() => parseWidePage(page([E[1], E[0]]), opts), 'OutOfOrder');
  refused(() => parseWidePage(page([E[0]]), { ...opts, previous: parseWidePage(page([E[1]]), opts).entries[0] }), 'OutOfOrder');
  refused(() => parseWidePage(page([E[0]]), { ...opts, previous: parseWidePage(page([E[0]]), opts).entries[0] }), 'DuplicateEntry');
  // the herald's ring, wedge and position are recomputed, not believed
  refused(() => parseWidePage(page([entry(2, 0, 3, 0, 0)]), opts), 'BadPage');
  refused(() => parseWidePage(page([entry(2, 0, 2, 1, 0)]), opts), 'BadPage');
  refused(() => parseWidePage(page([entry(1, 1, 2, 0, 0)]), opts), 'BadPage');
  refused(() => parseWidePage(page([entry(2, 0, 2, 0, 0, { legacy: { p: 2, q: 1 } })]), opts), 'BadPage');
  refused(() => parseWidePage(page([entry(2, 0, 2, 0, 0, { state: 'owned' })]), opts), 'BadPage');
  refused(() => parseWidePage(page([entry(2, 0, 2, 0, 0, { revision: '0' })]), opts), 'BadPage');
  refused(() => parseWidePage(page([{ ...entry(2, 0, 2, 0, 0), p: 2 }]), opts), 'BadCoord');
  refused(() => parseWidePage(page([{ ...entry(2, 0, 2, 0, 0), p: '02' }]), opts), 'BadCoord');
  refused(() => parseWidePage(page(E), { ...opts, limit: 3 }), 'BadPage');
  refused(() => parseWidePage(page(E, { next: CURSOR }), opts), 'BadCursor');
  refused(() => parseWidePage(page(E.slice(0, 2), { next: 'zz', limit: 2 }), { ...opts, limit: 2 }), 'BadCursor');
  refused(() => parseWidePage(page(E.slice(2), { after: CURSOR, next: CURSOR, limit: 2 }), { ...opts, limit: 2, after: CURSOR }), 'BadCursor');
  refused(() => parseWidePage({ ...page(E), sample: true }, opts), 'SampleWorld');
  // a closed entry is listed, known and distinct from an unlisted place
  const closed = parseWidePage(page([entry(2, 0, 2, 0, 0, { state: 'closed', revision: '2', legacy: null })]), opts);
  assert.equal(closed.entries[0].state, 'closed');
  assert.equal(closed.entries[0].legacy, null);
  // a far entry (no legacy identity) decodes exactly
  const far = parseWidePage(page([entry(2, 0, 2, 0, 0), { ...entry(0, 0, 0, 0, 0), p: '4611686018427387904', q: '0', ring: '4611686018427387904', wedge: 0, pos: '0', legacy: null }]), opts);
  assert.equal(far.entries[1].p, 1n << 62n);
  assert.equal(far.entries[1].ring, 1n << 62n);
});

// ------------------------------------------------------------------ the walk
function fakeClient(pages, { manifest: m = manifest(), onPage = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    async wideWorld({ signal } = {}) { calls.push(['manifest']); if (signal?.aborted) return { ok: false, code: 'Aborted' }; return { ok: true, manifest: parseWideManifest(m) }; },
    async wideWorldPage({ limit, after, signal } = {}) {
      calls.push(['page', limit, after]);
      if (signal?.aborted) return { ok: false, code: 'Aborted' };
      const i = after === null ? 0 : pages.findIndex(p => p.next === after) + 1;
      await onPage(i);
      const p = pages[i];
      return p ? { ok: true, json: p } : { ok: false, code: 'BadCursor' };
    },
  };
}

test('a walk joins bounded pages in order and keeps the snapshot it began on', async () => {
  const pages = [page(E.slice(0, 2), { next: CURSOR, limit: 2 }), page(E.slice(2), { after: CURSOR, limit: 2 })];
  const client = fakeClient(pages);
  const r = await loadWide(client, { walk: new WideWalk({ limit: 2 }) });
  assert.equal(r.ok, true);
  assert.equal(r.walk.done, true);
  assert.equal(r.walk.truncated, false);
  assert.equal(r.walk.pages, 2);
  assert.deepEqual(r.walk.list().map(e => e.key), ['2,0', '1,1', '0,2', '3,0']);
  assert.deepEqual(client.calls, [['manifest'], ['page', 2, null], ['page', 2, CURSOR]]);
  assert.deepEqual(describeWalk(r.walk), { recorded: 4, shown: 4, open: 4, closed: 0, truncated: false, snapshot: { epoch: 4n, stamp: STAMP } });
  // the page limit the walk asks for never exceeds the manifest's
  const small = await loadWide(fakeClient([page(E, { limit: 1 })], { manifest: manifest({ page: { max: 1 } }) }), { walk: new WideWalk({ limit: 64 }) });
  assert.equal(small.ok, false, 'four entries for a limit of one is refused');
  assert.equal(small.code, 'BadPage');
  // cut at the page limit: said so, not passed off as the whole
  const cut = await loadWide(fakeClient(pages), { walk: new WideWalk({ limit: 2, maxPages: 1 }) });
  assert.equal(cut.ok, true);
  assert.equal(cut.walk.truncated, true);
  assert.equal(cut.walk.entries.size, 2);
  // a world with nothing recorded: one empty page, done
  const empty = await loadWide(fakeClient([page([])], { manifest: manifest({ recorded: 0 }) }));
  assert.equal(empty.ok, true);
  assert.equal(empty.walk.entries.size, 0);
});

test('a world or snapshot that changes under the walk is refused, and a refused page leaves nothing behind', async () => {
  const switched = [page(E.slice(0, 2), { next: CURSOR, limit: 2 }), page(E.slice(2), { after: CURSOR, limit: 2, world: OTHER_WORLD })];
  const r = await loadWide(fakeClient(switched), { walk: new WideWalk({ limit: 2 }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WorldChanged');
  assert.equal(r.walk.fault, 'WorldChanged');
  assert.equal(r.walk.open, false);
  assert.deepEqual(r.walk.list().map(e => e.key), ['2,0', '1,1'], 'the refused page added nothing');
  const stale = [page(E.slice(0, 2), { next: CURSOR, limit: 2 }), page(E.slice(2), { after: CURSOR, limit: 2, snapshot: { epoch: '5', stamp: STAMP } })];
  const s = await loadWide(fakeClient(stale), { walk: new WideWalk({ limit: 2 }) });
  assert.equal(s.code, 'StaleSnapshot');
  const dup = [page(E.slice(0, 2), { next: CURSOR, limit: 2 }), page([E[1], E[2]], { after: CURSOR, limit: 2 })];
  const d = await loadWide(fakeClient(dup), { walk: new WideWalk({ limit: 2 }) });
  assert.equal(d.code, 'DuplicateEntry');
  // the second page says it follows another cursor than the one asked for
  const wrong = [page(E.slice(0, 2), { next: CURSOR, limit: 2 }), page(E.slice(2), { after: CURSOR2, limit: 2 })];
  const w = await loadWide(fakeClient(wrong), { walk: new WideWalk({ limit: 2 }) });
  assert.equal(w.code, 'WrongPage');
  // the herald refusing a cursor (409 StaleSnapshot) ends the walk with that code
  const refusing = { ...fakeClient([page(E.slice(0, 2), { next: CURSOR, limit: 2 })]), async wideWorldPage({ after }) { return after === null ? { ok: true, json: page(E.slice(0, 2), { next: CURSOR, limit: 2 }) } : { ok: false, code: 'StaleSnapshot' }; } };
  const h = await loadWide(refusing, { walk: new WideWalk({ limit: 2 }) });
  assert.equal(h.code, 'StaleSnapshot');
  assert.equal(h.walk.fault, 'StaleSnapshot');
  assert.equal(h.walk.accept(page(E.slice(2), { after: CURSOR, limit: 2 })), 'StaleSnapshot', 'a faulted walk takes no more pages');
});

test('a reset or an abort drops the answer of a walk in flight; an unavailable world is said, never faked', async () => {
  const pages = [page(E.slice(0, 2), { next: CURSOR, limit: 2 }), page(E.slice(2), { after: CURSOR, limit: 2 })];
  // abort between pages (a new load starting): the first load answers Aborted and keeps no walk
  const ac = new AbortController();
  const client = fakeClient(pages, { onPage: i => { if (i === 0) ac.abort(); } });
  const r = await loadWide(client, { walk: new WideWalk({ limit: 2 }), signal: ac.signal });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'Aborted');
  assert.equal(client.calls.length, 2, 'no page was asked after the abort');
  // a reset of the walk while a page is in flight
  const walk = new WideWalk({ limit: 2 });
  const client2 = fakeClient(pages, { onPage: i => { if (i === 0) walk.reset(); } });
  const r2 = await loadWide(client2, { walk });
  assert.equal(r2.code, 'Aborted');
  assert.equal(walk.entries.size, 0);
  // the token: a late page of an earlier walk is 'aborted', not merged
  const w3 = new WideWalk({ limit: 2 });
  const t = w3.begin(parseWideManifest(manifest()));
  w3.reset();
  assert.equal(w3.accept(pages[0], t), 'aborted');
  assert.equal(w3.entries.size, 0);
  // no recorded world on this herald
  const none = { async wideWorld() { return { ok: false, code: 'WideWorldUnavailable' }; }, async wideWorldPage() { throw new Error('never asked'); } };
  const u = await loadWide(none);
  assert.equal(u.ok, false);
  assert.equal(u.code, 'WideWorldUnavailable');
  assert.equal(u.walk.manifest, null);
  assert.equal(u.walk.entries.size, 0);
  // a sample world's manifest is refused by the client before any page
  const sample = { async wideWorld() { try { parseWideManifest(manifest({ sample: { world: 'sample' } })); } catch (e) { return { ok: false, code: e.code }; } return { ok: true }; }, async wideWorldPage() { throw new Error('never asked'); } };
  assert.equal((await loadWide(sample)).code, 'SampleWorld');
});

// ------------------------------------------------------------------ the camera
test('the layout is relative to a BigInt origin, exact where a double would not be', () => {
  const o = originAt('4611686018427387903', '0');
  assert.equal(o.p, (1n << 62n) - 1n);
  assert.deepEqual(relativeTo(o, 1n << 62n, 0n), { dp: 1, dq: 0 });
  assert.deepEqual(relativeTo(o, (1n << 62n) - 5n, 3n), { dp: -4, dq: 3 });
  // the same difference through Number is wrong: 2^62 and 2^62 − 1 are one double
  assert.equal(Number(1n << 62n) - Number((1n << 62n) - 1n), 0);
  assert.equal(relativeTo(ORIGIN_CONCORD, 1n << 62n, 0n), null, 'too far for this camera: recentre first');
  assert.equal(relativeTo(ORIGIN_CONCORD, 1n << 31n, 0n), null);
  assert.deepEqual(relativeTo(ORIGIN_CONCORD, (1n << 31n) - 1n, -(1n << 31n) + 1n), { dp: 2 ** 31 - 1, dq: -(2 ** 31 - 1) });
  refused(() => originAt('4611686018427387905', '0'), 'BadCoord');
  refused(() => originAt(1, 0), 'BadCoord');
  const entries = parseWidePage(page([entry(2, 0, 2, 0, 0), entry(1, 1, 2, 0, 1), { ...entry(0, 0, 0, 0, 0), p: '4611686018427387904', ring: '4611686018427387904', legacy: null }]), { world: WORLD, snapshot: { epoch: 4n, stamp: STAMP } }).entries;
  const lay = layoutWide(entries, ORIGIN_CONCORD);
  assert.deepEqual(lay.near.map(n => [n.dp, n.dq]), [[2, 0], [1, 1]]);
  assert.equal(lay.far, 1);
  const farLay = layoutWide(entries, originAt(1n << 62n, 0n));
  assert.deepEqual(farLay.near.map(n => [n.entry.key, n.dp, n.dq]), [['4611686018427387904,0', 0, 0]]);
  assert.equal(farLay.far, 2);
  assert.equal(nearestTo(entries, originAt(3n, 0n)).key, '2,0');
  assert.equal(nearestTo(entries, originAt((1n << 62n) - 7n, 0n)).key, '4611686018427387904,0');
  assert.equal(nearestTo([], ORIGIN_CONCORD), null);
});

// ------------------------------------------------------------------ the herald client
function fakeFetch(routes) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url: String(url), signal: init?.signal ?? null });
    const r = routes[new URL(url, 'http://h').pathname + (new URL(url, 'http://h').search || '')] ?? routes[new URL(url, 'http://h').pathname];
    if (!r) return { ok: false, status: 404, json: async () => ({ ok: false, code: 'NotFound' }) };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  f.seen = seen;
  return f;
}

test('the herald client says when the world is unavailable, pins the season and passes the abort signal', async () => {
  const off = createHerald({ base: 'http://h', fetch: fakeFetch({}), seasonId: 5 });
  assert.equal((await off.wideWorld()).code, 'WideWorldUnavailable', 'an older herald: 404');
  const dense = createHerald({ base: 'http://h', fetch: fakeFetch({ '/h/world/wide': { status: 503, body: { ok: false, code: 'WideWorldUnavailable' } } }), seasonId: 5 });
  const u = await dense.wideWorld();
  assert.equal(u.ok, false);
  assert.equal(u.code, 'WideWorldUnavailable', "the default build's own code, not HTTP503");
  assert.equal(u.httpStatus, 503);
  const f = fakeFetch({ '/h/world/wide': { status: 200, body: manifest() }, '/h/world/wide/page?limit=2': { status: 200, body: page(E.slice(0, 2), { next: CURSOR, limit: 2 }) }, [`/h/world/wide/page?limit=2&after=${CURSOR}`]: { status: 200, body: page(E.slice(2), { after: CURSOR, limit: 2 }) } });
  const h = createHerald({ base: 'http://h', fetch: f, seasonId: 5 });
  const m = await h.wideWorld({ pins: { seasonAddress: SEASON_ADDR, programId: PROGRAM } });
  assert.equal(m.ok, true);
  assert.equal(m.manifest.world, WORLD);
  const other = createHerald({ base: 'http://h', fetch: f, seasonId: 6 });
  assert.equal((await other.wideWorld()).code, 'WrongSeason');
  assert.equal((await h.wideWorld({ pins: { seasonAddress: toB58(new Uint8Array(32).fill(8)) } })).code, 'WrongSeason');
  const ac = new AbortController();
  const p1 = await h.wideWorldPage({ limit: 2, signal: ac.signal });
  assert.equal(p1.ok, true);
  assert.equal(f.seen.at(-1).url, 'http://h/h/world/wide/page?limit=2');
  assert.equal(f.seen.at(-1).signal, ac.signal, 'the caller\'s signal reaches fetch');
  const p2 = await h.wideWorldPage({ limit: 2, after: CURSOR });
  assert.equal(p2.ok, true);
  assert.equal(f.seen.at(-1).url, `http://h/h/world/wide/page?limit=2&after=${CURSOR}`);
  // the whole walk through the client
  const r = await loadWide(h, { walk: new WideWalk({ limit: 2 }), pins: { seasonAddress: SEASON_ADDR, programId: PROGRAM } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.walk.list().map(e => e.key), ['2,0', '1,1', '0,2', '3,0']);
  // an aborted request is Aborted, not a network error
  const slow = createHerald({ base: 'http://h', fetch: async (url, init) => { const e = new Error('aborted'); e.name = 'AbortError'; if (init?.signal?.aborted) throw e; return { ok: true, status: 200, json: async () => manifest() }; }, seasonId: 5 });
  const ac2 = new AbortController();
  ac2.abort();
  assert.equal((await slow.wideWorld({ signal: ac2.signal })).code, 'Aborted');
});

test('a reset during the manifest request cannot revive an older source', async () => {
  const walk = new WideWalk();
  let resolve;
  let pages = 0;
  const client = { wideWorld: () => new Promise(r => { resolve = r; }), wideWorldPage: async () => { pages++; return { ok: true, json: page(E) }; } };
  const pending = loadWide(client, { walk });
  walk.reset();
  resolve({ ok: true, manifest: parseWideManifest(manifest()) });
  const result = await pending;
  assert.equal(result.code, 'Aborted');
  assert.equal(pages, 0);
  assert.equal(walk.world, null);
});

test('screen pins require a loaded, labelled non-sample game source', () => {
  refused(() => sourcePins(null), 'NoSeasonYet');
  const record = { season: '5', seasonAddress: SEASON_ADDR, programId: PROGRAM, cluster: 'localnet' };
  const pins = sourcePins(record);
  assert.equal(pins.cluster, 'localnet');
  for (const cluster of ['fixture', ' FIXTURE ', 'sample', 'prototype', 'unknown', '', undefined]) {
    refused(() => sourcePins({ ...record, cluster }), 'SampleWorld');
  }
  assert.notEqual(pins.key, sourcePins({ ...record, season: '6' }).key);
  assert.notEqual(pins.key, sourcePins({ ...record, cluster: 'mainnet-beta' }).key);
  refused(() => sourcePins({ ...record, sample: { world: 'sample' } }), 'SampleWorld');
  refused(() => sourcePins({ ...record, proto: { claims: true } }), 'SampleWorld');
});

import { mountWideMode } from '../../permutation-server/web/frontier/map/widemode.mjs';

// Minimal DOM contract harness, not a browser or visual acceptance test.
class FakeElement {
  constructor(doc) { this.ownerDocument = doc; this.dataset = {}; this.children = []; this.events = {}; this.attrs = {}; this.clientWidth = 640; this.clientHeight = 400; }
  set innerHTML(text) { this.ids = new Map([...text.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new FakeElement(this.ownerDocument)])); }
  set textContent(t) { this.text = t; this.children = []; }
  get textContent() { return this.text ?? ''; }
  querySelector(s) { return this.ids?.get(s.replace(/^#/, '')) ?? null; }
  append(...nodes) { this.children.push(...nodes); for (const n of nodes) n.parentElement = this; }
  after(node) { this.parentElement?.append(node); }
  setAttribute(k,v) { this.attrs[k]=v; }
  addEventListener(k, f) { (this.events[k] ??= []).push(f); }
  fire(k,e={}) { for (const f of this.events[k] ?? []) f(e); }
  focus() {} remove() {} getContext() { return null; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function modeHarness(client, recordOf) {
  const doc = { createElement: () => new FakeElement(doc) };
  const parent = doc.createElement('div'), canvas = doc.createElement('canvas'); parent.append(canvas);
  return mountWideMode({ herald: client, canvas, doc, recordOf });
}
test('the real screen mount loads records, pages its list, and closes without sends', async () => {
  const rows = Array.from({length:50}, (_, i) => entry(i + 1, 0, i + 1, 0, 0));
  const client = { wideWorld: async () => ({ok:true, manifest:parseWideManifest(manifest({recorded:50}))}), wideWorldPage: async () => ({ok:true,json:page(rows)}) };
  const record = {season:'5',seasonAddress:SEASON_ADDR,programId:PROGRAM,cluster:'localnet'};
  const mode = modeHarness(client, () => record);
  try {
    mode.open(); await flush();
    assert.equal(mode.state().phase, 'ready');
    const sheet = mode.elements().sheet;
    assert.equal(sheet.querySelector('#wide-list').children.length, 48);
    sheet.querySelector('#wide-next').fire('click');
    assert.equal(sheet.querySelector('#wide-list').children.length, 2);
    assert.match(sheet.querySelector('#wide-status').textContent, /localnet/);
    mode.close(); assert.equal(mode.state().open, false);
  } finally { mode.unmount(); }
});
test('the screen refuses a source that changes during loading', async () => {
  let resolve;
  let record = {season:'5',seasonAddress:SEASON_ADDR,programId:PROGRAM,cluster:'localnet'};
  const mode = modeHarness({wideWorld:()=>new Promise(r=>{resolve=r;}),wideWorldPage:async()=>({ok:true,json:page(E)})},()=>record);
  try {
    mode.open(); record = {...record, season:'6'};
    resolve({ok:true,manifest:parseWideManifest(manifest())}); await flush();
    assert.equal(mode.state().phase,'error'); assert.equal(mode.state().code,'WorldChanged'); assert.equal(mode.state().walk,null);
  } finally { mode.unmount(); }
});

// Synthetic wire data only. These fixed bytes test the display contract,
// not ABI authentication, live captures, event verification or gameplay.
function capturedEntry(p = '9007199254740993') {
  const capture = n => ({address: SEASON_ADDR, slot: '9007199254740994', archiveSequence: '12',
    verification: 'captured-unverified', postState: 'at-or-after-transaction', bytes_b64: Buffer.alloc(n).toString('base64')});
  return entry(p, 0, p, 0, 0, {legacy: null, wide: {world:WORLD,p,q:'0',region:3,openedBell:5,keepHolder:4,
    capture:capture(4864), holdings:[{world:WORLD,p,q:'0',site:2,generation:1,inventorySlot:2,
      ownerCitizen:SEASON_ADDR,capture:capture(1344)}]}});
}
test('captured wide land retains exact keys, bounded holdings and explicit unverified timing', () => {
  const e = parseWidePage(page([capturedEntry()]), {world:WORLD}).entries[0];
  assert.equal(e.p, 9007199254740993n);
  assert.equal(e.legacy, null);
  assert.equal(e.wide.keepHolder, 4);
  assert.equal(e.wide.holdings[0].p, e.p);
  assert.equal(e.wide.capture.slot, 9007199254740994n);
  assert.equal(e.wide.capture.verification, 'captured-unverified');
  assert.equal(e.wide.capture.postState, 'at-or-after-transaction');
  for (const mutate of [
    x => { x.wide.world = OTHER_WORLD; },
    x => { x.wide.holdings[0].p = '129'; },
    x => { x.wide.capture.verification = 'verified'; },
    x => { x.wide.capture.bytes_b64 = 'AA=='; },
    x => { x.wide.holdings.push({...x.wide.holdings[0]}); },
    x => { x.wide.holdings[0].inventorySlot = 1; },
    x => { x.state = 'closed'; },
    x => { x.wide.keepHolder = 7; },
  ]) { const bad = capturedEntry(); mutate(bad); refused(() => parseWidePage(page([bad]), {world:WORLD}), 'BadWideCapture'); }
});
test('the screen shows captured wide land past the legacy cap without aliasing it', async () => {
  const client = {wideWorld:async()=>({ok:true,manifest:parseWideManifest(manifest({recorded:1}))}),
    wideWorldPage:async()=>({ok:true,json:page([capturedEntry()])})};
  const mode = modeHarness(client,()=>({season:'5',seasonAddress:SEASON_ADDR,programId:PROGRAM,cluster:'localnet'}));
  try {
    mode.open(); await flush();
    assert.equal(mode.state().phase,'ready');
    const row = mode.elements().sheet.querySelector('#wide-list').children[0].children[0];
    assert.match(row.textContent,/9007199254740993/);
    assert.match(row.textContent,/9007199254740994/);
    assert.doesNotMatch(row.textContent,/捕捉なし/);
    assert.equal(mode.state().walk.list()[0].wide.holdings.length,1);
    mode.close(); mode.open(); await flush();
    assert.equal(mode.state().walk.list().length,1);
  } finally { mode.unmount(); }
});
