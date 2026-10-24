// The agent wallet's routes (docs/agent-wallet/DESIGN.md §3, §5): the HTTP
// face of AgentGateway. Local test USDC only; nothing here has value.
//
//   GET  /f/agent/terms                      prices, mint, custody account, sources
//   GET  /f/agent?id=                        the agent's public view (keys are public, balances, policy, history)
//   GET  /f/agent/session-terms?id=          what the owner puts in SetSession (the agent's key)
//   POST /f/agent/command {command, signature}
//        an owner command signed by the owner's wallet (owner-auth.mjs):
//          op create             params {village: [p, q, site], policy}        → {agent, capability (shown once), sessionTerms}
//          op policy             params {policy}                              → {agent}
//          op mode               params {mode: 'manual'|'auto'}               → {agent}
//          op withdraw           params {amount} | {all: true}                → {withdrawal, agent}
//          op action             params {idempotencyKey?, policyVersion, modeEpoch?, action}  → ActionResult (source 'browser')
//          op rotate-capability                                              → {agent, capability}
//   GET  /f/agent/by-owner?owner=            the owner's agents, briefly
//   POST /f/agent/deposit {agentId, signature}   credits a confirmed owner-signed deposit to the custody account
//   POST /f/agent/deposit {agentId, tx, lastValidBlockHeight?}
//                                            a sponsored deposit: the owner signed, a pool key (GET /f/relay) pays the fee;
//                                            the relay co-signs, simulates, sends, waits and credits (the browser's path)
//   POST /f/agent/action  {capability, request}  an ActionRequest with the agent's capability token (source 'ai' or 'mcp')
//                                                → ActionResult (always 200: `ok`, `status`, `error.code` say what happened)
//   POST /f/agent/reconcile                      operator only: settle sent holds and withdrawals by the chain's answer
//   GET  /f/agent/unresolved                     operator only: model calls whose outcome was unknown, and the operator's cost record
//   POST /f/agent/settle {agentId, holdId, outcome: charge|refund, note?, by?, evidence?}   operator only: decide one unresolved call (audited:
//        `by` in the record is the credential — the operator token's fingerprint and the caller's address; the body's `by` is kept as `claimedBy`)
//
// Nothing here is MCP-specific: an MCP server calls POST /f/agent/action
// (or AgentGateway.submit in process) like any other caller. The owner's
// wallet signature is the only thing that creates, funds, re-scopes, stops
// or drains an agent; a capability token can only ask for actions inside
// the policy, and the relay refuses an agent key that bypasses this.
import { AgentError, ERR, SOURCES } from '../agent/contract.mjs';
import { OWNER_OPS, verifyCommand } from '../agent/owner-auth.mjs';
import { parseWire } from '../../cosign.mjs';
import { RouteError } from '../../routes/errors.mjs';
import { operatorPrincipal, requireFrontierOperator } from './operator.mjs';

function agents(ctx) {
  if (!ctx.agents) throw new AgentError(ERR.DISABLED, 'the agent wallet is not enabled on this relay (--agent-wallet)', 404);
  return ctx.agents;
}

const idOf = req => {
  const id = req.url.searchParams.get('id');
  if (!id || id.length > 64) throw new RouteError(400, 'id (the agent id) is required', 'BadRequest');
  return id;
};

const str = (v, what, max = 128) => {
  if (typeof v !== 'string' || !v || v.length > max) throw new RouteError(400, `${what} is required`, 'BadRequest');
  return v;
};

