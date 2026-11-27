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
//   3. a village                      → first ONE mine (Build item 3; owner 2026-11-25 17:58 Q-AOR-1,
//                                       local-play-operator-mine.mjs), then the next command of a fixed rotation
//                                       (OPERATOR_ROTATION); a command the program
//                                       refused waits OPERATOR_COOLDOWN decisions before it is asked for again;
//                                       in a wide world, until its next wide-land village is built, no Train at or
//                                       above one host (300 troops): the food and gold are saved for the village
//                                       (owner 2026-11-25 20:03 Q-AEM-1 (b), local-play-operator-reserve.mjs)
//                                       and no new tile but the one that village stands on (owner 22:28 Q-VPR241-1 (b))
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
// its stores cover the next settler cost, then files a WIDE CLAIM (flocalplay-wide.mjs, 0xD9) on the best wide province
// within reach — `outpost_range` from home or from the nation's land (expansion-gameplay-1,
// local-play-operator-expansion.mjs: the frontier pushed outward along the resident's heading), site by site; at most OPERATOR_WIDE_CLAIMS claims, then the usual rotation.
// Still one action per bell; the world's runner settles the claims (itest wide_play).
// EXCEPT in a TEST-ONLY war world (`--operator-war operator-war-v1`, owner t359u): a resident whose memory says `war`
// also marches (the page's own Depart), aimed and sized by local-play-operator-war.mjs, one action per turn (Q16-2).
import { OPERATOR_WAR_MAX, WAR_COOLDOWN_BELLS, MUSTER_MIN, warStep, warHomeOrder } from './local-play-operator-war.mjs';
import { oreReserve, tilePays, coversTrain, oreTurn, savingCapsTrain } from './local-play-operator-reserve.mjs';
export { OPERATOR_ORE_RESERVE, OPERATOR_VILLAGE_SAVING } from './local-play-operator-reserve.mjs';
import { OPERATOR_EARLY_MINE, minesOf, earlyMineDue, noteEarlyMine } from './local-play-operator-mine.mjs';
export { OPERATOR_EARLY_MINE } from './local-play-operator-mine.mjs';
import { nearerOwnVillage, tileUpkeepV1 } from '../../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { distance } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';

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

/**
 * (fix-loop16, owner 2026-11-25 12:04 Q-LP16-2 (b)) `--near` (launcher `--operator-near operator-near-v1`, play-local
 * `--ai-near`), TEST-ONLY, wide worlds: resident 0 joins no nation until the PLAYER has a first village, then takes the
 * village site of ANOTHER nation that is nearest to it — so tiles of another nation come to stand within an
 * expedition's reach of the player's start (loop-play16: the AI-free nations' rim sites neighbour only each other, and
 * no other nation's tile was ever within the road's 4 provinces). No rule changes: the choice of a nation and a site.
 */
export const OPERATOR_NEAR_MODE = 'operator-near-v1';
const hexDistance = (a, b) => { const dp = a.p - b.p, dq = a.q - b.q; return Math.max(Math.abs(dp), Math.abs(dq), Math.abs(dp + dq)); };
/**
 * The near resident's choice (pure): among `homes` (`[{p, q, nation}]`, homesOf) of every nation but the player's
 * (`playerFaction`), the province nearest to the player's village `village` `{p, q}` — ties: the lower nation, then p, q.
 * → `{nation, p, q, distance}`, or null (no village yet, or no home of another nation).
 */
export function nearChoice(homes, village, playerFaction) {
  const v = village && Number.isSafeInteger(Number(village.p)) && Number.isSafeInteger(Number(village.q)) ? { p: Number(village.p), q: Number(village.q) } : null;
  if (!v || !Number.isInteger(playerFaction)) return null;
  const best = (homes ?? []).filter(h => h.nation !== playerFaction).map(h => ({ nation: h.nation, p: h.p, q: h.q, distance: hexDistance(h, v) }))
    .sort((a, b) => a.distance - b.distance || a.nation - b.nation || a.p - b.p || a.q - b.q)[0];
  return best ? Object.freeze(best) : null;
}
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

