import { ExpeditionDepartPrepareError, EXPEDITION_DEPART_PREPARE_ROUTE } from '../expedition-depart-prepare.mjs';

/** Unsigned original-host Depart preparation. Disabled unless its own adapter is configured. Never signs or sends. */
export const expeditionDepartPrepareRoutes = Object.freeze({
  [EXPEDITION_DEPART_PREPARE_ROUTE]: async (ctx, req) => {
    try {
      if (!ctx.expeditionDepartPrepare) throw new ExpeditionDepartPrepareError('ExpeditionDepartPrepareDisabled');
      const report = await ctx.expeditionDepartPrepare.prepare(await req.json(), { signal: req.signal });
      return { body: report };
    } catch (error) {
      if (error?.code === 'RequestAborted') error = new ExpeditionDepartPrepareError('ExpeditionDepartPrepareAborted');
      if (error?.code === 'RequestTimeout') error = new ExpeditionDepartPrepareError('ExpeditionDepartPrepareTimeout');
      if (['BodyTooLarge', 'InvalidJson'].includes(error?.code)) return { status: error.code === 'BodyTooLarge' ? 413 : 400,
        body: { error: error.code === 'BodyTooLarge' ? 'request body too large' : 'invalid JSON object', code: error.code } };
      const safe = error instanceof ExpeditionDepartPrepareError ? error : new ExpeditionDepartPrepareError('ExpeditionDepartPrepareUnavailable');
      return { status: safe.status, body: { error: safe.message, code: safe.code } };
    }
  },
});
