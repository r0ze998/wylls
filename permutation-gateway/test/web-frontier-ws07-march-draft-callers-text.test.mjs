// ⑦ the march's entry, the page's side (Lane C, 2026-11-17): every place in app.mjs that opens a march draft goes on only
// with the draft its own request opened for its own host, and after the route's wait speaks of and adjusts only that
// draft while it still names the place. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert /
// node:fs: app.mjs and controller.mjs are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of
// refused tests).
//   Expected, case by case:
//   D1 the host is not there any more while another host's draft stands: orderMarch, composeTo, the HUD's compose and
//      村へ戻す return before any write — the selection, the tab, the camera, that draft's place, arrival turn and
//      protoShift are as they were
//   D2 the host is there: the draft the entry returned (still FS.compose, naming that host) gets the place
//   D3 after the route's wait — put away, another host's draft opened, a place chosen again, or another world (which
//      puts an unsent draft away): no map note of another draft's refusal, and composeTo moves no arrival turn
//   D4 the same world, the same draft and place: the refusal is said and composeTo's arrival-turn adjustment runs as before
//   D5 the order before the entry is unchanged: local play's own question, then the village switch, then the entry
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const app = read('app.mjs'), ctl = read('controller.mjs');
const fnOf = head => { const at = app.indexOf(head); assert.ok(at >= 0, head); return app.slice(at, app.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const om = fnOf('async function orderMarch(A, hit) {'), ct = fnOf('async function composeTo(row, to) {');
const hc = app.slice(app.indexOf('  compose: d => {'), app.indexOf("  'drawer-open': () =>"));
const hr = app.slice(app.indexOf("  'hand-return': async d => {"), app.indexOf("  'hand-unit': d =>"));
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('D1 D2 orderMarch: its own draft for its own host, or nothing', () => {
  order(om, 'FS.localMarchFor(own, A.actor.id)', 'FS.activeHolding = A.actor.holdingIndex;', "const c = ACTIONS.compose({ host: A.actor.id, stay: 'map' });",
    'if (!c || FS.compose !== c || String(c.host?.id) !== String(A.actor.id)) return;', "FS.tab = 'map'; FS.explore = null;", 'FS.selected = {',
    "const world = momentWorld(), going = ACTIONS['dest-from-map'](), aim = c.dest;", 'await going;', 'if (!draftAims(c, aim, world)) return;', 'if (c.routeError) mapNote(hit, refusalText(c.routeError, hit));');
  assert.doesNotMatch(code(om), /if \(!FS\.compose\) return;|FS\.compose\?\.routeError/);
});

test('D1–D4 composeTo: the same, and the arrival turn of its own draft only', () => {
  order(ct, 'endPick(); FS.hand = null;', "const c = ACTIONS.compose({ host: row.id, stay: 'map' });", 'if (!c || FS.compose !== c || String(c.host?.id) !== String(row.id)) return;',
    'FS.selected = { kind: \'tile\', p: to.p, q: to.q, idx: to.tile };', "const world = momentWorld(), going = ACTIONS['dest-quick']({ p: String(to.p), q: String(to.q), tile: String(to.tile) }), aim = c.dest;",
    'await going;', 'if (!draftAims(c, aim, world)) return;', 'if (c.routeError) mapNote(', 'if (FS.proto && FS.season && Number.isInteger(c.arriveBell) && pm.ownArrivalAt(FS, to, c.arriveBell, row.id)) {',
    'while (b < w.max && pm.ownArrivalAt(FS, to, b, row.id)) b++;', 'c.protoShift = { from: c.arriveBell, to: b }; c.arriveBell = b;');
  assert.doesNotMatch(code(ct), /const c = FS\.compose;|if \(!FS\.compose\) return;|FS\.compose\?\.routeError/, 'never whatever draft stands after the wait');
});

test('D3 the check after the wait', () => {
  // (corrected: by the place's own object and the world, not by coordinates — web-frontier-ws07-march-draft-identity-text.test.mjs)
  assert.ok(app.includes('const draftAims = (c, aim, world) => !!c && !!aim && FS.compose === c && c.dest === aim && momentWorld() === world;'));
  // (what makes "another world" fail it: an unsent draft is put away at a re-pin — controller adoptPinnedWorld)
  assert.ok(ctl.includes('if (FS.compose && !FS.compose.sending && !FS.compose.pending && !pendingDriver.armed) FS.compose = null;'));
  assert.ok(ctl.includes('if (FS.compose !== c || c.dest !== dest) return;'));
});

test('D1 the HUD\'s compose and 村へ戻す', () => {
  order(hc, 'const c = ACTIONS.compose(d);', 'if (!c || FS.compose !== c) return;', "FS.tab = 'map';", 'mapRef.setView(', 'FS.selected = {');
  assert.doesNotMatch(code(hc), /const c = FS\.compose;/);
  order(hr, 'if (sub.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = sub.holdingIndex;', 'const host = String(d.host ?? sub.host.id), before = FS.compose, world = momentWorld();',
    "const going = ACTIONS['march-home']({ host });", 'const c = FS.compose, aim = c?.dest ?? null;', 'const own = !!c && c !== before && !!c.home && String(c.host?.id) === host;',
    'await going;', 'if (!own || !draftAims(c, aim, world)) return;', "FS.tab = 'map';",
    'if (c.routeError) {');
  assert.doesNotMatch(code(hr), /if \(!FS\.compose\) return;|FS\.compose\.routeError/);
});

test('D5 nothing of sending is touched', () => {
  assert.doesNotMatch(code(om) + code(ct) + code(hc) + code(hr), /march-send|sendTheMarch|payAndJoin|faucet|claim/);
  assert.ok(app.includes("if (FS.localMarchFor(own, A.actor.id)?.open !== true) { mapNote(hit, () => L`ローカルプレイでは、まだ命令を送れません（読み取りのみ）。`); return; }"));
});
