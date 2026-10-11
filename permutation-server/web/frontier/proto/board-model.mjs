// The board's reading of the banner rule's PROTOTYPE ("Standing Ground":
// a DESIGN, not in the program, the rules crate or the ABI; nothing of it is
// sent to a chain). The sample world serves the prototype's records
// (PROTOTYPE-SPEC.md section 6); this file turns them into what the map
// draws, and into nothing else:
//
//   protoBoardModel({sample, provinces, me, events, previews, viewer, …}) → model | null
//
// One pure function. It holds NO number of the rule: every count on the
// board (the turns a threat still needs, the turns before a banner can rise,
// when a walk is due) is the difference of two turns the records carry.
// With `sample.proto.claims` absent it answers null and the map draws
// exactly what it drew before.
//
// Words: a tile index is 0..60 inside its province; the model gives every
// tile as its absolute hex `{q, r}` with `p, pq, idx` beside it (the names
// the map's own tiles use), so the painters never ask where a tile is.
import { tileHex, hexDistance } from '../fgeo.mjs';

const int = Number.isInteger;
/** The claim record's values (PROTOTYPE-SPEC 4.1: the shape of a record, not a number of the rule). */
export const CLAIM = Object.freeze({ OPEN: 0xff, SITES: 12, BANNER0: 16, SLOTS: 16 });
/** What a tile's claim value is: `{kind: 'open' | 'village' | 'banner', site?, slot?}`. */
export function claimKind(v) {
  if (int(v) && v >= 0 && v < CLAIM.SITES) return { kind: 'village', site: v };
  if (int(v) && v >= CLAIM.BANNER0 && v < CLAIM.BANNER0 + CLAIM.SLOTS) return { kind: 'banner', slot: v - CLAIM.BANNER0 };
  return { kind: 'open' };
}
export const bannerKey = (p, q, slot) => `${p},${q},${slot}`;
const hexOf = (p, q, idx) => { const h = int(idx) ? tileHex(p, q, idx) : null; return h ? { q: h.q, r: h.r, p, pq: q, idx } : null; };
const hexesOf = (p, q, list) => (Array.isArray(list) ? list : []).map(i => hexOf(p, q, Number(i))).filter(Boolean);
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * A dial from two turns of a record: it began at `since`, is done at `at`, and the province is settled up to `now`
 * (`resolvedNext`). `{total, done, left, share 0..1}`; never negative, never past its end (a dial counts settled
 * turns, so it never runs backwards). Null when the record does not carry both turns.
 */
export function dialOf(since, at, now) {
  const s = num(since), a = num(at), n = num(now);
  if (a === null || n === null) return null;
  const total = s === null ? null : Math.max(1, a - s), left = Math.max(0, a - n);
  const done = total === null ? null : Math.max(0, Math.min(total, total - left));
  return { since: s, at: a, total, done, left, share: total === null ? (left > 0 ? 0 : 1) : done / total, ready: left <= 0 };
}

/**
 * One PROTO_LAND record of /h/events as the board reads it. The fields may sit on the event itself, under `record`
 * or under `fields` (the herald's page shape is the world's to choose): `{seq, op, turn, p, q, slot, pole, nation,
 * holder, tiles: [idx], from, works, by, host}`, or null for anything that is not a record of the prototype.
 */
export function protoEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const f = { ...(e.fields ?? {}), ...(e.record ?? {}), ...e };
  if (f.proto !== true && f.kind !== 'PROTO_LAND' && f.name !== 'PROTO_LAND') return null;
  const op = String(f.op ?? '').toUpperCase();
  if (!op) return null;
  const p = num(f.p), q = num(f.q);
  if (!int(p) || !int(q)) return null;
  const from = Array.isArray(f.from) ? f.from : f.from ?? null;
  // (the answer is itself a record this function reads: a reader may keep what it has read)
  return { kind: 'PROTO_LAND', proto: true, seq: num(f.seq) ?? 0, op, turn: num(f.turn), p, q, slot: num(f.slot), pole: num(f.pole), nation: num(f.nation), holder: f.holder ?? null, host: f.host ?? null,
    tiles: (Array.isArray(f.tiles) ? f.tiles : []).map(Number).filter(int), from, works: num(f.works), by: f.by ?? null };
}

