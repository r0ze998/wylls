// The game page's entry in the walletless demo bundle (build.mjs bundles this file with esbuild as
// frontier/app.bundle.mjs and every game page loads it in place of app.mjs). It runs the real app.mjs unchanged.
// A bundle has its own copy of every module, so a test that imports "fstate.mjs" by URL would get a second, idle
// copy: the bundle's own instances are listed on __wyllsDemo.modules for the smoke (and any verifier) instead.
import * as fstate from '../../../permutation-server/web/frontier/fstate.mjs';
import * as fmap from '../../../permutation-server/web/frontier/map/fmap.mjs';
import * as fgeo from '../../../permutation-server/web/frontier/fgeo.mjs';
import * as map from '../../../permutation-server/web/map.mjs';
import '../../../permutation-server/web/frontier/app.mjs';

if (globalThis.__wyllsDemo?.modules) Object.assign(globalThis.__wyllsDemo.modules, { 'fstate.mjs': fstate, 'map/fmap.mjs': fmap, 'fgeo.mjs': fgeo, '../map.mjs': map });

// the demo's bandit camps: a tent and its defenders over every standing camp (camphud.mjs, demo-npc-camps)
import { startCampHud } from './camphud.mjs';
if (globalThis.document) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => startCampHud(), { once: true });
  else startCampHud();
}
