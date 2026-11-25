// The land chip and the province envelope stay with the ACTIVE village (Lane C, 2026-11-16): when the active village
// changes province, when a province's latest envelope no longer carries its land record, and when envelopes come back
// out of order, the chip's home figures (claimed tiles, tiles, bonus, per-hour) and its "other provinces" count are
// those of the active holding and the newest envelope — never a previous selection or an older read.
// Pure data only: imports land.mjs and lang.mjs; controller.mjs, app.mjs and herald.mjs are read as text (no wallet,
// session, resident, network, storage or process side effects are loaded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLand, landOf, landSummary, landElsewhere, landYieldPerHour, renderLandChip, LAND } from '../../permutation-server/web/frontier/land.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const b64 = b => Buffer.from(b).toString('base64');
const SEASON = 11;

/** A PSFLAND1 record as the program writes it, wrapped as the herald carries it (`{key, bytes}`). */
function landValue({ p, q, season = BigInt(SEASON), version = 1, owners = {}, village = [], key = `ld:${p},${q}` }) {
  const b = new Uint8Array(LAND.SIZE), dv = new DataView(b.buffer);
  b.set([...'PSFLAND1'].map(c => c.charCodeAt(0)), 0);
  dv.setBigUint64(LAND.SEASON_ID, season, true);
  dv.setUint16(LAND.VERSION, version, true);
  dv.setUint32(LAND.NEXT_BELL, 40, true);
  let m = 0n;
  for (const t of village) m |= 1n << BigInt(t);
  dv.setBigUint64(LAND.VILLAGE, m, true);
  dv.setInt16(LAND.P, p, true);
  dv.setInt16(LAND.Q, q, true);
  b.fill(255, LAND.OWNER, LAND.OWNER + LAND.TILES);
  b.fill(255, LAND.BY, LAND.BY + LAND.TILES);
  for (const [t, f] of Object.entries(owners)) b[LAND.OWNER + Number(t)] = f;
  return { key, bytes: b64(b) };
}
const land = (o) => parseLand(landValue(o), { p: o.p, q: o.q, seasonId: SEASON });
const tiles = (from, n, f) => Object.fromEntries(Array.from({ length: n }, (_, i) => [from + i, f]));
/** An envelope as loadEnvelope stores it: generation fields, the province (its site mirror), the parsed land. */
const env = (seq, province, l) => ({ seq: String(seq), slot: String(seq * 10), bell: seq, province, ...(l !== undefined ? { land: l } : {}) });
const sites = (n, f) => ({ siteMirror: Array.from({ length: n }, () => ({ state: 1, faction: f })) });

/** What app.mjs puts in the chip for the active holding (its line: landSummary of the holding, landElsewhere apart). */
const chipFor = (FS, h, f) => ({ home: landSummary(FS, h, f), far: landElsewhere(FS, h, f) });

const F = 0;
const PROD_A = [40_000, 30_000, 20_000, 15_000, 0, 15_000, 5_000, 0];
const PROD_B = [60_000, 45_000, 30_000, 22_500, 0, 22_500, 7_500, 0];
const A = { p: 2, q: 0, production: PROD_A };
const B = { p: 4, q: -2, production: PROD_B };

function world() {
  const FS = { provinces: new Map() };
  // A's province: one village of nation 0, 5 claimed tiles (+1 village tile) → 10%
  FS.provinces.set('2,0', env(5, sites(1, F), land({ p: 2, q: 0, owners: { ...tiles(0, 5, F), 30: F }, village: [30] })));
  // B's province: two villages of nation 0, 8 claimed tiles → 8 × 2% / 2 = 8%
  FS.provinces.set('4,-2', env(7, sites(2, F), land({ p: 4, q: -2, owners: { ...tiles(10, 8, F), 40: F, 41: F }, village: [40, 41] })));
  // a third province read by the map: 3 claimed tiles, no village of ours
  FS.provinces.set('3,1', env(2, sites(0, F), land({ p: 3, q: 1, owners: tiles(20, 3, F) })));
  return FS;
}

