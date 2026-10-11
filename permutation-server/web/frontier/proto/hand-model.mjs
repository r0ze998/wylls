// The hand's reading of the prototype's records (PROTOTYPE-SPEC sections 5 to 8).
//
// "Standing Ground, the banner rule" is a DESIGN tried in the sample world: it is not in the program, the rules
// crate or the ABI, and nothing of it reaches a chain. Everything here reads records the sample world wrote
// (`FS.proto`, filled by controller.mjs only while the season record carries `sample.proto.claims`) and says them in
// words. No rule is decided here: whether a banner can rise, what it would take and what it costs are the world's
// answers (`rising` in the province's land record, the preview route, a refusal's code). The few numbers a sentence
// carries come from the records too.
//
//   FS.proto = {
//     claims     sample.proto.claims of /h/season: {rule, version, label: {ja, en}, scoreNote: {ja, en}, numbers, reduced}
//     lands      Map "p,q" → proto.land of /h/province/P,Q/latest: {resolvedNext, claim[61], banners[], trails[],
//                counted[6], paid[6], holderNation, rising[]}
//     me         proto.land of /h/me/<wallet>: {holder ("p,q,site"), tiles, paidTiles, villageTiles, banners[{p, q, slot, pole,
//                tiles (a count), frayed}], cap, perProvince, nextPrice, works, exploreLeftToday, walkPaidToday, ledger,
//                perTurn, shareOfNation, hosts[{host, p, q, tile, unit, stands, raise, onPole, fell, tend[], dress[]}]}
//                (`hosts`: what each of the viewer's hosts may do now, judged by the world: the bar is lit from it)
//     standings  /h/proto/standings
//     log        the PROTO_LAND records of /h/events, oldest first: {seq, op, turn, p, q, slot, pole, nation, holder,
//                tiles, from, fromHolder, works, by (the holder's key, "keeper" or "script"), host (its id), premise
//                (true: written when the world began)}
//     previews   Map key → {at, answer} of /h/proto/preview (the page's cache; a new settled turn asks again)
//   }
//
// Counts are said in turns (the HUD's word), with the clock time beside them at the sample world's own pace.
import { L, fmtNum, lang } from '../../lang.mjs';
import { TILE_OFFSETS, hexDistance, wedgeOf } from '../fgeo.mjs';
import { hostParts } from '../faddr.mjs';
import { BELL_SECS } from '../clock.mjs';
import { SCOUT, SETTLER, UNIT_ORDER, isFinal } from '../fland.mjs';
import { troopsOf } from '../fmarch.mjs';
import { ownHosts } from '../hud/subject.mjs';
import { factionName, unitCount, clientText } from '../fi18n.mjs';
import { placeName } from '../people/identity.mjs';

const int = Number.isInteger;

// ------------------------------------------------------------------ the switch and the label
/**
 * The prototype's own record in a season record, or null: only a sample world on a localnet record is believed, and
 * only a record that carries the label (the chip is drawn from it and from nothing else).
 */
export function claimsOf(record) {
  const c = record?.cluster === 'localnet' && record.sample?.world === 'sample' ? record.sample.proto?.claims ?? null : null;
  return c && typeof c === 'object' && typeof (c.label?.ja ?? c.label?.en) === 'string' ? c : null;
}
/** A `{ja, en}` pair in the page's language (the other one when this one is missing). */
export const inLang = pair => (pair ? (lang() === 'en' ? pair.en ?? pair.ja : pair.ja ?? pair.en) ?? '' : '');
/** The chip's words: the record's own label, nothing of the page's. */
export const labelText = claims => inLang(claims?.label);
/** The note under the score: the record's own. */
export const scoreNote = (claims, standings = null) => inLang(standings?.note ?? claims?.scoreNote);
/** The tag every line of the prototype carries. */
export const tag = () => L`試作`;

/** A fresh `FS.proto` for a claims record. */
export const emptyState = claims => ({ claims, lands: new Map(), me: null, standings: null, log: [], previews: new Map(), newsSeq: null, guide: { threat: false, walked: false } });

/**
 * The prototype's records in a page of /h/events (`kind: "PROTO_LAND"`, `proto: true`; they have no chain-shaped
 * body, so the chronicle's decoder passes them by): `[{seq, op, turn, p, q, slot, pole, nation, holder, tiles, from,
 * works, by}]`, in the page's order.
 */
export function landRecords(events = []) {
  const out = [];
  for (const e of events ?? []) {
    if (!e || e.proto !== true || String(e.kind ?? e.name ?? '') !== 'PROTO_LAND') continue;
    const body = e.record && typeof e.record === 'object' ? e.record : e.body && typeof e.body === 'object' ? e.body : {};
    out.push({ ...body, ...e, seq: String(e.seq ?? '') });
  }
  return out;
}
/** A log with a page's records added: no record twice (by `seq`), the last `max` kept. */
export function mergeLog(log, records, max = 240) {
  const seen = new Set(log.map(r => r.seq));
  return [...log, ...records.filter(r => r.seq !== '' && !seen.has(r.seq))].slice(-max);
}

// ------------------------------------------------------------------ turns and the clock beside them
/** Wall seconds a turn lasts in this world (a sample world declares its clock's rate), or null while its clock is stopped. */
export function turnWallSecs(FS) {
  if (FS.sample?.paused) return null;
  const rate = Number(FS.sample?.rate ?? FS.chain?.rate ?? 1);
  return rate > 0 ? BELL_SECS / rate : null;
}
/** A length of wall time, about: 約40秒 / 約9分 / 約4時間30分. */
export function aboutTime(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 90) return L`約${fmtNum(s)}秒`;
  if (s < 5400) return L`約${fmtNum(Math.round(s / 60))}分`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60 / 10) * 10;
  return m > 0 && m < 60 ? L`約${fmtNum(h)}時間${fmtNum(m)}分` : L`約${fmtNum(m >= 60 ? h + 1 : h)}時間`;
}
/** The clock time of `n` turns at this world's pace in brackets, or '' when the world's clock is stopped: 「（約9分）」. */
export const clockOf = (FS, n) => { const w = turnWallSecs(FS); return w === null || !(n > 0) ? '' : L`（${aboutTime(n * w)}）`; };

// ------------------------------------------------------------------ the land record
const ADJ = TILE_OFFSETS.map((a, i) => TILE_OFFSETS.map((b, j) => (i !== j && hexDistance(a.q, a.r, b.q, b.r) === 1 ? j : -1)).filter(j => j >= 0));
/** The tiles of the same province next to tile `t`. */
export const tilesBeside = t => ADJ[t] ?? [];
/** Steps between two tiles of one province. */
export const tileSteps = (a, b) => { const x = TILE_OFFSETS[a], y = TILE_OFFSETS[b]; return x && y ? hexDistance(x.q, x.r, y.q, y.r) : Infinity; };

