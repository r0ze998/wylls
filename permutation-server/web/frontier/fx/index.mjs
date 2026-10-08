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
import { fx } from './engine.mjs';
import { installEffects } from './effects.mjs';
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
  if (!installed) { installEffects(fx); installed = true; }
  const doc = canvas?.ownerDocument ?? null;
  if (!doc?.createElement || !doc.head) return fx;
  if (!doc.getElementById('fx-css')) {
    const link = doc.createElement('link');
    link.id = 'fx-css'; link.rel = 'stylesheet'; link.href = new URL('./fx.css', import.meta.url).href;
    doc.head.append(link);
  }
  fx.mount({ map, canvas, stage });
  audio().install(doc);
  const q = new URLSearchParams(search);
  if (q.has('fx')) import('./demo.mjs').then(m => m.startDemo({ fx, map, params: q, doc })).catch(e => globalThis.console?.warn?.('fx demo:', e));
  return fx;
}
