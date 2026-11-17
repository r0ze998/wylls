/**
 * A MOCK ledger of evidence, standing in for ④'s Receipt.
 *
 * A record here proves that a step of a run finished, with what outcome,
 * where and with what goods. It is the proof of a past event and nothing
 * more: it is never spent, any number of plans may cite it, and it creates
 * no goods. The right to consume the goods a delivery brought is a batch in
 * the world (execute.mjs), which points at its evidence.
 *
 * Nothing here touches a chain. A record's id is the hash of its content
 * and it counts only if this ledger holds it. In the real game the record
 * would be the program's log (CARAVAN_SETTLED, USE_RUN …) judged by the
 * verifier, and finality would be the chain's, not a boolean here; and only
 * the run itself could write it (here anyone holding the object can call
 * `record`, which is why a record alone must never yield goods).
 */

import { clone, contentHash, own } from "./canonical.mjs";
import { satisfies } from "./semver.mjs";

export const RECEIPT_FORMAT = "wylls.mock.receipt/0";

export class Ledger {
  constructor(data = { receipts: {} }) {
    this.data = clone(data);
  }

  toJSON() {
    return clone(this.data);
  }

  /** Record a receipt body; its id is its hash. */
  record(body) {
    const r = { format: RECEIPT_FORMAT, mock: true, ...body };
    const id = contentHash(r);
    this.data.receipts[id] = r;
    return { id, receipt: clone(r) };
  }

  get(id) {
    const r = own(this.data.receipts, id);
    return r ? clone(r) : null;
  }

  /**
   * Whether a claimed record proves a finished result of the expected kind.
   * `claim` is an id, or a receipt object someone presents (its id is
   * recomputed, so an edited copy is caught). Returns null or a reason.
   */
  check(claim, expect) {
    let id = claim, presented = null;
    if (claim && typeof claim === "object") {
      presented = claim.receipt ?? claim;
      id = claim.id ?? null;
      let actual;
      try { actual = contentHash(presented); } catch { return { reason: "tampered", detail: "the receipt has no canonical form" }; }
      if (id && id !== actual) return { reason: "tampered", detail: "the receipt's content does not hash to its id" };
      id = actual;
    }
    if (typeof id !== "string") return { reason: "unbound" };
    const r = own(this.data.receipts, id);
    if (!r) return { reason: presented ? "not-in-ledger" : "unknown", id };
    if (!r.final) return { reason: "not-final", id };
    if (expect.producer) {
      const p = expect.producer;
      if (r.manifest.author !== p.author || r.manifest.name !== p.name) return { reason: "wrong-producer", id, producer: r.manifest };
      if (p.range && !satisfies(r.manifest.version, p.range)) return { reason: "wrong-version", id, version: r.manifest.version, range: p.range };
      if (p.hash && r.manifest.hash !== p.hash) return { reason: "wrong-version", id, detail: "hash differs from the pinned one" };
    }
    if (expect.output && !(r.outputs ?? []).includes(expect.output)) return { reason: "wrong-output", id, outputs: r.outputs ?? [] };
    if (expect.outcomeOk && !expect.outcomeOk.includes(r.outcome)) return { reason: "failed-run", id, outcome: r.outcome };
    if (expect.beneficiary && r.beneficiary !== expect.beneficiary) return { reason: "not-beneficiary", id, beneficiary: r.beneficiary };
    return null;
  }
}
