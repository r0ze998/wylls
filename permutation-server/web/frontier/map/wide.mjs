// The recorded wide world, read-only (map growth, docs/frontier/map-growth/
// WIDE-WORLD-INDEX.md): the herald's `/h/world/wide` manifest and pages,
// decoded strictly, walked in bounded pages, and laid out relative to a
// BigInt camera origin. Pure: no DOM, no fetch of its own (loadWide takes a
// client and an AbortSignal). widemode.mjs is the page's side.
//
// What a page here is: the Provinces the herald's fold CAPTURED, presented
// through its lossless legacy adapter as (world, P, Q) with P and Q as
// decimal strings. It is never a proof of completeness (a place not listed
// is UNKNOWN: neither open nor closed), never new land (every entry is a
// captured legacy or experimental wide record), and never trusted for anything the page would
// sign (nothing here is signed or sent).
//
// Precision: a coordinate is a BigInt from the moment it is read; nothing
// passes a global coordinate through Number. The camera keeps a BigInt
// origin and the layout works on the small BigInt difference to it, which
// becomes a Number only once it is known to be small (relativeTo).
import { sha256 } from '../../sdk/sha256.mjs';
import { decode as fromB58 } from '../../sdk/base58.mjs';
import { toHex } from '../../sdk/bytes.mjs';
import { checkCapturedBytes } from './widecapture.mjs';

/** |P|, |Q| ≤ 2⁶² (frontier-abi world_index WIDE_BOUND). */
export const WIDE_BOUND = 1n << 62n;
/** Most entries one page may carry (world_index MAX_PAGE). */
export const PAGE_MAX = 256;
/** Entries per page the mode asks for. */
export const PAGE_DEFAULT = 64;
/** Pages one walk reads at most (64 × 256 = 16,384 entries): past that the walk says it was cut. */
export const WALK_MAX_PAGES = 64;
/** A cursor's canonical bytes (world_index CURSOR_LEN), as hex. */
export const CURSOR_HEX_LEN = 212;
/** `WorldId::derive_legacy_season`'s domain. */
export const WORLD_DOMAIN = 'PSF-WORLD-v1/legacy-season';
/** A relative offset the layout accepts (a lattice difference that fits a plain integer with room to spare). */
export const RELATIVE_LIMIT = 1n << 31n;

const DEC_RE = /^(0|-?[1-9][0-9]*)$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const CURSOR_RE = /^[0-9a-f]{212}$/;
const ZERO64 = '0'.repeat(64);

export class WideError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}
const check = (cond, code, msg) => { if (!cond) throw new WideError(code, msg); };

// ------------------------------------------------------------------ integers and geometry (BigInt)
/** A canonical decimal string → BigInt within ±bound; anything else (a sign on zero, leading zeros, blanks, exponents, a Number) is refused. */
export function parseWideInt(s, { bound = WIDE_BOUND, code = 'BadCoord' } = {}) {
  check(typeof s === 'string' && s.length <= 20 && DEC_RE.test(s), code, `${String(s)} is not a canonical decimal integer`);
  const v = BigInt(s);
  check(v >= -bound && v <= bound, code, `${s} is outside ±${bound}`);
  return v;
}

/** A canonical decimal string of an unsigned 64-bit value → BigInt. */
export const parseU64 = (s, code = 'BadValue') => {
  check(typeof s === 'string' && s.length <= 20 && /^(0|[1-9][0-9]*)$/.test(s), code, `${String(s)} is not a decimal u64`);
  const v = BigInt(s);
  check(v <= 0xffffffffffffffffn, code, `${s} exceeds u64`);
  return v;
};

const abs = x => (x < 0n ? -x : x);

/** Hex distance of province (p, q) from the Concord, exact. */
export const ringOfWide = (p, q) => (abs(p) + abs(q) + abs(p + q)) / 2n;

