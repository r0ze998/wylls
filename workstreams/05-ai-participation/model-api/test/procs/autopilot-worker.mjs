// One autopilot PROCESS over MOCKS, for safety-e2e.test.mjs. argv: <dir> <mode> <ticks> [pid-is-dead]
//   relay: a file-backed stub of the agent wallet's agent_act idempotency (one execution per requestId; a repeat is
//          a replay) — MOCK, not the relay's code; the relay's own idempotency is its tests' and ④'s
//   model: fixtureTransport answering one Train proposal — MOCK, no model is called
//   registry: ⑤'s substitute (localActsPort) unless RUNEXEC_BIN and FOUR_ACTS_CLIENT name ④'s REAL one
//   ledger, lease, journal: ⑤'s own (files under <dir>), the same code as in use
// modes: normal | die-in-act (the relay executes, then this process is killed before it hears the answer)
//        | lose-act-response (the relay executes; every answer this process would hear is lost: RelayUnreachable)
//        | die-in-model (killed while the model call is in flight) | lose-model-response (sent, no answer)
//        | owner-stops-before-act (the owner switches the agent off between the model's answer and the act)
// No key is generated, derived or used; nothing is signed; no network.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunJournal } from '../../../src/adapters.mjs';
import { anthropicAdapter, fixtureTransport } from '../../src/adapters.mjs';
import { apiDecider } from '../../src/api-decider.mjs';
import { Autopilot } from '../../src/autopilot.mjs';
import { FileCostLedger } from '../../src/cost-store.mjs';
import { ProcessLease } from '../../src/process-lease.mjs';
import { withFileMutex, writeDurable } from '../../src/file-mutex.mjs';
import { DecisionRegistry } from '../../src/inference.mjs';
import { FIXTURE_BOOK } from '../../src/price-book.mjs';
import { FileActsRegistry } from '../../src/acts-registry.mjs';
import { loadFourActsPort, localActsPort } from '../../src/acts-port.mjs';
import { claude200 } from '../fixtures.mjs';

const [dir, mode, ticks, deadPid] = process.argv.slice(2);
const AGENT = 'agent-e2e', OWNER = 'owner-e2e', CLOCK = 1_000_000;
const relayFile = join(dir, 'relay.json');
const relay = fn => withFileMutex(join(dir, 'relay.mutex'), () => {
  const s = existsSync(relayFile) ? JSON.parse(readFileSync(relayFile, 'utf8')) : { executed: {}, executions: 0, mode: 'auto', modeEpoch: 3, lost: {} };
  const out = fn(s);
  writeDurable(relayFile, JSON.stringify(s));
  return out;
});
const view = () => relay(s => ({ agentId: AGENT, owner: OWNER, mode: s.mode, modeEpoch: s.modeEpoch, policy: { version: 2, allowed: ['Train'] }, village: [1, 2, 3], delegation: { delegated: true }, historySeq: s.executions }));
let decided = false;
const mcp = { tools: ['agent_view', 'agent_whoami', 'agent_act'], async handle(req) {
  const { name, arguments: a } = req.params;
  const ok = x => ({ result: { isError: !x.ok, structuredContent: x } });
  if (name === 'agent_view') {
    // The owner stops the agent right after the model answered (the act's freshness check reads this view).
    if (mode === 'owner-stops-before-act' && decided) relay(s => { if (s.mode === 'auto' && !s.stoppedOnce) { s.mode = 'manual'; s.modeEpoch += 1; s.stoppedOnce = true; } });
    return ok({ ok: true, ...view() });
  }
  if (name === 'agent_whoami') return ok({ ok: true, agentId: AGENT, owner: OWNER, capabilitySource: 'ai' });
  if (name === 'agent_act') {
    const r = relay(s => {
      // The gateway's order (submit: authenticate → idempotency → gate): a repeat replays even after a stop.
      if (s.executed[a.requestId]) return mode === 'lose-act-response' ? { lose: true } : { ...s.executed[a.requestId], replayed: true };
      if (s.mode !== 'auto' || a.modeEpoch !== s.modeEpoch) return { ok: false, status: 'refused', sent: false, error: { code: s.mode !== 'auto' ? 'AgentStopped' : 'StaleMode' }, charges: [] };
      s.executions += 1;
      const res = { ok: true, requestId: a.requestId, status: 'sent', sent: true, signature: `sig-${a.requestId}`, lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: s.executions, charges: [] };
      s.executed[a.requestId] = res;
      // lose-act-response: every answer this process would hear is lost (participate retries the same requestId twice).
      if (mode === 'lose-act-response') return { lose: true };
      return res;
    });
    if (mode === 'die-in-act' && !relay(s => s.lost.died)) { relay(s => { s.lost.died = true; }); process.kill(process.pid, 'SIGKILL'); }
    if (r.lose) return ok({ ok: false, error: { code: 'RelayUnreachable', message: 'the answer was lost' } });
    return ok(r);
  }
  return ok({ ok: false, error: { code: 'NoSuchTool' } });
} };
const answer = () => { decided = true; return claude200({ content: [{ type: 'text', text: '{"proposals":[{"request":"R-1","action":"Train","fields":{"unit":0,"n":10},"reason":"asked"}],"skipped":[]}' }] }); };
const transport = fixtureTransport(async () => {
  if (mode === 'die-in-model' && !relay(s => s.lost.model)) { relay(s => { s.lost.model = true; }); process.kill(process.pid, 'SIGKILL'); }
  if (mode === 'lose-model-response' && !relay(s => s.lost.modelAnswer)) { relay(s => { s.lost.modelAnswer = true; }); return { transportError: 'socket hang up', sent: true }; }
  return answer();
});
const lim = { Food: 1e5, Wood: 1e5, Stone: 1e5, Ore: 1e5, Gold: 1e5 };
const mandate = { mandateId: 'm1', version: 1, agentId: AGENT, basedOnPolicyVersion: 2, allowed: ['Train'], expiresAt: CLOCK + 10 * 86_400, limits: { perRequest: lim, perDay: { ...lim }, troopsPerRequest: 100 } };
const big = 1e6;
const publicWorld = { clockSec: () => CLOCK, village: () => ({ stores: { Food: big, Wood: big, Stone: big, Ore: big, Gold: big }, reserve_troops: {} }),
  requests: () => [{ id: 'R-1', nation: 1, author: 'n1', title: 'troops', deadlineSec: CLOCK + 5 * 86_400, ask: { kind: 'train', unit: 0, n: 10 } }] };
