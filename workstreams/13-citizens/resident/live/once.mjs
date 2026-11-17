// One step of the operator resident's live path, from explicit settings, with a result an operator can read
// (2026-11-17). The product entry over factory.mjs createLiveResident(...).step(): observe → candidates → the no-charge
// rule → a proposal, or, when the resident is stopped, only the results of its matched submitted keys (stop-A).
//
// What it never does: sign, post, submit, register, cancel, join, re-send, call a model, or choose a wallet, URL,
// registry, key or funding. The decider is the no-charge rule, fixed: no provider and no `allow` can be given here.
// Every result says `enacted: false`. Nothing runs at import; one call of runOnce is one step.
//
// Not bin/observe-canonical.mjs: that command prints workstream 12's canonical evidence about counterparties; this one
// runs the resident's own live step.
import { createLiveResident } from './factory.mjs';
import { registryOrigin, AGENT_ID_MAX } from '../ports/ws04-acts.mjs';

export const RESULT_KIND = 'ws13-live-once/1';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALLOWED = new Set(['heraldUrl', 'boardUrl', 'wallet', 'residentDir', 'rpc', 'actsStatus']);
const short = (v, n = 160) => String(v ?? '').replace(/[A-Za-z0-9+/=_-]{40,}/g, '…').slice(0, n);
const httpUrl = v => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } };

/**
 * The settings, checked; nothing is completed with a default. → {ok, config, missing: [{field, why}], refused: [field]}
 * Required: heraldUrl, wallet, residentDir. Optional, each whole or absent: boardUrl; rpc {url, cluster, source};
 * actsStatus {bin, db, registry, agentId, gatewayPort?, bridge?}.
 */
export function onceConfig(input) {
  const missing = [], refused = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, config: null, missing: [{ field: '*', why: 'the settings must be an object' }], refused: [] };
  const i = input;
  for (const k of Object.keys(i)) if (!ALLOWED.has(k)) refused.push(k);   // provider, allow, authority, execution, … are not settings of this entry
  if (!httpUrl(i.heraldUrl)) missing.push({ field: 'heraldUrl', why: 'the herald of the world: an http(s) URL without credentials' });
  if (typeof i.wallet !== 'string' || !B58.test(i.wallet)) missing.push({ field: 'wallet', why: "the resident's own address (base58), given by its owner; none is chosen here" });
  if (typeof i.residentDir !== 'string' || !i.residentDir.startsWith('/')) missing.push({ field: 'residentDir', why: "the resident's directory (absolute): its stop and submitted keys are read from it" });
  if (i.boardUrl !== undefined && i.boardUrl !== null && !httpUrl(i.boardUrl)) missing.push({ field: 'boardUrl', why: "workstream 1's board: an http(s) URL without credentials, or absent" });
  if (i.rpc !== undefined && i.rpc !== null) {
    const r = i.rpc;
    if (!r || typeof r !== 'object' || !httpUrl(r.url) || typeof r.cluster !== 'string' || !r.cluster || typeof r.source !== 'string' || !r.source) missing.push({ field: 'rpc', why: 'all of url, cluster (the network it serves) and source (who declares it), or none' });
    else for (const k of Object.keys(r)) if (!['url', 'cluster', 'source'].includes(k)) refused.push(`rpc.${k}`);
  }
  if (i.actsStatus !== undefined && i.actsStatus !== null) {
    const a = i.actsStatus;
    if (!a || typeof a.bin !== 'string' || !a.bin.startsWith('/') || typeof a.db !== 'string' || !a.db.startsWith('/')) missing.push({ field: 'actsStatus.bin/db', why: 'absolute paths of runexec and its run store' });
    const agentOk = !!a && typeof a.agentId === 'string' && a.agentId.length > 0 && a.agentId.length <= AGENT_ID_MAX;
    if (!agentOk) missing.push({ field: 'actsStatus.agentId', why: `the resident's agent id in the registry (1..${AGENT_ID_MAX} characters)` });
    // (2026-11-17) the registry name under the same contract as the ports (ws04-acts.mjs registryOrigin)
    let regOk = false;
    try { regOk = !!a && !!registryOrigin(agentOk ? a.agentId : 'x', a.registry); } catch { regOk = false; }
    if (!regOk) missing.push({ field: 'actsStatus.registry', why: "the registry's explicit, non-secret name (no spaces, 1..256 characters); never inferred" });
    if (a && a.gatewayPort !== undefined && a.gatewayPort !== null && !(Number.isInteger(a.gatewayPort) && a.gatewayPort > 0 && a.gatewayPort < 65536)) missing.push({ field: 'actsStatus.gatewayPort', why: 'a port on 127.0.0.1, or absent' });
    if (a && a.bridge !== undefined && typeof a.bridge !== 'boolean') missing.push({ field: 'actsStatus.bridge', why: 'true, false or absent' });
    for (const k of Object.keys(a ?? {})) if (!['bin', 'db', 'registry', 'agentId', 'gatewayPort', 'bridge'].includes(k)) refused.push(`actsStatus.${k}`);
  }
  const ok = !missing.length && !refused.length;
  // only the checked fields, copied (a later change of the caller's object changes nothing here)
  const a = i.actsStatus;
  return { ok, config: ok ? Object.freeze({ heraldUrl: i.heraldUrl, boardUrl: i.boardUrl ?? null, wallet: i.wallet, residentDir: i.residentDir,
    rpc: i.rpc ? Object.freeze({ url: i.rpc.url, cluster: i.rpc.cluster, source: i.rpc.source }) : null,
    actsStatus: a ? Object.freeze({ bin: a.bin, db: a.db, registry: a.registry, agentId: a.agentId, gatewayPort: a.gatewayPort ?? null, bridge: a.bridge === true }) : null }) : null, missing, refused };
}

