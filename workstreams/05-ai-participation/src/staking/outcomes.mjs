// What "it worked" means, step by step, so that no step is read as the last:
//
//   accepted   the relay took the request and sent the transaction (ActionResult status 'sent')
//   landed     the chain finalized it without error (GET /f/tx → landed)
//   departed   for a caravan: it is on the road (the herald's h/caravans.json lists it in `moving`)
//   arrived    for a caravan: it has left `moving` unraided AND the destination's stores show the cargo
//   effect     for an immediate action (Train): the public state shows the change (src/participate.mjs verifyPending)
//
// A trade accepted is not a caravan arrived, and a caravan gone from the road
// is not proof it arrived (a raid that takes it re-lists it under the raider,
// decision J2; herald caravan.rs). Only the destination's stores close it.
// The agent cannot send caravans today (no agent path; CURRENT-SUPPORT §2):
// this is the reading the tracker will need, checked on the herald's
// documented feed shape, not on a live caravan.

/** The state of caravan `{ownerTag, seq}` between two readings of h/caravans.json, and the destination's stores before and now. */
export function caravanOutcome({ before, now, ownerTag, seq, destBefore = null, destNow = null, cargo = null }) {
  const find = f => (f?.moving ?? []).find(m => String(m.ownerTag) === String(ownerTag) && m.seq === seq) ?? null;
  const was = find(before), is = find(now);
  if (is && is.raided) return { state: 'raided', final: false, why: 'on the road, raided (burned: cargo 0)' };
  if (is) return { state: 'departed', final: false, why: 'on the road' };
  // Taken by a raider (J2): the same transaction re-lists it under the raider's tag; ours is gone.
  const taken = (now?.moving ?? []).some(m => m.src?.kind === 3 && Array.isArray(cargo) && m.cargo?.every?.((c, i) => c <= (cargo[i] ?? 0)) && String(m.ownerTag) !== String(ownerTag));
  if (!was && !is) return { state: 'unknown', final: false, why: 'not seen on the road in either reading' };
  if (taken) return { state: 'possibly-taken', final: false, why: 'gone from the road and a raider\'s caravan from a raid tile appeared: read the destination before calling it arrived' };
  if (destBefore && destNow && Array.isArray(cargo)) {
    const grew = cargo.every((c, i) => (destNow[i] ?? 0) - (destBefore[i] ?? 0) >= c);
    return grew ? { state: 'arrived', final: true, why: 'gone from the road and the destination\'s stores grew by the cargo' } : { state: 'settled-unconfirmed', final: false, why: 'gone from the road but the destination did not grow by the cargo' };
  }
  return { state: 'settled-unconfirmed', final: false, why: 'gone from the road; the destination\'s stores were not read' };
}

/** The ladder of one action, for the owner: each rung is a separate fact. */
export function ladderOf({ accepted = null, tx = null, effect = null }) {
  return [
    { rung: 'accepted', ok: accepted === 'sent', value: accepted },
    { rung: 'landed', ok: tx === 'landed', value: tx },
    { rung: 'effect', ok: effect === true, value: effect },
  ];
}
