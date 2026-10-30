// The RunReceipt PORT: what ⑤ needs back from ④ for every autopilot run, as one record per run.
// ④'s RunReceipt is NOT RECEIVED: this file fixes the shape ⑤ consumes, and gives a LOCAL ADAPTER that fills it from
// what the relay shows today (agent_act answers, agent_view holds and history, GET /f/tx). Fields the relay cannot
// give are marked `from4: true` and stay null in the local adapter; ④'s implementation would fill them.
// `conformance(port, …)` (run-receipt.conformance.mjs) is the check either implementation must pass.

export const RECEIPT_VERSION = 'p05-port/0.1';

/**
 * Every field ⑤ reads. `local`: what the local adapter fills it from today. `from4`: only ④ can give it.
 * (Kept as data so that the hand-off document and the tests use one list.)
 */
export const RECEIPT_FIELDS = Object.freeze({
  runId:            { local: 'the autopilot tick id (⑤)', from4: false },
  run4Id:           { local: null, from4: true, why: '④\'s own Run id, to join ⑤\'s run to ④\'s records' },
  agentId:          { local: 'agent_view.agentId', from4: false },
  citizen:          { local: 'agent_view.citizen', from4: false },
  decisionKey:      { local: 'the inference record (⑤)', from4: false },
  policyVersion:    { local: 'agent_view.policy.version at the observation', from4: false },
  modeEpoch:        { local: 'agent_view.modeEpoch at the observation', from4: false },
  'seq.observed':   { local: 'agent_view.historySeq when the run observed', from4: false },
  'seq.closed':     { local: 'agent_view.historySeq when the run closed', from4: false },
  'acts[].requestId':       { local: 'the agent_act requestId (⑤ journal act-begin)', from4: false },
  'acts[].idempotencyKey':  { local: '<source>:<requestId>, read back from the relay history', from4: false },
  'acts[].source':          { local: 'relay history entry source', from4: false },
  'acts[].status':          { local: 'agent_act answer (sent | refused | failed | unknown)', from4: false },
  'acts[].code':            { local: 'agent_act error code', from4: false },
  'acts[].signature':       { local: 'agent_act answer', from4: false },
  'acts[].signedAt':        { local: null, from4: true, why: 'when the agent key signed (the relay does not expose it)' },
  'acts[].fate':            { local: 'GET /f/tx/{signature}: landed | failed | expired | unknown', from4: false },
  'acts[].gameCharge':      { local: 'agent_view.holds by idempotency key (reserved); settled/released only via history', from4: false },
  'acts[].cancellable':     { local: null, from4: true, why: 'whether a signed, unsent request can still be dropped' },
  'inference.status':       { local: 'api-decider record', from4: false },
  'inference.attempts':     { local: 'api-decider record (keys, outcomes, cost per attempt)', from4: false },
  'costs.inference':        { local: 'RunCostMock classes for this run\'s keys', from4: false },
  'costs.game':             { local: 'agent_view holds for this run\'s keys', from4: false },
  'cancel.stage':           { local: 'before-sign only (⑤ stops deciding)', from4: true, why: 'signed-unsent and sent stages are ④\'s' },
});

const STAGES = Object.freeze(['before-sign', 'signed-unsent', 'sent']);

/**
 * The local adapter: in memory, one process, built from the relay's reads. Not ④'s; its receipts say so.
 * @param {object} o
 * @param {Function} o.view      async () → agent_view (structuredContent)
 * @param {Function} o.txState   async signature → {state}
 * @param {object}   [o.costs]   RunCostMock (inference)
 */
