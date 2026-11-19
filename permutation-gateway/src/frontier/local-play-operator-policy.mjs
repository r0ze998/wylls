// LOCAL PLAY, TEST-ONLY — operator AI residents (⑤ option A, owner decision 2026-11-18): the DECISION side, key-free.
//
// An operator resident is an ordinary participant of a local-play world: its own wallet, its own relay (the same
// local-play-relay-server.mjs a human's page talks to, pinned to that wallet as actor and payer), the same six
// page-signed commands (local-play-act.mjs: Join, PlaceHome, Harvest, Build, Train, Muster), the same public herald
// reads. Nothing here signs, sends, reads a key or calls a model: this module only decides, by a fixed rule, which of
// the six commands a resident asks for next, from what the public herald says about that resident.
//
// The rule (deterministic, offline, no paid API, no network model — the owner's ⑤ choice and ⑬'s no-charge rule):
//   1. no Citizen yet                 → Join its nation (fixed per resident index: OPERATOR_FACTIONS)
//   2. a Citizen, no village          → PlaceHome on the next untried heartland site of its nation (the runner's own
//                                       `ready-for-join` list; the program rechecks the site and refuses a taken one)
//   3. a village                      → the next command of a fixed rotation (OPERATOR_ROTATION); a command the program
//                                       refused waits OPERATOR_COOLDOWN decisions before it is asked for again
// and the budget (`createOperatorBudget`): ONE action per resident per bell (owner decision Q16-2, 2026-11-18 21:44:
// "one action per resident per turn; operator AI must not double-act"). The bell is the program's own:
// floor((chain unix seconds − Season.GENESIS_TS) / 600), the chain time from the herald's `/h/status` and GENESIS_TS from
// its `/h/season` (never the local clock). Besides that: at most `maxRefusals` refusals in a row (then the resident stops
// for good), at most one send per `minGapMs`, and — only when it is set — at most `maxActs` sends for the whole world.
// The relay of a resident may itself hold it to one action per bell (PR #62, `ResidentAlreadyActed`); this budget never
// asks for a second action in a bell, and an answer `ResidentAlreadyActed` uses up the bell here too (no retry in it).
// Nothing is retried blindly: a send whose outcome is unknown is followed by its signature; the next decision is made on
// a NEW herald read.
//
// (B12, loop-play2) The budget used to be 60 sends for the whole world, which two residents spent in about 20 turns of a
// ×10 demo, then logged "budget stopped" every 6 s for the rest of it. Now: one per bell, no world cap, so a resident
// keeps playing until the world ends — on a ×10 two-hour TEST world (≈120 bells) at most ≈120 actions per resident, on
// 1× (12 bells) at most 12.
// Never: a march, a conquest step, a caravan, a reveal, a vote, an invite, a privileged route, an operator read.
//
// (TEST-ONLY wide play, owner t379u 「広い版がんばれ」, 2026-11-19) In a wide-land world (`--wide`: the runner's opened
// wide provinces) the same rule spreads outward: the PlaceHome candidates are taken rim first (the runner lists the
// settled rim provinces beside the heartland ones); a village within reach of the wide land saves (Harvest only) until
// its stores cover the next settler cost, then files a WIDE CLAIM (flocalplay-wide.mjs, 0xD9) on the nearest opened
// wide province within `outpost_range`, site by site; at most OPERATOR_WIDE_CLAIMS claims, then the usual rotation.
// Still one action per bell; the world's runner settles the claims (itest wide_play).
// EXCEPT in a TEST-ONLY war world (`--operator-war operator-war-v1`, owner t359u): a resident whose memory says `war`
// also marches (the page's own Depart), aimed and sized by local-play-operator-war.mjs, one action per turn (Q16-2).
import { OPERATOR_WAR_MAX, WAR_COOLDOWN_BELLS, warStep, warHomeOrder } from './local-play-operator-war.mjs';

export const OPERATOR_RESIDENTS_MODE = 'operator-residents-v1';
export const OPERATOR_RESIDENTS_SCHEMA = 'frontier-local-play-operator-residents-v1';
/** At most this many operator residents per world (each takes one relay and one loopback port). */
export const OPERATOR_RESIDENTS_MAX = 4;
/** The nations residents 0..3 join: spread over the six, fixed (no randomness to explain). A war world (up to 12
 *  residents) continues with the two nations left, then the same six again: every nation has a resident from six on. */
