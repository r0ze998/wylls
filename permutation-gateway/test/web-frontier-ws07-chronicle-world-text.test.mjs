// ⑦ the chronicle's report: read, shown and kept only under the pinned world it was read for (Lane C, 2026-11-17).
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs is read as TEXT, not
// imported (it is page-bound and loads fi18n.mjs and lang.mjs, the subjects of refused tests). A text check: it pins the
// guards and their places; it does not run the page.
//   R1 the world comes from setPin's checked season account; null before a pin (nothing made up)
//   R2 openReport keeps the world it started under; a clash answer read under another world is dropped, not shown
//   R3 the keep added to a report needs the same world
//   R4 loadSeason closes a report of another pinned world (and only the report's own what-if)
//   C1 controller.refreshChronicle: a chronicle read under another herald or pinned world is forgotten (undefined, so the
//      screen says it is being read — never empty) before the new world's start is read
//   C2 a page the change overtakes writes nothing (return before any write to FS or the cursor)
//   C3 FS.isMine reads the viewer's holdings when a line is drawn
//   C4 no use of `own` outside isMine is left; the incoming warnings take the holdings bound right before them
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const body = ctl.slice(ctl.indexOf('async function refreshChronicle() {'), ctl.indexOf('// Incoming (§7.7)', ctl.indexOf('async function refreshChronicle() {')));
const fnStart = ctl.indexOf('async function refreshChronicle() {');
const whole = ctl.slice(fnStart, ctl.indexOf('\n}\n', fnStart) + 2);

test('R1 the pinned world, never made up', () => {
  // (corrected 2026-11-17, Lane C moments-generation: the key also names the pin's generation — fchainio.setPin — so a report
  // read under the first A is not shown under the A pinned again after B)
  assert.ok(app.includes("const reportWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.gen ?? 0}|${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);"));
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

test('C1 another herald or world: forgotten, not empty, before the new start is read', () => {
  // (corrected 2026-11-17: with the pin's generation, so a read started under the first A is not written under the A pinned again)
  assert.ok(body.includes("const worldNow = () => { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null; };"));
  const reset = body.indexOf('if (FS.chronicleSource !== undefined) { cursor = 0; FS.chronicle = undefined; FS.chronicleRead = undefined; FS.life = undefined; FS.lifeWorld = undefined; }');
  const start = body.indexOf('if (cursor === 0 && FS.record?.headSeq !== undefined) cursor = chronicleStart(FS.record.headSeq);');
  assert.ok(body.includes('if (FS.chronicleSource !== h0 || FS.chronicleWorld !== w0) {'));
  assert.ok(reset > 0 && start > reset, 'forgotten before the start is set');
  assert.doesNotMatch(body, /FS\.chronicle = \[\];\s*\}?\s*\/\/ \(reset/, 'no empty record is made by the reset');
});

test('C2 a read the change overtakes writes nothing', () => {
  const ask = body.indexOf('try { r = await herald.events(cursor); }');
  const stop = body.indexOf('if (herald !== h0 || worldNow() !== w0) return;');
  const first = Math.min(...['if (!r?.ok)', 'pages++;', 'FS.chronicle = [', 'FS.life = updateLife(', 'cursor = r.next'].map(k => body.indexOf(k)));
  assert.ok(ask > 0 && stop > ask && first > stop, 'the check comes right after the read, before any write');
});

test('C3 the viewer\'s holdings when a line is drawn', () => {
  const at = body.indexOf('FS.isMine = rec => {');
  assert.ok(at > 0 && body.indexOf('const own = FS.holdings ?? [];', at) > at, 'read inside the function');
  assert.equal(body.slice(0, at).includes('const own = FS.holdings ?? [];'), false, 'not captured before');
});

test('C4 `own` lives only inside isMine; incoming takes the holdings bound before it', () => {
  const im = whole.indexOf('FS.isMine = rec => {'), ie = whole.indexOf('};', im);
  const uses = [...whole.matchAll(/(?<![\w.$])own(?![\w$])/g)].map(m => m.index).filter(i => !whole.slice(Math.max(0, i - 12), i).endsWith("prototype's "));
  assert.ok(uses.length > 0 && uses.every(i => i > im && i < ie), 'every use of own is inside isMine');
  const decl = whole.indexOf('const holdingsNow = FS.holdings ?? [];');
  const use = whole.indexOf('holdings: holdingsNow.map(o => ({');
  const incoming = whole.indexOf('FS.incoming = FS.citizen ? incomingWarnings({');
  assert.ok(decl > 0 && incoming > decl && use > incoming, 'bound right before the incoming warnings, and used there');
  assert.equal(whole.slice(decl, incoming).includes('await'), false, 'no await between the binding and its use');
});
