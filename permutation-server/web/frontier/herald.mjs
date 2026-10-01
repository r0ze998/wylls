// The read path: the herald's cached files and WS diffs (contract §8.4,
// §9.2, §9.3; web design §4). The herald is never a trust root: every
// record carries raw account bytes, which the client decodes with its own
// codec (fcodec.mjs) and checks against the key it asked for and the
// pinned season; the herald's decoded JSON is never used for anything the
// client signs or verifies.
//
// Many viewers (§4.2): only what is on screen is fetched; immutable
// per-bell files are cached (LRU, 256 province records); "latest" files
// are not; own entities poll every 10 s while a march or a transaction is
// in flight, else 30 s; overviews once per bell with a 0–15 s jitter after
// the bell; errors back off ×2 up to 5 min; a hidden page pauses polling.
import { fromBase64 } from '../sdk/bytes.mjs';
import { encode as toB58 } from '../sdk/base58.mjs';
import { decode } from './fcodec.mjs';
import { provincesWithin, provinceFromIndex, provinceIndex, cellOf, provinceCentre, ringOf } from './fgeo.mjs';

// ------------------------------------------------------------------ HTTP
/** A failed read (never thrown). */
const fail = (code, error, httpStatus = 0) => ({ ok: false, code, error: error ?? code, httpStatus });

async function get(f, url, { binary = false, timeoutMs = 12_000 } = {}) {
  let r;
  try {
    r = await f(url, { cache: 'no-store', signal: AbortSignal.timeout?.(timeoutMs) });
  } catch {
    return fail('network');
  }
  if (!r.ok) return fail(r.status === 404 ? 'NotFound' : r.status === 425 ? 'TooEarly' : `HTTP${r.status}`, `HTTP ${r.status}`, r.status);
  try {
    return binary ? { ok: true, bytes: new Uint8Array(await r.arrayBuffer()) } : { ok: true, json: await r.json() };
  } catch {
    return fail('BadBody', 'the herald answered something unreadable', r.status);
  }
}

