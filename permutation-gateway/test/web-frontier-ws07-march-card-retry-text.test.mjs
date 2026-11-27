// ⑦ the march card, one line through (Lane C, 2026-11-17): a host and a place chosen on the map → the plan is read →
// conditions, route and arrival are judged → a read that failed can be asked again from the same draft → put away and
// back to the map. Drafts only: nothing is sent, and no send rule, pendingDriver, fee or march rule is changed.
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs,
// hud/marchcard.mjs and the English dictionary are read as TEXT, not imported.
//   Expected, case by case:
//   P1 the rules module cannot be had: the draft keeps its place and settings; routeError names why and routeUnread is
//      true; the card says the route is not known and offers to ask again
//   P2 working the route out throws: the same — never 「道のりを探しています…」 for good (it was: neither route nor error)
//   P3 the world answers "no route" (a refusal code): routeUnread false — the existing words, and the reach link where
//      it applies; no "ask again" as if nothing had been read
//   P4 a route: the route, the earliest turn and the arrival turn are worked out first and set together — the card's
//      arrival is always made from the route it shows
//   P5 ask again: a NEW request for the draft's own place (a new place object), so a late answer of the earlier request
//      is not written (setDestination's identity check); stance, retreat, ratio, tip and home are untouched; not while
//      sending
//   P6 put away during the wait: nothing is written to the draft let go, and nothing to a newer one
//   P7 not known is never sendable: both send buttons need a route
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), card = read('frontier/hud/marchcard.mjs'), en = read('lang/en-frontier-play.mjs');
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const sdAt = ctl.indexOf('async function setDestination(dest) {'), sd = ctl.slice(sdAt, ctl.indexOf('\n}\n', sdAt) + 2);
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('P1 P2 P3 a route not read is said as that, and kept apart from "no route"', () => {
  order(sd, 'c.dest = dest; c.route = null; c.routeError = null; c.routeUnread = false; c.earliest = null; c.moved = null;', 'const k = await kernelOrNull();',
    'if (FS.compose !== c || c.dest !== dest) return;', "if (!k) { c.routeError = FS.kernelError ?? 'NoKernel'; c.routeUnread = true; invalidate('panel'); return; }",
    'try {', "if (!r.ok) { c.routeError = r.code; invalidate('panel'); return; }", '} catch (e) {', "c.route = null; c.routeError = e?.code ?? 'Error'; c.routeUnread = true;", "invalidate('panel');");
  const refusal = sd.slice(sd.indexOf('if (!r.ok) {'), sd.indexOf('const earliest'));
  assert.doesNotMatch(refusal, /routeUnread = true/, 'the world\'s "no route" is an answer, not a failed read');
});

test('P4 the arrival is made from the route shown', () => {
  order(sd, 'const r = planRoute(k, {', 'const earliest = earliestBell(k, { lead: minLeadOf(FS.season), genesisTs: FS.clock.genesisTs, departTs: now() + margin(), secs: r.route.secs });',
    'const arrive = arrivalWindow(FS.season, nowBell(), earliest).min;', 'c.route = r.route; c.earliest = earliest; c.arriveBell = arrive;');
  assert.equal(code(sd).split('c.route = r.route').length - 1, 1, 'set in one place, with its arrival');
  assert.equal(code(sd).split('await ').length - 1, 1);
});

test('P5 P6 asking again is a new request for the same place', () => {
  assert.ok(ctl.includes("'dest-retry': () => { const c = FS.compose; if (!c?.dest || c.sending) return undefined; return setDestination({ p: c.dest.p, q: c.dest.q, tile: c.dest.tile }); },"));
  const reset = sd.slice(0, sd.indexOf('const k = await'));
  assert.doesNotMatch(reset, /c\.stance|c\.retreat|c\.ratio|c\.tip|c\.home|c\.holding|c\.host/, 'the draft\'s settings are not touched by a route request');
  assert.ok(ctl.includes("'compose-close': () => { pendingDriver.cancel('cancel'); FS.compose = null; invalidate('panel'); },"));
});

test('P1 P2 the card: not known, kept, ask again', () => {
  order(card, 'c.route ? routeLine(c.route) : c.routeError ? clientText(c.routeError) : L`道のりを探しています…`',
    '${!c.route && c.routeUnread ? html`<span class="mc-route-unread" role="status">${L`道のりはまだわかっていません。行き先と設定はそのままです。着くターンは、道のりがわかってから決まります。`}',
    'data-act="dest-retry" ${raw(busy ? \'disabled\' : \'\')}>${icon(\'return\')}${L`道のりをもう一度調べる`}</button>');
  for (const k of ['道のりはまだわかっていません。行き先と設定はそのままです。着くターンは、道のりがわかってから決まります。', '道のりをもう一度調べる']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});

test('P7 a route not known is never sendable', () => {
  assert.ok(card.includes('const mainOk = !busy && !waiting && !!c.route && (problems.length === 0 || pendable(problems));'));
  assert.ok(card.includes("data-act=\"march-send\" ${raw(problems.length || busy || !c.route ? 'disabled' : '')}>"));
  assert.doesNotMatch(code(sd), /sendTheMarch|armMarchWait|pendingDriver/, 'the route request sends nothing');
});
