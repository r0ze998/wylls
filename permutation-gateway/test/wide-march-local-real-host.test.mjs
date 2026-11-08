// Explicit real-host integration. Never starts a server, builds code, signs, or contacts a chain.
// Run only after the fixed local_march_demo binary has been audited and built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChildBridge } from '../screens/wide-march-local/host-bridge.mjs';
import { commandLine, parseReplyLine, validateState, checkTransition } from '../screens/wide-march-local/local-model.mjs';

async function exercise(train) {
  const bridge = await createChildBridge();
  try {
    const initial = validateState(parseReplyLine(await bridge.exchange('get')));
    assert.equal(initial.revision, 0);
    assert.equal(initial.phase, 'ready');
    let previous = initial;
    const commands = ['depart', ...(train ? ['train'] : []), 'settle_departure', 'post_reveal', 'resolve_arrival', 'settle_transit', 'dissolve_return'];
    for (const kind of commands) {
      const command = { kind, rev: previous.revision };
      const next = validateState(parseReplyLine(await bridge.exchange(commandLine(command))));
      assert.equal(next.status, 'ok', `${kind}: ${next.error ?? 'unknown refusal'}`);
      assert.equal(checkTransition(previous, command, next, initial), 'ok');
      assert.ok(next.evidence.instructions.length > 0, `${kind} must name real dispatches`);
      assert.ok(next.evidence.recordsHex.length > 0, `${kind} must return new records`);
      if (kind === 'depart') {
        assert.equal(next.host.currentMilli, next.host.initialMilli, 'departure keeps the Spend entry troops until settlement');
      }
      if (kind === 'train') {
        assert.equal(next.holding.reserveUnits, previous.holding.reserveUnits + 10);
        assert.equal(next.holding.escrowLamports, previous.holding.escrowLamports);
        assert.equal(next.host.currentMilli, previous.host.currentMilli);
      }
      if (kind === 'resolve_arrival') {
        assert.ok(next.combat.engagements > 0);
        assert.ok(next.combat.arrivalSurvivorMilli > 0);
        assert.ok(next.combat.arrivalSurvivorMilli < next.host.initialMilli);
      }
      previous = next;
    }
    assert.equal(previous.phase, 'returned');
    assert.equal(previous.trained, train);
    assert.equal(previous.host.transitState, 'closed');
    assert.equal(previous.holding.openTransits, 0);
    assert.equal(previous.holding.escrowLamports, '0');
    assert.ok(previous.combat.engagements > 0, 'later resolves retain the arrival combat count');
    assert.ok(previous.returned.creditedUnits > 0);
    assert.ok(previous.returned.creditedMilli < previous.host.initialMilli);
    assert.equal(previous.returned.creditedMilli, previous.returned.creditedUnits * 1000);
    assert.equal(previous.holding.reserveUnits, initial.holding.reserveUnits + (train ? 10 : 0) + previous.returned.creditedUnits);

    const get = validateState(parseReplyLine(await bridge.exchange('get')));
    assert.equal(checkTransition(previous, { kind: 'get' }, get, initial), 'ok');
    const stale = validateState(parseReplyLine(await bridge.exchange('depart 0')));
    assert.equal(checkTransition(get, { kind: 'depart', rev: 0 }, stale, initial), 'refused');
    const resetCmd = { kind: 'reset', rev: stale.revision };
    const reset = validateState(parseReplyLine(await bridge.exchange(commandLine(resetCmd))));
    assert.equal(checkTransition(stale, resetCmd, reset, initial), 'ok');
    assert.equal(reset.phase, 'ready');
    return { revision: previous.revision, reserve: previous.holding.reserveUnits, credited: previous.returned.creditedUnits, engagements: previous.combat.engagements };
  } finally { bridge.close(); }
}

test('real march host: train during transit, combat, survivor return and strict reset', async () => {
  const result = await exercise(true);
  assert.equal(result.revision, 7);
});
test('real march host: same fixed route without optional train', async () => {
  const result = await exercise(false);
  assert.equal(result.revision, 6);
});
