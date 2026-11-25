// The land preview's record on the page (TEST-ONLY worlds with `--world-option land-preview-v1`): the herald's `land`
// in a province envelope is read byte for byte (frontier-abi/src/land_preview.rs, 272 bytes), drives the per-tile
// nation fill and the viewer's gold outline, and a world without the option changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLand, landOf, landTotals, landSummary, landElsewhere, landYieldPerHour, renderLandChip, LAND } from '../../permutation-server/web/frontier/land.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { recordLands } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { SpriteArt } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { openSurvey } from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import * as LL from '../src/frontier/local-play-launcher.mjs';
const { runnerLandAgrees, LAND_PREVIEW_OPTION } = LL;

/** A land record as the program writes it: `owners` {tile: nation}, `village` [tiles]. */
function record({ p = 2, q = 0, season = 11n, version = 1, next = 40, owners = {}, village = [] } = {}) {
  const b = new Uint8Array(LAND.SIZE), dv = new DataView(b.buffer);
  b.set([...'PSFLAND1'].map(c => c.charCodeAt(0)), 0);
  dv.setBigUint64(LAND.SEASON_ID, season, true);
  dv.setUint16(LAND.VERSION, version, true);
  dv.setUint32(LAND.NEXT_BELL, next, true);
  let m = 0n;
  for (const t of village) m |= 1n << BigInt(t);
  dv.setBigUint64(LAND.VILLAGE, m, true);
  dv.setInt16(LAND.P, p, true);
  dv.setInt16(LAND.Q, q, true);
  b.fill(255, LAND.OWNER, LAND.OWNER + 61);
  for (const [t, f] of Object.entries(owners)) b[LAND.OWNER + Number(t)] = f;
  return { key: `ld:${p},${q}`, slot: 7, bytes: toBase64(b) };
}

test('parseLand reads the program record and refuses another province, season, size or a blank record', () => {
  const r = parseLand(record({ owners: { 30: 0, 31: 0, 29: 0, 40: 3 }, village: [30] }), { p: 2, q: 0, seasonId: 11 });
  assert.equal(r.nextBell, 40);
  assert.equal(r.owners[30], 0); assert.equal(r.owners[40], 3); assert.equal(r.owners[0], 255);
  assert.deepEqual([...r.village], [30]);
  assert.equal(r.totals[0], 3); assert.equal(r.claimed[0], 2, 'village land is not claimed land'); assert.equal(r.totals[3], 1);
  assert.equal(parseLand(record(), { p: 2, q: 1, seasonId: 11 }), null, 'another province');
  assert.equal(parseLand(record({ season: 12n }), { p: 2, q: 0, seasonId: 11 }), null, 'another season');
  assert.equal(parseLand(record({ version: 0 }), { p: 2, q: 0, seasonId: 11 }), null, 'made but not folded: no land yet');
  assert.equal(parseLand({ key: 'ld:2,0', bytes: toBase64(new Uint8Array(256)) }, { p: 2, q: 0 }), null, 'size');
  assert.equal(parseLand(null, { p: 2, q: 0 }), null);
  const bad = record({ owners: { 3: 9 } });
  assert.equal(parseLand(bad, { p: 2, q: 0, seasonId: 11 }), null, 'a nation above 5');
});

test('the viewer\'s gold land follows the record as it grows, and totals count only provinces read', () => {
  const v = { p: 2, q: 0, tile: 30, tier: 0, state: 2 };
  const FS = { provinces: new Map() };
  const src = { landOf: (p, q) => landOf(FS, p, q) };
  const survey = { faction: 0 };
  assert.equal(recordLands(src, survey, [v]), null, 'no record: the old geometry stays');
  const grow = tiles => FS.provinces.set('2,0', { land: parseLand(record({ owners: Object.fromEntries(tiles.map(t => [t, 0])), village: [30] }), { p: 2, q: 0, seasonId: 11 }) });
  grow([30, 31]);
  const a = recordLands(src, survey, [v]);
  assert.equal(a.length, 1); assert.equal(a[0].tiles.length, 2);
  grow([30, 31, 32, 33, 34]);
  const b = recordLands(src, survey, [v]);
  assert.equal(b[0].tiles.length, 5, 'more land, a larger outline');
  assert.ok(b[0].shape, 'an outline shape');
  // a neighbouring province's land of the viewer is drawn too (land grown across the border)
  FS.provinces.set('3,0', { land: parseLand(record({ p: 3, q: 0, owners: { 5: 0, 6: 0 } }), { p: 3, q: 0, seasonId: 11 }) });
  assert.equal(recordLands(src, survey, [v])[0].tiles.length, 7);
  assert.deepEqual(landTotals(FS, 0), { tiles: 7, claimed: 6 });
  // another nation's tiles are not the viewer's
  assert.equal(recordLands(src, { faction: 2 }, [v]).length, 0);
});