/** The order a patch floods in: from the far end of its tail, through the pole, then outward round the pole (`tiles` and `pole` as hexes). */
export function floodOrder(tiles, pole) {
  if (!pole) return [...tiles];
  const d = t => hexDistance(t.q, t.r, pole.q, pole.r), ang = t => Math.atan2((t.r - pole.r) * 1.5, (t.q - pole.q) * Math.sqrt(3) + (t.r - pole.r) * Math.sqrt(3) / 2);
  const tail = tiles.filter(t => d(t) > 1).sort((a, b) => d(b) - d(a) || ang(a) - ang(b));
  const at = tiles.filter(t => d(t) === 0), ring = tiles.filter(t => d(t) === 1).sort((a, b) => ang(a) - ang(b));
  return [...tail, ...at, ...ring];
}

/**
 * The model the map draws from, or null while the prototype is off.
 *
 *   sample     the season record's `sample` (its `proto.claims` is the switch; `turnSecs` says how long a turn is)
 *   provinces  iterable of `{p, q, land}`: `land` = `proto.land` of `/h/province/P,Q/latest` (as the sample world serves it: beside
 *              the fields of PROTOTYPE-SPEC section 6 it names its villages, `villages: [{site, tile, nation}]`, the tile a trail's
 *              host stands on, and for a claim in progress the land it would take, `patch` and `trail`; each is read when present)
 *   me         `proto.land` of `/h/me/<wallet>`, or null (its `holder` is the viewer's player key; its `hosts[].dress[].tiles`,
 *              when the world serves them, are the tiles a banner can be widened onto now)
 *   events     the PROTO_LAND records read so far (any shape `protoEvent` takes), oldest first
 *   previews   Map host id → the preview route's answer for where that host stands (the faint flower of a claim in progress)
 *   viewer     `{nation, villages: [{p, q, site, tile}], ownsHost(id) → bool, holders: [player keys], hostAt(id) → {p, q, tile} | null}`
 *   siteNation `(p, q, site) → nation | null` (who holds the village on that site: the province's own record)
 *   siteTiles  `(p, q) → [tile index of each of the 12 sites]` (the terrain), or null
 *   levelAt    `(q, r) → 0..3` the viewer's survey of a hex (others' land is drawn where it has been seen); absent: everything
 *   nationOf   `(p, q) → nation | null` the wedge's nation of a province with no record yet (for a border's direction)
 */
