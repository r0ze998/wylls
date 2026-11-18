// ⑦ the wide map says where its reads did not come (Lane C, 2026-11-17): the provider's read states → the page's map
// source → the map's own pass → select the province → its card's "read again". Land whose record is not there is not
// empty land. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs,
// controller.mjs, map/fmap.mjs, hud/inspect.mjs and the English dictionary are read as TEXT, not imported.
//   Expected, case by case:
//   K1 a province asked for and not read (failed), nothing held: one mark on it — "not loaded (select it to load again)"
//   K2 a province waiting for a free read place: one mark — "waiting to load"
//   K3 a read still under way, a record held, a province never asked for (out of sight, or simply not asked): no mark
//      — nothing flickers as the map moves, and no sight is widened
//   K4 a ring whose overview was asked for and did not come: one mark, only while the person looks at that ring (the
//      selected province, or the view's centre zoomed in), on that place; it goes when the overview is held; a ring
//      never asked for, refused by the herald (NoSuchRing), or not one of the world's open rings, is not marked
//   K5 another world's states: FS.provinceReads is emptied at a re-pin (controller), and the ring misses name their
//      world — not read for another
//   K6 the map draws words only, from the page's readMarks, with its existing tag painter; a tap selects as before
//   K7 the way back: the selected province's card says how its reads went and reads again (province-reread →
//      retryProvince + loadOverviews) within the 12 read places and the one waiting place
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const app = read('frontier/app.mjs'), ctl = read('frontier/controller.mjs'), fmap = read('frontier/map/fmap.mjs'), insp = read('frontier/hud/inspect.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');
const marks = fnOf(app, 'function readMarksNow() {'), lo = fnOf(app, 'function loadOverviews(herald, rings = overviewRings(FS.world, FS.overviewTaken)) {');

test('K1 K2 K3 province marks: not read or waiting, nothing held, nothing else', () => {
  order(marks, 'for (const [key, st] of FS.provinceReads ?? []) {', "if ((st.state !== 'failed' && st.state !== 'waiting') || FS.provinces.has(key)) continue;",
    "text: st.state === 'failed' ? L`読めていません（選ぶと読み直せます）` : L`読み込みの順番待ち` });");
  assert.doesNotMatch(code(marks), /wantProvince|retryProvince|herald|fetch\(/, 'the marks ask for nothing: only what was already asked is said');
});

test('K4 K5 ring marks: asked, did not come, this world', () => {
  // (fix-stale-tooltip 2026-11-19: which ring misses are said is map/overviews.mjs ringMissMarks — refused, unopened and
  //  held rings never, and only the ring looked at; run in web-frontier-ring-miss-marks.test.mjs)
  order(marks, 'for (const m of ringMissMarks(FS, { key: momentWorld(), looking: lookingAt() }))',
    "state: 'ring', ring: m.ring, text: L`この輪の村の一覧を読めていません（州を選ぶと読み直せます）` });");
  const look = fnOf(app, 'function lookingAt() {');
  order(look, 'FS.selected?.p', "if (view && mapRef?.lod && mapRef.lod !== 'world') {", 'hexAtPixel(view.x, view.y)', 'locate(h.q, h.r)');
  order(lo, 'const world = momentWorld(), asked = [...new Set(rings)];', 'const read = readOverviews(FS, { herald, rings, v2: conquestEnabled(FS.season), source: momentWorld,',
    'const note = () => {', 'if (momentWorld() !== world || !FS.world) return;', 'const rings0 = FS.overviewMisses?.world === world ? FS.overviewMisses.rings : new Map();',
    'if (seeded.includes(d) && !FS.overviews.has(d)) { if (!rings0.has(d)) rings0.set(d, ringProvinces(d)[0] ?? null); } else rings0.delete(d);',
    'if (FS.overviews.has(d) || !seeded.includes(d)) rings0.delete(d);', 'FS.overviewMisses = { world, rings: rings0 };', 'read.then(note, note);', 'return read;');
  const ad = fnOf(ctl, 'export function adoptPinnedWorld() {');
  assert.ok(ad.includes('FS.provinceReads?.clear?.();'), 'another world\'s province states are let go at a re-pin');
});

test('K6 the map: words only, from the page\'s list', () => {
  assert.ok(app.includes('readMarks: readMarksNow(),'));
  const tp = fmap.slice(fmap.indexOf('  topPass(ctx, F) {'), fmap.indexOf('  topPass(ctx, F) {') + 1200);
  order(tp, 'const { z, fx, still, src } = F;', 'for (const m of src.readMarks ?? []) {', 'if (!Number.isInteger(m?.p) || !Number.isInteger(m?.q) || !m.text) continue;',
    'const c = provincePixel(m.p, m.q);', "paintTag(ctx, c.x, c.y, m.text, { zoom: z, place: 'above', size: 11.5, anchor: c, spare: m.state !== 'failed' });");
  const loop = tp.slice(tp.indexOf('for (const m of src.readMarks'), tp.indexOf('paintTag(ctx, c.x, c.y, m.text') + 140);
  assert.doesNotMatch(loop, /paintProvince|paintTiles|provinceOf|overviews/, 'nothing of the land is drawn from a mark');
});

test('K7 the way back: select, read again, within the limits', () => {
  assert.ok(insp.includes('data-act="province-reread" data-p="${m.p}" data-q="${m.q}"'));
  const line = app.split('\n').find(l => l.includes("'province-reread': d =>"));
  for (const s of ['loadOverviews(heraldRef)', 'retryProvince(p, q,']) assert.ok(line.includes(s), s);
  assert.ok(ctl.includes("if (readsUnderWay.size >= WANT_IN_FLIGHT) { holdWant(p, q, onLoad); return 'waiting'; }"));
  assert.ok(ctl.includes('export const WANT_IN_FLIGHT = 12;'));
});

test('English follows; no banned word', () => {
  for (const k of ['読めていません（選ぶと読み直せます）', '読み込みの順番待ち', 'この輪の村の一覧を読めていません（州を選ぶと読み直せます）']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
