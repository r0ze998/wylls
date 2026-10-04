// AC6a: the AI citizens' read side of the herald (AI-CITIZENS-CONTRACT §1.3 C5, §3.2, §5.2, §11.6).
//
//   const feed = createFeed({ herald: 'http://127.0.0.1:41940', roster, clock });
//   await feed.poll();                      // or feed.start() for a timer
//   feed.events(bell)                       // decoded events logged in a bell        (alias eventsFor)
//   feed.batchSince(cursorSeq)              // {events, cursor}: what `episodes_from_events` takes as `batch`
//   await feed.provinceAt(p, q, bell)       // the immutable /h/province/{p},{q}/{bell} envelope, decoded (null: not resolved yet)
//   await feed.provinceBefore(p, q, bell)   // the newest served file at or before bell (up to 4 earlier)
//   await feed.clashAt(p, q, bell)          // the /h/clash/{p},{q}/{bell} report, decoded (null: no clash record)
//   await feed.clashDetail(p, q, bell)      // + pre/post troops per fighter (exact: the report's province_before)
//   await feed.prepare(events)              // prefetch + SYNCHRONOUS readers {province, clash, clashDetail, owners} for the pure episodes function
//   feed.departOf(hostId, arriveBell) / revealOf(...)   // the DEPART / REVEAL of a march
//   feed.owners                             // {citizenOfHost, holdingsOf, ...}  (owners.mjs)
//   feed.wakeEvents(tag, bell)              // W-CLASH / W-THREAT of §3.2 for a watched AI
//   feed.completeThrough()                  // every record logged in a bell <= this is in hand (the `feed_lag` test)
//   feed.subscribe(fn)
//
// Reads only. It GETs /h/season, /h/events, /h/province/*, /h/clash/* (and /h/roster through `feed.rosterRing`)
// from the herald it is given; it never POSTs, signs, or holds a key. A herald URL must be loopback.
//
// What it uses of the herald (shapes captured in test/fixtures/ai-herald-*, see AC6a-NOTES.md):
//  - `/h/events` rows `{seq, slot, sig, kind, bell, tx, body_b64, decoded}`: the server-side `decoded` field
//    (contract §0.2). `bell` is the LOG bell (when the record was written). CLASH's own bell is `key.bell`
//    (the arrival bell, 2 bells before the record is written): the normalised event calls it `clash_bell`.
//  - per-bell province envelopes are decoded by `web/frontier/herald.mjs parseEnvelope` from the raw account
//    bytes (the herald's decoded JSON is not used for them) and checked against the asked key and bell.
//  - the clash report's `decoded.fighters` (the herald's own recomputation; `heraldCheck` is carried) and its
//    `province_before_b64` (the Province bytes before ResolveFromInputs) for exact pre-clash troops.
//
// Units: troops are MILLI-troops on the chain (MILLI = 1000; `MIN_HOST_TROOPS` = 100 troops = 100000);
// `troopsOf(milli)` rounds to whole troops for texts.
import { parseEnvelope } from '../../../permutation-server/web/frontier/herald.mjs';
import { decode as decodeAccount } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { hexDistance } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { decodeRoster } from '../../../permutation-server/web/frontier/people/roster.mjs';
import * as b58 from '../../../permutation-server/web/sdk/base58.mjs';
import { createOwners, parseHostId, tagFromDecimal, tagHex } from './owners.mjs';

export const MILLI = 1000;
export const troopsOf = milli => Math.round(Number(milli) / MILLI);
/** A unit id that is a scout (agents/src/policy.rs SCOUT); every other unit is a combat unit. */
export const SCOUT = 6;
/** Host entry state of a roster (resident) host (fclient abi STATE_ROSTER). */
export const STATE_ROSTER = 1;
export const THREAT_RADIUS_PROVINCES = 3;
export const WEIGHTS = Object.freeze({ 'W-CLASH': 4, 'W-THREAT': 2, 'W-THREAT-BIG': 3 });
/** TRANSIT_SETTLED outcomes and ClashInputs fates, 1-based (frontier-abi log.rs `transit_outcome`). Index 0 = none. */
export const FATE_NAMES = Object.freeze(['None', 'Stays', 'Withdrew', 'Bounced', 'Retreated', 'Destroyed', 'BouncedUnranked', 'Routed', 'BadSeal']);

/** Kinds kept by default (the rest are counted and skipped): the ones episodes, owners and wakes read. */
export const KEPT_KINDS = Object.freeze(['JOIN', 'SETTLE', 'RELEASE', 'HOLDING_FINAL', 'BUILD', 'TRAIN', 'MUSTER', 'DISSOLVE', 'STRANDED',
  'DEPART', 'REVEAL', 'DEPARTURE_SETTLED', 'TRANSIT_SETTLED', 'CLASH', 'CAMP']);

