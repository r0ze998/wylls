// Workstream 12: what one viewer knows, derived by a pure fold of the journal (fold v3).
//
//   knowledge(records, viewer:{tag, nation}, clock, {observedBy = clock, world = null}) -> Knowledge
//
// Two clocks. `clock` is the game bell at which states are judged (is a due bell past?); `observedBy` bounds what
// had been OBSERVED (record.created_bell). Normally both are "now". To reassess a past decision with evidence that
// arrived later, judge at the decision's bell with `observedBy` = now (index.mjs `reassess`).
//
// Isolation is the first step: only records visible to `viewer` enter the fold, so nothing derived below can
// depend on a record the viewer cannot see.
//
// What this fold will NOT do (the rules of the second and third reviews):
//   - treat a missing record as a failure or a lie. A missing record is `unconfirmed`. "Not sent" is verified only
//     by a SUFFICIENT coverage attestation (coverageSufficiency: the memory's world and season, the sender, the
//     whole window, every send route, a gapless slot range, finalized) and a lie only when a claimed caravan does
//     not exist in such an index (criteria below). Not sent and not arrived are different: a caravan that left
//     and has no settle record is unknown, never "not sent";
//   - pair a promise with a delivery by guesswork. Only a SIGNED allocation by a party names which caravan, and
//     how much of it, is for which commitment. Per signer, commitment and caravan the operation with the highest
//     nonce is the one in force (a correction replaces, a revoke removes, a resend is a duplicate). It must match
//     sender, place (with its generation), resource and the caravan's capacity, used up in the order the
//     operations in force were signed, across ALL commitments. A caravan nobody allocated stays `unassigned`;
//   - read DELIVERED as the amount received or as "the creditor received it". The quantity of a delivery to a
//     HOLDING is derived by the pinned rule CREDIT_RULES (the settle credits the whole cargo, uncapped); for a
//     VAULT (capped by its stock at that instant) only 4's per-delivery execution record gives it, else it stays
//     `qty_unverified`. A balance difference is never used. The recipient is the place's owner AT THE SETTLE
//     BELL from a `place_owner` attestation; without one it is `recipient_unverified`, and a different owner is
//     `recipient_changed` (neutral);
//   - judge timeliness by when a record was observed. On time / late compares the settle's chain bell with the
//     due bell; a settle observed late is still on time.
//
// Commitment states:
//   verified:   fulfilled | late | partial | not_sent
//   neutral:    raided | lost | recipient_changed | withdrawn       (the sender is not judged on these)
//   open:       promised | claimed_unverified | in_progress         (before the due bell plus grace)
//   unknown:    unconfirmed (+ reasons)                             (after it, with something not yet known)
//
// Reliability is a Beta-reputation estimate (Jøsang & Ismail 2002) over VERIFIED evidence only, with
// forgetting; unknowns are listed beside it and never move it. Every weight below is provisional (WEIGHTS).
import { OUTCOME, PLACE, SEND_ROUTES, caravanKey, canonical, placeKey, visibleTo } from './records.mjs';

export const WEIGHTS = Object.freeze({
  provisional: true,
  grace_bells: 6, // a delivery settled by due + grace is on time
  half_life_bells: 432, // evidence weight halves every 3 game days
  observed_weight: 0.5, // a public commitment the viewer only watched counts half
  false_claim_weight: 0.5, // added to s for a claim contradicted by a complete index (criteria: CLAIM_CRITERIA)
  claim_slack_bells: 2, // a claim made up to this many bells before the record still counts as consistent
});
export const GRACE_BELLS = WEIGHTS.grace_bells;
export const HALF_LIFE_BELLS = WEIGHTS.half_life_bells;

