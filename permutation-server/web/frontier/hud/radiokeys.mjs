// The arrow keys of a group of radio buttons (WAI-ARIA radio group): the page draws its choices as buttons with
// role="radio" inside a role="radiogroup" (the stances, the retreat, the stances compared: hud/marchcard.mjs), which
// a screen reader announces as a radio group, where the arrows are the keys a user expects. An arrow moves to the
// next choice in the group and chooses it (the button's own click: the page's existing action), Home and End to the
// first and the last. Tab still reaches each button as before. A click may draw the group again: the focus follows
// the choice to its new button (same group label, same value).

const KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** The button a key moves to in `group` from `from` (a role="radio" button), or null. Pure, for tests. */
export function radioStep(buttons, from, key) {
  const live = buttons.filter(b => !b.disabled);
  const i = live.indexOf(from);
  if (i < 0 || !live.length) return null;
  if (key === 'Home') return live[0];
  if (key === 'End') return live[live.length - 1];
  const d = KEYS[key];
  return d ? live[(i + d + live.length) % live.length] : null;
}

/** Listen on `doc` (once). */
export function mountRadioKeys(doc = globalThis.document) {
  if (!doc?.addEventListener || doc.__radioKeys) return;
  doc.__radioKeys = true;
  doc.addEventListener('keydown', e => {
    if (!(e.key in KEYS) && e.key !== 'Home' && e.key !== 'End') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const from = e.target?.closest?.('button[role="radio"]');
    const group = from?.closest?.('[role="radiogroup"]');
    if (!group) return;
    const to = radioStep([...group.querySelectorAll('button[role="radio"]')], from, e.key);
    if (!to) return;
    e.preventDefault();
    const label = group.getAttribute('aria-label'), v = to.dataset.v;
    to.click();
    const refocus = () => {
      const g = [...doc.querySelectorAll('[role="radiogroup"]')].find(x => x.getAttribute('aria-label') === label);
      const b = g && [...g.querySelectorAll('button[role="radio"]')].find(x => x.dataset.v === v);
      (b ?? to).focus?.({ preventScroll: true });
    };
    refocus();
    globalThis.requestAnimationFrame?.(() => refocus());
  });
}
