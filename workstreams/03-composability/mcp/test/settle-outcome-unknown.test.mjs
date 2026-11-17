// A settle record whose outcome the ABI does not define is held, never completed (Lane C, 2026-11-17). WRITTEN, NOT RUN.
// KEY-FREE: no imports beyond node:test / node:assert / node:fs. server.mjs, events.mjs and the ABI are read as TEXT, not
// imported (server.mjs's closure, and exercising its evidence loop, would need test/fixture.mjs, which generates keys).
// A text check: it pins the guard and its place, it does not run the evidence loop.
//   O1 the ABI and the program define exactly two outcomes: 0 DELIVERED, 1 LOST; events.mjs maps exactly those
//   O2 server.mjs: an outcome outside SETTLE_OUTCOME is held as Inconsistent (existing hold) and the loop continues,
//      before op.outcome is set and before any step to COMPLETED; the old `?? 'settled'` fallback is gone
//   O3 unchanged: 0/1 still set op.outcome from SETTLE_OUTCOME and step to COMPLETED; the burned-raid rule is kept;
//      the loop still stops at a terminal state (stored completed operations are not reread)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const server = read('../src/server.mjs');
const events = read('../src/events.mjs');
const abi = read('../../../../frontier-abi/src/v2/log.rs');

test('O1 two outcomes in the ABI, the same two in events.mjs', () => {
  const mod = abi.slice(abi.indexOf('pub mod caravan_outcome {'), abi.indexOf('}', abi.indexOf('pub mod caravan_outcome {')));
  assert.deepEqual([...mod.matchAll(/pub const (\w+): u8 = (\d+);/g)].map(m => [m[1], m[2]]), [['DELIVERED', '0'], ['LOST', '1']]);
  assert.ok(events.includes("export const SETTLE_OUTCOME = Object.freeze({ 0: 'delivered', 1: 'lost' });"));
});

test('O2 an undefined outcome is held as Inconsistent before anything is decided', () => {
  const at = server.indexOf('if (x.kind === KINDS.CARAVAN_SETTLED) {');
  assert.ok(at > 0);
  const block = server.slice(at, server.indexOf('step(op, STATES.COMPLETED', at));
  const guard = block.indexOf('if (!Object.hasOwn(SETTLE_OUTCOME, String(x.payload.outcome))) {');
  const held = block.indexOf("hold(op, 'Inconsistent', `the settle record's outcome");
  const cont = block.indexOf('continue;', held);
  const set = block.indexOf('op.outcome =');
  assert.ok(guard > 0 && held > guard && cont > held && set > cont, 'guard, hold and continue come before op.outcome is set');
  assert.ok(!server.includes("SETTLE_OUTCOME[x.payload.outcome] ?? 'settled'"), 'no generic "settled" fallback');
});

test('O3 unchanged: 0/1 complete as before; the loop stops at a terminal state', () => {
  assert.ok(server.includes('const o = SETTLE_OUTCOME[x.payload.outcome];'));
  assert.ok(server.includes("op.outcome = op.caravan.raid?.choice === 'burned' && o === 'delivered' ? 'burned' : o;"));
  assert.ok(server.includes("step(op, STATES.COMPLETED, op.outcome === 'delivered' ? 'the caravan arrived and was settled' : `the caravan was settled: ${op.outcome}`);"));
  assert.ok(server.includes('if (TERMINAL.includes(op.state)) break;'));
  assert.ok(server.includes("if (!op.caravan.mine || op.hold?.code === 'Inconsistent') continue;"), 'later settle/raid records do not decide a held operation');
});
