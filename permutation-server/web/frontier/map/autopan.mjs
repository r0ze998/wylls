// "When a clash of mine is resolved, move the map there and show it" (the
// settings of the More drawer, app.mjs `data-act="autopan"`, FS.ui.autoPan;
// Civ VII's "pan to combat").
//
// The preference is off by default (fui.mjs). On a conquest season the
// viewer's own battles are what the season is played for — the march on a
// keep, the fight with its defenders — and with the option off such a battle
// plays where it stands, small when the view is far. So on a conquest season
// the option is ON unless the player has switched it off.
//
// The stored preferences are written whole whenever any one of them is saved
// (fui.mjs saveUi), so a stored "off" does not say that the player chose it.
// The default is therefore GIVEN ONCE for a season on a device: a mark beside
// the season's preferences says it has been given, the option is saved as on,
// and from then on it is the player's own to switch (the same checkbox, the
// same stored field): switched off, it stays off.
//
// Called once a frame by the keeps' feed (map/keepmount.mjs), which runs only
// on a conquest season; after the first look it costs one comparison.
import { uiKey, uiStorage, saveUi } from '../fui.mjs';
import { scope as chainScope } from '../fchainio.mjs';
import { invalidate } from '../fstate.mjs';

/** The mark's key beside the season's preferences: the conquest default of the option has been given on this device. */
export const AUTOPAN_GIVEN = ':autopan-given';

let settled = null;   // the preferences' key the default is settled for

/**
 * Give the option its conquest default once. `fs.ui` must have been loaded (it is replaced by the saved preferences
 * when the default is given). Returns 'given' (switched on now), 'kept' (already given earlier, or on already: the
 * stored value stands) or null (nothing to do yet, or settled before).
 */
export function autoPanDefault(fs, { storage = uiStorage, scope = chainScope, redraw = () => invalidate('panel') } = {}) {
  if (!fs?.ui) return null;
  let sc = null;
  try { sc = scope(); } catch { sc = null; }
  if (!sc) return null;
  const key = uiKey(sc);
  if (settled === key) return null;
  settled = key;
  if (storage.get(key + AUTOPAN_GIVEN) === '1') return 'kept';
  storage.set(key + AUTOPAN_GIVEN, '1');
  if (fs.ui.autoPan === true) return 'kept';
  fs.ui = saveUi(storage, key, { autoPan: true });
  redraw();
  return 'given';
}

/** (tests) Forget which season the default is settled for. */
export const autoPanReset = () => { settled = null; };
