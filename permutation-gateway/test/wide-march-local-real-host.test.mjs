// Explicit real-host integration. Never starts a server, builds code, signs, or contacts a chain.
// Run only after the fixed local_march_demo binary (protocol v3) has been audited and built.
// Assertions are relations between host replies, never hardcoded store or troop snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChildBridge } from '../screens/wide-march-local/host-bridge.mjs';
import { commandLine, parseReplyLine, validateState, checkTransition, checkQuote } from '../screens/wide-march-local/local-model.mjs';

async function exercise(commands) {
  const bridge = await createChildBridge();
  try {
    const initial = validateState(parseReplyLine(await bridge.exchange('get')));
    assert.equal(initial.revision, 0);
    assert.equal(initial.phase, 'ready');
    let previous = initial, trains = 0, farmSlot = null;
    const seen = {};
    for (const kind of commands) {
      const command = { kind, rev: previous.revision };
      const next = validateState(parseReplyLine(await bridge.exchange(commandLine(command))));
      assert.equal(next.status, 'ok', `${kind} at ${previous.phase}: ${next.error ?? 'unknown refusal'} ${next.refusalCode ?? ''}`);
      assert.equal(checkTransition(previous, command, next, initial), 'ok');
      assert.ok(next.evidence.instructions.length > 0, `${kind} must name real dispatches`);
      assert.ok(next.evidence.recordsHex.length > 0, `${kind} must return new records`);
      if (kind === 'depart') assert.equal(next.host.currentMilli, next.host.initialMilli, 'departure keeps the Spend entry troops until settlement');
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
      if (kind === 'resolve_arrival') {
        assert.ok(next.combat.engagements > 0);
        assert.ok(next.combat.arrivalSurvivorMilli > 0);
        assert.ok(next.combat.arrivalSurvivorMilli < next.host.initialMilli);
      }
      if (kind === 'dissolve_return') assert.equal(next.holding.reserveUnits, previous.holding.reserveUnits + next.returned.creditedUnits);
      seen[kind] = (seen[kind] ?? 0) + 1;
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

    const get = validateState(parseReplyLine(await bridge.exchange('get')));
    assert.equal(checkTransition(previous, { kind: 'get' }, get, initial), 'ok');
    const stale = validateState(parseReplyLine(await bridge.exchange('harvest 0')));
    assert.equal(stale.error, 'STALE_REVISION');
    assert.equal(checkTransition(get, { kind: 'harvest', rev: 0 }, stale, initial), 'refused');
    const resetCmd = { kind: 'reset', rev: stale.revision };
    const reset = validateState(parseReplyLine(await bridge.exchange(commandLine(resetCmd))));
    assert.equal(checkTransition(stale, resetCmd, reset, initial), 'ok');
    assert.equal(reset.phase, 'ready');
    return { revision: previous.revision, seen };
  } finally { bridge.close(); }
}

const MARCH = ['depart', 'settle_departure', 'post_reveal', 'resolve_arrival', 'settle_transit', 'dissolve_return'];

test('real host: village economy and march interleaved on one holding and one clock', async () => {
  const commands = ['harvest', 'build_farm', 'train', 'depart', 'train', 'settle_departure', 'harvest', 'post_reveal', 'harvest', 'resolve_arrival', 'settle_transit', 'train', 'dissolve_return', 'harvest'];
  const result = await exercise(commands);
  assert.equal(result.revision, commands.length);
});
test('real host: same fixed route without any economy command', async () => {
  const result = await exercise(MARCH);
  assert.equal(result.revision, MARCH.length);
});
test('real host: open a ring-129 province with the real handler, then quote into it; stale and duplicate change nothing', async () => {
  const bridge = await createChildBridge();
  try {
    const initial = validateState(parseReplyLine(await bridge.exchange('get')));
    assert.equal(initial.land.opened, 0);
    assert.equal(initial.land.provincesCreated, 3);
    assert.ok(initial.allowed.includes('open_province'));
    // before: the 32-step line leaves the two fixtures into unknown land
    const before = validateState(parseReplyLine(await bridge.exchange(`quote_route ${'2'.repeat(32)}`)));
    checkQuote(initial, before);
    const i = before.routeQuote.blockedStep;
    assert.equal(before.routeQuote.reason, 'UNKNOWN_PROVINCE');
    const target = before.routeQuote.steps[i];
    assert.equal(target.known, false);
    // open exactly that province (it is ring 129 next to the fixtures)
    const cmd = { kind: 'open_province', rev: 0, p: target.p, q: target.q };
    const opened = validateState(parseReplyLine(await bridge.exchange(commandLine(cmd))));
    assert.equal(opened.status, 'ok', `${opened.error} ${opened.refusalCode ?? ''}`);
    assert.equal(checkTransition(initial, cmd, opened, initial), 'ok');
    assert.equal(opened.land.opened, 1);
    const prov = opened.map.provinces.find(p => p.p === target.p && p.q === target.q);
    assert.equal(prov.source, 'opened');
    assert.equal(prov.openedBell, opened.clock.bell);
    assert.deepEqual(opened.evidence.instructions, ['WideOpenProvince']);
    // a replayed line is stale; the same coordinate at the current revision is a duplicate; neither mutates
    const stale = validateState(parseReplyLine(await bridge.exchange(commandLine(cmd))));
    assert.equal(stale.error, 'STALE_REVISION');
    assert.equal(checkTransition(opened, cmd, stale, initial), 'refused');
    const dupCmd = { ...cmd, rev: 1 };
    const dup = validateState(parseReplyLine(await bridge.exchange(commandLine(dupCmd))));
    assert.equal(dup.error, 'LAND_DUPLICATE_OPEN');
    assert.equal(checkTransition(opened, dupCmd, dup, initial), 'refused');
    // after: the same path's blocked step now lies on the opened province's returned bytes
    const after = validateState(parseReplyLine(await bridge.exchange(`quote_route ${'2'.repeat(32)}`)));
    checkQuote(opened, after);
    assert.equal(after.routeQuote.steps[i].known, true);
    assert.notEqual(after.routeQuote.steps[i].passable, null);
    assert.ok(after.routeQuote.blockedStep === null || after.routeQuote.blockedStep > i || after.routeQuote.reason === 'IMPASSABLE');
    // the economy and the fixed march still run on the same session
    const harvest = validateState(parseReplyLine(await bridge.exchange('harvest 1')));
    assert.equal(checkTransition(opened, { kind: 'harvest', rev: 1 }, harvest, initial), 'ok');
    const depart = validateState(parseReplyLine(await bridge.exchange('depart 2')));
    assert.equal(checkTransition(harvest, { kind: 'depart', rev: 2 }, depart, initial), 'ok');
    // reset restores the installed baseline (no opened land), revision still moving forward
    const resetCmd = { kind: 'reset', rev: 3 };
    const reset = validateState(parseReplyLine(await bridge.exchange(commandLine(resetCmd))));
    assert.equal(checkTransition(depart, resetCmd, reset, initial), 'ok');
    assert.equal(reset.land.opened, 0);
  } finally { bridge.close(); }
});
test('real host: a route quote validates a chosen path over the really-opened provinces and never mutates', async () => {
  const bridge = await createChildBridge();
  try {
    const initial = validateState(parseReplyLine(await bridge.exchange('get')));
    // the recorded march's own path (3 steps, direction 2) reaches the opened destination (129,-1)
    const reach = validateState(parseReplyLine(await bridge.exchange('quote_route 222')));
    assert.equal(checkQuote(initial, reach), reach.routeQuote);
    const q = reach.routeQuote;
    assert.equal(q.reachable, true);
    assert.deepEqual(q.end, { p: '129', q: '-1', tile: 34 });
    assert.ok(q.steps.every(s => s.known && s.passable === true));
    assert.ok(q.provincesEntered.some(p => p.p === '129' && p.q === '-1'));
    // The same direction for the longest accepted path (32 steps): a straight line must leave two radius-4
    // provinces well before that (8 steps were observed to stay on returned land), so the host refuses it at the
    // first step into a province it did not return. Unknown land is never open ground.
    const far = validateState(parseReplyLine(await bridge.exchange(`quote_route ${'2'.repeat(32)}`)));
    checkQuote(initial, far);
    const fq = far.routeQuote;
    const firstUnknown = fq.steps.findIndex(s => !s.known);
    assert.equal(fq.reachable, false);
    assert.equal(fq.end, null);
    assert.equal(fq.reason, 'UNKNOWN_PROVINCE');
    assert.ok(firstUnknown > 0, 'the walk starts on returned land and later leaves it');
    assert.equal(fq.blockedStep, firstUnknown);
    assert.ok(fq.steps.slice(0, firstUnknown).every(s => s.known));
    assert.equal(fq.steps[firstUnknown].passable, null);
    // a malformed quote line is refused by the host itself (the browser never sends one); its reply is a
    // generic reject (command "invalid"), parsed raw because the model's command enum does not list it
    const bad = JSON.parse(await bridge.exchange('quote_route 6'));
    assert.equal(bad.status, 'refused');
    assert.equal(bad.error, 'BAD_COMMAND');
    assert.equal(bad.command, 'invalid');
    assert.equal(bad.routeQuote, null);
    const after = validateState(parseReplyLine(await bridge.exchange('get')));
    assert.equal(after.revision, 0);
    assert.equal(checkTransition(initial, { kind: 'get' }, after, initial), 'ok');
    // and a mutation at revision 0 still works after all the reads
    const depart = validateState(parseReplyLine(await bridge.exchange('depart 0')));
    assert.equal(depart.status, 'ok');
  } finally { bridge.close(); }
});
