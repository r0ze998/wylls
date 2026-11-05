// ④'s Run Receipts and Run outcomes → evaluator events. Written against ④'s
// types at a967f5f1c64facc32facf07010f39a679c77d80a
// (origin/preserve/ws04-a967f5f1): `store.rs` Receipt, `ports.rs` Settle and
// Raid, `model.rs` Outcome and Verification, and ④'s quantity contract
// (docs/QUANTITY-CONTRACT.ja.md, §3, §4, §7 for ⑮). ④ has committed no JSON
// produced by a run; the shapes below follow its serde types, and
// test/contract-ws04.test.mjs is written in them.
//
//   Receipt  {run_id, kind, subject, source, slot, body}
//            subject of a caravan: `cv:<owner in hex>:<seq>` (CaravanKey::text)
//            caravan_sent    body {seq, cargo: [8], content_from}
//            caravan_settled body Settle {key: {owner, seq}, outcome, dst: {kind, p, q, at, gen}, cargo, credited, slot}
//            caravan_raided  body Raid {key, choice (0 take, 1 burn), raider, taken: [8], slot}
//   Run      the destination is the run's `spec.ship.dst`; the verified amount is the run's
//            `outcome` {delivered, verification, cargo_logged}, not in any receipt body (④ §7 a)
//
// Quantities (④ §3): RuleDerived and Recorded → lower bound [b, b+1);
// KnownZero → zero (only on evidence for this caravan, which ④ checks);
// Unverifiable → unknown [0, cargo_logged + 1); a DestinationMismatch run →
// lost with the cause unconfirmed (no amount, no one named). Without a run
// outcome yet, the settle record alone gives: outcome LOST → zero; a village
// → lower bound of the logged cargo; a storehouse → `credited` as a lower
// bound if present (P1, case B), else unknown.
//
// Duplicates are removed by `kind|subject` (④ §7 c: the same record read from
// the feed and from the entity history has two sources). The same kind and
// subject with other content is emitted twice under one id, so the
// evaluator's record check sets both aside as a conflict.
//
// Owners and raiders are u64. In JSON numbers above 2^53 lose precision in
// JavaScript: the owner is read from the subject's hex (exact); a raider tag
// that is not a safe integer is left unresolved (a gap), never guessed.
import { canonical } from '../canon.mjs';
import { SLOT_RESOURCES } from './s1-chain.mjs';

const RAID_TAKE = 0;
const OUTCOME_LOST = 1;

/** The owner tag (decimal string, as the S1 adapter writes it) and seq of `cv:<hex>:<seq>`. */
export function caravanOfSubject(subject) {
  const m = /^cv:([0-9a-f]+):(\d+)$/.exec(subject ?? '');
  return m ? { owner: BigInt(`0x${m[1]}`).toString(), seq: Number(m[2]) } : null;
}

/** The arrival's quantity kind and amounts per resource from a run outcome or the settle record (④ §3). */
export function quantityOf(settle, outcome) {
  if (outcome?.verification === 'KnownZero') return { kind: 'zero' };
  if (outcome?.verification === 'RuleDerived' || outcome?.verification === 'Recorded') return { kind: 'lower_bound', qty: outcome.delivered };
  if (outcome?.verification === 'Unverifiable') return { kind: 'unknown', qty: outcome.cargo_logged ?? settle.cargo };
  if (Number(settle.outcome) === OUTCOME_LOST) return { kind: 'zero' };
  if (Number(settle.dst?.kind) === 1) return { kind: 'lower_bound', qty: settle.cargo };
  if (settle.credited) return { kind: 'lower_bound', qty: settle.credited };
  return { kind: 'unknown', qty: settle.cargo };
}

const samePlace = (a, b) => !!a && !!b && ['kind', 'p', 'q', 'at', 'gen'].every(k => Number(a[k]) === Number(b[k]));

/**
 * `{events, skipped}` from ④'s receipts. `runs[run_id]` = `{spec, outcome,
 * reason}` (④'s RunSpec, Outcome, Reason); `map.bellOfSlot(slot)`;
 * `map.actorOfTag(tag, epoch)`; `map.destination(placeRef, owner, seq)` →
 * `{actor, project?}`. The sender's stock is not in ④'s receipts: sends
 * enter the cargo `fromOutside`.
 */