// ------------------------------------------------------------------ small LRU
export class Lru {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { if (!this.m.has(k)) return undefined; const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v; }
  set(k, v) { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
  get size() { return this.m.size; }
}

// ------------------------------------------------------------------ record checks
const bytesOf = b64 => (typeof b64 === 'string' ? fromBase64(b64) : null);
const KEY = {
  pv: /^pv:(-?\d+),(-?\d+)$/,
  ar: /^ar:(-?\d+),(-?\d+),(\d+),(\d+),(\d+)$/,
  ad: /^ad:(-?\d+),(-?\d+),(\d+)$/,
  ci: /^ci:(-?\d+),(-?\d+),(\d+)$/,
};

export class HeraldError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const check = (cond, code, msg) => { if (!cond) throw new HeraldError(code, msg); };

/**
 * A province envelope (§9.2) → decoded accounts, each checked against its
 * key and the season: `{bell, slot, seq, head, province, slots: [{key,
 * slot, account}], day, inputs}`. With `bell` (a per-bell file, not
 * `latest`), the envelope, every slot, the day and the inputs must be that
 * bell's (W3-F, the deferred envelope-bell check of integ-W2). Throws
 * HeraldError on any mismatch.
 */
export function parseEnvelope(env, { seasonId, p, q, bell } = {}) {
  check(env && env.v === 1, 'BadEnvelope', 'not a v1 envelope');
  const m = KEY.pv.exec(env.key ?? '');
  check(m, 'BadEnvelope', `key ${env.key}`);
  const [P, Q] = [+m[1], +m[2]];
  if (p !== undefined) check(P === p && Q === q, 'WrongKey', `asked for pv:${p},${q}, got ${env.key}`);
  const province = decode('Province', bytesOf(env.bytes) ?? new Uint8Array(0), { seasonId });
  check(province.p === P && province.q === Q, 'WrongKey', 'the Province bytes are another province');
  const slots = (env.slots ?? []).map(s => {
    const k = KEY.ar.exec(s.key ?? '');
    check(k, 'BadEnvelope', `slot key ${s.key}`);
    const a = decode('ArrivalSlot', bytesOf(s.bytes), { seasonId });
    check(a.p === +k[1] && a.q === +k[2] && a.bell === +k[3] && a.faction === +k[4] && a.i === +k[5], 'WrongKey', `slot bytes are not ${s.key}`);
    check(a.p === P && a.q === Q, 'WrongKey', 'a slot of another province');
    return { key: s.key, slot: s.slot, account: a };
  });
  let day = null;
  if (env.day) {
    const k = KEY.ad.exec(env.day.key ?? '');
    check(k, 'BadEnvelope', `day key ${env.day.key}`);
    day = decode('ArrivalDay', bytesOf(env.day.bytes), { seasonId });
    check(day.p === +k[1] && day.q === +k[2] && day.day === +k[3] && day.p === P && day.q === Q, 'WrongKey', 'day bytes');
  }
  let inputs = null;
  if (env.inputs) {
    const k = KEY.ci.exec(env.inputs.key ?? '');
    check(k, 'BadEnvelope', `inputs key ${env.inputs.key}`);
    inputs = decode('ClashInputs', bytesOf(env.inputs.bytes), { seasonId });
    check(inputs.p === +k[1] && inputs.q === +k[2] && inputs.bell === +k[3] && inputs.p === P && inputs.q === Q, 'WrongKey', 'inputs bytes');
  }
  if (Number.isInteger(bell)) {
    check(env.bell === bell, 'WrongKey', `asked for bell ${bell}, got ${env.bell}`);
    check(slots.every(s => s.account.bell === bell), 'WrongKey', 'a slot of another bell');
    check(!day || day.day === Math.floor(bell / 144), 'WrongKey', 'the day of another bell');
    check(!inputs || inputs.bell === bell, 'WrongKey', 'the inputs of another bell');
  }
  return { bell: env.bell, slot: env.slot, seq: String(env.seq ?? ''), head: env.head ?? null, province, slots, day, inputs };
}

// ------------------------------------------------------------------ the overview binary (§9.3)
export const OVERVIEW_MAGIC = 'PSFOV1\0\0';
export const OVERVIEW_HEADER = 32;
export const OVERVIEW_RECORD = 24;
/** Site states in the overview: free, holding, camp, reserved/released. */
export const SITE_STATE = Object.freeze(['free', 'holding', 'camp', 'reserved']);

/**
 * `/h/overview/{ring}/{bell}.bin` → `{season, ring, bell, slot, provinces:
 * [{p, q, owners[12] (0–5 faction, 6 neutral/camp, 7 none), sites[12]
 * (SITE_STATE index), hosts[7], clash, dormant, opened, resolvedNext}]}`.
 * Throws HeraldError on a bad magic, length, ring or order.
 */
export function decodeOverview(bytes, { seasonId, ring } = {}) {
  const b = Uint8Array.from(bytes);
  check(b.length >= OVERVIEW_HEADER, 'BadOverview', 'short header');
  check(String.fromCharCode(...b.subarray(0, 8)) === OVERVIEW_MAGIC, 'BadOverview', 'magic');
  const dv = new DataView(b.buffer);
  const out = { season: dv.getBigUint64(8, true), ring: dv.getUint16(16, true), n: dv.getUint16(18, true), bell: dv.getUint32(20, true), slot: dv.getBigUint64(24, true) };
  if (seasonId !== undefined) check(out.season === BigInt(String(seasonId)), 'WrongSeason', 'overview of another season');
  if (ring !== undefined) check(out.ring === ring, 'WrongKey', `asked ring ${ring}, got ${out.ring}`);
  check(b.length === OVERVIEW_HEADER + out.n * OVERVIEW_RECORD, 'BadOverview', 'length');
  out.provinces = [];
  for (let i = 0; i < out.n; i++) {
    const o = OVERVIEW_HEADER + i * OVERVIEW_RECORD;
    let owners = 0n;
    for (let j = 4; j >= 0; j--) owners = (owners << 8n) | BigInt(b[o + 4 + j]);
    const sites = b[o + 9] | (b[o + 10] << 8) | (b[o + 11] << 16);
    const flags = b[o + 19];
    const rec = {
      p: dv.getInt16(o, true),
      q: dv.getInt16(o + 2, true),
      owners: Array.from({ length: 12 }, (_, s) => Number((owners >> BigInt(3 * s)) & 7n)),
      sites: Array.from({ length: 12 }, (_, s) => (sites >> (2 * s)) & 3),
      hosts: Array.from(b.subarray(o + 12, o + 19)),
      clash: !!(flags & 1),
      dormant: !!(flags & 2),
      opened: !!(flags & 4),
      resolvedNext: dv.getUint32(o + 20, true),
    };
    const prev = out.provinces[i - 1];
    check(!prev || prev.p < rec.p || (prev.p === rec.p && prev.q < rec.q), 'BadOverview', 'records not sorted by (P, Q)');
    out.provinces.push(rec);
  }
  return out;
}

/** The majority owner of a province's sites (for the world LOD), or null. */
export function majorityOwner(rec) {
  const n = new Array(8).fill(0);
  rec.sites.forEach((s, i) => { if (s === 1) n[rec.owners[i]]++; });
  let best = null;
  for (let f = 0; f < 6; f++) if (n[f] > 0 && (best === null || n[f] > n[best])) best = f;
  return best;
}

// ------------------------------------------------------------------ WS diffs
/**
 * The WS diff stream (§8.4): messages `{seq, kind, key, slot, head,
 * bytes_b64}` in sequence. `accept(msg)` → 'applied' | 'duplicate' |
 * 'gap' (a missed seq: the client resyncs from the files, then the next
 * message starts a new run).
 */
export class DiffStream {
  constructor({ onResync = () => {} } = {}) { this.last = null; this.onResync = onResync; }
  accept(msg) {
    let seq;
    try { seq = BigInt(String(msg?.seq)); } catch { return 'invalid'; }
    if (this.last === null || seq === this.last + 1n) { this.last = seq; return 'applied'; }
    if (seq <= this.last) return 'duplicate';
    this.last = null;
    this.onResync();
    return 'gap';
  }
}

// ------------------------------------------------------------------ polling (§4.2)
export const OWN_POLL_ACTIVE = 10;
export const OWN_POLL_IDLE = 30;
export const BELL_JITTER = 15;
export const BACKOFF_MAX = 300;
export const STALE_AFTER = 60;
export const PROVINCE_LIMIT_TILE = 12;

/**
 * Seconds until the next poll of one kind, or null while paused:
 *   own:      10 s while a march or a transaction is in flight, else 30 s
 *   overview: at the next bell's end + a random 0–15 s
 * doubled per consecutive error, up to 5 min; a hidden page pauses all.
 */
export function nextPoll({ kind, hidden = false, inFlight = false, errors = 0, secondsToBellEnd = 600, random = Math.random }) {
  if (hidden) return null;
  const base = kind === 'own' ? (inFlight ? OWN_POLL_ACTIVE : OWN_POLL_IDLE) : Math.max(0, secondsToBellEnd) + random() * BELL_JITTER;
  return errors > 0 ? Math.min(BACKOFF_MAX, base * 2 ** errors) : base;
}

/**
 * The province records to hold: the viewer's own (holdings, marches) always,
 * plus the visible ones at tile LOD, at most 12 visible at once.
 */
export function wantedProvinces({ visible = [], own = [], lod = 'world', limit = PROVINCE_LIMIT_TILE }) {
  const out = new Map();
  for (const p of own) out.set(`${p.p},${p.q}`, p);
  if (lod === 'tile') for (const p of visible.slice(0, limit)) out.set(`${p.p},${p.q}`, p);
  return [...out.values()];
}

/** How far the herald's view is behind the chain clock; `stale` past 60 s (actions that need fresh state ask to reload). */
export function staleness({ latestUnix, chainNow, behind: measured }) {
  // `behind` (ChainClock.behind(), measured against the local clock) wins:
  // an estimate built from the herald itself cannot see the herald stall.
  if (measured !== undefined && measured !== null) return { behind: measured, stale: measured > STALE_AFTER };
  if (latestUnix === null || latestUnix === undefined || chainNow === null || chainNow === undefined) return { behind: null, stale: false };
  const behind = Math.max(0, chainNow - Number(latestUnix));
  return { behind, stale: behind > STALE_AFTER };
}

// ------------------------------------------------------------------ `me` key checks
/**
 * The viewer's own record must be the viewer's (W3-F, the deferred `me`
 * check of integ-W2): the Citizen at the canonical address of `wallet` and
 * naming it; each Holding at its canonical address, owned by that Citizen
 * and one of the Citizen's holdings; at most three. Throws HeraldError.
 */
export function checkMe(addresses, wallet, record, citizen, holdings) {
  const want = addresses.of('Citizen', { wallet });
  if (citizen) {
    check(toB58(citizen.wallet) === wallet, 'WrongKey', 'the Citizen names another wallet');
    if (record.citizen?.address !== undefined) check(record.citizen.address === want, 'WrongKey', 'the Citizen is not at its canonical address');
  }
  check(holdings.length <= 3, 'BadRecord', 'more than three holdings');
  check(!holdings.length || citizen, 'BadRecord', 'holdings without a Citizen');
  holdings.forEach((h, i) => {
    check(toB58(h.ownerCitizen) === want, 'WrongKey', 'a Holding of another Citizen');
    const at = addresses.of('Holding', { p: h.p, q: h.q, site: h.site });
    if (record.holdings?.[i]?.address !== undefined) check(record.holdings[i].address === at, 'WrongKey', 'a Holding not at its canonical address');
    check(citizen.holding.some(r => r.p === h.p && r.q === h.q && r.site === h.site), 'WrongKey', 'a Holding the Citizen does not name');
  });
}

// ------------------------------------------------------------------ the client
/**
 * A herald client for one season. Every call answers `{ok, …}` and never
 * rejects. `seasonId` pins what every decoded account must carry.
 */
export function createHerald({ base = '', fetch: f = (...a) => globalThis.fetch(...a), seasonId = null, cacheSize = 256 } = {}) {
  const root = String(base).replace(/\/+$/, '');
  const cache = new Lru(cacheSize);
  let pinned = seasonId === null ? null : String(seasonId);
  let addrs = null;
  const guard = fn => { try { return { ok: true, ...fn() }; } catch (e) { return fail(e.code ?? 'BadRecord', e.message); } };

  async function cached(key, immutable, load) {
    if (immutable) { const hit = cache.get(key); if (hit) return hit; }
    const r = await load();
    if (r.ok && immutable) cache.set(key, r);
    return r;
  }

  return {
    cache,
    /** Pin the season (and, for the `me` key checks, its recomputed addresses: faddr.seasonAddresses). */
    pin(id, addresses = null) { pinned = String(id); addrs = addresses; },
    /** GET /h/season: the record, with the Season account decoded and checked. */
    async season() {
      const r = await get(f, `${root}/h/season`);
      if (!r.ok) return r;
      return guard(() => {
        const j = r.json;
        check(j && j.v === 1, 'BadRecord', 'not a v1 season record');
        const season = decode('Season', bytesOf(j.bytes_b64) ?? new Uint8Array(0), { seasonId: pinned ?? j.season });
        check(String(season.seasonId) === String(j.season), 'WrongSeason', 'the record and its bytes name different seasons');
        return { record: j, season };
      });
    },
    /** GET /h/province/{P},{Q}/{bell|latest}. */
    province(p, q, bell = 'latest') {
      const immutable = bell !== 'latest';
      return cached(`pv:${p},${q}@${bell}`, immutable, async () => {
        const r = await get(f, `${root}/h/province/${p},${q}/${bell}`);
        return r.ok ? guard(() => parseEnvelope(r.json, { seasonId: pinned ?? undefined, p, q, bell: immutable ? Number(bell) : undefined })) : r;
      });
    },
    /** GET /h/overview/{ring}/{bell|latest}.bin. */
    overview(ring, bell = 'latest') {
      const immutable = bell !== 'latest';
      return cached(`ov:${ring}@${bell}`, immutable, async () => {
        const r = await get(f, `${root}/h/overview/${ring}/${bell}.bin`, { binary: true });
        return r.ok ? guard(() => decodeOverview(r.bytes, { seasonId: pinned ?? undefined, ring })) : r;
      });
    },
    /** GET /h/bell/{bell}/region/{r}: anchor, S, caches, archive state (JSON; the anchor bytes decoded when present). */
    async bellRegion(bell, region) {
      const r = await get(f, `${root}/h/bell/${bell}/region/${region}`);
      if (!r.ok) return r;
      return guard(() => {
        const j = r.json;
        const anchor = j.anchor?.bytes_b64 ? decode('BellAnchor', bytesOf(j.anchor.bytes_b64), { seasonId: pinned ?? undefined }) : null;
        if (anchor) check(anchor.bell === bell && anchor.region === region, 'WrongKey', 'the anchor bytes are another bell or region');
        return { record: j, anchor };
      });
    },
    /** GET /h/me/{wallet}: the Citizen and its Holdings, decoded and checked. */
    async me(wallet) {
      const r = await get(f, `${root}/h/me/${wallet}`);
      if (!r.ok) return r;
      return guard(() => {
        // A holding the Citizen names that the fold has not captured (or
        // closed) is listed as null: skipped, never a failed view (wave-3
        // review, W3-E/W3-F); the checks see the same, aligned list.
        const j = { ...r.json, holdings: (r.json?.holdings ?? []).filter(h => h !== null && h !== undefined) };
        const opts = { seasonId: pinned ?? undefined };
        const citizen = j.citizen?.bytes_b64 ? decode('Citizen', bytesOf(j.citizen.bytes_b64), opts) : null;
        const holdings = j.holdings.map(h => decode('Holding', bytesOf(h.bytes_b64), opts));
        if (addrs) checkMe(addrs, wallet, j, citizen, holdings);
        return { record: j, citizen, holdings };
      });
    },
    /** GET /h/events?after={seq}: a page of PS2 records. */
    async events(after = 0) {
      const r = await get(f, `${root}/h/events?after=${encodeURIComponent(String(after))}`);
      return r.ok ? { ok: true, events: Array.isArray(r.json?.events) ? r.json.events : [], next: r.json?.next ?? null, full: r.json?.full === true } : r;
    },
    /** GET /h/clash/{P},{Q}/{bell}: the clash report (immutable). */
    clash(p, q, bell) {
      return cached(`cl:${p},${q}@${bell}`, true, async () => {
        const r = await get(f, `${root}/h/clash/${p},${q}/${bell}`);
        return r.ok ? guard(() => ({ report: r.json, inputs: r.json?.inputs_b64 ? decode('ClashInputs', bytesOf(r.json.inputs_b64), { seasonId: pinned ?? undefined }) : null })) : r;
      });
    },
  };
}

// ================================================================== MC formats
// The conquest milestone's herald formats (CONQUEST-CONTRACT v1.1 §8.4,
// unit CQ1-D; additive: nothing above changed). Each decoder mirrors the
// Rust codec `frontier-node/crates/herald/src/cqfmt.rs` check for check, in
// the same order, and refuses a bad file with the same `HeraldError.code`
// (BadMagic, BadLength, BadReserved, BadShape, BadValue, BadOrder,
// NotCumulative, TooMany, BadJson, BadSchema). No page module calls these
// decoders yet: CQ3-D wires them (fetchers, fcqstate) and adds the JA/EN
// texts for these codes to fi18n.mjs (CQ1-D-NOTES, request D-3). The shared vectors are
// `frontier-node/fixtures/cq/formats/` (web-frontier-cq-formats.test.mjs).
// The format clarifications CF-1…CF-8 are listed in cqfmt.rs.

// ------------------------------------------------------------------ PSFCT1, the faction map
export const CONTROL_MAGIC = 'PSFCT1\0\0';
export const CONTROL_HEADER = 32;
export const CONTROL_PROVINCE = 8;
export const CONTROL_MARCH = 4;
/** CF-1: a control file covers whole rings 0..=R, R ≤ 127. */
export const CONTROL_MAX_RING = 127;
/** Province `control` 6 = the Concord (neutral); 7 = unopened, and "none" elsewhere. */
export const CONTROL_NEUTRAL = 6;
export const CONTROL_NONE = 7;
export const CONTROL_DELTA_MAX = 64;
/** Province flag bits (§8.4). */
export const PROVINCE_FLAGS = Object.freeze({ changed: 1, consolidating: 2, heartland: 4, seat: 8, taken: 16, broken: 32, clash: 64 });
/** March flag bits (§8.4); truce and hostility are M3's (always 0 in MC). */
export const MARCH_FLAGS = Object.freeze({ bannerChanged: 1, dominionChanged: 2, callTarget: 4, truce: 8, hostility: 16 });

const latin = b => String.fromCharCode(...b);
const dvOf = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** R with provincesWithin(R) === nProv (whole rings, R ≤ 127), else null. */
export function ringsOf(nProv) {
  for (let d = 0; d <= CONTROL_MAX_RING; d++) {
    const n = provincesWithin(d);
    if (n === nProv) return d;
    if (n > nProv) return null;
  }
  return null;
}

const MARCH_ORDER = new Map();
/**
 * CF-2: the Marches of a control file over rings 0..=`rings`, in file order:
 * every March with a member in those rings, by the dense index of its
 * centre province (geometry::march_members(m)[0]). → frozen [{m, n}].
 */
export function marchOrder(rings) {
  const R = Math.min(rings, CONTROL_MAX_RING);
  const hit = MARCH_ORDER.get(R);
  if (hit) return hit;
  const seen = new Map();
  for (let i = 0; i < provincesWithin(R); i++) {
    const { p, q } = provinceFromIndex(i);
    const c = cellOf(p, q, 1);
    const k = `${c.p},${c.q}`;
    if (!seen.has(k)) {
      const ctr = provinceCentre(c.p, c.q, 1);
      seen.set(k, { m: c.p, n: c.q, centre: provinceIndex(ctr.q, ctr.r) });
    }
  }
  const out = Object.freeze([...seen.values()].sort((a, b) => a.centre - b.centre).map(({ m, n }) => Object.freeze({ m, n })));
  MARCH_ORDER.set(R, out);
  return out;
}

/** One 8-byte province record at dense index `index`, checked (cqfmt ControlProvince::check). */
function controlProvince(b, o, index) {
  const r = {
    index,
    control: b[o], contender: b[o + 1], progress: b[o + 2], required: b[o + 3], flags: b[o + 4],
    sieges: b[o + 5] & 15, occupations: b[o + 5] >> 4, pointsLead: b[o + 6], pointsShare: b[o + 7],
  };
  const at = `province ${index}`;
  check((r.flags & 128) === 0, 'BadReserved', `${at}: flags bit 128`);
  check(r.control <= CONTROL_NONE, 'BadValue', `${at}: control ${r.control}`);
  check((r.control === CONTROL_NEUTRAL) === (index === 0), 'BadValue', `${at}: control 6 is the Concord's alone`);
  const pc = provinceFromIndex(index);
  check(pc !== null, 'BadValue', `${at}: index beyond ring 128`);
  const ring = ringOf(pc.p, pc.q);
  check(((r.flags & 8) !== 0) === (ring <= 1), 'BadValue', `${at}: the seat flag marks rings 0–1 exactly`);
  check((r.flags & 4) === 0 || ring >= 2, 'BadValue', `${at}: heartland in rings 0–1`);
  check(r.contender <= 5 || r.contender === CONTROL_NONE, 'BadValue', `${at}: contender ${r.contender}`);
  check(r.progress <= r.required, 'BadValue', `${at}: progress ${r.progress} > required ${r.required}`);
  if (r.contender === CONTROL_NONE) check(r.progress === 0, 'BadValue', `${at}: progress without a contender`);
  else {
    check(r.contender !== r.control, 'BadValue', `${at}: the holder contends its own keep`);
    check(r.progress >= 1, 'BadValue', `${at}: a contender with progress 0`);
  }
  check(r.pointsLead <= CONTROL_NONE, 'BadValue', `${at}: pointsLead ${r.pointsLead}`);
  r.p = pc.p;
  r.q = pc.q;
  for (const [k, bit] of Object.entries(PROVINCE_FLAGS)) r[k] = (r.flags & bit) !== 0;
  return r;
}

function controlMarch(b, o, i, at) {
  const r = { m: at.m, n: at.n, banner: b[o], pointsLead: b[o + 1], keeps: b[o + 2], flags: b[o + 3] };
  check((r.flags & 0xe0) === 0, 'BadReserved', `march ${i}: flags bits 32-128`);
  check(r.banner <= 5 || r.banner === CONTROL_NONE, 'BadValue', `march ${i}: banner ${r.banner}`);
  check(r.pointsLead <= CONTROL_NONE, 'BadValue', `march ${i}: pointsLead ${r.pointsLead}`);
  check(r.keeps <= 7, 'BadValue', `march ${i}: keeps ${r.keeps}`);
  for (const [k, bit] of Object.entries(MARCH_FLAGS)) r[k] = (r.flags & bit) !== 0;
  return r;
}

/**
 * `/h/control/{bell}.bin` (PSFCT1) → `{season (BigInt), bell, rings,
 * provinces: [{index, p, q, control, contender, progress, required, flags,
 * sieges, occupations, pointsLead, pointsShare, changed, consolidating,
 * heartland, seat, taken, broken, clash}], marches: [{m, n, banner,
 * pointsLead, keeps, flags, bannerChanged, dominionChanged, callTarget,
 * truce, hostility}]}`. The map colours a province by `control` and a
 * March by `banner` only; `pointsLead` is a standings figure (R-15).
 * Throws HeraldError.
 */
export function decodeControl(bytes, { seasonId, bell } = {}) {
  const b = Uint8Array.from(bytes);
  check(b.length >= CONTROL_HEADER, 'BadLength', 'short header');
  check(latin(b.subarray(0, 8)) === CONTROL_MAGIC, 'BadMagic', 'magic');
  check(b.subarray(24, 32).every(x => x === 0), 'BadReserved', 'header reserved');
  const dv = dvOf(b);
  const nProv = dv.getUint16(20, true), nMarch = dv.getUint16(22, true);
  const rings = ringsOf(nProv);
  check(rings !== null, 'BadShape', `n_prov ${nProv} is not whole rings 0..=R (R ≤ 127)`);
  const order = marchOrder(rings);
  check(nMarch === order.length, 'BadShape', `n_march ${nMarch}, rings 0..=${rings} have ${order.length} Marches`);
  check(b.length === CONTROL_HEADER + nProv * CONTROL_PROVINCE + nMarch * CONTROL_MARCH, 'BadLength', 'length');
  const provinces = [];
  for (let i = 0; i < nProv; i++) provinces.push(controlProvince(b, CONTROL_HEADER + i * CONTROL_PROVINCE, i));
  const base = CONTROL_HEADER + nProv * CONTROL_PROVINCE;
  const marches = [];
  for (let i = 0; i < nMarch; i++) marches.push(controlMarch(b, base + i * CONTROL_MARCH, i, order[i]));
  const out = { season: dv.getBigUint64(8, true), bell: dv.getUint32(16, true), rings, provinces, marches };
  if (seasonId !== undefined && seasonId !== null) check(out.season === BigInt(String(seasonId)), 'WrongSeason', 'control file of another season');
  if (Number.isInteger(bell)) check(out.bell === bell, 'WrongKey', `asked for bell ${bell}, got ${out.bell}`);
  return out;
}

/**
 * The WS `control` delta (CF-6): `[index u16, record 8 B]…`, 1–64 entries,
 * strictly increasing index → `[{index, ...record}]` (records as
 * decodeControl's). More than 64 changes are never a delta (resync hint).
 */
export function decodeControlDelta(bytes) {
  const b = Uint8Array.from(bytes);
  check(b.length > 0 && b.length % 10 === 0, 'BadLength', `${b.length} B is not n × 10`);
  const n = b.length / 10;
  check(n <= CONTROL_DELTA_MAX, 'TooMany', `${n} entries > 64`);
  const out = [];
  for (let k = 0; k < n; k++) out.push(controlProvince(b, k * 10 + 2, b[k * 10] | (b[k * 10 + 1] << 8)));
  for (let k = 1; k < n; k++) check(out[k - 1].index < out[k].index, 'BadOrder', `index ${out[k].index} after ${out[k - 1].index}`);
  return out;
}

/** A decoded control file with a decoded delta applied (a new object; `bell` is the delta's bell when given). */
export function applyControlDelta(control, delta, bell = control.bell) {
  const provinces = control.provinces.slice();
  for (const r of delta) {
    check(r.index < provinces.length, 'BadShape', `delta index ${r.index} beyond ${provinces.length} provinces`);
    provinces[r.index] = r;
  }
  return { ...control, bell, provinces };
}

// ------------------------------------------------------------------ PSFOV2, the overview v2
export const OVERVIEW2_MAGIC = 'PSFOV2\0\0';
export const OVERVIEW2_RECORD = 40;
/** Per-site siege state in PSFOV2. */
export const SIEGE_STATE = Object.freeze(['none', 'progressing', 'pausedVigil', 'captureDue']);
/** Per-site kind in PSFOV2. */
export const SITE_KIND = Object.freeze(['first', 'holding', 'freeCity', 'reservedOrFree']);
export const KEEP_TILE_NONE = 0xff;

/**
 * `/h/overview2/{ring}/{bell}.bin` (PSFOV2) → `{season, ring, bell, slot,
 * provinces: [{...the v1 fields of decodeOverview, occupiers[12] (0–5, 7
 * none), siegeStates[12] (SIEGE_STATE index), siteKinds[12] (SITE_KIND
 * index), keepTile (null: no keep), keepTroops (u16, saturating),
 * immune[12]}]}`. Owners stay titles (D9). Throws HeraldError.
 */
export function decodeOverviewV2(bytes, { seasonId, ring } = {}) {
  const b = Uint8Array.from(bytes);
  check(b.length >= OVERVIEW_HEADER, 'BadLength', 'short header');
  check(latin(b.subarray(0, 8)) === OVERVIEW2_MAGIC, 'BadMagic', 'magic');
  const dv = dvOf(b);
  const out = { season: dv.getBigUint64(8, true), ring: dv.getUint16(16, true), n: dv.getUint16(18, true), bell: dv.getUint32(20, true), slot: dv.getBigUint64(24, true) };
  check(b.length === OVERVIEW_HEADER + out.n * OVERVIEW2_RECORD, 'BadLength', 'length');
  out.provinces = [];
  for (let i = 0; i < out.n; i++) {
    const o = OVERVIEW_HEADER + i * OVERVIEW2_RECORD;
    let owners = 0n, occ = 0n;
    for (let j = 4; j >= 0; j--) owners = (owners << 8n) | BigInt(b[o + 4 + j]);
    for (let j = 4; j >= 0; j--) occ = (occ << 8n) | BigInt(b[o + 24 + j]);
    check((occ >> 36n) === 0n && (b[o + 39] >> 4) === 0, 'BadReserved', `record ${i}: reserved bits`);
    const sites = b[o + 9] | (b[o + 10] << 8) | (b[o + 11] << 16);
    const sg = b[o + 29] | (b[o + 30] << 8) | (b[o + 31] << 16);
    const kd = b[o + 32] | (b[o + 33] << 8) | (b[o + 34] << 16);
    const flags = b[o + 19];
    const immune = b[o + 38] | ((b[o + 39] & 15) << 8);
    const rec = {
      p: dv.getInt16(o, true),
      q: dv.getInt16(o + 2, true),
      owners: Array.from({ length: 12 }, (_, s) => Number((owners >> BigInt(3 * s)) & 7n)),
      sites: Array.from({ length: 12 }, (_, s) => (sites >> (2 * s)) & 3),
      hosts: Array.from(b.subarray(o + 12, o + 19)),
      clash: !!(flags & 1),
      dormant: !!(flags & 2),
      opened: !!(flags & 4),
      resolvedNext: dv.getUint32(o + 20, true),
      v1: b.slice(o, o + OVERVIEW_RECORD),
      occupiers: Array.from({ length: 12 }, (_, s) => Number((occ >> BigInt(3 * s)) & 7n)),
      siegeStates: Array.from({ length: 12 }, (_, s) => (sg >> (2 * s)) & 3),
      siteKinds: Array.from({ length: 12 }, (_, s) => (kd >> (2 * s)) & 3),
      keepTile: b[o + 35] === KEEP_TILE_NONE ? null : b[o + 35],
      keepTroops: dv.getUint16(o + 36, true),
      immune: Array.from({ length: 12 }, (_, s) => ((immune >> s) & 1) === 1),
    };
    rec.occupiers.forEach((f, s) => check(f <= 5 || f === 7, 'BadValue', `record ${i}: site ${s} occupier ${f}`));
    check(rec.keepTile === null || rec.keepTile < 61, 'BadValue', `record ${i}: keep tile ${rec.keepTile}`);
    check(rec.keepTile !== null || rec.keepTroops === 0, 'BadValue', `record ${i}: keep troops without a keep`);
    out.provinces.push(rec);
  }
  for (let i = 1; i < out.provinces.length; i++) {
    const [a, c] = [out.provinces[i - 1], out.provinces[i]];
    check(a.p < c.p || (a.p === c.p && a.q < c.q), 'BadOrder', `record ${i} not after record ${i - 1} in (P, Q)`);
  }
  if (seasonId !== undefined && seasonId !== null) check(out.season === BigInt(String(seasonId)), 'WrongSeason', 'overview of another season');
  if (ring !== undefined) check(out.ring === ring, 'WrongKey', `asked ring ${ring}, got ${out.ring}`);
  return out;
}

// ------------------------------------------------------------------ PSFSD1, the standings series
export const STANDINGS_MAGIC = 'PSFSD1\0\0';
export const STANDINGS_HEADER = 32;
export const STANDINGS_FACTION = 32;
/** One faction-hour's fields in record order (CF-5; offsets 0…24, tail 26..32 reserved). */
export const STANDINGS_FIELDS = Object.freeze([
  ['provinces', 0, 2], ['banners', 2, 2], ['keepsTaken', 4, 2], ['keepsLost', 6, 2], ['dominionBells', 8, 4],
  ['captures', 12, 2], ['occupationsActive', 14, 2], ['siegesWon', 16, 2], ['siegesLost', 18, 2],
  ['liberations', 20, 2], ['holdings', 22, 2], ['membersActive', 24, 2],
]);
const CUMULATIVE = ['keepsTaken', 'keepsLost', 'dominionBells', 'captures', 'siegesWon', 'siegesLost', 'liberations'];

/**
 * `/h/standings/series.bin` (PSFSD1) → `{season, firstHour, hours: [{hour,
 * factions: [6 × {provinces, banners, keepsTaken, keepsLost, dominionBells,
 * captures, occupationsActive, siegesWon, siegesLost, liberations,
 * holdings, membersActive}]}]}`. Unofficial game points. Throws HeraldError.
 */
export function decodeStandings(bytes, { seasonId } = {}) {
  const b = Uint8Array.from(bytes);
  check(b.length >= STANDINGS_HEADER, 'BadLength', 'short header');
  check(latin(b.subarray(0, 8)) === STANDINGS_MAGIC, 'BadMagic', 'magic');
  check(b.subarray(24, 32).every(x => x === 0), 'BadReserved', 'header reserved');
  const dv = dvOf(b);
  const n = dv.getUint32(20, true);
  check(b.length === STANDINGS_HEADER + n * 6 * STANDINGS_FACTION, 'BadLength', `${b.length} B for ${n} hours`);
  const out = { season: dv.getBigUint64(8, true), firstHour: dv.getUint32(16, true), hours: [] };
  for (let h = 0; h < n; h++) {
    const factions = [];
    for (let f = 0; f < 6; f++) {
      const o = STANDINGS_HEADER + (h * 6 + f) * STANDINGS_FACTION;
      check(b.subarray(o + 26, o + 32).every(x => x === 0), 'BadReserved', 'record reserved tail');
      const r = {};
      for (const [k, off, w] of STANDINGS_FIELDS) r[k] = w === 2 ? dv.getUint16(o + off, true) : dv.getUint32(o + off, true);
      factions.push(r);
    }
    out.hours.push({ hour: out.firstHour + h, factions });
  }
  for (let h = 1; h < n; h++) {
    for (let f = 0; f < 6; f++) {
      const [a, c] = [out.hours[h - 1].factions[f], out.hours[h].factions[f]];
      check(CUMULATIVE.every(k => c[k] >= a[k]), 'NotCumulative', `hour index ${h}: faction ${f} went down`);
    }
  }
  if (seasonId !== undefined && seasonId !== null) check(out.season === BigInt(String(seasonId)), 'WrongSeason', 'standings of another season');
  return out;
}

// ------------------------------------------------------------------ JSON files (§8.4, CF-7, CF-8)
const COORD = 128;
const U32 = 0xffffffff;
const TAG_RE = /^[0-9a-f]{16}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{1,90}$/;

function jsonOf(input) {
  if (input !== null && typeof input === 'object' && !(input instanceof Uint8Array) && !ArrayBuffer.isView(input)) return input;
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  try {
    return JSON.parse(text);
  } catch (e) {
    return check(false, 'BadJson', e.message);
  }
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function objOf(v, at) { check(isObj(v), 'BadSchema', `${at}: not an object`); return v; }
function fieldOf(o, k, at) { check(Object.hasOwn(o, k), 'BadSchema', `${at}: missing ${k}`); return o[k]; }
function intOf(o, k, lo, hi, at) {
  const v = fieldOf(o, k, at);
  check(Number.isInteger(v), 'BadSchema', `${at}: ${k} is not an integer`);
  check(v >= lo && v <= hi, 'BadValue', `${at}: ${k} ${v} outside ${lo}..=${hi}`);
  return v;
}
const optIntOf = (o, k, lo, hi, at) => (fieldOf(o, k, at) === null ? null : intOf(o, k, lo, hi, at));
function strOf(o, k, at) { const v = fieldOf(o, k, at); check(typeof v === 'string', 'BadSchema', `${at}: ${k} is not a string`); return v; }
function tagOf(o, k, at) { const s = strOf(o, k, at); check(TAG_RE.test(s), 'BadValue', `${at}: ${k} is not 16 lowercase hex characters`); return s; }
function arrOf(o, k, at) { const v = fieldOf(o, k, at); check(Array.isArray(v), 'BadSchema', `${at}: ${k} is not an array`); return v; }
function versionOf(o) {
  const v = fieldOf(o, 'v', 'file');
  check(Number.isInteger(v), 'BadSchema', 'v is not an integer');
  check(v === 1, 'BadValue', `v ${v}`);
}

function siegeOf(v, bell, at) {
  const o = objOf(v, at);
  const key = strOf(o, 'key', at);
  const kindS = strOf(o, 'kind', at);
  const status = strOf(o, 'status', at);
  const reason = fieldOf(o, 'pauseReason', at);
  const owner = fieldOf(o, 'owner', at) === null ? null : tagOf(o, 'owner', at);
  let pauseReason;
  const known = status === 'progressing' || status === 'paused';
  if (status === 'progressing' && reason === null) pauseReason = null;
  else if (status === 'paused' && (reason === 'vigil' || reason === 'defender')) pauseReason = reason;
  else {
    check(!known || reason === null || typeof reason === 'string', 'BadSchema', `${at}: pauseReason is not a string or null`);
    check(false, 'BadValue', known ? `${at}: status ${status} with pauseReason ${reason}` : `${at}: status ${status}`);
  }
  const s = { key };
  s.p = intOf(o, 'p', -COORD, COORD, at);
  s.q = intOf(o, 'q', -COORD, COORD, at);
  s.site = intOf(o, 'site', 0, 255, at);
  check(['first', 'other', 'free'].includes(kindS), 'BadValue', `${at}: kind ${kindS}`);
  s.kind = kindS;
  s.owner = owner;
  s.ownerFaction = intOf(o, 'ownerFaction', 0, 255, at);
  s.attacker = tagOf(o, 'attacker', at);
  s.attackerFaction = intOf(o, 'attackerFaction', 0, 255, at);
  s.declared = intOf(o, 'declared', 0, U32, at);
  s.required = intOf(o, 'required', 0, 255, at);
  s.progress = intOf(o, 'progress', 0, 255, at);
  s.status = status;
  s.pauseReason = pauseReason;
  s.etaBell = intOf(o, 'etaBell', 0, U32, at);
  const want = `sg:${s.p},${s.q},${s.site},${s.declared}`;
  check(key === want, 'BadValue', `${at}: key ${key} is not ${want}`);
  const free = s.kind === 'free';
  check(s.site < 12, 'BadValue', `${at}: site`);
  check(free === (s.owner === null), 'BadValue', `${at}: owner is null exactly for a Free City`);
  check(free === (s.ownerFaction === CONTROL_NEUTRAL), 'BadValue', `${at}: ownerFaction 6 exactly for a Free City`);
  check(s.ownerFaction <= 6 && s.attackerFaction <= 5, 'BadValue', `${at}: faction`);
  check(s.attackerFaction !== s.ownerFaction, 'BadValue', `${at}: a faction besieging its own holding`);
  check(s.required >= 1 && s.required <= 60, 'BadValue', `${at}: required ${s.required}`);
  check(s.progress < s.required, 'BadValue', `${at}: progress ${s.progress} of ${s.required}`);
  check(s.declared <= bell, 'BadValue', `${at}: declared after the file's bell`);
  check(s.etaBell > s.declared, 'BadValue', `${at}: etaBell not after declared`);
  return s;
}

function keepOf(v, bell, at) {
  const o = objOf(v, at);
  const k = {
    p: intOf(o, 'p', -COORD, COORD, at),
    q: intOf(o, 'q', -COORD, COORD, at),
    holder: intOf(o, 'holder', 0, 255, at),
    contender: intOf(o, 'contender', 0, 255, at),
    progress: intOf(o, 'progress', 0, 255, at),
    required: intOf(o, 'required', 0, 255, at),
    since: intOf(o, 'since', 0, U32, at),
    etaBell: intOf(o, 'etaBell', 0, U32, at),
  };
  check(k.holder <= 5 && k.contender <= 5, 'BadValue', `${at}: faction`);
  check(k.holder !== k.contender, 'BadValue', `${at}: the holder contends its own keep`);
  check(k.required >= 1 && k.progress >= 1 && k.progress < k.required, 'BadValue', `${at}: progress ${k.progress} of ${k.required}`);
  check(k.since <= bell, 'BadValue', `${at}: since after the file's bell`);
  check(k.etaBell >= k.since, 'BadValue', `${at}: etaBell before since`);
  return k;
}

const lexLess = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; };

/**
 * `/h/sieges/latest.json` or `/h/sieges/{bell}.json` (text, bytes or an
 * already-parsed object) → `{v: 1, bell, sieges: [{key, p, q, site, kind,
 * owner (tag hex | null), ownerFaction, attacker, attackerFaction, declared,
 * required, progress, status, pauseReason, etaBell}], keeps: [{p, q,
 * holder, contender, progress, required, since, etaBell}]}`, checked.
 */
export function parseSieges(input) {
  const o = objOf(jsonOf(input), 'file');
  versionOf(o);
  const bell = intOf(o, 'bell', 0, U32, 'file');
  const sieges = arrOf(o, 'sieges', 'file').map((s, i) => siegeOf(s, bell, `sieges[${i}]`));
  const keeps = arrOf(o, 'keeps', 'file').map((k, i) => keepOf(k, bell, `keeps[${i}]`));
  for (let i = 1; i < sieges.length; i++) {
    const [a, c] = [sieges[i - 1], sieges[i]];
    check(lexLess([a.p, a.q, a.site], [c.p, c.q, c.site]), 'BadOrder', `sieges[${i}] not after sieges[${i - 1}] in (p, q, site)`);
  }
  for (let i = 1; i < keeps.length; i++) {
    const [a, c] = [keeps[i - 1], keeps[i]];
    check(lexLess([a.p, a.q], [c.p, c.q]), 'BadOrder', `keeps[${i}] not after keeps[${i - 1}] in (p, q)`);
  }
  return { v: 1, bell, sieges, keeps };
}

/** The conquest event kinds of §8.4, and which location fields each carries (CF-8). */
export const CONQUEST_EVENT_SHAPE = Object.freeze({
  siege_declared: 'site', siege_failed: 'site', occupied: 'site', liberated: 'site', occupation_expired: 'site',
  capture_due: 'site', captured: 'site', keep_contest: 'province', keep_broken: 'province', keep_taken: 'province',
  province_control: 'province', march_banner: 'march', march_points_lead: 'march', free_city: 'site', outpost: 'site',
  retired: 'provinceMaybeSite',
});
export const BELLS_PER_DAY = 144;

function eventOf(v, day, at) {
  const o = objOf(v, at);
  const seq = strOf(o, 'seq', at);
  check(/^(0|[1-9][0-9]*)$/.test(seq) && BigInt(seq) <= 0xffffffffffffffffn, 'BadValue', `${at}: seq ${seq} is not a decimal u64`);
  const kind = strOf(o, 'kind', at);
  let march = fieldOf(o, 'march', at);
  if (march !== null) {
    const mo = objOf(march, `${at}.march`);
    march = { m: intOf(mo, 'm', -COORD, COORD, at), n: intOf(mo, 'n', -COORD, COORD, at) };
  }
  const citizens = arrOf(o, 'citizens', at).map(c => {
    check(typeof c === 'string', 'BadSchema', `${at}: a citizen is not a string`);
    check(TAG_RE.test(c), 'BadValue', `${at}: citizen ${c}`);
    return c;
  });
  const e = { seq, bell: intOf(o, 'bell', 0, U32, at), sig: strOf(o, 'sig', at) };
  check(Object.hasOwn(CONQUEST_EVENT_SHAPE, kind), 'BadValue', `${at}: kind ${kind}`);
  e.kind = kind;
  e.p = optIntOf(o, 'p', -COORD, COORD, at);
  e.q = optIntOf(o, 'q', -COORD, COORD, at);
  e.site = optIntOf(o, 'site', 0, 255, at);
  e.march = march;
  e.from = optIntOf(o, 'from', 0, 255, at);
  e.to = optIntOf(o, 'to', 0, 255, at);
  e.citizens = citizens;
  e.detail = fieldOf(o, 'detail', at);
  const lo = day * BELLS_PER_DAY;
  check(e.bell >= lo && e.bell - lo < BELLS_PER_DAY, 'BadValue', `${at}: bell ${e.bell} is not in day ${day}`);
  check(B58_RE.test(e.sig), 'BadValue', `${at}: sig is not base58`);
  const pq = e.p !== null && e.q !== null, none = e.p === null && e.q === null;
  const ok = {
    site: pq && e.site !== null && e.march === null,
    province: pq && e.site === null && e.march === null,
    provinceMaybeSite: pq && e.march === null,
    march: none && e.site === null && e.march !== null,
  }[CONQUEST_EVENT_SHAPE[kind]];
  check(ok, 'BadValue', `${at}: p/q/site/march do not fit kind ${kind}`);
  check(e.site === null || e.site < 12, 'BadValue', `${at}: site`);
  check((e.from === null || e.from <= 7) && (e.to === null || e.to <= 7), 'BadValue', `${at}: from/to`);
  check(isObj(e.detail), 'BadSchema', `${at}: detail is not an object`);
  return e;
}

/**
 * `/h/conquest/{day}.json` (text, bytes or an object) → `{v: 1, day,
 * events: [{seq (decimal string), bell, sig, kind, p, q, site, march
 * ({m, n} | null), from, to, citizens [tag hex], detail}]}`, checked.
 */
export function parseConquestDay(input) {
  const o = objOf(jsonOf(input), 'file');
  versionOf(o);
  const day = intOf(o, 'day', 0, Math.floor(U32 / BELLS_PER_DAY), 'file');
  const events = arrOf(o, 'events', 'file').map((e, i) => eventOf(e, day, `events[${i}]`));
  for (let i = 1; i < events.length; i++) check(BigInt(events[i - 1].seq) <= BigInt(events[i].seq), 'BadOrder', `events[${i}] seq before events[${i - 1}]`);
  return { v: 1, day, events };
}