/**
 * Ring, wedge (sextant) and position along the wedge, the rule of
 * frontier-abi `WideCoord::ring_position`: the wedge is the first of six
 * 60° turns back that lands in {q > 0, r ≥ 0}; the position is the r there.
 * → {ring: BigInt, wedge: 0–5, pos: BigInt}; the Concord is (0, 0, 0).
 */
export function ringPosition(p, q) {
  const ring = ringOfWide(p, q);
  if (ring === 0n) return { ring, wedge: 0, pos: 0n };
  let [a, b] = [p, q];
  for (let wedge = 0; wedge < 6; wedge++) {
    if (a > 0n && b >= 0n) return { ring, wedge, pos: b };
    [a, b] = [a + b, -a];
  }
  throw new WideError('BadCoord', 'a nonzero hex lies in one of six sextants');
}

/** Ring order (the index's sort-key order): −1, 0 or 1. */
export function compareRingOrder(x, y) {
  if (x.ring !== y.ring) return x.ring < y.ring ? -1 : 1;
  if (x.wedge !== y.wedge) return x.wedge < y.wedge ? -1 : 1;
  if (x.pos !== y.pos) return x.pos < y.pos ? -1 : 1;
  return 0;
}

/** The world namespace of a legacy season, as the herald derives it: sha256(domain ‖ season PDA ‖ program), hex. Public bytes only. */
export function worldIdOf(seasonAddress, programId) {
  let season, program;
  try {
    check(typeof seasonAddress === 'string' && seasonAddress.length <= 44 && typeof programId === 'string' && programId.length <= 44, 'BadAddress', 'address length');
    season = fromB58(seasonAddress); program = fromB58(programId);
  } catch { throw new WideError('BadAddress', 'invalid public address'); }
  check(season.length === 32 && program.length === 32, 'BadAddress', 'a season PDA and a program id are 32 bytes each');
  return toHex(sha256(WORLD_DOMAIN, season, program));
}

export const coordKey = (p, q) => `${p},${q}`;
/** The exact text of a coordinate (never a rounded number). */
export const formatCoord = (p, q) => `P ${p}, Q ${q}`;

// ------------------------------------------------------------------ the manifest
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (o, k, code = 'BadManifest') => { check(typeof o?.[k] === 'string', code, `${k} is not a string`); return o[k]; };
const hex64 = (o, k, code = 'BadManifest') => { const s = str(o, k, code); check(HEX64_RE.test(s), code, `${k} is not 32 bytes of hex`); check(s !== ZERO64, code, `${k} is the reserved zero world`); return s; };
const snapshotOf = (o, code) => {
  check(isObj(o?.snapshot), code, 'no snapshot');
  const epoch = parseU64(o.snapshot.epoch, code);
  const stamp = str(o.snapshot, 'stamp', code);
  check(HEX64_RE.test(stamp), code, 'snapshot stamp');
  return Object.freeze({ epoch, stamp });
};
const sameSnapshot = (a, b) => a.epoch === b.epoch && a.stamp === b.stamp;

/**
 * `/h/world/wide` → `{world, season, program, seasonAddress, snapshot: {epoch (BigInt), stamp}, recorded, refused,
 * legacy: {rMax, rMaxHard, ringsOpened, provinces}, page: {path, max, default}}`, checked: a v1, experimental,
 * read-only, "captured" manifest whose world equals sha256(domain ‖ seasonAddress ‖ program) and, when the caller
 * pins them, whose season, seasonAddress and program are the page's. A record that marks itself a sample or
 * prototype world is refused (`SampleWorld`): a sample must never pass as the recorded chain.
 */
