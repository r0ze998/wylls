// The effects layer's one entry for the page (UX-DESIGN §8). app.mjs calls
//
//   startFx({ map, canvas, effects: () => FS.ui?.effects });
//
// once the map exists. It registers the vocabulary (effects.mjs), lays the
// top canvas and the #fx-hud layer over the map (engine.mjs: both are made
// by script, the HTML pages carry nothing), links fx.css, arms the sound for
// the first user gesture (audio.mjs) and, only when the address carries
// `?fx=`, starts the demo switch (demo.mjs, loaded on demand so normal play
// never even fetches it). Without a DOM (node tests) it only registers the
// vocabulary.
import { fx, paintGround } from './engine.mjs';
import { installEffects } from './effects.mjs';
import { installStage } from './stage.mjs';
import { audio } from './audio.mjs';
import { setMotionSource } from './motion.mjs';

export { fx } from './engine.mjs';
export { emit, on } from './bus.mjs';
export { motion } from './motion.mjs';
export { fxNow } from './clock.mjs';

let installed = false;

/** Start the effects layer on a page. Returns the engine. */
export function startFx({ map = null, canvas = null, effects = null, search = globalThis.location?.search ?? '', stage = null } = {}) {
  if (effects) setMotionSource(effects);
  if (!installed) { installEffects(fx); installStage(fx); installed = true; }
  const doc = canvas?.ownerDocument ?? null;
  if (!doc?.createElement || !doc.head) return fx;
  if (!doc.getElementById('fx-css')) {
    const link = doc.createElement('link');
    link.id = 'fx-css'; link.rel = 'stylesheet'; link.href = new URL('./fx.css', import.meta.url).href;
    doc.head.append(link);
  }
  // the map's own seams (map/fmap.mjs): the picture on screen is `map.shown` (it travels toward the logical view);
  // an animation frame is `map.tick()` (the still layers of a resting view are kept); the ground pass is the
  // map's `between` hook, called after the ground and the viewer's own ground marks and before what stands on the land
  const tileArt = () => (map?.drawnLod ?? map?.lod) === 'tile' && !!map?.art;
  // Under the tabletop tilt (map/tilt.mjs) the top canvas lies in `#map-stage`, exactly over the map's ground canvas,
  // and shares its transform: it draws through the ground canvas's own flat view and size (larger than the map's box).
  // HUD effects are placed in the map's box (`stage`) through `map.project`.
  const tilted = !!map?.stage && map.ground && map.ground !== canvas;
  fx.mount({ map, canvas: tilted ? map.ground : canvas, stage: stage ?? (tilted ? canvas : null), ...(map ? { camera: () => (tilted ? map.groundView() : map.shown ?? map.view), invalidate: () => (map.tick ? map.tick() : map.invalidate?.()), groundInPainter: tileArt } : {}),
    ...(tilted ? { size: () => map.groundSize(), toViewport: (x, y) => map.project(x, y) } : {}) });
  if (map) map.between = (ctx, { zoom }) => paintGround(ctx, { zoom, tiles: map.art?.tiles ?? null });
  audio().install(doc);
  const q = new URLSearchParams(search);
  if (q.has('fx')) import('./demo.mjs').then(m => m.startDemo({ fx, map, params: q, doc })).catch(e => globalThis.console?.warn?.('fx demo:', e));
  return fx;
}