export function localReceiptPort({ view, txState, costs = null }) {
  const runs = new Map();
  const port = {
    kind: 'local adapter (④ RunReceipt not received)',
    async open({ runId, decisionKey = null }) {
      if (runs.has(runId)) throw Object.assign(new Error(`run ${runId} already open`), { code: 'RunExists' });
      const v = await view();
      const r = {
        receiptVersion: RECEIPT_VERSION, provenance: port.kind, runId, run4Id: null, agentId: v.agentId, citizen: v.citizen, decisionKey,
        policyVersion: v.policy?.version ?? null, modeEpoch: v.modeEpoch ?? null, seq: { observed: v.historySeq, closed: null },
        state: 'open', inference: null, acts: [], costs: { inference: null, game: null }, cancel: null,
        missingFrom4: Object.entries(RECEIPT_FIELDS).filter(([, f]) => f.from4).map(([k]) => k),
      };
      runs.set(runId, r);
      return structuredClone(r);
    },
    attachInference(runId, inf) {
      const r = must(runId);
      if (!inf) return;
      r.decisionKey = inf.requestKey;
      r.inference = { status: inf.status, outcome: inf.outcome, called: inf.called, replayed: inf.replayed ?? false, attempts: inf.attempts.map(a => ({ key: a.key, outcome: a.outcome, stop: a.stop, cost: a.cost ? { measured: a.cost.measured, unknown: a.cost.unknown } : null })) };
      if (costs) {
        const keys = new Set(inf.attempts.map(a => a.key));
        const mine = [...costs.items.values()].filter(i => keys.has(i.key));
        const sum = st => mine.filter(i => i.state === st).reduce((t, i) => t + BigInt(st === 'settled' ? i.settled : i.amount), 0n).toString();
        r.costs.inference = { settled: sum('settled'), undecided: sum('undecided'), released: sum('released'), reserved: String(BigInt(sum('reserved')) + BigInt(sum('calling'))) };
      }
    },
    /** One act of the run: its agent_act requestId and outcome (participate's item). */
    attachAct(runId, { requestId, outcome, code = null, signature = null, proposed = null }) {
      must(runId).acts.push({ requestId, idempotencyKey: null, source: null, action: proposed, status: outcome, code, signature, signedAt: null, fate: signature ? 'unknown' : null, gameCharge: null, cancellable: null });
    },
    async close(runId) {
      const r = must(runId);
      const v = await view();
      r.seq.closed = v.historySeq;
      // Read back how the relay recorded each act: its idempotency key and source, and the game hold under that key.
      for (const a of r.acts) {
        const h = (v.history ?? []).find(x => x.type === 'action' && typeof x.key === 'string' && x.key.endsWith(`:${a.requestId}`));
        if (h) { a.idempotencyKey = h.key; a.source = h.source ?? null; }
        const hold = (v.holds ?? []).find(x => x.key === a.idempotencyKey);
        a.gameCharge = hold ? { reserved: hold.amount, state: hold.state } : { reserved: '0', state: a.status === 'sent' ? 'none or settled (see history)' : 'none' };
      }
      r.costs.game = { reserved: r.acts.reduce((t, a) => t + BigInt(a.gameCharge?.reserved ?? '0'), 0n).toString() };
      r.state = r.state === 'cancelled' ? 'cancelled' : 'closed';
      return structuredClone(r);
    },
    /** The chain's answer for every signature of the run (read only). */
    async refreshFates(runId) {
      const r = must(runId);
      for (const a of r.acts) if (a.signature) { const t = await txState(a.signature); a.fate = t?.state ?? 'unknown'; }
      return structuredClone(r);
    },
    /** The local adapter can only stop before anything is signed; the other stages are ④'s (NotSupported / Irrevocable). */
    cancel(runId, stage) {
      const r = must(runId);
      if (!STAGES.includes(stage)) throw Object.assign(new Error(`stage: ${STAGES.join(' | ')}`), { code: 'BadStage' });
      if (stage === 'sent') { r.cancel = { stage, result: 'Irrevocable' }; return r.cancel; }
      if (stage === 'signed-unsent') { r.cancel = { stage, result: 'NotSupported', why: 'needs ④: the relay signs and sends in one step today' }; return r.cancel; }
      r.cancel = { stage, result: 'stopped' };
      if (r.state === 'open') r.state = 'cancelled';
      return r.cancel;
    },
    get(runId) { const r = runs.get(runId); return r ? structuredClone(r) : null; },
    list() { return [...runs.values()].map(r => structuredClone(r)); },
  };
  const must = runId => { const r = runs.get(runId); if (!r) throw Object.assign(new Error(`no run ${runId}`), { code: 'NoRun' }); return r; };
  return port;
}
