// ⑦ the march's entry, one line through (Lane C, 2026-11-17): select a village or a host on the map → the card offers the
// march of every host of the viewer's standing there (also one of another of their villages) → the draft opens from that
// host's own village → a place is chosen and its route, time and conditions are read → put away / choose again. Drafts
// only: nothing is sent, and no send rule, fee or permission is changed. WRITTEN, NOT RUN. KEY-FREE and import-free
// beyond node:test / node:assert / node:fs: controller.mjs, hud/inspect.mjs and the English dictionary are read as TEXT,
// not imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests).
//   M1 the card: ownHostsOn lists the open village's hosts and, from the province's own record, those of the viewer's
//      other villages on that tile (`other`, with their village's index); each gets the march button, the other
//      village's saying where it leaves from
//   M2 the entry: ACTIONS.compose switches to the host's own village before it looks the host up, and the draft names
//      that village; the callers that already switched are unchanged
//   M3 "back to the village" reads the village after the entry: the host's own
//   M4 a place chosen: the route is written only to the draft still open and for the place it names now
//   M5 put away / choose again: compose-close and dest-from-map as before; the card offers the march again when no
//      draft is open
//   M6 a change of world: a draft that is only a draft is put away and a host in hand let go; one being sent, waiting
//      or armed is left to the send; the selected place stays
//   M7 English for the new sentence; nothing of sending is touched
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), insp = read('frontier/hud/inspect.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const compose = ctl.slice(ctl.indexOf('  compose: d => {'), ctl.indexOf("  'mc-bell': d => {"));

test('M1 the card offers every own host standing there', () => {
  const oh = fnOf(insp, 'export function ownHostsOn(FS, p, q, idx) {');
  order(oh, 'hostRows(FS).filter(r => r.p === p && r.q === q && r.tile === idx && r.state === 1 && !r.inTransit && !r.pending)', 'holdingIndex: FS.activeHolding ?? 0, other: false',
    'const prov = FS.provinces?.get?.(`${p},${q}`)?.province ?? null;', 'if (!prov || !h || i === (FS.activeHolding ?? 0)) return;', 'for (const r of hostsIn(prov, h, FS.nowBell ?? 0)) {',
    'if (r.tile !== idx || r.state !== 1 || r.inTransit || r.pending || out.some(x => x.id === String(r.id))) continue;', 'holdingIndex: i, other: true', '} catch { return []; }');
  assert.ok(insp.includes("import { UNIT_ORDER, hostsIn } from '../fland.mjs';"));
  assert.ok(insp.includes("text: h.other ? L`${unitCount(h.unit, h.troops)} を進軍させる（別の村の軍勢：その村から出します）` : L`${unitCount(h.unit, h.troops)} を進軍させる`, primary: true });"));
  assert.ok(insp.includes("if (!FS.compose && t) for (const h of ownHostsOn(FS, m.p, m.q, t.idx)) out.push({ act: 'compose', data: { host: h.id, stay: 'map' },"));
});

test('M2 the draft opens from the host\'s own village', () => {
  order(compose, 'const hi = holdingIndexOfHost(d.host);', "if (hi !== null && hi !== (FS.activeHolding ?? 0)) { FS.activeHolding = hi; invalidate('rail'); }",
    'const r = hostRow(d.host);', 'if (!r) return;', 'const h = activeHolding(FS);', 'FS.compose = { holding:{p:h.p,q:h.q,site:h.site,gen:h.gen},', 'dest: null, route: null,');
  // unchanged: the callers that switch first, and local play's own question before a draft
  assert.ok(ctl.includes("if (localPlay && localMarchFor(hi !== null ? FS.holdings[hi] : activeHolding(FS), d.host)?.open !== true) return failed(localPlayReadOnly());"));
});

test('M3 the way home is to the host\'s own village', () => {
  const mh = ctl.slice(ctl.indexOf("  'march-home': d => {"), ctl.indexOf('  // ---- the prototype rule "banners"'));
  // (corrected: only the draft this request opened for this host is marked — web-frontier-ws07-march-home-draft-text.test.mjs)
  order(mh, 'if (!activeHolding(FS)) return undefined;', "const c = ACTIONS.compose({ host: d.host, stay: 'map' });",
    'if (!c || FS.compose !== c || String(c.host?.id) !== String(d.host)) return undefined;', 'const h = activeHolding(FS);',
    'c.home = true;', 'return setDestination({ p: h.p, q: h.q, tile: h.tile });');
});

test('M4 the route is of the place the open draft names now', () => {
  const sd = fnOf(ctl, 'async function setDestination(dest) {');
  // (the march-card bundle works the results out first and sets them together, and marks a route that was not read —
  //  web-frontier-ws07-march-card-retry-text.test.mjs)
  order(sd, 'c.dest = dest; c.route = null; c.routeError = null; c.routeUnread = false; c.earliest = null; c.moved = null;', 'const k = await kernelOrNull();',
    'if (FS.compose !== c || c.dest !== dest) return;', "if (!k) { c.routeError = FS.kernelError ?? 'NoKernel'; c.routeUnread = true; invalidate('panel'); return; }", 'const r = planRoute(k, {',
    "if (!r.ok) { c.routeError = r.code; invalidate('panel'); return; }", 'const earliest = earliestBell(k, {', 'const arrive = arrivalWindow(FS.season, nowBell(), earliest).min;',
    'c.route = r.route; c.earliest = earliest; c.arriveBell = arrive;');
  assert.equal(sd.split('await ').length - 1, 1);
});

test('M5 put away and choose again, as before', () => {
  assert.ok(ctl.includes("'compose-close': () => { pendingDriver.cancel('cancel'); FS.compose = null; invalidate('panel'); },"));
  assert.ok(ctl.includes("'dest-from-map': () => { const s = FS.selected; if (s?.idx !== undefined) return setDestination({ p: s.p, q: s.q, tile: s.idx }); return undefined; },"));
  // (fix-b14-b16 B14: never on a centre place without a Province — web-frontier-centre-no-province.test.mjs)
  assert.ok(insp.includes("if (FS.compose && t && !FS.compose.sending && m.place !== PLACE.centre) out.push({ act: 'dest-from-map', data: {}, text: L`ここを進軍の行き先にする`, primary: true });"));
});

test('M6 another world\'s draft and host in hand are not this world\'s', () => {
  const ad = fnOf(ctl, 'export function adoptPinnedWorld() {');
  order(ad, 'if (readsWorld === undefined || readsWorld === world) { readsWorld = world; return false; }',
    'if (FS.compose && !FS.compose.sending && !FS.compose.pending && !pendingDriver.armed) FS.compose = null;',
    'if (FS.hand?.host !== undefined && FS.hand?.host !== null) FS.hand = null;', 'dropOtherWorldConquest(world);');
  assert.doesNotMatch(ad, /FS\.selected =/, 'the selected place stays the person\'s');
});

test('M7 English follows; nothing of sending is touched', () => {
  const line = en.split('\n').find(l => l.startsWith("  '{0} を進軍させる（別の村の軍勢：その村から出します）':"));
  assert.ok(line);
  assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  assert.ok(ctl.includes("'march-send': () => sendTheMarch(),"));
  assert.doesNotMatch(compose, /sendTheMarch|armMarchWait|act\('/, 'the entry drafts, it does not send');
});
