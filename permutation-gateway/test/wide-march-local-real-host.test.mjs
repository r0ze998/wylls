// Explicit real-host integration. Never starts a server, builds code, signs, or contacts a chain.
// Run only after the fixed local_march_demo binary (protocol v2) has been audited and built.
// Assertions are relations between host replies, never hardcoded store or troop snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChildBridge } from '../screens/wide-march-local/host-bridge.mjs';
import { commandLine, parseReplyLine, validateState, checkTransition } from '../screens/wide-march-local/local-model.mjs';

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
