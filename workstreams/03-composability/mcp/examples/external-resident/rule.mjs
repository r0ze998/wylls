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
/** The Join's session expiry, as the page counts it: chain now + 30 days − 600 s. */
export const SESSION_SECONDS = 30 * 86_400 - 600;

export function createMemory({ nation }) {
  if (!Number.isInteger(nation) || nation < 0 || nation > 5) throw new Error('nation 0-5');
  return { nation, step: 0, decisions: 0, triedHomes: [], cooldown: {} };
}
const key = a => (a.name === 'Build' ? `Build:${a.item ?? a.fields?.item}` : a.name);

/**
 * `obs`: `{joined, faction, holding: {p, q, site, tile?} | null}` (public herald), `homes`: `[{p, q, site}]` (free home
 * sites of its nation, public herald), `nowSecs` (the chain's clock, public herald), `village` (MCP get_village_status,
 * optional). → `{name, v, fields, why}` or `{wait: true, why}`.
 */
export function decide(mem, { obs, homes = [], nowSecs = null, village = null }) {
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
    // (what MCP showed is used: with no Food in the stores, training is not asked for)
    if (a.name === 'Train' && Number.isFinite(food) && food <= 0) continue;
    const fields = a.name === 'Harvest' ? {} : a.name === 'Build' ? { item: a.item } : a.name === 'Train' ? { unit: a.unit, n: a.n } : { unit: a.unit, troops: a.troops, tile: obs.holding.tile };
    return { name: a.name, v: { holding: h, ...(a.name === 'Build' ? { item: a.item } : {}) }, fields, why: `my village's rotation, step ${i}`, step: i };
  }
  return { wait: true, why: 'every order of my rotation is cooling down after a refusal' };
}

/** After an order: 'landed' | 'failed' | 'refused' | 'unknown'. */
export function note(mem, d, outcome) {
  mem.decisions += 1;
  if (d?.wait) return mem;
  const bad = outcome === 'refused' || outcome === 'failed';
  if (d.name === 'PlaceHome' && outcome !== 'landed') mem.triedHomes.push(`${d.fields.p},${d.fields.q},${d.fields.site}`);
  if (Number.isInteger(d.step)) { mem.step = d.step + 1; if (bad) mem.cooldown[key(d)] = mem.decisions + COOLDOWN; }
  return mem;
}
