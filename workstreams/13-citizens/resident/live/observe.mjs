// The operator resident's observation of the REAL world, as far as existing readers answer it (2026-11-17).
// A partial view, never the test world's full one: the resident's own Citizen and villages (herald /h/me), the world
// and its clock (herald /h/season), and the public requests on workstream 1's board in the same world (/coop/config,
// /coop/view). Everything else (other villages, their stock, events, positions) is not read here and is not invented.
//
// Kept apart from the test world: nothing here imports world/*.mjs, and no 1-D `pos`, tier or mock rule appears.
// Places are S1 places as the chain names them: {p, q, site, gen} (hex province, site, generation).
// Workstream 13 imports nothing of workstream 12 or of the game: the caller supplies
//   deps.worldFromSeason(season)        workstream 12 adapters/canonical.mjs worldFromSeason (throws on a bad record)
//   deps.currentBellFromSeason(season)  workstream 12 adapters/canonical.mjs: the bell of /h/season's latestUnix, or null
//   deps.decodeHolding(bytes_b64)       the game's Holding decode (fcodec), → {p, q, site, gen, tile, ownerCitizen}
//   deps.decodeCitizen(bytes_b64)       the game's Citizen decode, → {wallet (base58), holdingsN}  (optional)
//   deps.stockAt(holding, unixTs)       the game's stock at a time (fland storesAt over rulebook settled)   (optional)
// Readers: herald.get(path) and board.get(path) → {status, json} (or throw). Reads only: GET.
//
// Time: the bell is the Season bell of /h/season's own latestUnix (the herald's latest block time), through 12's
// currentBellFromSeason. It is informational, not finality, and no slot or wall time is turned into seconds or a bell
// here. Without it the bell is null, and what depends on it is held by the caller (candidates.mjs).

import { seasonClock } from '../frame.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const placeOf = h => ({ p: h.p, q: h.q, site: h.site, gen: h.gen });
const ok = r => r && r.status >= 200 && r.status < 300 && isObj(r.json);

async function read(src, path) {
  try { const r = await src.get(path); return ok(r) ? { json: r.json } : { why: `http_${r?.status ?? '?'}` }; }
  catch (e) { return { why: `unreachable:${String(e?.message ?? e).slice(0, 60)}` }; }
}

/**
 * One observation. → {kind: 'live-partial', world, clock, bell, bellBasis, self, requests, held, unknown}
 *   world/clock  null with a reason in `unknown` when /h/season is not read or not a continuous world
 *   self         {status: 'ok', citizen, holdings: [{place, tile, stock|null, stockBasis}]} | {status: 'none'|'unread', why}
 *   requests     the board's requests of THIS world that are open and whose destination the board verified
 *   held         everything read but not usable, each with why (never dropped)
 *   unknown      what is not read at all, each with why
 */