test('the near map paints each tile in its holder\'s colour from the record', () => {
  const terrain = { terrain: Array(61).fill(0), names: ['Grassland'], sites: [30] };
  const province = { p: 2, q: 0, sites: [30], entries: [], siteMirror: [{ state: 1, faction: 0, tier: 0, garrison: 0, shieldUntilBell: 0 }], relations: 0n };
  const land = parseLand(record({ owners: { 30: 0, 31: 0, 40: 3 }, village: [30] }), { p: 2, q: 0, seasonId: 11 });
  const e = { p: 2, q: 0, ...terrain, rec: { p: 2, q: 0, owners: [0], sites: [1], control: 5 }, prov: province, fog: 'sight', territoryMode: true, territory: land };
  const m = new SpriteArt().model([e], { ringsOpen: 3, survey: openSurvey(3) });
  assert.equal(m.byId.get('2,0,31').wash.f, 0);
  assert.equal(m.byId.get('2,0,40').wash.f, 3, 'another nation\'s land in its colour');
  assert.equal(m.byId.get('2,0,0').wash, null, 'open ground has no colour');
  assert.ok(tileHex(2, 0, 40));
});

test('the launcher believes the runner\'s land statement only with the option, with the rule\'s own numbers', () => {
  assert.equal(LAND_PREVIEW_OPTION, 'land-preview-v1');
  assert.equal(runnerLandAgrees({}, false), true);
  assert.equal(runnerLandAgrees({ land_preview: { mode: 'land-preview-v1' } }, false), false, 'an unasked statement');
  assert.equal(runnerLandAgrees({}, true), false, 'asked but not stated');
  const ok = { mode: 'land-preview-v1', test_only: true, stand_bells: 6, seize_bells: 72, fray_bells: 36 };
  assert.equal(runnerLandAgrees({ land_preview: ok }, true), true);
  assert.equal(runnerLandAgrees({ land_preview: { ...ok, seize_bells: 4 } }, true), false, 'shortened numbers are refused');
});

test('the territory line counts only this village\'s province and states the bonus the program pays, in English', () => {
  const FS = { provinces: new Map() };
  const h = { p: 2, q: 0 };
  assert.equal(landSummary(FS, h, 0), null, 'no record: no line');
  assert.equal(renderLandChip(null), '');
  const province = { siteMirror: [{ state: 1, faction: 0 }, { state: 0, faction: 0 }] };
  FS.provinces.set('2,0', { province, land: parseLand(record({ owners: { 30: 0, 31: 0, 32: 0, 33: 0, 20: 4 }, village: [30] }), { p: 2, q: 0, seasonId: 11 }) });
  const s = landSummary(FS, h, 0);
  assert.deepEqual(s, { claimed: 3, tiles: 4, bonusPct: 6, perHour: null }, '3 claimed tiles × 2% for one village (no production known: no figure)');
  // reading another province (the camera moved) changes nothing in the line
  FS.provinces.set('3,0', { land: parseLand(record({ p: 3, q: 0, owners: { 5: 0, 6: 0, 7: 0 } }), { p: 3, q: 0, seasonId: 11 }) });
  assert.deepEqual(landSummary(FS, h, 0), s, 'independent of the provinces read');
  // the cap: 30%
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, 0]));
  FS.provinces.set('2,0', { province, land: parseLand(record({ owners: many, village: [30] }), { p: 2, q: 0, seasonId: 11 }) });
  assert.equal(landSummary(FS, h, 0).bonusPct, 30);
  setLang('en');
  try {
    const t = String(renderLandChip({ claimed: 3, tiles: 4, bonusPct: 6 }));
    assert.match(t, /Fields in this province: 3 tiles · production \+6%/);
    assert.match(String(renderLandChip({ claimed: 1, tiles: 8, bonusPct: 0.16 })), /Fields in this province: 1 tile · production \+0\.16%/);
    assert.doesNotMatch(t, /[\u3040-\u30ff\u4e00-\u9fff]/, 'no Japanese in the English line');
    assert.doesNotMatch(t, /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i);
  } finally { setLang('ja'); }
});

