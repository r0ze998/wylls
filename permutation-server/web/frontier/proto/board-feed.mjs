// The board's view of the banner rule's PROTOTYPE records (PROTOTYPE-SPEC.md
// section 6; the rule is a design, served by the sample world alone and never
// by a chain).
//
// The page reads those records ONCE (controller.mjs: the season record's
// `sample.proto.claims`, `proto.land` of each province envelope and of the
// viewer's own record, the PROTO_LAND records of the log, the answers of the
// preview route through proto/orders.mjs) and keeps them in `FS.proto`. This
// file asks the network for nothing: it hands that one reading to the board's
// model (proto/board-model.mjs) in the shape the model takes, so the hand and
// the board can never read two different worlds.
import { protoEvent } from './board-model.mjs';

const int = Number.isInteger;

/**
 * `state()` gives the page's reading (`FS.proto`: `{lands: Map "P,Q" → land, me, log, rev}`) or null while the
 * prototype is off. `want(x, onAnswer?)` is the page's one asker of the preview route (controller.mjs `wantPreview`:
 * the answer held, undefined while it is asked, null when it cannot be had). `seen(p, q)`: whether the viewer has
 * seen any of that province (the board draws the prototype's land nowhere else).
 */
export function protoFeedOf({ state = () => null, want = () => undefined, seen = () => true } = {}) {
  let logOf = null, events = [];
  const landsNow = () => {
    const out = new Map();
    for (const [key, land] of state()?.lands ?? []) {
      const [p, q] = String(key).split(',').map(Number);
      if (land && int(p) && int(q) && seen(p, q)) out.set(key, land);
    }
    return out;
  };
  return {
    /** "P,Q" → `proto.land` of that province, as the page last read it. */
    get lands() { return landsNow(); },
    get me() { return state()?.me ?? null; },
    /** The PROTO_LAND records the page has read, oldest first (as `protoEvent` gives them). */
    get events() {
      const log = state()?.log ?? null;
      if (log !== logOf) { logOf = log; events = (log ?? []).map(protoEvent).filter(Boolean); }
      return events;
    },
    /** The provinces as the model takes them: `[{p, q, land}]`. */
    provinces() { return [...landsNow()].map(([key, land]) => { const [p, q] = key.split(',').map(Number); return { p, q, land }; }); },
    /** What changes when the page has read something new (the model is built again only then). */
    rev() { const P = state(); return P ? `${P.rev ?? 0}|${P.lands?.size ?? 0}|${P.log?.length ?? 0}` : ''; },
    /**
     * What a banner raised by `host` on tile (p, q, tile) would bring, as the world's preview route says; with no host
     * (null or ''): by a host formed there now (`troops`). A promise of the route's own answer with the place beside it
     * (`{…, host, p, q, tile}`: what `map.showRaisePreview` takes), or null when it cannot be had.
     */
    preview(host, p, q, tile, { troops = null } = {}) {
      const who = host === null || host === undefined || host === '' ? null : String(host);
      const x = who !== null ? { host: who, p, q, tile } : { p, q, tile, ...(Number.isFinite(Number(troops)) && troops !== null ? { troops: Number(troops) } : {}) };
      const wrap = a => (a ? { ...a, host: who, p, q, tile } : null);
      return new Promise(done => {
        let told = false;
        const a = want(x, v => { if (!told) { told = true; done(wrap(v)); } });
        if (a !== undefined && !told) { told = true; done(wrap(a)); }
        if (!state() && !told) { told = true; done(null); }
      });
    },
    /** The answer the page already holds for that place this turn, or undefined (it is asked for then). */
    previewNow(host, p, q, tile) { return want({ host: String(host), p, q, tile }) || undefined; },
  };
}