/**
 * (owner-answers-logic, owner 2026-11-26 10:52 Q-LP19-1 (a); no rule change) Whether a NATION-REACH village target `t`
 * is too dear for this resident's land: the tile of its site would add more upkeep per hour than the village's food
 * surplus. loop-play19: a target reached through a nation-mate's land 252 provinces from the resident's own villages —
 * the tile's upkeep distance counts from the claimer's NEAREST own village (TQ-2), so that one tile made the land cost
 * 137.79 food/h against 40 made; unpaid 24 turns, then the tile was let go.
 *   t        a claim target (`{p, q, reach?, territory?}`); only one with a `reach` witness (the nation's land) and the
 *            territory facts (a territory world) is ever too dear — a target within reach of home is near by the reach
 *            rule itself, and outside a territory world there is no upkeep
 *   home     the first home `{p, q}`; `villages` the resident's own wide villages (memory.wideVillages)
 *   ownTiles the resident's own tiles: a province where it owns a tile already is not judged (its upkeep is paid)
 *   land     `{foodMilliPerHour, upkeepMilliPerHour}` — the first home's food per hour and the land's upkeep now (the
 *            resident's territory summary), both milli-food; not known → nothing is judged too dear
 * → null (not too dear) or `{dist, addMilli, surplusMilli}`.
 */
export function landTooDear(t, { home, villages = [], ownTiles = [], land = null } = {}) {
  if (!t || !t.reach || !t.territory || !land || !Number.isFinite(land.foodMilliPerHour) || !Number.isFinite(land.upkeepMilliPerHour)) return null;
  if ((ownTiles ?? []).some(o => String(o.p) === String(t.p) && String(o.q) === String(t.q))) return null;
  let dist;
  try { const v = nearerOwnVillage(home, t, villages); dist = distance(v ?? home, t); } catch { return null; }
  if (!Number.isFinite(dist)) return null;
  const addMilli = tileUpkeepV1(dist), surplusMilli = land.foodMilliPerHour - land.upkeepMilliPerHour;
  return addMilli > surplusMilli ? { dist, addMilli, surplusMilli } : null;
}

/** How many decisions a tile the resident claimed is kept in its memory before the herald's territory read may drop it
 *  (the herald captures a landed claim a few seconds later; a round is OPERATOR_DEFAULTS.cadenceMs). */
export const OWN_TILE_READ_GRACE = 10;
/**
 * (owner-answers-logic, loop-play19 side fact of Q-LP19-1) The resident's memory of its own tiles after the herald's
 * territory read: a tile the read shows as not its own — let go for unpaid upkeep, farthest first — leaves
 * `memory.ownTiles`, so its OPERATOR_TILES_MAX count, its claim price guess and its next site choice are right again.
 * `records`: heraldTerritoryRecords (Map "p,q" → {owners}; a province absent has no owned tile at all), `ownTag` its
 * Citizen tag. A tile noted in the last OWN_TILE_READ_GRACE decisions stays (the read may predate the claim). No usable
 * read (null) → nothing changes. → the tiles dropped ("p,q,tile").
 */
export function pruneOwnTiles(memory, records, ownTag) {
  if (!(records instanceof Map) || typeof ownTag !== 'string' || !ownTag || !Array.isArray(memory.ownTiles)) return [];
  const dropped = [], keep = [];
  for (const o of memory.ownTiles) {
    const fresh = Number.isInteger(o.at) && memory.decisions - o.at < OWN_TILE_READ_GRACE;
    const owner = records.get(`${o.p},${o.q}`)?.owners?.[o.tile] ?? null;
    if (!fresh && owner !== ownTag) dropped.push(`${o.p},${o.q},${o.tile}`);
    else keep.push(o);
  }
  if (dropped.length) memory.ownTiles = keep;
  return dropped;
}