export const agentRoutes = {
  'GET /f/agent/terms': async ctx => ({ body: agents(ctx).terms() }),

  'GET /f/agent': async (ctx, req) => {
    const g = agents(ctx);
    const id = idOf(req);
    const view = g.view(id);
    // The chain's word on the delegation (a stop here does not revoke it; the owner's SetSession does).
    let delegation = null;
    try { delegation = await g.delegation(id); } catch { delegation = null; }
    // The owner's and the agent's shared allowance of sponsored transactions today.
    let quota = null;
    try { quota = await g.quota(id); } catch { quota = null; }
    return { body: { ...view, delegation, quota } };
  },

  'GET /f/agent/session-terms': async (ctx, req) => ({ body: agents(ctx).sessionTerms(idOf(req)) }),

  'GET /f/agent/by-owner': async (ctx, req) => {
    const owner = req.url.searchParams.get('owner');
    if (!owner || owner.length > 64) throw new RouteError(400, 'owner (a wallet address) is required', 'BadRequest');
    return { body: { owner, agents: agents(ctx).byOwner(owner) } };
  },

  'POST /f/agent/command': async (ctx, req) => {
    const g = agents(ctx);
    const b = await req.json();
    const op = b.command?.op;
    if (!OWNER_OPS.includes(op)) throw new RouteError(400, `command.op must be one of ${OWNER_OPS.join(', ')}`, 'BadRequest');
    const command = verifyCommand({ command: b.command, signature: b.signature }, { op, nonces: g.ledger.db.ownerNonces, now: ctx.now() });
    const p = command.params ?? {};
    const owner = command.owner;
    const agentId = op === 'create' ? null : str(command.agentId, 'command.agentId', 64);
    switch (op) {
      case 'create': {
        const { agent, capability } = g.createAgent({ owner, village: p.village, policy: p.policy });
        return { body: { ok: true, agent, capability, sessionTerms: g.sessionTerms(agent.agentId) } };
      }
      case 'policy': return { body: { ok: true, agent: g.setPolicy(agentId, owner, p.policy) } };
      case 'mode': return { body: { ok: true, agent: g.setMode(agentId, owner, p.mode) } };
      case 'withdraw': return { body: { ok: true, ...(await g.withdraw(agentId, owner, { amount: p.amount, all: p.all === true })) } };
      case 'rotate-capability': return { body: { ok: true, ...g.rotateCapability(agentId, owner) } };
      case 'action': {
        const result = await g.submit({ agentId, source: 'browser', idempotencyKey: p.idempotencyKey ?? command.nonce, policyVersion: p.policyVersion, modeEpoch: p.modeEpoch, action: p.action }, { owner });
        return { body: result };
      }
      default: throw new RouteError(400, 'unknown op', 'BadRequest');
    }
  },

  'POST /f/agent/deposit': async (ctx, req) => {
    const g = agents(ctx);
    const b = await req.json();
    const agentId = str(b.agentId, 'agentId', 64);
    ctx.limiter.check(`f-agent-deposit:${agentId}`, { burst: 10, perSecond: 0.5 }, 'deposit checks for this agent');
    if (b.tx !== undefined) {
      const { wire, tx } = parseWire(b.tx);
      return { body: { ok: true, ...(await g.sponsorDeposit(agentId, { tx, wire, lastValidBlockHeight: b.lastValidBlockHeight })) } };
    }
    return { body: { ok: true, ...(await g.deposit(agentId, str(b.signature, 'signature'))) } };
  },

  'POST /f/agent/action': async (ctx, req) => {
    const g = agents(ctx);
    const b = await req.json();
    const r = b.request;
    if (!r || typeof r !== 'object') throw new RouteError(400, 'request (an ActionRequest) is required', 'BadRequest');
    const source = r.source ?? 'mcp';
    if (!SOURCES.includes(source) || source === 'browser') throw new RouteError(400, 'request.source must be ai or mcp (browser requests are owner commands)', 'BadRequest');
    if (typeof r.agentId === 'string') ctx.limiter.check(`f-agent-action:${r.agentId}`, { burst: 30, perSecond: 1 }, 'actions for this agent');
    return { body: await g.submit({ ...r, source }, { capability: b.capability }) };
  },

  'POST /f/agent/reconcile': async (ctx, req) => {
    requireFrontierOperator(ctx, req);
    return { body: { ok: true, ...(await agents(ctx).reconcile()) } };
  },

  'GET /f/agent/unresolved': async (ctx, req) => {
    requireFrontierOperator(ctx, req);
    return { body: agents(ctx).unresolved() };
  },

  'POST /f/agent/settle': async (ctx, req) => {
    const who = operatorPrincipal(ctx, req);
    const b = await req.json();
    return { body: { ok: true, ...agents(ctx).settleUnresolved(str(b.agentId, 'agentId', 64), str(b.holdId, 'holdId', 64), b.outcome, b.note ?? '', { by: who, claimedBy: b.by ?? null, evidence: b.evidence ?? '' }) } };
  },
};
