// AC6: the nation council's options (contract section 6.5 step 1) and the job that opens a council and asks the AI members
// for their motion and their ballot (section 3.4: the council-motion and council-ballot calls).
//
// Pure part (vectors in test/citizens-watcher-council-gen.test.mjs):
//   ratioWord(own, enemy)                         the troop-ratio word of section 4.3 ("estimate")
//   targetProvinces(holdings)                     provinces within 2 provinces of >= 3 of the nation's holdings
//   rawTargets(pv, {faction, strikeBell})         the strike, camp and raid targets one province offers (value, enemy troops, tile)
//   largestEnemyStack(pv, faction)                the strike target of a province: the largest stack of one other nation on a non-site tile
//   rankOptions({faction, raws, provinceOf})      own strength, the 1.5 filter, ranking, the top three distinct provinces
//
// Job part: createCouncilGen(...) opens period k of a nation at C0 (the watcher fixes the options from the immutable herald files of
// bell C0 - 2, the voters and the humans), then asks each AI member of the nation for one motion (window [C0, C0+3)) and one ballot
// (window [C0+3, C0+6)) through the mind (`mind.councilCall`), once each, deadlines as section 3.4.
//
// Everything here reads public records only (the herald's province files, the roster, the owners index). Options carry no reward
// text and no capture (D9): a strike or a raid costs troops only.
import { hexDistance } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { SCOUT, STATE_ROSTER } from './feed.mjs';
import { candidatesHash, optionsHash } from '../social/council.mjs';

/** A site state of the Province account: a village stands there (web/frontier/fland.mjs SITE.HOLDING). */
export const SITE_HOLDING = 1;
/** Hosts of a faction number >= 6 are not a nation (6 = neutral / camp). */
export const NATIONS = 6;
export const NEAR_RADIUS = 2; // a target must lie within this many provinces of ...
export const NEAR_HOLDINGS = 3; // ... at least this many of the nation's holdings
export const OWN_RADIUS = 2; // the own strength counts the nation's resident combat hosts within this many provinces of the target
export const OWN_TOP_HOSTS = 4; // the four largest of them
export const OWN_FACTOR = 1.5; // an option is offered only if own >= OWN_FACTOR x value
export const MAX_OPTIONS = 3;
export const MILLI = 1000;
const KIND_ORDER = { strike: 0, camp: 1, raid: 2 };
export const FAIL_RETRY_MS = 5000;
export const MAX_CALL_TRIES = 2;

const troops = milli => Math.floor(Math.max(0, Number(milli) || 0) / MILLI);
const key = (p, q) => `${p},${q}`;

/** The troop-ratio word of section 4.3: own / enemy >= 2 favourable, >= 1 even, < 1 unfavourable. A labelled estimate, never a promise. */
export function ratioWord(own, enemy) {
  if (!(enemy > 0)) return 'favourable';
  const r = own / enemy;
  return r >= 2 ? 'favourable' : r >= 1 ? 'even' : 'unfavourable';
}

/** Provinces within `r` provinces of (p, q), the centre included, in a fixed order (axial coordinates, as fgeo.hexDistance). */
export function ball(p, q, r) {
  const out = [];
  for (let dp = -r; dp <= r; dp++) {
    for (let dq = -r; dq <= r; dq++) {
      if (hexDistance(0, 0, dp, dq) <= r) out.push({ p: p + dp, q: q + dq });
    }
  }
  return out;
}

/** Target provinces: within NEAR_RADIUS of at least NEAR_HOLDINGS of the nation's holdings. `holdings` = [{p, q}] (one entry per village). Sorted by (p, q). */
export function targetProvinces(holdings, { radius = NEAR_RADIUS, need = NEAR_HOLDINGS } = {}) {
  const count = new Map();
  for (const h of holdings) for (const c of ball(h.p, h.q, radius)) count.set(key(c.p, c.q), (count.get(key(c.p, c.q)) ?? 0) + 1);
  return [...count].filter(([, n]) => n >= need).map(([k]) => { const [p, q] = k.split(',').map(Number); return { p, q }; }).sort((a, b) => a.p - b.p || a.q - b.q);
}

