// Devnet gap P1: the page's wallet-paid devnet play routes (devnet-play-act.mjs). Served only when the gateway runs
// with `--devnet-play` (ctx.devnetPlay); otherwise 404, as before. The gateway signs and pays nothing on them.
import { RouteError } from '../../routes/errors.mjs';
import { LocalActError } from '../local-play-act.mjs';
import { DEVNET_ACT_ROUTES } from '../devnet-play-act.mjs';

const run = step => async (ctx, request) => {
  if (!ctx.devnetPlay) throw new RouteError(404, 'not found', 'NotFound');
  try { return { status: 200, body: await ctx.devnetPlay[step](await request.json()) }; } catch (e) {
    if (e instanceof LocalActError) throw new RouteError(e.status, e.message, e.code, e.detail !== undefined ? { detail: e.detail } : {});
    throw e;
  }
};
export const devnetPlayRoutes = Object.freeze({
  [DEVNET_ACT_ROUTES.context]: run('context'),
  [DEVNET_ACT_ROUTES.submit]: run('submit'),
  [DEVNET_ACT_ROUTES.status]: run('status'),
});
export const DEVNET_PLAY_PUBLIC_ROUTES = Object.freeze(Object.values(DEVNET_ACT_ROUTES));
/** Per client address (the same bursts as the relay's own sends and reads). */
export const DEVNET_PLAY_IP_LIMITS = Object.freeze({
  [DEVNET_ACT_ROUTES.context]: { burst: 40, perSecond: 3 },
  [DEVNET_ACT_ROUTES.submit]: { burst: 40, perSecond: 2 },
  [DEVNET_ACT_ROUTES.status]: { burst: 40, perSecond: 4 },
});