test('switching the active village swaps home and other-provinces figures; per-hour follows that village', () => {
  const FS = world();
  const a = chipFor(FS, A, F);
  assert.deepEqual(a.home, { claimed: 5, tiles: 6, bonusPct: 10, perHour: landYieldPerHour(PROD_A, 1000) });
  assert.deepEqual(a.far, { tiles: 8 + 3, provinces: 2 }, 'B\'s province and the third count as elsewhere');
  const b = chipFor(FS, B, F);
  assert.deepEqual(b.home, { claimed: 8, tiles: 10, bonusPct: 8, perHour: landYieldPerHour(PROD_B, 800) });
  assert.deepEqual(b.far, { tiles: 5 + 3, provinces: 2 }, 'A\'s province is elsewhere now, B\'s is not');
  // and back: nothing of B's selection lingers
  assert.deepEqual(chipFor(FS, A, F), a);
  // the rendered chip carries the active village's figures only
  const ha = String(renderLandChip(a.home, a.far)), hb = String(renderLandChip(b.home, b.far));
  assert.match(ha, /data-land-claimed="5"/); assert.match(ha, /data-land-far="11"/);
  assert.match(hb, /data-land-claimed="8"/); assert.match(hb, /data-land-far="8"/);
  assert.doesNotMatch(hb, /data-land-claimed="5"/);
  // same province, other village (same p,q): the home line is the province's, the per-hour is this village's production
  const A2 = { p: 2, q: 0, production: PROD_B };
  assert.equal(landSummary(FS, A2, F).perHour, landYieldPerHour(PROD_B, 1000));
  assert.equal(landSummary(FS, A2, F).claimed, 5);
});

test('a province whose latest envelope no longer carries its land record loses the line and the far count', () => {
  const FS = world();
  // home record gone (newer envelope with no `land`): no home line, far count unchanged
  FS.provinces.set('2,0', env(6, sites(1, F)));
  assert.equal(landOf(FS, 2, 0), null);
  assert.equal(landSummary(FS, A, F), null);
  assert.deepEqual(landElsewhere(FS, A, F), { tiles: 11, provinces: 2 });
  assert.match(String(renderLandChip(landSummary(FS, A, F), landElsewhere(FS, A, F))), /data-land-far="11"/);
  assert.doesNotMatch(String(renderLandChip(landSummary(FS, A, F), landElsewhere(FS, A, F))), /data-land-claimed/);
  // a record the herald could not accept for this province (parseEnvelope keeps `land: null`) shows nothing either
  FS.provinces.set('3,1', env(3, sites(0, F), null));
  assert.deepEqual(landElsewhere(FS, A, F), { tiles: 8, provinces: 1 }, 'the third province no longer counts');
  // everything gone: no chip
  FS.provinces.set('4,-2', env(8, sites(2, F)));
  assert.equal(String(renderLandChip(landSummary(FS, A, F), landElsewhere(FS, A, F))), '');
});

test('a record of another province, another season or not yet folded is never shown under the active one', () => {
  const ok = { p: 2, q: 0, owners: tiles(0, 5, F) };
  assert.ok(parseLand(landValue(ok), { p: 2, q: 0, seasonId: SEASON }));
  assert.equal(parseLand(landValue({ ...ok, key: 'ld:4,-2' }), { p: 2, q: 0, seasonId: SEASON }), null, 'key of another province');
  assert.equal(parseLand(landValue({ ...ok, p: 4, q: -2, key: 'ld:2,0' }), { p: 2, q: 0, seasonId: SEASON }), null, 'bytes of another province');
  assert.equal(parseLand(landValue({ ...ok, season: 12n }), { p: 2, q: 0, seasonId: SEASON }), null, 'another season');
  assert.equal(parseLand(landValue({ ...ok, version: 0 }), { p: 2, q: 0, seasonId: SEASON }), null, 'made, not folded');
  // herald.mjs parses the record against the ENVELOPE's own province and season
  assert.match(src('herald.mjs'), /\.\.\.\(env\.land \? \{ land: parseLand\(env\.land, \{ p: P, q: Q, seasonId \}\) \} : \{\}\)/);
});