test('land claimed in other provinces the map has loaded is said apart, and the chip shows it even without home land', () => {
  const FS = { provinces: new Map() };
  const h = { p: 2, q: 0 };
  assert.deepEqual(landElsewhere(FS, h, 0), { tiles: 0, provinces: 0 });
  assert.deepEqual(landElsewhere(FS, null, 0), { tiles: 0, provinces: 0 });
  // a take two provinces out (land4/land5: (4,-2)); the home province has no land record
  FS.provinces.set('4,-2', { land: parseLand(record({ p: 4, q: -2, owners: { 10: 0, 16: 0, 17: 0, 24: 1 }, village: [] }), { p: 4, q: -2, seasonId: 11 }) });
  assert.equal(landSummary(FS, h, 0), null, 'home line: still none');
  const far = landElsewhere(FS, h, 0);
  assert.deepEqual(far, { tiles: 3, provinces: 1 }, 'the nation\'s claimed tiles out there');
  assert.deepEqual(landElsewhere(FS, h, 1), { tiles: 1, provinces: 1 }, 'the other nation counts its own');
  const ja = String(renderLandChip(null, far));
  assert.match(ja, /ほかの州 3 マス/);
  assert.match(ja, /data-land-far="3"/);
  assert.match(ja, /title="地図で読み込んだほかの州だけを数えます（テスト用の世界）。地図を動かすと変わることがあります。"/);
  assert.doesNotMatch(ja, /この州の耕地/, 'no home line without a home record');
  assert.equal(renderLandChip(null, { tiles: 0, provinces: 0 }), '', 'nothing anywhere: no chip');
  // village land out there is not "claimed"; the home province never counts as elsewhere
  const province = { siteMirror: [{ state: 1, faction: 0 }] };
  FS.provinces.set('2,0', { province, land: parseLand(record({ owners: { 30: 0, 31: 0 }, village: [30] }), { p: 2, q: 0, seasonId: 11 }) });
  assert.deepEqual(landElsewhere(FS, h, 0), far, 'home is not elsewhere');
  const both = String(renderLandChip(landSummary(FS, h, 0), far));
  assert.ok(both.indexOf('この州の耕地') >= 0 && both.indexOf('この州の耕地') < both.indexOf('ほかの州'), 'home line first, then the far part');
  setLang('en');
  try {
    const en = String(renderLandChip(landSummary(FS, h, 0), far));
    assert.match(en, /Fields in this province: 1 tile · production \+2%/);
    assert.match(en, /Other provinces: 3 tiles/);
    // eb6cebe9 reworded the tooltip to say what the chip counts (only the provinces the map has loaded)
    assert.match(en, /title="Counts only the other provinces the map has loaded \(test world\)\. It can change as you move the map\."/);
    assert.match(String(renderLandChip(null, { tiles: 1, provinces: 1 })), /Other provinces: 1 tile\b/);
    assert.doesNotMatch(en, /[\u3040-\u30ff\u4e00-\u9fff]/);
    assert.doesNotMatch(en, /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i);
  } finally { setLang('ja'); }
});