export const OPERATOR_FACTIONS = Object.freeze([1, 4, 2, 5, 0, 3, 1, 4, 2, 5, 0, 3]);
/** What a resident with a village asks for, in this order, round and round. */
export const OPERATOR_ROTATION = Object.freeze([
  Object.freeze({ name: 'Harvest' }),
  Object.freeze({ name: 'Build', item: 0 }),
  Object.freeze({ name: 'Train', unit: 0, n: 100 }),
  Object.freeze({ name: 'Harvest' }),
  Object.freeze({ name: 'Build', item: 1 }),
  // (a host is at least 100 troops: permutation-rules host.rs MIN_HOST_TROOPS; the program refuses fewer, Kernel 15)
  Object.freeze({ name: 'Muster', unit: 0, troops: 100 }),
  Object.freeze({ name: 'Harvest' }),
  Object.freeze({ name: 'Build', item: 2 }),
  Object.freeze({ name: 'Train', unit: 0, n: 100 }),
]);
export const OPERATOR_COOLDOWN = 3;
/** The pace: `cadenceMs` between rounds; `maxActs` null = no cap for the whole world. (One action per bell is fixed: Q16-2.) */
export const OPERATOR_DEFAULTS = Object.freeze({ cadenceMs: 6000, maxActs: null, maxRefusals: 12, minGapMs: 4000 });
/** Actions per resident per bell: one, by owner decision Q16-2 (not a setting). */
export const OPERATOR_ACTIONS_PER_BELL = 1;
/** Seconds per bell (permutation-rules travel.rs BELL_SECS; web clock.mjs BELL_SECS). */
export const BELL_SECS = 600;
/**
 * The bell chain time `secs` (unix seconds) is in, for a Season that began at `genesisTs` — the program's own count
 * (web clock.mjs `bellAt`; PR #62 resident-turns.mjs `bellAt`) — or null when either is unknown or it is before genesis.
 */
export function bellOf(genesisTs, secs) {
  if (!Number.isSafeInteger(genesisTs) || genesisTs < 0 || !Number.isSafeInteger(secs) || secs <= 0 || secs < genesisTs) return null;
  return Math.floor((secs - genesisTs) / BELL_SECS);
}

/** The Join's session expiry: the page's own (controller.mjs: chain now + 30 days − 600 s). */
export const SESSION_SECONDS = 30 * 86_400 - 600;

/**
 * `--operator-nations <csv>` (TEST-ONLY, opt-in; the six-nation recording, scripts/demo/sixnation): up to this many
 * residents, one per named nation. Off unless given; `--operator-residents` and its fixed OPERATOR_FACTIONS are unchanged.
 */
export const OPERATOR_NATIONS_MAX = 6;

/**
 * `--operator-nations <csv>` → the nations residents 0..n-1 join, in order (distinct whole numbers 0-5, 1 to 6 of
 * them, comma-separated, nothing else), or null. Who joins which nation is the operator's choice; the rule is not.
 */
export function parseOperatorNations(raw) {
  if (typeof raw !== 'string' || !/^[0-5](,[0-5]){0,5}$/.test(raw)) return null;
  const nations = raw.split(',').map(Number);
  return new Set(nations).size === nations.length ? Object.freeze(nations) : null;
}

