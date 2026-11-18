// The Engine's stage (the landmark over the Concord's centre): 0 is the ring of markers with the bell's tower inside
// it, 1..5 are the raised Engine (art: specials/engine_N). Pure: no page, no canvas.
//
// In production the stage is always 0: no rule raises it yet (⑭ central tower, step T3, waits on the owner's
// decisions Q7/Q9). The only way to another stage is the art preview, `?art=1&engine=N` (presentation only).
// Held by permutation-gateway/test/web-frontier-engine-stage.test.mjs.

/** The highest stage the art has (specials/engine_0 .. engine_5). */
export const ENGINE_STAGE_MAX = 5;

/** Any value as a stage: a whole number in 0..ENGINE_STAGE_MAX (what is not a number is 0). */
export const clampEngineStage = v => Math.max(0, Math.min(ENGINE_STAGE_MAX, Number(v) | 0));

/**
 * The stage the page shows, from its query string (a string or URLSearchParams): 0 unless the art preview is on
 * (`art=1` exactly); in the preview, `engine=N` clamped to the art's range.
 */
export function resolveEngineStage(search) {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(search ?? '');
  return q.get('art') === '1' ? clampEngineStage(q.get('engine') ?? 0) : 0;
}

/**
 * What stands over the Concord's centre at a stage: the art's sprite name, whether it stands upright (stage 0 is a
 * ring of markers lying on the ground), and whether the bell's tower stands inside it (until the Engine is raised).
 */
export function engineLandmark(stage) {
  const n = clampEngineStage(stage);
  return { stage: n, sprite: `engine_${n}`, raised: n > 0, tower: n === 0 };
}
