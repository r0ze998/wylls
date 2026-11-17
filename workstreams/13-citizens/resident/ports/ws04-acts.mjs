// The resident's execution port over workstream 4's act registry (origin/claude/gallant-ride-cunptv 95686606:
// workstreams/04-execution/clients/acts.mjs, docs/EXECUTION-CONTRACT-20261106.ja.md §7). The registry records an act
// under its idempotency key and reads its state from the agent wallet's GET /f/agent/fate; it never sends, signs or
// holds a key. Sending stays with `send(req)` (the wallet's POST /f/agent/action, or the relay), which the caller
// supplies with the same idempotency key.
//
// The seven states are kept as workstream 4 names them (the resident's journal understands all of them):
//   landed, failed            final
//   expired, not-sent         final, nothing happened: a new attempt under a new key may follow
//   pending (and registered)  wait
//   unknown                   result unknown: hold, never send again
//   unqueryable               could not ask: thrown (R5), so the resident reads again and never treats it as an answer
// This is not workstream 4's `toWs13Status`, which folds expired and not-sent into `cancelled` and so loses the "new
// attempt allowed" difference, and reports retention as null, which the resident would refuse as undeclared.
//
// Retention: the registry never deletes a row (its receipts say `retentionBells: null`), so keys are kept for good.

export class Unqueryable extends Error {
  constructor(message) { super(message); this.code = 'Unqueryable'; }
}

const KNOWN = new Set(['registered', 'not-sent', 'landed', 'failed', 'expired', 'pending', 'unknown']);

/** A registry receipt as the resident's port answer (or throws Unqueryable). */
export function fateOfReceipt(r) {
  if (r?.state === 'unqueryable') throw new Unqueryable(`the act could not be read: ${r.why ?? r.lastReadError ?? 'unqueryable'}`);
  if (!KNOWN.has(r?.state)) throw new Unqueryable(`unknown registry state ${r?.state}`);
  // (2026-11-17) The wallet's entry for this key is a Duplicate (workstream 4's receipt `code`, from the wallet's fate
  // read): nothing of THIS key's request left; the signature and state in the receipt are the earlier send's
  // (permutation-gateway agent/gateway.mjs: the Duplicate branch of #run, actionFateView). They are not this key's
  // send or its result. The answer is the one the wallet gave this key's submit, a Duplicate failure, so a read-back
  // (after a restart, or a lost reply) ends the line as the answer itself would have (#retryOrFail('Duplicate')):
  // no signature, never sent again, never counted as landed. Only with a signature in the receipt: a Duplicate the
  // wallet refused before anything was signed (a non-seq action out of rebuilds) reads `not-sent` with no signature and
  // keeps today's handling (nothing happened: a new attempt may follow).
  if (r.code === 'Duplicate' && typeof r.signature === 'string' && r.signature !== '') {
    return {
      ok: false, status: 'failed', fate: 'failed', fateError: 'Duplicate',
      error: { code: 'Duplicate', message: 'the same transaction was already sent by an earlier request; this key sent nothing of its own' },
      duplicate: true,
      ws04: { run4Id: r.run4Id ?? null, state: r.state, next: r.next ?? null, newAttemptAllowed: r.newAttemptAllowed === true,
        commitment: r.commitment ?? null, final: r.final ?? null, code: r.code, ...(r.conflict ? { conflict: r.conflict } : {}) },
    };
  }
  return {
    ok: true, status: r.state === 'not-sent' ? 'refused' : 'sent', fate: r.state === 'registered' ? 'pending' : r.state,
    // ④'s own words kept beside the fate: `commitment` is what the node reported (processed | confirmed | finalized);
    // `final` is ④'s (landed, failed, expired, not-sent never change); a contradicting later reading is ④'s
    // `conflict`, kept for the operator and not applied.
    ws04: { run4Id: r.run4Id ?? null, state: r.state, next: r.next ?? null, newAttemptAllowed: r.newAttemptAllowed === true,
      commitment: r.commitment ?? null, final: r.final ?? null, ...(r.conflict ? { conflict: r.conflict } : {}) },
    ...(r.signature ? { signature: r.signature } : {}), ...(r.state === 'failed' ? { fateError: r.why ?? 'failed' } : {}),
  };
}

