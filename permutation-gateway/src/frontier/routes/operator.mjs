// Operator routes (operator listener only, bearer token; contract §8.3):
//
//   POST /f/operator/invites {count}   one-time invites for a gated season (I-51) → {invites: [...]}
//   GET  /f/operator/pool              the relay pool's balances → {size, total, floor, eligible, payers: [{key, lamports}]}
import { createHash, timingSafeEqual } from 'node:crypto';
import { RouteError } from '../../routes/errors.mjs';

const digest = s => createHash('sha256').update(String(s)).digest();

export function requireFrontierOperator(ctx, req) {
  const auth = req.headers?.authorization ?? '';
  const ok = req.surface === 'operator' && !!ctx.cfg.operatorToken && timingSafeEqual(digest(auth), digest(`Bearer ${ctx.cfg.operatorToken}`));
  if (!ok) throw new RouteError(403, 'operator only', 'OperatorOnly');
}

/**
 * Who the operator credential identifies, for an audit line: the listener,
 * the token (its fingerprint: the first 8 hex of its SHA-256, never the token)
 * and the caller's address. The relay has one operator token, so this names
 * the token, not a person; a caller's own label is a claim, kept apart.
 */
export function operatorPrincipal(ctx, req) {
  requireFrontierOperator(ctx, req);
  return { via: 'operator-token', token: digest(ctx.cfg.operatorToken).toString('hex').slice(0, 8), ip: req.ip ?? null };
}

export const operatorRoutes = {
  'POST /f/operator/invites': async (ctx, req) => {
    requireFrontierOperator(ctx, req);
    if (!ctx.invites) throw new RouteError(503, 'this relay has no invite secret', 'InvitesUnavailable');
    const b = await req.json();
    const n = b.count ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RouteError(400, 'count: 1–1,000', 'BadRequest');
    return { body: { invites: ctx.invites.issue(n) } };
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
