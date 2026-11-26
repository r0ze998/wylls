// The world goals of the DEVNET world (world 3, preset S1_DEVNET_TERRITORY), judged OFF CHAIN with no money
// (pt-world-goals-devnet; owner r0ze 2026-11-26 15:48 JST: Q-PT-6 (c) — "planned, not judged yet" first, then an
// off-chain judgement, no money moved; Q-PT-7 (b) — the flag keeps are the NEUTRAL keeps and Free Cities of the wide
// land: capture one and hold it for 24 hours).
//
// A pure function of public chain bytes, as the herald already holds them: the captured wide Province accounts of
// `/h/world/wide/page` (frontier-abi world_index/land.rs WideProvince, 4,864 B: the v2 Province layout and a 128-byte
// trailer). No RPC, no key, nothing signed or sent. The judge in this file never reads a clock: every bell it uses is
// one the bytes carry, so two readers of the same captures get the same answer.
//
//   flags      every keep of a wide Province (ring ≥ 129; in world 3 every wide keep opens unowned —
//              rules::KeepHolderRule::NeutralTerritoryV1) and every genesis Free City site (site mirror state 5) of
//              one. A flag is known from the first capture that shows it.
//   held long  a KEEP held by nation n since `since_bell` s (the chain's own field: a capture at bell b writes
//              since = b + 1, permutation-rules keep.rs take) is held long once its Province is resolved through the
//              hold: resolved_next ≥ s + holdBells. A keep that was lost again before that never counts (its holder,
//              since and gen change with the capture). When the judge did not see the moment between two captures
//              (n held, then m took it), the chain still says it: m's capture names n (`last_taken_from`), bumps gen
//              by one and starts at m's since s₂ — so n held [s, s₂ − 1) and counts iff s₂ − 1 ≥ s + holdBells.
//              A FREE CITY captured (state 5 → a holding of nation n) has no "since" bell in the Province bytes; it
//              counts from the resolved bell of the first capture that shows it held by n (Q-PTWG-4).
//   achieve    the first nation to hold a flag long achieves THAT flag, at bell s + holdBells (firstOnly: a flag is
//              achieved once — Q-PTWG-2). No rounds, no end, no prize; the standings are counts per nation.
import { createHash } from 'node:crypto';

export const WIDE_FLAGS_KIND = 'world-goals';
export const WIDE_FLAGS_VERSION = 1;
export const WIDE_FLAGS_RULESET = 'wide-flags-v1';
export const NATIONS = 6;
/** 144 bells of 10 minutes = 24 hours (Q-PT-7 (b)). */
export const BELLS_PER_DAY = 144;
/**
 * The judge's PROVISIONAL rules (owner questions inbox/2026-11-26-1830-pt-world-goals-devnet-questions.md; the
 * recommended answers, per Grok 2026-11-26 17:02 "continue with the recommended defaults where nothing ships live").
 * Each later answer is a change of one value here:
 *   holdBells   Q-PT-7 (b) decided: 24 hours.
 *   firstOnly   Q-PTWG-2 (a): the first nation to hold a flag long takes it, once per flag. false = (b): every long
 *               hold counts again, also after a recapture by another nation.
 *   freeCities  Q-PTWG-1 (a) / Q-PTWG-5: Free City sites are flags beside the keeps. false = keeps only (Q-PTWG-5 (c)).
 * Not a value: Q-PTWG-3 (a) — counts only, no winner (nothing here computes one); Q-PTWG-4 — a Free City counts from
 * the first read that shows it held; Q-PTWG-7 (a) — holds count only through RESOLVED bells (`resolvedNext`).
 */
export const WIDE_FLAGS_DEFAULTS = Object.freeze({ holdBells: BELLS_PER_DAY, firstOnly: true, freeCities: true });
/** The first ring past the legacy disk (geometry R_MAX_HARD + 1). */
export const FIRST_WIDE_RING = 129;