test('the chip says what the land bonus pays in an hour, by the program\'s own yield_for', () => {
  // the Rust formula, read as text: each entry × bonus_bps × bells / (10 000 × 6), rounded down
  const rust = readFileSync(new URL('../../frontier-abi/src/land_preview.rs', import.meta.url), 'utf8');
  assert.match(rust, /\(v\.max\(0\) as i128 \* bonus_bps as i128 \* bells as i128 \/ \(10_000 \* BELLS_PER_HOUR as i128\)\)\s+as i64/);
  assert.match(rust, /pub const BELLS_PER_HOUR: i64 = 6;/);
  const yieldFor = (prod, bps, bells) => prod.map(v => (BigInt(Math.max(0, v)) * BigInt(bps) * BigInt(bells)) / (10_000n * 6n));
  const town = [60_000, 45_000, 30_000, 22_000, 22_000, 7_000, 0, 0];   // milli per hour (a Town, M1)
  for (const bps of [0, 200, 600, 1_333, 3_000]) {
    const want = Number(yieldFor(town, bps, 6).reduce((a, b) => a + b, 0n) / 1000n);
    assert.equal(landYieldPerHour(town, bps), want, `bps ${bps}`);
    assert.equal(landYieldPerHour(town.map(BigInt), bps), want, 'BigInt production too');
  }
  assert.equal(landYieldPerHour(town, 600), 11, '186 an hour × 6% = 11.16 → 11');
  assert.equal(landYieldPerHour(null, 600), null);
  assert.equal(landYieldPerHour([], 600), null);
  assert.equal(landYieldPerHour([-5_000, 10_000], 3_000), 3, 'negative entries pay nothing (v.max(0))');
  // in the chip, after the percentage; nothing when the figure is 0 or unknown
  const FS = { provinces: new Map() };
  const province = { siteMirror: [{ state: 1, faction: 0 }] };
  FS.provinces.set('2,0', { province, land: parseLand(record({ owners: { 30: 0, 31: 0, 32: 0, 33: 0 }, village: [30] }), { p: 2, q: 0, seasonId: 11 }) });
  const s = landSummary(FS, { p: 2, q: 0, production: town }, 0);
  assert.deepEqual(s, { claimed: 3, tiles: 4, bonusPct: 6, perHour: 11 });
  assert.match(String(renderLandChip(s)), /この州の耕地 3 マス · 生産 \+6%（毎時 \+11）/);
  assert.doesNotMatch(String(renderLandChip({ ...s, perHour: 0 })), /毎時/);
  assert.doesNotMatch(String(renderLandChip({ ...s, perHour: null })), /毎時/);
  setLang('en');
  try {
    const en = String(renderLandChip(s));
    assert.match(en, /Fields in this province: 3 tiles · production \+6% \(\+11\/h\)/);
    assert.doesNotMatch(en, /[\u3040-\u30ff\u4e00-\u9fff]/);
  } finally { setLang('ja'); }
});

// The launcher's word for the land preview, alone and with the TEST-ONLY contest pair (two ordinary wallets in one
// memory-only world): a static check of the option words only — no key is made and no process is started.
const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
const trial = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1', '--march-trial', LL.MARCH_TRIAL_MODE];
const demo = ['--capture-demo', LL.CAPTURE_DEMO_MODE, '--demo-scale', '10'];
const land = ['--world-option', LAND_PREVIEW_OPTION];
const pair = ['--contest-pair', LL.CONTEST_PAIR_MODE];
const wordCodes = ['InvalidWorldOption', 'WorldOptionNeedsCaptureDemo', 'InvalidContestPair', 'InvalidCaptureDemo', 'CaptureDemoNeedsNaturalTrial', 'InvalidArguments'];
const refusedAs = async (args, code) => assert.rejects(LL.parseConfig(args), e => e.code === code, code);
// (well-formed words fail only later, at the paths, which do not exist here)
const wordsAccepted = async args => assert.rejects(LL.parseConfig(args), e => !wordCodes.includes(e.code), JSON.stringify(args.slice(-6)));

test('the launcher takes --world-option land-preview-v1 only with the capture demo, alone or with the contest pair', async () => {
  await refusedAs([...trial, ...land], 'WorldOptionNeedsCaptureDemo');
  await refusedAs([...trial, ...demo, '--world-option', 'land-preview-v2'], 'InvalidWorldOption');
  await wordsAccepted([...trial, ...demo, ...land]);
  await wordsAccepted([...trial, ...demo, ...land, ...pair]);
  await wordsAccepted([...trial, ...demo, ...pair, ...land]);
  // startWorld refuses the land option without the demo before anything starts
  await assert.rejects(LL.startWorld({ worldPreset: 'local-natural-v1', naturalRunner: '/x/natural', economy: 'page-signed-v1', marchTrial: true, landPreview: true }, 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', 0, () => {}), e => e.code === 'InvalidWorldPreset');
});
