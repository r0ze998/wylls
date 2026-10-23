// Counts, for one agent, the actions the MODEL chose and the relay sent, and asks the chain about each one:
// finalized without error, failed on chain, or not found. The E2E's own report keeps the first model decision
// only; this reads every `decision` line of the agent's ledger (STATUS-2026-10-23.ja.md §3.2 asked for
// "confirmed individually", not inferred from "sent").
//
//   node permutation-gateway/scripts/agent-finalized-count.mjs --rpc http://127.0.0.1:41410 \
//     --state frontier-node/.local/frontier/<run>/relay/agent-wallet.json [--agent <agentId>]
//   node permutation-gateway/scripts/agent-finalized-count.mjs --rpc ... --url http://127.0.0.1:41440 --agent <agentId>
//
// --state reads the relay's ledger file (every line the ledger keeps, up to 500); --url reads the public view
// (its last 50 lines). Read-only: nothing is signed or sent. Prints JSON.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const rpcUrl = arg('rpc');
assert.ok(rpcUrl, '--rpc is required');

async function rpc(method, params) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

let agents;
if (arg('state')) {
  const db = JSON.parse(readFileSync(arg('state'), 'utf8'));
  agents = Object.values(db.agents ?? {}).filter(a => !arg('agent') || a.agentId === arg('agent')).map(a => ({ agentId: a.agentId, history: a.history ?? [], source: 'state file' }));
} else {
  assert.ok(arg('url') && arg('agent'), '--state, or --url with --agent');
  const v = await (await fetch(`${arg('url').replace(/\/$/, '')}/gw/f/agent?id=${encodeURIComponent(arg('agent'))}`)).json();
  agents = [{ agentId: v.agentId, history: v.history ?? [], source: 'public view (last 50 lines)' }];
}

const out = [];
for (const a of agents) {
  const decisions = a.history.filter(h => h.type === 'decision');
  const byModelSent = decisions.filter(h => h.driver === 'model' && h.outcome === 'sent' && h.signature);
  const sigs = byModelSent.map(h => h.signature);
  const statuses = [];
  for (let i = 0; i < sigs.length; i += 100) statuses.push(...((await rpc('getSignatureStatuses', [sigs.slice(i, i + 100), { searchTransactionHistory: true }]))?.value ?? []));
  const each = byModelSent.map((h, i) => {
    const st = statuses[i] ?? null;
    const fate = !st ? 'not-found' : st.err ? 'failed-on-chain' : st.confirmationStatus === 'finalized' ? 'finalized' : st.confirmationStatus ?? 'processed';
    return { action: h.action, signature: h.signature, at: h.at, fate, reason: h.reason ?? null };
  });
  const count = k => each.filter(e => e.fate === k).length;
  out.push({
    agentId: a.agentId, source: a.source,
    decisions: decisions.length,
    byDriver: { model: decisions.filter(h => h.driver === 'model').length, autopilot: decisions.filter(h => h.driver === 'autopilot').length },
    modelOutcomes: Object.fromEntries(['sent', 'refused', 'failed', 'rest'].map(o => [o, decisions.filter(h => h.driver === 'model' && h.outcome === o).length])),
    autopilotStandingIn: decisions.filter(h => h.driver === 'autopilot' && h.cause).length,
    modelSentChecked: each.length, finalized: count('finalized'), failedOnChain: count('failed-on-chain'), notFound: count('not-found'),
    notYetFinal: each.length - count('finalized') - count('failed-on-chain') - count('not-found'),
    each,
  });
}
console.log(JSON.stringify(out, null, 2));
