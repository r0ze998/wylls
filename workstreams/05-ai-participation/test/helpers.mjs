// Shared set-up for the participation tests and the demo.
import { RunJournal } from '../src/adapters.mjs';
import { participate, verifyPending } from '../src/participate.mjs';
import { ruleDecider } from '../src/deciders.mjs';
import { NATION, createLocalWorld } from '../src/local-world.mjs';

/** The owner's mandate for the northern operation (目的と上限). Overrides are shallow, limits deep. */
export function mandateFor(w, over = {}) {
  const view = w.relay.gateway.view(w.agentId);
  const base = {
    mandateId: 'north-op', version: 1, agentId: w.agentId, basedOnPolicyVersion: view.policy.version,
    purpose: '北方拠点の共同作戦に、自分の村の蓄えの範囲で守りの兵を出して協力する', nation: NATION, from: ['Aster-officer'],
    allowed: ['Train', 'Harvest'], partial: true,
    limits: { perRequest: { Food: 120, Ore: 40, Gold: 20 }, perDay: { Food: 300, Ore: 100, Gold: 50 }, troopsPerRequest: 200 },
    expiresAt: w.state.clock + 8 * 3_600, revokedAt: null,
  };
  return { ...base, ...over, limits: { ...base.limits, ...(over.limits ?? {}), perRequest: { ...base.limits.perRequest, ...(over.limits?.perRequest ?? {}) }, perDay: { ...base.limits.perDay, ...(over.limits?.perDay ?? {}) } } };
}

export async function world(o = {}) { return createLocalWorld(o); }

/** One participation run in world `w` (a fresh MCP server unless one is given). */
export function run(w, { mandate = mandateFor(w), decider = ruleDecider(), journal = new RunJournal({ now: () => w.state.clock * 1000 }), runId = 'run-1', mcp = w.mcp(), meter = w.meter, ...rest } = {}) {
  return participate({ mcp, world: w.publicWorld, txState: w.txState, meter, mandate, decider, journal, runId, ...rest }).then(report => ({ report, journal }));
}

/** The chain and the world answer; then the agent checks what became of its sends. */
export async function settleAndVerify(w, journal) {
  w.settle();
  return verifyPending({ journal, txState: w.txState, world: w.publicWorld });
}

export const item = (report, requestId) => report.items.find(i => i.requestId === requestId);
