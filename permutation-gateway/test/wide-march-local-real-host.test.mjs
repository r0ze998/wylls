// Explicit real-host integration. Never starts a server, builds code, signs, or contacts a chain.
// Run only after the fixed local_march_demo binary (protocol v4) has been audited and built.
// Assertions are relations between host replies, never hardcoded store or troop snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChildBridge } from '../screens/wide-march-local/host-bridge.mjs';
import { commandLine, parseReplyLine, validateState, checkTransition, checkQuote, HISTORY } from '../screens/wide-march-local/local-model.mjs';
import { bindingMatchesQuote } from '../screens/wide-march-local/local-client.mjs';
import { decodeRecord, KIND, provinceKeyHex } from '../screens/wide-march-local/local-receipts.mjs';
import { walkDirections } from '../screens/wide-march-local/local-route.mjs';
import { DIRECTIONS } from '../../permutation-server/web/frontier/fgeo.mjs';

const read = async (bridge, line) => validateState(parseReplyLine(await bridge.exchange(line)));
const accountOf = (r, k) => r.evidence.accounts.find(a => a.keyHex === k);

async function exercise(commands) {
  const bridge = await createChildBridge();
  try {
    const initial = await read(bridge, 'get');
    assert.equal(initial.revision, 0);
    assert.equal(initial.phase, 'ready');
    assert.equal(initial.marchBinding, null);
    let previous = initial, trains = 0, farmSlot = null;
    for (const kind of commands) {
      const command = { kind, rev: previous.revision };
      const next = await read(bridge, commandLine(command));
      assert.equal(next.status, 'ok', `${kind} at ${previous.phase}: ${next.error ?? 'unknown refusal'} ${next.refusalCode ?? ''}`);
      assert.equal(checkTransition(previous, command, next, initial), 'ok');
      assert.ok(next.evidence.instructions.length > 0, `${kind} must name real dispatches`);
      assert.ok(next.evidence.recordsHex.length > 0, `${kind} must return new records`);
      if (kind === 'depart') {
        assert.equal(next.host.currentMilli, next.host.initialMilli, 'departure keeps the Spend entry troops until settlement');
        assert.equal(next.marchBinding.kind, 'recorded');
        assert.deepEqual(next.marchBinding.trail, ['RECORDED_FIXTURE_ORDER', 'REAL_DEPART']);
      }
      if (kind === 'train') { trains++; assert.equal(next.holding.reserveUnits, previous.holding.reserveUnits + 10); }
      if (kind === 'build_farm') {
        const before = previous.village.queue.map(q => q.kind !== 0), after = next.village.queue.map(q => q.kind !== 0);
        farmSlot = after.findIndex((busy, i) => busy && !before[i]);
        assert.ok(farmSlot >= 0, 'the farm is queued');
      }
      if (kind === 'harvest' && next.phase === 'revealed' && farmSlot !== null) {
        assert.equal(next.village.queue[farmSlot].kind, 0, 'the farm completed on the touch at bell 21');
        assert.ok(BigInt(next.village.production[0]) > BigInt(initial.village.production[0]));
      }
      // the RECORDED fixture destination has its fixture enemy: this assertion is the recorded march's only
      if (kind === 'resolve_arrival') {
        assert.equal(next.combat.enemyFixture, true);
        assert.ok(next.combat.engagements > 0);
        assert.ok(next.combat.arrivalSurvivorMilli > 0);
        assert.ok(next.combat.arrivalSurvivorMilli < next.host.initialMilli);
      }
      if (kind === 'dissolve_return') assert.equal(next.holding.reserveUnits, previous.holding.reserveUnits + next.returned.creditedUnits);
      previous = next;
    }
    assert.equal(previous.phase, 'returned');
    assert.equal(previous.economy.trains, trains);
    assert.equal(previous.host.transitState, 'closed');
    assert.equal(previous.holding.openTransits, 0);
    assert.equal(previous.holding.escrowLamports, '0');
    assert.ok(previous.combat.engagements > 0, 'later resolves retain the arrival combat count');
    assert.ok(previous.returned.creditedUnits > 0);
    assert.ok(previous.returned.creditedMilli < previous.host.initialMilli);
    assert.equal(previous.returned.creditedMilli, previous.returned.creditedUnits * 1000);
    assert.equal(previous.holding.reserveUnits, initial.holding.reserveUnits + 10 * trains + previous.returned.creditedUnits);
    assert.ok(previous.horizon.destinationResolvedNext > initial.horizon.originResolvedNext, 'the reported horizon stays honest');

    const get = await read(bridge, 'get');
    assert.equal(checkTransition(previous, { kind: 'get' }, get, initial), 'ok');
    const stale = await read(bridge, 'harvest 0');
    assert.equal(stale.error, 'STALE_REVISION');
    assert.equal(checkTransition(get, { kind: 'harvest', rev: 0 }, stale, initial), 'refused');
    const resetCmd = { kind: 'reset', rev: stale.revision };
    const reset = await read(bridge, commandLine(resetCmd));
    assert.equal(checkTransition(stale, resetCmd, reset, initial), 'ok');
    assert.equal(reset.phase, 'ready');
    return { revision: previous.revision };
  } finally { bridge.close(); }
}