export function parseWideManifest(j, { seasonId, seasonAddress, programId } = {}) {
  check(isObj(j), 'BadManifest', 'not an object');
  check(!('sample' in j) && !('proto' in j) && j.sample !== true, 'SampleWorld', 'a sample world has no recorded wide world');
  check(j.v === 1, 'BadManifest', `v ${j.v}`);
  check(j.experimental === true && j.readOnly === true, 'BadManifest', 'not the experimental read-only world');
  check(j.completeness === 'captured', 'BadManifest', 'a manifest that claims more than captured data is not this format');
  const world = hex64(j, 'world');
  check(j.worldDomain === WORLD_DOMAIN, 'BadManifest', `worldDomain ${j.worldDomain}`);
  const season = parseU64(str(j, 'season'), 'BadManifest').toString();
  const program = str(j, 'program'), address = str(j, 'seasonAddress');
  check(worldIdOf(address, program) === world, 'WorldMismatch', 'the world is not the namespace of its own season and program');
  if (seasonId !== undefined && seasonId !== null) check(season === String(seasonId), 'WrongSeason', `season ${season}, the page is on ${seasonId}`);
  if (seasonAddress) check(address === String(seasonAddress), 'WrongSeason', 'another Season account');
  if (programId) check(program === String(programId), 'WrongSeason', 'another program');
  const snapshot = snapshotOf(j, 'BadManifest');
  // Herald emits these on the manifest, not on each page. Keep them separate
  // from the index cursor identity, which may outlive ordinary legacy polling.
  const hasBounds = j.snapshot.lastSlot !== undefined || j.snapshot.foldedThrough !== undefined;
  const captureBounds = hasBounds ? Object.freeze({ lastSlot: parseU64(j.snapshot.lastSlot, 'BadManifest'),
    foldedThrough: parseU64(j.snapshot.foldedThrough, 'BadManifest') }) : null;
  const count = k => { check(Number.isSafeInteger(j[k]) && j[k] >= 0, 'BadManifest', `${k}`); return j[k]; };
  const legacy = isObj(j.legacy) ? j.legacy : {};
  const page = isObj(j.page) ? j.page : {};
  const max = Number.isInteger(page.max) && page.max >= 1 ? Math.min(page.max, PAGE_MAX) : PAGE_MAX;
  return Object.freeze({
    world, season, program, seasonAddress: address, snapshot, captureBounds,
    recorded: count('recorded'), refused: count('refused'),
    legacy: Object.freeze({
      rMax: Number.isInteger(legacy.rMax) ? legacy.rMax : null,
      rMaxHard: Number.isInteger(legacy.rMaxHard) ? legacy.rMaxHard : null,
      ringsOpened: Number.isInteger(legacy.ringsOpened) ? legacy.ringsOpened : null,
      provinces: Number.isInteger(legacy.provinces) ? legacy.provinces : null,
    }),
    page: Object.freeze({ path: typeof page.path === 'string' ? page.path : '/h/world/wide/page', max, default: Number.isInteger(page.default) ? Math.min(page.default, max) : Math.min(PAGE_DEFAULT, max) }),
  });
}