const isAlive = deadPid ? pid => pid !== Number(deadPid) && pid === process.pid : undefined;
const lease = new ProcessLease({ dir, agentId: AGENT, ttlMs: 30_000, ...(isAlive ? { isAlive } : {}) });
const costs = new FileCostLedger({ dir, lease, init: { available: '100000000', caps: { total: '50000000' } } });
const acts = process.env.RUNEXEC_BIN && process.env.FOUR_ACTS_CLIENT
  ? await loadFourActsPort({ clientPath: process.env.FOUR_ACTS_CLIENT, bin: process.env.RUNEXEC_BIN, db: join(dir, 'runs.db') })
  : localActsPort({ registry: new FileActsRegistry({ dir: join(dir, 'acts') }) });
let ap;
const decider = apiDecider({ adapter: anthropicAdapter, model: 'claude-fixture-model', transport, book: FIXTURE_BOOK(), costs, registry: new DecisionRegistry(), runId: () => ap.currentRun, sleep: async () => {} });
ap = new Autopilot({ world: { agentId: AGENT, publicWorld, txState: async () => ({ state: 'unknown' }) }, mcp: () => mcp, mandate, decider, journal: new RunJournal({ file: join(dir, 'journal.jsonl'), now: () => CLOCK * 1000 }), lease, acts, actSource: 'ai' });
const out = { pid: process.pid, mode, registry: acts.real ? 'real' : 'substitute' };
try {
  out.start = (await ap.start({ by: 'owner' })).state;
  // HOLD_MS: keep the lease a while before ticking, so that two processes started together really overlap.
  if (process.env.HOLD_MS) await new Promise(r => setTimeout(r, Number(process.env.HOLD_MS)));
  out.ticks = [];
  for (let i = 0; i < Number(ticks); i++) { const r = await ap.tick(); out.ticks.push({ status: r.status ?? r.state ?? null, skipped: r.skipped ?? false, game: (r.game ?? []).map(g => [g.outcome, g.code]) }); }
} catch (e) { out.error = e.code ?? e.message; }
out.relay = relay(s => ({ executions: s.executions, keys: Object.keys(s.executed).length }));
out.costs = { classes: costs.classes(), items: [...costs.items.values()].map(i => [i.key, i.state]) };
out.lease = lease.leaseId;
process.stdout.write(JSON.stringify(out) + '\n');