const MARCH = ['depart', 'settle_departure', 'post_reveal', 'resolve_arrival', 'settle_transit', 'dissolve_return'];

test('real host: village economy and the recorded march interleaved on one holding and one clock', async () => {
  const commands = ['harvest', 'build_farm', 'train', 'depart', 'train', 'settle_departure', 'harvest', 'post_reveal', 'harvest', 'resolve_arrival', 'settle_transit', 'train', 'dissolve_return', 'harvest'];
  assert.equal((await exercise(commands)).revision, commands.length);
});
test('real host: same recorded route without any economy command', async () => {
  assert.equal((await exercise(MARCH)).revision, MARCH.length);
});
test('real host: open a ring-129 province with the real handler, then quote into it; stale and duplicate change nothing', async () => {
  const bridge = await createChildBridge();
  try {
    const initial = await read(bridge, 'get');
    assert.equal(initial.land.opened, 0);
    assert.ok(initial.allowed.includes('open_province') && !initial.allowed.includes('depart_route'));
    const before = await read(bridge, `quote_route ${'2'.repeat(32)}`);
    checkQuote(initial, before);
    const i = before.routeQuote.blockedStep;
    assert.equal(before.routeQuote.reason, 'UNKNOWN_PROVINCE');
    const target = before.routeQuote.steps[i];
    const cmd = { kind: 'open_province', rev: 0, p: target.p, q: target.q };
    const opened = await read(bridge, commandLine(cmd));
    assert.equal(opened.status, 'ok', `${opened.error} ${opened.refusalCode ?? ''}`);
    assert.equal(checkTransition(initial, cmd, opened, initial), 'ok');
    const prov = opened.map.provinces.find(p => p.p === target.p && p.q === target.q);
    assert.equal(prov.source, 'opened'); assert.equal(prov.history, HISTORY.NONE); assert.equal(prov.openedBell, opened.clock.bell);
    assert.ok(opened.allowed.includes('depart_route'), 'offered once a province is opened');
    const stale = await read(bridge, commandLine(cmd));
    assert.equal(stale.error, 'STALE_REVISION');
    assert.equal(checkTransition(opened, cmd, stale, initial), 'refused');
    const dupCmd = { ...cmd, rev: 1 };
    const dup = await read(bridge, commandLine(dupCmd));
    assert.equal(dup.error, 'LAND_DUPLICATE_OPEN');
    assert.equal(checkTransition(opened, dupCmd, dup, initial), 'refused');
    const after = await read(bridge, `quote_route ${'2'.repeat(32)}`);
    checkQuote(opened, after);
    assert.equal(after.routeQuote.steps[i].known, true);
    const harvest = await read(bridge, 'harvest 1');
    assert.equal(checkTransition(opened, { kind: 'harvest', rev: 1 }, harvest, initial), 'ok');
    const depart = await read(bridge, 'depart 2');
    assert.equal(checkTransition(harvest, { kind: 'depart', rev: 2 }, depart, initial), 'ok');
    assert.equal(depart.marchBinding.kind, 'recorded', 'depart is the recorded march even with an opened province');
    const resetCmd = { kind: 'reset', rev: 3 };
    const reset = await read(bridge, commandLine(resetCmd));
    assert.equal(checkTransition(depart, resetCmd, reset, initial), 'ok');
    assert.equal(reset.land.opened, 0);
  } finally { bridge.close(); }
});
test('real host: a route quote validates a chosen path over the really-opened provinces and never mutates', async () => {
  const bridge = await createChildBridge();
  try {
    const initial = await read(bridge, 'get');
    const reach = await read(bridge, 'quote_route 222');
    assert.equal(checkQuote(initial, reach), reach.routeQuote);
    assert.equal(reach.routeQuote.reachable, true);
    assert.deepEqual(reach.routeQuote.end, { p: '129', q: '-1', tile: 34 });
    // the browser's own re-walk of the same directions is the host's
    assert.deepEqual(walkDirections({ p: '129', q: '0', tile: initial.host.originTile }, '222').steps, reach.routeQuote.steps.map(({ p, q, tile }) => ({ p, q, tile })));
    const far = await read(bridge, `quote_route ${'2'.repeat(32)}`);
    checkQuote(initial, far);
    const fq = far.routeQuote, firstUnknown = fq.steps.findIndex(s => !s.known);
    assert.equal(fq.reachable, false); assert.equal(fq.reason, 'UNKNOWN_PROVINCE');
    assert.ok(firstUnknown > 0); assert.equal(fq.blockedStep, firstUnknown);
    const bad = JSON.parse(await bridge.exchange('quote_route 6'));
    assert.equal(bad.status, 'refused'); assert.equal(bad.error, 'BAD_COMMAND'); assert.equal(bad.command, 'invalid'); assert.equal(bad.routeQuote, null);
    const after = await read(bridge, 'get');
    assert.equal(after.revision, 0);
    assert.equal(checkTransition(initial, { kind: 'get' }, after, initial), 'ok');
    assert.equal((await read(bridge, 'depart 0')).status, 'ok');
  } finally { bridge.close(); }
});

