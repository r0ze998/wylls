// The one place where the page's conquest records reach the keeps on the map
// (map/keeps.mjs). app.mjs calls `mountKeepBoard({ map })` once the map
// exists; nothing else of the page is asked.
//
//   the feed    `map.setKeepFeed(() => ({enabled, events, viewer, bell}))`: whether the season is a
//               conquest season (fconquest.mjs conquestEnabled), the keep events the page has read
//               (controller.mjs refreshKeepEvents → FS.conquest.events), the viewer's nation, the turn.
//               The map reads it once a frame; who holds what comes from the control record on the
//               overviews, which the map already has.
//   the reach   while a fighting host that may march is in the hand, the keeps it can reach are lit
//               (`keepReachOf`): asked of the rules kernel through the composer's own planner
//               (fkeepreach.mjs), once per host, place, turn and control snapshot. A guide only: the
//               route the composer plans is what a march takes. This is the board's own default: the
//               first call of `map.setKeepReach(list)` by the page takes it over (the hand may then
//               light what it likes).
//
//   own clash   the clashes of the viewer's own host where it stands are given their place among the turn's
//               results (map/ownclash.mjs, which reads those records' reports), and the option "move the map to
//               a clash of mine" is given its conquest default once (map/autopan.mjs).
//
// This file reads nothing from the network and sends no order.
import { FS } from '../fstate.mjs';
import { conquestEnabled } from '../fconquest.mjs';
import { territoryEnabled } from '../territory.mjs';
import { reachableKeeps } from '../fkeepreach.mjs';
import { earliestBell, departMargin } from '../fmarch.mjs';
import { SCOUT, SETTLER } from '../fland.mjs';
import { subjectOf, marchCheck } from '../hud/subject.mjs';
import { reachWhy } from './keeps.mjs';
import { mountOwnClash } from './ownclash.mjs';
import { autoPanDefault } from './autopan.mjs';

const int = Number.isInteger;

/** The page's part of the keeps' records, for the map: `{enabled, events, viewer, bell}`. */
export function keepFeedOf(fs) {
  const enabled = conquestEnabled(fs?.season) && !territoryEnabled(fs);
  return { enabled, events: enabled && Array.isArray(fs.conquest?.events) ? fs.conquest.events : null, viewer: int(fs?.citizen?.faction) ? fs.citizen.faction : null, bell: int(fs?.nowBell) ? fs.nowBell : null };
}

/** The fighting host in the hand that may march now: a host row (hud/subject.mjs), or null. */
export function handHostOf(fs) {
  try {
    if ((fs?.mode ?? 'play') !== 'play' || fs.compose || fs.hand?.pick) return null;
    const sub = subjectOf(fs), h = sub?.kind === 'host' ? sub.host : null;
    return h && h.unit !== SCOUT && h.unit !== SETTLER && marchCheck(fs, h).ok ? h : null;
  } catch { return null; }
}

/**
 * The reach list of host `h` for `map.setKeepReach`: every keep another nation holds, `[{p, q, tile, arriveTurn,
 * holder, defenders, reachable, why}]`. A keep the planner has a route to is `reachable` with the earliest turn the
 * march could arrive; the others say why not (too far, a heartland, protected after a capture). Null without the
 * rules kernel or the control record.
 */
export function keepReachOf(fs, h) {
  const cq = fs?.conquest, me = fs?.citizen?.faction;
  if (!h || !cq?.keeps?.size || !fs.kernel || !int(me)) return null;
  const nowBell = fs.nowBell ?? 0;
  const r = reachableKeeps({ kernel: fs.kernel, keeps: cq.keeps, origins: [{ p: h.p, q: h.q, tile: h.tile, unit: h.unit }], seeds: (fs.record?.rings ?? []).map(x => ({ ring: x.d, seed: x.seed })), faction: me, nowBell });
  if (!r.ok) return null;
  const secsPerTurn = Number(fs.season?.bellSecs ?? 600) || 600, departTs = (fs.chain?.now?.() ?? 0) + departMargin(fs.chain?.rate);
  const turnOf = secs => {
    let b = null;
    try { b = fs.clock ? earliestBell(fs.kernel, { genesisTs: fs.clock.genesisTs, departTs, secs }) : null; } catch { b = null; }
    return int(b) ? Math.max(b, nowBell + Number(fs.season?.minLead ?? 0)) : nowBell + Math.max(1, Math.ceil(secs / secsPerTurn));
  };
  const out = [], lit = new Set();
  for (const k of r.rows) { lit.add(`${k.p},${k.q}`); out.push({ p: k.p, q: k.q, tile: k.tile, arriveTurn: turnOf(k.route.secs), holder: k.holder, defenders: k.troops ?? null, reachable: true, why: null }); }
  for (const k of cq.keeps.values()) {
    const key = `${k.p},${k.q}`;
    if (lit.has(key) || !int(k.holder) || k.holder > 5 || k.holder === me) continue;
    const why = k.heartland ? reachWhy.heartland() : int(k.consolidatedUntil) && k.consolidatedUntil > nowBell ? reachWhy.guarded(k.consolidatedUntil) : reachWhy.far();
    out.push({ p: k.p, q: k.q, tile: k.tile, arriveTurn: null, holder: k.holder, defenders: k.troops ?? null, reachable: false, why });
  }
  return out;
}

/** Give the map its feed and its default reach. Returns `{sync}` (called by the map's feed each frame; tests call it), or null without a map. */
export function mountKeepBoard({ map, state = () => FS } = {}) {
  if (!map?.setKeepFeed) return null;
  let key = null;
  // the clashes of the viewer's own host where it stands (map/ownclash.mjs): only on a conquest season, as the keeps are
  const own = mountOwnClash({ state, enabled: fs => keepFeedOf(fs).enabled });
  const sync = () => {
    const fs = state(), feed = keepFeedOf(fs);
    if (feed.enabled) { try { autoPanDefault(fs); own.sync(); } catch (e) { globalThis.console?.warn?.('frontier own clash:', e); } }
    // the default reach: only until the page lights its own (`map.setKeepReach`)
    if (!map.keeps?.reachOwn) {
      const h = feed.enabled ? handHostOf(fs) : null;
      const k = h ? `${h.id}|${h.p},${h.q},${h.tile}|${fs.nowBell}|${fs.conquest?.control?.bell ?? ''}|${fs.kernel ? 1 : 0}|${fs.conquest?.keeps?.size ?? 0}` : '';
      if (k !== key) {
        key = k;
        let list = null;
        try { list = h ? keepReachOf(fs, h) : null; } catch (e) { globalThis.console?.warn?.('frontier keep reach:', e); }
        // (a host in hand before the kernel has loaded: asked again when it has)
        if (h && !list && !fs.kernel) key = null;
        map.keeps?.setReach(list, { own: false });
      }
    }
    return feed;
  };
  map.setKeepFeed(sync);
  return { sync, own };
}
