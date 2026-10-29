/**
 * The world snapshot a preflight reads, and the adapter from S2's model
 * to the grants a manifest needs.
 *
 * The snapshot mirrors the fields of S1 vaults and holdings and S2 issues
 * and lots (docs/frontier/stage2/S2-2A-CONTRACT.md §2, on the unmerged
 * branch). It is mock data: in the real game it would be read from the
 * herald's feeds (`h/tickets.json`, the vault and holding accounts), and
 * the grant checks would be ②'s Grant verifier (see proposals/).
 */

import { clone, own } from "./canonical.mjs";

export function place(world, id) {
  return own(world.places, id) ?? null;
}

export function citizenOf(world, pub) {
  for (const [id, c] of Object.entries(world.citizens ?? {})) if (c.pub === pub) return id;
  return null;
}

export function bindIdentities(world, pubs) {
  const w = clone(world);
  for (const [id, pub] of Object.entries(pubs)) if (w.citizens[id]) w.citizens[id].pub = pub;
  return w;
}

/** The kind of grant a lot gives, by S2's issue kinds (1 share, 2 receipt, 3 use). */
export function lotView(world, lotId) {
  const lot = own(world.lots, lotId);
  if (!lot) return null;
  const issue = own(world.issues, lot.issue);
  return issue ? { id: lotId, ...lot, issue: { id: lot.issue, ...issue } } : null;
}

/**
 * Why a lot does not give `actor` the right `kind` on `sourceId` today,
 * or null if it does. The order is the S2 program's: holder, kind and
 * source, state, generation and stamp, then the end day.
 */
export function grantProblem(world, lotId, { actor, kind, sourceId, today }) {
  const v = lotView(world, lotId);
  if (!v) return { code: "GRANT_NOT_HELD", detail: "no such lot" };
  if (v.holder !== actor) return { code: "GRANT_NOT_HELD", holder: v.holder };
  if (v.escrow) return { code: "GRANT_NOT_HELD", detail: "the lot is held in an escrow" };
  if (v.issue.kind !== kind || v.issue.source !== sourceId) return { code: "GRANT_WRONG", has: { kind: v.issue.kind, source: v.issue.source }, needs: { kind, source: sourceId } };
  const src = place(world, sourceId);
  if (v.state !== "live" || v.issue.state !== "live") return { code: "GRANT_VOID", detail: "closed" };
  if (!src || !src.live || src.gen !== v.issue.srcGen || src.gen !== v.srcGen || src.stamp !== v.issue.srcStamp) {
    return { code: "GRANT_VOID", detail: "the source was seized, captured, closed or built again" };
  }
  if (today > v.issue.untilDay) return { code: "GRANT_EXPIRED", untilDay: v.issue.untilDay, today };
  return null;
}

/** Use runs left today on a lot (AMOUNT × PER_UNIT − used today). */
export function useRunsLeft(world, lotId, today) {
  const v = lotView(world, lotId);
  const used = v.day === today ? v.dayUsed ?? 0 : 0;
  return v.amount * v.issue.perUnit - used;
}

/** Runs left today on a workshop holding across every use ticket (copies × 24). */
export function workshopRunsLeft(world, holdingId, today) {
  const h = place(world, holdingId);
  const used = h.useDay === today ? h.useRuns ?? 0 : 0;
  return (h.workshops ?? 0) * 24 - used;
}

/** The actor's lots that would give `kind` on `sourceId`, best first. */
export function candidateLots(world, { actor, kind, sourceId, today }) {
  return Object.keys(world.lots ?? {}).filter((id) => !grantProblem(world, id, { actor, kind, sourceId, today }));
}
