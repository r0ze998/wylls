// ⑦ correction to the page's march entries (Lane C, 2026-11-17): a request owns what it asked for by IDENTITY — the
// draft object it opened, the place object it gave that draft, the pinned world with its generation — all taken before
// any wait; never by "a draft of this host stands" or "a place of these coordinates". WRITTEN, NOT RUN. KEY-FREE and
// import-free beyond node:test / node:assert / node:fs: app.mjs and controller.mjs are read as TEXT, not imported.
//   Expected, case by case (request 1 answers after request 2 was made):
//   I1 the same host sent home twice (村へ戻す): request 1's draft is not the open one any more → it says and moves
//      nothing; request 2 answers for its own draft
//   I2 the same place chosen again (same coordinates, a new place object — on the same or a new draft): request 1's
//      place object is not the draft's any more → no refusal note, no arrival turn moved by request 1
//   I3 put away during the wait: no draft is open → nothing
//   I4 the world changed and came back (A → B → A): the generation differs → nothing, also for a draft the send kept
//   I5 the latest request, same world: the refusal is said and composeTo's arrival-turn adjustment runs as before
//   I6 why the capture is sound: the entry opens the draft, and setDestination gives it the place, before their first wait
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const app = read('app.mjs'), ctl = read('controller.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const om = fnOf(app, 'async function orderMarch(A, hit) {'), ct = fnOf(app, 'async function composeTo(row, to) {');
const hr = app.slice(app.indexOf("  'hand-return': async d => {"), app.indexOf("  'hand-unit': d =>"));

test('I1–I4 ownership is by identity and world', () => {
  assert.ok(app.includes('const draftAims = (c, aim, world) => !!c && !!aim && FS.compose === c && c.dest === aim && momentWorld() === world;'));
  assert.doesNotMatch(app, /c\.dest\.p === to\.p && c\.dest\.q === to\.q/, 'no ownership by coordinates is left');
  assert.ok(app.includes("const momentWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.gen ?? 0}|"), 'the world carries the generation: A → B → A are three');
});

test('I1 村へ戻す: the draft and its place are taken before the wait', () => {
  order(hr, 'const host = String(d.host ?? sub.host.id), before = FS.compose, world = momentWorld();', "const going = ACTIONS['march-home']({ host });",
    'const c = FS.compose, aim = c?.dest ?? null;', 'const own = !!c && c !== before && !!c.home && String(c.host?.id) === host;', 'await going;',
    'if (!own || !draftAims(c, aim, world)) return;', "FS.tab = 'map';", 'if (c.routeError) {');
  const afterWait = code(hr).slice(code(hr).indexOf('await going;'));
  assert.doesNotMatch(afterWait, /= FS\.compose\b(?! ===)/, 'nothing is read back from FS.compose after the wait');
});

test('I2 I5 the map order and the placed order: the place object is taken before the wait', () => {
  order(om, "const c = ACTIONS.compose({ host: A.actor.id, stay: 'map' });", 'if (!c || FS.compose !== c || String(c.host?.id) !== String(A.actor.id)) return;',
    "const world = momentWorld(), going = ACTIONS['dest-from-map'](), aim = c.dest;", 'await going;', 'if (!draftAims(c, aim, world)) return;', 'if (c.routeError) mapNote(');
  order(ct, "const c = ACTIONS.compose({ host: row.id, stay: 'map' });", 'if (!c || FS.compose !== c || String(c.host?.id) !== String(row.id)) return;',
    "const world = momentWorld(), going = ACTIONS['dest-quick']({ p: String(to.p), q: String(to.q), tile: String(to.tile) }), aim = c.dest;", 'await going;',
    'if (!draftAims(c, aim, world)) return;', 'if (c.routeError) mapNote(', 'pm.ownArrivalAt(FS, to, c.arriveBell, row.id)', 'c.protoShift = { from: c.arriveBell, to: b }; c.arriveBell = b;');
  for (const body of [om, ct]) assert.equal(code(body).split('await ').length - 1, 1, 'one wait, and everything of the request is taken before it');
});

test('I6 the draft and its place exist before the first wait', () => {
  const compose = ctl.slice(ctl.indexOf('  compose: d => {'), ctl.indexOf("  'mc-bell': d => {"));
  assert.doesNotMatch(compose, /await /, 'the entry opens the draft at once');
  const sd = fnOf(ctl, 'async function setDestination(dest) {');
  order(sd, 'const c = FS.compose;', 'if (!c) return;', 'c.dest = dest;', 'const k = await kernelOrNull();', 'if (FS.compose !== c || c.dest !== dest) return;');
  const mh = ctl.slice(ctl.indexOf("  'march-home': d => {"), ctl.indexOf('  // ---- the prototype rule "banners"'));
  order(mh, "const c = ACTIONS.compose({ host: d.host, stay: 'map' });", 'c.home = true;', 'return setDestination({ p: h.p, q: h.q, tile: h.tile });');
  assert.doesNotMatch(mh, /await /);
  assert.ok(ctl.includes("'dest-from-map': () => { const s = FS.selected; if (s?.idx !== undefined) return setDestination({ p: s.p, q: s.q, tile: s.idx }); return undefined; },"));
  assert.ok(ctl.includes("'dest-quick': d => setDestination({ p: num(d.p), q: num(d.q), tile: num(d.tile) }),"));
});
