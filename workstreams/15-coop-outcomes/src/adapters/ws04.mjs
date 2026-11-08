// ④'s Run Receipts → evaluator events. Written from ④'s contract as relayed
// (workstreams/04-execution/docs/CONTRACTS.ja.md at bd415e7430dafe7284f7bbf7bbce1f78940b2ec6,
// integration HEAD 967ffc015a03c566784934c9f69afaad971c0e56); not checked
// against ④'s code. A receipt is
// `{run_id, kind, subject, source, slot, body}` with `kind` one of
// facility_used | caravan_sent | caravan_raided | caravan_settled.
//
// The body fields read here are ASSUMED from the relayed outcome type:
//   caravan_sent     {owner_tag, seq, cargo: [8], dst}
//   caravan_settled  {owner_tag, seq, cargo: [8], credited?: [8], verification}
//   caravan_raided   {owner_tag, seq, choice: 'take'|'burn', taken: [8], raider_tag}
// `verification` is ④'s Recorded | RuleDerived | Unverifiable | KnownZero | NotShipped.
//
// ④ and ① disagree on a village arrival without `credited`: ④ calls the
// logged cargo the delivered amount (RuleDerived), ① a lower bound. The
// caller picks (`ruleDerivedAs`); the default is ①'s, the more cautious.
import { canonical } from '../canon.mjs';
import { SLOT_RESOURCES } from './s1-chain.mjs';

export const VERIFICATION = Object.freeze({
  Recorded: 'chain',
  Unverifiable: 'unverified',
  KnownZero: 'chain',
});

// Slots are the chain's own clock and do not restart with a season; Citizen tags and caravan
// numbers do, so for receipts from more than one season give `epoch` (ids are namespaced by it).
export function fromRunReceipts(receipts, map, { stream = 'ws04', ruleDerivedAs = 'chain_lower_bound', epoch = null } = {}) {
  const ns = epoch === null ? '' : `${epoch}:`;
  const events = [];
  const skipped = [];
  // ④ removes duplicates by sig ‖ instruction position ‖ log position; its `source` names that.
  // The same key with the same content is one receipt; with other content, both are emitted
  // under one id and position, and the evaluator's record check sets both aside as a conflict.
  // The order is total (content breaks ties), so the input's order does not matter.
  const keyOf = r => `${r.kind}|${r.source}|${r.subject}`;
  const sorted = [...receipts].map(r => ({ r, k: keyOf(r), c: canonical(r) })).sort((a, b) => a.r.slot - b.r.slot || (a.k < b.k ? -1 : a.k > b.k ? 1 : a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
  const seqOf = new Map();
  const seen = new Set();
  let seq = 0;
  for (const { r, k, c } of sorted) {
    if (seen.has(c)) { skipped.push({ source: r.source, why: 'duplicate receipt' }); continue; }
    seen.add(c);
    if (!seqOf.has(k)) seqOf.set(k, seq++);
    const b = r.body ?? {};
    const at = map.bellOfSlot(r.slot);
    const s = seqOf.get(k);
    let sub = 0;
    const emit = (kind, fields, verified) => events.push({ id: `${stream}:${s}:${sub}`, stream, seq: s, sub: sub++, at, kind, verified, ...fields, src: { source: r.source } });
    const ship = res => `cv:${ns}${b.owner_tag}:${b.seq}:${res}`;
    if (r.kind === 'caravan_sent') {
      const from = map.actorOfTag(b.owner_tag);
      const dst = map.destination(b.dst, b.owner_tag, b.seq);
      if (!from || !dst) { skipped.push({ source: r.source, why: 'unresolved (left as a gap)' }); continue; }
      b.cargo.forEach((q, i) => { if (q && SLOT_RESOURCES[i]) emit('ship.send', { ship: ship(SLOT_RESOURCES[i]), from, to: dst.project ? `project:${dst.project}` : dst.actor, resource: SLOT_RESOURCES[i], qty: q }, 'chain'); });
    } else if (r.kind === 'caravan_settled') {
      const v = b.verification === 'RuleDerived' ? ruleDerivedAs : VERIFICATION[b.verification] ?? 'unverified';
      const amounts = b.credited ?? b.cargo;
      b.cargo.forEach((q, i) => { if (q && SLOT_RESOURCES[i]) emit('ship.arrive', { ship: ship(SLOT_RESOURCES[i]), qty: b.verification === 'KnownZero' ? 0 : amounts[i] }, v); });
    } else if (r.kind === 'caravan_raided') {
      const raider = map.actorOfTag(b.raider_tag);
      const sent = map.cargoSent(b.owner_tag, b.seq);
      if (!raider || !sent) { skipped.push({ source: r.source, why: 'unresolved (left as a gap)' }); continue; }
      sent.forEach((q, i) => {
        if (!q || !SLOT_RESOURCES[i]) return;
        const take = b.choice === 'take' ? b.taken[i] : 0;
        emit('ship.raid', { ship: ship(SLOT_RESOURCES[i]), raider, taken: take, burned: q - take }, 'chain');
      });
    } else { skipped.push({ source: r.source, why: `${r.kind} not mapped (facility use is not a goal stage here)` }); emit('position', {}, 'chain'); }
    if (!sub) emit('position', {}, 'chain');
  }
  return { events, skipped };
}
