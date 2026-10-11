// The MC herald formats on the web side (CONQUEST-CONTRACT v1.1 §8.4, unit
// CQ1-D): herald.mjs's decoders for PSFCT1 (the faction map), its WS
// delta, PSFOV2, PSFSD1 and the sieges and conquest-day JSON files, over
// the shared vectors the Rust codec writes (frontier-node/fixtures/cq/
// formats/, producer frontier-node/crates/herald/src/cqfmt.rs). Every valid
// vector decodes to the canonical form Rust recorded (so the two decoders,
// and the two copies of the March geometry, agree), the test-side encoder
// writes the same bytes back, and every invalid vector is refused with the
// code Rust refuses it with. The v1 decoders are untouched (additive).
//
// The test-side encoders (the inverse of the decoders) live in this file:
// a file under test/fixtures/frontier/ would break web-frontier-herald.
// test.mjs's fixture-set check, which lists that directory (CQ1-D-NOTES,
// dependency request D-2). CQ3-D may move them into fixtures/frontier/cq/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as H from '../../permutation-server/web/frontier/herald.mjs';

// ------------------------------------------------------------------ test-side encoders
const { CONTROL_MAGIC, CONTROL_HEADER, CONTROL_PROVINCE, CONTROL_MARCH, OVERVIEW2_MAGIC, OVERVIEW2_RECORD, STANDINGS_MAGIC, STANDINGS_HEADER, STANDINGS_FACTION, STANDINGS_FIELDS, KEEP_TILE_NONE, OVERVIEW_HEADER } = H;
const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));

/** One province record (decodeControl's shape) → 8 bytes. */
function controlRecord(r) {
  return Uint8Array.of(r.control, r.contender, r.progress, r.required, r.flags,
    (Math.min(r.sieges, 15) & 15) | (Math.min(r.occupations, 15) << 4), r.pointsLead, r.pointsShare);
}

/** decodeControl's shape → PSFCT1 bytes. */
function encodeControl({ season, bell, provinces, marches }) {
  const b = new Uint8Array(CONTROL_HEADER + provinces.length * CONTROL_PROVINCE + marches.length * CONTROL_MARCH);
  const dv = new DataView(b.buffer);
  b.set(ascii(CONTROL_MAGIC), 0);
  dv.setBigUint64(8, BigInt(season), true);
  dv.setUint32(16, bell, true);
  dv.setUint16(20, provinces.length, true);
  dv.setUint16(22, marches.length, true);
  provinces.forEach((r, i) => b.set(controlRecord(r), CONTROL_HEADER + i * CONTROL_PROVINCE));
  const base = CONTROL_HEADER + provinces.length * CONTROL_PROVINCE;
  marches.forEach((m, i) => b.set(Uint8Array.of(m.banner, m.pointsLead, m.keeps, m.flags), base + i * CONTROL_MARCH));
  return b;
}

/** decodeControlDelta's shape → the WS delta bytes. */
function encodeControlDelta(delta) {
  const b = new Uint8Array(delta.length * 10);
  delta.forEach((r, k) => { b[k * 10] = r.index & 0xff; b[k * 10 + 1] = r.index >> 8; b.set(controlRecord(r), k * 10 + 2); });
  return b;
}

const packBits = (vals, width, nBytes) => {
  let v = 0n;
  vals.forEach((x, i) => { v |= BigInt(x & ((1 << width) - 1)) << BigInt(width * i); });
  return Uint8Array.from({ length: nBytes }, (_, j) => Number((v >> BigInt(8 * j)) & 0xffn));
};

/** decodeOverviewV2's shape → PSFOV2 bytes (the v1 part is taken as is from `v1`). */
function encodeOverviewV2({ season, ring, bell, slot, provinces }) {
  const b = new Uint8Array(OVERVIEW_HEADER + provinces.length * OVERVIEW2_RECORD);
  const dv = new DataView(b.buffer);
  b.set(ascii(OVERVIEW2_MAGIC), 0);
  dv.setBigUint64(8, BigInt(season), true);
  dv.setUint16(16, ring, true);
  dv.setUint16(18, provinces.length, true);
  dv.setUint32(20, bell, true);
  dv.setBigUint64(24, BigInt(slot), true);
  provinces.forEach((r, i) => {
    const o = OVERVIEW_HEADER + i * OVERVIEW2_RECORD;
    b.set(r.v1, o);
    b.set(packBits(r.occupiers, 3, 5), o + 24);
    b.set(packBits(r.siegeStates, 2, 3), o + 29);
    b.set(packBits(r.siteKinds, 2, 3), o + 32);
    b[o + 35] = r.keepTile === null ? KEEP_TILE_NONE : r.keepTile;
    dv.setUint16(o + 36, Math.min(r.keepTroops, 0xffff), true);
    const imm = r.immune.reduce((a, x, s) => a | ((x ? 1 : 0) << s), 0);
    b[o + 38] = imm & 0xff;
    b[o + 39] = (imm >> 8) & 15;
  });
  return b;
}