/** frontier-abi v2 layout province / keep / site, and world_index/land.rs wide_province (the offsets this judge reads). */
export const WP = Object.freeze({
  SIZE: 4864, TRAILER: 4736, MAGIC: 'PSFXWPV1', SEASON_ID: 8, LAYOUT_VERSION: 16, RESOLVED_NEXT: 72, OPENED_BELL: 76,
  SITES: 250, SITE_COUNT: 262, SITE_MIRROR: 296, SITE_SIZE: 64, SITES_N: 12,
  KEEP: 4480, K_TILE: 0, K_HOLDER: 1, K_FLAGS: 5, K_TROOPS: 8, K_SINCE: 12, K_GEN: 24, K_LAST_FROM: 28,
  T_FAMILY: 0, T_STATUS: 2, T_READY: 3, T_WORLD: 4,
});
export const NO_TILE = 0xff;
export const NO_HOLDER = 0xff;
export const SITE_STATE_HOLDING = 1;
export const SITE_STATE_FREE_CITY = 5;

const isNation = f => Number.isInteger(f) && f >= 0 && f < NATIONS;
const hex = b => Buffer.from(b).toString('hex');
const sha256hex = b => createHash('sha256').update(b).digest('hex');
const DEC = /^(0|-?[1-9][0-9]{0,18})$/;

/**
 * The fields of one captured wide Province this judge needs → `{season, resolvedNext, openedBell, world, keep, sites}`.
 * Refuses (throws `Error(code)`) a record that is not a ready wide Province of `seasonId` (and of `world`, hex, when
 * given): wrong length, magic, layout or family version, status or readiness, season or world.
 */
export function readWideProvince(bytes, { seasonId, world = null } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  if (b.length !== WP.SIZE) fail('WideProvinceLength');
  if (Buffer.from(b.subarray(0, 8)).toString('latin1') !== WP.MAGIC) fail('WideProvinceMagic');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint16(WP.LAYOUT_VERSION, true) !== 3 || v.getUint16(WP.TRAILER + WP.T_FAMILY, true) !== 1) fail('WideProvinceVersion');
  if (b[WP.TRAILER + WP.T_STATUS] !== 1 || b[WP.TRAILER + WP.T_READY] !== 15) fail('WideProvinceNotReady');
  const season = v.getBigUint64(WP.SEASON_ID, true).toString();
  if (seasonId !== undefined && seasonId !== null && season !== String(seasonId)) fail('WideProvinceSeason');
  const w = hex(b.subarray(WP.TRAILER + WP.T_WORLD, WP.TRAILER + WP.T_WORLD + 32));
  if (world && w !== world) fail('WideProvinceWorld');
  const k = WP.KEEP;
  const keep = b[k + WP.K_TILE] === NO_TILE ? null : {
    tile: b[k + WP.K_TILE], holder: b[k + WP.K_HOLDER], flags: b[k + WP.K_FLAGS], troops: v.getUint32(k + WP.K_TROOPS, true),
    since: v.getUint32(k + WP.K_SINCE, true), gen: v.getUint32(k + WP.K_GEN, true), lastFrom: b[k + WP.K_LAST_FROM],
  };
  const count = Math.min(b[WP.SITE_COUNT], WP.SITES_N);
  const sites = [];
  for (let i = 0; i < count; i++) {
    const o = WP.SITE_MIRROR + i * WP.SITE_SIZE;
    sites.push({ site: i, tile: b[WP.SITES + i], state: b[o], faction: b[o + 1], gen: b[o + 4] });
  }
  return { season, world: w, resolvedNext: v.getUint32(WP.RESOLVED_NEXT, true), openedBell: v.getUint32(WP.OPENED_BELL, true), keep, sites };
}

/** Decimal-string coordinates in a stable order (BigInt compare). */
const coordCmp = (a, b) => { const ap = BigInt(a.p), bp = BigInt(b.p); if (ap !== bp) return ap < bp ? -1 : 1; const aq = BigInt(a.q), bq = BigInt(b.q); return aq === bq ? 0 : aq < bq ? -1 : 1; };

/**
 * One reading of the herald (`entries` of every `/h/world/wide/page`, as sent) → an observation: `{provinces: [{p, q,
 * slot, sha, resolvedNext, keep, sites}]}` — only wide (ring ≥ 129) open Provinces with a capture, decoded from their
 * bytes; sorted by (p, q). An entry whose bytes do not read as a ready wide Province of the season is left out and
 * counted (`refused`). Pure.
 */