export async function observeLive({ herald, board = null, wallet, deps }) {
  const held = [], unknown = [];
  const out = { kind: 'live-partial', world: null, clock: null, bell: null, bellBasis: null, self: { status: 'unread', why: 'not read' }, requests: [], held, unknown };
  // the world and its clock
  const s = await read(herald, '/h/season');
  let season = null;
  if (s.why) unknown.push({ what: 'world', why: `herald /h/season: ${s.why}` });
  else {
    season = s.json;
    try {
      const w = deps.worldFromSeason(season);
      if (!w.world) unknown.push({ what: 'world', why: (w.reasons ?? []).join(',') || 'not_a_continuous_world' });
      else {
        out.world = w.world;
        out.clock = seasonClock({ genesisTs: w.clock.genesisTs, bellSecs: w.clock.bellSecs, source: w.clock.source });
      }
    } catch (e) { unknown.push({ what: 'world', why: `herald /h/season malformed: ${String(e?.message ?? e).slice(0, 80)}` }); }
  }
  if (out.clock) {
    const b = deps.currentBellFromSeason(season);
    if (Number.isSafeInteger(b)) { out.bell = b; out.bellBasis = { from: 'herald /h/season latestUnix', finality: 'none (informational)', latestUnix: season.latestUnix }; }
    else unknown.push({ what: 'bell', why: 'herald /h/season has no usable latestUnix' });
  } else unknown.push({ what: 'bell', why: 'no world clock' });
  // the resident's own Citizen and villages
  if (typeof wallet !== 'string' || !wallet) out.self = { status: 'unread', why: 'no wallet given (the identity is supplied by its owner)' };
  else if (!out.world) out.self = { status: 'unread', why: 'no world: villages are not read for an unknown world' };
  else {
    const m = await read(herald, `/h/me/${encodeURIComponent(wallet)}`);
    if (m.why) out.self = { status: 'unread', why: `herald /h/me: ${m.why}` };
    else if (m.json.v !== 1 || m.json.wallet !== wallet) out.self = { status: 'unread', why: 'herald /h/me malformed or for another wallet' };
    else if (!m.json.citizen) out.self = { status: 'none', why: 'no Citizen for this wallet in this world (join is not supported here)' };
    else {
      let cit = null;
      if (typeof deps.decodeCitizen === 'function') {
        try { cit = deps.decodeCitizen(m.json.citizen.bytes_b64); } catch (e) { held.push({ what: 'citizen', why: `undecodable: ${String(e?.message ?? e).slice(0, 60)}` }); }
        if (cit && cit.wallet !== wallet) { out.self = { status: 'unread', why: "the Citizen's wallet is not this wallet" }; cit = false; }
      }
      if (cit !== false) {
        const holdings = [];
        for (const a of Array.isArray(m.json.holdings) ? m.json.holdings : []) {
          let h;
          try { h = deps.decodeHolding(a?.bytes_b64); } catch (e) { held.push({ what: 'holding', address: a?.address ?? null, why: `undecodable: ${String(e?.message ?? e).slice(0, 60)}` }); continue; }
          if (!h || h.ownerCitizen !== m.json.citizen.address) { held.push({ what: 'holding', address: a?.address ?? null, why: 'not owned by this Citizen now' }); continue; }
          let stock = null, stockBasis = 'unknown: no stock reader or no herald time';
          if (typeof deps.stockAt === 'function' && out.bellBasis) {
            try { stock = deps.stockAt(h, season.latestUnix); stockBasis = 'estimate at herald latestUnix (the program decides at sending: Insufficient)'; }
            catch (e) { stockBasis = `unknown: ${String(e?.message ?? e).slice(0, 60)}`; }
          }
          holdings.push(Object.freeze({ place: Object.freeze(placeOf(h)), tile: h.tile ?? null, address: a?.address ?? null, stock, stockBasis }));
        }
        out.self = { status: 'ok', citizen: m.json.citizen.address, holdings: Object.freeze(holdings) };
        if (!holdings.length) held.push({ what: 'holdings', why: 'the Citizen has no village read as its own now' });
      }
    }
  }
  // workstream 1's board, in the same world only
  if (!board) unknown.push({ what: 'requests', why: 'no board given' });
  else if (!out.world || !season) unknown.push({ what: 'requests', why: 'no world: a board is not matched to an unknown world' });
  else {
    const c = await read(board, '/coop/config');
    const sameWorld = c.json && isObj(c.json.season) && c.json.season.programId === season.programId && String(c.json.season.seasonId) === String(season.season);
    if (c.why) unknown.push({ what: 'requests', why: `board /coop/config: ${c.why}` });
    else if (!sameWorld) unknown.push({ what: 'requests', why: 'the board is of another world (program or Season)' });
    else {
      const v = await read(board, '/coop/view');
      if (v.why || !Array.isArray(v.json?.requests)) unknown.push({ what: 'requests', why: `board /coop/view: ${v.why ?? 'malformed'}` });
      else for (const q of v.json.requests) {
        const inWorld = isObj(q?.ctx) && q.ctx.programId === season.programId && String(q.ctx.seasonId) === String(season.season);
        const shaped = typeof q?.id === 'string' && typeof q?.requester === 'string' && isObj(q?.need) && isObj(q?.to) && ['p', 'q', 'site', 'gen'].every(k => Number.isInteger(q.to[k]));
        if (!shaped) { held.push({ what: 'request', id: q?.id ?? null, why: 'malformed' }); continue; }
        if (!inWorld) { held.push({ what: 'request', id: q.id, why: 'of another world' }); continue; }
        if (q.stateNow !== 'open') { held.push({ what: 'request', id: q.id, why: `not open (${q.stateNow ?? '?'})` }); continue; }
        if (q.destination?.status !== 'verified') { held.push({ what: 'request', id: q.id, why: `destination not verified (${q.destination?.status ?? 'none'})` }); continue; }
        out.requests.push(Object.freeze({ id: q.id, requester: q.requester, need: Object.freeze({ ...q.need }), to: Object.freeze(placeOf(q.to)), expiresAt: q.expiresAt ?? null,
          responses: isObj(q.responses) ? q.responses : {}, sendings: Array.isArray(q.sendings) ? q.sendings : [], links: Array.isArray(q.links) ? q.links : [] }));
      }
    }
  }
  return Object.freeze(out);
}
