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
/** Run view versions this port reads (workstream 4 src/view.rs RUN_VIEW_VERSION). A view without one is an older fake. */
export const RUN_VIEW_VERSIONS = Object.freeze(['p04-run/0.1']);

/**
 * What a run view says about effects, from every field that says anything (p04-run/0.1, cf517b55):
 *   `effects`          receipt kinds in the store (top level)
 *   `outcome.effects`  the executor's "effects that took place before the run stopped" ("kind subject")
 *   `sent`             a confirmed caravan_sent receipt
 * In workstream 4 today all three come from the same facts. If they ever disagree (one effects list empty and the
 * other not, or the caravan's departure said by one and denied by another), the view is contradictory: no field is
 * preferred, nothing is claimed, the answer is unknown.
 */
export function effectsOf(run) {
  const lists = [['effects', run.effects], ['outcome.effects', run.outcome?.effects]].filter(([, v]) => Array.isArray(v));
  const kinds = v => v.map(x => String(x).split(' ')[0]);
  const departed = [...lists.map(([n, v]) => [n, kinds(v).includes('caravan_sent')]), ...(typeof run.sent === 'boolean' ? [['sent', run.sent]] : [])];
  const contradictions = [];
  if (lists.length === 2 && (lists[0][1].length > 0) !== (lists[1][1].length > 0)) contradictions.push(`${lists[0][0]} has ${lists[0][1].length}, ${lists[1][0]} has ${lists[1][1].length}`);
  if (new Set(departed.map(([, b]) => b)).size > 1) contradictions.push(`caravan_sent: ${departed.map(([n, b]) => `${n} ${b}`).join(', ')}`);
  return { any: lists.some(([, v]) => v.length > 0) || run.sent === true, contradictions };
}

export function fateOfRun(run) {
  if (run === null || run === undefined) return null;
  const base = { ok: true, status: 'sent', ws04State: run.state };
  if (run.view_version !== undefined && !RUN_VIEW_VERSIONS.includes(run.view_version)) return { ...base, fate: 'unknown', why: `unknown run view version ${run.view_version}` };
  if (!WS04_STATES.includes(run.state)) return { ...base, fate: 'unknown', why: `unknown workstream 4 state ${run.state}` };
  if (run.held_reason) return { ...base, fate: 'unknown', why: `held: ${run.held_reason}` };
  if (TOOK_EFFECT.has(run.state)) return { ...base, fate: 'landed', ...(run.state === 'Partial' ? { partial: true } : {}), ...(run.state === 'DeliveredUnverified' ? { unverified: true } : {}) };
  if (PENDING.has(run.state)) return { ...base, fate: 'pending' };
  // Stopped: Failed, Cancelled, Expired. Whether something took place first decides it; a contradictory view decides
  // nothing (held: it may have left, so it is never sent again, and it is not claimed as landed either).
  const e = effectsOf(run);
  if (e.contradictions.length) return { ...base, fate: 'unknown', why: `contradictory run view: ${e.contradictions.join('; ')}` };
  if (e.any) return { ...base, fate: 'landed', stoppedAfterEffects: run.state };
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
 * generation: without `requesterOf`, or when it gives no requester, nothing is handed to workstream 4
 * (`NoAuthenticatedRequester`, nothing sent; accept is not called).
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
      // No credential layer (requesterOf absent) or no requester from it: nothing is handed to workstream 4.
      const requester = typeof requesterOf === 'function' ? requesterOf(req) : null;
      if (!requester) return { ok: false, status: 'refused', error: { code: 'NoAuthenticatedRequester', message: 'no requester authenticated by the credential layer: not handed to workstream 4' } };
      let a;
      try { a = await client.accept(spec, requester); } catch (e) {
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
