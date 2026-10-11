// Compare the paused chain on both sides of `frontier-stack down` / `resume --start-paused`.
// Usage: node permutation-gateway/scripts/conquest-persistence-check.mjs snapshot|compare RPC_URL REPORT_PATH
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const [mode, url, file] = process.argv.slice(2);
assert.ok(['snapshot', 'compare'].includes(mode));
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
async function rpc(method) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });
  const j = await r.json(); assert.ok(!j.error, JSON.stringify(j.error)); return j.result;
}
const status = await rpc('frontier_status');
assert.equal(status.paused, true, 'pause the chain before measuring persisted state');
const hash = await rpc('frontier_stateHash');
const current = { runId: status.runId, slot: status.slot, unixTimestamp: status.unixTimestamp, scale: status.scale, transactions: status.transactions, stateHash: hash.stateHash };
if (mode === 'snapshot') {
  await rpc('frontier_snapshot');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ before: current }, null, 2) + '\n');
} else {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(current, report.before, 'run identity, all account state, clock and transaction history must survive restart exactly');
  report.after = current; report.identical = true;
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
}
console.log(mode, JSON.stringify(current));
