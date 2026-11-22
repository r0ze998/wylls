// The keeper link's public routes (contract §8.3, I-24):
//
//   POST /f/reveal {holding, transit_slot, plain_b64, salt_b64, ct_hash_b64}  → the keeper's POST /v1/reveal, answer passed through
//   POST /f/nudge  {province: [P, Q], bell}                                    → the keeper's POST /v1/nudge
//
// A self-reveal is material, not a transaction: nobody's account is named
// in advance, and the keeper's random reveal payer sends it. Besides the
// per-address limit, reveals are limited per holding (a holding has at most
// four transits, each revealed once or twice).
//
// fix-gw-highs (audit H-1, H-2): both go through `ctx.keeperGuard`
// (keeper-guard.mjs): a global bucket per route over every client address,
// the same body answered from the last answer for a while, counters of
// every refusal. Keeper A judges the material and the bell itself before
// any chain read (keeper/src/api_guard.rs).
import { RouteError } from '../../routes/errors.mjs';
import { nudgeBody, revealBody } from '../keeperlink.mjs';

export const PER_HOLDING_REVEALS = Object.freeze({ burst: 8, perSecond: 0.2 });

export const keeperRoutes = {
  'POST /f/reveal': async (ctx, req) => {
    if (!ctx.keeper) throw new RouteError(503, 'no keeper is linked to this relay', 'KeeperUnavailable');
    const body = shape(ctx, 'reveal', revealBody, await req.json());
    try {
      ctx.limiter.check(`f-reveal:${body.holding}`, PER_HOLDING_REVEALS, 'reveals for this holding');
    } catch (e) { ctx.keeperGuard?.count('reveal_limited_holding', true); throw e; }
    const r = ctx.keeperGuard ? await ctx.keeperGuard.run('POST /f/reveal', body, () => ctx.keeper.reveal(body)) : await ctx.keeper.reveal(body);
    return { status: r.status, body: r.body };
  },

  'POST /f/nudge': async (ctx, req) => {
    if (!ctx.keeper) throw new RouteError(503, 'no keeper is linked to this relay', 'KeeperUnavailable');
    const body = shape(ctx, 'nudge', nudgeBody, await req.json());
    const r = ctx.keeperGuard ? await ctx.keeperGuard.run('POST /f/nudge', body, () => ctx.keeper.nudge(body)) : await ctx.keeper.nudge(body);
    return { status: r.status, body: r.body };
  },
};

/** `check(raw)`, counting a refused shape. */
function shape(ctx, name, check, raw) {
  try { return check(raw); } catch (e) { ctx.keeperGuard?.count(`${name}_refused_shape`, true); throw e; }
}
