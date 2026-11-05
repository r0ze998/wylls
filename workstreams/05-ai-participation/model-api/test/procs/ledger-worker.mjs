// A child process for test/multiprocess.test.mjs: one autopilot process's view of the shared cost ledger and lease.
// argv: <mode> <dir> <agentId> [...]. Prints one JSON line per event. No network, no key, no model.
import { FileCostLedger } from '../../src/cost-store.mjs';
import { ProcessLease } from '../../src/process-lease.mjs';
import { sleepSync } from '../../src/file-mutex.mjs';

const [mode, dir, agentId, ...rest] = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify({ pid: process.pid, ...o }) + '\n');

if (mode === 'race') {
  // Reserve `count` calls of `amount` as fast as possible, settling each in full.
  const [prefix, count, amount] = [rest[0], Number(rest[1]), rest[2]];
  const ledger = new FileCostLedger({ dir });
  let ok = 0, refused = 0;
  for (let i = 0; i < count; i++) {
    const key = `${prefix}-${i}#0`;
    try { ledger.reserve(key, amount); ledger.calling(key); ledger.settle(key, amount, 'measured'); ok++; } catch (e) { refused++; if (!['CategoryTotalLimit', 'InsufficientBalance'].includes(e.code)) out({ error: e.code ?? e.message }); }
  }
  out({ ok, refused });
} else if (mode === 'lease') {
  // Try to take the agent's lease and hold it for `holdMs`.
  const lease = new ProcessLease({ dir, agentId, ttlMs: Number(rest[0] ?? 30_000) });
  try { const l = lease.acquire(); out({ acquired: true, epoch: l.epoch }); sleepSync(Number(rest[1] ?? 300)); lease.release(); } catch (e) { out({ acquired: false, code: e.code }); }
} else if (mode === 'crash') {
  // Take the lease, reserve one call (not yet sent) and start another (calling), then die without cleaning up.
  const lease = new ProcessLease({ dir, agentId, ttlMs: Number(rest[0]) });
  lease.acquire();
  const ledger = new FileCostLedger({ dir, lease });
  ledger.reserve('crash-reserved#0', '100');
  ledger.reserve('crash-calling#0', '100');
  ledger.calling('crash-calling#0');
  out({ ready: true, leaseId: lease.leaseId });
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'zombie') {
  // Take the lease, then hang (no heartbeat) longer than its TTL; then try to reserve.
  const ttl = Number(rest[0]);
  const lease = new ProcessLease({ dir, agentId, ttlMs: ttl });
  lease.acquire();
  const ledger = new FileCostLedger({ dir, lease });
  out({ ready: true });
  sleepSync(Number(rest[1]));
  try { ledger.reserve('zombie#0', '100'); out({ reserved: true }); } catch (e) { out({ reserved: false, code: e.code }); }
  try { lease.renew(); out({ renewed: true }); } catch (e) { out({ renewed: false, code: e.code }); }
}