export function fromRunReceipts(receipts, runs, map, { stream = 'ws04', epoch = null } = {}) {
  const ns = epoch === null ? '' : `${epoch}:`;
  const events = [];
  const skipped = [];
  const keyOf = r => `${r.kind}|${r.subject}`;
  const sorted = [...receipts].map(r => ({ r, k: keyOf(r), c: canonical({ kind: r.kind, subject: r.subject, slot: r.slot, body: r.body }) }))
    .sort((a, b) => a.r.slot - b.r.slot || (a.k < b.k ? -1 : a.k > b.k ? 1 : a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
  const seqOf = new Map();
  const seen = new Set();
  const sentCargo = new Map();
  let seq = 0;
  for (const { r, k, c } of sorted) {
    if (seen.has(c)) { skipped.push({ source: r.source, why: 'same record from another source' }); continue; }
    seen.add(c);
    if (!seqOf.has(k)) seqOf.set(k, seq++);
    const s = seqOf.get(k);
    const at = map.bellOfSlot(r.slot);
    const b = r.body ?? {};
    const run = runs[r.run_id] ?? {};
    let sub = 0;
    const emit = (kind, fields, verified) => events.push({ id: `${stream}:${s}:${sub}`, stream, seq: s, sub: sub++, at, kind, verified, ...fields, src: { run: r.run_id, source: r.source } });
    const cv = caravanOfSubject(r.subject);
    if (r.kind === 'facility_used' || !cv) { skipped.push({ source: r.source, why: `${r.kind} not judged here` }); emit('position', {}, 'chain'); continue; }
    const ship = res => `cv:${ns}${cv.owner}:${cv.seq}:${res}`;
    if (r.kind === 'caravan_sent') {
      const from = map.actorOfTag(cv.owner, epoch);
      const dst = run.spec?.ship?.dst ? map.destination(run.spec.ship.dst, cv.owner, cv.seq) : null;
      if (!from || !dst) { skipped.push({ source: r.source, why: 'owner or destination unresolved (left as a gap)' }); continue; }
      sentCargo.set(`${cv.owner}:${cv.seq}`, b.cargo);
      (b.cargo ?? []).forEach((q, i) => { if (q && SLOT_RESOURCES[i]) emit('ship.send', { ship: ship(SLOT_RESOURCES[i]), from, to: dst.project ? `project:${dst.project}` : dst.actor, resource: SLOT_RESOURCES[i], qty: q, fromOutside: true }, 'chain'); });
    } else if (r.kind === 'caravan_settled') {
      const mismatch = run.reason === 'DestinationMismatch' || (run.spec?.ship?.dst && !samePlace(b.dst, run.spec.ship.dst) && Number(b.outcome) !== OUTCOME_LOST);
      const q = quantityOf(b, run.outcome);
      (b.cargo ?? []).forEach((logged, i) => {
        const res = SLOT_RESOURCES[i];
        if (!res || !logged) return;
        if (mismatch) emit('ship.lost', { ship: ship(res), cause: 'unconfirmed' }, 'chain');
        else if (q.kind === 'zero') emit('ship.arrive', { ship: ship(res), qty: 0, qtyKind: 'zero' }, 'chain');
        else if (q.kind === 'lower_bound') emit('ship.arrive', { ship: ship(res), qty: q.qty?.[i] ?? 0, qtyKind: 'lower_bound' }, 'chain_lower_bound');
        else emit('ship.arrive', { ship: ship(res), qty: q.qty?.[i] ?? logged, qtyKind: 'unknown' }, 'unverified');
      });
      if (!sub) emit('position', {}, 'chain');
    } else if (r.kind === 'caravan_raided') {
      const raiderTag = Number.isSafeInteger(b.raider) ? String(b.raider) : typeof b.raider === 'string' ? b.raider : null;
      const raider = raiderTag && map.actorOfTag(raiderTag, epoch);
      const sent = sentCargo.get(`${cv.owner}:${cv.seq}`);
      if (!raider || !sent) { skipped.push({ source: r.source, why: !raiderTag ? 'raider tag not exact in JSON (beyond 2^53): left as a gap' : 'raider or sent cargo unresolved (left as a gap)' }); continue; }
      sent.forEach((q, i) => {
        if (!q || !SLOT_RESOURCES[i]) return;
        const take = Number(b.choice) === RAID_TAKE ? (b.taken?.[i] ?? 0) : 0;
        emit('ship.raid', { ship: ship(SLOT_RESOURCES[i]), raider, taken: take, burned: q - take }, 'chain');
      });
    } else { skipped.push({ source: r.source, why: `${r.kind} not judged here` }); emit('position', {}, 'chain'); }
  }
  return { events, skipped };
}