// ------------------------------------------------------------------ a page
function entryOf(e, i, world, manifest) {
  const at = `entries[${i}]`;
  check(isObj(e), 'BadPage', `${at}: not an object`);
  const p = parseWideInt(e.p), q = parseWideInt(e.q);
  const rp = ringPosition(p, q);
  // the herald's ring, wedge and position are recomputed here, never believed
  check(parseU64(e.ring, 'BadPage') === rp.ring, 'BadPage', `${at}: ring ${e.ring} is not the ring of (${p}, ${q})`);
  check(e.wedge === rp.wedge, 'BadPage', `${at}: wedge`);
  check(parseU64(e.pos, 'BadPage') === rp.pos, 'BadPage', `${at}: position`);
  check(e.state === 'open' || e.state === 'closed', 'BadPage', `${at}: state ${e.state}`);
  const revision = parseU64(e.revision, 'BadPage');
  check(revision >= 1n, 'BadPage', `${at}: revision 0`);
  const observedAt = parseU64(e.observedAt, 'BadPage');
  let legacy = null;
  if (e.legacy !== null && e.legacy !== undefined) {
    const l = e.legacy;
    check(isObj(l) && Number.isSafeInteger(l.p) && Number.isSafeInteger(l.q) && l.p >= -32768 && l.p <= 32767 && l.q >= -32768 && l.q <= 32767, 'BadPage', `${at}: legacy`);
    // the legacy pair is the same place, exactly (an i16 pair always fits)
    check(BigInt(l.p) === p && BigInt(l.q) === q, 'BadPage', `${at}: the legacy pair is another place`);
    check(l.ring === undefined || l.ring === null || BigInt(l.ring) === rp.ring, 'BadPage', `${at}: legacy ring`);
    legacy = Object.freeze({
      p: l.p, q: l.q,
      index: Number.isInteger(l.index) ? l.index : null,
      ring: Number.isInteger(l.ring) ? l.ring : null,
      region: Number.isInteger(l.region) ? l.region : null,
      openedBell: Number.isInteger(l.openedBell) ? l.openedBell : null,
      slot: Number.isSafeInteger(l.slot) && l.slot >= 0 ? l.slot : null,
      address: typeof l.address === 'string' ? l.address : null,
    });
  }
  const wide = capturedWide(e.wide, { world, p, q, ...rp, state: e.state, legacy, manifest });
  return Object.freeze({ p, q, key: coordKey(p, q), ring: rp.ring, wedge: rp.wedge, pos: rp.pos, state: e.state, revision, observedAt, legacy, wide });
}

// Captured wide accounts are explicit, bounded and never reinterpreted as legacy
// P/Q fields. These are server-reported captures, not client-verified event history.
function capturedWide(j, expected) {
  if (j === null || j === undefined) return null;
  const { world, p, q, ring, state, legacy } = expected;
  const valid = (yes, why) => check(yes, 'BadWideCapture', why);
  const checked = (kind, summary, value) => {
    try { checkCapturedBytes(kind, summary, value, expected); }
    catch (e) { throw new WideError('BadWideCapture', e.message); }
    return value;
  };
  const identity = h => {
    valid(isObj(h) && h.world === world, 'capture world');
    valid(parseWideInt(h.p) === p && parseWideInt(h.q) === q, 'capture coordinate');
  };
  const address = s => {
    valid(typeof s === 'string' && s.length <= 44, 'capture address');
    try { valid(fromB58(s).length === 32, 'capture address'); }
    catch { throw new WideError('BadWideCapture', 'capture address'); }
    return s;
  };
  const capture = (c, byteLength) => {
    valid(isObj(c) && c.verification === 'captured-unverified', 'capture verification');
    valid(c.postState === 'transaction' || c.postState === 'at-or-after-transaction', 'capture timing');
    valid(typeof c.bytes_b64 === 'string' && c.bytes_b64.length === 4 * Math.ceil(byteLength / 3)
      && /^[A-Za-z0-9+/]+={0,2}$/.test(c.bytes_b64), 'capture bytes');
    return Object.freeze({ address: address(c.address), slot: parseU64(c.slot, 'BadWideCapture'),
      archiveSequence: parseU64(c.archiveSequence, 'BadWideCapture'), postState: c.postState,
      verification: c.verification, bytes_b64: c.bytes_b64 });
  };
  valid(ring > 128n && state === 'open' && legacy === null, 'wide record is not legacy or closed');
  identity(j);
  valid(Number.isInteger(j.openedBell) && j.openedBell >= 0 && j.openedBell <= 0xffffffff, 'opened bell');
  valid(Number.isInteger(j.region) && j.region >= 0 && j.region <= 255, 'region');
  valid(Number.isInteger(j.keepHolder) && j.keepHolder >= 0 && j.keepHolder <= 6, 'keep holder');
  valid(Array.isArray(j.holdings) && j.holdings.length <= 12, 'holdings');
  const seen = new Set();
  const holdings = j.holdings.map(h => {
    identity(h);
    valid(Number.isInteger(h.site) && h.site >= 0 && h.site < 12 && !seen.has(h.site), 'holding site');
    seen.add(h.site);
    valid(Number.isInteger(h.generation) && h.generation >= 1 && h.generation < 255, 'holding generation');
    valid(h.inventorySlot === 2 || h.inventorySlot === 3, 'holding slot');
    return Object.freeze({ world, p, q, site: h.site, generation: h.generation,
      inventorySlot: h.inventorySlot, ownerCitizen: address(h.ownerCitizen), capture: checked('holding', h, capture(h.capture, 1344)) });
  });
  return Object.freeze({ world, p, q, openedBell: j.openedBell, region: j.region,
    keepHolder: j.keepHolder, capture: checked('province', j, capture(j.capture, 4864)), holdings: Object.freeze(holdings) });
}