const siteTiles = pv => new Set((pv.sites ?? []).filter(s => s.site < (pv.site_count ?? 12)).map(s => s.tile));
const isCombat = h => h.state === STATE_ROSTER && h.unit !== SCOUT;

/**
 * The strike target of a province (shaped by feed.shapeProvince): the largest stack of ONE other nation, resident combat hosts on a
 * non-site tile. Ties: the smaller tile index, then the smaller nation. Returns {tile, faction, troops (milli), hosts} or null.
 */
export function largestEnemyStack(pv, faction) {
  const tiles = siteTiles(pv);
  const stacks = new Map();
  for (const h of pv.hosts ?? []) {
    if (!isCombat(h) || h.faction === faction || !(h.faction >= 0 && h.faction < NATIONS) || tiles.has(h.tile)) continue;
    const k = `${h.tile}|${h.faction}`;
    const s = stacks.get(k) ?? { tile: h.tile, faction: h.faction, troops: 0, hosts: [] };
    s.troops += Number(h.troops);
    s.hosts.push(h.id);
    stacks.set(k, s);
  }
  let best = null;
  for (const s of stacks.values()) if (!best || s.troops > best.troops || (s.troops === best.troops && (s.tile < best.tile || (s.tile === best.tile && s.faction < best.faction)))) best = s;
  return best;
}

/** The raid target of a province: the village of another nation with the most garrison plus resident troops on its tile whose shield has ended by `strikeBell`. */
export function bestRaidVillage(pv, faction, strikeBell) {
  let best = null;
  for (const s of pv.sites ?? []) {
    if (s.state !== SITE_HOLDING || s.faction === faction || !(s.faction >= 0 && s.faction < NATIONS)) continue;
    if (Number(s.shield_until_bell ?? 0) > strikeBell) continue; // the target's shield still stands at the arrival bell
    const resident = (pv.hosts ?? []).filter(h => h.state === STATE_ROSTER && h.tile === s.tile && h.faction !== faction).reduce((a, h) => a + Number(h.troops), 0);
    const total = Number(s.garrison ?? 0) + resident;
    if (!best || total > best.total || (total === best.total && s.tile < best.tile)) best = { tile: s.tile, site: s.site, faction: s.faction, total };
  }
  return best;
}

/**
 * What one province offers nation `faction` as an option, before the own-strength filter:
 * strike (value = the largest enemy stack), camp (value = half of the camp's troops), raid (value = 0.8 x garrison plus resident troops).
 * `enemy` is the troop count the ratio word compares with (the whole stack, the whole camp, the whole garrison plus residents).
 * Values are whole troops, rounded down. Returns [{kind, p, q, value, enemy, tile}] (the tile is internal: never published).
 */
export function rawTargets(pv, { faction, strikeBell }) {
  const out = [];
  if (!pv) return out;
  const stack = largestEnemyStack(pv, faction);
  if (stack && stack.troops > 0) out.push({ kind: 'strike', p: pv.p, q: pv.q, value: troops(stack.troops), enemy: troops(stack.troops), tile: stack.tile });
  if (pv.camp && pv.camp.state === 1 && Number(pv.camp.troops) > 0) {
    // camps count whole troops (camp.rs), unlike host entries
    out.push({ kind: 'camp', p: pv.p, q: pv.q, value: Math.floor(Number(pv.camp.troops) / 2), enemy: Number(pv.camp.troops), tile: pv.camp.tile });
  }
  const raid = bestRaidVillage(pv, faction, strikeBell);
  if (raid && raid.total > 0) out.push({ kind: 'raid', p: pv.p, q: pv.q, value: Math.floor(0.8 * troops(raid.total)), enemy: troops(raid.total), tile: raid.tile });
  return out.filter(r => r.value > 0);
}

/** The nation's strength near a target: the sum of its 4 largest resident combat hosts within 2 provinces (whole troops). `provinceOf(p, q)` is a synchronous lookup (null: not fetched). */
export function ownStrengthNear(p, q, { faction, provinceOf, radius = OWN_RADIUS, top = OWN_TOP_HOSTS }) {
  const hosts = [];
  for (const c of ball(p, q, radius)) {
    const pv = provinceOf(c.p, c.q);
    for (const h of pv?.hosts ?? []) if (isCombat(h) && h.faction === faction) hosts.push(Number(h.troops));
  }
  hosts.sort((a, b) => b - a);
  return troops(hosts.slice(0, top).reduce((a, b) => a + b, 0));
}

