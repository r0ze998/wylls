// Pure HTTP adapter: public inspection only, no relay payer or signing path.
import { ExpeditionPreviewError, EXPEDITION_PREVIEW_ROUTE } from '../expedition-preview.mjs';

export const expeditionPreviewRoutes = Object.freeze({
  [EXPEDITION_PREVIEW_ROUTE]: async (ctx, req) => {
    try {
      if (!ctx.expeditionPreview) throw new ExpeditionPreviewError('ExpeditionPreviewDisabled');
      const input = await req.json();
      const report = await ctx.expeditionPreview.inspect(input, { signal: req.signal });
      return { body: report };
    } catch (error) {
      // Do not expose child stderr, executable/RPC paths, or arbitrary errors.
      if (error?.code === 'RequestAborted') error = new ExpeditionPreviewError('ExpeditionPreviewAborted');
      if (error?.code === 'RequestTimeout') error = new ExpeditionPreviewError('ExpeditionPreviewTimeout');
      if (['BodyTooLarge', 'InvalidJson'].includes(error?.code)) return { status: error.code === 'BodyTooLarge' ? 413 : 400,
        body: { error: error.code === 'BodyTooLarge' ? 'request body too large' : 'the request body is not a JSON object', code: error.code } };
      const safe = error instanceof ExpeditionPreviewError ? error : new ExpeditionPreviewError('ExpeditionPreviewUnavailable');
      return { status: safe.status, body: { error: safe.message, code: safe.code } };
    }
  },
});
