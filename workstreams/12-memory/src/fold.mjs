// Workstream 12: what one viewer knows at one bell, derived by a pure fold of the journal.
//
//   knowledge(records, viewer:{tag, nation}, bell) -> Knowledge
//
// Isolation is the first step: only records with bell <= `bell` and visible to `viewer` enter the fold. Nothing
// computed below can depend on a record the viewer cannot see, so another citizen's private conversation or
// sealed march cannot leak through a derived number either.
//
// Commitments are DERIVED, never stored: a `request` and a matching `accept` make a commitment whose state is
// `promised` (talk only: no authority, no contract, not done). It becomes `fulfilled` / `late` / `partial` only
// through a visible caravan_settled fact (DELIVERED, debtor -> creditor, enough cargo, after the accept); a
// `claim_delivered` utterance only attaches a claim. Past the due bell plus GRACE_BELLS with no matching fact it
// is `broken` (and `false_claim` when the debtor had claimed delivery). A raid or a lost destination is neutral.
//
// Reliability is a Beta-reputation estimate (Jøsang & Ismail 2002) with forgetting: positive evidence r and
// negative s, each item weighted 0.5^(age / HALF_LIFE_BELLS) (and by OBSERVED_WEIGHT when the viewer only
// watched someone else's public commitment); E = (r + 1) / (r + s + 2). It does not only go up: a broken promise
// adds to s, old evidence fades toward the prior 0.5, and every item names the records behind it.
// Testimony (what a third party says about a delivery) is shown and cross-checked, never counted.
import { OUTCOME, visibleTo } from './records.mjs';

export const GRACE_BELLS = 6;
export const HALF_LIFE_BELLS = 432; // 3 game days of 144 bells
export const OBSERVED_WEIGHT = 0.5;
export const FALSE_CLAIM_EXTRA = 0.5;

const round = x => Math.round(x * 1e6) / 1e6;

