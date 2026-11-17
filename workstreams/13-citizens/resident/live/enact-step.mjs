// Enacting a respond proposal from the live step's own result (2026-11-17): the explicit entry that joins step.mjs's
// proposal to enact.mjs enactRespond with the SAME observation the proposal was made from. Not the one-step entry:
// once.mjs and the step stay non-enacting and never call this.
//
// Why: enactRespond takes `observed` as its own argument. A caller that observed again for it would give a snapshot the
// proposal was not made from (another Season, other requests, another clock). Here nothing is observed: the step's
// `context` (step.mjs: a deep frozen copy of the observation it used, with the proposal it belongs to) is what is passed.
//
// Held, nothing done, when any of this is not so:
//   - a step result that is not stopped, with a proposal not enacted and a context made for it (same candidate, kind,
//     request and offer); a respond only (a send is enact.mjs enactSend: unsupported);
//   - the context's wallet, world (program, Season, network, world id) and Season-bell clock all given (unknown is
//     never filled in, and nothing is read to fill it);
//   - the board the requests came from known, and the board given here that same one;
//   - an explicit signer for the context's wallet (the authority: its owner supplies it; no key is read or made).
// Then enactRespond does the rest unchanged: the resident's stop read before any new operation and again after the
// signature (stop-A: only earlier results read back), the board's world checked before the one POST, a failed save
// reported as unknown and never posted again, one call per journal in a process (none excluded across processes).
import { enactRespond } from './enact.mjs';
import { CONTEXT_KIND } from './step.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const held = (why, extra = {}) => ({ ok: false, held: true, why, ...extra });
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const baseOf = u => { try { const x = new URL(u); if (!['http:', 'https:'].includes(x.protocol) || x.username || x.password) return null; return x.href.replace(/\/+$/, ''); } catch { return null; } };

/** The checks above, nothing read or written. → {context} | {why} */
export function stepRespondProblem(step, { boardUrl, signer } = {}) {
  if (!isObj(step)) return { why: 'no step result' };
  if (step.stopped) return { why: 'the step was stopped: there is no proposal to enact (stop-A)' };
  const p = step.proposal, ctx = step.context;
  if (!isObj(p) || p.enacted !== false) return { why: 'no unenacted proposal in this step result' };
  if (p.held) return { why: 'the proposal is held' };
  if (p.candidate?.kind !== 'respond') return { why: 'not a respond proposal (a send is not supported)' };
  if (!isObj(ctx) || ctx.kind !== CONTEXT_KIND || !Object.isFrozen(ctx)) return { why: `no observation context for this proposal${ctx?.unavailable ? ` (${ctx.unavailable})` : ''}` };
  const f = ctx.forProposal;
  if (!isObj(f) || f.candidate !== p.candidate.id || f.kind !== p.candidate.kind || f.request !== p.candidate.request || !same(f.offer, p.candidate.offer)) return { why: 'the context was made for another proposal' };
  if (typeof ctx.wallet !== 'string' || !ctx.wallet) return { why: 'the context names no wallet' };
  if (!isObj(ctx.world) || typeof ctx.world.world_id !== 'string' || !isObj(ctx.season) || !isObj(ctx.clock)) return { why: 'the context has no world, Season or clock (not filled in)' };
  if (typeof ctx.requestsFrom !== 'string' || !ctx.requestsFrom) return { why: 'the context does not say which board its requests came from' };
  const board = baseOf(boardUrl);
  if (!board || board !== ctx.requestsFrom) return { why: 'the board given is not the one the requests were read from' };
  if (!signer || typeof signer.signMessage !== 'function' || signer.address !== ctx.wallet) return { why: "no signer for the context's wallet (its owner supplies it)" };
  return { context: ctx };
}

/**
 * `step`: one result of step.mjs liveStep / factory.mjs step() with a respond proposal; `dir`: the resident's
 * directory; `signer` ({address, signMessage}); `nation` (0..5, declared); `boardUrl` (the board the step read);
 * `fetchImpl`; `nowSecs()` the record's time (explicit). → enactRespond's result, or held with why.
 */
export async function enactStepRespond({ step, dir, signer, nation, boardUrl, fetchImpl, nowSecs } = {}) {
  const c = stepRespondProblem(step, { boardUrl, signer });
  if (!c.context) return held(`not enacted: ${c.why}`);
  return enactRespond({ dir, wallet: c.context.wallet, proposal: step.proposal, observed: c.context, nation, signer, boardUrl: c.context.requestsFrom, fetchImpl, nowSecs });
}
