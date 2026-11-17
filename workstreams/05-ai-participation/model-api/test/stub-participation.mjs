// A stub world for one participate() run with ONE open request that the guard accepts (Train unit 0 × 10).
// No relay, no chain, no key, nothing signed: agent_view and agent_act answer from these objects.
export function stubParticipation({ onAct, clock = () => 1_000_000, deadlineSec = 2_000_000, agentId = 'agent1' }) {
  const view = { agentId, owner: 'o1', mode: 'auto', modeEpoch: 3, policy: { version: 2, allowed: ['Train'] }, village: [1, 2, 3], delegation: { delegated: true }, historySeq: 1 };
  const acts = [];
  const mcp = { async handle(req) {
    const { name, arguments: a } = req.params;
    if (name === 'agent_view') return { result: { isError: false, structuredContent: view } };
    if (name === 'agent_act') { acts.push(a); const r = onAct(a); return { result: { isError: !r.ok, structuredContent: r } }; }
    return { result: { isError: true, structuredContent: { ok: false, error: { code: 'NoSuchTool' } } } };
  } };
  const big = 1e6;
  const world = { clockSec: clock, village: () => ({ stores: { Food: big, Wood: big, Stone: big, Ore: big, Gold: big }, reserve_troops: {} }),
    requests: () => [{ id: 'R-1', nation: 1, author: 'n1', title: 'troops', deadlineSec, ask: { kind: 'train', unit: 0, n: 10 } }] };
  const lim = { Food: 1e5, Wood: 1e5, Stone: 1e5, Ore: 1e5, Gold: 1e5 };
  const mandate = { mandateId: 'm1', version: 1, agentId, basedOnPolicyVersion: 2, allowed: ['Train'], expiresAt: deadlineSec, limits: { perRequest: lim, perDay: { ...lim }, troopsPerRequest: 100 } };
  const decider = { name: 'stub', free: true, async plan() { return { proposals: [{ requestId: 'R-1', command: { name: 'Train', fields: { unit: 0, n: 10 } }, by: 'stub', reason: 'asked' }], notes: [] }; } };
  return { acts, args: { mcp, world, mandate, decider, txState: async () => ({ state: 'unknown' }) } };
}
