// Workstream 4's executor behind the resident's execution port (resident/ports/execution.mjs). Read on the
// integration candidate (workstreams/04-execution, src/model.rs RunState, src/store.rs, docs/CONTRACTS.ja.md):
//
//   - the idempotency key is the Run's `run_id`; the same id with the same spec answers the existing run, another
//     spec is a Conflict (store.rs `accept`). Runs are never deleted (store.rs deletes only reservations), so a key
//     is kept for good: more than the one game day the resident requires (08-retention-contract.ja.md);
//   - a Run has 15 states, 6 terminal (Fulfilled, Partial, DeliveredUnverified, Failed, Cancelled, Expired), and a
//     `held_reason` that stops automatic work until someone decides;
//   - "Absent" (never landed) is reported only after a finalized, gapless look at the whole validity window
//     (CONTRACTS ③-R4); anything less is Unavailable. A failed or expired run is therefore a definite answer.
//
// fateOfRun maps a run view to the port's answer. The resident's question is "did my action take effect": a
// caravan that left (InTransit and after) has, whatever came of the delivery; a run that stopped (Failed, Cancelled,
// Expired) but recorded effects also has. Nothing here is a transport: `client` (accept, run) and `specOf` (the
// resident's action → ④'s RunSpec: owner tag, Places with generation, deadline slot, budget) must come from
// workstreams 4 and 8. Until they do, this is tested against a fake client only.

export const WS04_STATES = Object.freeze(['Accepted', 'Reserved', 'FacilityRequested', 'FacilitySubmitted', 'FacilityConfirmed',
  'ShipRequested', 'ShipSubmitted', 'InTransit', 'Arrived', 'Fulfilled', 'Partial', 'DeliveredUnverified', 'Failed', 'Cancelled', 'Expired']);
export const WS04_TERMINAL = Object.freeze(['Fulfilled', 'Partial', 'DeliveredUnverified', 'Failed', 'Cancelled', 'Expired']);
const TOOK_EFFECT = new Set(['InTransit', 'Arrived', 'Fulfilled', 'Partial', 'DeliveredUnverified']);
const PENDING = new Set(['Accepted', 'Reserved', 'FacilityRequested', 'FacilitySubmitted', 'FacilityConfirmed', 'ShipRequested', 'ShipSubmitted']);

/**
 * @param run  null (no run with this id: never accepted) or {state, held_reason?, outcome?: {effects?: []}}
 * @returns    null, or {ok, status: 'sent', fate: 'pending'|'landed'|'failed'|'cancelled'|'unknown', fateError?, ws04State, partial?, unverified?}
 */
export function fateOfRun(run) {
  if (run === null || run === undefined) return null;
  const base = { ok: true, status: 'sent', ws04State: run.state };
  const effects = run.outcome?.effects ?? [];
  if (!WS04_STATES.includes(run.state)) return { ...base, fate: 'unknown', why: `unknown workstream 4 state ${run.state}` };
  if (run.held_reason) return { ...base, fate: 'unknown', why: `held: ${run.held_reason}` };
  if (TOOK_EFFECT.has(run.state)) return { ...base, fate: 'landed', ...(run.state === 'Partial' ? { partial: true } : {}), ...(run.state === 'DeliveredUnverified' ? { unverified: true } : {}) };
  if (PENDING.has(run.state)) return { ...base, fate: 'pending' };
  // Stopped: Failed, Cancelled, Expired.
  if (effects.length) return { ...base, fate: 'landed', stoppedAfterEffects: run.state };
  if (run.state === 'Cancelled') return { ...base, fate: 'cancelled' };
  return { ...base, fate: 'failed', fateError: run.state };
}

/**
 * The execution port over workstream 4. `client.accept(spec)` → {kind: 'accepted'|'existing'|'conflict', run?};
 * `client.run(runId)` → run view | null, and throws when workstream 4 cannot answer (the resident treats that as
 * unknown). `specOf(request)` builds the RunSpec with `run_id = idempotencyKey`.
 */
export function ws04ExecutionPort(client, { specOf }) {
  if (typeof client?.accept !== 'function' || typeof client?.run !== 'function') throw new TypeError('workstream 4 client with accept() and run()');
  if (typeof specOf !== 'function') throw new TypeError('specOf(request) → RunSpec is required');
  return {
    kind: 'workstream 4 executor',
    // store.rs never deletes a run: keys are kept for good.
    retentionBells: Infinity,
    async submit(req) {
      const spec = { ...specOf(req), run_id: req.idempotencyKey };
      const a = await client.accept(spec);
      if (a.kind === 'conflict') return { ok: false, status: 'refused', error: { code: 'IdempotencyConflict', message: 'workstream 4 has another spec under this run_id' } };
      return { ok: true, status: 'sent', signature: `run:${spec.run_id}`, ...(a.kind === 'existing' ? { replayed: true } : {}) };
    },
    async status(key) { return fateOfRun(await client.run(key)); },
    async cancel(key) {
      if (typeof client.cancel !== 'function') return { cancelled: false, reason: 'NotSupported' };
      return client.cancel(key);
    },
  };
}
