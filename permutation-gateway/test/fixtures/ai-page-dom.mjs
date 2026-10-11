// A tiny fake DOM for the council page's render tests (no dependency, no browser). It records what the page builds
// and TRIPS on every HTML-parsing entry point: innerHTML, outerHTML and insertAdjacentHTML throw, so a render
// function that tried to turn a string into markup fails the test instead of passing silently.
class Node {
  constructor(type) { this.nodeType = type; this.parentNode = null; }
}
class Text extends Node {
  constructor(s) { super(3); this.data = String(s); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class Element extends Node {
  constructor(tag) {
    super(1);
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.className = '';
    this.listeners = new Map();
    this.value = '';
    this.disabled = false;
    this.hidden = false;
  }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.children.push(n); return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; }
  replaceChildren(...ns) { for (const c of [...this.children]) this.removeChild(c); for (const n of ns) this.appendChild(n); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(ev, fn) { (this.listeners.get(ev) ?? this.listeners.set(ev, []).get(ev)).push(fn); }
  click() { for (const fn of this.listeners.get('click') ?? []) fn({ target: this, preventDefault() {} }); }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); this.appendChild(new Text(v)); }
  get innerHTML() { throw new Error('innerHTML read'); }
  set innerHTML(_) { throw new Error('innerHTML is forbidden on the council page'); }
  get outerHTML() { throw new Error('outerHTML read'); }
  set outerHTML(_) { throw new Error('outerHTML is forbidden on the council page'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML is forbidden on the council page'); }
}

export function makeFakeDocument() {
  return { createElement: t => new Element(t), createTextNode: s => new Text(s), body: new Element('body') };
}

/** Every element under `node` (depth first), the node itself included. */
export function* walk(node) {
  if (node.nodeType === 1) { yield node; for (const c of node.children) yield* walk(c); }
}
export const findAll = (node, pred) => [...walk(node)].filter(pred);
export const byClass = (node, cls) => findAll(node, e => e.className.split(/\s+/).includes(cls));
export const byTag = (node, tag) => findAll(node, e => e.tagName === tag.toUpperCase());
/** All visible text under a node, with a space between block-level siblings kept simple: just the concatenated text. */
export const textOf = node => node.textContent;
/** True when no element in the tree carries a script-ish or style attribute and no <script>, <style>, <iframe>, <img>, <a href=javascript:> exists. */
export function hasActiveContent(node) {
  for (const e of walk(node)) {
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'SVG', 'LINK'].includes(e.tagName)) return `<${e.tagName.toLowerCase()}>`;
    for (const [k, v] of e.attrs) {
      if (/^on/i.test(k) || k === 'style' || k === 'srcdoc') return `attribute ${k}`;
      if ((k === 'href' || k === 'src') && /^\s*(javascript|data|https?:|\/\/)/i.test(v)) return `${k}=${v}`;
    }
  }
  return null;
}