const keyOf = d => `${d.name}:${Object.values(d.key ?? {}).join(',')}`;

/** The 24 three-bit fates of a CLASH record's `fates` (9 bytes, little-endian bit order): slot i = bits 3i..3i+2. 0 = no arrival in that slot. */
export function fatesOf(hex) {
  const b = Buffer.from(String(hex), 'hex');
  const out = [];
  for (let i = 0; i < 24; i++) {
    let v = 0;
    for (let k = 0; k < 3; k++) { const bit = 3 * i + k; if (b[bit >> 3] & (1 << (bit & 7))) v |= 1 << k; }
    out.push(v);
  }
  return out;
}

/**
 * One herald row → the normalised event, or null (no decoded body, or a kind this feed does not keep).
 * Common fields: `seq` (string), `slot`, `tx`, `sig`, `bell` (log bell), `kind` (name), `code`, `key` (herald-style
 * `NAME:key,fields`). Eight-byte integers stay decimal strings (`host_id`, `tip`, `done_at`, `final_ts`);
 * citizen tags become 16-digit hex (`citizen`, `displaced`); a record naming a host also gets `host: {p, q, site, gen, seq}`.
 */
export function normalizeRow(row, { kinds = KEPT_KINDS } = {}) {
  const d = row?.decoded;
  if (!d || typeof d.name !== 'string' || d.kind !== row.kind) return null;
  if (!kinds.includes(d.name)) return null;
  const k = d.key ?? {}, p = d.payload ?? {};
  const out = { seq: String(row.seq), slot: row.slot, tx: row.tx, sig: row.sig, bell: row.bell, kind: d.name, code: d.kind, key: keyOf(d) };
  const host = id => parseHostId(id);
  switch (d.name) {
    case 'JOIN': Object.assign(out, { citizen15: k.citizen_tag15, wallet: p.wallet, faction: p.faction, shard: p.shard }); break;
    case 'SETTLE':
      Object.assign(out, { p: k.p, q: k.q, site: k.site, outcome: p.outcome, citizen: tagFromDecimal(p.citizen_tag), displaced: p.displaced_tag === '0' ? null : tagFromDecimal(p.displaced_tag), gen: p.gen, final_ts: p.final_ts, ticket_bell: p.ticket_bell });
      break;
    case 'RELEASE': Object.assign(out, { p: k.p, q: k.q, site: k.site, citizen: tagFromDecimal(p.citizen_tag) }); break;
    case 'HOLDING_FINAL': Object.assign(out, { p: k.p, q: k.q, site: k.site, final_ts: p.final_ts }); break;
    case 'BUILD': Object.assign(out, { p: k.p, q: k.q, site: k.site, item: p.item, done_at: p.done_at }); break;
    case 'TRAIN': Object.assign(out, { p: k.p, q: k.q, site: k.site, unit: p.unit, n: p.n, done_at: p.done_at }); break;
    case 'MUSTER': Object.assign(out, { host_id: k.host_id, host: host(k.host_id), unit: p.unit, troops: p.troops, tile: p.tile, entry: p.entry }); break;
    case 'DISSOLVE': Object.assign(out, { host_id: k.host_id, host: host(k.host_id), pending_bell: p.pending_bell, delta: p.delta }); break;
    case 'STRANDED': Object.assign(out, { host_id: k.host_id, host: host(k.host_id), troops_lost: p.troops_lost }); break;
    case 'DEPART':
      // the sealed 165-byte seal is not carried; seal_root and commit are public hashes
      Object.assign(out, { host_id: k.host_id, host: host(k.host_id), origin_p: p.origin_p, origin_q: p.origin_q, origin_tile: p.origin_tile, depart_bell: p.depart_bell, arrive_bell: p.arrive_bell, dep_mass: p.dep_mass, march_stamina: p.march_stamina, tip: p.tip, seal_root: p.seal_root, commit: p.commit });
      break;
    case 'REVEAL':
      Object.assign(out, { p: k.p, q: k.q, arrive: k.arrive, faction: k.faction, i: k.i, host_id: p.host_id, host: host(p.host_id), tile: p.tile, stance: p.stance, retreat: p.retreat, displace: p.displace, displaced_host: p.displaced_host === '0' ? null : p.displaced_host, ev_slot: p.ev_slot, ev_price: p.ev_price, ev_limit: p.ev_limit, arrivalday_created: p.arrivalday_created });
      break;
    case 'DEPARTURE_SETTLED': Object.assign(out, { host_id: k.host_id, host: host(k.host_id), troops_after: p.troops_after, stamina_after: p.stamina_after, destroyed: p.destroyed }); break;
    case 'TRANSIT_SETTLED':
      Object.assign(out, { host_id: k.host_id, host: host(k.host_id), outcome: p.outcome, outcome_name: FATE_NAMES[p.outcome] ?? `outcome${p.outcome}`, seal_code: p.seal_code, troops: p.troops, tip: p.tip, fee: p.fee, bond: p.bond, reward: p.reward, pool_owed_delta: p.pool_owed_delta, slot_kept: p.slot_kept });
      break;
    case 'CLASH': {
      const fates = fatesOf(p.fates);
      Object.assign(out, { p: k.p, q: k.q, clash_bell: k.bell, engagements: p.engagements, fates, arrivals: fates.filter(Boolean).length, real: p.engagements > 0 || fates.some(Boolean), outcome_digest: p.outcome_digest, input_digest: p.input_digest });
      break;
    }
    case 'CAMP': Object.assign(out, { p: k.p, q: k.q, tile: p.tile, troops: p.troops, day: p.day }); break;
    default: Object.assign(out, k, p);
  }
  return out;
}

