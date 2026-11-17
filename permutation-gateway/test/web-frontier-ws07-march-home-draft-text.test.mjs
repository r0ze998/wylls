// ⑦ correction to the march's entry (Lane C, 2026-11-17): "back to the village" marks and aims only the draft that this
// very request opened for this very host. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert /
// node:fs: controller.mjs is read as TEXT, not imported (it loads fi18n.mjs and lang.mjs, the subjects of refused tests).
//   Expected, case by case:
//   H1 the host is not there any more while a draft of ANOTHER host stands: the entry answers nothing; march-home returns
//      before any write — that draft's `home`, place and route are as they were
//   H2 the host is there: the draft the entry returns is the one in FS.compose and names that host → marked home, its
//      place the host's own village (read after the entry)
//   H3 the entry itself: a host not found leaves FS.compose and the open village as they were; found, it returns the new
//      draft (FS.compose)
//   H4 pressed again / another host right after: each request checks its own draft; the route of an earlier request that
//      answers late is not written to a later draft or another place (setDestination's check after its wait)
//   H5 put away while the route is read: nothing is written to the draft let go
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const mh = ctl.slice(ctl.indexOf("  'march-home': d => {"), ctl.indexOf('  // ---- the prototype rule "banners"'));
const compose = ctl.slice(ctl.indexOf('  compose: d => {'), ctl.indexOf("  'mc-bell': d => {"));
const sdAt = ctl.indexOf('async function setDestination(dest) {'), sd = ctl.slice(sdAt, ctl.indexOf('\n}\n', sdAt) + 2);

test('H1 H2 only this request\'s own draft is marked and aimed', () => {
  order(mh, 'if (!activeHolding(FS)) return undefined;', "const c = ACTIONS.compose({ host: d.host, stay: 'map' });",
    'if (!c || FS.compose !== c || String(c.host?.id) !== String(d.host)) return undefined;', 'const h = activeHolding(FS);', 'if (!h) return undefined;',
    'c.home = true;', 'return setDestination({ p: h.p, q: h.q, tile: h.tile });');
  const code = mh.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /FS\.compose\.home = true|if \(!FS\.compose\) return undefined;/, 'never whatever draft happens to stand');
  const before = code.slice(0, code.indexOf('if (!c || FS.compose !== c'));
  assert.doesNotMatch(before, /\.home =|setDestination\(/, 'no write before the check');
});

test('H3 the entry: not found changes nothing; found returns the new draft', () => {
  order(compose, 'const hi = holdingIndexOfHost(d.host);', "if (hi !== null && hi !== (FS.activeHolding ?? 0)) { FS.activeHolding = hi; invalidate('rail'); }",
    'const r = hostRow(d.host);', 'if (!r) return;', 'FS.compose = {', 'host: { ...r.entry, id: r.id,', 'return FS.compose;');
  const head = compose.slice(0, compose.indexOf('if (!r) return;'));
  assert.doesNotMatch(head.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'), /FS\.compose =/, 'no draft is touched before the host is found');
});

test('H4 H5 a late route is not written to another draft or place', () => {
  order(sd, 'const c = FS.compose;', 'if (!c) return;', 'c.dest = dest;', 'const k = await kernelOrNull();', 'if (FS.compose !== c || c.dest !== dest) return;', 'c.route = r.route;');
  assert.equal(sd.split('await ').length - 1, 1);
  assert.ok(ctl.includes("if (!ACTIONS.compose({host:d.host,stay:'map'})) return;"), 'the keep\'s march also goes on only with the draft the entry returned');
});