export function protoBoardModel({ sample = null, provinces = [], me = null, events = [], previews = null, viewer = {}, siteNation = () => null, siteTiles = () => null, levelAt = null } = {}) {
  const claims = sample?.proto?.claims ?? null;
  if (!claims) return null;
  const nation = int(viewer.nation) ? viewer.nation : null;
  const myVillages = viewer.villages ?? [], ownsHost = viewer.ownsHost ?? (() => false), holders = new Set((viewer.holders ?? []).map(String));
  // (the world names a player by its village, "P,Q,site": the viewer's own record says its key)
  if (me?.holder !== null && me?.holder !== undefined) holders.add(String(me.holder));
  const myBanners = new Set((me?.banners ?? []).map(b => bannerKey(b.p, b.q, b.slot)));
  const seen = levelAt ? (h => levelAt(h.q, h.r) >= 2) : () => true;
  const out = { on: true, rule: claims.rule ?? null, version: claims.version ?? null, label: claims.label ?? null, scoreNote: claims.scoreNote ?? null, turnSecs: num(sample.turnSecs),
    // (the rule's own table as the record carries it: read by name where a sentence says a count, never copied here)
    numbers: claims.numbers ?? null,
    viewer: { nation }, me: me ?? null, banners: [], villages: [], commons: [], trails: [], rising: [], canRise: [], buds: [], provinces: [], mine: null, events: [] };
  const mineTiles = [], sig = [];
  let villageN = 0, bannerN = 0;
  // where the viewer may still plant by what its own record says (never by a number kept here)
  const capLeft = me && int(me.cap) ? me.cap - (me.banners?.length ?? 0) : null;
  for (const pv of provinces) {
    const land = pv?.land, p = pv?.p, q = pv?.q;
    if (!land || !int(p) || !int(q) || !Array.isArray(land.claim)) continue;
    const now = num(land.resolvedNext), holderNation = int(land.holderNation) ? land.holderNation : null;
    const sites = new Set(siteTiles(p, q) ?? []);
    sig.push(`${p},${q}@${now}:${land.claim.join('.')}`);
    // ---- banners
    const bySlot = new Map();
    for (const b of land.banners ?? []) {
      if (!int(b?.slot)) continue;
      const key = bannerKey(p, q, b.slot);
      // (whose it is: the land record's own holder, or the viewer's own list of its banners — and never a banner the
      // land record puts under another nation. The two records are read a moment apart: right after the viewer TOOK
      // a banner on real records, the viewer's list had it while its land record still said the other nation's, the
      // banner was "the viewer's, under the other nation" for one model, and the board played the viewer's own
      // taking as a loss, 「あなたの旗がアステルに取られました」.)
      const ours = nation === null || !int(b.nation) || b.nation === nation;
      const mine = ours && (myBanners.has(key) || (b.holder !== null && b.holder !== undefined && holders.has(String(b.holder))));
      const tiles = hexesOf(p, q, b.tiles), pole = hexOf(p, q, Number(b.pole));
      const c = b.contested ?? null;
      const dial = c ? dialOf(c.sinceTurn, c.canTakeAtTurn, now) : null;
      const walkIn = num(b.walkDue) !== null && now !== null ? num(b.walkDue) - now : null, strikeIn = num(b.strikeAt) !== null && now !== null ? num(b.strikeAt) - now : null;
      const banner = { key, p, q, slot: b.slot, nation: int(b.nation) ? b.nation : null, holder: b.holder ?? null, mine, mate: !mine && nation !== null && b.nation === nation,
        pole, tiles, firm: !!b.firm, border: (Array.isArray(b.border) ? b.border : []).filter(int), frayed: !!b.frayed, raisedTurn: num(b.raisedTurn), tendedTurn: num(b.tendedTurn),
        walk: { dueIn: walkIn, strikeIn, every: num(b.walkDue) !== null && num(b.tendedTurn) !== null ? num(b.walkDue) - num(b.tendedTurn) : null },
        dressedToday: !!b.dressedToday, elbowLockedUntil: num(b.elbowLockedUntil),
        // a hostile host on the pole: the threat's dial; `byViewer`: it is a host of the viewer's (the gold ring of a taking)
        // (`onlyPull`: the record says the host on the pole may only pull the banner down — it cannot be taken there)
        contested: c && !(int(c.nation) && c.nation === b.nation) ? { nation: int(c.nation) ? c.nation : null, host: c.host ?? null, byViewer: ownsHost(c.host), dial, onlyPull: c.onlyPull ?? null } : null };
      bySlot.set(b.slot, banner);
      if (mine) { for (const t of tiles) mineTiles.push({ q: t.q, r: t.r, banner: key }); bannerN += tiles.length; }
      // (another's banner is drawn where the viewer has seen its land: a public record, as a village is)
      if (mine || tiles.some(seen)) out.banners.push(banner);
      sig.push(`b${key}:${banner.nation}:${mine ? 1 : 0}:${banner.firm ? 1 : 0}:${banner.frayed ? 1 : 0}:${banner.border.join('')}:${walkIn}:${banner.contested && dial ? `${dial.left}/${dial.total}/${banner.contested.nation}/${banner.contested.onlyPull ?? ''}` : ''}`);
    }
    // ---- village land and open ground, tile by tile
    const bySite = new Map(), open = [];
    land.claim.forEach((v, idx) => {
      const k = claimKind(Number(v)), h = hexOf(p, q, idx);
      if (!h) return;
      if (k.kind === 'village') { let l = bySite.get(k.site); if (!l) bySite.set(k.site, l = []); l.push(h); }
      else if (k.kind === 'open') open.push(h);
    });
    for (const [site, tiles] of bySite) {
      const mv = myVillages.find(v => v.p === p && v.q === q && v.site === site) ?? null;
      // (the land record names each village itself, `villages: [{site, tile, nation}]`; else the province's own record does)
      const rec = (land.villages ?? []).find(v => v.site === site) ?? null;
      const n = mv ? nation : int(rec?.nation) ? rec.nation : siteNation(p, q, site);
      const centre = mv && int(mv.tile) ? hexOf(p, q, mv.tile) : int(rec?.tile) ? hexOf(p, q, rec.tile) : tiles.find(t => sites.has(t.idx)) ?? null;
      out.villages.push({ key: `${p},${q},s${site}`, p, q, site, nation: int(n) ? n : null, mine: !!mv, mate: !mv && nation !== null && n === nation, tiles, centre });
      if (mv) { for (const t of tiles) mineTiles.push({ q: t.q, r: t.r, village: `${p},${q},${mv.tile}`, d: centre ? hexDistance(t.q, t.r, centre.q, centre.r) : 0 }); villageN += tiles.length; }
    }
    // the commons: open ground pays the nation that holds the province (in the sample world: the wedge's nation)
    const shown = open.filter(seen);
    if (holderNation !== null && shown.length) out.commons.push({ key: `${p},${q}`, p, q, nation: holderNation, ours: nation !== null && holderNation === nation, tiles: shown });
    // ---- where a banner could rise, the cheap form: surveyed open ground of a province the viewer's nation holds,
    // while the viewer's own record leaves room (its cap, its count in this province)
    if (nation !== null && holderNation === nation && me) {
      const here = (me.banners ?? []).filter(b => b.p === p && b.q === q).length;
      if ((capLeft === null || capLeft > 0) && (!int(me.perProvince) || here < me.perProvince)) for (const t of shown) if (!sites.has(t.idx)) out.canRise.push(t);
    }
    // ---- trails: a host's own last steps (they become land when that host raises a banner)
    for (const t of land.trails ?? []) {
      const tiles = hexesOf(p, q, t?.tiles);
      if (!tiles.length) continue;
      // (where its host stands: the record's own `tile`, else the page's roster)
      const mine = ownsHost(t.host), at = int(t.tile) ? { p, q, tile: t.tile } : viewer.hostAt?.(t.host) ?? null, ah = at && int(at.tile) ? hexOf(at.p, at.q, at.tile) : null;
      // (as it was walked: the far end first, the step beside the host last)
      const walked = ah ? [...tiles].sort((a, b) => hexDistance(b.q, b.r, ah.q, ah.r) - hexDistance(a.q, a.r, ah.q, ah.r)) : tiles;
      if (mine || tiles.some(seen)) out.trails.push({ key: `${p},${q},${t.host}`, host: String(t.host), nation: int(t.nation) ? t.nation : null, mine, p, q, tiles: walked, at: ah });
      sig.push(`t${t.host}:${tiles.map(x => x.idx).join('.')}`);
    }
    // ---- claims in progress: a fighting host standing on open ground where it could raise
    for (const r of land.rising ?? []) {
      const at = hexOf(p, q, Number(r?.tile));
      if (!at) continue;
      const mine = ownsHost(r.host), dial = dialOf(r.sinceTurn, r.canRaiseAtTurn, now);
      // (the land it would take: the record's own `patch` and `trail`; a record without them, the preview route's answer for where the host stands)
      const own = Array.isArray(r.patch) ? { ok: true, p, q, tile: at.idx, tiles: r.patch, trail: r.trail ?? [] } : null;
      const pre = own ?? (mine ? previews?.get?.(String(r.host)) ?? null : null);
      const ok = pre && pre.ok && pre.p === p && pre.q === q && pre.tile === at.idx;
      const row = { key: `${p},${q},${r.host}`, host: String(r.host), nation: int(r.nation) ? r.nation : null, mine, mate: !mine && nation !== null && r.nation === nation,
        // (on ground the viewer's nation holds, by another nation: the ghost banner with its dial)
        enemyHere: !mine && nation !== null && r.nation !== nation && holderNation === nation,
        p, q, at, dial, n: num(r.tiles), flower: ok ? hexesOf(p, q, pre.tiles).filter(t => !(pre.trail ?? []).includes(t.idx)) : [], tail: ok ? hexesOf(p, q, pre.trail) : [] };
      if (mine || seen(at)) out.rising.push(row);
      sig.push(`r${r.host}:${at.idx}:${dial?.left}/${dial?.total}:${row.flower.length}`);
    }
    // ---- the province from afar: who holds how many of its tiles (the holder has the rest)
    const counted = (Array.isArray(land.counted) ? land.counted : []).map(Number), paid = (Array.isArray(land.paid) ? land.paid : []).map(Number);
    const total = land.claim.length, others = counted.reduce((a, n, f) => a + (f === holderNation ? 0 : n || 0), 0);
    const shares = counted.map((n, f) => ({ nation: f, tiles: f === holderNation ? total - others : n || 0 })).filter(s => s.tiles > 0).sort((a, b) => (a.nation === holderNation ? -1 : b.nation === holderNation ? 1 : b.tiles - a.tiles));
    out.provinces.push({ key: `${p},${q}`, p, q, holder: holderNation, resolvedNext: now, counted, paid, total, shares, mineHere: (me?.banners ?? []).filter(b => b.p === p && b.q === q).length });
    sig.push(`c${counted.join('.')}`);
  }
  // ---- where a banner of the viewer's can be widened now: the viewer's own record says it host by host (`hosts[].dress[].tiles`)
  const buds = new Map();
  // (not the tile a host stands on while it could raise a banner of its own there: widened onto, that banner could not rise)
  for (const h of me?.hosts ?? []) {
    const own = h?.raise && (h.raise.ok || h.raise.code === 'StandLonger') ? Number(h.tile) : null;
    for (const d of h?.dress ?? []) for (const i of d?.tiles ?? []) { const t = int(h.p) && int(h.q) && Number(i) !== own ? hexOf(h.p, h.q, Number(i)) : null; if (t) buds.set(`${t.q},${t.r}`, { ...t, slot: d.slot, host: String(h.host) }); }
  }
  out.buds = [...buds.values()];
  // ---- the viewer's land as one shape: village land and banner land together (the gold line closes round the union)
  out.mine = { tiles: mineTiles, villageTiles: villageN, bannerTiles: bannerN, total: villageN + bannerN, banners: out.banners.filter(b => b.mine).length };
  out.events = events.map(protoEvent).filter(Boolean).map(e => ({ ...e, hexes: hexesOf(e.p, e.q, e.tiles), poleHex: hexOf(e.p, e.q, e.pole), key: int(e.slot) ? bannerKey(e.p, e.q, e.slot) : null,
    mine: (int(e.slot) && myBanners.has(bannerKey(e.p, e.q, e.slot))) || (e.holder !== null && holders.has(String(e.holder))) || (e.host !== null && ownsHost(e.host)),
    // (a banner of the viewer's that was taken or pulled down names the viewer in `from` or in what it was: the map asks its own memory too)
    fromNation: int(e.from) ? e.from : null }));
  out.rev = `${nation}|${myBanners.size}|${capLeft}|${out.buds.map(b => b.idx).join('.')}|${sig.join('|')}`;
  return out;
}

/** The banner of a model that holds hex (q, r), or whose pole stands there: the banner, or null. */
export function bannerOfHex(model, q, r) {
  for (const b of model?.banners ?? []) if (b.tiles.some(t => t.q === q && t.r === r)) return b;
  return null;
}
/**
 * What tile (q, r) is under the prototype, for a tip or a card: `{kind: 'banner' | 'village' | 'commons', mine,
 * mate, nation, banner?, village?}`, or null where the model says nothing of it (off, not loaded, not seen).
 */
export function protoLandAt(model, q, r) {
  if (!model?.on) return null;
  const b = bannerOfHex(model, q, r);
  if (b) return { kind: 'banner', mine: b.mine, mate: b.mate, nation: b.nation, banner: b };
  for (const v of model.villages) if (v.tiles.some(t => t.q === q && t.r === r)) return { kind: 'village', mine: v.mine, mate: v.mate, nation: v.nation, village: v };
  for (const c of model.commons) if (c.tiles.some(t => t.q === q && t.r === r)) return { kind: 'commons', mine: false, mate: false, ours: c.ours, nation: c.nation };
  return null;
}