/** `--operator-residents <1-4>` → the count, or null when it is not exactly a whole number in range. */
export function parseOperatorResidents(raw, { war = false } = {}) {
  if (typeof raw !== 'string' || !/^([1-9]|1[0-2])$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= (war ? OPERATOR_WAR_MAX : OPERATOR_RESIDENTS_MAX) ? n : null;
}

/** The ports a world slot keeps for operator relays: OPERATOR_RESIDENTS_MAX, or the count when a war world has more. */
export const operatorSlotPorts = n => Math.max(OPERATOR_RESIDENTS_MAX, Number.isInteger(n) ? n : 0);

/**
 * The loopback ports of a world's operator relays: after the launcher's two worlds (5 ports each) come
 * OPERATOR_RESIDENTS_MAX ports per world slot. `worldPort` + 10 + slot × 4 + i (`width` 6 with `--operator-nations`).
 */
export function operatorRelayPorts(worldPort, slot, n, worldLimit = 2, width = OPERATOR_RESIDENTS_MAX) {
  const base = worldPort + worldLimit * 5 + slot * Math.max(width, operatorSlotPorts(n));   // (a war world's 5-12 residents keep that many ports per slot)
  return Array.from({ length: n }, (_, i) => base + i);
}

/** The runner's `ready-for-join` line → `[{p, q, nation}]` (whole numbers), or null when there is none or it is malformed. */
export function homesOf(lines) {
  const line = (lines ?? []).find(l => l && l.natural_step === 'ready-for-join' && Array.isArray(l.home_provinces));
  if (!line) return null;
  const out = [];
  for (const h of line.home_provinces) {
    const p = Number(h?.p), q = Number(h?.q);
    if (!Number.isSafeInteger(p) || !Number.isSafeInteger(q) || !Number.isInteger(h?.nation) || h.nation < 0 || h.nation > 5) return null;
    out.push(Object.freeze({ p, q, nation: h.nation }));
  }
  return out.length ? Object.freeze(out) : null;
}

const ring = (p, q) => Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q));
/** Every heartland site of `faction`, nearest ring first (`outward`: farthest first, the wide world's rim), then by place: `[{p, q, site}]` (sites 0-11; the program decides which exist). */
export function homeCandidates(homes, faction, { outward = false } = {}) {
  return (homes ?? []).filter(h => h.nation === faction)
    .sort((a, b) => (outward ? -1 : 1) * (ring(a.p, a.q) - ring(b.p, b.q)) || a.p - b.p || a.q - b.q)
    .flatMap(h => Array.from({ length: 12 }, (_, site) => Object.freeze({ p: h.p, q: h.q, site })));
}

/**
 * What the public herald says about one resident (`GET /h/me/{wallet}`), reduced to what the rule reads, with the
 * page's own decoder (`decode(kind, bytes)` → fields). → `{joined, faction, holding: {p, q, site, tile?} | null}`.
 * Anything unreadable is `null` (unknown), never "not joined".
 */
export function residentView(me, decode) {
  if (!me || typeof me !== 'object' || me.v !== 1) return null;
  if (me.citizen === null) return Object.freeze({ joined: false, faction: null, holding: null });
  let citizen;
  try { citizen = decode('Citizen', Buffer.from(String(me.citizen?.bytes_b64 ?? ''), 'base64')); } catch { return null; }
  const faction = Number(citizen?.faction);
  if (!Number.isInteger(faction)) return null;
  let holding = null, wide = 0;
  for (const row of Array.isArray(me.holdings) ? me.holdings : []) {
    try {
      const h = decode('Holding', Buffer.from(String(row?.bytes_b64 ?? ''), 'base64'));
      const p = Number(h.p), q = Number(h.q), site = Number(h.site);
      if (![p, q, site].every(Number.isSafeInteger)) continue;
      // (a wide village, ring 129+: counted, never the village the rotation works — the six are legacy commands)
      if (ring(p, q) > 128) { wide += 1; continue; }
      if (holding) continue;
      const tile = Number(h.tile);
      // (the decoded record rides along, not enumerable: the wide rule reads its stores; the view itself is as it was)
      holding = Object.freeze(Object.defineProperty({ p, q, site, ...(Number.isInteger(tile) && tile >= 0 && tile <= 60 ? { tile } : {}) }, 'decoded', { value: h, enumerable: false }));
    } catch { /* another kind of record: not this rule's */ }
  }
  return Object.freeze({ joined: true, faction, holding, wide });
}

/** At most this many wide claims per resident (slots 2 and 3). */
export const OPERATOR_WIDE_CLAIMS = 2;
/** Decisions to wait after a claim landed, for the world's runner to settle its ticket (one ticket at a time). */
export const OPERATOR_CLAIM_SETTLE_WAIT = 4;