// ---------------------------------------------------------------- shaping

/** A decoded province envelope → the view the AI code reads (owners resolved from public records). */
export function shapeProvince(parsed, owners) {
  const pv = parsed.province;
  const sites = [];
  for (let i = 0; i < Math.min(pv.siteCount, 12); i++) {
    const m = pv.siteMirror[i];
    const holder = m.state === 1 ? owners.holderOfSite(pv.p, pv.q, i, m.gen) : null;
    sites.push({ site: i, tile: pv.sites[i], state: m.state, faction: m.faction, order: m.order, tier: m.tier, gen: m.gen, garrison: m.garrison,
      walls_committed: m.wallsCommitted, shield_until_bell: m.shieldUntilBell, owner: holder?.tag ?? null });
  }
  const hosts = [];
  for (const e of pv.entries) {
    if (e.state === 0) continue;
    const id = String(e.id);
    hosts.push({ id, host: parseHostId(id), owner: owners.citizenOfHost(id), faction: e.faction, unit: e.unit, tile: e.tile, state: e.state,
      troops: e.troops, stamina: e.staminaValue, stamina_bell: e.staminaBell, ready_bell: e.readyBell, from_bell: e.fromBell });
  }
  const inp = parsed.inputs;
  const inputs = inp ? {
    bell: inp.bell, arrivals_mask: inp.arrivalsMask, camp_mask: inp.campMask, flags: inp.flags,
    arrivals: inp.arrivals.filter(a => a.hostId !== 0n).map(a => ({
      host_id: String(a.hostId), citizen: tagHex(a.citizenTag), dep_mass: a.depMass, troops: a.troops, troops_after: a.troopsAfter, stamina: a.stamina, retreat: a.retreat,
      dealt: a.dealt, faction: a.faction, unit: a.unit, tile: a.tile, stance: a.stance, present: a.present, fate: a.fate, fate_name: FATE_NAMES[a.fate] ?? `fate${a.fate}`,
    })),
  } : null;
  return {
    v: 1, p: pv.p, q: pv.q, bell: parsed.bell, slot: parsed.slot, seq: parsed.seq, head: parsed.head,
    resolved_next: pv.resolvedNext, site_count: pv.siteCount, sites, hosts,
    camp: pv.camp ? { tile: pv.camp.tile, state: pv.camp.state, troops: pv.camp.troops, gen: pv.camp.gen } : null,
    summary: { bell: pv.resolveSummary.bell, engagements: pv.resolveSummary.engagements, arrivals: pv.resolveSummary.arrivals, destroyed: pv.resolveSummary.destroyed, bounced: pv.resolveSummary.bounced },
    inputs,
    slots: parsed.slots.map(s => ({ key: s.key, faction: s.account.faction, i: s.account.i, host_id: String(s.account.hostId), citizen: tagHex(s.account.citizenTag), dep_mass: s.account.depMass, unit: s.account.unit, stance: s.account.stance, tile: s.account.tile })),
  };
}

