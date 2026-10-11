// Pictures for choices (UX design section 6: the order's stance and retreat
// choices as clear pictorial options). Small authored SVG drawings, used
// inline: the viewer's own side is solid, the other side an outline, an
// arrow is the move. Presentation attributes only (the CSP allows no style
// attribute); colours come from the page through classes of frontier.css
// (.pic-own, .pic-foe, .pic-move).
import { raw } from '../../util.mjs';

const svg = (w, h, body) => raw(`<svg class="pic" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">${body}</svg>`);
const OWN = 'class="pic-own"', FOE = 'class="pic-foe" fill="none" stroke-width="2"', MOVE = 'class="pic-move" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"';

/** The four stances: hold the ground under the banner, charge straight, go round the side, brace behind shields. */
export const STANCE_PIC = Object.freeze({
  Hold: () => svg(56, 36, `<path ${FOE} d="M43 9h7v18h-7z"/><rect ${OWN} x="9" y="16" width="16" height="12" rx="2"/><path ${MOVE} stroke-width="2" d="M17 16V5"/><path ${OWN} d="M17 5l9 3-9 3z"/>`),
  Assault: () => svg(56, 36, `<path ${FOE} d="M43 9h7v18h-7z"/><path ${OWN} d="M5 11l11 7-11 7z"/><path ${MOVE} d="M18 18h19M31 12l7 6-7 6"/>`),
  Flank: () => svg(56, 36, `<path ${FOE} d="M40 17h7v14h-7z"/><rect ${OWN} x="5" y="20" width="12" height="10" rx="2"/><path ${MOVE} d="M12 17C14 6 38 3 43 11M36 9l7 3 2-7"/>`),
  Brace: () => svg(56, 36, `<path ${OWN} d="M8 8c5 0 8 2 8 2v9c0 5-4 8-8 9zM8 8v20c-1 0-2-.4-2-.4V8.5z"/><path ${OWN} d="M19 8c5 0 8 2 8 2v9c0 5-4 8-8 9z" opacity=".75"/><path ${MOVE} stroke-width="2" d="M27 13h9M27 18h11M27 23h9"/><path ${FOE} stroke-linecap="round" stroke-dasharray="3 4" d="M52 18h-9"/><path ${FOE} stroke-linecap="round" stroke-linejoin="round" d="M47 13l-5 5 5 5"/>`),
});

/**
 * The retreat choices: the viewer's host (solid) beside the defenders
 * (outline) at the size from which the host turns back; "never" has no
 * such size — a banner that stays.
 */
export const RETREAT_PIC = Object.freeze({
  never: () => svg(34, 30, `<rect ${OWN} x="5" y="16" width="9" height="12" rx="1.5"/><path ${MOVE} stroke-width="2" d="M22 28V5"/><path ${OWN} d="M22 5l9 3.5-9 3.5z"/>`),
  x2: () => svg(34, 30, `<rect ${OWN} x="5" y="16" width="9" height="12" rx="1.5"/><rect ${FOE} x="19" y="4" width="10" height="24" rx="1.5"/>`),
  'x1.5': () => svg(34, 30, `<rect ${OWN} x="5" y="16" width="9" height="12" rx="1.5"/><rect ${FOE} x="19" y="10" width="10" height="18" rx="1.5"/>`),
  x1: () => svg(34, 30, `<rect ${OWN} x="5" y="16" width="9" height="12" rx="1.5"/><rect ${FOE} x="19" y="16" width="10" height="12" rx="1.5"/>`),
  'x0.5': () => svg(34, 30, `<rect ${OWN} x="5" y="16" width="9" height="12" rx="1.5"/><rect ${FOE} x="19" y="22" width="10" height="6" rx="1.5"/>`),
});

/** The seal of a sealed order: wax with the bell pressed in it. */
export const sealPic = (size = 44) => raw(`<svg class="pic-seal" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path class="seal-wax" d="M24 3c4 0 5 3 8 4s6-1 8 2 0 6 2 9 4 4 3 8-4 4-5 7 1 6-2 8-6 0-9 2-4 4-8 3-4-4-7-5-6 1-8-2 0-6-2-9-4-4-3-8 4-4 5-7-1-6 2-8 6 0 9-2 4-4 8-3c2 .3 3 1 7 1Z"/><circle class="seal-ring" cx="24" cy="24" r="12.5" fill="none" stroke-width="1.6"/><path class="seal-mark" d="M24 16.5c-3 0-4.4 2.6-4.4 5.4l-.4 3.9-1.7 2h13l-1.7-2-.4-3.9c0-2.8-1.4-5.4-4.4-5.4Zm-2.2 12.3c0 1.6 4.4 1.6 4.4 0Z"/></svg>`);
