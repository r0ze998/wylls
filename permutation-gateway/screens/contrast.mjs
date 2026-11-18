// Q16-3 round 3 (verify-pr61 F4): text contrast as the page paints it, for the screen tests. `CONTRAST` runs IN the page
// (page.evaluate(CONTRAST, selector)): every button and text line under the selector, with its WCAG contrast against
// what is painted behind it — its own background, else translucent layers composited down to the nearest painted
// ancestor; a gradient counts by its worst stop. Images and text shadows are not counted.
/** In the page: every button and text line of `sel`, with its contrast against what is painted behind it. */
export const CONTRAST = sel => {
  const rgba = s => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; };
  const stops = s => [...String(s).matchAll(/rgba?\([^)]+\)/g)].map(m => rgba(m[0]));
  const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat(1); };
  // the candidate colours painted behind `el`: translucent layers composited down to the first opaque one (a gradient
  // is opaque here, each stop a candidate)
  const behind = el => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const st = getComputedStyle(e);
      const g = stops(st.backgroundImage);
      if (g.length) { let out = g.map(c => [c[0], c[1], c[2], 1]); for (const l of layers.reverse()) out = out.map(u => over(l, u)); return out; }
      const c = rgba(st.backgroundColor);
      if (c && c[3] >= 0.999) { let out = [c]; for (const l of layers.reverse()) out = out.map(u => over(l, u)); return out; }
      if (c && c[3] > 0) layers.push(c);
    }
    let out = [[255, 255, 255, 1]]; for (const l of layers.reverse()) out = out.map(u => over(l, u)); return out;
  };
  const root = document.querySelector(sel);
  if (!root) return null;
  const items = [...root.querySelectorAll('button, a.btn, span, strong')].filter(e => e.childElementCount === 0 || e.tagName === 'BUTTON' || e.tagName === 'A');
  return items.filter(e => e.textContent.trim() && e.getClientRects().length).map(e => {
    const fg = rgba(getComputedStyle(e).color);
    const min = Math.min(...behind(e).map(b => ratio(fg, b)));
    const st = getComputedStyle(e);
    return { tag: e.tagName, act: e.dataset?.act ?? null, text: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 60), contrast: Math.round(min * 100) / 100,
      paint: `${st.color} on ${st.backgroundColor} ${st.backgroundImage === 'none' ? '' : st.backgroundImage.slice(0, 80)}` };
  });
};
