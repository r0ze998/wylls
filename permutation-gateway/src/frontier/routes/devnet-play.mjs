// Devnet gap P1: the page's wallet-paid devnet play routes (devnet-play-act.mjs). Served only when the gateway runs
// with `--devnet-play` (ctx.devnetPlay); otherwise 404, as before. The gateway signs and pays nothing on them.
import { RouteError } from '../../routes/errors.mjs';
import { LocalActError } from '../local-play-act.mjs';
import { LocalMarchError } from '../local-play-march.mjs';
import { DEVNET_ACT_ROUTES, DEVNET_MARCH_ROUTES, DEVNET_EXPEDITION_ROUTES } from '../devnet-play-act.mjs';

const run = step => async (ctx, request) => {
  if (!ctx.devnetPlay) throw new RouteError(404, 'not found', 'NotFound');
  try { return { status: 200, body: await ctx.devnetPlay[step](await request.json()) }; } catch (e) {
    if (e instanceof LocalActError || e instanceof LocalMarchError) throw new RouteError(e.status, e.message, e.code, e.detail !== undefined ? { detail: e.detail } : {});
    throw e;
  }
};
export const devnetPlayRoutes = Object.freeze({
  [DEVNET_ACT_ROUTES.context]: run('context'),
  [DEVNET_ACT_ROUTES.submit]: run('submit'),
  [DEVNET_ACT_ROUTES.status]: run('status'),
  // (devnet-page-war: the page's sealed Depart, wallet-paid; the rest of the war is keeper A's)
  [DEVNET_MARCH_ROUTES.submit]: run('marchSubmit'),
  [DEVNET_MARCH_ROUTES.status]: run('marchStatus'),
  // (devnet-p15-p9, P15: the page's boundary departure, wallet-paid; the rest of the expedition is keeper A's)
  [DEVNET_EXPEDITION_ROUTES.submit]: run('expeditionSubmit'),
  [DEVNET_EXPEDITION_ROUTES.status]: run('expeditionStatus'),
});
export const DEVNET_PLAY_PUBLIC_ROUTES = Object.freeze([...Object.values(DEVNET_ACT_ROUTES), ...Object.values(DEVNET_MARCH_ROUTES), ...Object.values(DEVNET_EXPEDITION_ROUTES)]);
/** Per client address (the same bursts as the relay's own sends and reads). */
export const DEVNET_PLAY_IP_LIMITS = Object.freeze({
  [DEVNET_ACT_ROUTES.context]: { burst: 40, perSecond: 3 },
  [DEVNET_ACT_ROUTES.submit]: { burst: 40, perSecond: 2 },
  [DEVNET_ACT_ROUTES.status]: { burst: 40, perSecond: 4 },
  [DEVNET_MARCH_ROUTES.submit]: { burst: 10, perSecond: 0.5 },
  [DEVNET_MARCH_ROUTES.status]: { burst: 40, perSecond: 4 },
  [DEVNET_EXPEDITION_ROUTES.submit]: { burst: 10, perSecond: 0.5 },
  [DEVNET_EXPEDITION_ROUTES.status]: { burst: 40, perSecond: 4 },
});
