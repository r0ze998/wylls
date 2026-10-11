// What a battle scene has on stage, for whoever must keep out of its way.
//
// A player's character is in one place at a time (UX design 13.2; DECISIONS
// ZQ7). While a scene shows a nation's character behind its line, the board
// does not show the same player beside the village as well, and nothing of the
// board's stands inside a scene: people/battle.mjs says here, each frame it
// paints a scene's tile, how far that tile's scene reaches and whose
// characters stand in it; people/onboard.mjs asks before it lets a character
// stand beside its village.
//
// This file holds no rule and imports nothing: it is the note the scene's
// painter leaves, so that the two painters need not import each other. A note
// is true for as long as the scene is on stage. Whoever stages the scene says
// when that is (`live()`: the effects layer plays a scene on its own clock,
// which the demo switch can hold still: fx/battle.mjs); a scene nobody stages
// (the map's own painter draws it) is on stage while it is being painted: its
// note is gone when it was not renewed for STAGE_HOLD seconds.
const notes = new Map();   // "P,Q,tile" → the note of that tile's scene
const wall = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000;

/** A note without a `live()` of its own is renewed every frame its scene is painted; it is gone this long (s) after the last one. */
export const STAGE_HOLD = 0.25;

/**
 * A scene's tile was painted just now: `{p, q, tile}` where, `box: {x0, y0, x1, y1}` how far its figures, numbers
 * and bars reach on the ground (world px), `characters`: the nations' characters it shows (`[{key, x, y}]`: the
 * motion pack's key, where its feet stand), `hosts`: the ids of the hosts on the sides that have a character,
 * `live`: a function that says whether the scene is still on stage (optional).
 */
export function noteStage(note, at = wall()) {
  if (!note || ![note.p, note.q, note.tile].every(Number.isInteger) || !note.box) return;
  if (notes.size > 32) for (const [k, n] of notes) if (!onStage(n, at)) notes.delete(k);
  notes.set(`${note.p},${note.q},${note.tile}`, { ...note, at });
}
const onStage = (n, now) => { if (typeof n.live === 'function') { try { return !!n.live(); } catch { return false; } } return now - n.at <= STAGE_HOLD; };
/** The scenes on stage at `now`: the notes that are still true. */
export function stagesNow(now = wall()) {
  const out = [];
  for (const [k, n] of notes) { if (onStage(n, now)) out.push(n); else notes.delete(k); }
  return out;
}
/** Forget every note (a test, a page that leaves the map). */
export const clearStages = () => notes.clear();