/**
 * `/h/world/wide/page` → `{entries: [{p, q (BigInt), key, ring, wedge, pos, state, revision, observedAt, legacy}],
 * next (cursor hex | null), snapshot}`, checked against what the walk expects: the world (`WorldChanged`), the
 * snapshot (`StaleSnapshot`), the cursor the page was asked after (`WrongPage`), at most `limit` entries in strictly
 * ascending ring order with no repeat (`OutOfOrder`, `DuplicateEntry`), every ring recomputed, a cursor only after a
 * full page (`BadCursor`), and `previous` (the last entry of the page before) before every entry of this page.
 * Wide captures additionally require the parsed `manifest`: raw ABI identities, summaries, canonical public
 * addresses and capture fold bounds are checked. This is consistency only, never event-chain verification.
 */
export function parseWidePage(j, { world, snapshot, after = null, limit = PAGE_DEFAULT, previous = null, manifest = null } = {}) {
  check(isObj(j), 'BadPage', 'not an object');
  check(!('sample' in j) && !('proto' in j), 'SampleWorld', 'a sample world has no recorded wide world');
  check(j.v === 1, 'BadPage', `v ${j.v}`);
  const w = hex64(j, 'world', 'BadPage');
  if (world !== undefined && world !== null) check(w === world, 'WorldChanged', 'a page of another world');
  const snap = snapshotOf(j, 'BadPage');
  if (snapshot) check(sameSnapshot(snap, snapshot), 'StaleSnapshot', 'a page of another snapshot of the index');
  if (manifest) {
    check(w === manifest.world, 'WorldChanged', 'a page of another manifest world');
    check(sameSnapshot(snap, manifest.snapshot), 'StaleSnapshot', 'a page of another manifest snapshot');
  }
  check((j.after ?? null) === after, 'WrongPage', `asked after ${after}, got a page after ${j.after ?? null}`);
  check(Array.isArray(j.entries), 'BadPage', 'entries');
  check(j.entries.length <= limit, 'BadPage', `${j.entries.length} entries for a limit of ${limit}`);
  const entries = j.entries.map((e, i) => entryOf(e, i, w, manifest));
  let last = previous;
  for (const e of entries) {
    if (last) {
      const c = compareRingOrder(last, e);
      check(c !== 0, 'DuplicateEntry', `${e.key} twice`);
      check(c < 0, 'OutOfOrder', `${e.key} after ${last.key}`);
    }
    last = e;
  }
  let next = null;
  if (j.next !== null && j.next !== undefined) {
    check(typeof j.next === 'string' && CURSOR_RE.test(j.next), 'BadCursor', 'next is not a cursor');
    check(entries.length === limit, 'BadCursor', 'a cursor after a short page');
    check(j.next !== after, 'BadCursor', 'the cursor does not advance');
    next = j.next;
  }
  return Object.freeze({ world: w, snapshot: snap, entries: Object.freeze(entries), next });
}

