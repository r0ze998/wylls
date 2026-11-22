// The board page in the display language of the game page (Japanese, the source language, or English).
//
// The language is the game page's: the same saved choice ('ps-lang', else the browser's language), the
// same toggle and `<html lang>` (permutation-server/web/lang.mjs). This page's code writes Japanese only; here every
// text the page shows is put into English as it appears (text nodes, aria-label / title / placeholder, the document
// title, the focus label of the style sheet, and confirm() through `shown`), with the board's table (tr.mjs,
// lang/en.mjs). The Japanese of each text is remembered, so the toggle switches both ways in place, and nothing is
// read back from the page: records, signatures, requests and comparisons are made from the Japanese-writing code
// exactly as before. In Japanese nothing is touched.
import { lang, setLang, onLangChange, mountLangToggle, LANGS, STORAGE_KEY } from '../../../permutation-server/web/lang.mjs';
import { toEnglish, needsEnglish, missing } from './tr.mjs';

const doc = globalThis.document;
const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];
const texts = new WeakMap();   // text node → {ja, en}
const attrs = new WeakMap();   // element → {attribute: {ja, en}}
const skip = el => !el || el.nodeName === 'SCRIPT' || el.nodeName === 'STYLE' || !!el.closest?.('[data-lang-toggle]');

/** A text for confirm() and the like, in the display language (line by line). */
export const shown = text => (lang() === 'en' ? String(text).split('\n').map(toEnglish).join('\n') : text);

function textTo(node) {
  const now = node.nodeValue, st = texts.get(node);
  if (lang() === 'en') {
    if (st && st.en === now) return;   // what this module wrote
    if (!needsEnglish(now)) return;
    const en = toEnglish(now);
    texts.set(node, { ja: now, en });
    if (en !== now) node.nodeValue = en;
  } else if (st && st.en === now && st.ja !== now) node.nodeValue = st.ja;
}
function attrsTo(el) {
  let st = attrs.get(el);
  for (const a of ATTRS) {
    const now = el.getAttribute(a);
    if (now === null) continue;
    const s = st?.[a];
    if (lang() === 'en') {
      if ((s && s.en === now) || !needsEnglish(now)) continue;
      const en = toEnglish(now);
      if (!st) attrs.set(el, st = {});
      st[a] = { ja: now, en };
      if (en !== now) el.setAttribute(a, en);
    } else if (s && s.en === now && s.ja !== now) el.setAttribute(a, s.ja);
  }
}
/** Put everything under `root` (and `root` itself) into the display language. */
function apply(root) {
  if (!root) return;
  if (root.nodeType === 3) { if (!skip(root.parentElement)) textTo(root); return; }
  if (root.nodeType !== 1 || skip(root)) return;
  attrsTo(root);
  for (const el of root.querySelectorAll('[aria-label],[title],[placeholder],[alt]')) if (!skip(el)) attrsTo(el);
  const w = doc.createTreeWalker(root, 4 /* text */);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (!skip(n.parentElement)) textTo(n);
}

let titleJa = null;
function applyPage() {
  if (titleJa === null) titleJa = doc.title;
  doc.title = lang() === 'en' ? toEnglish(titleJa) : titleJa;
  // the label the style sheet puts before the request chosen at the entry (index.html `.req.focus::before`)
  if (lang() === 'en') doc.documentElement.style.setProperty('--focus-label', JSON.stringify(toEnglish('入口で選んだ依頼')));
  else doc.documentElement.style.removeProperty('--focus-label');
  apply(doc.body);
  warn();
}
const warned = new Set();
function warn() {
  for (const s of missing()) if (!warned.has(s)) { warned.add(s); console.warn('[coop lang] no English for:', JSON.stringify(s)); }
}

if (doc?.body && typeof globalThis.MutationObserver === 'function') {
  globalThis.__coopLangMissing = missing;   // the live check reads what stayed Japanese in English
  const box = doc.createElement('span');
  box.className = 'row';
  doc.querySelector('header')?.append(box);
  mountLangToggle(box, { className: 'lang' });
  new MutationObserver(records => {
    if (lang() !== 'en') return;
    for (const r of records) {
      if (r.type === 'characterData') apply(r.target);
      else if (r.type === 'attributes') { if (!skip(r.target)) attrsTo(r.target); }
      else for (const n of r.addedNodes) apply(n);
    }
    warn();
  }).observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  onLangChange(applyPage);
  // the game page (same origin) changed the language in another window: follow it
  globalThis.addEventListener?.('storage', e => { if (e.key === STORAGE_KEY && LANGS.includes(e.newValue)) setLang(e.newValue); });
  applyPage();
}
