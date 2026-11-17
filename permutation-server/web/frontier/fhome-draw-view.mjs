// The provisional first-village draw's view state (2026-11-18): NOT PRODUCTION, NOT ENABLED.
//
// What a screen shows of a draw (fhome-draw.mjs) and of map growth (fhome-draw-frontier.mjs), with the guards the
// screen needs and nothing else:
//   * an answer is shown only for the wallet and the world (cluster, program, Season, the page's generation of it)
//     it was asked for, and only when it is the newest question: an older answer that arrives late is dropped;
//   * changing the wallet or the world clears what is shown at once (no answer of another one stays on screen);
//   * nothing is kept on the device: a reload starts with nothing shown and asks again (no stored draw can come
//     back for another wallet or world).
// It calls no join, no PlaceHome, no confirmHome, no signer and no send; it is not the normal join entry and does not
// replace it. Pure state: no DOM, no fetch, no clock.
import { drawHome, sameWorld, worldKeyOf, DRAW } from './fhome-draw.mjs';
import { growthView } from './fhome-draw-frontier.mjs';

export const VIEW = Object.freeze({ empty: 'empty', reading: 'reading', shown: 'shown' });

export function createDrawView({ draw = drawHome, growth = growthView } = {}) {
  let wallet = null, world = null, seq = 0, shown = null, status = VIEW.empty;
  const clear = () => { shown = null; status = VIEW.empty; seq++; };
  return {
    /** What the screen draws now. */
    state() { return Object.freeze({ status, wallet, world, answer: shown?.answer ?? null, growth: shown?.growth ?? null }); },
    /** The wallet the screen is for (the address typed or connected; never signed for here). Another one clears. */
    setWallet(w) {
      const next = typeof w === 'string' && w ? w : null;
      if (next !== wallet) { wallet = next; clear(); }
    },
    /**
     * (correction, 2026-11-18) End the question under way without clearing what is shown: its answer, when it comes,
     * is not shown (the page's newer request asks again). Used when the page starts a newer request.
     */
    cancel() { seq++; status = shown ? VIEW.shown : VIEW.empty; },
    /** The world the page reads now ({cluster, programId, seasonId, gen}). Another one, or an unknown one, clears. */
    setWorld(w) {
      const next = worldKeyOf(w);
      if (!sameWorld(next, world)) { world = next; clear(); }
    },
    /**
     * Ask for a draw with what the page has read (drawHome's inputs, without world and citizen: those are the view's).
     * → {applied: true} | {applied: false, why: 'noWallet'|'noWorld'|'stale'|'otherWallet'|'otherWorld'}
     */
    async ask(inputs = {}) {
      if (!wallet) return { applied: false, why: 'noWallet' };
      if (!world) return { applied: false, why: 'noWorld' };
      const my = ++seq, askedWallet = wallet, askedWorld = world;
      status = VIEW.reading;
      let answer;
      try { answer = await draw({ ...inputs, world: askedWorld, citizen: askedWallet }); }
      catch (e) { answer = Object.freeze({ kind: DRAW.unread, why: `the draw failed: ${String(e?.message ?? e).slice(0, 80)}`, world: askedWorld, citizen: askedWallet }); }
      if (my !== seq) return { applied: false, why: 'stale' };
      // (the newest question with an answer for someone or somewhere else: nothing is shown for it)
      if (wallet !== askedWallet || answer?.citizen !== askedWallet) { status = VIEW.empty; return { applied: false, why: 'otherWallet' }; }
      if (!sameWorld(world, askedWorld) || !sameWorld(answer?.world, askedWorld)) { status = VIEW.empty; return { applied: false, why: 'otherWorld' }; }
      let g = null;
      try { g = growth({ record: inputs.record, season: inputs.season, nowBell: inputs.nowBell ?? null }); } catch { g = null; }
      shown = { answer, growth: g };
      status = VIEW.shown;
      return { applied: true };
    },
  };
}