/** Breadth-first search, over the host's own masks, for directions whose LAST step is the first impassable tile of
 * a returned province (every earlier step on returned, passable land): a route the host must refuse as IMPASSABLE. */
function impassableRoute(state) {
  const held = new Map(state.map.provinces.map(p => [`${p.p},${p.q}`, BigInt(p.passableMask)]));
  const ok = s => { const m = held.get(`${s.p},${s.q}`); return m === undefined ? null : ((m >> BigInt(s.tile)) & 1n) === 1n; };
  const start = { p: state.map.origin.p, q: state.map.origin.q, tile: state.host.originTile };
  const seen = new Set([`${start.p},${start.q},${start.tile}`]); let frontier = [''];
  for (let depth = 0; depth < 31 && frontier.length; depth++) {
    const next = [];
    for (const dirs of frontier) for (let d = 0; d < DIRECTIONS.length; d++) {
      const w = walkDirections(start, dirs + d);
      if (w.offWorld !== null) continue;
      const s = w.steps.at(-1), k = `${s.p},${s.q},${s.tile}`;
      if (seen.has(k)) continue; seen.add(k);
      const pass = ok(s);
      if (pass === false) return dirs + d;
      if (pass === true) next.push(dirs + d);
    }
    frontier = next;
  }
  return null;
}

