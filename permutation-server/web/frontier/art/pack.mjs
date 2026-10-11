// The owner's handover art (Wylls-Claude-Handoff, 2026-10-10; art/README.md says what came from where): one
// switch for the four families it brings in.
//
//   soldiers   people/minis.mjs        art/units/mobs-v1/        the three-heads-tall figures, 8 kinds × 6 nations
//   icons      hud/icons.mjs           art/ui/illustrated/       8 resources and 5 states
//   effects    fx/sheetfx.mjs          art/vfx/first-v1/         select, depart, impact, hit, build_complete, capture
//   characters leader-motion-data.mjs  art/leaders3d/motion-v2/  idle, walk, attack, hit and the victory pose
//
// The pack is shown where the season runs the conquest program (fconquest.mjs conquestEnabled: layout 2, program
// version 3 or more). The basic game, the sample world and every test without a season draw exactly what they drew
// before: the earlier figures, the line glyphs, the first motion pack, the drawn effects.
//
// Two ways round the rule, both in the address and both for judging only:
//   ?art=off          the earlier art on a conquest season too (the way back if a sheet reads badly)
//   ?fx=…&art=on      the pack on any page, under the demo tag (`?fx=`) only
import { FS } from '../fstate.mjs';
import { conquestEnabled } from '../fconquest.mjs';

let forced = null;
const listeners = new Set();
let last = null;

const asked = (() => {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    const v = q.get('art');
    if (v === 'off') return false;
    if (v === 'on' && q.has('fx')) return true;
  } catch { /* no address (a test) */ }
  return null;
})();

/** Whether the handover art is shown now. */
export function artPackOn() {
  const on = forced ?? asked ?? conquestEnabled(FS.season);
  if (on !== last) { const first = last === null; last = on; if (!first) for (const fn of [...listeners]) { try { fn(on); } catch { /* a listener's own fault */ } } }
  return on;
}

/** Tests and the demo: `true` / `false` holds the pack on or off, `null` gives it back to the season. */
export function forceArtPack(v) { forced = v === null || v === undefined ? null : !!v; artPackOn(); }

/** Be told when the pack comes on or goes off (the season arrived): `fn(on)`. Returns the way to stop being told. */
export function onArtPack(fn) { if (typeof fn !== 'function') return () => {}; listeners.add(fn); return () => listeners.delete(fn); }

let linked = false;
/** The pack's stylesheet (art/art.css: the pictures' sizes, the cards' grounds), linked once by script the first time something of the pack is put on a page (a page without a document, a test, links nothing). */
export function linkArtCss() {
  if (linked) return;
  const doc = globalThis.document;
  if (!doc?.head?.append || !doc.createElement) return;
  linked = true;
  if (doc.getElementById?.('art-css')) return;
  const link = doc.createElement('link');
  link.id = 'art-css'; link.rel = 'stylesheet'; link.href = new URL('./art.css', import.meta.url).href;
  doc.head.append(link);
}