/** What makes a claim FALSE (counted) versus a MISMATCH (shown, not counted as dishonesty). */
export const CLAIM_CRITERIA = Object.freeze({
  caravan_absent_in_complete_index: 'false: the named caravan is not among the sender\'s caravans in a sufficient coverage (world, season, every send route, gapless, finalized) from the promise to the claim',
  no_caravan_to_place_in_complete_index: 'false: a sufficient coverage (world, season, every send route, gapless, finalized) shows no caravan by the sender to the promised place between the promise and the claim',
  caravan_of_another: 'mismatch: the named caravan belongs to someone else',
  caravan_to_other_place: 'mismatch: the named caravan went to another place or generation',
  premature: 'mismatch: the record (departure or settle) came after the claim',
  not_delivered_by_record: 'mismatch: the named caravan was raided or lost',
});

/**
 * The per-delivery credit the memory may derive itself. One rule, pinned to the code it restates:
 * permutation-frontier/src/proc/caravan.rs settle_caravan credits each cargo resource to a live holding with
 * Holding::credit, which calls Store::add ("may exceed the cap", permutation-rules/src/frontier/holding.rs), after
 * settling production up to the same instant; so this delivery adds exactly its cargo. The settle log carries the
 * cargo in whole units, floor(milli / 1000) (cargo_log), so the derived credit is that whole number, a lower bound
 * exact to below one unit. A vault caps the addition by its stock and cap at that instant (min(have + c,
 * max(cap, have))): not derivable from the records, so no rule for it.
 */
export const CREDIT_RULES = Object.freeze({
  'holding-credit-uncapped/v1': Object.freeze({ place_kind: PLACE.HOLDING, unit: 'whole_units', precision: 'floor of milli-units: exact lower bound',
    code: ['permutation-frontier/src/proc/caravan.rs settle_caravan (KIND_HOLDING branch, cargo_log)', 'permutation-rules/src/frontier/holding.rs Holding::credit, Store::add'] }),
});

/** Is a coverage attestation enough to prove "not sent"? Returns the missing conditions (empty = sufficient). */
export function coverageSufficiency(cov, world) {
  const why = [];
  if (!world) why.push('memory_world_unset');
  else if (canonical(cov.data.world) !== canonical(world)) why.push('other_world_or_season');
  if (cov.data.finality !== 'finalized') why.push(`not_finalized:${cov.data.finality}`);
  if (!cov.data.completeness.gapless) why.push('slot_range_has_gaps');
  for (const r of SEND_ROUTES) if (!cov.data.routes.includes(r)) why.push(`route_missing:${r}`);
  return why;
}

export const VERIFIED_STATES = Object.freeze(['fulfilled', 'late', 'partial', 'not_sent']);
export const NEUTRAL_STATES = Object.freeze(['raided', 'lost', 'recipient_changed', 'withdrawn']);
const PENDING_LINK = new Set(['caravan_unknown', 'lookup_failed', 'in_transit', 'settle_unobserved', 'recipient_unverified', 'recipient_conflict', 'qty_unverified', 'record_conflict']);
const INVALID_LINK = new Set(['not_debtor_caravan', 'wrong_resource', 'over_allocated', 'not_a_party', 'revoked']);

const round = x => Math.round(x * 1e6) / 1e6;
const byBellId = (a, b) => a.bell - b.bell || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const group = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); (m.get(k) ?? m.set(k, []).get(k)).push(x); } return m; };