export function observationOf(entries, { seasonId, world = null } = {}) {
  const provinces = [];
  let refused = 0;
  for (const e of entries ?? []) {
    const cap = e?.wide?.capture;
    if (!e || e.state !== 'open' || !cap || typeof cap.bytes_b64 !== 'string') continue;
    if (!DEC.test(String(e.p)) || !DEC.test(String(e.q)) || !(Number(e.ring) >= FIRST_WIDE_RING)) continue;
    let r;
    try { r = readWideProvince(Buffer.from(cap.bytes_b64, 'base64'), { seasonId, world }); } catch { refused++; continue; }
    const fc = r.sites.filter(s => s.state === SITE_STATE_FREE_CITY || s.state === SITE_STATE_HOLDING).map(s => ({ site: s.site, tile: s.tile, state: s.state, faction: s.faction, gen: s.gen }));
    provinces.push({ p: String(e.p), q: String(e.q), slot: String(cap.slot ?? ''), sha: sha256hex(Buffer.from(cap.bytes_b64, 'base64')), resolvedNext: r.resolvedNext, keep: r.keep, sites: fc });
  }
  provinces.sort(coordCmp);
  return { provinces, refused };
}

const keyKeep = (p, q) => `k:${p},${q}`;
const keyCity = (p, q, site) => `c:${p},${q}:${site}`;

/** A fresh judge state. */
export function initialState(rules = WIDE_FLAGS_DEFAULTS) {
  return { v: 1, ruleset: WIDE_FLAGS_RULESET, holdBells: rules.holdBells, firstOnly: rules.firstOnly, freeCities: rules.freeCities !== false, observations: 0, inputsHash: '0'.repeat(64), bell: null, flags: {}, achievements: [] };
}

/** The canonical text of an observation (what the inputs hash chains over): only the fields the judge reads. */
export const canonicalObservation = obs => JSON.stringify(obs.provinces.map(x => [x.p, x.q, x.slot, x.sha, x.resolvedNext,
  x.keep ? [x.keep.tile, x.keep.holder, x.keep.since, x.keep.gen, x.keep.lastFrom] : null, x.sites.map(s => [s.site, s.state, s.faction, s.gen])]));

/**
 * One step of the judge: state `st` and an observation → `{state, events}` (`events`: the achievements this step
 * made). Pure; the input state is not changed. Deterministic: provinces in (p, q) order, sites in index order,
 * achievements sorted by (bell, flag key).
 */
