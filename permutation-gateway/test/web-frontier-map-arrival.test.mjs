// The march order from the S1 map golden's host, before sealing (⑲, 2026-11-08): the router's own answers
// (frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json, cqfixture::growth) decoded by the page's
// herald.mjs, then the composer's pre-seal check fmarch.checkMarch from the wallet's host on (4,0) tile 0 to
// (5,0) tile 0 at the grown stage. The Season is CreateSeason's write of MC_LOCAL_7D (min_lead 2, max_lead 72,
// the program's validate pins both), so the arrival window is [now + 2, now + 72]; a zero-window Season (the
// golden before this fix) leaves no arrival bell and the check refuses ArrivalBell.
// Key-free: no seal, no Worker, no signature. checkMarch, arrivalWindow and tipOptions are pure; seal.mjs is
// imported for constants only (sealMarch is never called). The route is workstream 8's planRoute answer
// (growth-route.mjs ROUTE, pinned there against frontier-v3.wasm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { arrivalWindow, checkMarch, tipOptions, RETREAT_CHOICES } from '../../permutation-server/web/frontier/fmarch.mjs';
import { ROUTE } from './fixtures/frontier/growth-route.mjs';

const S1 = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url), 'utf8'));

function heraldAt(stage, patch = a => a) {
  const answers = S1.stages[stage];
  const f = async url => {
    const path = new URL(url, 'http://h').pathname;
    const a = patch(answers[path] ?? { status: 404, body: { ok: false, code: 'NotFound' } }, path);
    const body = a.body?.b64 !== undefined ? Buffer.from(a.body.b64, 'base64') : JSON.stringify(a.body);
    return new Response(body, { status: a.status });
  };
  const h = createHerald({ fetch: f, seasonId: S1.season });
  h.pin(S1.season, seasonAddresses(S1.program, BigInt(S1.season)));
  return h;
}

/** The composer's inputs at `nowBell` from the herald's answers. */
async function orderAt(h, nowBell) {
  const s = await h.season();
  assert.ok(s.ok, s.code);
  const me = await h.me(S1.wallet);
  assert.ok(me.ok, me.code);
  const pv = await h.province(4, 0);
  assert.ok(pv.ok, pv.code);
  const host = pv.province.entries.find(e => String(e.id) === S1.host);
  assert.ok(host, 'the wallet\'s host is in (4,0)');
  const tip = tipOptions(s.season)[0].lamports;
  return {
    season: s.season, nowBell, now: Number(s.season.genesisTs) + nowBell * 600, resolvedNext: pv.province.resolvedNext,
    holding: me.holdings[0], province: pv.province, host, dest: { p: 5, q: 0, tile: 0 },
    route: { ...ROUTE, path: null }, earliest: null, stance: 0, retreat: { choice: RETREAT_CHOICES[0].id }, tip,
  };
}

test('the S1 Season carries the profile\'s lead window: min_lead 2, max_lead 72', async () => {
  const s = await heraldAt('grown').season();
  assert.ok(s.ok, s.code);
  assert.equal(s.season.minLead, 2);
  assert.equal(s.season.maxLead, 72);
  assert.deepEqual(arrivalWindow(s.season, 0), { min: 2, max: 72 });
});

test('grown: the order from (4,0) tile 0 to (5,0) tile 0 passes every pre-seal check for an arrival bell in the window', async () => {
  const m = await orderAt(heraldAt('grown'), 0);
  for (const arriveBell of [2, 3, 72]) assert.deepEqual(checkMarch({ ...m, arriveBell }), [], `arrive ${arriveBell}`);
  for (const arriveBell of [0, 1, 73]) assert.deepEqual(checkMarch({ ...m, arriveBell }), ['ArrivalBell'], `arrive ${arriveBell}`);
});

test('before growth there is no route, and a zero-window Season leaves no arrival bell (the old golden)', async () => {
  const m = await orderAt(heraldAt('grown'), 0);
  assert.deepEqual(checkMarch({ ...m, route: null, arriveBell: 3 }), ['NoPath']);
  // The Season bytes with MIN_LEAD (@276) and MAX_LEAD (@277) zeroed, as the fixture wrote them before.
  const zero = heraldAt('grown', (a, path) => {
    if (path !== '/h/season') return a;
    const b = Buffer.from(a.body.bytes_b64, 'base64');
    b[276] = 0; b[277] = 0;
    return { ...a, body: { ...a.body, bytes_b64: b.toString('base64') } };
  });
  const z = await orderAt(zero, 0);
  // Zero leads: the only bell is the departure bell itself; the page's earliest bell for a real route (the kernel's
  // earliest_arrival_bell for its secs, after departure) is past it, so no arrival bell is left and Seal stays off.
  assert.deepEqual(arrivalWindow(z.season, 0), { min: 0, max: 0 });
  for (const earliest of [1, 3]) {
    const w = arrivalWindow(z.season, 0, earliest);
    assert.ok(w.min > w.max, `earliest ${earliest}: empty window ${JSON.stringify(w)}`);
    for (const arriveBell of [0, 1, 2, 3, 72]) assert.ok(checkMarch({ ...z, earliest, arriveBell }).includes('ArrivalBell'), `zero window, earliest ${earliest}, arrive ${arriveBell}`);
  }
  // The profile's window with the same earliest bells: from the earliest bell to now + 72.
  for (const earliest of [1, 3]) {
    assert.deepEqual(arrivalWindow(m.season, 0, earliest), { min: Math.max(2, earliest), max: 72 });
    assert.deepEqual(checkMarch({ ...m, earliest, arriveBell: Math.max(2, earliest) }), []);
    assert.deepEqual(checkMarch({ ...m, earliest, arriveBell: Math.max(2, earliest) - 1 }), ['ArrivalBell']);
  }
});
