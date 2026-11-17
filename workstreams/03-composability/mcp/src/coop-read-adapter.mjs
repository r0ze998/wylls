// Read-only adapter from the WYLLS MCP server to a workstream 01 cooperation board
// (workstreams/01-national-strategy/coop/board.mjs). NOT wired to any tool, scope, HTTP route or bin: an exported
// factory and a read method a future authenticated MCP integration can call. See COOP-READ-ADAPTER.md.
//
// What the board offers (board.mjs createServer): GET /coop/config and GET /coop/view are public. `viewer` on
// /coop/view is display context, not authentication: the board tells anyone what any wallet is involved in. So this
// adapter
//   * is off unless the deployment's trusted config says this specific board is meant to be public
//     (publicViewConfirmed: true), names its http(s) base, and injects fetch; off means zero fetches;
//   * binds `viewer` to the authenticated principal's own wallet (never a caller-chosen one), and requires the
//     existing wylls.read scope and a trusted current game context {programId, seasonId, cluster} from the caller;
//   * reads /coop/config before and after /coop/view and refuses when the board is not the current world/cluster,
//     carries more than one context (previous worlds), reports damaged records or store problems, or changed between
//     the reads; refuses redirects; forwards no credentials or cookies; bounds body size and time;
//   * returns a fixed projection only: the board's national aggregate for the owner's verified nation, the owner's
//     own involvement by request id and counts, source/world/owner, and the limitations. No raw config/view, no
//     signatures, tokens, proofs, free-form text, other wallets or internal paths.
// GET /coop/view is not free of side effects on the board: board.view() calls caravans(), which may refresh and save
// the board's own observation cache. The adapter itself writes nothing and never POSTs.
//
// Dependency-free on purpose (no import of ./auth.mjs, whose imports reach the gateway): COOP_READ_SCOPE must equal
// SCOPES.READ in ./auth.mjs ('wylls.read'). This adapter is not a permission source: it cannot make send_caravan
// accept another owner's place, and it derives no recipient/target list, score, selection or role.

export const COOP_READ_SCOPE = 'wylls.read';

export const COOP_READ_STATUSES = Object.freeze(['ok', 'disabled', 'refused', 'unavailable', 'mismatch', 'changed', 'unsupported', 'damaged', 'malformed']);

export const COOP_READ_LIMITATIONS = Object.freeze([
  'Read-only: two GET /coop/config and one GET /coop/view per read; the adapter writes nothing and never POSTs. The board itself may refresh and save its own observation cache while answering /coop/view.',
  'The board is public and viewer is display context, not authentication: the adapter binds viewer to the authenticated owner but proves nothing about the owner itself; the caller\'s authentication does.',
  'nation is the board\'s verified-nation aggregate over the whole single-context board: requests whose requester the board verified as that nation, and counted arrivals whose responder it verified as that nation. There is no per-request verified requester nation, so no same-nation recipient or target list, score, selection, role or send authority is derived.',
  'nation.status "unknown" means the board could not verify the owner\'s nationality; its counts are null, not 0.',
  'All amounts are whole-unit lower bounds as the board reports them. entries.counted / myEntries.counted are board-verified counted arrivals; entries.listed / myEntries.listed are every entry the board lists in any state (moving, raided, unproven, duplicate) and are not arrivals or success. A response or a sending is never reported as an arrival or as success.',
  'mine.requests and mine.responses carry request ids, states, needs and counts only: not the other party\'s wallet, not free-form text (the board\'s nation.why / nationWhy included), not the board\'s raw records, signatures or proofs.',
  'The response body is read as a bounded stream (maxBytes) under one deadline (timeoutMs); a response without a readable body stream is refused.',
  'A board with more than one context (previous worlds) is refused as unsupported. A board reporting damaged records or store problems is refused as damaged. Nothing is shown partially.',
  'This adapter grants nothing: it is not a permission source and cannot enable send_caravan to another owner\'s place.',
]);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SEASON_ID = /^[A-Za-z0-9._-]{1,32}$/;
const CLUSTER = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const WORD = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const NATION = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const RESOURCE = /^[A-Z][A-Za-z]{1,15}$/;
const CONTEXT_KEYS = Object.freeze(['programId', 'seasonId', 'cluster']);
const CONFIG_PATH = '/coop/config';
const VIEW_PATH = '/coop/view';
const MAX_LIST = 1000;
const MIN_TIMEOUT_MS = 1, MAX_TIMEOUT_MS = 60_000;
const MIN_BYTES = 1024, MAX_BYTES = 16 * 1024 * 1024;

const isPlainObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCount = x => Number.isSafeInteger(x) && x >= 0;
const UNKNOWN_NATION_NOTE = 'the board has not verified this wallet\'s nationality; nation counts are unknown, not 0';

class Reject extends Error {
  constructor(status, why) { super(why); this.status = status; this.why = why; }
}
const reject = (status, why) => { throw new Reject(status, why); };

function result(status, why, { source = null, world = null, owner = null, nation = null, mine = null } = {}) {
  return { ok: status === 'ok', status, why, source, world, owner, nation, mine, limitations: COOP_READ_LIMITATIONS };
}

/**
 * The trusted board base: http(s), no userinfo, no query, no fragment; an optional path prefix of plain segments.
 * Returns {href, origin, path} with href = origin + path (no trailing slash). Throws TypeError otherwise.
 */
export function normaliseBoardBase(base) {
  if (typeof base !== 'string' || base.length === 0 || base.length > 2048) throw new TypeError('coop board base: an http(s) URL string is required');
  if (/[?#]/.test(base)) throw new TypeError('coop board base: query or fragment not allowed');
  let u;
  try { u = new URL(base); } catch { throw new TypeError('coop board base: not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('coop board base: http(s) only');
  if (u.username !== '' || u.password !== '') throw new TypeError('coop board base: userinfo not allowed');
  if (u.search !== '' || u.hash !== '') throw new TypeError('coop board base: query or fragment not allowed');
  const path = u.pathname.replace(/\/+$/, '');
  if (path !== '' && !/^(\/[A-Za-z0-9._-]+)+$/.test(path)) throw new TypeError('coop board base: path prefix must be plain segments');
  return Object.freeze({ href: u.origin + path, origin: u.origin, path });
}

function checkPrincipal(principal) {
  if (!isPlainObject(principal)) return { ok: false, why: 'principal: an authenticated principal object is required' };
  if (typeof principal.owner !== 'string' || !BASE58.test(principal.owner)) return { ok: false, why: 'principal.owner: not a wallet address' };
  const scopes = principal.scopes;
  if (!Array.isArray(scopes) || !scopes.every(s => typeof s === 'string')) return { ok: false, why: 'principal.scopes: a list of scope strings is required' };
  if (!scopes.includes(COOP_READ_SCOPE)) return { ok: false, why: `principal.scopes: ${COOP_READ_SCOPE} is required` };
  return { ok: true, owner: principal.owner };
}

function checkContext(context) {
  if (!isPlainObject(context)) return { ok: false, why: 'context: the trusted current game context {programId, seasonId, cluster} is required' };
  const extra = Object.keys(context).filter(k => !CONTEXT_KEYS.includes(k));
  if (extra.length) return { ok: false, why: `context: unknown field(s) ${extra.join(', ')}; no viewer or wallet can be chosen here` };
  const { programId, seasonId, cluster } = context;
  if (typeof programId !== 'string' || !BASE58.test(programId)) return { ok: false, why: 'context.programId: not a program address' };
  if (!(typeof seasonId === 'string' || isCount(seasonId))) return { ok: false, why: 'context.seasonId: a string or non-negative integer is required' };
  const season = String(seasonId);
  if (!SEASON_ID.test(season)) return { ok: false, why: 'context.seasonId: malformed' };
  if (typeof cluster !== 'string' || !CLUSTER.test(cluster)) return { ok: false, why: 'context.cluster: malformed' };
  return { ok: true, world: Object.freeze({ programId, seasonId: season, cluster }) };
}

/** The board's {programId, seasonId} (seasonId as the board does: String()) names the current world. */
function sameSeason(c, world) {
  return isPlainObject(c) && c.programId === world.programId && (typeof c.seasonId === 'string' || isCount(c.seasonId)) && String(c.seasonId) === world.seasonId;
}

/** contexts / damaged / store.problems, common to config and view. Returns null when acceptable. */
function checkEnvelope(doc, world, what) {
  if (!isPlainObject(doc)) return { status: 'malformed', why: `${what}: not an object` };
  if (!Array.isArray(doc.contexts) || !Array.isArray(doc.damaged) || !isPlainObject(doc.store) || !Array.isArray(doc.store.problems)) return { status: 'malformed', why: `${what}: contexts, damaged or store missing` };
  if (!doc.contexts.every(isPlainObject)) return { status: 'malformed', why: `${what}: a context is not an object` };
  if (doc.contexts.length !== 1) return { status: 'unsupported', why: `${what}: the board carries ${doc.contexts.length} contexts (previous worlds); only a single-context board is read` };
  if (!sameSeason(doc.contexts[0], world)) return { status: 'mismatch', why: `${what}: the board's context is not the current world` };
  if (doc.damaged.length > 0 || doc.store.problems.length > 0) return { status: 'damaged', why: `${what}: the board reports ${doc.damaged.length} damaged record(s) and ${doc.store.problems.length} store problem(s); nothing is shown` };
  return null;
}

function checkConfig(cfg, world) {
  if (!isPlainObject(cfg) || !isPlainObject(cfg.season)) return { status: 'malformed', why: 'config: season missing' };
  if (!sameSeason(cfg.season, world)) return { status: 'mismatch', why: 'config: the board\'s season is not the current world' };
  if (typeof cfg.cluster !== 'string' || cfg.cluster !== world.cluster) return { status: 'mismatch', why: 'config: the board\'s cluster is not the current cluster' };
  const env = checkEnvelope(cfg, world, 'config');
  if (env) return env;
  if (cfg.judge !== undefined && cfg.judge !== null && (typeof cfg.judge !== 'string' || !WORD.test(cfg.judge))) return { status: 'malformed', why: 'config: judge is not a name' };
  return null;
}

/** What must not change between the two config reads. */
function configKey(cfg) {
  return JSON.stringify({ programId: cfg.season.programId, seasonId: String(cfg.season.seasonId), cluster: cfg.cluster,
    contexts: cfg.contexts.map(c => [c.programId, String(c.seasonId)]), damaged: cfg.damaged.length, problems: cfg.store.problems.length, judge: cfg.judge ?? null });
}

function projectNation(nation) {
  if (!isPlainObject(nation)) reject('malformed', 'view.nation: missing although a viewer was named');
  // The board's free-form nation.why (and personal.nationWhy) is never copied out: a fixed note only.
  if (nation.nation === null) {
    return { status: 'unknown', nation: null, requests: null, deliveredFromNation: null, note: UNKNOWN_NATION_NOTE };
  }
  if (typeof nation.nation !== 'string' || !NATION.test(nation.nation)) reject('malformed', 'view.nation.nation: not a nation name');
  if (!isCount(nation.requests) || !isCount(nation.deliveredFromNation)) reject('malformed', 'view.nation: requests or deliveredFromNation is not a count');
  return { status: 'verified', nation: nation.nation, requests: nation.requests, deliveredFromNation: nation.deliveredFromNation, note: null };
}

function cargoOf(need, what) {
  if (!isPlainObject(need)) reject('malformed', `${what}: need is not an object`);
  const out = {};
  for (const [r, v] of Object.entries(need)) {
    if (!RESOURCE.test(r) || !isCount(v)) reject('malformed', `${what}: need has an entry that is not a whole resource amount`);
    out[r] = v;
  }
  return out;
}

/**
 * {listed, counted}. listed = every entry the board lists in that arrivals list, in any state (moving, raided,
 * delivered-but-unproven, duplicates): NOT arrivals and NOT success. counted = the entries the board verified and
 * counted (a counted object, not a duplicate).
 */
function arrivalCounts(list, what, responder = null) {
  if (!Array.isArray(list) || list.length > MAX_LIST) reject('malformed', `${what}: arrivals is not a list`);
  let counted = 0;
  for (const a of list) {
    if (!isPlainObject(a)) reject('malformed', `${what}: an arrival is not an object`);
    if (responder !== null && a.responder !== responder) reject('malformed', `${what}: an arrival of another responder is listed as the owner's`);
    if (a.counted !== null && a.counted !== undefined && !isPlainObject(a.counted)) reject('malformed', `${what}: an arrival's counted is not an object`);
    if (isPlainObject(a.counted) && !a.duplicateOf) counted += 1;
  }
  return { listed: list.length, counted };
}

function fulfilmentOf(f, what) {
  if (f === null || f === undefined) return null;
  if (typeof f === 'string') return WORD.test(f) ? f : reject('malformed', `${what}: fulfilment is not a name`);
  if (isPlainObject(f)) return typeof f.status === 'string' && WORD.test(f.status) ? f.status : null;
  reject('malformed', `${what}: fulfilment has an unrecognised shape`);
}

function indexRequests(list) {
  if (!Array.isArray(list) || list.length > MAX_LIST) reject('malformed', 'view.requests: not a list');
  const m = new Map();
  for (const q of list) {
    if (!isPlainObject(q) || typeof q.id !== 'string' || !ID.test(q.id)) reject('malformed', 'view.requests: a request without a valid id');
    if (m.has(q.id)) reject('malformed', 'view.requests: duplicate request id');
    m.set(q.id, q);
  }
  return m;
}

/** The board's full request behind an id in the owner's lists; it must exist and belong to the current world. */
function requestOf(index, id, world, what) {
  if (typeof id !== 'string' || !ID.test(id)) reject('malformed', `${what}: bad request id`);
  const q = index.get(id);
  if (!q) reject('malformed', `${what}: a listed request is not among the board's requests`);
  if (q.ctx !== undefined && q.ctx !== null && !sameSeason(q.ctx, world)) reject('mismatch', `${what}: a listed request belongs to another world`);
  if (typeof q.requester !== 'string' || !BASE58.test(q.requester)) reject('malformed', `${what}: a listed request has no requester`);
  return q;
}

function projectMine(view, owner, world, nationName) {
  const p = view.personal;
  if (!isPlainObject(p)) reject('malformed', 'view.personal: missing although a viewer was named');
  if (p.viewer !== owner) reject('mismatch', 'view.personal.viewer: the board answered for another wallet');
  if ((p.nation ?? null) !== nationName) reject('malformed', 'view.personal.nation: differs from view.nation.nation');
  if (!Array.isArray(p.myRequests) || !Array.isArray(p.myResponses) || !Array.isArray(p.left) || !isPlainObject(p.myVerified)) reject('malformed', 'view.personal: myRequests, myResponses, myVerified or left missing');
  if (p.myRequests.length > MAX_LIST || p.myResponses.length > MAX_LIST || p.left.length > MAX_LIST) reject('malformed', 'view.personal: a list is too long');
  const index = indexRequests(view.requests);

  const seenQ = new Set();
  const requests = p.myRequests.map(r => {
    const what = 'view.personal.myRequests';
    if (!isPlainObject(r)) reject('malformed', `${what}: an entry is not an object`);
    const q = requestOf(index, r.id, world, what);
    if (q.requester !== owner) reject('malformed', `${what}: a request of another wallet is listed as the owner's`);
    if (seenQ.has(r.id)) reject('malformed', `${what}: duplicate request id`);
    seenQ.add(r.id);
    if (typeof r.state !== 'string' || !WORD.test(r.state)) reject('malformed', `${what}: state is not a name`);
    return { id: r.id, state: r.state, need: cargoOf(r.need, what), entries: arrivalCounts(r.arrivals, what), fulfilment: fulfilmentOf(r.fulfilment, what) };
  });

  const seenR = new Set();
  const responses = p.myResponses.map(r => {
    const what = 'view.personal.myResponses';
    if (!isPlainObject(r)) reject('malformed', `${what}: an entry is not an object`);
    const q = requestOf(index, r.id, world, what);
    if (!isPlainObject(q.responses) || !isPlainObject(q.responses[owner])) reject('malformed', `${what}: the board lists a request the owner did not respond to`);
    if (seenR.has(r.id)) reject('malformed', `${what}: duplicate request id`);
    seenR.add(r.id);
    return { id: r.id, responded: true, myEntries: arrivalCounts(r.arrivals, what, owner) };
  });

  const verified = {};
  for (const [r, v] of Object.entries(p.myVerified)) {
    if (!RESOURCE.test(r) || !Number.isSafeInteger(v) || v < 1) reject('malformed', 'view.personal.myVerified: an entry is not a positive whole amount');
    verified[r] = v;
  }
  const left = p.left.map(g => (typeof g === 'string' && ID.test(g) ? g : reject('malformed', 'view.personal.left: a goal id is malformed')));
  return { requests, responses, verified, left };
}

function heraldFeedOf(view) {
  if (view.heraldFeed === null) return 'unavailable';
  if (isPlainObject(view.heraldFeed)) return 'read';
  reject('malformed', 'view.heraldFeed: unrecognised');
}

/**
 * The factory. Trusted deployment config only:
 *   publicViewConfirmed  must be exactly true, meaning "this specific board's /coop/* is meant to be public";
 *                        anything else returns a disabled adapter that never fetches (default);
 *   baseUrl              http(s) base of the board, no userinfo/query/fragment (normaliseBoardBase); required when on;
 *   fetch                injected fetch; required when on; globalThis.fetch is never used;
 *   timeoutMs            per request, 1..60000 (default 5000); maxBytes per body, 1 KiB..16 MiB (default 1 MiB);
 *   timers               {setTimeout, clearTimeout} (tests inject fakes; default globalThis).
 * Returns {enabled, origin, read}.
 */
export function createCoopReadAdapter(config = {}) {
  const c = isPlainObject(config) ? config : {};
  if (c.publicViewConfirmed !== true) {
    const why = 'coop board reading is off: the deployment did not confirm this board as public (publicViewConfirmed: true)';
    return Object.freeze({ enabled: false, origin: null, read: async () => result('disabled', why) });
  }
  if (typeof c.fetch !== 'function') throw new TypeError('coop board adapter: an injected fetch is required when enabled');
  const base = normaliseBoardBase(c.baseUrl);
  const timeoutMs = c.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError('coop board adapter: timeoutMs out of range');
  const maxBytes = c.maxBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_BYTES || maxBytes > MAX_BYTES) throw new TypeError('coop board adapter: maxBytes out of range');
  const timers = isPlainObject(c.timers) && typeof c.timers.setTimeout === 'function' && typeof c.timers.clearTimeout === 'function'
    ? c.timers : { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: t => globalThis.clearTimeout(t) };
  const fetchImpl = c.fetch;
  const sourceOf = (judge = null, heraldFeed = null) => ({ kind: 'coop-board', origin: base.origin, readOnly: true, judge, heraldFeed });

  const headerOf = (res, name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
  const quietly = fn => { try { const p = fn(); if (p && typeof p.then === 'function') p.then(null, () => {}); } catch { /* best effort */ } };

  /**
   * One bounded GET of a fixed board path. Only the two paths above, only on the configured base.
   * The body is read chunk by chunk from res.body (a stream with getReader) and the read stops, and the stream is
   * cancelled, as soon as the bytes received exceed maxBytes; res.text()/res.json() are never called (they would
   * buffer an unbounded body first). A response without a readable stream is refused, not read some other way.
   * The fetch and every chunk read race one deadline, so a fetch that ignores the abort signal still ends the read.
   */
  async function getJson(path, query = '') {
    const href = base.href + path + query;
    let u;
    try { u = new URL(href); } catch { return { ok: false, why: `${path}: could not form the board URL` }; }
    if (u.origin !== base.origin || u.pathname !== base.path + path || u.search !== query || u.hash !== '' || u.username !== '' || u.password !== '') {
      return { ok: false, why: `${path}: the board URL left the configured base` };
    }
    const late = { ok: false, why: `${path}: timed out after ${timeoutMs} ms` };
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false, timer = null;
    const deadline = new Promise((_, fail) => {
      timer = timers.setTimeout(() => { timedOut = true; if (ac) quietly(() => ac.abort()); fail(new Error('timeout')); }, timeoutMs);
    });
    deadline.then(null, () => {});
    const within = p => Promise.race([p, deadline]);
    let res = null, reader = null, finished = false;
    try {
      try {
        res = await within(fetchImpl(u.href, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' }, signal: ac ? ac.signal : undefined }));
      } catch {
        return timedOut ? late : { ok: false, why: `${path}: the fetch failed` };
      }
      if (timedOut) return late;
      if (!res || typeof res !== 'object' || !Number.isInteger(res.status)) return { ok: false, why: `${path}: no response` };
      if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect' || res.redirected === true) return { ok: false, why: `${path}: redirect refused (HTTP ${res.status})` };
      if (typeof res.url === 'string' && res.url !== '' && res.url !== u.href) return { ok: false, why: `${path}: the response came from another URL (redirect refused)` };
      if (res.status !== 200) return { ok: false, why: `${path}: HTTP ${res.status}` };
      const len = headerOf(res, 'content-length');
      if (len !== null && len !== undefined && (!/^\d{1,15}$/.test(String(len)) || Number(len) > maxBytes)) return { ok: false, why: `${path}: body too large` };
      if (!res.body || typeof res.body.getReader !== 'function') return { ok: false, why: `${path}: no readable body stream (an unbounded read is refused)` };
      try { reader = res.body.getReader(); } catch { return { ok: false, why: `${path}: body unreadable` }; }
      const chunks = [];
      let size = 0;
      for (;;) {
        let step;
        try { step = await within(reader.read()); } catch { return timedOut ? late : { ok: false, why: `${path}: body unreadable` }; }
        if (timedOut) return late;
        if (!isPlainObject(step)) return { ok: false, why: `${path}: body unreadable` };
        if (step.done === true) { finished = true; break; }
        if (!(step.value instanceof Uint8Array)) return { ok: false, why: `${path}: body unreadable` };
        size += step.value.byteLength;
        if (size > maxBytes) return { ok: false, why: `${path}: body too large` };
        chunks.push(step.value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const ch of chunks) { bytes.set(ch, at); at += ch.byteLength; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, why: `${path}: body is not UTF-8` }; }
      let json;
      try { json = JSON.parse(text); } catch { return { ok: false, why: `${path}: not JSON` }; }
      if (!isPlainObject(json)) return { ok: false, why: `${path}: not a JSON object` };
      return { ok: true, json };
    } finally {
      timers.clearTimeout(timer);
      if (reader && !finished) quietly(() => reader.cancel());
      else if (!reader && res && res.body && typeof res.body.cancel === 'function') quietly(() => res.body.cancel());
    }
  }

  /**
   * read({principal, context}): principal = the authenticated caller ({owner: wallet, scopes: [...]} with
   * wylls.read); context = the trusted current world {programId, seasonId, cluster} as the server knows it.
   * Never a caller-selected viewer or foreign wallet. See COOP-READ-ADAPTER.md for the result.
   */
  async function read({ principal, context } = {}) {
    const source = sourceOf();
    const p = checkPrincipal(principal);
    if (!p.ok) return result('refused', p.why, { source });
    const cx = checkContext(context);
    if (!cx.ok) return result('refused', cx.why, { source, owner: p.owner });
    const at = { source, world: cx.world, owner: p.owner };

    const cfg1 = await getJson(CONFIG_PATH);
    if (!cfg1.ok) return result('unavailable', cfg1.why, at);
    const bad1 = checkConfig(cfg1.json, cx.world);
    if (bad1) return result(bad1.status, bad1.why, at);

    const view = await getJson(VIEW_PATH, `?viewer=${encodeURIComponent(p.owner)}`);
    if (!view.ok) return result('unavailable', view.why, at);

    const cfg2 = await getJson(CONFIG_PATH);
    if (!cfg2.ok) return result('unavailable', `after the view, ${cfg2.why}`, at);
    const bad2 = checkConfig(cfg2.json, cx.world);
    if (bad2) return result(bad2.status === 'malformed' ? 'malformed' : 'changed', `the board changed while reading: ${bad2.why}`, at);
    if (configKey(cfg1.json) !== configKey(cfg2.json)) return result('changed', 'the board changed while reading: config differs before and after the view', at);

    try {
      const env = checkEnvelope(view.json, cx.world, 'view');
      if (env) return result(env.status, env.why, at);
      if (configKey(cfg1.json) !== configKey({ ...cfg1.json, contexts: view.json.contexts, damaged: view.json.damaged, store: view.json.store })) {
        return result('changed', 'the board changed while reading: the view\'s contexts or store differ from config', at);
      }
      const nation = projectNation(view.json.nation);
      const mine = projectMine(view.json, p.owner, cx.world, nation.nation);
      const heraldFeed = heraldFeedOf(view.json);
      return result('ok', null, { ...at, source: sourceOf(cfg1.json.judge ?? null, heraldFeed), nation, mine });
    } catch (e) {
      if (e instanceof Reject) return result(e.status, e.why, at);
      throw e;
    }
  }

  return Object.freeze({ enabled: true, origin: base.origin, read });
}