/** A resident's memory between decisions: what it tried and what was refused. Plain data; no key, no address of anyone else. */
export function createResidentMemory(index, faction, { war = false } = {}) {
  // (no nation named: the fixed OPERATOR_FACTIONS, residents 0-3; a named nation (`--operator-nations`): 0-5, residents 0-5)
  const named = faction !== undefined;
  if (!Number.isInteger(index) || index < 0 || index >= (war ? OPERATOR_WAR_MAX : named ? OPERATOR_NATIONS_MAX : OPERATOR_RESIDENTS_MAX)) throw new Error('resident index');
  if (named && (!Number.isInteger(faction) || faction < 0 || faction > 5)) throw new Error('resident nation');
  return { index, faction: named ? faction : OPERATOR_FACTIONS[index], step: 0, decisions: 0, triedHomes: [], cooldown: {}, ...(war ? { war: true, lastBell: null } : {}) };
}

/**
 * A war resident's heartland sites: its nation's sites, the OUTERMOST ring first (warHomeOrder), and the n-th resident
 * of a nation (index ÷ 6) starting at the n-th province of that order — two residents of one nation in two provinces.
 */
export function warHomeCandidates(homes, faction, index) {
  const all = warHomeOrder(homeCandidates(homes, faction));
  const provinces = [...new Set(all.map(h => `${h.p},${h.q}`))];
  if (!provinces.length) return [];
  const k = Math.floor(index / 6) % provinces.length;
  const first = provinces.slice(k).concat(provinces.slice(0, k));
  return first.flatMap(key => all.filter(h => `${h.p},${h.q}` === key));
}

// (a rotation entry carries `item`; a decision carries it in `fields`)
const key = a => (a.name === 'Build' ? `Build:${a.item ?? a.fields?.item}` : a.name);

/**
 * The next command for one resident: `{name, v, fields, why}` (the page's own order shape, for flocalplay-act.mjs
 * `submitLocalAct`), or `{wait: true, why}`. `view` from `residentView`; `homes` from `homesOf`; `nowSecs` the clock
 * the Join's expiry is counted from. Pure: the memory is changed only by `noteOutcome`.
 */