/** decodeStandings's shape → PSFSD1 bytes. */
function encodeStandings({ season, firstHour, hours }) {
  const b = new Uint8Array(STANDINGS_HEADER + hours.length * 6 * STANDINGS_FACTION);
  const dv = new DataView(b.buffer);
  b.set(ascii(STANDINGS_MAGIC), 0);
  dv.setBigUint64(8, BigInt(season), true);
  dv.setUint32(16, firstHour, true);
  dv.setUint32(20, hours.length, true);
  hours.forEach((h, i) => h.factions.forEach((f, j) => {
    const o = STANDINGS_HEADER + (i * 6 + j) * STANDINGS_FACTION;
    for (const [k, off, w] of STANDINGS_FIELDS) {
      if (w === 2) dv.setUint16(o + off, f[k], true);
      else dv.setUint32(o + off, f[k], true);
    }
  }));
  return b;
}
const E = { encodeControl, encodeControlDelta, encodeOverviewV2, encodeStandings };

// ------------------------------------------------------------------ the shared vectors
const DIR = new URL('../../frontier-node/fixtures/cq/formats/', import.meta.url);
const file = name => new Uint8Array(readFileSync(new URL(name, DIR)));
const index = JSON.parse(readFileSync(new URL('vectors.json', DIR), 'utf8'));

const canon = {
  control: c => ({
    season: String(c.season),
    bell: c.bell,
    rings: c.rings,
    provinces: c.provinces.map(r => [r.index, r.p, r.q, r.control, r.contender, r.progress, r.required, r.flags, r.sieges, r.occupations, r.pointsLead, r.pointsShare]),
    marches: c.marches.map(m => [m.m, m.n, m.banner, m.pointsLead, m.keeps, m.flags]),
  }),
  controlDelta: d => d.map(r => [r.index, r.control, r.contender, r.progress, r.required, r.flags, r.sieges, r.occupations, r.pointsLead, r.pointsShare]),
  overview2: o => ({
    season: String(o.season),
    ring: o.ring,
    bell: o.bell,
    slot: String(o.slot),
    provinces: o.provinces.map(r => ({
      p: r.p, q: r.q, v1: Buffer.from(r.v1).toString('hex'), occupiers: r.occupiers, sieges: r.siegeStates,
      kinds: r.siteKinds, keepTile: r.keepTile, keepTroops: r.keepTroops, immune: r.immune,
    })),
  }),
  standings: s => ({
    season: String(s.season),
    firstHour: s.firstHour,
    hours: s.hours.map(h => h.factions.map(f => H.STANDINGS_FIELDS.map(([k]) => f[k]))),
  }),
};

const decoders = {
  control: b => H.decodeControl(b),
  controlDelta: b => H.decodeControlDelta(b),
  overview2: b => H.decodeOverviewV2(b),
  standings: b => H.decodeStandings(b),
  sieges: b => H.parseSieges(b),
  conquestDay: b => H.parseConquestDay(b),
};
const encoders = {
  control: E.encodeControl,
  controlDelta: E.encodeControlDelta,
  overview2: E.encodeOverviewV2,
  standings: E.encodeStandings,
};

test('the shared vectors are the Rust producer\'s, and every file is listed', () => {
  assert.equal(index.v, 1);
  const listed = new Set([...index.valid, ...index.invalid].map(v => v.file));
  const onDisk = readdirSync(DIR).filter(n => n !== 'vectors.json');
  assert.deepEqual([...listed].sort(), onDisk.sort());
  assert.ok(index.valid.length >= 10 && index.invalid.length >= 30, `${index.valid.length} valid, ${index.invalid.length} invalid`);
  for (const f of Object.keys(decoders)) assert.ok(index.valid.some(v => v.format === f), `a valid ${f} vector`);
});