export function stepFlags(st, obs) {
  const s = structuredClone(st ?? initialState());
  const hold = s.holdBells;
  const made = [];
  const achieve = (f, nation, bell) => {
    if (f.achieved && s.firstOnly) return;
    // (one hold = one (nation, bell): the bell is since + holdBells and since changes with every capture. `last` is the
    //  latest hold achieved — holds are achieved in bell order — so a hold read again on the next read is not counted again)
    const last = f.last ?? f.achieved;
    if (last && last.nation === nation && last.bell === bell) return;
    if (last && bell < last.bell) return;
    const a = { key: f.key, kind: f.kind, p: f.p, q: f.q, ...(f.kind === 'freeCity' ? { site: f.site } : {}), nation, bell };
    if (!f.achieved) f.achieved = { nation, bell };
    f.last = { nation, bell };
    made.push(a);
  };
  for (const x of obs.provinces) {
    const resolved = x.resolvedNext; // the bytes speak for bells < resolvedNext
    s.bell = s.bell === null ? Math.max(0, resolved - 1) : Math.max(s.bell, resolved - 1);
    if (x.keep) {
      const key = keyKeep(x.p, x.q);
      let f = s.flags[key];
      if (!f) f = s.flags[key] = { key, kind: 'keep', p: x.p, q: x.q, tile: x.keep.tile, firstSeen: resolved, holder: null, since: null, gen: null, resolved: null, achieved: null };
      if (f.resolved !== null && resolved < f.resolved) { /* an older capture than one already read: ignored */ } else {
        const k = x.keep, prev = { holder: f.holder, since: f.since, gen: f.gen };
        // (a capture the judge did not see happen: the new holder took it from the one we saw, one gen later)
        if (isNation(prev.holder) && k.gen === prev.gen + 1 && k.lastFrom === prev.holder && k.since - 1 >= prev.since + hold) achieve(f, prev.holder, prev.since + hold);
        f.holder = isNation(k.holder) ? k.holder : null;
        f.since = f.holder === null ? null : k.since;
        f.gen = k.gen;
        f.tile = k.tile;
        f.resolved = resolved;
        if (f.holder !== null && resolved >= f.since + hold) achieve(f, f.holder, f.since + hold);
      }
    }
    for (const c of s.freeCities === false ? [] : x.sites) {
      const key = keyCity(x.p, x.q, c.site);
      let f = s.flags[key];
      if (!f) {
        // (a Free City is known from a capture that shows it as one; a holding the judge never saw as a Free City is not a flag)
        if (c.state !== SITE_STATE_FREE_CITY) continue;
        f = s.flags[key] = { key, kind: 'freeCity', p: x.p, q: x.q, site: c.site, tile: c.tile, firstSeen: resolved, holder: null, since: null, gen: null, resolved: null, achieved: null };
      }
      if (f.resolved !== null && resolved < f.resolved) continue;
      const held = c.state === SITE_STATE_HOLDING && isNation(c.faction) ? c.faction : null;
      if (held === null) { f.holder = null; f.since = null; f.gen = c.gen; }
      else if (f.holder !== held || f.gen !== c.gen) { f.holder = held; f.since = resolved; f.gen = c.gen; }
      f.resolved = resolved;
      if (f.holder !== null && resolved >= f.since + hold) achieve(f, f.holder, f.since + hold);
    }
  }
  made.sort((a, b) => a.bell - b.bell || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  s.achievements.push(...made);
  s.observations += 1;
  s.inputsHash = createHash('sha256').update(s.inputsHash).update(canonicalObservation(obs)).digest('hex');
  return { state: s, events: made };
}

/** Replay an archive (observations in order) from scratch → the final state. */
export function replay(observations, rules = WIDE_FLAGS_DEFAULTS) {
  let st = initialState(rules);
  for (const o of observations) st = stepFlags(st, o).state;
  return st;
}

/** Per nation: `{nation, achieved, holding, holdingLong}` (holding: flags it holds now that are not achieved by anyone). */
export function standingsOf(st) {
  const out = Array.from({ length: NATIONS }, (_, n) => ({ nation: n, achieved: 0, holding: 0 }));
  for (const a of st.achievements) out[a.nation].achieved += 1;
  for (const f of Object.values(st.flags)) if (isNation(f.holder) && !f.achieved) out[f.holder].holding += 1;
  return out;
}

/**
 * The published answer (what `GET /f/goals/state` serves): the rules, the flags with their holders (the page applies
 * the fog of war — the herald's `/h/world/wide/page` already publishes every captured wide keep's holder), the
 * achievements, the standings and the judge's position in its inputs. No money, no chain effect.
 */
export function answerOf(st, { seasonId, programId = null, seasonAddress = null, judgedAt = null } = {}) {
  const flags = Object.values(st.flags).sort((a, b) => coordCmp(a, b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(f => ({
    kind: f.kind, p: f.p, q: f.q, ...(f.kind === 'freeCity' ? { site: f.site } : {}), tile: f.tile, holder: f.holder, since: f.since,
    longAt: f.holder === null ? null : f.since + st.holdBells, resolved: f.resolved, achieved: f.achieved,
  }));
  return {
    ok: true, v: WIDE_FLAGS_VERSION, kind: WIDE_FLAGS_KIND, ruleset: WIDE_FLAGS_RULESET,
    effects: { money: 'none', chain: 'none' },
    season: { seasonId: String(seasonId), ...(programId ? { programId } : {}), ...(seasonAddress ? { seasonAddress } : {}) },
    bell: st.bell,
    goals: [{ id: 'flag-keeps', kind: 'hegemony', live: true }],
    wideFlags: { holdBells: st.holdBells, firstOnly: st.firstOnly, flags, standings: standingsOf(st) },
    achievements: st.achievements.map(a => ({ kind: a.kind, p: a.p, q: a.q, ...(a.kind === 'freeCity' ? { site: a.site } : {}), nation: a.nation, bell: a.bell })),
    judge: { observations: st.observations, inputsHash: st.inputsHash, ...(judgedAt ? { judgedAt } : {}) },
  };
}
