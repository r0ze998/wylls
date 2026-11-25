// LOCAL PLAY, TEST-ONLY — operator AI residents: ONE EARLY MINE (owner 2026-11-25 17:58 JST, Q-AOR-1 (b): "build one
// early mine"). Key-free, pure: nothing here reads, signs or sends.
//
// Why (reports/ai-ore-reserve.md, Q-AOR-1): a village makes 4 ore an hour; tiles and troops are both paid in that ore,
// and the residents' build rotation is farm, woodcutter, quarry (items 0, 1, 2) — they never built a mine (+6 ore an
// hour, the page's own Build item 3). With the ore reserve in place (#236) the ore income limits both their armies and
// their land.
//
// The rule (behaviour only — the page's own Build at the page's own price, §8; no rule of the world changes):
//   a resident's first village command is Build item 3 (a mine), once:
//     - while its first village's own record says it has no mine, built or under way (a record that does not tell:
//       no mine is asked for — nothing is built on a guess), and the resident's memory holds no landed one,
//     - its stores cover the first copy's cost (unknown stores do not block, as everywhere in the policy),
//     - nothing threatens it (a war resident defends first),
//     - at most OPERATOR_EARLY_MINE.tries asks (a refused one cools OPERATOR_COOLDOWN decisions like any Build).
//   A village's first building takes the program's 60-second "first building" time, so the mine yields from its
//   second turn on. One copy only: more mines are not this rule's.
// The cost is pinned against permutation-rules catalog.rs BUILDINGS by test/frontier-local-play-operator-early-mine.test.mjs.
// (hud/rulebook.mjs copyNumber is the page's reading of the same count; it is not imported — its closure reaches the
//  march composer, and the key-free CI lane would then drop the policy's tests.)
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';

const ORE = RESOURCE_ORDER.indexOf('Ore');
/** The settings (the AI's own choice, not a rule of the world): which build item, how many copies, how many asks. */
export const OPERATOR_EARLY_MINE = Object.freeze({ item: 3, copies: 1, tries: 3 });
/** What the first mine costs, by resource index (catalog.rs BUILDINGS[3].cost: food 40, wood 80, stone 20). */
export const MINE_COST = Object.freeze(RESOURCE_ORDER.map(r => ({ Food: 40, Wood: 80, Stone: 20 })[r] ?? 0));
/** What one mine adds, thousandths of ore an hour (catalog.rs BUILDINGS[3].per_hour 6). */
export const MINE_PER_HOUR_MILLI = 6000n;
/** The queue kind of a building under way (the program's `queue_kind` PRODUCTION; fland.mjs QUEUE_KIND). */
const QUEUE_PRODUCTION = 1;

const big = x => { try { return x === undefined || x === null ? null : BigInt(x); } catch { return null; } };

/** A Hamlet's ore an hour where the village records no terrain ore (catalog.rs BASE_PROD ore 15; fland.mjs BASE_PROD), thousandths. */
export const ORE_BASE_MILLI = 15000n;

/**
 * The mines of a village, built and under way, from its own record (the page decoder's Holding fields), or null when
 * the record does not tell. A Hamlet (tier 0) has `(production[ore] − base) / 6,000` mines built, plus every production
 * record of ore in its queue; `base` is its recorded terrain ore (`terrainOre`, thousandths an hour, written when the
 * village is founded — S1's arms rule) or, where none is recorded, the catalog's 15 an hour. (The page's
 * hud/rulebook.mjs copyNumber − 1, for the one case the operator residents are in: their villages stay Hamlets.)
 */
export function minesOf(h) {
  if (!h || typeof h !== 'object' || Number(h.tier ?? 0) !== 0) return null;
  const terrain = big(h.terrainOre), have = big(h.production?.[ORE]);
  const base = terrain !== null && terrain > 0n ? terrain : ORE_BASE_MILLI;
  if (have === null || have < base) return null;
  const queued = (Array.isArray(h.queue) ? h.queue : []).filter(q => q && Number(q.doneAt ?? 0) > 0 && Number(q.kind) === QUEUE_PRODUCTION && Number(q.arg) === ORE).length;
  return Number((have - base) / MINE_PER_HOUR_MILLI) + queued;
}

/** Whether `stores` (whole units by resource index) cover the first mine. Unknown stores do not block. */
export function coversMine(stores) {
  if (!Array.isArray(stores)) return true;
  return MINE_COST.every((x, i) => x <= (Number(stores[i]) || 0));
}

/**
 * Whether the resident asks for its early mine now. `mines`: `minesOf` of its first village; null (the record does not
 * tell) → never: a mine is not built on a guess. A mine the resident's own memory says landed counts too (the herald's
 * record may lag a turn). `cooling`: its Build of the mine is cooling after a refusal.
 */
export function earlyMineDue(memory, { mines = null, stores = null, threatened = false, cooling = false } = {}, cfg = OPERATOR_EARLY_MINE) {
  if (threatened || cooling || !Number.isInteger(mines)) return false;
  if (Math.max(mines, memory?.mine?.landed ?? 0) >= cfg.copies) return false;
  if ((memory?.mine?.asks ?? 0) >= cfg.tries) return false;
  return coversMine(stores);
}

/** After the early mine's Build was answered: counted in the resident's memory (`outcome` as noteOutcome's). */
export function noteEarlyMine(memory, outcome) {
  const m = (memory.mine ??= { asks: 0, landed: 0 });
  m.asks += 1;
  if (outcome === 'landed') m.landed += 1;
  return memory;
}
