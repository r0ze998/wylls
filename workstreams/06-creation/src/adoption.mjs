/**
 * Adoption: the user's confirmation of a plan, pinned to one manifest
 * version and content hash.
 *
 * The author's publication status decides whether a plan may be *newly*
 * adopted. Once adopted, the plan keeps that pinned definition: the author's
 * suspension or withdrawal does not stop it, and no later version — not even
 * a text-only patch — replaces it until the user confirms an update by
 * adopting a new plan that names the old one in `supersedes`. What still
 * stops an adopted plan is checked when it runs (execute.mjs): the facility
 * owner's grant, expiry, balance, goods, capacity, and the user ending it.
 *
 * This book is local and mock. In the game the record of adoptions and of
 * runs per day would be kept where runs are authorised (④, or the chain).
 */

import { clone, own } from "./canonical.mjs";
import { finding } from "./codes.mjs";
import { DOMAIN, verifyHash } from "./keys.mjs";
import { preflight, verifyPlanSignature } from "./plan.mjs";

function runKey(a) {
  return `${a.actor}|${a.manifest.author}/${a.manifest.name}`;
}

export class AdoptionBook {
  constructor(data = { adoptions: {}, seq: 0 }) {
    this.data = clone(data);
  }

  toJSON() {
    return clone(this.data);
  }

  get(planHash) {
    const a = own(this.data.adoptions, planHash);
    return a ? clone(a) : null;
  }

  /** null if the plan may run as adopted, else the finding code why not. */
  problem(planHash) {
    const a = own(this.data.adoptions, planHash);
    if (!a) return "PLAN_NOT_ADOPTED";
    if (a.state === "superseded") return "PLAN_SUPERSEDED";
    if (a.state === "ended") return "PLAN_ENDED";
    return null;
  }

  /** The active adoptions of a user (by public key). */
  activeOf(actorPub) {
    return Object.values(this.data.adoptions).filter((a) => a.actor === actorPub && a.state === "active").map(clone);
  }

  /**
   * Adopt a signed plan: it must pass preflight as a new adoption (so the
   * definition must be listed). A plan that names `supersedes` confirms an
   * update: the old adoption must be the same user's, active, of the same
   * definition name; it is marked superseded.
   */
  async adopt(signed, ctx) {
    if (!(await verifyPlanSignature(signed))) return { ok: false, findings: [finding("PLAN_SIGNATURE_INVALID", "$.plan", {})] };
    const plan = signed.plan;
    const guard = () => {
      // an adoption that exists is reported as it is: "already" only while it can still run
      const existing = own(this.data.adoptions, signed.hash);
      if (existing) {
        const p = this.problem(signed.hash);
        return p ? { ok: false, findings: [finding(p, "$.plan", { by: existing.by })] } : { ok: true, findings: [], adoption: clone(existing), already: true };
      }
      if (plan.supersedes !== undefined && plan.supersedes !== null) {
        const old = own(this.data.adoptions, plan.supersedes);
        if (!old || old.state !== "active" || old.actor !== plan.actor || old.manifest.author !== plan.manifest.author || old.manifest.name !== plan.manifest.name) {
          return { ok: false, findings: [finding("SHAPE", "$.plan.supersedes", { detail: "names an active adoption of the same user and definition" })] };
        }
      }
      return null;
    };
    const early = guard();
    if (early) return early;
    const check = await preflight(signed, { ...ctx, adoptions: null });
    if (!check.ready) return { ok: false, findings: check.findings, preflight: check };
    // the preflight awaited: everything checked before it is checked again, with no await before the writes
    const late = guard();
    if (late) return late;
    const old = plan.supersedes ? own(this.data.adoptions, plan.supersedes) : null;
    this.data.seq += 1;
    const record = { planHash: signed.hash, actor: plan.actor, manifest: plan.manifest, seq: this.data.seq, day: ctx.world.today, state: "active", runs: {}, supersedes: old ? old.planHash : null };
    this.data.adoptions[signed.hash] = record;
    if (old) { old.state = "superseded"; old.by = signed.hash; }
    return { ok: true, findings: check.findings, adoption: clone(record), preflight: check };
  }

  /** The user ends their own adoption (signed with their key). */
  async end(planHash, signature) {
    const a = own(this.data.adoptions, planHash);
    if (!a) return { ok: false, findings: [finding("PLAN_NOT_ADOPTED", "$", {})] };
    if (!(await verifyHash(a.actor, DOMAIN.end, planHash, signature))) return { ok: false, findings: [finding("NOT_OWNER", "$", { detail: "only the plan's user ends it" })] };
    a.state = "ended";
    return { ok: true, findings: [] };
  }

  /** Spend a run request's nonce for a plan; false if it was used before. */
  useNonce(planHash, nonce) {
    const a = own(this.data.adoptions, planHash);
    if (!a) return false;
    a.nonces ??= {};
    if (Object.hasOwn(a.nonces, nonce)) return false;
    a.nonces[nonce] = true;
    return true;
  }

  /**
   * Runs started on a day, counted per user and definition (author/name):
   * the definition's runsPerDay holds however many plans the user adopts.
   */
  runsOn(planHash, day) {
    const a = own(this.data.adoptions, planHash);
    return a ? own(own(this.data.runs, runKey(a)), String(day)) ?? 0 : 0;
  }

  noteRun(planHash, day) {
    const a = own(this.data.adoptions, planHash);
    if (!a) return;
    this.data.runs ??= {};
    const k = runKey(a);
    this.data.runs[k] ??= {};
    this.data.runs[k][String(day)] = (this.data.runs[k][String(day)] ?? 0) + 1;
  }
}
