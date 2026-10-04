// The page's only way to build markup (contract §6.2 rule 5, §11.5 AC7: "feed (textContent only)"): elements are
// created with createElement, every string reaches the page as a text node or textContent, and nothing in this
// directory may use innerHTML, outerHTML, insertAdjacentHTML or document.write (a test scans for them, and a fake
// document whose setters throw runs every render function). Attributes are a whitelist of plain names; `on*`,
// `style` (the CSP allows no inline style: look is classes only), `srcdoc` and non-local URLs are refused.
//
//   const h = makeH(document);
//   h('p', { class: 'note' }, 'text', h('b', null, 'more'))
//   h('button', { on: { click: fn } }, 'label')
const BAD_ATTR = /^(on|style$|srcdoc$|innerhtml$|outerhtml$|formaction$|action$)/i;
const SAFE_URL = /^(#[\w-]*|\/(?!\/)[\w./%?=&,:-]*)$/;

export function makeH(doc) {
  const text = s => doc.createTextNode(String(s ?? ''));
  function append(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else if (typeof k === 'object' && k.nodeType) el.appendChild(k);
      else el.appendChild(text(k));
    }
  }
  function h(tag, props, ...kids) {
    const el = doc.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = String(v);
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'on') { for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); }
        else if (BAD_ATTR.test(k)) throw new Error(`dom: attribute ${k} is not allowed`);
        else if ((k === 'href' || k === 'src') && !SAFE_URL.test(String(v))) throw new Error(`dom: ${k} must be a same-origin path or a fragment`);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }
  /** Replace every child of `el` with `kids`. */
  function fill(el, ...kids) {
    while (el.firstChild) el.removeChild(el.firstChild);
    append(el, kids);
    return el;
  }
  h.text = text;
  h.fill = fill;
  h.append = (el, ...kids) => { append(el, kids); return el; };
  return h;
}