export const landOf = (FS, p, q) => FS.proto?.lands?.get?.(`${p},${q}`) ?? null;
export const meOf = FS => FS.proto?.me ?? null;
export const nationOf = FS => (int(FS.citizen?.faction) && FS.citizen.faction >= 0 && FS.citizen.faction < 6 ? FS.citizen.faction : null);
/** A rule's number by its name in the record's table (the table is the record's: the page keeps no copy), or null. */
export function numberOf(FS, ...names) {
  const n = FS.proto?.claims?.numbers ?? null;
  if (!n) return null;
  for (const k of names) {
    const v = n[k] ?? n[k.toLowerCase()] ?? n[k.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** What a tile is in a land record: {kind: 'open'} · {kind: 'village', site} · {kind: 'banner', slot, banner} · {kind: 'unknown'}. */
export function kindAt(land, tile) {
  const c = land?.claim?.[tile];
  if (!int(c)) return { kind: 'unknown' };
  if (c === 0xff) return { kind: 'open' };
  if (c >= 16 && c <= 31) return { kind: 'banner', slot: c - 16, banner: (land.banners ?? []).find(b => b.slot === c - 16) ?? null };
  if (c >= 0 && c < 12) return { kind: 'village', site: c };
  return { kind: 'unknown' };
}

const ownKeys = FS => new Set((meOf(FS)?.banners ?? []).map(b => `${b.p},${b.q},${b.slot}`));
/** Whether banner `b` of province (p, q) is the viewer's: the viewer's own record lists it. */
export const isOwnBanner = (FS, p, q, b) => !!b && ownKeys(FS).has(`${p},${q},${b.slot}`);
/** Whether a host id is one of the viewer's (its province, site and generation are one of the viewer's villages). */
export function isOwnHost(FS, id) {
  let h = null;
  try { h = hostParts(id); } catch { h = null; }
  return !!h && (FS.holdings ?? []).some(o => o.p === h.p && o.q === h.q && o.site === h.site && (o.gen === undefined || o.gen === h.gen));
}
/** The key the world names a holder by: "p,q,site" of the player's village. `{p, q, site}`, or null for any other text ("keeper", "script"). */
export function holderPlace(key) {
  const m = /^(-?\d+),(-?\d+),(\d+)$/.exec(String(key ?? ''));
  return m ? { p: Number(m[1]), q: Number(m[2]), site: Number(m[3]) } : null;
}
/** Whether a holder's key is the viewer's: the key of the viewer's own record, or the place of one of the viewer's villages. */
export function isOwnHolder(FS, key) {
  if (key === undefined || key === null) return false;
  const mine = FS.proto?.known?.holder ?? FS.proto?.me?.holder ?? null;
  if (mine !== null && String(key) === String(mine)) return true;
  const at = holderPlace(key);
  return !!at && (FS.holdings ?? []).some(o => o.p === at.p && o.q === at.q && o.site === at.site);
}
/**
 * What the records have shown of the viewer so far, kept in `FS.proto.known`: the banners the viewer's own record has
 * listed (a banner that was taken or pulled down is no longer listed when its record is read) and the key the world
 * names the viewer by as a holder (read off a banner the viewer's record lists).
 */
export function learn(FS) {
  const P = FS.proto;
  if (!P) return null;
  const known = (P.known ??= { banners: new Set(), holder: null });
  for (const b of P.me?.banners ?? []) {
    known.banners.add(`${b.p},${b.q},${b.slot}`);
    const rec = (P.lands.get(`${b.p},${b.q}`)?.banners ?? []).find(x => x.slot === b.slot);
    if (rec && rec.holder !== undefined && rec.holder !== null) known.holder = String(rec.holder);
  }
  if (P.me?.holder !== undefined && P.me?.holder !== null) known.holder = String(P.me.holder);
  return known;
}
const isHostId = x => x !== undefined && x !== null && /^\d+$/.test(String(x));
/** Whether a log record was the viewer's own doing: one of the viewer's hosts did it, or the viewer as a holder (`by`). */
export function isOwnDoing(FS, r) {
  if (!r) return false;
  learn(FS);
  if (isHostId(r.host) && isOwnHost(FS, String(r.host))) return true;
  if (isHostId(r.by)) return isOwnHost(FS, String(r.by));
  return isOwnHolder(FS, r.by);
}
/** Whether a log record is about a banner that is, or has been, the viewer's. */
export function isOwnBannerRecord(FS, r) {
  if (!r) return false;
  const known = learn(FS);
  if (r.fromHolder !== undefined && r.fromHolder !== null) return isOwnHolder(FS, r.fromHolder);
  return int(r.slot) && (ownKeys(FS).has(`${r.p},${r.q},${r.slot}`) || !!known?.banners.has(`${r.p},${r.q},${r.slot}`));
}
/** Whether a log record is of the viewer's own doing or holding. */
export function isOwnRecord(FS, r) {
  if (!r) return false;
  return isOwnDoing(FS, r) || isOwnBannerRecord(FS, r) || isOwnHolder(FS, r.holder);
}

/** A count that runs in settled turns: {left, done, lag (the province is behind the clock: the count waits for it)}. */
export function countTo(FS, atTurn, r) {
  if (!int(atTurn) || !int(r)) return { left: null, done: false, lag: true };
  const left = Math.max(0, atTurn - r);
  return { left, done: left === 0, lag: left > 0 && r + clockLag(FS) < (FS.nowBell ?? 0) };
}
/** How many turns the settled turn of a province normally stands behind the clock's (the record says: 1), for a count's "it lags" and a march's "from turn N". */
export const clockLag = FS => (int(FS.proto?.claims?.clockLag) ? FS.proto.claims.clockLag : 1);

/** A fighting host (the rule: Scouts and Settlers never raise or take). */
export const fights = row => !!row && row.unit !== SCOUT && row.unit !== SETTLER;

// ------------------------------------------------------------------ who stands where, and how many (the public roster)
/**
 * The fighting host of `nation` that stands on a tile, from the province's public roster as the page holds it:
 * `{unit, troops}` (whole troops; the largest when several stand there), or null (nobody of that nation there, or the
 * province's record is not on the page).
 */
export function hostOn(FS, p, q, tile, nation) {
  const pv = FS.provinces?.get?.(`${p},${q}`)?.province ?? null;
  const list = (pv?.entries ?? []).filter(e => e.tile === tile && e.faction === nation && e.state === 1 && e.unit !== SCOUT && e.unit !== SETTLER);
  if (!list.length) return null;
  const e = list.reduce((a, b) => (Number(b.troops) > Number(a.troops) ? b : a));
  return { unit: e.unit, troops: troopsOf(e.troops) };
}
/** Whether the page holds the roster of a province (so that "nobody stands there" can be said of a tile of it). */
export const rosterKnown = (FS, p, q) => Array.isArray(FS.provinces?.get?.(`${p},${q}`)?.province?.entries);
/**
 * How many the viewer can put in the field now: `{host (the largest fighting host that stands), reserve (the largest
 * host the reserve could form), best}`, in whole troops. Numbers of the records; no battle is judged here.
 */
export function strengthOf(FS) {
  let rows = [];
  try { rows = ownHosts(FS).filter(fights); } catch { rows = []; }
  const home = (FS.holdings ?? [])[0] ?? null;
  const host = Math.max(0, ...rows.map(r => Number(r.troops) || 0));
  const reserve = Math.max(0, ...[0, 1, 2, 3, 4, 5].map(u => Number(home?.reserve?.[u] ?? 0)));
  return { host, reserve, best: Math.max(host, reserve) };
}
/** Whether the viewer's first village is final for an order of its own province (a new village is provisional for a while: no host is formed from it then). True when the page cannot tell. */
export function villageFinal(FS) {
  const h = (FS.holdings ?? [])[0] ?? null;
  if (!h) return true;
  try { return isFinal(h, FS.provinces?.get?.(`${h.p},${h.q}`)?.province ?? null, FS.chain?.now?.() ?? 0, FS.nowBell ?? 0); } catch { return true; }
}

// ------------------------------------------------------------------ the preview's cache
/** The key of a preview: who, where, and the settled turn it was asked at. */
export const previewKey = (FS, { host = null, p, q, tile, troops = null }) => `${host ?? `new:${troops ?? ''}`}|${p},${q},${tile}|${landOf(FS, p, q)?.resolvedNext ?? ''}|${meOf(FS)?.works ?? ''}|${(meOf(FS)?.banners ?? []).length}`;
/** The answer held for a preview, or undefined while none has come. */
export const previewOf = (FS, x) => FS.proto?.previews?.get?.(previewKey(FS, x))?.answer;

// ------------------------------------------------------------------ what a host of the viewer's can do with banners
/** What the world says one of the viewer's hosts may do now (`hosts` of the viewer's own record), or null when the record does not carry it. */
export const hostActs = (FS, id) => (meOf(FS)?.hosts ?? []).find(h => String(h.host) === String(id)) ?? null;

/**
 * A host of the viewer's and the banners (hud/subject.mjs rows): null with the prototype off, else
 *   {fighting, loading}                                  the province's land record has not come yet
 *   {fighting, r, mode, …}
 *     mode 'foe'     it stands on another nation's pole: {banner, count, refusal (why it can do neither), noTake (why not: {code} | {stop})}
 *     mode 'rising'  it stands where a banner can rise: {count, size, answer (the world's: tiles, trail, size, price)}
 *     mode 'own'     it stands in or beside a banner of the viewer's nation: {banner, mine, inPatch, tend, dress}
 *                    (`tend`: {ok, code, need, paysToday} | null; `dress`: {tiles, code} | null — the world's, when it serves them)
 *     mode 'none'    none of these: {preview} says why no banner can rise here
 * The world's own judgement (`hosts` of /h/me) is read first; where a world does not serve it, the land record's
 * `rising` and `contested` and the preview route are.
 */
export function hostSituation(FS, row) {
  if (!FS.proto || !row) return null;
  const fighting = fights(row);
  const land = landOf(FS, row.p, row.q);
  if (!land) return { fighting, loading: true, mode: 'none' };
  const r = land.resolvedNext, nation = nationOf(FS), id = String(row.id);
  const banners = land.banners ?? [], acts = hostActs(FS, id);
  const bySlot = slot => banners.find(b => b.slot === slot) ?? null;
  // ---- another nation's pole under it
  const foe = fighting ? (acts?.fell ? bySlot(acts.fell.slot) : banners.find(b => b.pole === row.tile && b.nation !== nation)) ?? null : null;
  if (foe) {
    const me = meOf(FS), held = (me?.banners ?? []).length, here = (me?.banners ?? []).filter(b => b.p === row.p && b.q === row.q).length;
    if (acts?.fell) {
      const f = acts.fell, waiting = !f.ok && f.code === 'StandLonger';
      return { fighting, r, mode: 'foe', banner: foe, count: f.ok ? { left: 0, done: true, lag: false } : waiting ? countTo(FS, f.atTurn ?? f.need?.atTurn, r) : { left: null, done: false, lag: false },
        refusal: !f.ok && !waiting ? { code: f.code, need: f.need } : null, noTake: f.canTake === false || f.onlyPull ? { stop: f.onlyPull ?? 'place' } : null };
    }
    const mine = foe.contested && String(foe.contested.host) === id;
    const noTake = me && int(me.cap) && held >= me.cap ? { stop: 'cap' } : me && here >= (me.perProvince ?? 2) ? { stop: 'perProvince' } : foe.contested?.onlyPull && mine ? { stop: foe.contested.onlyPull } : null;
    return { fighting, r, mode: 'foe', banner: foe, count: mine ? countTo(FS, foe.contested.canTakeAtTurn, r) : { left: null, done: false, lag: true }, refusal: null, noTake };
  }
  const tendOf = slot => (acts?.tend ?? []).find(t => t.slot === slot) ?? null, dressOf = slot => (acts?.dress ?? []).find(d => d.slot === slot) ?? null;
  // (a banner of the viewer's own that the world says this host could widen today from where it stands — it stands
  // beside a tile next to that banner's land — while the host's own card is about raising a banner of its own)
  // (never with the tile the host itself stands on: the world would take it, and this host's own banner could then
  // not rise there — the checker's play lost a banner that way. The tile is left out of what the card offers)
  const widenOf = () => {
    for (const x of acts?.dress ?? []) {
      const tiles = (x.tiles ?? []).filter(t => t !== row.tile), b = tiles.length ? bySlot(x.slot) : null;
      if (b && isOwnBanner(FS, row.p, row.q, b) && isOwnHolder(FS, b.holder)) return { banner: b, dress: { ...x, tiles }, tend: tendOf(b.slot), mine: true, inPatch: (b.tiles ?? []).includes(row.tile) };
    }
    return null;
  };
  // ---- where a banner can rise
  const rise = fighting ? (land.rising ?? []).find(x => String(x.host) === id) ?? null : null;
  const a = fighting ? acts?.raise ?? null : null;
  if (a && (a.ok || a.code === 'StandLonger')) {
    const count = a.ok ? { left: 0, done: true, lag: false } : countTo(FS, a.atTurn ?? a.need?.atTurn ?? rise?.canRaiseAtTurn, r);
    return { fighting, r, mode: 'rising', rising: rise, count, size: int(a.size) ? a.size : sizeOf(rise), answer: { ...a, ok: true }, widen: widenOf() };
  }
  if (!a && rise) return { fighting, r, mode: 'rising', rising: rise, count: countTo(FS, rise.canRaiseAtTurn, r), size: sizeOf(rise), answer: previewOf(FS, { host: id, p: row.p, q: row.q, tile: row.tile }), widen: widenOf() };
  // ---- a banner of the viewer's nation it stands in or beside
  const own = banners.filter(b => isOwnBanner(FS, row.p, row.q, b));
  const near = b => (b.tiles ?? []).includes(row.tile) || (b.tiles ?? []).some(t => tilesBeside(row.tile).includes(t));
  const mineHere = own.find(b => (b.tiles ?? []).includes(row.tile)) ?? own.find(near) ?? null;
  if (mineHere) return { fighting, r, mode: 'own', banner: mineHere, mine: true, inPatch: (mineHere.tiles ?? []).includes(row.tile), tend: tendOf(mineHere.slot), dress: dressOf(mineHere.slot) };
  const mate = (acts?.tend ?? []).map(t => bySlot(t.slot)).find(Boolean) ?? null;
  if (mate) return { fighting, r, mode: 'own', banner: mate, mine: false, inPatch: (mate.tiles ?? []).includes(row.tile), tend: tendOf(mate.slot), dress: null };
  return { fighting, r, mode: 'none', preview: fighting ? (a ?? previewOf(FS, { host: id, p: row.p, q: row.q, tile: row.tile })) : undefined };
}
const sizeOf = x => (!x ? null : int(x.tiles) ? x.tiles : Array.isArray(x.tiles) ? x.tiles.length : Array.isArray(x.patch) ? x.patch.length : null);

/**
 * Where a banner's land could take one more tile (a hint for the board's lit tiles; the world judges the order):
 * open ground next to the patch within two steps of the pole, with a host of the viewer's on it or beside it.
 */
export function dressTiles(FS, p, q, banner, hosts = []) {
  const land = landOf(FS, p, q);
  if (!land || !banner) return [];
  const patch = new Set(banner.tiles ?? []), near = new Set();
  for (const h of hosts) if (h.p === p && h.q === q) { near.add(h.tile); for (const t of tilesBeside(h.tile)) near.add(t); }
  const out = [];
  for (let t = 0; t < TILE_OFFSETS.length; t++) {
    if (patch.has(t) || kindAt(land, t).kind !== 'open' || tileSteps(t, banner.pole) > 2) continue;
    if (!tilesBeside(t).some(x => patch.has(x)) || !near.has(t)) continue;
    out.push({ p, q, tile: t });
  }
  return out;
}

// ------------------------------------------------------------------ words
/** A holder by the name of its village (「イスフォード」), from the key the world names it by; '' when the key is no place. */
export function holderName(key) {
  const at = holderPlace(key);
  if (!at) return '';
  try { return placeName(at.p, at.q, at.site)[lang() === 'en' ? 'en' : 'ja'] ?? ''; } catch { return ''; }
}

/** How often a banner must be walked, from its own record: 「3日に1回」 / 「1日に1回」 / 「100ターンに1回」. */
export function walkEvery(b) {
  const every = int(b?.walkDue) && int(b?.tendedTurn) ? b.walkDue - b.tendedTurn : null;
  if (!(every > 0)) return '';
  return every % 144 === 0 ? L`${fmtNum(every / 144)}日に1回` : L`${fmtNum(every)}ターンに1回`;
}

/**
 * A banner in words, as the board's tip and the cards say it: `[{text, tone?}]`, the first line what it is.
 * `r`: the province's settled turn.
 */
export function bannerLines(FS, p, q, b, r = landOf(FS, p, q)?.resolvedNext ?? null) {
  if (!b) return [];
  const nation = nationOf(FS), own = isOwnBanner(FS, p, q, b), out = [];
  const every = walkEvery(b);
  if (own) out.push({ text: b.firm ? (every ? L`あなたの旗（しっかり立っています・${every}の見回り）` : L`あなたの旗（しっかり立っています）`) : (every ? L`あなたの旗（他国の州：${every}の見回りが必要）` : L`あなたの旗（他国の州）`) });
  else if (b.nation === nation) out.push({ text: holderName(b.holder) ? L`同じ国の${holderName(b.holder)}の旗` : L`同じ国の仲間の旗` });
  else out.push({ text: holderName(b.holder) ? L`${factionName(b.nation)}の旗（${holderName(b.holder)}）` : L`${factionName(b.nation)}の旗` });
  out.push({ text: L`${fmtNum((b.tiles ?? []).length)}マス`, quiet: true });
  if (own && (b.border ?? []).length) {
    const fall = numberOf(FS, 'FALL_LOOSE');
    out.push({ text: fall ? L`国境に触れています：向かいの国には${fmtNum(fall)}ターンで取られます` : L`国境に触れています：向かいの国には早く取られます`, tone: 'warn' });
  }
  if (b.contested && int(r)) {
    const c = countTo(FS, b.contested.canTakeAtTurn, r);
    // (the viewer's own banner with a host of the viewer's nation on its pole: a record read a moment after a taking — no threat)
    if (own && b.contested.nation !== nation) out.push({ text: threatText(FS, c, b.contested.onlyPull), tone: 'bad' });
    else if (!own && b.contested.nation === nation) out.push({ text: c.done ? L`わたしたちの軍勢が立っています：もう取るか倒せます` : L`わたしたちの軍勢が立っています：あと${fmtNum(c.left)}ターン${clockOf(FS, c.left)}`, tone: 'good' });
  }
  if (own && b.frayed) {
    const left = int(b.strikeAt) && int(r) ? Math.max(0, b.strikeAt - r) : null;
    out.push({ text: left === null ? L`ほつれています：いまは得点になりません` : L`ほつれています：いまは得点になりません。${fmtNum(left)}ターン${clockOf(FS, left)}のうちに見回れば戻ります`, tone: 'bad' });
  } else if (own && int(b.walkDue) && int(r) && b.walkDue - r <= 48) {
    const left = Math.max(0, b.walkDue - r);
    out.push({ text: L`あと${fmtNum(left)}ターン${clockOf(FS, left)}のうちに見回ってください（新しく着いた軍勢で）`, tone: 'warn' });
  }
  return out;
}

/**
 * Every refusal of the prototype's orders and previews as one plain sentence, with the number it needs
 * (PROTOTYPE-SPEC section 5). `x.need`: what the answer carried — a number, or the world's own object (`{tolls,
 * atTurn}`, `{troops, have}`, `{short}`, `{why}`, `{turn}`, `{since}`, `{cap, held}`, `{perProvince}`, `{reach}`, …);
 * `x.why`, `x.turn`, `x.cap`, `x.held`, `x.perProvince`: the same things where the page's own records say them.
 */
export function refusalText(code, x = {}) {
  const obj = x.need && typeof x.need === 'object' ? x.need : {};
  const plain = typeof x.need === 'number' || (typeof x.need === 'string' && x.need !== '' && Number.isFinite(Number(x.need))) ? Number(x.need) : null;
  const num = (...keys) => { for (const k of keys) { const v = obj[k] ?? x[k]; if (Number.isFinite(Number(v)) && v !== null && v !== '') return Number(v); } return plain; };
  const why = String(obj.why ?? x.why ?? '').toLowerCase();
  switch (code) {
    case 'NotResident': return L`この州の集計を待っています。少しあとでもう一度どうぞ`;
    case 'HostBusy': return L`この軍勢は、いまは動かせません`;
    case 'InTransit': return L`進軍中の軍勢では旗を扱えません`;
    case 'Scouts': return L`斥候は旗を立てたり取ったりできません`;
    case 'StandLonger': { const n = num('tolls'); return n !== null ? L`あと${fmtNum(n)}ターン立たせてください` : L`もう少し立たせてください`; }
    case 'TooFew': { const n = num('troops'); return n !== null ? L`兵が足りません：${fmtNum(n)}人以上の軍勢が要ります` : L`兵が足りません`; }
    case 'NotSurveyed': return L`まだ測量していません（進軍して着けば測量は要りません）`;
    case 'NotOpen':
      if (why === 'impassable') return L`山や水のマスには旗を立てられません`;
      if (why === 'village') return L`ここは村の土地です`;
      if (why === 'banner') return L`ここはもう旗の土地です`;
      if (why === 'enemy') return L`敵の軍勢が立っています`;
      return L`ここはもう誰かの土地です`;
    case 'SiteOrCamp': return why === 'camp' ? L`野営地やそのとなりには旗を立てられません` : L`村を置く場所には旗を立てられません`;
    case 'SiteRoom': return L`この空き地のとなりには、もう旗が2本あります`;
    case 'PatchTooSmall': { const n = num('tiles'); return n !== null ? L`土地にできるマスが少なすぎます（${fmtNum(n)}マスから）` : L`土地にできるマスが少なすぎます`; }
    case 'NotHere':
      if (why.includes('heart')) return L`他国の中核地です`;
      if (why.includes('town')) return L`町になってから`;
      if (why === 'ring') return L`この土地には、まだ旗を立てられません`;
      if (why === 'muster') return L`編成できるのは、村のある州の中だけです`;
      return L`わたしたちの土地に接していません`;
    case 'Heartland': return L`他国の中核地です`;
    case 'SameNation': return L`同じ国の旗です`;
    case 'CapReached': { const cap = num('cap'), held = obj.held ?? x.held ?? cap; return cap !== null && int(cap) ? L`旗は ${fmtNum(held)}/${fmtNum(cap)} 本：村の段階が上がると増えます` : L`旗の本数が上限です：村の段階が上がると増えます`; }
    case 'PerProvince': return L`この州の旗は${fmtNum(obj.perProvince ?? x.perProvince ?? 2)}本までです：次の旗は別の州へ`;
    case 'CeilingReached': return L`この州で持てる土地の上限に届いています`;
    case 'WorksShort': { const n = num('short'); return n !== null ? L`功績があと${fmtNum(n)}足りません` : L`功績が足りません`; }
    case 'SlotsFull': return L`この州には、もう旗を立てる余地がありません`;
    case 'ElbowNotAllowed': return L`ここでは土地を分けてもらえません`;
    case 'Changed': return L`条件が変わりました。もう一度確かめてください`;
    case 'NotYours': return L`あなたの旗ではありません`;
    case 'Contested': return L`敵が立っているあいだは、取り下げも広げることもできません`;
    case 'DressedToday': return L`この旗は、今日はもう広げました（1日1回）`;
    case 'PatchFull': return L`この旗の土地は、これ以上広げられません`;
    case 'Denied': return L`敵の軍勢が近すぎます`;
    case 'TooFar': { const n = obj.reach ?? null; return int(n) ? L`旗から遠すぎます（旗から${fmtNum(n)}マスまで）` : L`旗から遠すぎます`; }
    case 'NoHostBeside': return L`そのマスのとなりに、あなたの軍勢がいません`;
    case 'NotOnPole': return L`旗の立っているマスに軍勢を立たせてください`;
    case 'NotPastGrace': return L`まだ引き継げません`;
    case 'NotInPatch': return L`旗の土地の中に軍勢を立たせてください`;
    case 'NotBeside': return L`旗の土地か、そのとなりに軍勢を立たせてください`;
    case 'NotArrivedSince': return L`見回りは、前の見回りのあとに着いた軍勢でします`;
    case 'TooLate': return L`この旗はもうありません`;
    case 'NotDue': return L`まだその時ではありません`;
    case 'ElbowLocked': { const t = num('turn'); return t !== null && int(t) ? L`ターン ${fmtNum(t)} までは取り下げられません` : L`まだ取り下げられません`; }
    case 'ExploreLimit': return L`今日はここまでです（このマスは未探索のまま残ります）`;
    case 'Off': return L`旗の試作は、この世界では動いていません`;
    case 'BadOp': return L`この命令は、旗の試作では出せません`;
    default: return clientText(code);
  }
}
/**
 * Why a banner on whose pole a host stands can only be pulled down, not taken (the world's `onlyPull`: cap,
 * perProvince, ceiling, town, place), as one sentence.
 */
export function takeStopText(stop, x = {}) {
  switch (stop) {
    case 'cap': return refusalText('CapReached', x);
    case 'perProvince': return refusalText('PerProvince', x);
    case 'ceiling': return refusalText('CeilingReached', x);
    case 'town': return refusalText('NotHere', { why: 'town' });
    default: return L`わたしたちの土地にも国境にも接していません`;
  }
}
/** The codes this page says in its own words (a test checks each has a sentence in both languages). */
export const REFUSALS = Object.freeze(['NotResident', 'HostBusy', 'InTransit', 'Scouts', 'StandLonger', 'TooFew', 'NotSurveyed', 'NotOpen', 'SiteOrCamp', 'SiteRoom', 'PatchTooSmall', 'NotHere', 'Heartland', 'SameNation', 'CapReached',
  'PerProvince', 'CeilingReached', 'WorksShort', 'SlotsFull', 'ElbowNotAllowed', 'Changed', 'NotYours', 'Contested', 'DressedToday', 'PatchFull', 'Denied', 'TooFar', 'NoHostBeside', 'NotOnPole', 'NotPastGrace',
  'NotInPatch', 'NotBeside', 'NotArrivedSince', 'TooLate', 'NotDue', 'ElbowLocked', 'ExploreLimit']);
/** The codes the page's own modules of the prototype return (proto/orders.mjs): said here too, not in the page's table of errors. */
export const OWN_CODES = Object.freeze(['Off', 'BadOp']);

/**
 * What the world says of a banner at a place, in one line: 「+7マス・1ターン」, or the refusal's sentence. `{ok, text,
 * size, wait, price}`; null while no answer has come. (A host that only has to stand longer is told what it will
 * raise: the world sends the patch with that refusal.)
 */
export function previewLine(FS, a) {
  if (a === undefined || a === null) return null;
  const waits = !a.ok && a.code === 'StandLonger' && (int(a.size) || Array.isArray(a.tiles));
  if (a.ok || waits) {
    const size = int(a.size) ? a.size : (a.tiles ?? []).length;
    const wait = int(a.waitTurns) ? a.waitTurns : int(a.need?.tolls) ? a.need.tolls : null;
    return { ok: true, size, wait, price: int(a.price) ? a.price : 0, text: wait === null ? L`+${fmtNum(size)}マス` : wait === 0 ? L`+${fmtNum(size)}マス・いますぐ` : L`+${fmtNum(size)}マス・${fmtNum(wait)}ターン` };
  }
  const me = meOf(FS);
  return { ok: false, code: a.code ?? null, text: refusalText(a.code, { need: a.need, why: a.why, turn: a.turn, cap: me?.cap, held: (me?.banners ?? []).length, perProvince: me?.perProvince }) };
}
/**
 * A banner here was said to bring more when the player chose the place (`FS.proto.promised`, app.mjs) than the world
 * gives now: `{was, now, toLand (tiles of the promise that have become somebody's land since), other}`, or null when
 * nothing was promised here or nothing shrank.
 */
export function promiseShort(FS, p, q, tile, size) {
  const pr = FS.proto?.promised?.get?.(`${p},${q},${tile}`) ?? null, land = landOf(FS, p, q);
  if (!pr || !int(size) || !(pr.size > size) || !land) return null;
  const toLand = pr.tiles.filter(t => kindAt(land, t).kind !== 'open').length, lost = pr.size - size;
  return { was: pr.size, now: size, toLand: Math.min(lost, toLand), other: Math.max(0, lost - toLand) };
}
/** How a patch is made up: `{flower, trail}` (the tiles round the pole; the walk behind the host). The world's `tiles` holds both. */
export function patchParts(a) {
  if (!a) return { flower: null, trail: null };
  const trail = Array.isArray(a.trail) ? a.trail.length : 0;
  const all = int(a.size) ? a.size : (a.tiles ?? []).length;
  return { flower: Array.isArray(a.flower) ? a.flower.length - (a.flower.some(t => (a.trail ?? []).includes(t)) ? trail : 0) : Math.max(0, all - trail), trail };
}

/** What the day's first walk or widening pays, from the record's table (null when the record does not say). */
export const walkPay = FS => numberOf(FS, 'WALK_PAY');

/** The price of a banner in words: 「功績 8」, or that it is free. */
export const priceText = price => (price > 0 ? L`功績 ${fmtNum(price)}` : L`功績はかかりません`);

// ------------------------------------------------------------------ the plate
/**
 * The plate's lines, from the viewer's own record: `{tiles, village, banner, held, cap, nextPrice, works, perTurn,
 * share (percent of the nation's, or null), explore}`; null while the record has not come.
 */
export function plateModel(FS) {
  const me = meOf(FS);
  if (!me) return null;
  const tiles = Number(me.tiles ?? 0), village = Number(me.villageTiles ?? 0);
  // (a share of nothing is not said: before the first turn has been counted in the viewer's name the record's share is 0, and
  // the plate read 「あなたの名で 7マス（毎ターン+7、国の0.0%）」 — seven tiles that are no part of the nation)
  const share = Number.isFinite(me.shareOfNation) && me.shareOfNation > 0 ? (me.shareOfNation <= 1 ? me.shareOfNation * 100 : me.shareOfNation) : null;
  const home = (FS.holdings ?? [])[int(FS.activeHolding) && FS.activeHolding >= 0 && FS.activeHolding < (FS.holdings ?? []).length ? FS.activeHolding : 0] ?? null;
  const here = home ? (me.banners ?? []).filter(b => b.p === home.p && b.q === home.q).length : 0;
  return { here, per: int(me.perProvince) ? me.perProvince : null, tiles, village, banner: Math.max(0, tiles - village), held: (me.banners ?? []).length, cap: int(me.cap) ? me.cap : null, nextPrice: int(me.nextPrice) ? me.nextPrice : null,
    works: int(me.works) ? me.works : null, perTurn: Number(me.perTurn ?? me.paidTiles ?? tiles), share, explore: int(me.exploreLeftToday) ? me.exploreLeftToday : null, walkPaid: !!me.walkPaidToday };
}
/** 「あなたの土地 16マス（村7・旗9）」 */
export const plateLand = m => (m.banner > 0 ? L`あなたの土地 ${fmtNum(m.tiles)}マス（村${fmtNum(m.village)}・旗${fmtNum(m.banner)}）` : L`あなたの土地 ${fmtNum(m.tiles)}マス`);
/** 「旗 1/5」, and once the village's own province holds a banner of the viewer's, 「旗 2/5 · この州 2/2」 */
export function plateBanners(m) {
  const all = m.cap === null ? L`旗 ${fmtNum(m.held)}` : L`旗 ${fmtNum(m.held)}/${fmtNum(m.cap)}`;
  return m.here > 0 && m.per !== null ? L`${all} · この州 ${fmtNum(m.here)}/${fmtNum(m.per)}` : all;
}
/** 「つぎの旗：功績 8」 */
// (the cap reached: there is no next banner to price — on real records the plate said 「旗 5/5 · つぎの旗：功績 12」)
export const plateNext = m => (m.cap !== null && m.held >= m.cap ? L`旗はこれ以上立てられません` : m.nextPrice === null ? '' : m.nextPrice > 0 ? L`つぎの旗：功績 ${fmtNum(m.nextPrice)}` : L`つぎの旗：無料`);
/** 「あなたの名で 16マス（毎ターン+16、国の2.4%）」 */
export const plateLedger = m => (m.share === null ? L`あなたの名で ${fmtNum(m.tiles)}マス（毎ターン+${fmtNum(m.perTurn)}）` : L`あなたの名で ${fmtNum(m.tiles)}マス（毎ターン+${fmtNum(m.perTurn)}、国の${pct(m.share)}%）`);
const pct = x => (Math.round(x * 10) / 10).toFixed(1);
/** A share as the ticker says it: 「17.2」. */
export const pctText = pct;

// ------------------------------------------------------------------ the score
/**
 * The six nations by share of all tile-turns, largest first: `{turn, rows: [{nation, share (percent), tilesNow,
 * paidNow, mine}], note}`; null while the record has not come.
 */
export function standingsModel(FS) {
  const s = FS.proto?.standings ?? null;
  if (!s || !Array.isArray(s.nations)) return null;
  const sum = s.nations.reduce((a, n) => a + (Number(n.share) || 0), 0);
  const scale = sum > 1.5 ? 1 : 100;
  const mine = nationOf(FS);
  const rows = s.nations.map(n => ({ nation: n.nation, share: (Number(n.share) || 0) * scale, tilesNow: Number(n.tilesNow ?? 0), paidNow: Number(n.paidNow ?? 0), mine: n.nation === mine }))
    .sort((a, b) => b.share - a.share || a.nation - b.nation);
  return { turn: int(s.turn) ? s.turn : null, rows, note: scoreNote(FS.proto.claims, s) };
}

// ------------------------------------------------------------------ the province card
/**
 * A province's land in numbers: `{segments: [{nation, n, held (tiles under villages and banners), commons}],
 * counts: [{nation, paid}], holder, mine: {nation, counted, ceiling (null in the nation's own province)}, banners:
 * {here, per}}`; null without its land record.
 */
export function provinceCard(FS, p, q) {
  const land = landOf(FS, p, q);
  if (!land || !Array.isArray(land.paid)) return null;
  const nation = nationOf(FS), holder = int(land.holderNation) ? land.holderNation : wedgeOf(p, q);
  const segments = [];
  for (let n = 0; n < 6; n++) {
    const paid = Number(land.paid[n] ?? 0), counted = Math.min(paid, Number(land.counted?.[n] ?? 0));
    if (paid > 0) segments.push({ nation: n, n: paid, held: counted, commons: n === holder ? paid - counted : 0 });
  }
  segments.sort((a, b) => (b.nation === holder) - (a.nation === holder) || b.n - a.n);
  const me = meOf(FS);
  const here = (me?.banners ?? []).filter(b => b.p === p && b.q === q).length;
  return { p, q, holder, segments, counts: segments.map(s => ({ nation: s.nation, paid: s.n })),
    mine: nation === null ? null : { nation, counted: Number(land.counted?.[nation] ?? 0), ceiling: nation === holder ? null : int(land.ceiling) ? land.ceiling : numberOf(FS, 'KEEP_SHARE', 'CEILING_ABROAD') },
    banners: { here, per: me?.perProvince ?? null } };
}

// ------------------------------------------------------------------ what happened: lines from the log's records
const opOf = r => String(r.op ?? '').toUpperCase();
const tilesN = r => (Array.isArray(r.tiles) ? r.tiles.length : int(r.tiles) ? r.tiles : 0);

/**
 * A PROTO_LAND record as a line of the feed, or null for a record that is no news to this viewer:
 * `{id, kind: 'proto', proto: true, bell, p, q, tile, text, quiet?, banner?: {p, q, slot}}`. Every line is one the
 * world wrote a record for; the page adds nothing.
 */
export function newsOf(FS, r) {
  const nation = nationOf(FS), did = isOwnDoing(FS, r), held = isOwnBannerRecord(FS, r);
  // (`bell`: the turn the line is told in, by the clock; the record's own `turn` is the province's settled turn, a turn behind it)
  // (never a turn earlier than the one in which the world can have written it — its settled turn and the record's own
  // `clockLag`: a page that read the record a moment before it read the clock stamped a loss with the turn that had
  // just ended, and the list of what happened this turn did not hold it)
  const told = int(r.turn) ? r.turn + clockLag(FS) : null;
  const base = { id: `pl:${r.seq}`, kind: 'proto', proto: true, bell: int(FS.nowBell) ? Math.max(FS.nowBell, told ?? FS.nowBell) : told, settled: int(r.turn) ? r.turn : null, p: r.p, q: r.q, tile: int(r.pole) ? r.pole : null, ...(int(r.slot) ? { banner: { p: r.p, q: r.q, slot: r.slot } } : {}) };
  const n = tilesN(r), from = int(r.from) ? r.from : null;
  switch (opOf(r)) {
    case 'RAISE': {
      const own = did || isOwnRecord(FS, r);
      if (own) return { ...base, text: L`+${fmtNum(n)}マス あなたの土地になりました`, gain: n };
      if (r.nation === nation) return { ...base, quiet: true, text: holderName(r.holder) ? L`同じ国の${holderName(r.holder)}が旗を立てました（+${fmtNum(n)}マス）` : L`同じ国の仲間が旗を立てました（+${fmtNum(n)}マス）` };
      return wedgeOf(r.p, r.q) === nation ? { ...base, text: L`${factionName(r.nation)}がわたしたちの州に旗を立てました（${fmtNum(n)}マス）` } : null;
    }
    case 'DRESS': return did ? { ...base, quiet: true, text: L`旗の土地を1マス広げました` } : null;
    // (`restored`: the record says the walk mended a frayed banner — on real records the colour came back and nothing said that the land counts again)
    case 'TEND': return did ? (r.restored ? { ...base, text: L`旗を見回りました。ほつれが直り、また得点になります` } : { ...base, quiet: true, text: L`旗を見回りました` }) : null;
    case 'WALK': return did ? { ...base, text: L`今日最初の見回り：功績 +${fmtNum(r.works ?? 0)}` } : null;
    case 'TAKE': {
      // (`nation`: who holds the banner now; `from`: the nation it was taken from)
      if (did) return { ...base, text: L`${factionName(from ?? r.nation)}の旗を取りました（+${fmtNum(n)}マス）`, gain: n };
      if (held && r.nation !== nation) return { ...base, text: L`あなたの旗が${factionName(r.nation)}に取られました`, lost: n };
      return from === nation && r.nation !== nation ? { ...base, text: L`同じ国の仲間の旗が${factionName(r.nation)}に取られました` } : null;
    }
    case 'PULL': {
      // (the banner that fell: its nation is `from` where the record gives it, else `nation`)
      const whose = from ?? r.nation;
      if (did) return { ...base, text: L`${factionName(whose)}の旗を倒しました` };
      if (held) return { ...base, text: L`あなたの旗が倒されました（−${fmtNum(n)}マス）`, lost: n };
      return whose === nation ? { ...base, text: L`同じ国の仲間の旗が倒されました` } : null;
    }
    case 'FRAY': return held ? { ...base, text: L`あなたの旗がほつれました：いまは得点になりません。見回れば戻ります` } : null;
    case 'STRIKE':
      if (!held && !did) return null;
      // (past its grace with no walk: said with its cause, in the board's own words — map/protowords.mjs `lapsed`)
      if (r.reason === 'grace') return { ...base, text: L`見回りがなく、あなたの旗がなくなりました（−${fmtNum(n)}マス）`, lost: n };
      return String(r.by ?? '') === 'keeper' || (r.reason && r.reason !== 'own') ? { ...base, text: L`あなたの旗が片づけられました（−${fmtNum(n)}マス）`, lost: n } : { ...base, quiet: true, text: L`旗を取り下げました（−${fmtNum(n)}マス）` };
    case 'TRAIL': return did || (isHostId(r.host) && isOwnHost(FS, String(r.host))) ? { ...base, quiet: true, tile: Array.isArray(r.tiles) && r.tiles.length ? r.tiles[0] : null, text: L`歩いた跡ができました（この軍勢が旗を立てると、一緒に土地になります）` } : null;
    case 'TAKEOVER': return did ? { ...base, text: L`旗を引き継ぎました（+${fmtNum(n)}マス）`, gain: n } : null;
    default: return null;
  }
}

/**
 * The log's records this viewer has not been told of yet, as feed lines, oldest first; `FS.proto.newsSeq` moves on.
 * The records that were already in the log when the page first read it are not news. `{records: [{record, own,
 * item}], items}` (`records`: every new record, for the board's moments; `items`: the lines).
 */
export function freshNews(FS) {
  const P = FS.proto;
  if (!P) return { records: [], items: [] };
  const num = r => Number(r.seq);
  const last = P.log.length ? Math.max(...P.log.map(num).filter(Number.isFinite), -1) : -1;
  learn(FS);
  if (P.newsSeq === null) { P.newsSeq = last; return { records: [], items: [] }; }
  // (`premise`: what the world wrote when it began — the villages' land, the neighbours' first banners — is no news)
  const fresh = P.log.filter(r => num(r) > P.newsSeq && r.premise !== true);
  P.newsSeq = Math.max(P.newsSeq, last);
  const records = fresh.map(r => ({ record: r, own: isOwnRecord(FS, r), did: isOwnDoing(FS, r), item: newsOf(FS, r) }));
  // (a walk that mended a frayed banner: the day's pay is a line of the list beside it and no notice of its own — a
  // phone shows one notice, and 「功績 +2」 stood in place of the sentence that says the land counts again)
  if (records.some(x => x.item && opOf(x.record) === 'TEND' && x.record.restored)) for (const x of records) if (x.item && opOf(x.record) === 'WALK') x.item = { ...x.item, quiet: true };
  return { records, items: records.map(x => x.item).filter(Boolean) };
}

/**
 * A threat on a banner of the viewer's in one sentence, by what the land record says the host on the pole may do
 * (`contested.onlyPull`: it can only pull the banner down there — said as that, never as a taking), with the count.
 */
export function threatText(FS, c, onlyPull = null) {
  const soon = c.done || c.left === null;
  if (onlyPull) return soon ? L`あなたの旗が狙われています。いつ倒されてもおかしくありません` : L`あなたの旗が狙われています。あと${fmtNum(c.left)}ターン${clockOf(FS, c.left)}で倒されます`;
  return soon ? L`あなたの旗が狙われています。いつ取られてもおかしくありません` : L`あなたの旗が狙われています。あと${fmtNum(c.left)}ターン${clockOf(FS, c.left)}で取られます`;
}

/**
 * What threatens the viewer's land, from the land records, the most pressing first: `[{id, kind, p, q, tile, nation,
 * left, done, text, slot?}]`.
 *   kind 'take'  a hostile host stands on the pole of a banner of the viewer's (`contested`): the banner can be taken
 *   kind 'rise'  a host of another nation stands on ground of the viewer's own wedge where it can raise a banner
 *                (`rising` of another nation there)
 * Either is answered by a march that wins the tile.
 */
export function threatsOf(FS) {
  const out = [], nation = nationOf(FS);
  for (const b of meOf(FS)?.banners ?? []) {
    const land = landOf(FS, b.p, b.q), ban = (land?.banners ?? []).find(x => x.slot === b.slot);
    if (!ban?.contested) continue;
    // (the viewer's record and the land record are read a moment apart: right after the viewer TOOK a banner its land
    // record still showed the viewer's own host standing on the pole of what was now the viewer's banner. On real
    // records that was told as a threat, 「いつ取られてもおかしくありません」, and a turn later as a threat that had gone.
    // A host of the viewer's nation, or the viewer's own, threatens no banner of the viewer's; nor is a banner the
    // land record still names another holder for the viewer's yet.)
    if (ban.contested.nation === nation || isOwnHost(FS, String(ban.contested.host ?? '')) || (ban.holder !== undefined && ban.holder !== null && !isOwnHolder(FS, ban.holder))) continue;
    const c = countTo(FS, ban.contested.canTakeAtTurn, land.resolvedNext);
    out.push({ id: `th:${b.p},${b.q},${b.slot}:${ban.contested.sinceTurn ?? ''}`, kind: 'take', p: b.p, q: b.q, slot: b.slot, tile: ban.pole, nation: ban.contested.nation, left: c.left, done: c.done, onlyPull: ban.contested.onlyPull ?? null, foe: hostOn(FS, b.p, b.q, ban.pole, ban.contested.nation),
      text: threatText(FS, c, ban.contested.onlyPull) });
  }
  return [...out, ...risingFoes(FS)].sort((a, b) => (a.left ?? 0) - (b.left ?? 0));
}

/**
 * The viewer's banners that want a walk, from the land records, the most pressing first: `[{id, kind, p, q, slot,
 * tile, left, text}]`.
 *   kind 'frayed'  the banner is frayed (it does not count now); `left`: the turns before it is struck
 *   kind 'walk'    its walk is due within WALK_SOON turns
 * (The loss states on real records, 2026-10-11: a frayed banner was said once, by a notice, and then nowhere in what
 * the turn holds, for the 72 turns before it was struck.)
 */
export const WALK_SOON = 48;
export function walksDue(FS) {
  const out = [];
  for (const b of meOf(FS)?.banners ?? []) {
    const land = landOf(FS, b.p, b.q), ban = (land?.banners ?? []).find(x => x.slot === b.slot), r = land?.resolvedNext;
    if (!ban || !int(r)) continue;
    if (ban.frayed) {
      const left = int(ban.strikeAt) ? Math.max(0, ban.strikeAt - r) : null;
      out.push({ id: `fr:${b.p},${b.q},${b.slot}`, kind: 'frayed', p: b.p, q: b.q, slot: b.slot, tile: ban.pole, left,
        text: left ? L`あなたの旗がほつれています。あと${fmtNum(left)}ターン${clockOf(FS, left)}のうちに見回れば戻ります` : L`あなたの旗がほつれています。見回れば戻ります` });
    } else if (int(ban.walkDue) && ban.walkDue - r <= WALK_SOON) {
      const left = Math.max(0, ban.walkDue - r);
      out.push({ id: `wk:${b.p},${b.q},${b.slot}`, kind: 'walk', p: b.p, q: b.q, slot: b.slot, tile: ban.pole, left, text: L`あなたの旗を、あと${fmtNum(left)}ターン${clockOf(FS, left)}のうちに見回ってください` });
    }
  }
  return out.sort((a, b) => (a.kind === 'frayed' ? 0 : 1) - (b.kind === 'frayed' ? 0 : 1) || (a.left ?? 0) - (b.left ?? 0));
}

/** Another nation's banner about to rise on ground of the viewer's wedge (`rising` of another nation): `[{id, kind: 'rise', p, q, tile, nation, left, done, text}]`. */
export function risingFoes(FS) {
  const nation = nationOf(FS), out = [];
  if (nation === null) return out;
  for (const [key, land] of FS.proto?.lands ?? []) {
    const [p, q] = key.split(',').map(Number);
    if (wedgeOf(p, q) !== nation) continue;
    for (const x of land.rising ?? []) {
      if (x.nation === nation) continue;
      const c = countTo(FS, x.canRaiseAtTurn, land.resolvedNext);
      out.push({ id: `rf:${p},${q},${x.host}:${x.sinceTurn ?? ''}`, kind: 'rise', p, q, tile: x.tile, nation: x.nation, left: c.left, done: c.done, foe: hostOn(FS, p, q, x.tile, x.nation),
        text: c.left ? L`わたしたちの州に${factionName(x.nation)}の旗が立ちそうです：あと${fmtNum(c.left)}ターン${clockOf(FS, c.left)}` : L`わたしたちの州に${factionName(x.nation)}の旗が立ちそうです` });
    }
  }
  return out;
}

/**
 * A threat the page has told of is gone (`was`: an entry of threatsOf, kept from the turn before): what the records
 * say became of it, as a feed line, or null when they say nothing yet.
 *   kind 'rise'  no banner of that nation stands on the tile: its count is gone (`won`: a host of the viewer's stands there)
 *   kind 'take'  the banner is still the viewer's: it was defended
 * (A banner that rose, or one that was taken, has its own record and its own line: newsOf.)
 */
export function threatGone(FS, was) {
  const land = landOf(FS, was.p, was.q);
  if (!land) return null;
  const base = { id: `gone:${was.id}`, kind: 'proto', proto: true, bell: int(FS.nowBell) ? FS.nowBell : null, p: was.p, q: was.q, tile: was.tile };
  if (was.kind === 'rise') {
    if ((land.banners ?? []).some(b => b.pole === was.tile && b.nation === was.nation)) return null;
    const mine = (meOf(FS)?.hosts ?? []).some(h => h.p === was.p && h.q === was.q && h.tile === was.tile) || (land.rising ?? []).some(x => x.tile === was.tile && isOwnHost(FS, String(x.host)));
    if (mine) return { ...base, won: true, outcome: 'stopped', text: L`${factionName(was.nation)}の旗を止めました。このマスは、あなたの軍勢が押さえています` };
    // (why the count is gone, where the records show it: that host still stands there with fewer troops than the
    // record's own table asks of a host on another nation's ground — a fight thinned it —, or nobody of that nation
    // stands there any more. The page reads two records side by side; the world judged)
    const foe = hostOn(FS, was.p, was.q, was.tile, was.nation), floor = numberOf(FS, 'FLOOR_ABROAD');
    if (foe && floor !== null && foe.troops < floor) {
      // (a march of the viewer's came to that tile and no host of the viewer's stands there: it did not take the tile.
      // Said with the rest — a new hamlet's attack that lost, and stopped the banner all the same)
      const tried = (FS.marches ?? []).some(m => m?.dest && m.dest.p === was.p && m.dest.q === was.q && m.dest.tile === was.tile && int(m.entry?.arriveBell ?? m.transit?.arriveBell) && (m.entry?.arriveBell ?? m.transit?.arriveBell) < (FS.nowBell ?? 0));
      const thinned = L`${factionName(was.nation)}の軍勢は${fmtNum(foe.troops)}人に減りました。ここに旗を立てるには${fmtNum(floor)}人が要るので、旗の数えは消えました`;
      return { ...base, won: false, outcome: 'ended', why: 'floor', tried, text: tried ? L`あなたの軍勢は、そのマスを取れませんでした。それでも、${thinned}` : thinned };
    }
    if (!foe && rosterKnown(FS, was.p, was.q)) return { ...base, won: false, outcome: 'ended', why: 'left', text: L`${factionName(was.nation)}の軍勢は、そのマスにいなくなりました。旗は立ちません` };
    return { ...base, won: false, outcome: 'ended', text: L`${factionName(was.nation)}の旗は立たずに終わりました` };
  }
  const ban = (land.banners ?? []).find(b => b.slot === was.slot) ?? null;
  return ban && isOwnBanner(FS, was.p, was.q, ban) && !ban.contested ? { ...base, outcome: 'kept', banner: { p: was.p, q: was.q, slot: was.slot }, text: L`あなたの旗は守られました。狙っていた軍勢はいなくなりました` } : null;
}
/**
 * What became of a threat that stands no longer, in one word for the guide's list, or null while the records do not
 * say: 'rose' (the other nation's banner stands on the tile), 'lost' (the banner is the viewer's no longer), else
 * what `threatGone` says ('stopped', 'ended', 'kept').
 */
export function threatOutcome(FS, was) {
  const land = landOf(FS, was.p, was.q);
  if (!land) return null;
  if (was.kind === 'rise' && (land.banners ?? []).some(b => b.pole === was.tile && b.nation === was.nation)) return 'rose';
  if (was.kind === 'take') { const ban = (land.banners ?? []).find(b => b.slot === was.slot) ?? null; if (!ban || !isOwnBanner(FS, was.p, was.q, ban)) return 'lost'; }
  return threatGone(FS, was)?.outcome ?? null;
}

/** The viewer's hosts whose count runs or is done, for this turn's list: `[{host, p, q, tile, done, lag, left, size, text}]`. */
export function risingOwn(FS) {
  const out = [], seen = new Set();
  const add = (host, p, q, tile, c, size) => {
    if (seen.has(host)) return;
    seen.add(host);
    out.push({ host, p, q, tile, ...c, size, text: c.done ? (size ? L`旗を立てられます（+${fmtNum(size)}マス）` : L`旗を立てられます`) : c.lag || c.left === null ? L`旗：集計を待っています` : L`あと${fmtNum(c.left)}ターンで旗を立てられます` });
  };
  // (the world's own judgement of each of the viewer's hosts, where it serves it)
  for (const h of meOf(FS)?.hosts ?? []) {
    const a = h.raise, r = landOf(FS, h.p, h.q)?.resolvedNext ?? null;
    if (a?.ok) add(String(h.host), h.p, h.q, h.tile, { left: 0, done: true, lag: false }, int(a.size) ? a.size : null);
    else if (a?.code === 'StandLonger') add(String(h.host), h.p, h.q, h.tile, countTo(FS, a.atTurn ?? a.need?.atTurn, r), int(a.size) ? a.size : null);
  }
  if (Array.isArray(meOf(FS)?.hosts)) return out.sort((a, b) => Number(b.done) - Number(a.done));
  for (const [key, land] of FS.proto?.lands ?? []) {
    const [p, q] = key.split(',').map(Number);
    for (const x of land.rising ?? []) if (isOwnHost(FS, String(x.host))) add(String(x.host), p, q, x.tile, countTo(FS, x.canRaiseAtTurn, land.resolvedNext), sizeOf(x));
  }
  return out.sort((a, b) => Number(b.done) - Number(a.done));
}

/** The arrival turn of the viewer's nearest sealed march that is not settled yet (the page's own list of marches), or null. */
export function onRoad(FS) {
  const turns = (FS.marches ?? []).map(m => m?.entry?.arriveBell ?? m?.transit?.arriveBell).filter(int);
  return turns.length ? Math.min(...turns) : null;
}

/** The arrival turn of a sealed march of the viewer's whose destination is that tile (the page's own list of marches), or null. */
export function marchingTo(FS, at) {
  if (!at) return null;
  const turns = (FS.marches ?? []).filter(m => m?.dest && m.dest.p === at.p && m.dest.q === at.q && m.dest.tile === at.tile).map(m => m?.entry?.arriveBell ?? m?.transit?.arriveBell).filter(int);
  return turns.length ? Math.min(...turns) : null;
}

/** Whether a sealed march of the viewer's already arrives in province (p, q) in turn `bell` (the page's own list of marches; `but`: a host to leave out). */
export function ownArrivalAt(FS, at, bell, but = null) {
  if (!at || !int(bell)) return false;
  return (FS.marches ?? []).some(m => m?.dest && m.dest.p === at.p && m.dest.q === at.q && (m.entry?.arriveBell ?? m.transit?.arriveBell) === bell && String(m.entry?.host ?? m.transit?.hostId ?? '') !== String(but ?? '\u0000'));
}

/** A host of the viewer's that the world lets walk a banner now (one that came there after the last walk), or null. `rows`: hud/subject.mjs rows of the viewer's hosts, when the caller has them. */
export function walkerOf(FS, rows = null) {
  for (const h of meOf(FS)?.hosts ?? []) if ((h.tend ?? []).some(t => t.ok)) return rows ? rows.find(r => String(r.id) === String(h.host)) ?? null : h;
  return null;
}

// ------------------------------------------------------------------ the guided first minutes (PROTOTYPE-SPEC section 8)
export const GUIDE_STEPS = Object.freeze(['land', 'form', 'raise', 'second', 'march', 'answer', 'won', 'walk']);
/**
 * The guide of the prototype, from the records: `{steps: [{id, status: 'done' | 'current' | 'todo'}], current, n,
 * total, title, text, go: {act, data, label} | null}`; null with the prototype off, without a village, or when all
 * is done. `flags`: the page's own memory of this visit (`threat`: a banner of the viewer's has been under threat).
 */
export function guideModel(FS) {
  const me = meOf(FS);
  if (!FS.proto || !me || !(FS.holdings ?? []).length) return null;
  const home = FS.holdings[0], banners = me.banners ?? [];
  const atHome = banners.filter(b => b.p === home.p && b.q === home.q).length, away = banners.length - atHome;
  const own = risingOwn(FS), threats = threatsOf(FS);
  const flags = FS.proto.guide ?? {};
  // (the page's memory of this visit: the tile of a threat that went away while a host of the viewer's stood on it)
  const wonAt = flags.won ?? null, wonHost = wonAt && !threats.length ? own.find(x => x.p === wonAt.p && x.q === wonAt.q && x.tile === wonAt.tile) ?? null : null;
  // (the turn in which that clash is being settled: the host that won is on the tile and the world still says it is
  // on the march — its count has not begun. The step is there already, with nothing to press; the guide said
  // 「旗を見回る」 for that one turn and then went back a step)
  const wonWait = wonAt && !threats.length && !wonHost ? (me.hosts ?? []).find(h => h.p === wonAt.p && h.q === wonAt.q && h.tile === wonAt.tile && WAIT_CODES.includes(h.raise?.code)) ?? null : null;
  const done = {
    land: Number(me.villageTiles ?? 0) > 0,
    form: banners.length > 0 || own.length > 0,
    raise: banners.length > 0,
    second: banners.length >= 2,
    march: away > 0,
    answer: !threats.length && !!flags.threat,
    // (the tile that was won: a host of the viewer's stands on it and counts toward a banner of its own, or can raise it)
    won: !wonHost && !wonWait,
    walk: !!me.walkPaidToday || !!flags.walked,
  };
  // (the threat is a step only while it stands, or once it has been seen: nothing to answer is nothing to do; the tile
  // that was won is a step only while a host of the viewer's stands on it where a banner can rise)
  const ids = GUIDE_STEPS.filter(id => (id !== 'answer' || threats.length || flags.threat) && (id !== 'won' || wonHost || wonWait));
  const ready = own.find(x => x.done) ?? null, counting = own[0] ?? null;
  // (the numbers of a threat, from the public roster: who stands there and how many, against the largest host the
  // viewer has or could form now. A threat the viewer is outnumbered by — a new hamlet against a host of 500 — does
  // not hold the other steps back: its notice stands, with those numbers, and the step is taken up when nothing else
  // is left to do. No battle is judged here: the order card's forecast is the rules' own)
  const t0 = threats[0] ?? null, force = t0?.foe ? strengthOf(FS) : null;
  const outnumbered = !!force && force.best < t0.foe.troops;
  const aside = !!t0 && outnumbered && ids.some(id => id !== 'answer' && !done[id]);
  // (a threat comes first, except while a host of the viewer's can raise its banner this moment: that banner is one
  // press away, and the threat's notice stays in sight)
  let current = threats.length && !ready && !aside ? 'answer' : null;
  const steps = ids.map(id => { const st = id === current ? 'current' : done[id] ? 'done' : current === null && !(aside && id === 'answer') ? 'current' : 'todo'; if (st === 'current') current = id; return { id, status: st, name: stepName(id, { threat: t0, outcome: flags.answer ?? null }) }; });
  if (current === null) return null;
  const n = steps.filter(s => s.status === 'done').length;
  const per = me.perProvince ?? 2;
  const reserveReady = [0, 1, 2, 3, 4, 5].some(u => Number(home.reserve?.[u] ?? 0) >= 100);
  let title = '', text = '', go = null;
  if (current === 'land') { title = L`あなたの土地`; text = L`村のまわりの${fmtNum(me.villageTiles ?? 0)}マスが、あなたの土地です。`; }
  else if ((current === 'form' || ((current === 'raise' || current === 'second') && !own.length)) && !villageFinal(FS)) {
    // (a new village is provisional for a while: the program forms no host from it yet. Said as that — the button
    // said 編成する and opened a card whose own button could not be pressed —, with what can be done meanwhile)
    title = L`村の確定を待つ`;
    text = reserveReady ? L`あなたの村は、まだ仮の村です。軍勢を編成できるのは、村が確定してからです。確定したら、光っているマスに軍勢を編成しましょう。`
      : L`あなたの村は、まだ仮の村です。軍勢を編成できるのは、村が確定してからです。それまでに、槍兵を訓練しておけます。`;
    go = reserveReady ? null : { act: 'proto-guide', data: { go: 'form' }, label: L`訓練する` };
  } else if (current === 'form' || ((current === 'raise' || current === 'second') && !own.length)) {
    title = current === 'second' ? L`二本目の旗` : L`軍勢を編成する`;
    // (no troops in reserve to form a host from — a new hamlet has none —: training comes first, and the button says so)
    text = reserveReady ? L`光っているマスに、槍兵の軍勢を編成しましょう。そこに1ターン立てば、旗を立てられます。` : L`まず、村で槍兵を訓練しましょう。そのあと、光っているマスに軍勢を編成します。`;
    go = { act: 'proto-guide', data: { go: 'form' }, label: reserveReady ? L`編成する` : L`訓練する` };
  } else if (current === 'raise' || current === 'second') {
    title = current === 'second' ? L`二本目の旗` : L`旗を立てる`;
    const x = ready ?? counting;
    text = ready ? L`旗を立てましょう。色が広がり、土地があなたのものになります。` : x.text;
    go = { act: 'proto-guide', data: { go: 'host', host: x.host }, label: ready ? L`旗を立てる` : L`軍勢を見る` };
  } else if (current === 'march' && own.length) {
    // (the host that marched stands where a banner can rise: the count, then the raise; its trail comes with it)
    title = L`進軍した先に旗`;
    const x = ready ?? counting;
    text = ready ? L`着いた先に旗を立てましょう。歩いた跡も一緒に土地になります。` : x.text;
    go = { act: 'proto-guide', data: { go: 'host', host: x.host }, label: ready ? L`旗を立てる` : L`軍勢を見る` };
  } else if (current === 'march' && onRoad(FS) !== null) {
    // (a sealed march of the viewer's is on its way, or has arrived and its turn is being settled: nothing to press)
    const at = onRoad(FS);
    if ((FS.nowBell ?? 0) < at) { title = L`進軍中：ターン ${fmtNum(at)} に到着`; text = L`封をした軍勢が向かっています。着いた先に1ターン立てば、旗を立てられます。`; }
    else { title = L`到着：集計を待っています`; text = L`軍勢が着きました。到着したターンの集計が済むと、旗を立てられるようになります。`; }
  } else if (current === 'march') {
    title = L`進軍した先に旗`;
    text = atHome >= per ? L`この州の旗は${fmtNum(per)}本です。つぎの土地は、進軍した先です。歩いた跡も一緒に土地になります。` : L`別の州へ進軍して、着いた先に旗を立てましょう。歩いた跡も一緒に土地になります。`;
    go = { act: 'proto-guide', data: { go: 'march' }, label: L`進軍する` };
  } else if (current === 'answer' && marchingTo(FS, threats[0]) !== null) {
    // (the answer is sealed and on its way to that tile: nothing to press until it arrives and the clash is settled)
    const at = marchingTo(FS, threats[0]);
    if ((FS.nowBell ?? 0) < at) { title = L`進軍中：ターン ${fmtNum(at)} に到着`; text = L`封をした軍勢が、そのマスへ向かっています。`; }
    else { title = L`到着：集計を待っています`; text = L`軍勢が着きました。戦いの結果は、到着したターンの集計が済むと出ます。`; }
  } else if (current === 'answer') {
    const t = threats[0];
    title = t.kind === 'rise' ? L`敵の旗を防ぐ` : L`旗を守る`;
    // (outnumbered: the numbers are said, and that the order card's forecast is where to look before sealing; the
    // sentence that a host "wins the tile" is not said to a player whose every host is the smaller one)
    // (the merge of 2026-10-11: a host that can only pull the banner down — the record's `onlyPull`, said so in the
    // threat's own sentence since the loss states were played — is not said to "take" it by the step's last words)
    const idle = t.kind === 'rise' ? L`何もしなければ、旗が立ちます。` : t.onlyPull ? L`何もしなければ、旗は倒されます。` : L`何もしなければ、旗は取られます。`;
    if (outnumbered) text = L`${t.text}。${threatNumbers(t, force)}数で下回っています。送るなら、命令の紙の予測を先に確かめましょう。${idle}`;
    else text = t.kind === 'rise' ? L`${t.text}。軍勢を送って、そのマスを取りましょう。何もしなければ、旗が立ちます。` : t.onlyPull ? L`${t.text}。軍勢を送って、そのマスを取り返しましょう。何もしなければ、旗は倒されます。` : L`${t.text}。軍勢を送って、そのマスを取り返しましょう。何もしなければ、旗は取られます。`;
    go = { act: 'proto-send', data: { p: t.p, q: t.q, tile: t.tile }, label: L`軍勢を送る` };
  } else if (current === 'won' && !wonHost) {
    title = L`勝ち取ったマスに旗`;
    text = L`あなたの軍勢が、そのマスを押さえました。到着したターンの集計が済むと、旗の数えが始まります。`;
  } else if (current === 'won') {
    title = L`勝ち取ったマスに旗`;
    text = wonHost.done ? L`勝ち取ったマスに旗を立てましょう。` : wonHost.text;
    go = { act: 'proto-guide', data: { go: 'host', host: wonHost.host }, label: wonHost.done ? L`旗を立てる` : L`軍勢を見る` };
  } else if (current === 'walk') {
    title = L`旗を見回る`;
    const pay = walkPay(FS);
    // (the button is named by what it opens: a host that may walk a banner now; else the card where a new host is
    // formed; else, with no troops in reserve, the training card — the step said 見回る and opened training)
    const can = walkerOf(FS), soon = can ? null : walkerSoon(FS);
    if (soon) {
      // (a host formed for the walk is taking its place — the world says it is not in the province yet —: the step
      // said 訓練する again for those turns, as if nothing had been done)
      text = L`見回りの軍勢が整列しています。整列がすむと、見回れます。`;
      go = { act: 'proto-guide', data: { go: 'host', host: soon.host }, label: L`軍勢を見る` };
    } else {
      text = can ? (pay ? L`旗を見回りましょう。今日の最初なら功績 +${fmtNum(pay)} です。` : L`旗を見回りましょう。`)
        : reserveReady ? (pay ? L`見回れるのは、旗の土地に新しく立った軍勢です。旗の土地に軍勢を編成しましょう。今日の最初の見回りは功績 +${fmtNum(pay)} です。` : L`見回れるのは、旗の土地に新しく立った軍勢です。旗の土地に軍勢を編成しましょう。`)
          : L`見回れるのは、旗の土地に新しく立った軍勢です。まず村で兵を訓練し、旗の土地に軍勢を編成しましょう。`;
      go = { act: 'proto-guide', data: { go: 'walk' }, label: can ? L`見回る` : reserveReady ? L`編成する` : L`訓練する` };
    }
  }
  return { steps, current, n, total: steps.length, title, text, go, ...(t0 ? { threat: { ...t0, outnumbered, force } } : {}) };
}
/** The world's answers that mean "this host is taking its place: ask again when the turn is settled". */
const WAIT_CODES = Object.freeze(['InTransit', 'NotResident', 'HostBusy']);
/** A host of the viewer's that stands in or beside a banner it may walk once it has taken its place (the world answers that it is not in the province yet), or null. */
export function walkerSoon(FS) {
  for (const h of meOf(FS)?.hosts ?? []) if ((h.tend ?? []).some(t => !t.ok && WAIT_CODES.includes(t.code))) return h;
  return null;
}
/**
 * Which of the viewer's hosts the guide sends on its march first, from what the world says of each where it stands
 * (lower goes first; the smaller host among equals): 0 a host on the pole of a banner of the viewer's own (it has
 * raised its banner: nothing holds it there), 1 any other host, 2 a host that can raise a banner where it stands, is
 * counting toward one, or is taking its place (a host just formed for a walk). The page chooses whom to offer; what
 * each may do is the world's answer.
 */
export function marchRank(FS, id) {
  const a = hostActs(FS, id);
  if (!a) return 1;
  if (a.raise?.ok || a.raise?.code === 'StandLonger' || (a.tend ?? []).some(t => !t.ok && WAIT_CODES.includes(t.code))) return 2;
  return a.onPole && isOwnHolder(FS, a.onPole.holder) ? 0 : 1;
}
/** The numbers of a threat in one sentence: who stands there, and the largest host the viewer has or could form. */
export function threatNumbers(t, force) {
  if (!t?.foe || !force) return '';
  const them = L`立っているのは${factionName(t.nation)}の${unitCount(UNIT_ORDER[t.foe.unit], t.foe.troops)}です。`;
  return force.best > 0 ? L`${them}あなたのいちばん大きい軍勢は${fmtNum(force.best)}人です。` : L`${them}あなたには、いま出せる軍勢がありません。`;
}
/** A step of the guide by name; the step of a threat is named by what the threat is, and afterwards by what became of it (`outcome`: app.mjs keeps it from the records). */
export function stepName(id, { threat = null, outcome = null } = {}) {
  switch (id) {
    case 'land': return L`あなたの土地`;
    case 'form': return L`軍勢を編成する`;
    case 'raise': return L`旗を立てる`;
    case 'second': return L`二本目の旗`;
    case 'march': return L`進軍した先に旗`;
    case 'answer':
      if (threat) return threat.kind === 'rise' ? L`敵の旗を防ぐ` : L`旗を守る`;
      return outcome === 'stopped' ? L`敵の旗を止めた` : outcome === 'rose' ? L`敵の旗が立った` : outcome === 'ended' ? L`敵の旗は立たなかった` : outcome === 'kept' ? L`旗を守った` : outcome === 'lost' ? L`旗を取られた` : L`旗を守る`;
    case 'won': return L`勝ち取ったマスに旗`;
    case 'walk': return L`旗を見回る`;
    default: return '';
  }
}

// ------------------------------------------------------------------ for the board
/**
 * The model the board draws the prototype from (`map.setProto(model)`): the records as the world served them, and
 * who is looking. Null with the prototype off.
 *   {rule, version, label, nation, turn, turnSecs, me, own: Set "p,q,slot", lands: Map "p,q" → land record,
 *    standings, ownHost(id) → bool}
 */
export function boardModel(FS) {
  const P = FS.proto;
  if (!P) return null;
  return { rule: P.claims.rule ?? null, version: P.claims.version ?? null, label: labelText(P.claims), nation: nationOf(FS), turn: FS.nowBell ?? null, turnSecs: turnWallSecs(FS),
    me: P.me, own: ownKeys(FS), lands: P.lands, standings: P.standings, ownHost: id => isOwnHost(FS, String(id)) };
}

/**
 * The widest place among the world's answers for every tile of a province (the preview route without a tile: `all`):
 * `{tile, size, steps}` of the answer that would bring the most tiles, the nearest of those, or null when none can
 * rise. Nothing is judged: the answers are the world's, and the page picks the largest number among them.
 */
export function widestPlace(all) {
  const ok = (all ?? []).filter(x => x && x.ok && int(x.tile) && (int(x.size) || Array.isArray(x.tiles)));
  if (!ok.length) return null;
  const size = x => (int(x.size) ? x.size : x.tiles.length);
  const x = ok.sort((a, b) => size(b) - size(a) || (a.steps ?? 0) - (b.steps ?? 0) || a.tile - b.tile)[0];
  return { tile: x.tile, size: size(x), steps: int(x.steps) ? x.steps : null };
}

/** A host of the viewer's by name for a line: 「槍兵 200」. */
export const hostName = row => (row ? unitCount(UNIT_ORDER[row.unit], row.troops) : L`軍勢`);