// ------------------------------------------------------------------ the walk (page state)
/**
 * The state of one walk over the pages of one snapshot of one world. `begin(manifest)` opens it; `accept(json)`
 * takes the next page and answers 'applied' | 'done' | a refusal code (the walk is then `faulted` and keeps
 * nothing of that page); `token` changes on every `reset`, so a reader that outlives a reset drops its answer.
 */
export class WideWalk {
  constructor({ limit = PAGE_DEFAULT, maxPages = WALK_MAX_PAGES } = {}) {
    this.limit = Math.max(1, Math.min(PAGE_MAX, limit | 0));
    this.maxPages = Math.max(1, maxPages | 0);
    this.token = 0;
    this.reset();
  }
  reset() {
    this.token++;
    this.manifest = null;
    this.world = null;
    this.snapshot = null;
    this.after = null;
    this.pages = 0;
    this.entries = new Map();
    this.last = null;
    this.done = false;
    this.truncated = false;
    this.fault = null;
    return this.token;
  }
  /** Opens a walk over `manifest` (parseWideManifest's) and says the page limit to ask for. */
  begin(manifest) {
    const token = this.reset();
    this.manifest = manifest;
    this.world = manifest.world;
    this.snapshot = manifest.snapshot;
    this.limit = Math.min(this.limit, manifest.page.max);
    return token;
  }
  get open() { return this.world !== null && !this.done && !this.fault; }
  /** What a world with nothing recorded is: done at once. */
  accept(json, token = this.token) {
    if (token !== this.token) return 'aborted';
    if (!this.open) return this.fault ?? 'done';
    let page;
    try {
      page = parseWidePage(json, { world: this.world, snapshot: this.snapshot, after: this.after, limit: this.limit, previous: this.last, manifest: this.manifest });
    } catch (e) {
      this.fault = e instanceof WideError ? e.code : 'BadPage';
      return this.fault;
    }
    const total = this.entries.size + page.entries.length;
    if (total > this.manifest.recorded || (page.next !== null && total >= this.manifest.recorded)) {
      this.fault = 'RecordedCountMismatch'; return this.fault;
    }
    if (page.next === null && total !== this.manifest.recorded) {
      this.fault = 'IncompleteRecordedWorld'; return this.fault;
    }
    for (const e of page.entries) {
      // (parseWidePage already refused a repeat within the page and across the previous page's last entry)
      if (this.entries.has(e.key)) { this.fault = 'DuplicateEntry'; return this.fault; }
      this.entries.set(e.key, e);
    }
    if (page.entries.length) this.last = page.entries[page.entries.length - 1];
    this.pages++;
    this.after = page.next;
    if (page.next === null) { this.done = true; return 'done'; }
    if (this.pages >= this.maxPages) { this.done = true; this.truncated = true; return 'done'; }
    return 'applied';
  }
  /** The entries in ring order. */
  list() { return [...this.entries.values()].sort(compareRingOrder); }
}

/**
 * Reads the whole recorded world through `client` (`wideWorld({signal})`, `wideWorldPage({limit, after, signal})`:
 * herald.mjs's, each answering `{ok, ...}`), into a fresh walk. Answers `{ok: true, walk}` or `{ok: false, code,
 * walk}`; never rejects. `signal` aborts between pages and inside each request (code `Aborted`). A world or snapshot
 * that changes under the walk is a refusal (the caller starts over), never a merge. `pins` are parseWideManifest's.
 */
