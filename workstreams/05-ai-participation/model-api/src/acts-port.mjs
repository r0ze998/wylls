// ⑤'s connection to ④'s act registry, behind ONE interface with TWO implementations that say which they are:
//
//   fourActsPort(client)     REAL: ④'s registry (the run store, SQLite) through ④'s own client
//                            `workstreams/04-execution/clients/acts.mjs` → `runexec act register|status|list`
//                            (④ b82fafa8 / 95686606, contract §7). `status` with the wallet's port reads
//                            GET /f/agent/fate once on 127.0.0.1 and records it in ④'s store. Nothing is sent.
//   localActsPort(registry)  SUBSTITUTE: acts-registry.mjs (⑤'s file copy of the same contract) and fate-reader.mjs,
//                            for as long as ④'s binary is not available where ⑤ runs.
//
// Every receipt carries `connection: 'real' | 'substitute'` and the port's `kind`, so a record never passes a
// substitute's answer off as ④'s. Errors use ④'s codes: BadRequest | NoRecord | Conflict | StoreError | Spawn.
//
// What a caller may do next is ④'s rule (acts.rs next_step), the same in both:
//   landed, failed → done · not-sent, expired → new-attempt (a NEW key only) · unknown → hold (never send again:
//   it may have landed; no amount of time changes that) · unqueryable → read-again · pending, registered → wait
import { pathToFileURL } from 'node:url';
import { idempotencyKeyOf } from './fate-reader.mjs';

export const SOURCES = Object.freeze(['ai', 'mcp', 'browser', 'resident']);
export const NEXT = Object.freeze({ landed: 'done', failed: 'done', 'not-sent': 'new-attempt', expired: 'new-attempt', unknown: 'hold', unqueryable: 'read-again' });
export const nextOf = state => { const next = NEXT[state] ?? 'wait'; return { next, newAttemptAllowed: next === 'new-attempt' }; };
const withNext = r => ({ ...r, ...nextOf(r.state) });
const err = (code, message) => Object.assign(new Error(message), { code });

/** REAL: ④'s client (createActsClient(...) from ④'s clients/acts.mjs). */
export function fourActsPort(client, { label = '④ runexec act (run store)' } = {}) {
  const tag = r => ({ ...r, connection: 'real', port: label });
  const wrap = p => p.then(tag, e => { throw err(e?.code ?? 'Spawn', e?.message ?? String(e)); });
  return {
    kind: label, real: true,
    // ④ 95686606's register reads, then inserts: two processes registering the same NEW key at the same moment make
    // the loser fail with BadRequest "UNIQUE constraint failed" (the row exists; it should have been the same answer).
    // Registering is idempotent, so that one error is retried once; any other error, or a second one, is returned.
    register: ({ agentId, key, source, runId = null }) => wrap(client.register({ agentId, key, source, runId }).catch(e => {
      if (e?.code === 'BadRequest' && /UNIQUE constraint failed/.test(e.message ?? '')) return client.register({ agentId, key, source, runId });
      throw e;
    })),
    status: (q, o = {}) => wrap(client.status(q, o)),
    list: runId => client.list(runId).then(x => ({ ...x, acts: (x.acts ?? []).map(tag) }), e => { throw err(e?.code ?? 'Spawn', e?.message ?? String(e)); }),
  };
}

/**
 * Loads ④'s client from ④'s tree (a path: ⑤'s tree does not carry ④'s files) and makes the REAL port.
 * @param {object} o  {clientPath, bin, db, gatewayPort}
 */
export async function loadFourActsPort({ clientPath, bin, db, gatewayPort = null, timeoutMs }) {
  const m = await import(pathToFileURL(clientPath).href);
  return fourActsPort(m.createActsClient({ bin, db, gatewayPort, ...(timeoutMs ? { timeoutMs } : {}) }));
}

/** SUBSTITUTE: ⑤'s file registry with the fate reader (fate omitted: answers from the file only). */
export function localActsPort({ registry, fate = null, label = '⑤ local substitute (acts-registry.mjs)' }) {
  const tag = r => withNext({ ...r, connection: 'substitute', port: label });
  const idOf = q => q.run4Id ?? registry.idOf(q.agentId, q.key);
  return {
    kind: label, real: false,
    async register({ agentId, key, source, runId = null }) {
      if (!SOURCES.includes(source)) throw err('BadRequest', `source must be one of ${SOURCES.join(', ')}`);
      return tag(registry.receipt(registry.register({ agentId, key, source, runId })));
    },
    async status(q, { read = true } = {}) {
      const id = idOf(q);
      if (!registry.get(id)) throw err('NoRecord', `no act ${id} is registered`);
      return tag(read && fate ? await registry.refresh(id, fate) : registry.receipt(id));
    },
    async list(runId) { return { runId, acts: registry.byRun(runId).map(r => tag(registry.receipt(r.run4Id))) }; },
  };
}

/**
 * The run id ⑤ registers its acts under: ONE per autopilot (agent), not per tick. A retry of the same attempt in a
 * later tick (after a crash between register and send, or a failed registration) keeps its key, and ④ refuses the
 * same key under another run id (Conflict): a per-tick id would leave such an act unsendable for ever. The tick that
 * sent it is in ⑤'s journal (act-begin.runId).
 */
export const actsRunIdOf = agentId => `p05-autopilot:${String(agentId).slice(0, 48)}`;

/**
 * participate's pre-send hook: register the act under its key BEFORE the agent_act call. A registration that fails
 * (Conflict, a store that cannot be opened, the binary missing) stops that act: nothing is sent without its record.
 */
export function registerBeforeSend(port, { agentId, source, runId = actsRunIdOf(agentId) }) {
  return async ({ requestId }) => {
    try {
      const r = await port.register({ agentId, key: idempotencyKeyOf(source, requestId), source, runId: typeof runId === 'function' ? runId() : runId });
      return { ok: true, run4Id: r.run4Id, connection: r.connection };
    } catch (e) {
      return { ok: false, code: e.code === 'Conflict' ? 'ActsConflict' : 'ActsUnavailable', detail: `${e.code}: ${e.message}`.slice(0, 200) };
    }
  };
}

/**
 * verifyPending's txState from the registry's status (one read of the wallet, recorded in the registry). Only ④'s
 * proved ends are final; `unknown` (hold), `unqueryable` (read again) and `pending` stay open, told apart by
 * `fateState`. A NoRecord answer (never registered) is unqueryable here: it says nothing about the chain.
 */
export function txStateFromActs(port, { agentId, source }) {
  return async (signature, { requestId } = {}) => {
    if (!requestId) return { state: 'unknown', final: false, fateState: 'unqueryable', why: 'no requestId to read by', source: port.kind };
    let r;
    try { r = await port.status({ agentId, key: idempotencyKeyOf(source, requestId) }); } catch (e) {
      return { state: 'unknown', final: false, fateState: 'unqueryable', why: `${e.code}: ${e.message}`, source: port.kind };
    }
    if (r.signature && signature && r.signature !== signature) return { state: 'unknown', final: false, fateState: 'unqueryable', why: `the registry has another signature (${r.signature})`, source: port.kind };
    const final = ['landed', 'failed', 'expired', 'not-sent'].includes(r.state);
    return { state: final ? (r.state === 'not-sent' ? 'expired' : r.state) : 'unknown', final, proved: final, fateState: r.state, next: r.next, newAttemptAllowed: r.newAttemptAllowed, run4Id: r.run4Id, connection: r.connection, why: r.why ?? r.lastReadError ?? null, source: port.kind };
  };
}
