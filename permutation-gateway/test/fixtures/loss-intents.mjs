// One example intent per S1 loss act of the coexist lane (fix-9-10-followups: SeizeVault, RaidDomestic, RaidCaravan —
// flocalplay-rights.mjs COEXIST_LOSS_ACTS), for the tests that walk every coexist act (frontier-local-play-rights.test.mjs)
// and the losses' own tests (frontier-local-play-losses.test.mjs). Plain data; no key, nothing sent.

/**
 * `F` the raider's / captor's village {p, q, site}, `V` a storehouse {p, q, tile} in the same Province, `owner` the other
 * Citizen (the storehouse's or the caravan's owner), `ownerTag` that Citizen's tag (decimal text).
 */
export function LOSS_INTENTS({ F, V, owner, ownerTag }) {
  const pq = { p: F.p, q: F.q }, caravan = { owner_tag: ownerTag, seq: 2 };
  return {
    SeizeVault: { name: 'SeizeVault', subject: { at: V, hostHolding: F, ownerCitizen: owner }, fields: { entry: 5 } },
    RaidDomestic: { name: 'RaidDomestic', subject: { caravan, province: pq, hostHolding: F, ownerCitizen: owner }, fields: { bell: 300, entry: 5 } },
    // (a burn: no destination, the raid's Province alone)
    RaidCaravan: { name: 'RaidCaravan', subject: { caravan, raid: pq, raider: F, dst: null, pathProvinces: [], oldRoute: [] },
      fields: { p: F.p, q: F.q, choice: 1, n_path: 1, dst_kind: 0, dst_p: 0, dst_q: 0, dst_at: 0, dst_gen: 0, steps: 0, path: Array(12).fill(0) } },
  };
}

/** A take of the same caravan to the raider's village `F` (generation 0), over its own Province. */
export function TAKE_INTENT({ F, ownerTag, oldRoute = [{ p: F.p, q: F.q }] }) {
  const pq = { p: F.p, q: F.q };
  return { name: 'RaidCaravan', subject: { caravan: { owner_tag: ownerTag, seq: 2 }, raid: pq, raider: F, dst: { kind: 'holding', ...F, gen: 0 }, pathProvinces: [pq], oldRoute },
    fields: { p: F.p, q: F.q, choice: 0, n_path: 1, dst_kind: 1, dst_p: F.p, dst_q: F.q, dst_at: F.site, dst_gen: 0, steps: 2, path: [9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } };
}
