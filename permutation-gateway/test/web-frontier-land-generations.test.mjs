// G1 (Lane C, 2026-11-16): the land chip pairs the viewer's holdings (from /h/me) with the province envelope. In
// refresh(), applyMeResult adopts the new holdings BEFORE loadEnvelope reads their provinces (awaited, one by one), and
// the chip is drawn on a timer (renderChip every second) independently of refresh(). So the code can draw the chip
// with holdings of the newer read against the envelope of the older one. If a village has just been founded in a
// province, the older envelope's site mirror does not list it, and the bonus divisor (the nation's villages there,
// permutation-rules land.rs bonus_bps) is short. landSummary now gives no line while the envelope's site does not show
// the active village as its nation's.
// The ordering is pinned as text. The timing was not observed (no world, no browser): the test shows what the
// page would draw IF a render falls in that window.
// Pure data: imports land.mjs and lang.mjs only. controller.mjs, app.mjs and the rules are read as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landSummary, landElsewhere, landYieldPerHour, renderLandChip } from '../../permutation-server/web/frontier/land.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const F = 0;
const PROD = [40_000, 30_000, 20_000, 15_000, 0, 15_000, 5_000, 0];
const mirror = (...sites) => Array.from({ length: 12 }, (_, i) => sites.includes(i) ? { state: 1, faction: F, gen: 0 } : { state: 0, faction: 0, gen: 0 });
const landRec = claimed => ({ claimed: [claimed, 0, 0, 0, 0, 0], totals: [claimed + 2, 0, 0, 0, 0, 0] });
const envAt = (seq, sites, claimed) => ({ seq: String(seq), slot: String(seq), bell: seq, province: { p: 2, q: 0, siteMirror: mirror(...sites) }, land: landRec(claimed) });
const old = { p: 2, q: 0, site: 1, gen: 0, production: PROD };   // the village held before
const fresh = { p: 2, q: 0, site: 4, gen: 0, production: PROD }; // the village just founded in the same province

test('the order in the page: holdings adopted, then envelopes awaited; the chip is drawn on its own timer', () => {
  const c = read('permutation-server/web/frontier/controller.mjs'), a = read('permutation-server/web/frontier/app.mjs');
  assert.match(c, /if \(applyMeResult\(me\) === 'error'\) return;\n\s*const h = activeHolding\(FS\);\n\s*\/\/[^\n]*\n\s*for \(const o of \[h, \.\.\.\(FS\.holdings \?\? \[\]\)\.filter\(x => x !== h\)\]\) if \(o\) \{ await loadEnvelope\(o\.p, o\.q\);/, 'refresh(): envelopes after the holdings, awaited');
  assert.match(c, /FS\.holdings = me\.holdings;/, 'applyMeResult adopts the holdings at once');
  assert.match(a, /if \(\+\+chipTick % 4 === 0\) \{ invalidate\('chip'\); return; \}/, 'the chip is invalidated every second (250 ms × 4)');
  assert.match(a, /\['chip', renderChip\]/);
  assert.match(a, /function renderChip\(\) \{[\s\S]{0,200}renderHudTick\(now\);/, 'renderChip draws the HUD strip (and the land chip)');
  // the rule's divisor: the nation's villages in the province's sites
  assert.match(read('permutation-rules/src/frontier/land.rs'), /let villages = sites\.iter\(\)\.filter\(\|s\| s\.holding\.is_some_and\(\|\(g, _\)\| g == f\)\)\.count\(\) as u32;/);
});

test('a village just founded, drawn against the envelope read before it: no line (it was double the bonus)', () => {
  const FS = { provinces: new Map([['2,0', envAt(5, [1], 5)]]) };   // envelope: one village of ours (site 1), 5 claimed
  // before the fix this pairing gave 5 × 200 / 1 = 10%; the program, with both villages, pays 5 × 200 / 2 = 5%
  assert.equal(landSummary(FS, fresh, F), null, 'the new village: the envelope does not list it yet');
  // the village it already had: same envelope; its own site is listed, so the line is drawn (the old divisor)
  assert.deepEqual(landSummary(FS, old, F), { claimed: 5, tiles: 7, bonusPct: 10, perHour: landYieldPerHour(PROD, 1000) });
  // the newer envelope (both villages) arrives: the line comes back with the program's divisor
  FS.provinces.set('2,0', envAt(6, [1, 4], 5));
  assert.deepEqual(landSummary(FS, fresh, F), { claimed: 5, tiles: 7, bonusPct: 5, perHour: landYieldPerHour(PROD, 500) });
  assert.deepEqual(landSummary(FS, old, F), landSummary(FS, fresh, F), 'both villages: one line for the province');
  // the chip: during the gap only the "other provinces" part (if any) is drawn, never a home figure
  assert.equal(String(renderLandChip(null, landElsewhere({ provinces: new Map([['2,0', envAt(5, [1], 5)]]) }, fresh, F))), '');
});

test('the site taken by another nation in the envelope: no home line for this holding', () => {
  const FS = { provinces: new Map([['2,0', { ...envAt(5, [1], 5), province: { p: 2, q: 0, siteMirror: mirror(1).map((s, i) => i === 4 ? { state: 1, faction: 3, gen: 1 } : s) } }]]) };
  assert.equal(landSummary(FS, fresh, F), null);
});

test('unchanged where nothing says another read: no site on the holding, or a site past the mirror', () => {
  const FS = { provinces: new Map([['2,0', envAt(5, [1], 5)]]) };
  assert.equal(landSummary(FS, { p: 2, q: 0, production: PROD }, F).bonusPct, 10, 'no site: as before');
  assert.equal(landSummary(FS, { p: 2, q: 0, site: 40, production: PROD }, F).bonusPct, 10, 'a site the mirror does not have: as before');
  const bare = { provinces: new Map([['2,0', { land: landRec(5) }]]) };
  assert.equal(landSummary(bare, fresh, F).bonusPct, 0, 'no mirror: as before (no village counted, no bonus)');
});