/** ④'s registry limits (workstreams/04-execution/src/acts.rs): agent id up to 64 characters, key up to 128. */
export const AGENT_ID_MAX = 64, KEY_MAX = 128;

/** (2026-11-17) The kind of registry these ports talk to (a label: never, alone, the identity of a registry). */
export const REGISTRY_KIND = 'workstream 4 act registry';

/**
 * (2026-11-17) The origin a port over workstream 4's registry states: {kind, registry, agentId}, frozen. `registry` is
 * the caller's explicit, non-secret name for the registry its client is connected to (no spaces, 1..256 characters);
 * it is never inferred (not from a kind, not from a file name) and grants nothing: a journal line records it
 * (resident.mjs #provenance) and it is matched against (bindingMismatchOf, live/resident-state.mjs). The same
 * contract for the resident's full port (ws04ActsPort) and the status-only one (ws04-acts-status.mjs).
 * `agentId` is the port's own, already checked by the port.
 */
export function registryOrigin(agentId, registry) {
  if (typeof registry !== 'string' || !registry.trim() || registry.length > 256 || /\s/.test(registry)) throw new TypeError('registry: the explicit, non-secret name of the registry this client is connected to (no spaces, at most 256 characters)');
  return Object.freeze({ kind: REGISTRY_KIND, registry, agentId });
}

/**
 * @param acts     workstream 4's acts client (register, status), or anything with those methods
 * @param agentId  the resident's agent id in the registry
 * @param send     (req) → ActionResult: the actual send, under req.idempotencyKey
 * @param runId    the caller's run id the acts are listed under (optional)
 * @param registry (2026-11-17, optional) the explicit name of the registry `acts` is connected to: the port then
 *                 states `origin` {kind, registry, agentId} (registryOrigin), fixed at creation and not writable.
 *                 Omitted (every earlier caller): no origin, as before; nothing is inferred, and the resident's new
 *                 journal lines record `execution: null` (held by the live reader). It changes no submit, register,
 *                 status, send or cancel.
 */
export function ws04ActsPort(acts, { agentId, send, runId = null, registry = undefined }) {
  if (typeof agentId !== 'string' || !agentId || agentId.length > AGENT_ID_MAX) throw new TypeError(`agentId: 1..${AGENT_ID_MAX} characters (workstream 4)`);
  if (typeof acts?.register !== 'function' || typeof acts?.status !== 'function') throw new TypeError('workstream 4 acts client with register() and status()');
  if (typeof send !== 'function') throw new TypeError('send(req) is required: the registry does not send');
  const origin = registry === undefined || registry === null ? null : registryOrigin(agentId, registry);
  const port = {
    kind: REGISTRY_KIND,
    retentionBells: Infinity,
    async submit(req) {
      // A key the registry cannot hold is refused before anything is sent (a definite "not sent").
      if (typeof req.idempotencyKey !== 'string' || !req.idempotencyKey || req.idempotencyKey.length > KEY_MAX)
        return { ok: false, status: 'refused', error: { code: 'BadKey', message: `idempotency key over ${KEY_MAX} characters` } };
      // Registered first, so a reply lost after the send can still be read under the key.
      await acts.register({ agentId, key: req.idempotencyKey, source: 'resident', runId });
      return send(req);
    },
    async status(key) {
      let r;
      try { r = await acts.status({ agentId, key }); } catch (e) {
        if (e?.code === 'NoRecord') return null; // never registered: never sent (R5)
        throw new Unqueryable(String(e?.message ?? e)); // the registry could not answer: read again
      }
      return fateOfReceipt(r);
    },
    async cancel() { return { cancelled: false, reason: 'NotSupported' }; }, // signed bytes cannot be stopped (§3.3)
  };
  // (2026-11-17) the stated origin, when one was given: enumerable (a caller's `{...port}` keeps it), not writable and
  // not configurable on this port (a later change of settings never changes it)
  if (origin) Object.defineProperty(port, 'origin', { value: origin, enumerable: true, writable: false, configurable: false });
  return port;
}
