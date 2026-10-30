// One Citizen, two actors: the owner's own MCP client (③) and ⑤'s autopilot, on the same agent (same capability,
// same relay ledger, same daily budget, the Citizen's one session key and its one sponsored-transaction quota).
// This is ⑤'s side of the boundary, from what the relay already shows (agent_view): nothing here is ③'s contract,
// which is not received. The rules are owner-first:
//
//   seq       ⑤ marks the relay history's sequence number when it observes. Right before it acts, any entry after
//             that mark that is not ⑤'s own (an action of another client, an owner command, a withdrawal) means the
//             owner acted in between: ⑤ does not act on that observation (OwnerActed). If the visible window no longer
//             reaches back to the mark, ⑤ cannot tell, and does not act either (HistoryGap).
//   budget    the relay's day budget and the Citizen's quota are shared. ⑤ leaves the owner a reserve of each:
//             it decides and acts only while what is left after its next step stays at or above the reserve.
//   attribution  ⑤'s actions carry requestIds 'p05.…'; through the MCP server the relay records them as
//             'mcp:p05.…' (source mcp, today) or 'ai:p05.…' (source ai, with the proposed patch 0003). Anything else is
//             not ⑤'s. Without patch 0003 the relay's `source` field cannot tell ⑤ from ③: only the key prefix can.
//
// What ③ must still state for this to be a contract, not ⑤'s assumption: §"from ③" in HANDOFF-3.ja.md.
const OWN = /^(mcp|ai):p05\./;
const OWNER_TYPES = new Set(['mode', 'policy', 'withdraw', 'withdrawal', 'capability', 'rotate', 'deposit']);

/** Who an entry of the relay history is, as far as ⑤ can tell. */
export function actorOf(h) {
  if (h.type === 'action') {
    if (OWN.test(String(h.key ?? ''))) return 'autopilot (⑤)';
    if (h.source === 'browser') return 'owner (browser, wallet-signed)';
    if (h.source === 'mcp') return 'another MCP client on this agent (③ or the owner)';
    if (h.source === 'ai') return 'another ai client on this agent';
    return `unknown (${h.source})`;
  }
  if (h.type === 'decision') return 'relay runner';
  if (OWNER_TYPES.has(h.type)) return 'owner (command)';
  return 'relay (bookkeeping)';
}
const isForeign = h => (h.type === 'action' && !OWN.test(String(h.key ?? ''))) || OWNER_TYPES.has(h.type);

export class CitizenBoundary {
  /**
   * @param {object} [o]
   * @param {number} [o.ownerQuotaReserve]   sponsored transactions a day ⑤ leaves to the owner (default 1)
   * @param {string} [o.ownerBudgetReserve]  relay day-budget units ⑤ leaves to the owner (default '0')
   */
  constructor({ ownerQuotaReserve = 1, ownerBudgetReserve = '0' } = {}) {
    this.ownerQuotaReserve = ownerQuotaReserve;
    this.ownerBudgetReserve = BigInt(ownerBudgetReserve);
    this.status = 'LOCAL: ⑤\'s side only; ③\'s contract not received';
  }

  /** The mark of an observation. */
  mark(view) { return { seq: view.historySeq, at: view.history?.at(-1)?.at ?? null }; }

  /** Entries after `mark` that are not ⑤'s, or {gap: true} when the visible window does not reach back to it. */
  since(view, mark) {
    const h = view.history ?? [];
    const first = h[0]?.seq ?? view.historySeq + 1;
    if (view.historySeq > mark.seq && first > mark.seq + 1) return { gap: true, entries: [] };
    return { gap: false, entries: h.filter(x => x.seq > mark.seq && isForeign(x)).map(x => ({ seq: x.seq, type: x.type, source: x.source ?? null, key: x.key ?? null, actor: actorOf(x) })) };
  }

  /** Before deciding (and paying for a model call): is there room left for ⑤ after the owner's reserve? */
  beforeDecide(view, { nextGamePrice = '0' } = {}) {
    const reasons = [];
    if (view.quota && view.quota.left - 1 < this.ownerQuotaReserve) reasons.push({ code: 'QuotaReservedForOwner', detail: `${view.quota.left} sponsored transactions left today; ${this.ownerQuotaReserve} kept for the owner` });
    const perDay = view.policy?.budget?.perDay;
    if (perDay !== undefined && perDay !== null) {
      const left = BigInt(perDay) - BigInt(view.day?.spent ?? '0') - BigInt(view.balance?.reserved ?? '0');
      if (left - BigInt(nextGamePrice) < this.ownerBudgetReserve) reasons.push({ code: 'BudgetReservedForOwner', detail: `day budget left ${left}, next game price ${nextGamePrice}, kept for the owner ${this.ownerBudgetReserve}` });
    }
    return { ok: reasons.length === 0, reasons };
  }

  /** Right before an act: the owner has not acted since the observation, and the reserves still hold. */
  beforeAct(observedView, nowView, { nextGamePrice = '0' } = {}) {
    const s = this.since(nowView, this.mark(observedView));
    if (s.gap) return { ok: false, code: 'HistoryGap', detail: 'the relay history no longer reaches back to the observation: whether the owner acted is unknown' };
    if (s.entries.length) return { ok: false, code: 'OwnerActed', detail: s.entries.map(e => `#${e.seq} ${e.type}${e.key ? ` ${e.key}` : ''} (${e.actor})`).join('; '), entries: s.entries };
    const b = this.beforeDecide(nowView, { nextGamePrice });
    return b.ok ? { ok: true } : { ok: false, code: b.reasons[0].code, detail: b.reasons[0].detail };
  }
}