test('real host v4: a chosen march to the opened (129,-2) along the 12-step direction-2 route, with the economy, back to the same holding', async () => {
  const bridge = await createChildBridge();
  try {
    const initial = await read(bridge, 'get');
    const DIRS = '2'.repeat(12);
    const refusedAs = async (prev, line, cmd, token) => {
      const r = await read(bridge, line);
      assert.equal(r.status, 'refused', line); assert.equal(r.error, token, line);
      assert.equal(checkTransition(prev, cmd, r, initial), 'refused');
      assert.equal(r.revision, prev.revision);
      return r;
    };
    // before any opening: unknown land (with the host's own quote), the origin, the fixture destination
    const unknown = await refusedAs(initial, `depart_route 0 ${DIRS}`, { kind: 'depart_route', rev: 0, dirs: DIRS }, 'ROUTE_UNREACHABLE');
    assert.equal(unknown.routeQuote.reason, 'UNKNOWN_PROVINCE');
    await refusedAs(initial, 'depart_route 0 2', { kind: 'depart_route', rev: 0, dirs: '2' }, 'ROUTE_DESTINATION_ORIGIN');
    await refusedAs(initial, 'depart_route 0 222', { kind: 'depart_route', rev: 0, dirs: '222' }, 'ROUTE_DESTINATION_FIXTURE');
    // open (129,-2) with the real handler
    const openCmd = { kind: 'open_province', rev: 0, p: '129', q: '-2' };
    const opened = await read(bridge, commandLine(openCmd));
    assert.equal(opened.status, 'ok', `${opened.error}`);
    assert.equal(checkTransition(initial, openCmd, opened, initial), 'ok');
    const dest = opened.map.provinces.find(p => p.p === '129' && p.q === '-2');
    const fixtureDest = opened.map.provinces[1];
    // an impassable tile found over the host's own masks is refused as such, nothing committed
    const blocked = impassableRoute(opened);
    assert.ok(blocked, 'the returned masks have a reachable impassable tile');
    const imp = await refusedAs(opened, `depart_route 1 ${blocked}`, { kind: 'depart_route', rev: 1, dirs: blocked }, 'ROUTE_UNREACHABLE');
    assert.equal(imp.routeQuote.reason, 'IMPASSABLE');
    // the quote of the chosen route: reachable, into (129,-2)
    const quoted = await read(bridge, `quote_route ${DIRS}`);
    const quote = checkQuote(opened, quoted);
    assert.equal(quote.reachable, true); assert.deepEqual([quote.end.p, quote.end.q], ['129', '-2']);
    let prev = opened;
    const run = async (kind, extra = {}) => {
      const cmd = { kind, rev: prev.revision, ...extra };
      const next = await read(bridge, commandLine(cmd));
      assert.equal(next.status, 'ok', `${kind}: ${next.error} ${next.refusalCode ?? ''}`);
      assert.equal(checkTransition(prev, cmd, next, initial), 'ok', kind);
      prev = next;
      return next;
    };
    await run('harvest');
    // a stale chosen departure is refused and never replayed
    await refusedAs(prev, `depart_route 1 ${DIRS}`, { kind: 'depart_route', rev: 1, dirs: DIRS }, 'STALE_REVISION');
    const departLine = `depart_route ${prev.revision} ${DIRS}`;
    const departed = await run('depart_route', { dirs: DIRS });
    const b = departed.marchBinding;
    // the selection is the chosen one, exactly the quoted route; not the recorded route
    assert.equal(b.kind, 'chosen'); assert.equal(b.directions, DIRS);
    assert.ok(bindingMatchesQuote(b, DIRS, quote), 'the bound route is the quoted route');
    assert.deepEqual([b.destination.p, b.destination.q, b.destination.source], ['129', '-2', 'opened']);
    assert.notDeepEqual({ p: b.destination.p, q: b.destination.q }, departed.map.destination);
    assert.equal(departed.combat.enemyFixture, false);
    assert.deepEqual(b.trail, ['RECORDED_ORDER_REPRODUCED', 'REBUILT_FROM_PUBLIC_MATERIAL_T20', 'REAL_DEPART', 'REVEAL_REHEARSED_ON_DROPPED_COPY']);
    assert.equal(departed.horizon.selectedDestinationResolvedNext, dest.openedBell);
    // a replay of the same line is stale; a new departure in the wrong phase is refused
    await refusedAs(departed, departLine, { kind: 'depart_route', rev: departed.revision - 1, dirs: DIRS }, 'STALE_REVISION');
    await refusedAs(departed, `depart_route ${departed.revision} ${DIRS}`, { kind: 'depart_route', rev: departed.revision, dirs: DIRS }, 'BAD_PHASE');
    await refusedAs(departed, `depart ${departed.revision}`, { kind: 'depart', rev: departed.revision }, 'BAD_PHASE');
    await run('train');
    await run('settle_departure');
    await run('harvest');
    const revealed = await run('post_reveal');
    // the preparation: real Resolves of bells openedBell..19 keyed by the chosen province, then the Revealed
    const n = 20 - dest.openedBell, recs = revealed.evidence.recordsHex.map(decodeRecord), key = provinceKeyHex(revealed.map.worldHex, '129', '-2');
    assert.deepEqual(recs.map(r => r.kind), [...Array(n).fill(KIND.RESOLVE), KIND.REVEALED]);
    assert.deepEqual(recs.slice(0, n).map(r => r.bell), Array.from({ length: n }, (_, i) => dest.openedBell + i));
    assert.ok(recs.every(r => r.provinceHex === key));
    assert.equal(revealed.marchBinding.preparation.resolves, n);
    assert.equal(revealed.map.provinces.find(p => p.p === '129' && p.q === '-2').history, HISTORY.PREPARED);
    assert.equal(revealed.horizon.selectedDestinationResolvedNext, 20);
    await run('harvest');
    const resolved = await run('resolve_arrival');
    assert.equal(resolved.horizon.selectedDestinationResolvedNext, 21);
    assert.ok(resolved.combat.arrivalSurvivorMilli >= 1 && resolved.combat.arrivalSurvivorMilli <= b.departedMilli, 'survivors as the handlers wrote them (no engagement count is asserted)');
    const settled = await run('settle_transit');
    assert.equal(settled.holding.escrowLamports, '0'); assert.equal(settled.holding.openTransits, 0);
    await run('train');
    const back = await run('dissolve_return');
    assert.equal(back.phase, 'returned');
    assert.equal(back.horizon.selectedDestinationResolvedNext, 24);
    assert.equal(back.returned.creditedMilli, back.returned.creditedUnits * 1000);
    await run('harvest');
    // the recorded destination: byte-identical account and summary from the opening to the return
    assert.deepEqual(accountOf(prev, fixtureDest.accountKeyHex), accountOf(opened, fixtureDest.accountKeyHex));
    assert.deepEqual(prev.map.provinces[1], fixtureDest);
    assert.ok(prev.evidence.accounts.length <= 96);
    for (const a of prev.marchBinding.accounts) assert.ok(accountOf(prev, a.keyHex), a.role);
    // reset: no binding, no opened province, no selected cursor
    const resetCmd = { kind: 'reset', rev: prev.revision };
    const reset = await read(bridge, commandLine(resetCmd));
    assert.equal(checkTransition(prev, resetCmd, reset, initial), 'ok');
    assert.equal(reset.marchBinding, null); assert.equal(reset.land.opened, 0); assert.equal(reset.horizon.selectedDestinationResolvedNext, null);
  } finally { bridge.close(); }
});
