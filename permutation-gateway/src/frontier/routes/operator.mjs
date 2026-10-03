// Operator routes (operator listener only, bearer token; contract §8.3):
//
//   POST /f/operator/invites {count, label?}   one-time invites for a gated season (I-51) → {invites: [...]}
//                                      (`label`: a short tag for the event log, e.g. "bots" or "friends-1")
//   GET  /f/operator/pool              the relay pool's balances → {size, total, floor, eligible, payers: [{key, lamports}]}
import { createHash, timingSafeEqual } from 'node:crypto';
import { RouteError } from '../../routes/errors.mjs';

const digest = s => createHash('sha256').update(String(s)).digest();

export function requireFrontierOperator(ctx, req) {
  const auth = req.headers?.authorization ?? '';
  const ok = req.surface === 'operator' && !!ctx.cfg.operatorToken && timingSafeEqual(digest(auth), digest(`Bearer ${ctx.cfg.operatorToken}`));
  if (!ok) throw new RouteError(403, 'operator only', 'OperatorOnly');
}

export const operatorRoutes = {
  'POST /f/operator/invites': async (ctx, req) => {
    requireFrontierOperator(ctx, req);
    if (!ctx.invites) throw new RouteError(503, 'this relay has no invite secret', 'InvitesUnavailable');
    const b = await req.json();
    const n = b.count ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RouteError(400, 'count: 1–1,000', 'BadRequest');
    // PT-E: a call without a label is never mistaken for a friends batch (the metrics count only `friends-*`).
    const label = b.label ?? 'unlabelled-DO-NOT-COUNT';
    if (typeof label !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(label)) throw new RouteError(400, 'label: 1–40 letters, digits, . _ -', 'BadRequest');
    const invites = ctx.invites.issue(n);
    // The nonces (not the codes) go to the event log: they tie a later Join to the batch it was issued in.
    ctx.events.write('invites_issued', { label, count: n, nonces: invites.map(i => ctx.invites.verify(i)) });
    return { body: { invites } };
  },

  'GET /f/operator/pool': async (ctx, req) => {
    requireFrontierOperator(ctx, req);
    const total = await ctx.pool.refresh(ctx.connection);
    return {
      body: { size: ctx.pool.size, total: String(total), floor: String(ctx.pool.minLamports), eligible: ctx.pool.eligible().length,
        payers: ctx.pool.publicKeys().map((key, i) => ({ key, lamports: String(ctx.pool.balances[i] ?? 0) })) },
    };
  },
};