/** The clash report → the view the AI code reads. `fighters[].troops` are the troops AFTER the clash (milli). */
export function shapeClash(j, p, q, bell, owners) {
  const dec = j.decoded;
  return {
    v: 1, p, q, bell: j.bell, engagements: dec.engagements, fates: dec.fates, input_digest: j.inputDigest, outcome_digest: j.outcomeDigest,
    herald_check: j.heraldCheck, check_error: j.checkError ?? null, builder: j.builder, anchor: j.anchor ?? null,
    fighters: dec.fighters.map(f => ({ id: f.id, owner: owners.citizenOfHost(f.id), faction: owners.factionOfHost(f.id), arrival: f.arrival, engaged: f.engaged, fate: f.fate, tile: f.tile, troops: f.troops, stamina: f.stamina })),
  };
}

// ---------------------------------------------------------------- herald access

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function makeGetter(herald, { fetchImpl, timeoutMs }) {
  if (herald && typeof herald.get === 'function') return path => herald.get(path);
  const base = String(typeof herald === 'string' ? herald : herald?.base ?? '').replace(/\/$/, '');
  if (!base) throw new Error('feed: a herald URL (http://127.0.0.1:<port>) is needed');
  const u = new URL(base);
  if (!LOOPBACK.has(u.hostname)) throw new Error(`feed: the herald must be on loopback, got ${u.hostname}`);
  const f = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  return async path => {
    const r = await f(base + path, { signal: AbortSignal.timeout(timeoutMs) });
    const bytes = Buffer.from(await r.arrayBuffer());
    const text = bytes.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary or an error page */ }
    return { status: r.status, json, text, bytes };
  };
}

/** A small insertion-ordered LRU. */
function lru(max) {
  const m = new Map();
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
    set(k, v) { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); },
    size: () => m.size,
  };
}

// ---------------------------------------------------------------- the feed

/**
 * @param {object} o
 * @param {string|{base:string}|{get:Function}} o.herald  loopback herald base URL; `{get(path) → {status, json, text, bytes}}` in tests
 * @param {object|Array} [o.roster]  the AI roster (`roster.json`: `{ai:[{tag, faction, ...}], script:{wallets}, seat:{tag}}`) or the `ai` array; its tags are watched for wakes
 * @param {object} [o.clock]  `{now(): ms}` (default Date.now), used only for poll timing stats
 * @param {object} [o.season]  `{seasonAddress, programId, season}` (default: GET /h/season at the first poll)
 * @param {string[]} [o.kinds]  kinds to keep (default KEPT_KINDS)
 * @param {'real'|'literal'} [o.clashMode]  'real' (default): a CLASH record wakes only when it has an arrival or an engagement (see AC6a-NOTES.md); 'literal': every CLASH record at a province where the AI holds a village also wakes
 */
