// Who is looking, for the survey (map/survey.mjs): the anchors of the page's
// viewer read out of what the page already holds. Nothing is fetched here.
//
//   villages       the viewer's Holdings (provisional or final), by tier
//   hosts          the viewer's hosts standing in the provinces the page has loaded
//                  (a host on the road gives no sight until it has arrived)
//   candidates     the sites of an open ticket (their tiles come from the terrain)
//   explored       the tiles of the viewer's own Explore records: the one a Holding
//                  still carries, and the EXPLORE events of the chronicle
//   destinations   where the viewer's own marches go (the march book of this browser)
import { hostParts } from '../faddr.mjs';
import { hostsIn } from '../fland.mjs';
import { activeHolding } from '../fstate.mjs';

const int = Number.isInteger;

/** The survey's input for `fs` (the page state): see survey.mjs createSurveyor. */
export function surveyInput(fs, { terrainOf = null, ready = true, scope = null } = {}) {
  const mode = fs?.mode ?? 'play';
  const ringsOpen = fs?.record?.rings?.length ?? 1;
  if (mode !== 'play') return { mode, ringsOpen };
  const holdings = (fs.holdings ?? []).filter(h => h && int(h.p) && int(h.q) && int(h.tile));
  const villages = holdings.map(h => ({ p: h.p, q: h.q, tile: h.tile, tier: h.tier ?? 0, state: h.state ?? null }));
  const hosts = [], hostIds = [];
  for (const env of fs.provinces?.values?.() ?? []) {
    const pv = env?.province;
    if (!pv?.entries) continue;
    for (const h of holdings) for (const row of hostsIn(pv, h, fs.nowBell ?? 0)) {
      hostIds.push(String(row.id));
      if (row.state === 1 || row.state === 2) hosts.push({ p: pv.p, q: pv.q, tile: row.tile, unit: row.unit });
    }
  }
  const stage = fs.land?.stage ?? (fs.citizen ? 'joined' : 'none');
  const candidates = stage === 'ticket' ? (fs.land?.ticket?.sites ?? []).map(s => {
    const tile = terrainOf?.(s.p, s.q)?.sites?.[s.site];
    return { p: s.p, q: s.q, site: s.site, tile: int(tile) ? tile : null };
  }) : [];
  const mine = id => { const h = hostParts(id); return !!h && holdings.some(o => o.p === h.p && o.q === h.q && o.site === h.site); };
  const explored = [];
  for (const h of holdings) {
    const e = h.explore;
    if (e?.state && int(e.p) && int(e.q)) for (const t of Array.from(e.tiles ?? [])) if (int(t)) explored.push({ p: e.p, q: e.q, tile: t });
  }
  for (const x of fs.chronicle ?? []) {
    const r = x.record ?? x;
    if (r.name !== 'EXPLORE' || !mine(r.host_id)) continue;
    for (const t of Array.from(r.tiles ?? []).slice(0, Number(r.n ?? 0))) explored.push({ p: Number(r.p), q: Number(r.q), tile: Number(t) });
  }
  const destinations = (fs.marches ?? []).map(m => m?.dest).filter(d => d && int(d.p) && int(d.q) && int(d.tile)).map(d => ({ p: d.p, q: d.q, tile: d.tile }));
  const a = activeHolding(fs);
  const dedupe = list => [...new Map(list.map(o => [`${o.p},${o.q},${o.tile},${o.unit ?? ''}`, o])).values()];
  return { mode, ringsOpen, ready, scope, wallet: fs.wallet?.address ?? null, stage, faction: int(fs.citizen?.faction) ? fs.citizen.faction : null,
    villages, hosts: dedupe(hosts), candidates, explored: dedupe(explored), destinations: dedupe(destinations), hostIds: [...new Set(hostIds)].sort(),
    home: a && int(a.tile) ? { p: a.p, q: a.q, tile: a.tile, state: a.state ?? null, tier: a.tier ?? 0 } : null };
}
