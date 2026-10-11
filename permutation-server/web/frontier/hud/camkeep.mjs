// The camera comes back (UX design 14.2; the capture of 2026-10-10: "drawers
// throw the camera away"). A drawer that opens, and a battle the camera was
// sent to, move the picture; when the drawer closes or the battle ends the
// picture returns to where it was — unless the player moved it in between
// (a drag, the wheel, the map's keys and buttons, a "go there"), which is
// then the place they chose.
//
//   const keep = createCamKeep(() => map);
//   keep.keep('drawer')          remember the view under a name (the first call wins until `back`)
//   keep.touch()                 the player moved the camera
//   keep.back('drawer', {ms})    fly back if nothing moved it since; true when it did
//
// The map's own API is used: `map.view` ({x, y, zoom}: the logical view), `map.moves` (a count of the moves the
// page asked for by name) and `map.setView(view, {auto: true, ms, kind: 'fly'})` (an automatic move: it does not
// count as the player's). Pure apart from the map it is given.
export function createCamKeep(mapOf) {
  const kept = new Map();
  let touches = 0;
  return {
    touch() { touches++; },
    keep(key) {
      const m = mapOf();
      if (!m?.view || kept.has(key)) return false;
      kept.set(key, { view: { x: m.view.x, y: m.view.y, zoom: m.view.zoom }, moves: m.moves ?? 0, touches });
      return true;
    },
    /** Forget a kept view without going back (the player chose a place while it was kept). */
    drop(key) { return kept.delete(key); },
    has(key) { return kept.has(key); },
    back(key, { ms = 260, slack = 0 } = {}) {
      const k = kept.get(key), m = mapOf();
      kept.delete(key);
      if (!k || !m?.setView) return false;
      // (`slack`: moves by name the keeper's own owner made in between, such as the flights to a battle: the page's and
      // the effects layer's; Infinity when the owner reports every move of the player's with `touch` itself)
      if (k.touches !== touches || (m.moves ?? 0) > k.moves + slack) return false;
      const v = m.view ?? {};
      if (Math.abs(v.x - k.view.x) < 0.5 && Math.abs(v.y - k.view.y) < 0.5 && Math.abs(v.zoom - k.view.zoom) < 0.001) return false;
      m.setView(k.view, { auto: true, ms, kind: 'fly' });
      return true;
    },
  };
}
