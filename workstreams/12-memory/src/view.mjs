// Workstream 12: summaries and retrieval that keep their sources.
//
//   summarize(k) -> [{about, text, epistemic, sources:[ids]}]
//   memoryLines(k, tags) -> lines about those partners only (for a decision input)
//   renderBlock(lines) -> text with every line ending in its source ids
//
// A summary line is a compression of several records; it always carries the ids of every record it rests on,
// so "B kept 2 of 3" can be expanded back to the request, the accept and the chain fact. Lines say which kind of
// knowledge they are: verified (a fact decided it), said (only words), interpreted (the owner's own note).
import { reliabilityOf } from './fold.mjs';

const STATE_WORD = {
  fulfilled: 'delivered in full (chain-verified)', late: 'delivered late (chain-verified)', partial: 'delivered in part (chain-verified)',
  broken: 'no delivery record by the due bell plus grace', raided: 'caravan raided on the way (not counted against the sender)',
  lost: 'caravan lost at the destination (not counted)', withdrawn: 'withdrawn before the due bell (not counted)',
  promised: 'promised only (talk; nothing granted, nothing delivered yet)', claimed_unverified: 'sender says delivered; no chain record yet',
};

export function commitmentLine(c) {
  // verified: a chain fact decided it. broken: code's conclusion from the ABSENCE of a fact by the due bell (interpreted).
  const epistemic = ['fulfilled', 'late', 'partial', 'raided', 'lost'].includes(c.state) ? 'verified' : c.state === 'broken' ? 'interpreted' : 'said';
  let text = `${c.debtor} -> ${c.creditor}: ${c.qty} ${c.resource} due bell ${c.due_bell}: ${STATE_WORD[c.state]}`;
  if (c.state === 'partial') text += ` (${c.delivered} of ${c.qty})`;
  if (c.false_claim) text += '; the sender had claimed delivery (no chain record)';
  return { about: c.debtor, commitment: c.id, text, epistemic, sources: [...c.sources] };
}

export function summarize(k) {
  const lines = [];
  const debtors = [...new Set(k.commitments.map(c => c.debtor))].filter(t => t !== k.viewer.tag).sort();
  for (const t of debtors) {
    const cs = k.commitments.filter(c => c.debtor === t);
    const rel = reliabilityOf(k, t);
    const kept = cs.filter(c => ['fulfilled', 'late', 'partial'].includes(c.state)).length;
    const broken = cs.filter(c => c.state === 'broken').length;
    lines.push({ about: t, text: `${t}: ${kept} kept, ${broken} broken, ${cs.length - kept - broken} other of ${cs.length} known promises; reliability estimate ${rel.E}`,
      epistemic: kept ? 'verified' : broken ? 'interpreted' : 'said', sources: [...new Set(cs.flatMap(c => c.sources))].sort() });
    for (const c of cs) lines.push(commitmentLine(c));
  }
  for (const t of k.testimonies) {
    lines.push({ about: t.about, text: `${t.by} says ${t.about} ${t.says === 'delivered' ? 'delivered' : 'did not deliver'} (${t.check}${t.conflicting ? ', conflicting testimony' : ''}; not counted)`,
      epistemic: 'said', sources: [t.id] });
  }
  for (const n of k.notes.filter(x => x.status === 'active')) lines.push({ about: n.about, text: `own note: ${n.text}`, epistemic: 'interpreted', sources: [n.id, ...n.sources] });
  return lines;
}

/** Lines about the given partners: each of their commitments, testimonies about them, own active notes about them. */
export function memoryLines(k, tags) {
  const want = new Set(tags);
  const out = [];
  for (const c of k.commitments) if (want.has(c.debtor)) out.push({ id: c.id, ...commitmentLine(c) });
  for (const t of k.testimonies) if (want.has(t.about)) out.push({ id: t.id, about: t.about, text: `${t.by} says ${t.about} ${t.says === 'delivered' ? 'delivered' : 'did not deliver'} (${t.check}; not counted)`, epistemic: 'said', sources: [t.id] });
  for (const n of k.notes) if (n.status === 'active' && want.has(n.about)) out.push({ id: n.id, about: n.about, text: `own note: ${n.text}`, epistemic: 'interpreted', sources: [n.id, ...n.sources] });
  return out;
}

export const renderBlock = lines => lines.map(l => `- [${l.epistemic}] ${l.text} {src: ${l.sources.join(',')}}`).join('\n');