export async function loadWide(client, { walk = new WideWalk(), signal = null, pins = {}, onPage = () => {} } = {}) {
  const aborted = () => !!signal?.aborted;
  const initialToken = walk.token;
  const m = await client.wideWorld({ signal, pins });
  if (initialToken !== walk.token || aborted()) return { ok: false, code: 'Aborted', walk };
  if (!m.ok) return { ok: false, code: m.code, walk };
  const token = walk.begin(m.manifest);
  while (walk.open) {
    if (aborted()) return { ok: false, code: 'Aborted', walk };
    const r = await client.wideWorldPage({ limit: walk.limit, after: walk.after, signal });
    if (token !== walk.token || aborted()) return { ok: false, code: 'Aborted', walk };
    if (!r.ok) { walk.fault = r.code; return { ok: false, code: r.code, walk }; }
    const a = walk.accept(r.json, token);
    if (a !== 'applied' && a !== 'done') return { ok: false, code: a, walk };
    onPage(walk);
  }
  return { ok: true, walk };
}

// ------------------------------------------------------------------ the camera (BigInt origin)
/** A camera origin at province (p, q) (BigInts or canonical strings). */
export function originAt(p, q) {
  const P = typeof p === 'bigint' ? p : parseWideInt(p), Q = typeof q === 'bigint' ? q : parseWideInt(q);
  check(abs(P) <= WIDE_BOUND && abs(Q) <= WIDE_BOUND, 'BadCoord', 'origin out of bounds');
  return Object.freeze({ p: P, q: Q });
}
export const ORIGIN_CONCORD = originAt(0n, 0n);

/**
 * The lattice offset of (p, q) from `origin` as plain integers, exact: the difference is taken in BigInt and becomes
 * a Number only when |Δ| < RELATIVE_LIMIT; further away answers null (off this camera: recentre first).
 */
export function relativeTo(origin, p, q) {
  const dp = p - origin.p, dq = q - origin.q;
  if (abs(dp) >= RELATIVE_LIMIT || abs(dq) >= RELATIVE_LIMIT) return null;
  return { dp: Number(dp), dq: Number(dq) };
}

/** Entries laid out against `origin`: `[{entry, dp, dq}]` for the near ones, `far` the count left out. */
export function layoutWide(entries, origin) {
  const near = [];
  let far = 0;
  for (const e of entries) {
    const r = relativeTo(origin, e.p, e.q);
    if (r) near.push({ entry: e, dp: r.dp, dq: r.dq }); else far++;
  }
  return { near, far };
}

/** The entry nearest in lattice distance to `origin` (ties: ring order), or null. */
export function nearestTo(entries, origin) {
  let best = null, bestD = null;
  for (const e of entries) {
    const d = ringOfWide(e.p - origin.p, e.q - origin.q);
    if (bestD === null || d < bestD || (d === bestD && compareRingOrder(e, best) < 0)) { best = e; bestD = d; }
  }
  return best;
}

/** What the mode says of its data, as facts: captured records, never completeness; unknown is not open. */
export function describeWalk(walk) {
  if (!walk?.manifest) return { recorded: 0, shown: 0, open: 0, closed: 0, truncated: false, snapshot: null };
  let open = 0, closed = 0;
  for (const e of walk.entries.values()) { if (e.state === 'open') open++; else closed++; }
  return { recorded: walk.manifest.recorded, shown: walk.entries.size, open, closed, truncated: walk.truncated, snapshot: walk.snapshot };
}

/** Pins the reader to a loaded game season, never to an unlabelled sample. */
export function sourcePins(record) {
  check(isObj(record), 'NoSeasonYet', 'the game season is not loaded');
  check(!record.sample && !record.proto, 'SampleWorld', 'sample/prototype source');
  const seasonId = parseU64(record.season, 'NoSeasonYet').toString();
  const seasonAddress = record.seasonAddress, programId = record.programId;
  const world = worldIdOf(seasonAddress, programId);
  const cluster = typeof record.cluster === 'string' ? record.cluster.trim() : 'unknown';
  check(!['fixture', 'sample', 'prototype', 'unknown', ''].includes(cluster.toLowerCase()), 'SampleWorld', 'fixture or unlabelled source is not a recorded game world');
  return Object.freeze({ seasonId, seasonAddress, programId, cluster, key: `${world}:${seasonId}:${cluster}` });
}
