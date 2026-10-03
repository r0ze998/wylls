// The keeper link's public routes (contract §8.3, I-24):
//
//   POST /f/reveal {holding, transit_slot, plain_b64, salt_b64, ct_hash_b64}  → the keeper's POST /v1/reveal, answer passed through
//   POST /f/nudge  {province: [P, Q], bell}                                    → the keeper's POST /v1/nudge
//
// A self-reveal is material, not a transaction: nobody's account is named
// in advance, and the keeper's random reveal payer sends it. Besides the
// per-address limit, reveals are limited per holding (a holding has at most
// four transits, each revealed once or twice).
import { PublicKey } from '@solana/web3.js';
import { RouteError } from '../../routes/errors.mjs';
import { nudgeBody, revealBody } from '../keeperlink.mjs';

export const PER_HOLDING_REVEALS = Object.freeze({ burst: 8, perSecond: 0.2 });

/**
 * PT-E: a nudge asks the keeper to resolve a province through a bell, so it
 * must name a province that exists and a bell no later than the next one
 * (`bell ≤ now + 1`). A u32 bell on a real province would otherwise pin it
 * as nudged for good (a keeper transaction every bell) and a made-up
 * province would grow the keeper's nudge book. There is deliberately no
 * lower bound: the page sends the province's own `resolved_next`, which
 * lags the present by up to 24 bells for a quiet province (controller.mjs).
 */
export async function checkNudge(ctx, { province: [p, q], bell }) {
  const [season, clock] = [await ctx.chain.season(), await ctx.chain.clock()];
  const now = Math.floor((Number(clock.unixTimestamp) - Number(season.GENESIS_TS)) / Number(season.BELL_SECS));
  if (!Number.isFinite(now) || bell > now + 1) {
    throw new RouteError(400, `bell must not be later than the next one (now ${Number.isFinite(now) ? now : '?'})`, 'BadRequest');
  }
  const a = await ctx.connection.getAccountInfo(new PublicKey(ctx.addresses.province(p, q)), 'confirmed');
  if (!a) throw new RouteError(400, 'that province does not exist', 'BadRequest');
}

export const keeperRoutes = {
  'POST /f/reveal': async (ctx, req) => {
    if (!ctx.keeper) throw new RouteError(503, 'no keeper is linked to this relay', 'KeeperUnavailable');
    const body = revealBody(await req.json());
    ctx.limiter.check(`f-reveal:${body.holding}`, PER_HOLDING_REVEALS, 'reveals for this holding');
    const r = await ctx.keeper.reveal(body);
    return { status: r.status, body: r.body };
  },

  'POST /f/nudge': async (ctx, req) => {
    if (!ctx.keeper) throw new RouteError(503, 'no keeper is linked to this relay', 'KeeperUnavailable');
    const body = nudgeBody(await req.json());
    await checkNudge(ctx, body);
    const r = await ctx.keeper.nudge(body);
    return { status: r.status, body: r.body };
  },
};