/**
 * Section 6.5 step 1 from the raw targets: attach own strength, drop options with own < 1.5 x value, rank by value (ties by (p, q), then
 * strike < camp < raid), keep the top three DISTINCT provinces and number them 1..n. Returns {options, hints, dropped}: `options` are
 * `{option, kind, p, q, value, own, ratio}` (public), `hints[option] = {tile}` (internal, for the Call's tile fallback).
 */
export function rankOptions({ faction, raws, provinceOf }) {
  const ownAt = new Map();
  const dropped = [];
  const ok = [];
  for (const r of raws) {
    const k = key(r.p, r.q);
    if (!ownAt.has(k)) ownAt.set(k, ownStrengthNear(r.p, r.q, { faction, provinceOf }));
    const own = ownAt.get(k);
    if (own >= OWN_FACTOR * r.value) ok.push({ ...r, own });
    else dropped.push({ kind: r.kind, p: r.p, q: r.q, value: r.value, own });
  }
  ok.sort((a, b) => b.value - a.value || a.p - b.p || a.q - b.q || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const seen = new Set();
  const options = [];
  const hints = {};
  for (const r of ok) {
    const k = key(r.p, r.q);
    if (seen.has(k)) continue;
    seen.add(k);
    const option = options.length + 1;
    options.push({ option, kind: r.kind, p: r.p, q: r.q, value: r.value, own: r.own, ratio: ratioWord(r.own, r.enemy) });
    hints[option] = { tile: r.tile };
    if (options.length === MAX_OPTIONS) break;
  }
  return { options, hints, dropped };
}

// ------------------------------------------------------------------------------------------------ the job

/** Run `fn` over `items` with at most `n` in flight; results in order. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * createCouncilGen({feed, social, roster, census, clock, mind, store, config, stats, onError, nowMs, outbox})
 *   mind: () => the mind (late binding; the mind is built after the watcher)
 *   store: the watcher's persisted state ({calls: Set of "motion:<tag>:<k>" | "ballot:<tag>:<k>"})
 *   outbox: {push(item)} for what a council call returns (the brain posts it with a later decision answer, see outbox.mjs)
 * -> {councilCandidates(f, c0), tryOpen(f, k, c0, bell), step(bell), hintOf(f, k, option), meta}
 */
export function createCouncilGen({ feed, social, roster, census, clock = null, mind = () => null, store, config = {}, stats = {}, onError = () => {}, nowMs = () => Date.now(), outbox = null, fetchLimit = 8, retryMs = 1500 } = {}) {
  const council = social?.council ?? null;
  const cfg = () => ({ period: 48, offset: 12, strike_lead: 6, ...(config.council ?? {}), ...(council?.config ?? {}) });
  const hints = new Map(); // "f|k" -> {option: {tile}}
  const attempts = new Map(); // "f|k" -> {at, n, status}
  const calling = new Set();
  const fails = new Map(); // call key -> {n, at}: a failed call is asked again after FAIL_RETRY_MS, twice at most
  const bump = (k, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };

  /**
   * One province file of bell `bell`: the strict immutable file; when it is not served and `fallback` allows, the newest served one up to
   * 4 bells earlier (flagged in the meta). Without `fallback` a missing file is only counted: the caller may wait for it.
   */
  async function provinceFile(p, q, bell, meta, fallback) {
    let pv = null;
    try { pv = await feed.provinceAt(p, q, bell); } catch (e) { meta.errors++; onError(e); }
    if (pv) { meta.fetched++; return pv; }
    if (fallback) {
      try { pv = await feed.provinceBefore?.(p, q, bell, 4); } catch (e) { meta.errors++; onError(e); }
      if (pv) { meta.fallback++; meta.fetched++; return pv; }
    }
    meta.missing++;
    return null;
  }

  /**
   * The options of nation f for the period starting at c0, from the herald files of bell c0 - 2.
   * -> {candidates, candidates_hash, options_hash, hints, meta} (candidates = [] when there is no option: no council that period).
   * `fallback: false` (the job, during the first bell of the period) makes the strict files the only source: `meta.missing > 0` then
   * means "some are not served yet" and the job waits a bell for them (the determinism of the A/B pair rule rests on bell C0 - 2).
   */
  async function councilCandidates(f, c0, { fallback = true } = {}) {
    const bell = c0 - 2;
    const c = cfg();
    const strikeBell = c0 + 6 + c.strike_lead;
    const meta = { faction: f, c0, bell, holdings: 0, targets: 0, fetched: 0, missing: 0, fallback: 0, errors: 0, raw: 0, dropped: 0 };
    const holdings = census.holdingsOfNation(f);
    meta.holdings = holdings.length;
    const cache = new Map();
    const need = async list => mapLimit(list.filter(c1 => !cache.has(key(c1.p, c1.q))), fetchLimit, async c1 => { cache.set(key(c1.p, c1.q), await provinceFile(c1.p, c1.q, bell, meta, fallback)); });
    const targets = targetProvinces(holdings);
    meta.targets = targets.length;
    await need(targets);
    const raws = [];
    for (const t of targets) raws.push(...rawTargets(cache.get(key(t.p, t.q)), { faction: f, strikeBell }));
    meta.raw = raws.length;
    // the own strength needs the provinces around each viable target
    const around = new Map();
    for (const r of raws) for (const c1 of ball(r.p, r.q, OWN_RADIUS)) around.set(key(c1.p, c1.q), c1);
    await need([...around.values()]);
    const { options, hints: h, dropped } = rankOptions({ faction: f, raws, provinceOf: (p, q) => cache.get(key(p, q)) ?? null });
    meta.dropped = dropped.length;
    return {
      candidates: options,
      candidates_hash: options.length ? candidatesHash(options) : null,
      options_hash: options.length ? optionsHash(options) : null,
      hints: h,
      meta,
    };
  }

  /** The wake deadline of a council call: bell_start(end bell) - margin, real unix ms. */
  function deadlineOf(endBell) {
    if (!clock?.hasAnchor?.()) return null;
    return Math.floor(clock.bellStartReal(endBell) - clock.marginMs());
  }

  /**
   * Try to open period k of nation f at bell >= c0. Returns the state: 'opened' | 'exists' | 'skipped:<why>' | 'waiting'.
   * Skips are final for the period (counted); 'waiting' means the feed is not complete through c0 - 1 yet or a retry is not due.
   */
  async function tryOpen(f, k, c0, bell) {
    if (!council?.open) return 'skipped:no_council';
    const id = `${f}|${k}`;
    if (council.periodOf?.(f, k)) return 'exists';
    const had = attempts.get(id);
    if (had?.status?.startsWith('skipped')) return had.status;
    if (had && nowMs() - had.at < retryMs) return 'waiting';
    const through = feed.completeThrough?.() ?? -1;
    if (through < c0 - 1) return 'waiting'; // the records of bell c0 - 1 (holdings becoming final) are not all in hand
    attempts.set(id, { at: nowMs(), n: (had?.n ?? 0) + 1, status: 'trying' });
    const members = roster.ai.filter(a => a.faction === f);
    if (!members.length) return mark(id, 'skipped:no_members');
    // a nation's council runs only if every AI of the nation holds a final village at C0 (section 6.5)
    if (!members.every(a => census.hasFinalHolding(a.tag))) return mark(id, 'skipped:not_all_final');
    // during the first bell of the period only the strict files of bell C0 - 2 count: they are served about when C0 begins, so a missing
    // one is waited for (the motion window is three bells, the open can lag one); from C0 + 1 the newest served file within 4 bells is accepted
    const gen = await councilCandidates(f, c0, { fallback: bell >= c0 + 1 });
    if (bell < c0 + 1 && gen.meta.missing > 0) { attempts.set(id, { at: nowMs(), n: (had?.n ?? 0) + 1, status: 'waiting_files', meta: gen.meta }); bump('council_waiting_files'); return 'waiting'; }
    if (!gen.candidates.length) return mark(id, 'skipped:no_options', gen.meta);
    const { eligible, humans } = census.voters(f);
    let opened;
    try {
      opened = council.open({ faction: f, period: k, c0, candidates: gen.candidates, candidates_hash: gen.candidates_hash, options_hash: gen.options_hash, eligible, humans });
    } catch (e) {
      stats.last_error = String(e?.message ?? e).slice(0, 300);
      onError(e);
      return mark(id, 'skipped:open_failed');
    }
    if (!opened) return mark(id, 'skipped:no_options', gen.meta);
    hints.set(id, gen.hints);
    attempts.set(id, { at: nowMs(), n: 1, status: 'opened', meta: gen.meta });
    bump('councils_opened');
    return 'opened';
  }
  function mark(id, status, meta = null) {
    attempts.set(id, { at: nowMs(), n: 1, status, meta });
    bump(status.replace(/[^a-z_]/g, '_'));
    return status;
  }

  /** Ask each AI member of nation f for its call of this kind once (persisted: a restart does not ask again). */
  async function askMembers(f, k, kind, endBell, bell) {
    const m = mind();
    if (!m?.councilCall) return;
    const deadline = deadlineOf(endBell);
    if (deadline == null) return; // no game clock yet: the mind has no anchor either
    for (const a of roster.ai.filter(x => x.faction === f)) {
      const callKey = `${kind}:${a.tag}:${k}`;
      if (store.calls.has(callKey) || calling.has(callKey)) continue;
      const failed = fails.get(callKey);
      if (failed && nowMs() - failed.at < FAIL_RETRY_MS) continue;
      calling.add(callKey);
      Promise.resolve()
        .then(() => m.councilCall({ tag: a.tag, kind, period: k, bell, deadline_unix_ms: deadline }))
        .then(res => {
          store.calls.add(callKey);
          store.dirty = true;
          bump(`council_${kind}_calls`);
          if (res?.mode === 'model') bump(`council_${kind}_model`);
          else bump(`council_${kind}_autopilot`);
          if (outbox && (res?.social?.motion || res?.social?.ballot)) outbox.push({ tag: a.tag, kind, period: k, decision_id: res.decision_id, bell, motion: res.social.motion ?? null, ballot: res.social.ballot ?? null });
        })
        .catch(e => {
          if (e?.retry) { bump(`council_${kind}_retry`); fails.set(callKey, { n: fails.get(callKey)?.n ?? 0, at: nowMs() }); return; } // integ-B: feed not complete yet: asked again, not a failure
          bump(`council_${kind}_errors`);
          stats.last_error = String(e?.message ?? e).slice(0, 300);
          onError(e);
          const n = (fails.get(callKey)?.n ?? 0) + 1;
          fails.set(callKey, { n, at: nowMs() });
          if (n >= MAX_CALL_TRIES) { store.calls.add(callKey); store.dirty = true; bump(`council_${kind}_gave_up`); }
        })
        .finally(() => calling.delete(callKey));
    }
  }

  /** One pass at bell `bell`: open what is due, then ask the AI members for their motion (window open) and ballot (window open). */
  async function step(bell) {
    if (!council) return;
    const per = council.periodAt?.(bell);
    if (per && bell <= per.c0 + 2) {
      const factions = [...new Set(roster.ai.map(a => a.faction))].sort((a, b) => a - b);
      for (const f of factions) {
        try { await tryOpen(f, per.k, per.c0, bell); } catch (e) { bump('council_open_errors'); stats.last_error = String(e?.message ?? e).slice(0, 300); onError(e); }
      }
    }
    // windows of the periods that are open: motions [c0, c0+3), ballots [c0+3, c0+6)
    for (const f of new Set(roster.ai.map(a => a.faction))) {
      const P = council.latest?.(f);
      if (!P || P.outcome) continue;
      if (bell >= P.c0 && bell < P.c0 + 3) await askMembers(f, P.period, 'motion', P.c0 + 3, bell);
      else if (bell >= P.c0 + 3 && bell < P.c0 + 6) await askMembers(f, P.period, 'ballot', P.c0 + 6, bell);
    }
  }

  return {
    councilCandidates, tryOpen, step, deadlineOf,
    hintOf: (f, k, option) => hints.get(`${f}|${k}`)?.[option] ?? null,
    attempts: () => [...attempts].map(([id, v]) => ({ id, ...v })),
  };
}