/** controller.mjs's latestEnvelope, read as text and built in isolation (the module itself is not imported). */
function latestEnvelopeFromSource() {
  const c = src('controller.mjs');
  const m = /export function latestEnvelope\(previous, next\) \{\n([\s\S]*?)\n\}\n/.exec(c);
  assert.ok(m, 'controller.mjs still defines latestEnvelope');
  return new Function('previous', 'next', m[1]);
}

test('envelopes that come back out of order never roll the land or the chip back to an older read', () => {
  const latest = latestEnvelopeFromSource();
  const c = src('controller.mjs');
  // loadEnvelope stores the newer of what it held and what came, for 'latest' reads only
  assert.match(c, /if \(bell !== 'latest'\) return r;\n\s*const key=`\$\{p\},\$\{q\}`, accepted=latestEnvelope\(FS\.provinces\.get\(key\),r\);\n\s*FS\.provinces\.set\(key,accepted\);/);
  const FS = world();
  const store = (key, next) => FS.provinces.set(key, latest(FS.provinces.get(key), next));
  // newer record for A's province arrives (7 claimed), then a slower older read (still 5) lands after it
  const newer = env(9, sites(1, F), land({ p: 2, q: 0, owners: tiles(0, 7, F) }));
  const older = env(6, sites(1, F), land({ p: 2, q: 0, owners: tiles(0, 5, F) }));
  store('2,0', newer); store('2,0', older);
  assert.equal(landSummary(FS, A, F).claimed, 7, 'the older read is dropped');
  // an older read that had a record does not bring a lost record back
  store('2,0', env(10, sites(1, F)));
  store('2,0', older);
  assert.equal(landSummary(FS, A, F), null, 'the record stays lost');
  // the far count follows the same rule
  store('4,-2', env(9, sites(2, F), land({ p: 4, q: -2, owners: tiles(10, 2, F) })));
  store('4,-2', env(7, sites(2, F), land({ p: 4, q: -2, owners: tiles(10, 8, F) })));
  assert.deepEqual(landElsewhere(FS, A, F), { tiles: 2 + 3, provinces: 2 });
  // seq compared as integers, not text ("10" after "9")
  assert.equal(latest({ seq: '10' }, { seq: '9' }).seq, '10');
  assert.equal(latest({ seq: '9' }, { seq: '10' }).seq, '10');
});

test('the page computes the chip from the active holding on every render (no remembered selection)', () => {
  const a = src('app.mjs');
  assert.match(a, /const lh = FS\.mode === 'play' \? hud\.activeHolding\(FS\) : null, lf = FS\.citizen\?\.faction;/);
  assert.match(a, /const ls = lh \? landSummary\(FS, settledHolding\(lh, now \?\? 0\), lf\) : null, le = lh \? landElsewhere\(FS, lh, lf\) : null;/);
  assert.match(a, /if \(chip\) \{ chip\.hidden = !landShown; setHtmlIfChanged\(chip, renderLandChip\(ls, le\)\); \}/);
  // land.mjs keeps no state of its own: no module-level let/Map/Set a previous call could leave behind
  assert.doesNotMatch(src('land.mjs'), /^(let|var) |^const \w+ = new (Map|Set)/m);
});

test('English chip for the active village: British spelling, none of the banned words', () => {
  const FS = world();
  setLang('en');
  try {
    for (const h of [A, B]) {
      const t = String(renderLandChip(landSummary(FS, h, F), landElsewhere(FS, h, F)));
      assert.match(t, /Fields in this province: \d+ tiles · production \+\d+%/);
      assert.doesNotMatch(t, /[぀-ヿ一-鿿]/);
      assert.doesNotMatch(t, /\bsettle|keeper|beacon|\bseed\b/i);
      assert.doesNotMatch(t, /\b(color|center|harbor|defense|neighbor)\b/i);
    }
  } finally { setLang('ja'); }
});
