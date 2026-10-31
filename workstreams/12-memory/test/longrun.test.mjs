// Workstream 12, continuing world: state that keeps growing (many partitions, years of world bells) stays usable.
// Separate from the boundary tests (continuity.test.mjs): passing one boundary is not the same as running long.
// Measurements for a larger run are written by tools/longrun.mjs (results/longrun.json); here, correctness plus a
// loose time guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordError, fact, allocation } from '../src/records.mjs';
import { A, LIMITS, PLACE_A, REQUEST, newMemory, cv, dm, signedAllocation, world } from '../fixtures/scenario.mjs';
import { growWorld } from '../fixtures/longrun-world.mjs';

test('long run: 300 partitions of history stay whole; nothing is evicted or reset', () => {
  const { m } = growWorld(300);
  const ids = m.journal.records().map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ids stay unique across partitions');
  const k = m.knowledge(A, 300 * 200);
  const rel = k.reliability.B;
  assert.equal(k.commitments.length, 300);
  assert.equal(rel.verified.fulfilled, 270);
  assert.equal(rel.verified.not_sent, 30);
  assert.equal(rel.evidence.length, 300, 'every partition\'s evidence is still listed');
  // the oldest evidence has faded by the decay rule (0.5^(59,800/432), shown rounded to 1e-6), not been deleted
  assert.equal(rel.evidence[0].weight, 0);
  assert.ok(rel.evidence[0].sources.length >= 4, 'it still names the records it rests on');
  assert.equal(k.commitments.reduce((s, c) => s + c.delivered_min, 0), 270 * 100);
  assert.deepEqual(k.unusable, []);
});

test('long run: reputation is bounded and converges instead of growing with the length of history', () => {
  const at = n => growWorld(n).m.knowledge(A, n * 200).reliability.B;
  const e150 = at(150), e300 = at(300);
  assert.ok(e300.E > 0 && e300.E < 1);
  assert.ok(Math.abs(e300.E - e150.E) < 1e-3, `${e150.E} vs ${e300.E}`);
  assert.ok(Math.abs(e300.r - e150.r) < 1e-3, 'the weighted evidence mass stays bounded');
});

test('long run: the journal replays to the same state after a restart, and a fold stays fast', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm12long-'));
  const path = join(dir, 'journal.jsonl');
  const { m, partitions } = growWorld(300, { path });
  const t0 = performance.now();
  const again = newMemory({ path, partitions });
  const replayMs = performance.now() - t0;
  assert.equal(again.journal.sha256(), m.journal.sha256());
  const t1 = performance.now();
  const k = again.knowledge(A, 300 * 200);
  const foldMs = performance.now() - t1;
  assert.equal(k.reliability.B.evidence.length, 300);
  // loose guards (a regression to quadratic folding took ~1 s at this size; measured values: tools/longrun.mjs)
  assert.ok(foldMs < 1500, `fold ${foldMs} ms`);
  assert.ok(replayMs < 5000, `replay ${replayMs} ms`);
  assert.ok(statSync(path).size < 3_000_000);
});

test('long run: decisions keep their inputs; each adds a bounded record', async () => {
  const { m } = growWorld(60);
  const sizes = [];
  for (let i = 1; i <= 6; i++) {
    const r = await m.choosePartner({ viewer: A, bell: i * 2000 - 1, request: { ...REQUEST, need_by_bell: i * 2000 + 100 }, candidates: world({ B: { arrive_bell: i * 2000 + 20 }, C: { arrive_bell: i * 2000 + 22 }, D: { arrive_bell: i * 2000 + 30 } }), limits: LIMITS });
    sizes.push(JSON.stringify(m.journal.get(r.decision_id)).length);
  }
  assert.equal(m.journal.records().filter(r => r.type === 'decision').length, 6);
  // the input lists memory lines about the candidates, so it grows with what is retrieved; it is capped by the
  // decision input, not by history length: the 6th decision sees 10x the history of the 1st
  assert.ok(Math.max(...sizes) < 64_000, `${sizes}`);
});

test('limits: world bells, caravan seq and allocation nonces are range-checked', () => {
  const sent = (bell, seq = 1) => fact({ kind: 'caravan_sent', bell, source: { sig: `s${bell}-${seq}`, ix: 0 },
    data: { caravan: cv(seq), dst: PLACE_A, cargo: { wood: 1 } } });
  assert.ok(sent(2 ** 32 - 1)); // a u32 world bell (10-minute bells: about 81,000 years)
  assert.throws(() => sent(2 ** 32), RecordError);
  assert.ok(sent(1, 2 ** 32 - 1));
  assert.throws(() => sent(1, 2 ** 32), RecordError, 'seq is the program\'s u32');
  const base = { by: 'B', commitment: 'x', caravan: cv(1), bell: 1, visibility: dm('A', 'B') };
  assert.ok(allocation(signedAllocation({ ...base, nonce: Number.MAX_SAFE_INTEGER })));
  assert.throws(() => allocation(signedAllocation({ ...base, nonce: Number.MAX_SAFE_INTEGER + 1 })), RecordError);
});
