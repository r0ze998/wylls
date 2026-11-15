import { ExpeditionPrepareError, EXPEDITION_PREPARE_ROUTE } from '../expedition-prepare.mjs';

export const expeditionPrepareRoutes = Object.freeze({
  [EXPEDITION_PREPARE_ROUTE]: async (ctx, req) => {
    try {
      if (!ctx.expeditionPrepare) throw new ExpeditionPrepareError('ExpeditionPrepareDisabled');
      const report = await ctx.expeditionPrepare.prepare(await req.json(), { signal: req.signal });
      return { body: report };
    } catch (error) {
      if (error?.code === 'RequestAborted') error = new ExpeditionPrepareError('ExpeditionPrepareAborted');
      if (error?.code === 'RequestTimeout') error = new ExpeditionPrepareError('ExpeditionPrepareTimeout');
      if (['BodyTooLarge', 'InvalidJson'].includes(error?.code)) return { status: error.code === 'BodyTooLarge' ? 413 : 400,
        body: { error: error.code === 'BodyTooLarge' ? 'request body too large' : 'invalid JSON object', code: error.code } };
      const safe = error instanceof ExpeditionPrepareError ? error : new ExpeditionPrepareError('ExpeditionPrepareUnavailable');
      return { status: safe.status, body: { error: safe.message, code: safe.code } };
    }
  },
});
