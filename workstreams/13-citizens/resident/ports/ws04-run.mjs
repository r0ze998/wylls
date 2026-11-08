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
 * @param run  null (no run with this id: never accepted) or {state, held_reason?, effects?: [] (p04-run/0.1), outcome?: {effects?: []}}
 * @returns    null, or {ok, status: 'sent', fate: 'pending'|'landed'|'failed'|'cancelled'|'unknown', fateError?, ws04State, partial?, unverified?}
 */
export function fateOfRun(run) {
  if (run === null || run === undefined) return null;
  const base = { ok: true, status: 'sent', ws04State: run.state };
  // p04-run/0.1 (cf517b55 src/view.rs) lists the receipt kinds as `effects` at the top; older views under `outcome`.
  const effects = run.effects ?? run.outcome?.effects ?? [];
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
 * The execution port over workstream 4's runs.
 *
 * `client.accept(spec, requester)`: workstream 4's run intake (clients/runs.mjs `createRunsClient`, cf517b55:
 * `runexec run accept --requester`). It answers the run view with `accept: 'Created' | 'Existing'`, and refuses by
 * throwing `{code}`: BadRequest, NotAuthorized (the requester is not the pass's current holder; exit 5, nothing
 * written), Conflict (another spec under this run_id), StoreError, Spawn. An older fake answering
 * `{kind: 'accepted'|'existing'|'conflict'}` is still read.
 *
 * `requesterOf(request)`: who asks, as the gateway's credential layer (workstreams 3 and 5) authenticated it:
 * `{actor, generation, citizen, authenticatedBy}`. This port never signs or verifies anything and never makes up a
 * generation: without a requester nothing is handed to workstream 4 (`NoAuthenticatedRequester`, nothing sent).
 *
 * `client.view(runId)` (or the older `client.run(runId)`): the run view (`runexec run view`, p04-run/0.1), or a
 * refusal: `NoRecord` alone means "never accepted here" (null); `StoreUnavailable` and anything else is no answer
 * (thrown: the resident reads again, never as "not sent").
 *
 * Definite refusals (nothing written: BadRequest, NotAuthorized, Conflict, NoAuthenticatedRequester) come back as
 * `refused`; the resident does not retry them under a new key (they are not transient). StoreError and Spawn may
 * have happened after the store was written: thrown, so the resident keeps the key and reads the run back.
 * Whether a resident should stop altogether once its pass has moved (NotAuthorized) is not decided here.
 */
export const DEFINITE_REFUSALS = Object.freeze(['BadRequest', 'NotAuthorized', 'Conflict', 'NoAuthenticatedRequester']);

export function ws04ExecutionPort(client, { specOf, requesterOf = null }) {
  if (typeof client?.accept !== 'function' || (typeof client?.view !== 'function' && typeof client?.run !== 'function')) throw new TypeError('workstream 4 client with accept() and view() (or run())');
  if (typeof specOf !== 'function') throw new TypeError('specOf(request) → RunSpec is required');
  const view = id => (typeof client.view === 'function' ? client.view(id) : client.run(id));
  return {
    kind: 'workstream 4 executor',
    // store.rs never deletes a run: keys are kept for good.
    retentionBells: Infinity,
    async submit(req) {
      const spec = { ...specOf(req), run_id: req.idempotencyKey };
      const requester = requesterOf ? requesterOf(req) : null;
      if (requesterOf && !requester) return { ok: false, status: 'refused', error: { code: 'NoAuthenticatedRequester', message: 'no requester authenticated by the credential layer: not handed to workstream 4' } };
      let a;
      try { a = requesterOf ? await client.accept(spec, requester) : await client.accept(spec); } catch (e) {
        const code = e?.code === 'Conflict' ? 'IdempotencyConflict' : e?.code;
        if (DEFINITE_REFUSALS.includes(e?.code)) return { ok: false, status: 'refused', error: { code, message: String(e.message ?? e).slice(0, 200) } };
        throw e; // StoreError, Spawn, anything else: maybe written; the resident reads it back under the same key
      }
      if (a?.kind === 'conflict') return { ok: false, status: 'refused', error: { code: 'IdempotencyConflict', message: 'workstream 4 has another spec under this run_id' } };
      const replayed = a?.accept === 'Existing' || a?.kind === 'existing';
      return { ok: true, status: 'sent', signature: `run:${spec.run_id}`, ...(replayed ? { replayed: true } : {}) };
    },
    async status(key) {
      let v;
      try { v = await view(key); } catch (e) { if (e?.code === 'NoRecord') return null; throw e; }
      return fateOfRun(v);
    },
    async cancel(key) {
      if (typeof client.cancel !== 'function') return { cancelled: false, reason: 'NotSupported' };
      return client.cancel(key);
    },
  };
}

/**
 * `runexec run view` for the port's `view` (workstream 4's clients/runs.mjs has `accept` only). Read-only; no shell.
 * Throws `{code}` from runexec's JSON (NoRecord, StoreUnavailable, StoreError, BadRequest) or Spawn.
 */
export function runViewClient({ bin, db, timeoutMs = 15_000, execFile }) {
  if (!bin || !db || typeof execFile !== 'function') throw new TypeError('bin, db and execFile (node:child_process) are required');
  return id => new Promise((resolve, reject) => {
    execFile(bin, ['run', 'view', '--db', db, '--run', id], { timeout: timeoutMs, maxBuffer: 1 << 22, shell: false }, (err, stdout) => {
      const line = String(stdout ?? '').trim().split('\n').at(-1) ?? '';
      let v = null;
      try { v = line ? JSON.parse(line) : null; } catch { v = null; }
      if (!err && v && !v.error) return resolve(v);
      if (v?.error) return reject(Object.assign(new Error(v.message ?? v.error), { code: v.error }));
      reject(Object.assign(new Error(String(err?.message ?? 'runexec printed no JSON')), { code: 'Spawn' }));
    });
  });
}
