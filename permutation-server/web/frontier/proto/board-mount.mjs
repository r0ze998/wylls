// The one place where the banner rule's PROTOTYPE reaches the map
// (PROTOTYPE-SPEC.md; the rule is a design, not in the program). app.mjs calls
//
//   const board = mountProtoBoard({ map, want: wantPreview });   …   board.build();
//
// once the map exists, and `build()` whenever the page has drawn itself again.
// While the season record carries `sample.proto.claims` (the sample world
// started with the boot parameter `claims=1`) the page's ONE reading of the
// prototype's records (`FS.proto`, filled by controller.mjs) is handed to the
// board's model (proto/board-model.mjs) and the model to the map
// (`map.setProto`). This file reads nothing from the network. With the switch
// off the map is given null and the page is the page it was.
//
// For the hand: `map.protoPreview(host, p, q, tile, {troops}?)` asks the preview
// route through the page's one asker (a promise of the route's answer with the place beside it, ready for
// `map.showRaisePreview`; `host` null: a host formed there now); `map.protoModel()` is the model the board draws.
import { FS } from '../fstate.mjs';
import { hostParts } from '../faddr.mjs';
import { protoBoardModel } from './board-model.mjs';
import { protoFeedOf } from './board-feed.mjs';

const int = Number.isInteger;
/** The model from the page's state `fs`, the feed and the viewer's survey (pure but for what it is given: tests call it). */
export function protoModelOf(fs, feed, survey = null) {
  const sample = fs?.sample ?? null;
  if (!sample?.proto?.claims) return null;
  const holdings = (fs.holdings ?? []).filter(h => h && int(h.p) && int(h.q) && int(h.site));
  const ownsHost = id => { try { const h = id === null || id === undefined ? null : hostParts(id); return !!h && holdings.some(o => o.p === h.p && o.q === h.q && o.site === h.site); } catch { return false; } };
  const rows = survey?.board?.hosts ?? [];
  const hostAt = id => { const r = rows.find(x => String(x.id) === String(id)); return r && int(r.tile) ? { p: r.p, q: r.q, tile: r.tile } : null; };
  const siteNation = (p, q, site) => {
    const m = fs.provinces?.get?.(`${p},${q}`)?.province?.siteMirror?.[site];
    if (m && int(m.faction) && m.faction < 6 && m.state) return m.faction;
    for (const ov of fs.overviews?.values?.() ?? []) { const r = ov.provinces?.find?.(x => x.p === p && x.q === q); const f = r?.owners?.[site]; if (int(f) && f < 6) return f; }
    return null;
  };
  // (the faint flower of a claim in progress: the preview route's answer for where each of the viewer's hosts stands)
  const previews = new Map();
  for (const [key, land] of feed.lands) {
    const [p, q] = key.split(',').map(Number);
    for (const r of land.rising ?? []) if (ownsHost(r.host)) { const a = feed.previewNow(r.host, p, q, Number(r.tile)); if (a) previews.set(String(r.host), a); }
  }
  return protoBoardModel({ sample, provinces: feed.provinces(), me: feed.me, events: feed.events, previews,
    viewer: { nation: int(fs.citizen?.faction) ? fs.citizen.faction : null, villages: holdings.map(h => ({ p: h.p, q: h.q, site: h.site, tile: h.tile })), ownsHost, hostAt, holders: holdings.map(h => `${h.p},${h.q},${h.site}`) },
    siteNation, siteTiles: (p, q) => fs.terrainOf?.(p, q)?.sites ?? null, levelAt: survey && !survey.showAll && survey.levelAt ? survey.levelAt : null });
}

export function mountProtoBoard({ map, want = () => undefined, state = () => FS.proto ?? null } = {}) {
  if (!map?.setProto) return null;
  let mine = false, last = null;
  const surveyNow = () => { try { return map.source?.()?.survey ?? null; } catch { return null; } };
  // (the provinces the viewer has seen some of: the board draws the prototype's land nowhere else)
  const seen = (p, q) => { const sv = surveyNow(); return !sv || sv.showAll || (sv.province?.(p, q)?.max ?? 0) >= 2; };
  const feed = protoFeedOf({ state, want, seen });
  /** Build the model again when the page's reading, the viewer or what the viewer has seen changed; false when nothing did. */
  const build = () => {
    if (!FS.sample?.proto?.claims || !state()) {
      if (mine) { mine = false; last = null; map.setProto(null); }
      return null;
    }
    const sv = surveyNow();
    const key = [feed.rev(), [...feed.lands.keys()].join(' '), (FS.holdings ?? []).map(h => `${h.p},${h.q},${h.site}`).join(' '), FS.citizen?.faction ?? '', sv ? (sv.showAll ? 'all' : sv.tiles?.size ?? '') : ''].join('|');
    if (mine && key === last) return false;
    const model = protoModelOf(FS, feed, sv);
    if (model) { mine = true; last = key; map.setProto(model); }
    else if (mine) { mine = false; last = null; map.setProto(null); }
    return model;
  };
  map.protoPreview = (host, p, q, tile, opts) => feed.preview(host, p, q, tile, opts);
  map.protoModel = () => map.proto?.model ?? null;
  return { feed, build };
}
