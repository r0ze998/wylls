// A READ-ONLY result port over workstream 4's act registry, for the operator resident's stop-A (2026-11-17): it reads
// the result of a key already submitted and nothing else. It has no submit, register, cancel or send; it holds no key
// and signs nothing. (ws04-acts.mjs ws04ActsPort is the resident's full execution port: it needs `send` and registers
// before sending, which a result reader must never do.)
//
// What `status` does in workstream 4 (workstreams/04-execution/clients/acts.mjs createActsClient): it runs
// `runexec act status --agent <agentId> --key <key> --db <db>` (no shell). When the client was made with a
// `gatewayPort`, runexec also reads the agent wallet's GET /f/agent/fate on 127.0.0.1 once and RECORDS that answer in
// the run store (db): a read of the wallet and a write to the registry's own store. Without a gateway port it answers
// from the store only. This port does not change either behaviour; it is not "no write at all" when a gateway port is
// given.
//
// Answers, as the resident's execution port answers (ws04-acts.mjs, 08-retention-contract R4/R5), reusing its code:
//   null          ONLY workstream 4's own NoRecord (runexec exit 3; the client turns any other "NoRecord" into Spawn):
//                 the key was never registered
//   a fate        fateOfReceipt: landed, failed, expired, not-sent, pending (registered), unknown kept as given;
//                 a Duplicate with a signature is that, never this key's success; commitment, final and conflict kept
//   throws        Unqueryable: the registry could not answer (read again; says nothing about the act)
//
// Its origin {kind, registry, agentId} is the caller's explicit statement that this client is connected to the
// registry named `registry` (a non-secret name the operator gives it, e.g. where the run store lives), for the agent
// `agentId`. It is fixed at creation and never inferred: not from a kind label and not from the db file's name. It
// grants nothing; it is matched against the provenance a journal line recorded (resident.mjs bindingMismatchOf), and
// `kind` is the registry's kind, the same the resident's own port declares (status-only is `access`, not another kind).
import { fateOfReceipt, Unqueryable, AGENT_ID_MAX, KEY_MAX, REGISTRY_KIND, registryOrigin } from './ws04-acts.mjs';

export { REGISTRY_KIND };

/** → {kind, access: 'status-only', origin, status(key)} */
export function ws04ActsStatusPort(acts, { agentId, registry }) {
  if (typeof acts?.status !== 'function') throw new TypeError('workstream 4 acts client with status()');
  if (typeof agentId !== 'string' || !agentId || agentId.length > AGENT_ID_MAX) throw new TypeError(`agentId: 1..${AGENT_ID_MAX} characters (workstream 4)`);
  const origin = registryOrigin(agentId, registry);   // (2026-11-17) the same contract as the full port (ws04-acts.mjs)
  return Object.freeze({
    kind: REGISTRY_KIND,
    access: 'status-only',
    origin,
    async status(key) {
      if (typeof key !== 'string' || !key || key.length > KEY_MAX) throw new Unqueryable(`not a registry key (1..${KEY_MAX} characters)`);
      let r;
      try { r = await acts.status({ agentId, key }); } catch (e) {
        if (e?.code === 'NoRecord') return null;   // workstream 4's own NoRecord only (exit 3)
        throw new Unqueryable(String(e?.message ?? e).slice(0, 200));
      }
      return fateOfReceipt(r);
    },
  });
}
