// Workstream 12: summaries and retrieval that keep their sources.
//
//   summarize(k) -> [{about, text, epistemic, sources:[ids]}]
//   memoryLines(k, tags) -> lines about those partners only (for a decision input)
//   renderBlock(lines) -> text with every line ending in its source ids
//
// A summary line is a compression of several records; it always carries the ids of every record it rests on,
// so "B: 1 fulfilled" can be expanded back to the request, the accept, the allocation and the chain facts.
// Each line says what kind of knowledge it is:
//   verified     a chain record or 4's attestation decided it
//   said         only words (a promise, a claim, a testimony)
//   interpreted  the owner's own note
//   unknown      something needed to decide it has not been observed (never read as a failure)
import { CLAIM_CRITERIA, VERIFIED_STATES, reliabilityOf } from './fold.mjs';

const STATE_WORD = {
  fulfilled: 'delivered in full by the due bell (credited at the promised place)',
  late: 'delivered in full after the due bell (credited at the promised place)',
  partial: 'delivered in part; a sufficient index shows nothing more was sent',
  not_sent: 'not sent: a sufficient index (world, season, every send route, gapless, finalized) shows no caravan to the promised place',
  raided: 'the allocated caravan was raided (not counted against the sender)',
  lost: 'the allocated caravan was lost at the destination (not counted)',
  recipient_changed: 'delivered, but the place had another owner at the settle bell (not counted)',
  withdrawn: 'withdrawn before the due bell (not counted)',
  promised: 'promised only (talk; nothing granted, nothing delivered yet)',
  claimed_unverified: 'the sender claims progress; no record yet',
  in_progress: 'a caravan is allocated; not settled and credited yet',
  unconfirmed: 'past the due bell but not decided',
};
const REASON_WORD = {
  no_record_found: 'no record found', lookup_failed: 'the index could not be queried', caravan_unknown: 'the allocated caravan has no departure record yet',
  in_transit: 'in transit', settle_unobserved: 'past its arrival time with no settle record', recipient_unverified: 'owner at the settle bell not attested',
  recipient_conflict: 'conflicting owner attestations', qty_unverified: 'settled, credited amount not measured', record_conflict: 'conflicting records',
  qty_split_ambiguous: 'a short credit shared by several allocations', coverage_caravan_unresolved: 'the index lists a caravan without its departure record',
  unassigned_caravan: 'a caravan to the place exists but nobody allocated it',
  coverage_insufficient: 'the index attestation does not prove the sender sent nothing',
};

export function epistemicOf(state) {
  if (VERIFIED_STATES.includes(state) || ['raided', 'lost', 'recipient_changed'].includes(state)) return 'verified';
  if (state === 'unconfirmed') return 'unknown';
  return 'said';
}

export function commitmentLine(c) {
  let text = `${c.debtor} -> ${c.creditor}: ${c.qty} ${c.resource} due bell ${c.due_bell}: ${STATE_WORD[c.state]}`;
  if (c.delivered_max > 0 && c.state !== 'fulfilled') {
    text += c.delivered_min === c.delivered_max ? ` (credited ${c.delivered_min} of ${c.qty})` : ` (credited ${c.delivered_min} of ${c.qty} so far; up to ${c.delivered_max} still possible)`;
  }
  if (c.reasons.length) text += ` (${c.reasons.map(r => REASON_WORD[r] ?? r).join('; ')}${c.coverage_gaps?.length ? `: ${c.coverage_gaps.join(', ')}` : ''})`;
  const bases = [...new Set(c.links.filter(l => l.credit).map(l => (l.credit.basis === 'rule_derived' ? `credit by rule ${l.credit.rule}, ${l.credit.unit}` : l.credit.basis === 'exec_record' ? `credit by execution record, ${l.credit.unit}` : 'credit not verifiable (vault)')))];
  if (bases.length) text += ` [${bases.join('; ')}]`;
  for (const cl of c.claims) if (cl.status !== 'consistent') text += `; ${cl.kind.replace('_', ' ')}: ${cl.status}${cl.criterion ? ` (${CLAIM_CRITERIA[cl.criterion]})` : ''}`;
  return { about: c.debtor, commitment: c.id, text, epistemic: epistemicOf(c.state), sources: [...c.sources] };
}

export function summarize(k) {
  const lines = [];
  const debtors = [...new Set(k.commitments.map(c => c.debtor))].filter(t => t !== k.viewer.tag).sort();
  for (const t of debtors) {
    const cs = k.commitments.filter(c => c.debtor === t);
    const rel = reliabilityOf(k, t);
    const v = rel.verified;
    const nv = v.fulfilled + v.late + v.partial + v.not_sent;
    const text = `${t}: verified ${v.fulfilled} fulfilled, ${v.late} late, ${v.partial} partial, ${v.not_sent} not sent; `
      + `${rel.unresolved.length} open or unconfirmed; ${rel.neutral.length} neutral; claims ${rel.claims.contradicted} false, ${rel.claims.mismatch} mismatched, `
      + `${rel.claims.unverified} unverified; reliability estimate ${rel.E} (verified evidence only)`;
    lines.push({ about: t, text, epistemic: nv ? 'verified' : rel.unresolved.length ? 'unknown' : 'said', sources: [...new Set(cs.flatMap(c => c.sources))].sort() });
    for (const c of cs) lines.push(commitmentLine(c));
  }
  for (const t of k.testimonies) lines.push(testimonyLine(t, true));
  for (const n of k.notes.filter(x => x.status === 'active')) lines.push({ about: n.about, text: `own note: ${n.text}`, epistemic: 'interpreted', sources: [n.id, ...n.sources] });
  return lines;
}

const testimonyLine = (t, flagConflict) => ({ id: t.id, about: t.about,
  text: `${t.by} says ${t.about} ${t.says === 'delivered' ? 'delivered' : 'did not deliver'} (${t.check}${flagConflict && t.conflicting ? ', conflicting testimony' : ''}; not counted)`,
  epistemic: 'said', sources: [t.id] });

/** Lines about the given partners: each of their commitments, testimonies about them, own active notes about them. */
export function memoryLines(k, tags) {
  const want = new Set(tags);
  const out = [];
  for (const c of k.commitments) if (want.has(c.debtor)) out.push({ id: c.id, ...commitmentLine(c) });
  for (const t of k.testimonies) if (want.has(t.about)) out.push(testimonyLine(t, true));
  for (const n of k.notes) if (n.status === 'active' && want.has(n.about)) out.push({ id: n.id, about: n.about, text: `own note: ${n.text}`, epistemic: 'interpreted', sources: [n.id, ...n.sources] });
  return out;
}

export const renderBlock = lines => lines.map(l => `- [${l.epistemic}] ${l.text} {src: ${l.sources.join(',')}}`).join('\n');
