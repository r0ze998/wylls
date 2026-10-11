// The label of the banner rule's PROTOTYPE (PROTOTYPE-SPEC.md section 1): a
// fixed chip that is on screen for as long as the board shows anything of the
// prototype. Its words are the record's own (`sample.proto.claims.label` of
// the season record) and nothing else's.
//
// The chip beside the turn dial is the page's (the HUD). This file is the
// board's own guarantee that the label is never missing while the map draws
// banner land: when the map is given a model and the page shows no element
// with `data-proto-chip` (one that is not hidden), the map mounts this chip under the top-left tools
// (`#hud-tl`, beside the sample world's tag); when the page shows its own,
// this one stands down. It also links the prototype's stylesheet
// (proto-board.css), the way the effects layer links its own.
import { lang, onLangChange } from '../../lang.mjs';

const ID = 'proto-chip-map', CSS_ID = 'proto-board-css';
let last = null, bound = false;

/** The label's text in the page's language (the record carries both). */
export const protoLabelText = label => (label ? String((lang() === 'en' ? label.en : label.ja) ?? label.ja ?? label.en ?? '') : '');

/** Show, update or remove the map's own chip for `label` (`{ja, en}` or null: the prototype is off). Returns the element, or null. */
export function syncProtoChip(canvas, label) {
  const doc = canvas?.ownerDocument ?? null;
  if (!doc?.createElement || !doc.getElementById) return null;
  last = { canvas, label };
  if (!bound) { bound = true; onLangChange(() => { if (last) syncProtoChip(last.canvas, last.label); }); }
  let el = doc.getElementById(ID);
  const theirs = doc.querySelector?.(`[data-proto-chip]:not([hidden]):not(#${ID})`) ?? null, text = protoLabelText(label);
  if (!text || theirs) { el?.remove(); if (doc.body?.dataset) delete doc.body.dataset.protoBoard; return null; }
  if (doc.head && !doc.getElementById(CSS_ID)) {
    const link = doc.createElement('link');
    link.id = CSS_ID; link.rel = 'stylesheet'; link.href = new URL('../proto-board.css', import.meta.url).href;
    doc.head.append(link);
  }
  if (!el) {
    el = doc.createElement('p');
    el.id = ID; el.className = 'proto-chip proto-chip-map'; el.setAttribute('role', 'note');
    const host = doc.getElementById('hud-tl'), before = doc.getElementById('objective');
    if (host) host.insertBefore(el, before?.parentNode === host ? before : null);
    else (canvas.parentElement ?? doc.body)?.append(el);
  }
  if (el.textContent !== text) el.textContent = text;
  if (doc.body?.dataset) doc.body.dataset.protoBoard = 'on';
  return el;
}