/** What this step may read and write, said as it is (workstream 4's own behaviour included). */
function effectsOf(config) {
  return {
    reads: ['herald /h/season, /h/me (when not stopped)', ...(config.boardUrl ? ["workstream 1's board /coop/config, /coop/view (when not stopped)"] : []),
      ...(config.rpc ? ['the chain through the RPC, for a plan (when not stopped)'] : []), "the resident's charter.json, state.json and halt file",
      ...(config.actsStatus ? ['workstream 4 run store through runexec, for matched submitted keys (only when stopped)'] : [])],
    writes: config.actsStatus?.gatewayPort ? ["workstream 4's run store: each status read with a gateway port records the wallet's answer there (workstream 4's behaviour)"] : ['none by this step'],
    sent: 'nothing: no signature, post, submission, registration, cancel or join',
  };
}

const answerOf = r => (r === null ? { answer: 'not registered (workstream 4 NoRecord)' }
  : { answer: r.fate ?? 'unknown', status: r.status ?? null, ...(r.duplicate ? { duplicate: true } : {}), ...(r.ws04?.commitment ? { commitment: r.ws04.commitment } : {}), ...(r.fateError ? { fateError: short(r.fateError, 80) } : {}) });

/** The step's result as an operator reads it: observed basis, choice, proposal (never "sent"), stop-A, unknowns. */
export function summarizeStep(r, config) {
  const base = { kind: RESULT_KIND, enacted: false, effects: effectsOf(config) };
  if (r?.stopped) {
    const rs = r.resident ?? {};
    return { ...base, outcome: 'stopped',
      stop: { why: rs.stop?.why ?? r.stopped, reasons: rs.stop?.reasons ?? [r.stopped] },
      stopA: {
        worldRead: rs.live?.read ?? 'none',
        confirmed: (r.confirmed?.read ?? []).filter(x => !('unqueryable' in x) && !('why' in x)).map(x => ({ key: x.key, ...answerOf(x.result) })),
        couldNotRead: (r.confirmed?.read ?? []).filter(x => 'unqueryable' in x || 'why' in x).map(x => ({ key: x.key, why: x.unqueryable ? 'the registry could not answer (read again later)' : short(x.why, 80) })),
        notMatched: (rs.submittedHeld ?? []).map(h => ({ key: h.key, why: short(h.why, 120) })),
        why: short(rs.submittedWhy ?? r.confirmed?.why ?? ''),
      },
      unsentIntents: rs.unsent ?? null };
  }
  const p = r?.proposal ?? null;
  const plan = p?.plan;
  return { ...base, outcome: p ? 'proposal' : 'wait',
    world: r?.world ?? null, bell: r?.bell ?? null, bellBasis: r?.bellBasis ?? null,
    decision: r?.decision ? { choice: r.decision.choice, by: r.decision.by, why: short(r.decision.why) } : null,
    proposal: p ? {
      kind: p.candidate.kind, request: p.candidate.request, source: p.candidate.source ?? null, offer: p.candidate.offer ?? null,
      enacted: false, notice: 'a proposal only: nothing was signed, posted or sent, and nothing has landed',
      needs: p.needs, missingAuthority: p.missingAuthority,
      ...(p.record ? { record: p.record, recordMissing: p.recordMissing } : {}),
      ...(plan ? { plan: plan.ok ? { ok: true, steps: plan.plan?.dirs?.length ?? null, caravanSeq: plan.fields?.seq ?? null, fee: plan.fields?.fee !== undefined ? String(plan.fields.fee) : null, estimate: plan.estimate ?? null }
        : { ok: false, code: plan.code ?? null, why: short(plan.why) } } : {}),
      ...(p.held ? { held: p.held.map(h => short(h)) } : {}),
    } : null,
    candidates: (r?.candidates ?? []).map(c => ({ id: c.id, kind: c.kind, ...(c.held ? { held: c.held.map(h => short(h, 120)) } : {}) })),
    unsupported: r?.unsupported ?? [], why: (r?.why ?? []).map(w => short(w)), unknown: (r?.unknown ?? []).map(u => ({ what: u.what, why: short(u.why) })),
    held: (r?.held ?? []).map(h => ({ what: h.what, ...(h.id ? { id: h.id } : {}), why: short(h.why) })),
    resident: r?.resident ? { stop: r.resident.stop ?? null, notMatched: (r.resident.submittedHeld ?? []).length } : null };
}

/**
 * One step. The settings are checked HERE, whoever calls (2026-11-17: a direct call is not assumed to have checked
 * them): invalid or foreign settings return {outcome: 'config-missing', missing, refused} before anything is made,
 * stepped, fetched or run. `make` is createLiveResident (a stand-in only for a test). The no-charge rule is fixed:
 * provider null, allow empty, authority empty.
 * → summarizeStep(…) | {kind, outcome: 'config-missing'|'error', …}
 */
export async function runOnce(input, { fetchImpl = globalThis.fetch, make = createLiveResident } = {}) {
  const c = onceConfig(input);
  if (!c.ok) return { kind: RESULT_KIND, outcome: 'config-missing', enacted: false, missing: c.missing, refused: c.refused };
  const config = c.config;
  try {
    const r = make({ heraldUrl: config.heraldUrl, boardUrl: config.boardUrl, rpc: config.rpc, wallet: config.wallet, residentDir: config.residentDir, actsStatus: config.actsStatus, provider: null, allow: {}, authority: {}, fetchImpl });
    return summarizeStep(await r.step(), config);
  } catch (e) {
    return { kind: RESULT_KIND, outcome: 'error', enacted: false, error: { code: typeof e?.code === 'string' ? e.code : e?.name ?? 'Error', message: short(e?.message, 120) } };
  }
}
