// ⑦ the chronicle's report: read, shown and kept only under the pinned world it was read for (Lane C, 2026-11-17).
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs is read as TEXT, not
// imported (it is page-bound and loads fi18n.mjs and lang.mjs, the subjects of refused tests). A text check: it pins the
// guards and their places; it does not run the page.
//   R1 the world comes from setPin's checked season account; null before a pin (nothing made up)
//   R2 openReport keeps the world it started under; a clash answer read under another world is dropped, not shown
//   R3 the keep added to a report needs the same world
//   R4 loadSeason closes a report of another pinned world (and only the report's own what-if)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');

test('R1 the pinned world, never made up', () => {
  assert.ok(app.includes("const reportWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);"));
  assert.doesNotMatch(app, /FS\.pin\.seasonAddress/, 'setPin has no seasonAddress field');
});

test('R2 a report answer of another world is dropped', () => {
  const body = app.slice(app.indexOf('export async function openReport('), app.indexOf('async function verifyReport('));
  const start = body.indexOf('const world = reportWorld();');
  const ask = body.indexOf('const r = await heraldRef.clash(p, q, bell);');
  const same = body.indexOf('if (FS.report !== rep) return;');
  const drop = body.indexOf("if (reportWorld() !== world) { FS.report = null; invalidate('panel'); return; }");
  const set = body.indexOf('FS.report = r.ok ? { p, q, bell, world, clash: r } : { p, q, bell, world, error: r.code ?? \'Error\' };');
  assert.ok(start > 0 && ask > start && same > ask && drop > same && set > drop, 'world at start, ask, then both checks, then shown');
});

test('R3 the keep needs the same world', () => {
  assert.ok(app.includes("if (k?.ok && FS.report === open && reportWorld() === world) { open.keep = k.keep; invalidate('panel'); }"));
});

test('R4 a report of another pinned world is closed when the season is read', () => {
  const body = app.slice(app.indexOf('async function loadSeason(herald) {'), app.indexOf('async function loadSeason(herald) {') + 1600);
  const was = body.indexOf('const reportWas = reportWorld();');
  const pin = body.indexOf('FS.pin = setPin(');
  const close = body.indexOf("if (FS.report && reportWas !== null && reportWorld() !== reportWas) { FS.report = null; if (FS.practice?.whatif) FS.practice = null; invalidate('panel'); }");
  assert.ok(was > 0 && pin > was && close > pin, 'the world before the pin, the pin, then the close');
});