test('valid binary vectors decode to the canonical form Rust recorded, and encode back byte for byte', () => {
  let n = 0;
  for (const v of index.valid.filter(x => canon[x.format])) {
    const bytes = file(v.file);
    const d = decoders[v.format](bytes);
    assert.deepEqual(canon[v.format](d), v.decoded, v.file);
    assert.deepEqual(encoders[v.format](d), bytes, `${v.file}: the test encoder writes Rust's bytes`);
    n++;
  }
  assert.ok(n >= 7);
});

test('valid JSON vectors parse; values survive the check unchanged', () => {
  for (const v of index.valid.filter(x => !canon[x.format])) {
    const text = readFileSync(new URL(v.file, DIR), 'utf8');
    const raw = JSON.parse(text);
    const d = decoders[v.format](text);
    assert.deepEqual(d, raw, v.file);
    // bytes and an already-parsed object give the same answer
    assert.deepEqual(decoders[v.format](file(v.file)), d);
    assert.deepEqual(decoders[v.format](raw), d);
  }
});

test('every invalid vector is refused with the code Rust refuses it with', () => {
  for (const v of index.invalid) {
    assert.throws(() => decoders[v.format](file(v.file)), e => {
      assert.ok(e instanceof H.HeraldError, `${v.file}: ${e}`);
      assert.equal(e.code, v.code, `${v.file}: ${e.message}`);
      return true;
    }, v.file);
  }
});

test('PSFCT1: the faction map reads by province and March; pins and flags', () => {
  const b = file('control-r4-b300.bin');
  const c = H.decodeControl(b, { seasonId: 7, bell: 300 });
  assert.equal(c.rings, 4);
  assert.equal(c.provinces.length, 61);
  assert.deepEqual([c.provinces[0].p, c.provinces[0].q, c.provinces[0].control, c.provinces[0].seat], [0, 0, H.CONTROL_NEUTRAL, true]);
  assert.ok(c.provinces.slice(1, 7).every(r => r.seat && r.control <= 5));
  assert.ok(c.provinces.slice(7).every(r => !r.seat));
  // rings 2–3 are every wedge's heartland under the default heartland_max_ring 3: never contested
  // (the sample leaves some provinces unopened: control 7)
  assert.ok(c.provinces.slice(7, 37).every(r => r.contender === H.CONTROL_NONE && (r.heartland || r.control === H.CONTROL_NONE)));
  assert.ok(c.provinces.slice(37).some(r => r.contender !== H.CONTROL_NONE && r.progress >= 1), 'a contested keep outside the heartlands');
  assert.equal(c.marches.length, H.marchOrder(4).length);
  assert.throws(() => H.decodeControl(b, { seasonId: 8 }), { code: 'WrongSeason' });
  assert.throws(() => H.decodeControl(b, { bell: 301 }), { code: 'WrongKey' });
  // the delta applies onto the file it was cut from
  const delta = H.decodeControlDelta(file('control-delta-r4.bin'));
  const next = H.applyControlDelta(c, delta, 301);
  assert.equal(next.bell, 301);
  assert.equal(c.bell, 300, 'the base file is not mutated');
  assert.deepEqual(delta.map(r => r.index), [7, 19, 20, 33, 60]);
  delta.forEach(r => assert.deepEqual(next.provinces[r.index], r));
  assert.throws(() => H.applyControlDelta(H.decodeControl(file('control-r0-b0.bin')), delta), { code: 'BadShape' });
});

test('marchOrder: every March with a member in the rings, by centre index, each once', () => {
  assert.deepEqual(H.marchOrder(0), [{ m: 0, n: 0 }]);
  for (let R = 0; R <= 10; R++) {
    const order = H.marchOrder(R);
    assert.equal(new Set(order.map(m => `${m.m},${m.n}`)).size, order.length);
    assert.strictEqual(H.marchOrder(R), order, 'cached');
  }
  assert.equal(H.ringsOf(1), 0);
  assert.equal(H.ringsOf(61), 4);
  assert.equal(H.ringsOf(60), null);
});