/** At most this many wide claims per resident (slots 2 and 3). */
export const OPERATOR_WIDE_CLAIMS = 2;
/** territory-impl: the most tiles an operator resident claims (its land then grows only through villages and keeps). */
export const OPERATOR_TILES_MAX = 24;
/** The troops a resident with no host trains up to before its first march into the wide land (a host is at least 100). */
export const WIDE_HOST_TROOPS = 110;
/** (TEST-ONLY wide march) Marches into the wide land per resident, and the turns between two of them. */
export const OPERATOR_WIDE_MARCHES = 2;
export const WIDE_MARCH_GAP_BELLS = 40;
/** Whether a resident may look for a wide march now (pure; `nowBell` the chain's turn). */
export const wideMarchDue = (memory, nowBell) => (memory.wideMarches ?? 0) < OPERATOR_WIDE_MARCHES && (memory.wideMarchUntil ?? -1) < (nowBell ?? -1)
  && (memory.cooldown?.WideMarch ?? 0) <= memory.decisions;
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
export function decideNext(memory, view, opts) {
  const d = decideCore(memory, view, opts);
  // (Q-LP19-1 (a): said in the decision's reason, so the log shows which far targets were left and why)
  const wide = opts?.wide, h = view?.holding;
  if (!h || !Array.isArray(wide?.targets) || !wide.land || typeof d?.why !== 'string') return d;
  const dear = wide.targets.map(t => ({ t, x: landTooDear(t, { home: h, villages: memory.wideVillages, ownTiles: memory.ownTiles, land: wide.land }) })).filter(e => e.x);
  if (!dear.length) return d;
  const f = dear[0];
  return { ...d, dear: dear.map(e => `${e.t.p},${e.t.q}`), why: `${d.why} (skipped ${dear.length} nation-reach target(s) whose site tile costs more upkeep than the food surplus: ${f.t.p},${f.t.q} is ${f.x.dist} provinces from my nearest village, +${(f.x.addMilli / 1000).toFixed(2)} food/h > ${(f.x.surplusMilli / 1000).toFixed(2)} food/h spare)` };
}
function decideCore(memory, view, { homes, nowSecs, war = null, wide = null, atOnce = false }) {
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
    // (fix-loop16, `--near`: the chosen province beside the player's village first, site by site; then the usual order)
    const nearFirst = memory.near?.home && view.faction === memory.near.home.nation ? Array.from({ length: 12 }, (_, site) => ({ p: memory.near.home.p, q: memory.near.home.q, site })) : [];
    const next = [...nearFirst, ...(memory.war ? warHomeCandidates(homes, view.faction, memory.index) : homeCandidates(homes, view.faction, { outward: !!wide }))].find(h => !tried.has(`${h.p},${h.q},${h.site}`));
    if (!next) return { wait: true, why: 'no untried heartland site of this nation' };
    // (wide play: past the heartland — a settled rim province — a first village is a one-site request, FileTicket: the
    //  program's PlaceHome names no province past the Season's base r_max)
    // (world4-pacing-impl, owner Q-PM2-2 (a): a world whose Season has `pacing` 1 (`atOnce`) places the rim village at
    //  once with PlaceHome on a settled rim province; a refused one (e.g. not settled yet, ⑭ R3) falls back to the
    //  request lottery for the same site — `memory.atOnceTried`)
    const k = `${next.p},${next.q},${next.site}`;
    if (wide && ring(next.p, next.q) > 6 && atOnce && !(memory.atOnceTried ?? []).includes(k)) return { name: 'PlaceHome', atOnce: true, v: { holding: next, faction: view.faction }, fields: { p: next.p, q: next.q, site: next.site }, why: 'a citizen with no village: place the rim village at once (pacing 1)' };
    if (wide && ring(next.p, next.q) > 6) return { name: 'FileTicket', v: { sites: [next] }, fields: { sites: [next] }, why: 'a citizen with no village: request a rim site of its nation, beside the wide land' };
    return { name: 'PlaceHome', v: { holding: next, faction: view.faction }, fields: { p: next.p, q: next.q, site: next.site }, why: 'a citizen with no village: the next heartland site of its nation' };
  }
  const h = { p: view.holding.p, q: view.holding.q, site: view.holding.site };
  // (verify-pr206-209, owner TQ-2: a tile's upkeep distance is from the NEAREST own village — an own wide village
  //  nearer than the first home is named in the claim)
  const nearer = t => { const v = nearerOwnVillage(h, t, memory.wideVillages); return v ? { village: v } : {}; };
  // (verify-pr206-209: live, 2 of 3 growth claims were refused Insufficient — a tile claim is sent only when the ore
  //  read covers the next tile's price; an unknown ore read does not block)
  // (ai-ore-reserve, owner 2026-11-25 09:33 Q-LP15-4 (b): and only when the ORE RESERVE stays behind — one training
  //  batch, the troops still missing for its next host, its next village's ore; no tile while an own keep near it is
  //  under contest. local-play-operator-reserve.mjs)
  // (Q-LP19-1 (a): a nation-reach target whose site tile would cost more upkeep than the village's food surplus is
  //  skipped — for the village claim, the site tile, and the saving for it; landTooDear above)
  const dearOf = t => landTooDear(t, { home: h, villages: memory.wideVillages, ownTiles: memory.ownTiles, land: wide?.land ?? null });
  const targets = Array.isArray(wide?.targets) ? wide.targets.filter(t => !dearOf(t)) : [];
  const skipped = Array.isArray(wide?.targets) ? wide.targets.length - targets.length : 0;
  const atWar = !!(memory.war && war);
  const stores = Array.isArray(wide?.stores) ? wide.stores : null;
  const ore = Number.isFinite(wide?.ore) ? wide.ore : null;
  const army = atWar ? (Number.isFinite(war.army) ? war.army : Number(war.reserve ?? 0)) : wide?.needHost ? Number(wide.needHost.reserve ?? 0) : null;
  const threatened = atWar && (war.threatened === true || war.march?.kind === 'defend');
  const villageDue = !!wide && targets.length > 0 && (memory.claims ?? 0) < OPERATOR_WIDE_CLAIMS;
  const oreKept = oreReserve({ army, hostGoal: atWar ? MUSTER_MIN : wide?.needHost ? WIDE_HOST_TROOPS : 0, threatened,
    villagesHeld: villageDue ? 1 + Math.max(Number.isInteger(view.wide) ? view.wide : 0, (memory.wideVillages ?? []).length) : null });
  const oreCovers = () => tilePays(ore, (memory.ownTiles ?? []).length, oreKept);
  // (ai-early-mine: SAVING FOR ITS FIRST WIDE VILLAGE — a wide village can still be claimed (wide land in reach, a site
  //  not yet refused, a claim left) and the resident has none yet (its record's count, its own landed claims)
  const villageSite = () => { const tried = new Set(memory.triedClaims ?? []); return targets.some(t => (Array.isArray(t.free) ? t.free : Array.from({ length: 12 }, (_, site) => site)).some(site => !tried.has(`${t.p},${t.q},${site}`))); };
  const savingFirstVillage = villageDue && Math.max(Number.isInteger(view.wide) ? view.wide : 0, (memory.wideVillages ?? []).length, memory.claims ?? 0) === 0 && villageSite();
  // (ai-early-mine, owner 2026-11-25 20:03 Q-AEM-1 (b): until its next wide-land village is built the resident's troops
  //  are capped at one host — no Train at or above 300 — so the food and gold are saved for the village; with the
  //  village claimed, or none claimable (no wide land in reach, every site tried, no claim left), it trains freely)
  // (a host on the march is not among the hosts the war eyes read where they stand: its troops at departure are in
  //  the village's own transit record — `depMass`, thousandths — and count toward the cap too)
  const marching = (Array.isArray(view.holding.decoded?.transit) ? view.holding.decoded.transit : []).reduce((n, t) => n + (t && Number(t.state) !== 0 ? Math.floor((Number(t.depMass) || 0) / 1000) : 0), 0);
  const trainCapped = savingCapsTrain({ villagePlanned: savingFirstVillage, army: Number.isFinite(army) ? army + marching : army, wideVillages: 0 });
  // (territory-impl: grow the land — one more tile next to the resident's own, a turn apart, up to OPERATOR_TILES_MAX;
  //  the reach is its own tile's province (witness 'own'); a refused tile is not asked again. verify-pr206-209: also
  //  while it saves for its next village — a tile costs ore, not the settler's goods — so AI land grows by tiles, not
  //  only by village sites: before, the save-for-a-village Harvest came first and no growth claim was ever sent)
  const growCandidate = () => {
    const own = memory.ownTiles ?? [];
    if (!(wide && own.length && own.length < OPERATOR_TILES_MAX)) return null;
    // (ai-early-mine, owner 2026-11-25 22:28 Q-VPR241-1 (b): while it saves for its FIRST wide village the resident buys
    //  only the tile its next village stands on (the site tile, below) — no other new tile; their upkeep is food)
    if (savingFirstVillage) return null;
    const tried = new Set(memory.triedTiles ?? []);
    for (const o of own) {
      const t = (wide.targets ?? []).find(x => x.p === o.p && x.q === o.q && x.territory);
      const blockedList = t?.territory ? [...t.territory.siteTiles, t.territory.keepTile] : o.blocked;
      if (!Array.isArray(blockedList)) continue;
      const blocked = new Set(blockedList);
      const tile = Array.from({ length: 61 }, (_, i) => i).find(i => !blocked.has(i) && !own.some(x => x.p === o.p && x.q === o.q && x.tile === i) && !tried.has(`${o.p},${o.q},${i}`));
      if (Number.isInteger(tile))
        return { name: 'TerritoryClaim', v: { holding: h, target: { p: o.p, q: o.q }, witness: { kind: 'own', p: o.p, q: o.q }, ...nearer({ p: o.p, q: o.q }) }, fields: { tile }, growth: true, blocked: blockedList,
          why: `grow the land: one more tile at ${o.p},${o.q} (${own.length} owned)` };
    }
    return null;
  };
  const grow = () => ((memory.cooldown.TerritoryClaim ?? 0) <= memory.decisions && memory.decisions % 2 === 0 && oreCovers() ? growCandidate() : null);
  // (ai-ore-reserve: the tile of the next village's site, when the resident still has to claim it — the same choice
  //  the village step below makes)
  const siteTileDue = () => {
    if (!villageDue || !targets.some(t => t.territory)) return false;
    const tried = new Set(memory.triedClaims ?? []);
    const next = targets.flatMap(t => (Array.isArray(t.free) ? t.free : Array.from({ length: 12 }, (_, site) => site)).map(site => ({ t, site }))).find(c => !tried.has(`${c.t.p},${c.t.q},${c.site}`));
    const tile = next?.t.territory ? next.t.territory.siteTiles[next.site] : null;
    return Number.isInteger(tile) && !(memory.ownTiles ?? []).some(o => o.p === next.t.p && o.q === next.t.q && o.tile === tile);
  };
  // (ai-ore-reserve: a Train is not asked for when the stores are known not to cover it; and with the army at its floor
  //  and no threat, land and troops take turns — the land's turn only while a tile can really be claimed)
  const landsTurn = () => oreTurn({ army, threatened, ore, troopsTurn: memory.troopsTurn === true, landWanted: siteTileDue() || !!growCandidate() }) === 'land';
  // (ai-early-mine, owner 2026-11-25 17:58 Q-AOR-1 (b): ONE mine, early — the village's first command, the page's own
  //  Build item 3 at its own price; not while threatened; local-play-operator-mine.mjs)
  if (earlyMineDue(memory, { mines: minesOf(view.holding.decoded), stores, threatened, cooling: (memory.cooldown[`Build:${OPERATOR_EARLY_MINE.item}`] ?? 0) > memory.decisions }))
    return { name: 'Build', v: { holding: h, item: OPERATOR_EARLY_MINE.item }, fields: { item: OPERATOR_EARLY_MINE.item }, earlyMine: true, why: 'one early mine: ore pays both troops and land' };
  // (a war resident of a wide world: its FIRST expedition into the wide land before the war step takes every ready host —
  //  loop-play4 B-6, war on by default: the AI nations both fight and go out into the wide land)
  if (memory.war && war && wide?.march && (memory.wideMarches ?? 0) === 0) return { name: 'WideMarch', plan: wide.march, why: `a ready host (${wide.march.host.troops} troops) marches into the wide land at ${wide.march.dest.p},${wide.march.dest.q} (arrival turn ${wide.march.arriveBell}), before the war takes it` };
  // (a war resident: the war step first — defend, attack, muster, train — then the base rotation for the economy)
  if (memory.war && war) {
    // (a war resident's refusals cool down for WAR_COOLDOWN_BELLS turns: it may act once per turn, but looks every few seconds)
    const cool = name => (memory.cooldown[`war:${name}`] ?? -1) >= (war.nowBell ?? Infinity);
    const s = warStep({ ...war, refused: { Train: cool('Train'), Muster: cool('Muster') }, march: cool('Depart') ? null : war.march });
    const bell = war.nowBell ?? null;
    if (s?.wait) return { wait: true, why: s.why };
    if (s?.name === 'Depart') return { name: 'Depart', kind: s.kind, row: s.row, war: true, bell, ...(s.goal ? { goal: s.goal } : {}), why: `${s.goal ? `${s.goal} — ` : ''}${s.kind}: the keep at ${s.row.p},${s.row.q} (garrison ${s.row.troops ?? '?'}, host ${s.row.origin?.troops ?? '?'})` };
    if (s?.name === 'Muster' && view.holding.tile !== undefined) return { name: 'Muster', v: { holding: h }, fields: { unit: 0, troops: s.troops, tile: view.holding.tile }, war: true, bell, why: `a host of the reserve's ${s.troops} troops` };
    if (s?.name === 'Train' && !trainCapped && coversTrain(stores, s.n) && !landsTurn()) return { name: 'Train', v: { holding: h }, fields: { unit: 0, n: s.n }, war: true, bell, why: `troops for the next host (reserve ${war.reserve ?? 0})` };
  }
  // (TEST-ONLY wide march, wide-march-local: a ready host of a rim village marches INTO the bordering wide land — the
  //  page's own judged route, local-play-operator-wide-march.mjs; at most OPERATOR_WIDE_MARCHES, one at a time)
  // (no host at all yet: form one first — Train to the minimum host, then Muster the reserve, each cooled after a refusal)
  if (wide?.needHost && view.holding.tile !== undefined) {
    const reserve = Number(wide.needHost.reserve ?? 0);
    if (reserve >= 100 && (memory.cooldown.WideMuster ?? 0) <= memory.decisions) return { name: 'Muster', v: { holding: h }, fields: { unit: 0, troops: Math.min(reserve, 300), tile: view.holding.tile }, wideHost: true, why: `a host of the reserve's ${Math.min(reserve, 300)} troops, to march into the wide land` };
    if (reserve < 100 && (memory.cooldown.WideTrain ?? 0) <= memory.decisions && coversTrain(stores, WIDE_HOST_TROOPS - reserve)) return { name: 'Train', v: { holding: h }, fields: { unit: 0, n: WIDE_HOST_TROOPS - reserve }, wideHost: true, why: 'troops for a host that marches into the wide land' };
  }
  if (wide?.march) return { name: 'WideMarch', plan: wide.march, why: `a ready host (${wide.march.host.troops} troops) marches into the wide land at ${wide.march.dest.p},${wide.march.dest.q} (arrival turn ${wide.march.arriveBell})` };
  // (TEST-ONLY wide play: save, then claim the nearest wide land within reach — header)
  if (wide && targets.length && (memory.claims ?? 0) < OPERATOR_WIDE_CLAIMS) {
    const tried = new Set(memory.triedClaims ?? []);
    // (a target's FREE sites when the herald's capture names them — flocalplay-wide.mjs freeWideSites; else every site)
    const sitesOf = t => (Array.isArray(t.free) ? t.free : Array.from({ length: 12 }, (_, site) => site));
    // (expansion-gameplay-1: a target reached through the nation's land carries its reach witness)
    const next = targets.flatMap(t => sitesOf(t).map(site => ({ t: { p: t.p, q: t.q }, site, reach: t.reach ? { p: t.reach.p, q: t.reach.q } : null }))).find(c => !tried.has(`${c.t.p},${c.t.q},${c.site}`));
    if (next) {
      const waiting = (memory.claimWaitUntil ?? 0) > memory.decisions || (memory.cooldown.WideClaim ?? 0) > memory.decisions;
      // (territory-impl, owner 2026-11-24 12:09 T-6: in a territory world the village stands on the resident's own tile —
      //  the site's tile is claimed first, one tile a turn, paid in ore; the same reach witness as the village claim)
      const terr = targets.find(t => t.p === next.t.p && t.q === next.t.q)?.territory ?? null;
      const tile = terr ? terr.siteTiles[next.site] : null;
      const owned = terr && (memory.ownTiles ?? []).some(o => o.p === next.t.p && o.q === next.t.q && o.tile === tile);
      if (terr && !owned) {
        if (!Number.isInteger(tile)) { (memory.triedClaims ??= []).push(`${next.t.p},${next.t.q},${next.site}`); return { name: 'Harvest', v: { holding: h }, fields: {}, why: 'that site has no tile: harvest' }; }
        if ((memory.cooldown.TerritoryClaim ?? 0) <= memory.decisions && oreCovers())
          return { name: 'TerritoryClaim', v: { holding: h, target: next.t, ...(next.reach ? { witness: { kind: 'nation', p: next.reach.p, q: next.reach.q } } : {}), ...nearer(next.t) }, fields: { tile }, site: next.site, blocked: [...terr.siteTiles, terr.keepTile],
            why: `claim the tile of site ${next.site} at ${next.t.p},${next.t.q} first (a village stands on one's own land)${next.reach ? ` through the nation's land at ${next.reach.p},${next.reach.q}` : ''}` };
        // (verify-pr206-209: the village cannot stand on a tile not yet its own — never sent then, it would be refused)
        return { name: 'Harvest', v: { holding: h }, fields: {}, why: 'the site\'s tile first (ore or the turn\'s claim): harvest meanwhile' };
      }
      if (wide.canClaim && !waiting) {
        const slot = 2 + Math.min(1, Math.max(Number.isInteger(view.wide) ? view.wide : 0, memory.claims ?? 0));
        // (a slot-3 claim names the slot-2 wide village as its previous pair — expansion-gameplay-1; before, the AI's
        //  third village was always refused BadAccount)
        const prev = slot === 3 ? (memory.wideVillages ?? [])[0] : null;
        if (slot === 3 && !prev) return { name: 'Harvest', v: { holding: h }, fields: {}, why: 'a third village needs the second wide village known first: harvest' };
        return { name: 'WideClaim', v: { holding: h, target: next.t, ...(next.reach && !terr ? { reach: next.reach } : {}), ...(prev ? { previous: { p: String(prev.p), q: String(prev.q), site: prev.site } } : {}), ...(terr ? { territory: true } : {}) }, fields: { site: next.site, slot },
          why: `stores cover the settler cost: claim wide land at ${next.t.p},${next.t.q} site ${next.site} (slot ${slot})${next.reach ? ` through the nation's land at ${next.reach.p},${next.reach.q}` : ''}` };
      }
      return grow() ?? { name: 'Harvest', v: { holding: h }, fields: {}, why: waiting ? 'a wide claim is settling: harvest meanwhile' : 'saving for a wide claim (the settler cost): harvest' };
    }
  }
  // (territory-impl: grow the land when idle)
  { const g = grow(); if (g) return g; }
  for (let k = 0; k < OPERATOR_ROTATION.length; k++) {
    const a = OPERATOR_ROTATION[(memory.step + k) % OPERATOR_ROTATION.length];
    // (a war resident's troops and hosts are the war step's: its rotation is the economy only — Harvest and Build)
    if (memory.war && (a.name === 'Train' || a.name === 'Muster')) continue;
    if (a.name === 'Train' && trainCapped) continue;   // (Q-AEM-1 (b): saving for the next wide village)
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
/** Program refusals of a tile claim that pass with time (stores, unpaid upkeep, the turn's claim): cool down, never mark tried. */
const TILE_CLAIM_TEMPORARY = new Set([21, 29, 43, 'Insufficient', 'Cooldown', 'NotEligible']);
export function noteOutcome(memory, decision, outcome, why = {}) {
  memory.decisions += 1;
  if (decision?.wait) return memory;
  const bad = outcome === 'refused' || outcome === 'failed';
  // (world4-pacing-impl: TicketState 45 — a lottery cohort is open in that province, which blocks PlaceHome there until
  //  it closes: wait two decisions and place at once again, rather than file a request that holds the province open
  //  for everyone else; any other refusal falls back to the request for that site)
  if (decision.name === 'PlaceHome' && decision.atOnce && bad && (why.programCode === 45 || why.code === 'TicketState')) memory.ticketUntil = memory.decisions + 2;
  else if (decision.name === 'PlaceHome' && decision.atOnce && (bad || outcome === 'unknown')) (memory.atOnceTried ??= []).push(`${decision.fields.p},${decision.fields.q},${decision.fields.site}`);
  else if (decision.name === 'PlaceHome' && (bad || outcome === 'unknown')) memory.triedHomes.push(`${decision.fields.p},${decision.fields.q},${decision.fields.site}`);
  if (decision.name === 'FileTicket') {
    const k = `${decision.fields.sites[0].p},${decision.fields.sites[0].q},${decision.fields.sites[0].site}`;
    // (a filed site is not filed again either way: a request that lost its site — taken — moves on to the next)
    if (outcome === 'landed') memory.ticketUntil = memory.decisions + OPERATOR_CLAIM_SETTLE_WAIT * 2;
    memory.triedHomes.push(k);
  }
  if (decision.name === 'WideClaim') {
    if (outcome === 'landed') { memory.claims = (memory.claims ?? 0) + 1; memory.claimWaitUntil = memory.decisions + OPERATOR_CLAIM_SETTLE_WAIT;
      // (TEST-ONLY wide -> wide: the village the claim may found, read later by local-play-operator-wide-host.mjs)
      (memory.wideVillages ??= []).push({ p: String(decision.v.target.p), q: String(decision.v.target.q), site: decision.fields.site }); }
    // (a refused site is not asked again; the claim itself cools down — a site taken, a ticket still open, stores short)
    if (bad || outcome === 'unknown') { (memory.triedClaims ??= []).push(`${decision.v.target.p},${decision.v.target.q},${decision.fields.site}`); memory.cooldown.WideClaim = memory.decisions + OPERATOR_COOLDOWN; }
  }
  if (decision.name === 'TerritoryClaim') {
    const k = `${decision.v.target.p},${decision.v.target.q},${decision.fields.tile}`;
    // (already the resident's — AlreadyDone 52, e.g. an earlier answer was not known — counts as landed)
    const mine = outcome === 'landed' || (bad && (why.programCode === 52 || why.code === 'AlreadyDone'));
    // (ai-ore-reserve: a tile landed — the next ore is the troops')
    if (outcome === 'landed') memory.troopsTurn = true;
    if (mine && !(memory.ownTiles ?? []).some(o => `${o.p},${o.q},${o.tile}` === k)) (memory.ownTiles ??= []).push({ p: String(decision.v.target.p), q: String(decision.v.target.q), tile: decision.fields.tile, at: memory.decisions, ...(Array.isArray(decision.blocked) ? { blocked: decision.blocked } : {}) });
    // (verify-pr206-209: a refusal that passes with time — ore short, upkeep unpaid, the turn's claim — only cools the
    //  claim; the tile and its village site stay candidates. Not known: the tile is not asked again, the site stays)
    const temporary = bad && (TILE_CLAIM_TEMPORARY.has(why.programCode) || TILE_CLAIM_TEMPORARY.has(why.code));
    if (temporary) memory.cooldown.TerritoryClaim = memory.decisions + OPERATOR_COOLDOWN;
    else if (outcome === 'unknown') { (memory.triedTiles ??= []).push(k); memory.cooldown.TerritoryClaim = memory.decisions + OPERATOR_COOLDOWN; }
    // (refused for good: that tile is not asked again — taken by another, the keep's, out of reach — and the claim cools)
    else if (bad && !mine) {
      (memory.triedTiles ??= []).push(k);
      if (Number.isInteger(decision.site)) (memory.triedClaims ??= []).push(`${decision.v.target.p},${decision.v.target.q},${decision.site}`);
      memory.cooldown.TerritoryClaim = memory.decisions + OPERATOR_COOLDOWN;
    }
  }
  // (ai-ore-reserve: a batch landed — the land may take the next ore)
  if (decision.name === 'Train' && outcome === 'landed') memory.troopsTurn = false;
  // (ai-early-mine: counted; a refused or failed one cools like any Build, an unknown one too — never sent blindly twice)
  if (decision.earlyMine) { noteEarlyMine(memory, outcome); if (bad || outcome === 'unknown') memory.cooldown[key(decision)] = memory.decisions + OPERATOR_COOLDOWN; }
  if (decision.wideHost && bad) memory.cooldown[decision.name === 'Muster' ? 'WideMuster' : 'WideTrain'] = memory.decisions + OPERATOR_COOLDOWN;
  if (decision.name === 'WideMarch') {
    // (landed or not known: counted and spaced — never sent twice for one plan; refused: cooled down)
    if (outcome === 'landed' || outcome === 'unknown') { memory.wideMarches = (memory.wideMarches ?? 0) + 1; memory.wideMarchUntil = (decision.plan?.nowBell ?? 0) + WIDE_MARCH_GAP_BELLS; }
    if (bad) memory.cooldown.WideMarch = memory.decisions + OPERATOR_COOLDOWN;
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
