// The prototype's three routes (PROTOTYPE-SPEC sections 5 and 6, amendment C), and nothing else.
//
// "Standing Ground, the banner rule" is a DESIGN that the sample world tries out. It is not in the program, the
// rules crate or the ABI, and nothing of it is sent to a chain: these routes exist only on the screenshot
// fixture's sample world, and the page calls them only while that world's season record carries
// `sample.proto.claims` (controller.mjs asks `enabled()` first). This file is the one place that names them:
//
//   POST /gw/f/proto/land          an order of the prototype: {op, host, province, …} → {ok: true, track, landMs, op,
//                                  turn, note} (the record follows `landMs` later) or {ok: false, code, error, need}
//                                  with HTTP 200
//   GET  /h/proto/standings        {turn, unit: 'tile-turn', note: {ja, en}, nations: [{nation, tilesNow, paidNow,
//                                  tileTurns, share}], check: {sum, expected}}
//   GET  /h/proto/preview          ?host=<id>&p=<P>&q=<Q>&tile=<T> (no host: &troops=<n>) → what the world's own canRaise would say if that
//                                  host stood on that tile after the turns it must stand: {ok: true, tiles, trail,
//                                  size, price, waitTurns} or {ok: false, code, need}. The page holds no copy of the
//                                  rule: where a banner can rise, what it would take and what it costs are asked.
//
// Every call answers `{ok, …}` and never rejects.
import { request as relayRequest } from '../fchainio.mjs';

let base = '', fetchOf = (...a) => globalThis.fetch(...a), on = false;

/** Where the reads are (the herald's origin; '' = this page's own) and, for tests, the fetch to use. */
export function configure({ herald = '', fetch = null } = {}) {
  base = String(herald ?? '').replace(/\/+$/, '');
  if (fetch) fetchOf = fetch;
}
/** The switch: the routes answer `Off` without touching the network until the season record carries the prototype. */
export function enable(v) { on = !!v; }
export const enabled = () => on;

const off = () => ({ ok: false, code: 'Off', error: 'the prototype is off' });

async function read(path) {
  if (!on) return off();
  let r;
  try { r = await fetchOf(`${base}${path}`, { cache: 'no-store', signal: AbortSignal.timeout?.(12_000) }); } catch { return { ok: false, code: 'network', error: 'network' }; }
  let json = null;
  try { json = await r.json(); } catch { /* not JSON */ }
  const b = json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  if (!r.ok) return { ...b, ok: false, code: b.code ?? (r.status === 404 ? 'NotFound' : `HTTP${r.status}`), error: String(b.error ?? `HTTP ${r.status}`) };
  return { ...b, ok: b.ok !== false };
}

/** The body of an order: the province both as `[p, q]` and as `p`, `q`; a host's id as a string (ids are 64-bit). */
export function orderBody(op, { host = null, p, q, slot = null, tile = null, minTiles = null, maxWorks = null, elbow = null, reason = null } = {}) {
  const body = { op, province: [p, q], p, q };
  if (host !== null && host !== undefined && host !== '') body.host = String(host);
  if (Number.isInteger(slot)) body.slot = slot;
  if (Number.isInteger(tile)) body.tile = tile;
  if (Number.isInteger(minTiles)) body.minTiles = minTiles;
  if (Number.isInteger(maxWorks)) body.maxWorks = maxWorks;
  if (Array.isArray(elbow) && elbow.length) body.elbow = elbow.slice(0, 4);
  if (reason) body.reason = String(reason);
  return body;
}

/** The orders the page can give (the world judges each; `takeover` and `fray` are not offered by this page). */
export const OPS = Object.freeze(['raise', 'dress', 'take', 'pull', 'tend', 'strike']);

/** POST /gw/f/proto/land. `fetch` for tests. */
export async function land(op, fields = {}, { fetch = null } = {}) {
  if (!on) return off();
  if (!OPS.includes(op)) return { ok: false, code: 'BadOp', error: `not an order of this page: ${op}` };
  return relayRequest('POST', '/f/proto/land', { body: orderBody(op, fields), ...(fetch ? { fetch } : {}) });
}

/** GET /h/proto/standings. */
export const standings = () => read('/h/proto/standings');

/**
 * The query of a preview: a host that exists by its id; a host that does not exist yet (a muster being placed) by its
 * number of troops alone, with no `host` (the world then judges a host formed there now).
 */
export function previewQuery({ host = null, p, q, tile, troops = null }) {
  const u = new URLSearchParams();
  if (host !== null && host !== undefined && host !== '') u.set('host', String(host));
  else if (Number.isFinite(troops)) u.set('troops', String(troops));
  // (no tile: the world answers for all 61 tiles of the province, `all`)
  u.set('p', String(p)); u.set('q', String(q)); if (Number.isInteger(tile)) u.set('tile', String(tile));
  return u.toString();
}
/** GET /h/proto/preview. */
export const preview = x => read(`/h/proto/preview?${previewQuery(x)}`);
