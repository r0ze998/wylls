// The land chip's inputs at their edges (Lane C, 2026-11-16): landSummary / landElsewhere against what the parsers
// actually hand them. The contracts are read from the generated layouts and the codec (a Province always carries 12
// site mirrors; a Holding's site is a u8; decode refuses any other size), and from the program (a holding's site is
// mirrored as state 1 of its nation at founding and at taking). Then each edge the page can reach is checked for a
// wrong 0%, a NaN or a throw: an unloaded province, a loaded one with no land record, a true zero, BigInt production,
// and the shapes the contract rules out (handled without a throw, not given a meaning).
// Pure data: imports land.mjs, abi.mjs and abi-v2-layouts.mjs (generated tables, no imports of their own). fcodec.mjs,
// herald.mjs, controller.mjs and the program are read as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landSummary, landElsewhere, landYieldPerHour, renderLandChip } from '../../permutation-server/web/frontier/land.mjs';
import { ACCOUNTS, RECORDS } from '../../permutation-server/web/frontier/abi.mjs';
import { LAYOUTS as V2 } from '../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const F = 0;
const PROD = [40_000n, 30_000n, 20_000n, 15_000n, 0n, 15_000n, 5_000n, 0n];   // decoded i64: BigInt
const mirror = (...ours) => Array.from({ length: 12 }, (_, i) => ours.includes(i) ? { state: 1, faction: F } : { state: 0, faction: 0 });
const landRec = (claimed, totals = claimed) => ({ claimed: [claimed, 0, 0, 0, 0, 0], totals: [totals, 0, 0, 0, 0, 0] });
const H = { p: 2, q: 0, site: 1, production: PROD };
const noNaN = s => { for (const v of Object.values(s ?? {})) assert.ok(!(typeof v === 'number' && !Number.isFinite(v)), `finite: ${JSON.stringify(s, (_, x) => typeof x === 'bigint' ? String(x) : x)}`); };