export function decideNext(memory, view, { homes, nowSecs, war = null, wide = null }) {
  if (view === null || view === undefined) return { wait: true, why: 'the herald did not give a readable answer' };
  if (!view.joined) {
    if (!Number.isSafeInteger(nowSecs) || nowSecs <= 0) return { wait: true, why: 'no clock for the Join expiry' };
    const f = memory.faction;
    return { name: 'Join', v: { faction: f }, fields: { faction: f, session_expiry: BigInt(nowSecs + SESSION_SECONDS) }, why: 'not a citizen yet: join the nation fixed for this resident' };
  }
  if (!view.holding) {
    const tried = new Set(memory.triedHomes);
    // (wide play: a filed rim request is settled by the world's runner at its turn's end: wait for it)
    if ((memory.ticketUntil ?? 0) > memory.decisions) return { wait: true, why: 'a rim village request is waiting for its turn to settle' };
    const next = (memory.war ? warHomeCandidates(homes, view.faction, memory.index) : homeCandidates(homes, view.faction, { outward: !!wide })).find(h => !tried.has(`${h.p},${h.q},${h.site}`));
    if (!next) return { wait: true, why: 'no untried heartland site of this nation' };
    // (wide play: past the heartland — a settled rim province — a first village is a one-site request, FileTicket: the
    //  program's PlaceHome names no province past the Season's base r_max)
    if (wide && ring(next.p, next.q) > 6) return { name: 'FileTicket', v: { sites: [next] }, fields: { sites: [next] }, why: 'a citizen with no village: request a rim site of its nation, beside the wide land' };
    return { name: 'PlaceHome', v: { holding: next, faction: view.faction }, fields: { p: next.p, q: next.q, site: next.site }, why: 'a citizen with no village: the next heartland site of its nation' };
  }
  const h = { p: view.holding.p, q: view.holding.q, site: view.holding.site };
  // (a war resident: the war step first — defend, attack, muster, train — then the base rotation for the economy)
  if (memory.war && war) {
    // (a war resident's refusals cool down for WAR_COOLDOWN_BELLS turns: it may act once per turn, but looks every few seconds)
    const cool = name => (memory.cooldown[`war:${name}`] ?? -1) >= (war.nowBell ?? Infinity);
    const s = warStep({ ...war, refused: { Train: cool('Train'), Muster: cool('Muster') }, march: cool('Depart') ? null : war.march });
    const bell = war.nowBell ?? null;
    if (s?.wait) return { wait: true, why: s.why };
    if (s?.name === 'Depart') return { name: 'Depart', kind: s.kind, row: s.row, war: true, bell, why: `${s.kind}: the keep at ${s.row.p},${s.row.q} (garrison ${s.row.troops ?? '?'}, host ${s.row.origin?.troops ?? '?'})` };
    if (s?.name === 'Muster' && view.holding.tile !== undefined) return { name: 'Muster', v: { holding: h }, fields: { unit: 0, troops: s.troops, tile: view.holding.tile }, war: true, bell, why: `a host of the reserve's ${s.troops} troops` };
    if (s?.name === 'Train') return { name: 'Train', v: { holding: h }, fields: { unit: 0, n: s.n }, war: true, bell, why: `troops for the next host (reserve ${war.reserve ?? 0})` };
  }
  // (TEST-ONLY wide play: save, then claim the nearest wide land within reach — header)
  if (wide && Array.isArray(wide.targets) && wide.targets.length && (memory.claims ?? 0) < OPERATOR_WIDE_CLAIMS) {
    const tried = new Set(memory.triedClaims ?? []);
    // (a target's FREE sites when the herald's capture names them — flocalplay-wide.mjs freeWideSites; else every site)
    const sitesOf = t => (Array.isArray(t.free) ? t.free : Array.from({ length: 12 }, (_, site) => site));
    const next = wide.targets.flatMap(t => sitesOf(t).map(site => ({ t: { p: t.p, q: t.q }, site }))).find(c => !tried.has(`${c.t.p},${c.t.q},${c.site}`));
    if (next) {
      const waiting = (memory.claimWaitUntil ?? 0) > memory.decisions || (memory.cooldown.WideClaim ?? 0) > memory.decisions;
      if (wide.canClaim && !waiting) {
        const slot = 2 + Math.min(1, Math.max(Number.isInteger(view.wide) ? view.wide : 0, memory.claims ?? 0));
        return { name: 'WideClaim', v: { holding: h, target: next.t }, fields: { site: next.site, slot }, why: `stores cover the settler cost: claim wide land at ${next.t.p},${next.t.q} site ${next.site} (slot ${slot})` };
      }
      return { name: 'Harvest', v: { holding: h }, fields: {}, why: waiting ? 'a wide claim is settling: harvest meanwhile' : 'saving for a wide claim (the settler cost): harvest' };
    }
  }
  for (let k = 0; k < OPERATOR_ROTATION.length; k++) {
    const a = OPERATOR_ROTATION[(memory.step + k) % OPERATOR_ROTATION.length];
    // (a war resident's troops and hosts are the war step's: its rotation is the economy only — Harvest and Build)
    if (memory.war && (a.name === 'Train' || a.name === 'Muster')) continue;
    if ((memory.cooldown[key(a)] ?? 0) > memory.decisions) continue;
    if (a.name === 'Muster' && view.holding.tile === undefined) continue;   // (no tile known: never guessed)
    const fields = a.name === 'Harvest' ? {} : a.name === 'Build' ? { item: a.item } : a.name === 'Train' ? { unit: a.unit, n: a.n } : { unit: a.unit, troops: a.troops, tile: view.holding.tile };
    return { name: a.name, v: { holding: h, ...(a.name === 'Build' ? { item: a.item } : {}) }, fields, why: `the village's rotation, step ${(memory.step + k) % OPERATOR_ROTATION.length}`, rotationStep: (memory.step + k) % OPERATOR_ROTATION.length };
  }
  return { wait: true, why: 'every command of the rotation is cooling down after a refusal' };
}

/**
 * After a decision was sent (or refused): `outcome` one of 'landed' | 'failed' | 'refused' | 'unknown'. A refused or
 * failed PlaceHome marks its site tried; a refused or failed rotation command cools down; the rotation moves on.
 */