export function createFeed({ herald, roster = null, clock = null, season = null, kinds = KEPT_KINDS, clashMode = 'real', fetch: fetchImpl = null, timeoutMs = 10_000,
  cacheSize = 512, maxPagesPerPoll = 400, clashRetries = 8, onError = () => {} } = {}) {
  const get = makeGetter(herald, { fetchImpl, timeoutMs });
  const now = clock?.now ? () => clock.now() : () => Date.now();
  let seasonInfo = season ? { ...season } : null;
  let owners = null;
  const list = []; // kept normalised events, in seq order
  const byBell = new Map(); // log bell -> events
  const clashKeys = new Map(); // "p,q,clash_bell" -> event
  const departIdx = new Map(); // "host_id/arrive_bell" -> DEPART event
  const revealIdx = new Map(); // "host_id/arrive" -> REVEAL event
  let cursor = '0'; // last seq read (any kind)
  let headBell = -1; // log bell of the newest row read
  let headSlot = -1;
  let complete = false; // the last poll ended on a non-full page
  const stats = { polls: 0, pages: 0, rows: 0, kept: 0, skipped: 0, bad: 0, errors: 0, last_error: null, last_poll_ms: null, clash_fetched: 0, clash_missing: 0, wakes: 0, kinds: {} };
  const subs = new Set();
  const provCache = lru(cacheSize);
  const clashCache = lru(cacheSize);
  const inflight = new Map();
  const watched = new Map(); // tag -> {tag, faction|null}
  const wakeIdx = new Map(); // tag -> Map(bell -> wake[])
  const pendingClash = []; // {ev, tries}
  let rosterInfo = null;
  let timer = null;
  let polling = null;

  function setRoster(r) {
    rosterInfo = Array.isArray(r) ? { ai: r } : r;
    for (const a of rosterInfo?.ai ?? []) if (a?.tag && !watched.has(a.tag)) watched.set(a.tag, { tag: a.tag, faction: a.faction ?? null });
  }
  if (roster) setRoster(roster);

  async function ensureSeason() {
    if (seasonInfo?.seasonAddress && seasonInfo?.programId && owners) return;
    if (!seasonInfo?.seasonAddress) {
      const r = await get('/h/season');
      if (r.status !== 200 || !r.json) throw new Error(`GET /h/season → ${r.status}`);
      seasonInfo = { seasonAddress: r.json.seasonAddress, programId: r.json.programId, season: String(r.json.season), genesisTs: r.json.genesisTs, bellSecs: r.json.bellSecs };
    }
    owners = createOwners({ seasonAddress: seasonInfo.seasonAddress, programId: seasonInfo.programId });
  }

  const addWake = (tag, w) => {
    let m = wakeIdx.get(tag);
    if (!m) wakeIdx.set(tag, (m = new Map()));
    const l = m.get(w.bell) ?? [];
    if (!l.some(x => x.code === w.code && x.seq === w.seq)) { l.push(w); m.set(w.bell, l); stats.wakes++; }
  };

  /** W-THREAT (§3.2): a DEPART of another nation's host whose origin is <= 3 provinces from the AI's home. */
  async function threatWakes(ev) {
    const out = [];
    for (const ai of watched.values()) {
      const home = owners.homeOf(ai.tag);
      const myFaction = owners.factionOfTag(ai.tag) ?? ai.faction;
      if (!home || myFaction === null) continue;
      const actor = owners.citizenOfHost(ev.host_id);
      const theirs = actor === null ? null : owners.factionOfTag(actor);
      if (theirs === null || theirs === myFaction) continue;
      const dist = hexDistance(ev.origin_p, ev.origin_q, home.p, home.q);
      if (dist > THREAT_RADIUS_PROVINCES) continue;
      // home troops estimate: the AI's own resident combat hosts in its home province at the departure bell (the
      // brain's `home_troops` also counts the reserve and the garrison; the gate may recompute with it, see AC6a-NOTES.md)
      let homeTroops = null, homeBell = null;
      try {
        // the per-bell province file of bell b exists only once b is resolved (about two bells later), so a DEPART
        // logged at bell d finds the file of d - 2 or d - 3 at best: take the newest one served
        const pv = await provinceBefore(home.p, home.q, ev.depart_bell ?? ev.bell, 4);
        if (pv) { homeBell = pv.bell; homeTroops = pv.hosts.filter(h => h.owner === ai.tag && h.unit !== SCOUT).reduce((s, h) => s + h.troops, 0); }
      } catch { /* the estimate is optional */ }
      const big = homeTroops !== null && homeTroops > 0 && ev.dep_mass * 2 >= homeTroops;
      out.push([ai.tag, { code: 'W-THREAT', weight: big ? WEIGHTS['W-THREAT-BIG'] : WEIGHTS['W-THREAT'], bell: ev.bell, seq: ev.seq, depart_bell: ev.depart_bell, arrive_bell: ev.arrive_bell,
        origin: { p: ev.origin_p, q: ev.origin_q }, distance: dist, nation: theirs, actor, host_id: ev.host_id, dep_mass: ev.dep_mass, home_troops_est: homeTroops, home_troops_bell: homeBell, big }]);
    }
    return out;
  }

  /** W-CLASH (§3.2): a CLASH at a province where the AI has a village or a host, or that lists one of its hosts. */
  async function clashWakes(ev) {
    const out = [];
    const holders = new Map(owners.holdersIn(ev.p, ev.q).map(h => [h.tag, h]));
    let report = null;
    if (ev.real) {
      report = await clashAt(ev.p, ev.q, ev.clash_bell);
      if (!report) return null; // not served yet: retry on a later poll
    }
    const mine = new Map();
    for (const f of report?.fighters ?? []) if (f.owner) (mine.get(f.owner) ?? mine.set(f.owner, []).get(f.owner)).push(f);
    for (const ai of watched.values()) {
      const hasVillage = holders.has(ai.tag);
      const fighters = mine.get(ai.tag) ?? [];
      if (!fighters.length && !(hasVillage && (ev.real || clashMode === 'literal'))) continue;
      out.push([ai.tag, { code: 'W-CLASH', weight: WEIGHTS['W-CLASH'], bell: ev.bell, seq: ev.seq, p: ev.p, q: ev.q, clash_bell: ev.clash_bell, engagements: ev.engagements, arrivals: ev.arrivals,
        village: hasVillage, own_hosts: fighters.map(f => f.id), own_arrival: fighters.some(f => f.arrival), own_engaged: fighters.some(f => f.engaged), real: ev.real }]);
    }
    return out;
  }

  async function ingestRows(rows) {
    await ensureSeason();
    const fresh = [];
    for (const row of rows) {
      stats.rows++;
      const kname = row?.decoded?.name ?? `kind${row?.kind}`;
      stats.kinds[kname] = (stats.kinds[kname] ?? 0) + 1;
      cursor = String(row.seq);
      if (Number.isInteger(row.bell) && row.bell < 0xffffffff && row.bell > headBell) headBell = row.bell;
      if (Number.isInteger(row.slot) && row.slot > headSlot) headSlot = row.slot;
      if (!row?.decoded) { stats.bad++; continue; }
      const ev = normalizeRow(row, { kinds });
      if (!ev) { stats.skipped++; continue; }
      stats.kept++;
      list.push(ev);
      const l = byBell.get(ev.bell) ?? [];
      l.push(ev); byBell.set(ev.bell, l);
      if (ev.kind === 'CLASH') clashKeys.set(`${ev.p},${ev.q},${ev.clash_bell}`, ev);
      if (ev.kind === 'DEPART') departIdx.set(`${ev.host_id}/${ev.arrive_bell}`, ev);
      if (ev.kind === 'REVEAL') revealIdx.set(`${ev.host_id}/${ev.arrive}`, ev);
      owners.ingest(ev);
      fresh.push(ev);
      if (ev.kind === 'DEPART') for (const [tag, w] of await threatWakes(ev)) addWake(tag, w);
      if (ev.kind === 'CLASH') pendingClash.push({ ev, tries: 0 });
    }
    await drainClashes();
    return fresh;
  }

  async function drainClashes() {
    if (!pendingClash.length) return;
    const todo = pendingClash.splice(0);
    for (const item of todo) {
      let r = null;
      try { r = await clashWakes(item.ev); } catch (e) { stats.errors++; stats.last_error = String(e?.message ?? e); onError(e); }
      if (r) { for (const [tag, w] of r) addWake(tag, w); if (item.ev.real) stats.clash_fetched++; continue; }
      if (++item.tries >= clashRetries) { stats.clash_missing++; continue; }
      pendingClash.push(item);
    }
  }

  async function pollOnce() {
    const t0 = now();
    stats.polls++;
    const before = list.length;
    try {
      await ensureSeason();
      let pages = 0;
      complete = false;
      for (;;) {
        const r = await get(`/h/events?after=${encodeURIComponent(cursor)}`);
        if (r.status !== 200 || !r.json || !Array.isArray(r.json.events)) throw new Error(`GET /h/events → ${r.status}`);
        stats.pages++;
        pages++;
        await ingestRows(r.json.events);
        if (!r.json.full) { complete = true; break; }
        if (pages >= maxPagesPerPoll) break;
      }
      await drainClashes();
    } catch (e) {
      complete = false;
      stats.errors++;
      stats.last_error = String(e?.message ?? e);
      onError(e);
    }
    stats.last_poll_ms = now() - t0;
    const added = list.slice(before);
    if (added.length) for (const fn of subs) { try { fn({ events: added, through_bell: api.completeThrough(), cursor }); } catch (e) { onError(e); } }
    return { ok: complete, added: added.length, cursor, through_bell: api.completeThrough(), error: complete ? null : stats.last_error };
  }

  // ---- province / clash

  async function cached(cache, key, loader) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const pr = (async () => {
      try {
        const v = await loader();
        if (v) cache.set(key, v);
        return v;
      } finally { inflight.delete(key); }
    })();
    inflight.set(key, pr);
    return pr;
  }

  async function provinceAt(p, q, bell) {
    await ensureSeason();
    return cached(provCache, `pv:${p},${q},${bell}`, async () => {
      const r = await get(`/h/province/${p},${q}/${bell}`);
      if (r.status === 404) return null; // NotYet: the bell is not resolved there yet
      if (r.status !== 200 || !r.json) throw new Error(`GET /h/province/${p},${q}/${bell} → ${r.status}`);
      const parsed = parseEnvelope(r.json, { seasonId: seasonInfo.season, p, q, bell });
      return shapeProvince(parsed, owners);
    });
  }

  /** The newest served province file at or before `bell` (up to `back` bells earlier), or null. */
  async function provinceBefore(p, q, bell, back = 4) {
    for (let b = bell; b >= Math.max(0, bell - back); b--) {
      const v = await provinceAt(p, q, b);
      if (v) return v;
    }
    return null;
  }

  async function clashAt(p, q, bell) {
    await ensureSeason();
    // a bell with no CLASH record has no file: answer from the log without a request once the log is past that bell
    if (!clashKeys.has(`${p},${q},${bell}`) && complete && headBell > bell + 2) return null;
    return cached(clashCache, `cl:${p},${q},${bell}`, async () => {
      const r = await get(`/h/clash/${p},${q}/${bell}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.json?.decoded) throw new Error(`GET /h/clash/${p},${q}/${bell} → ${r.status}`);
      if (r.json.bell !== bell) throw new Error(`clash report of bell ${r.json.bell}, asked ${bell}`);
      const rep = shapeClash(r.json, p, q, bell, owners);
      Object.defineProperty(rep, '_raw', { value: r.json, enumerable: false });
      return rep;
    });
  }

  /**
   * The clash with the troops each fighter had before and after. `before` is exact when the report carries the
   * Province bytes before ResolveFromInputs (`province_before_b64`; `pre_source: 'report'`), else it falls back to
   * the previous bell's province file (`'province_file'`; approximate if a muster, train or dissolve landed in the bell)
   * and to the arrival record of the clash inputs for an arriving host (`'arrival'`, the host's departure strength).
   */
  async function clashDetail(p, q, bell) {
    const rep = await clashAt(p, q, bell);
    if (!rep) return null;
    const post = await provinceAt(p, q, bell);
    const arrivals = new Map((post?.inputs?.arrivals ?? []).map(a => [a.host_id, a]));
    let preHosts = null, preSource = null;
    const raw = rep._raw?.province_before_b64;
    if (raw) {
      try {
        const bytes = Uint8Array.from(Buffer.from(raw, 'base64'));
        const pv = decodeAccount('Province', bytes, { seasonId: seasonInfo.season });
        preHosts = new Map(pv.entries.filter(e => e.state !== 0).map(e => [String(e.id), e]));
        preSource = 'report';
      } catch { preHosts = null; }
    }
    if (!preHosts) {
      const prev = await provinceAt(p, q, bell - 1);
      if (prev) { preHosts = new Map(prev.hosts.map(h => [h.id, h])); preSource = 'province_file'; }
    }
    const fighters = rep.fighters.map(f => {
      const a = arrivals.get(f.id);
      let before = null, source = null;
      if (a) { before = a.troops; source = 'arrival'; } else if (preHosts?.has(f.id)) { before = preHosts.get(f.id).troops; source = preSource; }
      return { ...f, troops_before: before, troops_after: f.troops, lost: before === null ? null : before - f.troops, before_source: source };
    });
    return { ...rep, fighters, pre_source: preSource, inputs: post?.inputs ?? null };
  }

  const api = {
    owners: null,
    stats,
    /** Pull new events (single flight). Never throws: the result says `ok`. */
    poll() { return (polling ??= pollOnce().finally(() => { polling = null; })); },
    start({ intervalMs = 2000 } = {}) {
      if (timer) return;
      const tick = async () => { await api.poll(); if (timer) timer = setTimeout(tick, intervalMs); timer?.unref?.(); };
      timer = setTimeout(tick, 0);
      timer.unref?.();
    },
    stop() { if (timer) clearTimeout(timer); timer = null; },
    /** Feed rows from elsewhere (a replay, a test) through the same path as a poll. */
    async ingest(rows) { const fresh = await ingestRows(rows); if (fresh.length) for (const fn of subs) fn({ events: fresh, through_bell: api.completeThrough(), cursor }); return fresh; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Events logged in `bell` (kept kinds), in seq order. */
    events(bell) { return (byBell.get(bell) ?? []).slice(); },
    eventsFor(bell) { return api.events(bell); },
    /** Kept events with seq > `after` (a decimal string cursor; '0' = all) and the new cursor: the `batch` of `episodes_from_events`. */
    batchSince(after = '0') {
      const a = BigInt(after);
      const events = list.filter(e => BigInt(e.seq) > a);
      return { events, cursor: events.length ? events[events.length - 1].seq : String(after) };
    },
    /** The DEPART of a host that arrives (or was to arrive) at `arriveBell`, or null; and the REVEAL of that march. */
    departOf(hostId, arriveBell) { return departIdx.get(`${hostId}/${arriveBell}`) ?? null; },
    revealOf(hostId, arriveBell) { return revealIdx.get(`${hostId}/${arriveBell}`) ?? null; },
    /**
     * Fetch what `episodes_from_events` reads for a batch and return SYNCHRONOUS readers over it (the function is pure:
     * no network inside). For every CLASH: the report, the province files of clash_bell - 1 and clash_bell and the
     * detail; for every REVEAL: the destination province's file at the DEPART bell (the state the sender could see)
     * and at the arrival bell. `missing` lists the "kind:p,q,bell" keys the herald did not serve (NotYet).
     *   const ctx = await feed.prepare(batch.events);  ctx.province(p, q, bell) | ctx.clash(p, q, bell) | ctx.clashDetail(p, q, bell) | ctx.owners
     */
    async prepare(events) {
      const prov = new Map(), cl = new Map(), det = new Map();
      const jobs = [];
      const needP = (p, q, b) => { const k = `${p},${q},${b}`; if (b < 0 || prov.has(k)) return; prov.set(k, null); jobs.push(provinceAt(p, q, b).then(v => prov.set(k, v))); };
      const needC = (p, q, b) => { const k = `${p},${q},${b}`; if (cl.has(k)) return; cl.set(k, null); det.set(k, null); jobs.push(clashAt(p, q, b).then(v => cl.set(k, v)), clashDetail(p, q, b).then(v => det.set(k, v))); };
      for (const ev of events) {
        if (ev.kind === 'CLASH') { needC(ev.p, ev.q, ev.clash_bell); needP(ev.p, ev.q, ev.clash_bell - 1); needP(ev.p, ev.q, ev.clash_bell); }
        if (ev.kind === 'REVEAL') {
          const d = departIdx.get(`${ev.host_id}/${ev.arrive}`);
          if (d) needP(ev.p, ev.q, d.depart_bell);
          needP(ev.p, ev.q, ev.arrive);
        }
      }
      await Promise.all(jobs);
      const key = (p, q, b) => `${p},${q},${b}`;
      const missing = [];
      for (const [k, v] of prov) if (!v) missing.push(`province:${k}`);
      for (const [k, v] of cl) if (!v) missing.push(`clash:${k}`);
      return { province: (p, q, b) => prov.get(key(p, q, b)) ?? null, clash: (p, q, b) => cl.get(key(p, q, b)) ?? null, clashDetail: (p, q, b) => det.get(key(p, q, b)) ?? null, owners: api.owners, missing: missing.sort() };
    },
    cursor: () => cursor,
    /** The newest log bell seen. */
    headBell: () => headBell,
    /**
     * Every record logged in a bell <= this value is in hand, or -1: the last poll reached the end of the herald's
     * index (a non-full page), so what is missing was logged at or after the head's own bell. The mind refuses a model
     * session (`feed_lag`) when this is below its bell − 1.
     */
    completeThrough() { return complete && headBell >= 0 ? headBell - 1 : -1; },
    provinceAt, provinceBefore, clashAt, clashDetail,
    /** /h/roster/{ring}/latest.bin decoded (people/roster.mjs), or null (the paused m1-exit herald does not serve it). */
    async rosterRing(ring) {
      const r = await get(`/h/roster/${ring}/latest.bin`);
      if (r.status !== 200) return null;
      const d = decodeRoster(Uint8Array.from(r.bytes ?? Buffer.from(r.text ?? '', 'latin1')));
      owners?.useRoster(d);
      return d;
    },
    /** Register AI citizens to derive wakes for: [{tag, faction?}] (the roster's `ai` entries are watched already). */
    watch(entries) { for (const e of entries) watched.set(e.tag, { tag: e.tag, faction: e.faction ?? null }); },
    setRoster,
    /** The AI / script bot / seat / unlabelled kind of a citizen tag, from the roster only (§8.3 badges): 'ai' | 'seat' | 'script' | null. */
    kindOfTag(tag) {
      if (!rosterInfo) return null;
      if ((rosterInfo.ai ?? []).some(a => a.tag === tag)) return 'ai';
      if (rosterInfo.seat?.tag === tag) return 'seat';
      const w = owners?.walletOf(tag);
      if (w && (rosterInfo.script?.wallets ?? []).includes(w)) return 'script';
      return null;
    },
    /** The wakes of §3.2 that this feed derives for a watched AI at log bell `bell`: [{code, weight, bell, seq, ...}]. */
    wakeEvents(tag, bell) { return (wakeIdx.get(tag)?.get(bell) ?? []).slice(); },
    /** Merge a bell's wakes the way the gate reads them: the uncapped weight sum and the codes (one W-code counted once per event). */
    wakeSummary(tag, bell) {
      const w = api.wakeEvents(tag, bell);
      return { bell, weight: w.reduce((s, x) => s + x.weight, 0), codes: [...new Set(w.map(x => x.code))], events: w };
    },
    /** The season facts the feed read (or was given). */
    season: () => (seasonInfo ? { ...seasonInfo } : null),
  };
  Object.defineProperty(api, 'owners', { get: () => owners });
  return api;
}