export function knowledge(records, viewer, bell) {
  const seen = records.filter(r => r.bell <= bell && visibleTo(r.visibility, viewer));
  const ids = new Set(seen.map(r => r.id));
  const byId = new Map(seen.map(r => [r.id, r]));

  // ---- facts, minus rolled-back ones
  const rolledBack = new Map();
  for (const r of seen) if (r.type === 'fact' && r.kind === 'rollback') rolledBack.set(r.data.fact, r.id);
  const facts = seen.filter(r => r.type === 'fact' && r.kind !== 'rollback' && !rolledBack.has(r.id));

  // ---- notes: active, corrected, expired
  const corrections = new Map();
  for (const r of seen) if (r.type === 'correction') corrections.set(r.target, r);
  const notes = [];
  for (const r of seen.filter(x => x.type === 'note')) {
    const c = corrections.get(r.id);
    const status = c ? 'corrected' : r.expires_bell !== null && r.expires_bell <= bell ? 'expired' : 'active';
    notes.push({ ...r, status, corrected_by: c?.id ?? null, replacement: c?.replacement ?? null });
  }

  // ---- commitments
  const utter = seen.filter(r => r.type === 'utterance' && r.act);
  const requests = new Map(utter.filter(u => u.act.type === 'request').map(u => [u.id, u]));
  const retracts = utter.filter(u => u.act.type === 'retract');
  const claims = utter.filter(u => u.act.type === 'claim_delivered');
  const declines = utter.filter(u => u.act.type === 'decline');
  const consumed = new Set();
  const commitments = [];
  const orderedFacts = [...facts].sort((a, b) => a.bell - b.bell || (a.id < b.id ? -1 : 1));

  for (const acc of utter.filter(u => u.act.type === 'accept').sort((a, b) => a.bell - b.bell || (a.id < b.id ? -1 : 1))) {
    const req = requests.get(acc.act.ref);
    if (!req) continue; // an accept of a request the viewer never saw: no commitment the viewer can know of
    if (req.speaker === acc.speaker || (req.act.to && req.act.to !== acc.speaker)) continue;
    const c = {
      id: acc.id, debtor: acc.speaker, creditor: req.speaker, resource: req.act.resource, qty: Math.min(acc.act.qty, req.act.qty),
      due_bell: acc.act.by_bell, made_bell: acc.bell, sources: [req.id, acc.id],
      authority: false, contract: false, // talk never grants authority or forms a contract (§ README)
      state: 'promised', resolved_bell: null, claims: [], fact: null, delivered: 0, false_claim: false,
      direct: viewer.tag === req.speaker,
    };
    c.claims = claims.filter(u => u.speaker === c.debtor && (u.act.ref === acc.id || u.act.ref === req.id)).map(u => u.id);
    const retract = retracts.find(u => u.speaker === c.debtor && (u.act.ref === acc.id || u.act.ref === req.id) && u.bell <= c.due_bell);
    const delivery = orderedFacts.find(f => f.kind === 'caravan_settled' && !consumed.has(f.id) && f.data.sender === c.debtor
      && f.data.recipient === c.creditor && f.bell > c.made_bell && (f.data.cargo[c.resource] ?? 0) > 0);
    const raid = orderedFacts.find(f => f.kind === 'caravan_raided' && f.data.sender === c.debtor && f.bell > c.made_bell
      && facts.some(s => s.kind === 'caravan_sent' && s.data.sender === c.debtor && s.data.seq === f.data.seq && s.data.recipient === c.creditor));
    if (delivery) {
      consumed.add(delivery.id);
      c.fact = delivery.id;
      c.sources.push(delivery.id);
      c.resolved_bell = delivery.bell;
      if (delivery.data.outcome === OUTCOME.LOST) c.state = 'lost';
      else {
        c.delivered = Math.min(delivery.data.cargo[c.resource], c.qty);
        c.state = c.delivered < c.qty ? 'partial' : delivery.bell <= c.due_bell + GRACE_BELLS ? 'fulfilled' : 'late';
      }
    } else if (raid) {
      c.state = 'raided'; c.fact = raid.id; c.sources.push(raid.id); c.resolved_bell = raid.bell;
    } else if (retract) {
      c.state = 'withdrawn'; c.sources.push(retract.id); c.resolved_bell = retract.bell;
    } else if (bell > c.due_bell + GRACE_BELLS) {
      c.state = 'broken'; c.resolved_bell = c.due_bell + GRACE_BELLS; c.false_claim = c.claims.length > 0;
    } else if (c.claims.length) {
      c.state = 'claimed_unverified';
    }
    c.sources.push(...c.claims);
    commitments.push(c);
  }
  const declined = declines.filter(d => requests.has(d.act.ref)).map(d => ({ id: d.id, by: d.speaker, request: d.act.ref }));

  // ---- testimony: shown, cross-checked against what the viewer can verify, never counted
  const byCommit = new Map(commitments.map(c => [c.id, c]));
  const testimonies = utter.filter(u => u.act.type === 'testimony').map(u => {
    const c = byCommit.get(u.act.ref);
    let check = 'unverifiable';
    if (c && c.debtor === u.act.about) {
      const delivered = ['fulfilled', 'late', 'partial'].includes(c.state);
      const failed = c.state === 'broken';
      if (delivered || failed) check = (u.act.says === 'delivered') === delivered ? 'consistent' : 'contradicted_by_fact';
    }
    return { id: u.id, by: u.speaker, about: u.act.about, ref: u.act.ref, says: u.act.says, check };
  });
  const groups = new Map();
  for (const t of testimonies) { const k = `${t.about}|${t.ref}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(t); }
  for (const g of groups.values()) if (new Set(g.map(t => t.says)).size > 1) for (const t of g) t.conflicting = true;

  // ---- reliability per debtor
  const reliability = {};
  for (const c of commitments) {
    if (c.debtor === viewer.tag) continue;
    const rel = (reliability[c.debtor] ??= { r: 0, s: 0, E: 0.5, n_direct: 0, n_observed: 0, evidence: [] });
    let dr = 0, ds = 0;
    switch (c.state) {
      case 'fulfilled': dr = 1; break;
      case 'late': dr = 0.5; ds = 0.5; break;
      case 'partial': dr = c.delivered / c.qty; ds = 1 - dr; break;
      case 'broken': ds = 1 + (c.false_claim ? FALSE_CLAIM_EXTRA : 0); break;
      default: break; // promised, claimed_unverified, raided, lost, withdrawn: no evidence either way
    }
    const w = (dr || ds) ? 0.5 ** ((bell - c.resolved_bell) / HALF_LIFE_BELLS) * (c.direct ? 1 : OBSERVED_WEIGHT) : 0;
    rel.r += dr * w; rel.s += ds * w;
    if (dr || ds) c.direct ? rel.n_direct++ : rel.n_observed++;
    rel.evidence.push({ commitment: c.id, state: c.state, direct: c.direct, weight: round(w), dr: round(dr * w), ds: round(ds * w), sources: [...c.sources] });
  }
  for (const rel of Object.values(reliability)) { rel.r = round(rel.r); rel.s = round(rel.s); rel.E = round((rel.r + 1) / (rel.r + rel.s + 2)); }

  return { viewer: { ...viewer }, bell, ids, byId, facts, rolledBack: [...rolledBack.keys()], notes, commitments, declined, testimonies, reliability };
}

/** The prior a viewer holds of a partner it has no evidence about. */
export const reliabilityOf = (k, tag) => k.reliability[tag] ?? { r: 0, s: 0, E: 0.5, n_direct: 0, n_observed: 0, evidence: [] };