export function noteOutcome(memory, decision, outcome) {
  memory.decisions += 1;
  if (decision?.wait) return memory;
  const bad = outcome === 'refused' || outcome === 'failed';
  if (decision.name === 'PlaceHome' && (bad || outcome === 'unknown')) memory.triedHomes.push(`${decision.fields.p},${decision.fields.q},${decision.fields.site}`);
  if (decision.name === 'FileTicket') {
    const k = `${decision.fields.sites[0].p},${decision.fields.sites[0].q},${decision.fields.sites[0].site}`;
    // (a filed site is not filed again either way: a request that lost its site — taken — moves on to the next)
    if (outcome === 'landed') memory.ticketUntil = memory.decisions + OPERATOR_CLAIM_SETTLE_WAIT * 2;
    memory.triedHomes.push(k);
  }
  if (decision.name === 'WideClaim') {
    if (outcome === 'landed') { memory.claims = (memory.claims ?? 0) + 1; memory.claimWaitUntil = memory.decisions + OPERATOR_CLAIM_SETTLE_WAIT; }
    // (a refused site is not asked again; the claim itself cools down — a site taken, a ticket still open, stores short)
    if (bad || outcome === 'unknown') { (memory.triedClaims ??= []).push(`${decision.v.target.p},${decision.v.target.q},${decision.fields.site}`); memory.cooldown.WideClaim = memory.decisions + OPERATOR_COOLDOWN; }
  }
  if (decision.war && (bad || (decision.name === 'Depart' && outcome === 'unknown'))) memory.cooldown[`war:${decision.name}`] = (Number.isSafeInteger(decision.bell) ? decision.bell : 0) + WAR_COOLDOWN_BELLS;
  if (Number.isInteger(decision.rotationStep)) {
    memory.step = decision.rotationStep + 1;
    if (bad) memory.cooldown[key(decision)] = memory.decisions + OPERATOR_COOLDOWN;
  }
  return memory;
}

/**
 * The resident's budget: `{allow(now, bell) → {ok, why?, later?, stopped?}, spent(outcome, now, bell), state()}`. `bell`
 * is `bellOf(…)`; with no known bell nothing is allowed (later). ONE ask per bell (Q16-2): every ask uses the bell up — a
 * refusal before the send too, and `outcome = 'held'` (its relay said the resident already acted in this bell: PR #62
 * `ResidentAlreadyActed`), which spends nothing else. A NEW bell gives the one ask again. A resident with `maxRefusals`
 * refusals in a row, or (when `maxActs` is a number) with `maxActs` sends spent, stops for good: `allow` then says
 * `{ok: false, why, stopped: true}`; it is never refilled while the world runs (it never stops the world).
 */
export function createOperatorBudget({ maxActs = OPERATOR_DEFAULTS.maxActs, maxRefusals = OPERATOR_DEFAULTS.maxRefusals, minGapMs = OPERATOR_DEFAULTS.minGapMs, ...rest } = {}) {
  if (Object.keys(rest).length) throw new Error(`operator budget: ${Object.keys(rest).join(', ')} is not a setting (one action per bell, Q16-2)`);
  if (![maxRefusals, minGapMs].every(n => Number.isSafeInteger(n) && n >= 0) || !(maxActs === null || (Number.isSafeInteger(maxActs) && maxActs >= 0))) throw new Error('operator budget');
  let sent = 0, refusalsInRow = 0, last = -Infinity, stopped = null, bellAt = null, inBell = 0;
  const stop = why => { stopped = why; return { ok: false, why, stopped: true }; };
  return Object.freeze({
    allow(now, bell) {
      if (stopped) return { ok: false, why: stopped, stopped: true };
      if (maxActs !== null && sent >= maxActs) return stop(`the budget of ${maxActs} sends is spent`);
      if (refusalsInRow >= maxRefusals) return stop(`${maxRefusals} refusals in a row`);
      if (!Number.isSafeInteger(bell)) return { ok: false, why: 'the bell is not known (chain clock or Season genesis unread)', later: true };
      if (bell === bellAt && inBell >= OPERATOR_ACTIONS_PER_BELL) return { ok: false, why: 'this bell\'s one action is taken: the next bell', later: true };
      if (now - last < minGapMs) return { ok: false, why: 'too soon after the last send', later: true };
      return { ok: true };
    },
    spent(outcome, now, bell) {
      if (bell !== bellAt) { bellAt = Number.isSafeInteger(bell) ? bell : null; inBell = 0; }
      inBell += 1;
      if (outcome === 'held') return;
      if (outcome !== 'refused') { sent += 1; last = now; }
      refusalsInRow = outcome === 'refused' || outcome === 'failed' ? refusalsInRow + 1 : 0;
    },
    state: () => ({ sent, refusalsInRow, bell: bellAt, inBell, stopped }),
  });
}