test('the contract: 12 site mirrors (v1 and v2), the site a u8, exact sizes, state 1 written with the holding', () => {
  assert.deepEqual(ACCOUNTS.Province.fields.find(f => f[0] === 'SITE_MIRROR'), ['SITE_MIRROR', 296, 768, 'rec:SiteMirror x12']);
  assert.deepEqual(ACCOUNTS.Holding.fields.find(f => f[0] === 'SITE'), ['SITE', 68, 1, 'u8']);
  assert.deepEqual(RECORDS.SiteMirror.fields.slice(0, 2), [['STATE', 0, 1, 'u8'], ['FACTION', 1, 1, 'u8']]);
  const v2 = k => V2.accounts.find(a => a.kind === k);
  assert.equal(v2('Province').fields.find(f => f.name === 'SITE_MIRROR').ty, 'rec:SiteMirrorV2 x12');
  assert.deepEqual(v2('Holding').fields.find(f => f.name === 'SITE'), { name: 'SITE', off: 68, len: 1, ty: 'u8' });
  const codec = read('permutation-server/web/frontier/fcodec.mjs');
  assert.match(codec, /if \(b\.length !== layout\.size && !\(kind === 'Season' && b\.length === 128\)\) throw new CodecError\('WrongSize'/, 'decode: exact size');
  const herald = read('permutation-server/web/frontier/herald.mjs');
  assert.match(herald, /const holdings = j\.holdings\.map\(h => decode\('Holding', bytesOf\(h\.bytes_b64\), opts\)\);/, 'me: every holding decoded');
  assert.match(herald, /const province = decode\('Province', provinceBytes, \{ seasonId \}\);/, 'envelope: the Province decoded (a missing one throws)');
  // the page's holdings are only ever the decoded /h/me list
  const c = read('permutation-server/web/frontier/controller.mjs');
  assert.deepEqual((c.match(/FS\.holdings ?= ?[^;]+;/g) ?? []).map(s => s.replace(/\s/g, '')).sort(), ['FS.holdings=[];', 'FS.holdings=[];', 'FS.holdings=me.holdings;', 'FS.holdings=me.holdings;'].sort());
  // the program mirrors each holding it makes as state 1 of its nation (founding; taking)
  const citizen = read('permutation-frontier/src/proc/citizen.rs');
  assert.ok((citizen.match(/w\.set_u8\(o \+ SM::STATE, SM::STATE_HOLDING\)\?;\s*w\.set_u8\(o \+ SM::FACTION, faction\)\?;/g) ?? []).length >= 2);
  // and the rule's divisor counts exactly those
  assert.match(read('permutation-rules/src/frontier/land.rs'), /let villages = sites\.iter\(\)\.filter\(\|s\| s\.holding\.is_some_and\(\|\(g, _\)\| g == f\)\)\.count\(\) as u32;\s*if villages == 0 \{/);
});

test('unloaded province, loaded without land, and a true zero are three different answers', () => {
  const FS = { provinces: new Map() };
  assert.equal(landSummary(FS, H, F), null, 'not read yet: no line (never 0%)');
  FS.provinces.set('2,0', { province: { siteMirror: mirror(1) } });
  assert.equal(landSummary(FS, H, F), null, 'read, no land record (a world without the option): no line');
  FS.provinces.set('2,0', { province: { siteMirror: mirror(1) }, land: null });
  assert.equal(landSummary(FS, H, F), null, 'a record the herald refused: no line');
  FS.provinces.set('2,0', { province: { siteMirror: mirror(1) }, land: landRec(0, 1) });
  const zero = landSummary(FS, H, F);
  assert.deepEqual(zero, { claimed: 0, tiles: 1, bonusPct: 0, perHour: 0 }, 'a record with nothing claimed: a true 0%');
  assert.match(String(renderLandChip(zero)), /data-land-bonus="0"/);
  assert.doesNotMatch(String(renderLandChip(zero)), /毎時/, 'no per-hour figure at zero');
  // no FS / no provinces map at all
  assert.equal(landSummary(null, H, F), null);
  assert.equal(landSummary({}, H, F), null);
  assert.deepEqual(landElsewhere({}, H, F), { tiles: 0, provinces: 0 });
});

test('a decoded holding (BigInt production, u8 site) on a decoded province gives finite figures', () => {
  const FS = { provinces: new Map([['2,0', { province: { siteMirror: mirror(1, 5) }, land: landRec(7, 9) }]]) };
  const s = landSummary(FS, H, F);
  assert.deepEqual(s, { claimed: 7, tiles: 9, bonusPct: 7, perHour: landYieldPerHour(PROD, 700) });
  noNaN(s);
  assert.equal(landYieldPerHour(PROD, 700), 8, '(40+30+20+15+15+5) × 7% = 8.75 → 8');
  // the cap and the far count stay finite with many tiles
  FS.provinces.set('2,0', { province: { siteMirror: mirror(1) }, land: landRec(61) });
  FS.provinces.set('3,0', { province: { siteMirror: mirror() }, land: landRec(61) });
  noNaN(landSummary(FS, H, F));
  assert.equal(landSummary(FS, H, F).bonusPct, 30);
  assert.deepEqual(landElsewhere(FS, H, F), { tiles: 61, provinces: 1 });
});

test('shapes the contract rules out are passed over without a throw or a NaN (no meaning is given to them)', () => {
  const env = sm => ({ province: { siteMirror: sm }, land: landRec(4) });
  const at = sm => ({ provinces: new Map([['2,0', env(sm)]]) });
  // a short or missing mirror (not a decoded Province): the site check is skipped, the divisor counts what is there
  for (const sm of [undefined, null, [], [{ state: 1, faction: F }], [null, undefined]]) {
    assert.doesNotThrow(() => landSummary(at(sm), H, F));
    noNaN(landSummary(at(sm), H, F));
  }
  // a site a u8 never is, or one past the 12 mirrors: no throw, no NaN (only the answer's absence or presence varies)
  for (const site of [undefined, null, '1', 1.5, -1, 255]) assert.doesNotThrow(() => noNaN(landSummary(at(mirror(1)), { ...H, site }, F)));
  // a nation the record does not count (u8 past 5): no throw, no NaN
  assert.doesNotThrow(() => noNaN(landSummary(at(mirror(1)), H, 9)));
  assert.equal(landSummary(at(mirror(1)), H, undefined), null, 'no nation: no line');
  // production that is not integers: no per-hour figure, never NaN
  assert.equal(landSummary(at(mirror(1)), { ...H, production: [1.5, 'x'] }, F).perHour, null);
  assert.equal(landSummary(at(mirror(1)), { ...H, production: undefined }, F).perHour, null);
  assert.equal(landYieldPerHour(PROD, -1), null);
  assert.equal(landYieldPerHour(PROD, 1.5), null);
});
