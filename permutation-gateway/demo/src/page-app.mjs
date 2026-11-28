// The game page's entry in the walletless demo bundle (build.mjs bundles this file with esbuild as
// frontier/app.bundle.mjs and every game page loads it in place of app.mjs). It runs the real app.mjs unchanged.
// A bundle has its own copy of every module, so a test that imports "fstate.mjs" by URL would get a second, idle
// copy: the bundle's own instances are listed on __wyllsDemo.modules for the smoke (and any verifier) instead.
import * as fstate from '../../../permutation-server/web/frontier/fstate.mjs';
import * as fmap from '../../../permutation-server/web/frontier/map/fmap.mjs';
import * as fgeo from '../../../permutation-server/web/frontier/fgeo.mjs';
import * as map from '../../../permutation-server/web/map.mjs';
import '../../../permutation-server/web/frontier/app.mjs';
import { startGoalHud } from './goalhud.mjs';
import { startTravelHud } from './travelhud.mjs';

if (globalThis.__wyllsDemo?.modules) Object.assign(globalThis.__wyllsDemo.modules, { 'fstate.mjs': fstate, 'map/fmap.mjs': fmap, 'fgeo.mjs': fgeo, '../map.mjs': map });

// the demo's single-player goal (its card, the castle flags on the map and the result screen: goalhud.mjs) and its
// travelers (their markers on the map, the list and the talk / trade panel: travelhud.mjs)
if (globalThis.document) {
  const start = () => { startGoalHud(); startTravelHud(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