test('PSFOV2: the first 24 bytes are exactly the v1 record; v1 decoders unchanged', () => {
  const b = file('overview2-r4-b300.bin');
  const o = H.decodeOverviewV2(b, { seasonId: 7, ring: 4 });
  assert.equal(o.provinces.length, 24);
  for (const r of o.provinces) {
    assert.equal(r.v1.length, 24);
    assert.equal(r.occupiers.length, 12);
    assert.ok(r.keepTile !== null && r.keepTile < 61);
  }
  // a v1 file built from the v1 parts decodes with the unchanged v1 decoder to the same v1 fields
  const v1 = new Uint8Array(32 + 24 * o.provinces.length);
  v1.set(b.subarray(0, 32));
  v1.set(Uint8Array.from('PSFOV1\0\0', c => c.charCodeAt(0)));
  o.provinces.forEach((r, i) => v1.set(r.v1, 32 + i * 24));
  const back = H.decodeOverview(v1, { seasonId: 7, ring: 4 });
  back.provinces.forEach((r, i) => {
    const { p, q, owners, sites, hosts, clash, dormant, opened, resolvedNext } = o.provinces[i];
    assert.deepEqual(r, { p, q, owners, sites, hosts, clash, dormant, opened, resolvedNext });
  });
  const r1 = H.decodeOverviewV2(file('overview2-r1-b300.bin'));
  assert.ok(r1.provinces.every(r => r.keepTile === null && r.keepTroops === 0), 'rings 0–1 have no keep');
  assert.throws(() => H.decodeOverviewV2(b, { ring: 3 }), { code: 'WrongKey' });
});

test('PSFSD1: hours from first_hour, cumulative fields never go down', () => {
  const s = H.decodeStandings(file('standings-h48-n3.bin'), { seasonId: 7 });
  assert.deepEqual(s.hours.map(h => h.hour), [48, 49, 50]);
  assert.ok(s.hours.every(h => h.factions.length === 6));
  assert.deepEqual(H.decodeStandings(file('standings-empty.bin')).hours, []);
  assert.throws(() => H.decodeStandings(file('standings-h48-n3.bin'), { seasonId: 1 }), { code: 'WrongSeason' });
});

test('sieges and conquest JSON: statuses, Free City owner, every event kind and its shape', () => {
  const s = H.parseSieges(readFileSync(new URL('sieges-b400.json', DIR), 'utf8'));
  assert.deepEqual(s.sieges.map(x => [x.kind, x.status, x.pauseReason]), [['other', 'progressing', null], ['first', 'paused', 'vigil'], ['free', 'paused', 'defender']]);
  assert.equal(s.sieges[2].owner, null);
  assert.equal(s.sieges[2].ownerFaction, 6);
  assert.deepEqual(H.parseSieges('{"v":1,"bell":0,"sieges":[],"keeps":[]}'), { v: 1, bell: 0, sieges: [], keeps: [] });
  const d = H.parseConquestDay(readFileSync(new URL('conquest-d2.json', DIR), 'utf8'));
  assert.deepEqual(d.events.map(e => e.kind).sort(), Object.keys(H.CONQUEST_EVENT_SHAPE).sort());
  for (const e of d.events) {
    assert.ok(e.bell >= 288 && e.bell < 432);
    if (H.CONQUEST_EVENT_SHAPE[e.kind] === 'march') assert.ok(e.march && e.p === null);
    else assert.ok(e.p !== null && e.march === null);
  }
  // unknown fields are ignored (CF-7)
  const extra = JSON.parse(readFileSync(new URL('sieges-b400.json', DIR), 'utf8'));
  extra.sieges[0].future = 1;
  extra.note = 'x';
  assert.equal(H.parseSieges(extra).sieges.length, 3);
  assert.throws(() => H.parseSieges('[1]'), { code: 'BadSchema' });
});

test('round trip: random valid control files and deltas through the test encoder', () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  for (let k = 0; k < 20; k++) {
    const R = rnd(7);
    const base = H.decodeControl(file('control-r6-b1000.bin'));
    const provinces = base.provinces.slice(0, 1 + 3 * R * (R + 1)).map(r => ({ ...r, pointsShare: rnd(256), clash: false, flags: r.flags & ~64 }));
    const c = { season: BigInt(k), bell: k, provinces, marches: H.marchOrder(R).map(({ m, n }) => ({ m, n, banner: [0, 1, 2, 3, 4, 5, 7][rnd(7)], pointsLead: rnd(8), keeps: rnd(8), flags: rnd(8) })) };
    const bytes = E.encodeControl(c);
    const d = H.decodeControl(bytes);
    assert.deepEqual(E.encodeControl(d), bytes);
    assert.equal(d.rings, R);
    const changed = d.provinces.filter(() => rnd(4) === 0).slice(0, 64);
    if (changed.length) assert.deepEqual(H.decodeControlDelta(E.encodeControlDelta(changed)).map(r => r.index), changed.map(r => r.index));
  }
});