export function knowledge(records, viewer, clock, { observedBy = clock, world = null } = {}) {
  const seen = records.filter(r => r.bell <= clock && (r.created_bell ?? r.bell) <= observedBy && visibleTo(r.visibility, viewer));
  const ids = new Set(seen.map(r => r.id));
  const byId = new Map(seen.map(r => [r.id, r]));

  // ---- facts, minus rolled-back ones
  const rolledBack = new Map();
  for (const r of seen) if (r.type === 'fact' && r.kind === 'rollback') rolledBack.set(r.data.fact, r.id);
  const facts = seen.filter(r => r.type === 'fact' && r.kind !== 'rollback' && !rolledBack.has(r.id)).sort(byBellId);
  const ofKind = k => facts.filter(f => f.kind === k);
  const sentBy = group(ofKind('caravan_sent'), f => caravanKey(f.data.caravan));
  const settledBy = group(ofKind('caravan_settled'), f => caravanKey(f.data.caravan));
  const creditBy = group(ofKind('caravan_credited'), f => caravanKey(f.data.caravan));
  const raidBy = group(ofKind('caravan_raided'), f => caravanKey(f.data.caravan));
  const owners = ofKind('place_owner');
  const coverages = ofKind('coverage');
  const lookupFails = ofKind('lookup_failed');
  // one fact per caravan and kind, or a conflict (two different records for the same caravan)
  const one = (map, key) => { const l = map.get(key) ?? []; if (!l.length) return { f: null }; return new Set(l.map(f => f.body_sha)).size > 1 ? { conflict: l } : { f: l[0] }; };

  /** The owner of `place` at `bell` per the visible attestations: {owner, basis} | {unverified} | {conflict}. */
  function ownerAt(place, bell) {
    const k = placeKey(place);
    const hits = owners.filter(o => placeKey(o.data.place) === k && o.data.from_bell <= bell && bell <= (o.data.to_bell ?? o.bell));
    const who = [...new Set(hits.map(o => o.data.owner))];
    if (!who.length) return { unverified: true };
    if (who.length > 1) return { conflict: true, basis: hits.map(o => o.id) };
    return { owner: who[0], basis: hits.map(o => o.id) };
  }

  /**
   * Is the sender's departure log proven complete over [from, to]? Only sufficient attestations count; contiguous
   * ones are merged. When it is not proven, `insufficient` says what the attestations that exist lack.
   */
  function covered(sender, from, to) {
    const mine = coverages.filter(c => c.data.sender === sender);
    const insufficient = [];
    const good = [];
    for (const c of mine) { const why = coverageSufficiency(c, world); if (why.length) insufficient.push(...why); else good.push(c); }
    const iv = good.sort((a, b) => a.data.from_bell - b.data.from_bell);
    let reach = null; const basis = []; const listed = [];
    for (const c of iv) {
      if (c.data.to_bell < from) continue;
      if (reach === null) { if (c.data.from_bell > from) break; reach = c.data.to_bell; }
      else if (c.data.from_bell <= reach + 1) reach = Math.max(reach, c.data.to_bell);
      else break;
      basis.push(c.id); listed.push(...c.data.caravans);
      if (reach >= to) return { ok: true, basis, listed };
    }
    const failed = lookupFails.some(l => l.data.query === 'coverage' && l.data.sender === sender);
    return { ok: false, failed, insufficient: [...new Set(insufficient)].sort(), partial_range: good.length > 0,
      basis: [...(failed ? lookupFails.filter(l => l.data.query === 'coverage' && l.data.sender === sender).map(l => l.id) : []), ...mine.map(c => c.id)] };
  }

  // ---- notes: active, corrected, expired
  const corrections = new Map();
  for (const r of seen) if (r.type === 'correction') corrections.set(r.target, r);
  const notes = seen.filter(x => x.type === 'note').map(r => {
    const c = corrections.get(r.id);
    const status = c ? 'corrected' : r.expires_bell !== null && r.expires_bell <= clock ? 'expired' : 'active';
    return { ...r, status, corrected_by: c?.id ?? null, replacement: c?.replacement ?? null };
  });

  // ---- commitments (request + accept; talk only)
  const utter = seen.filter(r => r.type === 'utterance' && r.act).sort(byBellId);
  const acts = t => utter.filter(u => u.act.type === t);
  const requests = new Map(acts('request').map(u => [u.id, u]));
  const commitments = [];
  for (const acc of acts('accept')) {
    const req = requests.get(acc.act.ref);
    if (!req) continue; // an accept of a request the viewer never saw: no commitment the viewer can know of
    if (req.speaker === acc.speaker || (req.act.to && req.act.to !== acc.speaker)) continue;
    commitments.push({
      id: acc.id, request: req.id, debtor: acc.speaker, creditor: req.speaker, resource: req.act.resource,
      qty: Math.min(acc.act.qty, req.act.qty), place: req.act.place, due_bell: acc.act.by_bell, made_bell: acc.bell,
      authority: false, contract: false, // talk never grants authority or forms a contract
      direct: viewer.tag === req.speaker, sources: [req.id, acc.id],
    });
  }
  const commitById = new Map(commitments.map(c => [c.id, c]));
  const byRequest = group(commitments, c => c.request);
  const resolveRef = ref => commitById.get(ref) ?? ((byRequest.get(ref) ?? []).length === 1 ? byRequest.get(ref)[0] : null);

  // ---- allocation links from SIGNED allocations (the store verified each signature and nonce)
  // per (signer, commitment, caravan) the operation with the highest nonce is in force; a revoke in force removes it
  const inForce = new Map();
  const allocs = seen.filter(r => r.type === 'allocation');
  for (const a of allocs) {
    const c = commitById.get(a.commitment);
    if (!c) continue;
    const key = `${a.by}|${c.id}|${caravanKey(a.caravan)}`;
    const prev = inForce.get(key);
    if (!prev || a.nonce > prev.nonce) inForce.set(key, a);
  }
  const history = key => allocs.filter(a => `${a.by}|${a.commitment}|${caravanKey(a.caravan)}` === key).map(a => a.id);
  const linkMap = new Map();
  for (const [key, a] of inForce) {
    const c = commitById.get(a.commitment);
    const lk = `${c.id}|${caravanKey(a.caravan)}`;
    const l = linkMap.get(lk) ?? { commitment: c.id, caravan: a.caravan, declared: [], sources: [] };
    l.declared.push({ by: a.by, op: a.op, qty: a.qty, id: a.id, nonce: a.nonce, bell: a.bell, party: a.by === c.debtor || a.by === c.creditor });
    l.sources.push(...history(key));
    linkMap.set(lk, l);
  }
  const links = [...linkMap.values()].map(l => {
    const parties = l.declared.filter(d => d.party);
    const sets = parties.filter(d => d.op === 'set');
    const qtys = [...new Set(sets.map(d => d.qty))];
    // ordered for capacity by the earliest operation in force that sets it (a correction re-signs, so it re-queues)
    const first = sets.length ? sets.reduce((m, d) => (d.bell < m.bell || (d.bell === m.bell && d.id < m.id) ? d : m)) : null;
    return { ...l, qty: sets.length ? Math.min(...qtys) : 0, disputed: qtys.length > 1 || (sets.length > 0 && sets.length < parties.length),
      by: [...new Set(sets.map(d => d.by))].sort(), first_bell: first?.bell ?? Infinity, first_id: first?.id ?? '',
      state: !parties.length ? 'not_a_party' : !sets.length ? 'revoked' : null };
  }).sort((a, b) => a.first_bell - b.first_bell || (a.first_id < b.first_id ? -1 : 1));

  const used = new Map(); // caravanKey|resource -> allocated
  for (const l of links) {
    if (l.state) continue;
    const c = commitById.get(l.commitment);
    const k = caravanKey(l.caravan);
    const sent = one(sentBy, k);
    if (sent.conflict) { l.state = 'record_conflict'; continue; }
    if (!sent.f) { l.state = lookupFails.some(x => x.data.query === 'caravan' && x.data.caravan && caravanKey(x.data.caravan) === k) ? 'lookup_failed' : 'caravan_unknown'; continue; }
    l.sent = sent.f.id; l.sources.push(sent.f.id);
    if (l.caravan.sender !== c.debtor) { l.state = 'not_debtor_caravan'; continue; }
    const cap = sent.f.data.cargo[c.resource] ?? 0;
    if (!cap) { l.state = 'wrong_resource'; continue; }
    const uk = `${k}|${c.resource}`;
    if ((used.get(uk) ?? 0) + l.qty > cap) { l.state = 'over_allocated'; continue; }
    used.set(uk, (used.get(uk) ?? 0) + l.qty);
    if (placeKey(sent.f.data.dst) !== placeKey(c.place)) { l.state = 'misdirected'; continue; }
    const raid = one(raidBy, k);
    if (raid.f) { l.state = 'raided'; l.sources.push(raid.f.id); continue; }
    const st = one(settledBy, k);
    if (st.conflict) { l.state = 'record_conflict'; continue; }
    if (!st.f) {
      l.state = sent.f.data.eta_bell !== null && sent.f.data.eta_bell < clock ? 'settle_unobserved' : 'in_transit';
      continue;
    }
    l.settled = st.f.id; l.sources.push(st.f.id); l.settle_bell = st.f.bell;
    if (placeKey(st.f.data.dst) !== placeKey(sent.f.data.dst)) { l.state = 'record_conflict'; continue; }
    if (st.f.data.outcome === OUTCOME.LOST) { l.state = 'lost'; continue; }
    const own = ownerAt(c.place, st.f.bell);
    if (own.basis) l.sources.push(...own.basis);
    if (own.unverified) { l.state = 'recipient_unverified'; continue; }
    if (own.conflict) { l.state = 'recipient_conflict'; continue; }
    if (own.owner !== c.creditor) { l.state = 'recipient_changed'; l.owner_at_settle = own.owner; continue; }
    l.recorded = st.f.data.cargo_recorded[c.resource] ?? 0;
    l.settle_fact = st.f;
    l.state = 'awaiting_credit';
  }
  // the credit of each caravan, split over its links; ambiguous splits keep bounds, never a guess
  for (const [k, ls] of group(links.filter(l => l.state === 'awaiting_credit'), l => `${caravanKey(l.caravan)}|${commitById.get(l.commitment).resource}`)) {
    const [ck, res] = k.split('|');
    const place = commitById.get(ls[0].commitment).place;
    const settle = ls[0].settle_fact;
    const cr = one(creditBy, ck);
    if (cr.conflict || (cr.f && placeKey(cr.f.data.place) !== placeKey(place))) { for (const l of ls) l.state = 'record_conflict'; continue; }
    // the basis of the amount: 4's execution record, or for a holding the pinned rule over the settle record
    let x = null, credit = null;
    if (place.kind === PLACE.HOLDING) {
      const derived = settle.data.cargo_recorded[res] ?? 0;
      if (cr.f && (cr.f.data.credited[res] ?? 0) !== derived) { for (const l of ls) l.state = 'record_conflict'; continue; }
      x = derived;
      credit = { basis: 'rule_derived', rule: 'holding-credit-uncapped/v1', unit: CREDIT_RULES['holding-credit-uncapped/v1'].unit,
        precision: CREDIT_RULES['holding-credit-uncapped/v1'].precision, inputs: [settle.id, ...(cr.f ? [cr.f.id] : [])] };
    } else if (cr.f) {
      x = cr.f.data.credited[res] ?? 0;
      credit = { basis: 'exec_record', unit: cr.f.data.unit, inputs: [cr.f.id], exec: cr.f.data.exec };
    } else {
      for (const l of ls) { l.state = 'qty_unverified'; l.credit = { basis: 'none', why: 'vault credit depends on its stock and cap at settle; needs 4\'s execution record' }; }
      continue;
    }
    const total = ls.reduce((s, l) => s + l.qty, 0);
    for (const l of ls) {
      l.sources.push(...credit.inputs);
      l.credit = credit;
      l.state = 'delivered';
      if (x >= total) { l.qmin = l.qmax = l.qty; } else if (ls.length === 1) { l.qmin = l.qmax = x; } else { l.qmin = Math.max(0, x - (total - l.qty)); l.qmax = Math.min(l.qty, x); }
    }
  }

  // ---- claims
  const claimsOf = c => [...acts('claim_sent'), ...acts('claim_delivered')].filter(u => u.speaker === c.debtor && resolveRef(u.act.ref) === c);
  function judgeClaim(u, c) {
    const slack = WEIGHTS.claim_slack_bells;
    const out = (status, criterion = null, basis = []) => ({ id: u.id, commitment: c.id, kind: u.act.type, by: u.speaker, bell: u.bell, status, criterion, basis });
    const K = u.act.caravan;
    if (K) {
      if (K.sender !== u.speaker) return out('mismatch', 'caravan_of_another');
      const sent = one(sentBy, caravanKey(K));
      if (sent.f) {
        if (placeKey(sent.f.data.dst) !== placeKey(c.place)) return out('mismatch', 'caravan_to_other_place', [sent.f.id]);
        if (sent.f.bell > u.bell + slack) return out('mismatch', 'premature', [sent.f.id]);
        if (u.act.type === 'claim_sent') return out('consistent', null, [sent.f.id]);
        if (one(raidBy, caravanKey(K)).f) return out('mismatch', 'not_delivered_by_record', [sent.f.id, one(raidBy, caravanKey(K)).f.id]);
        const st = one(settledBy, caravanKey(K)).f;
        if (!st) return out('unverified');
        if (st.data.outcome === OUTCOME.LOST) return out('mismatch', 'not_delivered_by_record', [st.id]);
        return st.bell > u.bell + slack ? out('mismatch', 'premature', [st.id]) : out('consistent', null, [st.id]);
      }
      const cov = covered(u.speaker, c.made_bell, u.bell);
      if (cov.ok && !cov.listed.some(x => caravanKey(x) === caravanKey(K))) return out('contradicted', 'caravan_absent_in_complete_index', [...cov.basis]);
      return out('unverified');
    }
    const cov = covered(u.speaker, c.made_bell, u.bell);
    if (!cov.ok) return out('unverified');
    const listed = cov.listed.map(x => one(sentBy, caravanKey(x)).f);
    if (listed.some(f => !f)) return out('unverified');
    const toPlace = listed.filter(f => f.bell >= c.made_bell && f.bell <= u.bell + slack && placeKey(f.data.dst) === placeKey(c.place));
    if (!toPlace.length) return out('contradicted', 'no_caravan_to_place_in_complete_index', [...cov.basis]);
    if (u.act.type === 'claim_sent') return out('consistent', null, toPlace.map(f => f.id));
    const st = toPlace.map(f => one(settledBy, caravanKey(f.data.caravan)).f).find(s => s && s.data.outcome === OUTCOME.DELIVERED && s.bell <= u.bell + slack);
    return st ? out('consistent', null, [st.id]) : out('unverified');
  }

  // ---- commitment states
  const allocatedCaravans = new Set(links.filter(l => !INVALID_LINK.has(l.state)).map(l => caravanKey(l.caravan)));
  const claims = [];
  for (const c of commitments) {
    const ls = links.filter(l => l.commitment === c.id);
    c.links = ls.map(l => ({ caravan: l.caravan, qty: l.qty, by: l.by, disputed: l.disputed, state: l.state, qmin: l.qmin ?? null, qmax: l.qmax ?? null,
      settle_bell: l.settle_bell ?? null, on_time: l.settle_bell !== undefined ? l.settle_bell <= c.due_bell + GRACE_BELLS : null, owner_at_settle: l.owner_at_settle ?? null,
      credit: l.credit ?? null, sources: [...new Set(l.sources)] }));
    for (const l of ls) c.sources.push(...l.sources);
    const del = c.links.filter(l => l.state === 'delivered');
    const onTime = del.filter(l => l.on_time).reduce((s, l) => s + l.qmin, 0);
    const late = del.filter(l => !l.on_time).reduce((s, l) => s + l.qmin, 0);
    const ambiguous = del.reduce((s, l) => s + (l.qmax - l.qmin), 0);
    const pending = c.links.filter(l => PENDING_LINK.has(l.state));
    const neutral = c.links.filter(l => ['raided', 'lost', 'recipient_changed'].includes(l.state));
    c.delivered_min = Math.min(c.qty, onTime + late);
    c.delivered_max = Math.min(c.qty, onTime + late + ambiguous + pending.reduce((s, l) => s + l.qty, 0));
    c.claims = claimsOf(c).map(u => judgeClaim(u, c));
    claims.push(...c.claims);
    c.sources.push(...c.claims.map(x => x.id));
    c.reasons = [];
    c.coverage_gaps = [];
    const retract = acts('retract').find(u => u.speaker === c.debtor && resolveRef(u.act.ref) === c && u.bell <= c.due_bell);
    const past = clock > c.due_bell + GRACE_BELLS;
    c.resolved_bell = null;
    if (onTime >= c.qty) { c.state = 'fulfilled'; c.resolved_bell = Math.max(...del.filter(l => l.on_time).map(l => l.settle_bell)); }
    else if (onTime + late >= c.qty) { c.state = 'late'; c.resolved_bell = Math.max(...del.map(l => l.settle_bell)); }
    else if (retract && !del.length) { c.state = 'withdrawn'; c.sources.push(retract.id); c.resolved_bell = retract.bell; }
    else if (!past) c.state = ls.length ? 'in_progress' : c.claims.length ? 'claimed_unverified' : 'promised';
    else if (pending.length || ambiguous > 0) { c.state = 'unconfirmed'; c.reasons = [...new Set([...pending.map(l => l.state), ...(ambiguous > 0 ? ['qty_split_ambiguous'] : [])])]; }
    else if (neutral.length && c.delivered_min + neutral.reduce((s, l) => s + l.qty, 0) >= c.qty) { c.state = neutral[0].state; c.resolved_bell = c.due_bell + GRACE_BELLS; }
    else {
      // a shortfall is verified only by a complete index of the debtor's departures over the promise window
      const cov = covered(c.debtor, c.made_bell, c.due_bell + GRACE_BELLS);
      if (!cov.ok) {
        c.state = 'unconfirmed';
        c.reasons = [cov.failed ? 'lookup_failed' : cov.insufficient.length || cov.partial_range ? 'coverage_insufficient' : 'no_record_found'];
        c.coverage_gaps = [...cov.insufficient, ...(cov.partial_range ? ['window_not_fully_covered'] : [])];
        c.sources.push(...cov.basis);
      }
      else {
        c.sources.push(...cov.basis);
        const listed = cov.listed.map(x => ({ x, f: one(sentBy, caravanKey(x)).f }));
        const unknownDst = listed.filter(y => !y.f);
        const toPlace = listed.filter(y => y.f && y.f.bell >= c.made_bell && placeKey(y.f.data.dst) === placeKey(c.place) && !allocatedCaravans.has(caravanKey(y.x)));
        if (unknownDst.length || toPlace.length) {
          c.state = 'unconfirmed';
          c.reasons = [...(unknownDst.length ? ['coverage_caravan_unresolved'] : []), ...(toPlace.length ? ['unassigned_caravan'] : [])];
          c.unassigned = toPlace.map(y => y.x);
        } else if (c.delivered_min > 0) { c.state = 'partial'; c.resolved_bell = c.due_bell + GRACE_BELLS; }
        else if (neutral.length) { c.state = neutral[0].state; c.resolved_bell = c.due_bell + GRACE_BELLS; }
        else { c.state = 'not_sent'; c.resolved_bell = c.due_bell + GRACE_BELLS; }
      }
    }
    c.sources = [...new Set(c.sources)];
  }
  const declined = acts('decline').filter(d => requests.has(d.act.ref)).map(d => ({ id: d.id, by: d.speaker, request: d.act.ref }));
  const unassigned = ofKind('caravan_sent').filter(f => !allocatedCaravans.has(caravanKey(f.data.caravan))).map(f => ({ fact: f.id, caravan: f.data.caravan, dst: f.data.dst }));

  // ---- testimony: shown, cross-checked against verified states, never counted
  const testimonies = acts('testimony').map(u => {
    const c = resolveRef(u.act.ref);
    let check = 'unverifiable';
    if (c && c.debtor === u.act.about && VERIFIED_STATES.includes(c.state)) {
      const delivered = c.state !== 'not_sent';
      check = (u.act.says === 'delivered') === delivered ? 'consistent' : 'contradicted_by_fact';
    }
    return { id: u.id, by: u.speaker, about: u.act.about, ref: u.act.ref, says: u.act.says, check };
  });
  for (const g of group(testimonies, t => `${t.about}|${t.ref}`).values()) if (new Set(g.map(t => t.says)).size > 1) for (const t of g) t.conflicting = true;

  // ---- reliability per debtor: verified evidence only; unknowns listed beside it
  const reliability = {};
  const relOf = tag => (reliability[tag] ??= blankReliability());
  const weight = (c, at) => 0.5 ** ((clock - at) / HALF_LIFE_BELLS) * (c.direct ? 1 : WEIGHTS.observed_weight);
  for (const c of commitments) {
    if (c.debtor === viewer.tag) continue;
    const rel = relOf(c.debtor);
    let dr = 0, ds = 0;
    if (c.state === 'fulfilled') dr = 1;
    else if (c.state === 'late') { dr = 0.5; ds = 0.5; }
    else if (c.state === 'partial') { dr = c.delivered_min / c.qty; ds = 1 - dr; }
    else if (c.state === 'not_sent') ds = 1;
    if (VERIFIED_STATES.includes(c.state)) {
      const w = weight(c, c.resolved_bell);
      rel.r += dr * w; rel.s += ds * w;
      rel.verified[c.state]++;
      c.direct ? rel.n_direct++ : rel.n_observed++;
      rel.evidence.push({ kind: 'delivery', commitment: c.id, state: c.state, direct: c.direct, weight: round(w), dr: round(dr * w), ds: round(ds * w), sources: [...c.sources] });
    } else if (NEUTRAL_STATES.includes(c.state)) rel.neutral.push({ commitment: c.id, state: c.state, sources: [...c.sources] });
    else rel.unresolved.push({ commitment: c.id, state: c.state, reasons: [...c.reasons], overdue: c.state === 'unconfirmed', sources: [...c.sources] });
    for (const cl of c.claims) {
      rel.claims[cl.status]++;
      if (cl.status === 'contradicted') {
        const w = weight(c, cl.bell);
        rel.s += WEIGHTS.false_claim_weight * w;
        rel.evidence.push({ kind: 'false_claim', commitment: c.id, claim: cl.id, criterion: cl.criterion, rule: CLAIM_CRITERIA[cl.criterion], direct: c.direct,
          weight: round(w), dr: 0, ds: round(WEIGHTS.false_claim_weight * w), sources: [cl.id, ...cl.basis] });
      } else if (cl.status === 'mismatch') rel.mismatches.push({ claim: cl.id, criterion: cl.criterion, rule: CLAIM_CRITERIA[cl.criterion], sources: [cl.id, ...cl.basis] });
    }
  }
  for (const rel of Object.values(reliability)) { rel.r = round(rel.r); rel.s = round(rel.s); rel.E = round((rel.r + 1) / (rel.r + rel.s + 2)); }

  return { viewer: { ...viewer }, clock, observedBy, bell: clock, ids, byId, facts, rolledBack: [...rolledBack.keys()], notes, commitments, links, claims,
    declined, unassigned, testimonies, reliability };
}

export function blankReliability() {
  return { r: 0, s: 0, E: 0.5, n_direct: 0, n_observed: 0, verified: { fulfilled: 0, late: 0, partial: 0, not_sent: 0 },
    claims: { consistent: 0, contradicted: 0, mismatch: 0, unverified: 0 }, unresolved: [], neutral: [], mismatches: [], evidence: [] };
}

/** The prior a viewer holds of a partner it has no evidence about. */
export const reliabilityOf = (k, tag) => k.reliability[tag] ?? blankReliability();
