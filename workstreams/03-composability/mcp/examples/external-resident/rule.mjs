// The reference external resident's "mind": a fixed, deterministic, offline rule. KEY-FREE and pure.
// This is the part to replace with your own AI (a model, a planner, a script): it gets what the resident observed and
// returns ONE of the page's six orders (Join, PlaceHome, Harvest, Build, Train, Muster) or a wait. Whatever it returns
// is still only a request: the resident signs it with its own key and the relay and the program check it exactly as
// they check a person's (a refused order is refused for it too).

/** What the reference rule asks for once it has a village, round and round. */
export const ROTATION = Object.freeze([
  Object.freeze({ name: 'Harvest' }),
  Object.freeze({ name: 'Build', item: 0 }),
  Object.freeze({ name: 'Train', unit: 0, n: 100 }),
  Object.freeze({ name: 'Harvest' }),
  // (a host is at least 100 troops: the program refuses fewer)
  Object.freeze({ name: 'Muster', unit: 0, troops: 100 }),
  Object.freeze({ name: 'Build', item: 1 }),
]);
export const COOLDOWN = 3;
/**
 * A Muster waits for its village's province to catch up with the turn (the program's resident_ok; else NotResident, 26):
 * at most this many rounds in a row, then it is skipped for this pass of the rotation (the other orders go on) and comes
 * back on the next pass. The page waits the same way (flocalplay-muster-wait.mjs).
 */
export const MUSTER_HOLD_ROUNDS = 5;
/** Program refusals that only mean "not yet, this turn" (the order is asked again, gated by its check, no cooldown). */
export const RETRY_LATER = Object.freeze(['NotResident']);
/** The Join's session expiry, as the page counts it: chain now + 30 days − 600 s. */
export const SESSION_SECONDS = 30 * 86_400 - 600;

export function createMemory({ nation }) {
  if (!Number.isInteger(nation) || nation < 0 || nation > 5) throw new Error('nation 0-5');
  return { nation, step: 0, decisions: 0, triedHomes: [], cooldown: {}, musterHolds: 0 };
}
const key = a => (a.name === 'Build' ? `Build:${a.item ?? a.fields?.item}` : a.name);

/**
 * `obs`: `{joined, faction, holding: {p, q, site, tile?} | null}` (public herald), `homes`: `[{p, q, site}]` (free home
 * sites of its nation, public herald), `nowSecs` (the chain's clock, public herald), `village` (MCP get_village_status,
 * optional), `province`: `{bell, resolvedNext}` (the turn and how far its own province is resolved, public herald;
 * public.mjs provinceFacts) — a Muster is asked for only when `resolvedNext + 1 >= bell`. → `{name, v, fields, why}` or
 * `{wait: true, why}`.
 */
export function decide(mem, { obs, homes = [], nowSecs = null, village = null, province = null }) {
  if (!obs) return { wait: true, why: 'no readable observation' };
  if (!obs.joined) {
    if (!Number.isSafeInteger(nowSecs) || nowSecs <= 0) return { wait: true, why: 'no chain clock yet for the Join expiry' };
    return { name: 'Join', v: { faction: mem.nation }, fields: { faction: mem.nation, session_expiry: BigInt(nowSecs + SESSION_SECONDS) }, why: 'not a citizen yet: join my nation' };
  }
  if (!obs.holding) {
    const tried = new Set(mem.triedHomes);
    const next = homes.find(h => !tried.has(`${h.p},${h.q},${h.site}`));
    if (!next) return { wait: true, why: 'no free home site of my nation seen yet' };
    return { name: 'PlaceHome', v: { holding: { p: next.p, q: next.q, site: next.site }, faction: obs.faction }, fields: { p: next.p, q: next.q, site: next.site }, why: 'a citizen with no village: a free home site of my nation' };
  }
  const h = { p: obs.holding.p, q: obs.holding.q, site: obs.holding.site };
  const food = village?.stores?.find?.(s => s.resource === 'Food')?.have;
  for (let k = 0; k < ROTATION.length; k++) {
    const i = (mem.step + k) % ROTATION.length, a = ROTATION[i];
    if ((mem.cooldown[key(a)] ?? 0) > mem.decisions) continue;
    if (a.name === 'Muster' && obs.holding.tile === undefined) continue;
    // (the program's resident_ok, checked before sending, as the page does: unread is held, never guessed)
    if (a.name === 'Muster') {
      const bell = province?.bell, rn = province?.resolvedNext;
      const ready = Number.isSafeInteger(bell) && Number.isSafeInteger(rn) ? rn + 1 >= bell : null;
      if (ready !== true) {
        if ((mem.musterHolds ?? 0) >= MUSTER_HOLD_ROUNDS) continue;
        return { wait: true, hold: 'Muster', why: ready === null ? 'a muster waits: my province\'s resolved turn is not read' : `a muster waits: my province is resolved to turn ${rn - 1}, it must reach turn ${bell - 2} (NotResident otherwise)` };
      }
    }
    // (what MCP showed is used: with no Food in the stores, training is not asked for)
    if (a.name === 'Train' && Number.isFinite(food) && food <= 0) continue;
    const fields = a.name === 'Harvest' ? {} : a.name === 'Build' ? { item: a.item } : a.name === 'Train' ? { unit: a.unit, n: a.n } : { unit: a.unit, troops: a.troops, tile: obs.holding.tile };
    return { name: a.name, v: { holding: h, ...(a.name === 'Build' ? { item: a.item } : {}) }, fields, why: `my village's rotation, step ${i}`, step: i };
  }
  return { wait: true, why: 'every order of my rotation is cooling down after a refusal' };
}

/**
 * After an order: 'landed' | 'failed' | 'refused' | 'unknown'; `code`: the program's error NAME when it named one
 * (agent.mjs). A RETRY_LATER refusal keeps the rotation on that order, with no cooldown: it is asked again (and checked
 * again before sending) on a later turn.
 */
export function note(mem, d, outcome, code = null) {
  mem.decisions += 1;
  if (d?.wait) { if (d.hold === 'Muster') mem.musterHolds = (mem.musterHolds ?? 0) + 1; return mem; }
  mem.musterHolds = 0;
  const bad = outcome === 'refused' || outcome === 'failed';
  if (d.name === 'PlaceHome' && outcome !== 'landed') mem.triedHomes.push(`${d.fields.p},${d.fields.q},${d.fields.site}`);
  if (Number.isInteger(d.step)) {
    if (bad && RETRY_LATER.includes(code)) { mem.step = d.step; return mem; }
    mem.step = d.step + 1; if (bad) mem.cooldown[key(d)] = mem.decisions + COOLDOWN;
  }
  return mem;
}
