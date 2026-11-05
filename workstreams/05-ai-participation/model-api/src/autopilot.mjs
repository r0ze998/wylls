// The autopilot: ⑤'s start and stop of away-mode decisions, one tick at a time, ONE PROCESS.
//
//   start   only when the relay says the owner switched the agent on (mode auto) and the agent's key is the Citizen's
//           session now; the autopilot never switches the relay mode and never sets or changes a session key
//           (those are the owner's wallet operations)
//   tick    one participate() run: preflight → (the model call) → guard → game operations through the EXISTING
//           MCP agent_act tool and relay (POST /f/agent/action, AgentGateway) → one decision record.
//           This is not ④'s Run / cancel / reconcile: ④'s material is not received and nothing of it is integrated
//           (EXECUTION_PATH). ⑤ does not build its own resend or reconcile for game operations either.
//   stop    the autopilot stops deciding at once; a budget stop (the decider's or the relay's) stops it the same way
//   resume  only by the owner, with a note; the next tick checks the budget again before any call
//
// It guards one process: two Autopilot objects for one agent in this process are refused, but a second PROCESS is
// not detected, so a second process is not safe (its reservations and its decision keys are its own).
import { participate } from '../../src/participate.mjs';
import { checkAccess } from './access-check.mjs';
import { checkBounds } from './bounds.mjs';
import { idempotencyKeyOf, txStateFromFate, txStateFromTx } from './fate-reader.mjs';
import { statusOf } from './status-query.mjs';

/** How many open acts one tick re-reads (GET /f/agent/fate is rate-limited by the relay: 20 burst, 2/s per IP). */
export const ACT_REFRESH_PER_TICK = 8;

const RUNNING = new Map(); // agentId → Autopilot, this process only

const runPrefix = agentId => `${String(agentId).slice(0, 8)}:t`;
function lastTickOf(journal, agentId) {
  const pre = runPrefix(agentId);
  let n = 0;
  for (const e of journal?.entries ?? []) if (typeof e.runId === 'string' && e.runId.startsWith(pre)) n = Math.max(n, Number(e.runId.slice(pre.length)) || 0);
  return n;
}
const scrub = (text, secret) => (secret ? String(text).split(secret).join('[capability]') : String(text));

export { checkAccess } from './access-check.mjs';

/** Where game operations go today, and what is NOT integrated. Carried in every status and record. */
export const EXECUTION_PATH = Object.freeze({
  via: 'existing MCP agent_act → relay POST /f/agent/action (AgentGateway), as in this repository',
  fourIntegrated: false,
  notIntegrated: Object.freeze(['④ Run (the execution unit)', '④ cancel / stop contract', '④ reconcile of signed requests and their costs', '④ acts registry store (no external entry: ⑤ keeps the same contract locally, acts-registry.mjs)']),
  why: '④ 77c5cbe2: the acts registry and GET /f/agent/fate exist; the registry is a Rust library with no entry for another process',
  withActs: 'with `acts` and `fate`: every act that reached the relay is registered under ④\'s run4Id and followed by GET /f/agent/fate (acts-registry.mjs, fate-reader.mjs)',
});

/** One record per tick, the inference and the game apart: which failed, and who refused. */
export function decisionRecord(report) {
  const inf = report.inference ?? null;
  return {
    runId: report.runId, status: report.status, stoppedBy: report.stoppedBy ?? null, executionPath: EXECUTION_PATH.via, fourIntegrated: false,
    inference: inf ? { status: inf.status, outcome: inf.outcome, called: inf.called, replayed: inf.replayed ?? false, requestKey: inf.requestKey, provider: inf.provider,
      configuredModel: inf.configuredModel, servedModel: inf.servedModel, preflight: inf.preflight.map(r => r.code), errors: inf.errors,
      attempts: inf.attempts.map(a => ({ key: a.key, outcome: a.outcome, stop: a.stop, cost: a.cost && { measured: a.cost.measured, unknown: a.cost.unknown } })), possibleDoubleBilling: inf.possibleDoubleBilling ?? null } : null,
    game: (report.items ?? []).map(it => ({ requestId: it.requestId, proposed: it.proposed, outcome: it.outcome, code: it.code ?? null,
      // Who said no: the relay (it answered agent_act), or this executor's guard and checks before anything was sent.
      decidedBy: it.attempts !== undefined ? 'existing relay (via MCP agent_act)' : 'executor (guard, before sending)', signature: it.signature ?? null })),
    notes: (report.notes ?? []).map(n => n.code),
  };
}

export class Autopilot {
  /**
   * @param {object} o
   * @param {object} o.world    the agent's reads and MCP: {mcp(), publicWorld, txState, agentId} (the local world in this build)
   * @param {object} o.mandate  the owner's mandate
   * @param {object} o.decider  apiDecider(...)
   * @param {object} o.journal  RunJournal
   */
  /**
   * @param {object} [o.citizen]   CitizenBoundary (the owner's own client on the same Citizen goes first)
   * @param {object} [o.receipts]  a RunReceipt port (run-receipt.mjs); the local adapter until ④'s is received
   */
  /**
   * @param {object} [o.acts]       acts-registry.mjs FileActsRegistry (④'s act-run contract, local adapter)
   * @param {Function} [o.fate]     fate-reader.mjs fateReader(...): GET /f/agent/fate
   * @param {string} [o.actSource]  how the MCP server keys acts: 'mcp' (unpatched) or 'ai' (patch 0003, source 'ai')
   */
  constructor({ world, mandate, decider, journal, citizen = null, receipts = null, mcp = null, mcpFor = null, owner = null, tokenCheck = null, lease = null, acts = null, fate = null, actSource = null }) {
    if ((acts || fate) && !['mcp', 'ai'].includes(actSource)) throw Object.assign(new Error('acts/fate need actSource: mcp or ai (the MCP server\'s key prefix)'), { code: 'BadActSource' });
    /** ④'s registry contract and the fate read: without them, the older GET /f/tx path (expired is not taken as proof). */
    Object.assign(this, { acts, fate, actSource });
    Object.assign(this, { w: world, mandate, decider, journal, citizen, receipts, state: 'idle', records: [], events: [] });
    /** The MCP server the autopilot acts through: by default the world's; pass one created with source 'ai' (patch 0003). */
    this.mcp = mcp ?? (() => world.mcp());
    /** token → MCP server over it (for a resume with the owner's new token); the token is never stored on this object. */
    this.mcpFor = mcpFor;
    /** The owner this autopilot works for: fixed at the first successful start (or given), checked on every start and resume. */
    this.owner = owner;
    /** How the token is checked before start and resume (access-check.mjs): {probe: {enabled, relayTree, budget}}; none → unverifiable → no start. */
    this.tokenCheck = tokenCheck;
    /** process-lease.mjs ProcessLease: one autopilot per agent ACROSS processes (without it: this process only). */
    this.lease = lease;
    // A restarted process continues the run ids of its journal: tick n+1, never a second "t1" with a different decision.
    this.ticks = lastTickOf(journal, world.agentId);
    this.scope = 'one process: a second Autopilot in this process is refused; a second process is NOT detected (not safe)';
  }

  #event(e) { this.events.push({ at: this.w.publicWorld.clockSec(), ...e }); }

  async start({ by }) {
    const holder = RUNNING.get(this.w.agentId);
    if (holder && holder !== this) throw Object.assign(new Error('this agent already has an autopilot in this process'), { code: 'AlreadyRunning' });
    if (this.state === 'stopped-by-budget' || this.state === 'stopped-capability') throw Object.assign(new Error(`${this.state}: only the owner resumes`), { code: 'NeedsOwner' });
    // Bounded authority first (a continuing world does not make a mandate or a budget permanent).
    const b = checkBounds({ mandate: this.mandate, costs: this.decider.costs ?? null, nowSec: this.w.publicWorld.clockSec() });
    if (!b.ok) { this.#event({ op: 'start', by, refused: b.reasons[0].code, why: b.reasons[0].detail }); throw Object.assign(new Error(b.reasons.map(r => r.detail).join('; ')), { code: b.reasons[0].code, reasons: b.reasons }); }
    const a = await checkAccess(this.mcp(), { mandate: this.mandate, owner: this.owner, probe: this.tokenCheck?.probe ?? null });
    this.lastAccess = { ok: a.ok, code: a.code ?? null, method: a.method ?? null, sideEffects: a.sideEffects ?? null };
    if (!a.ok) { this.#event({ op: 'start', by, refused: a.code, why: a.detail }); throw Object.assign(new Error(a.detail), { code: a.code === 'NotAuto' || a.code === 'NotDelegated' ? 'NotReady' : a.code, check: a.code }); }
    this.owner ??= a.owner;
    if (this.lease) {
      // Another process's live autopilot for this agent refuses the start (AlreadyRunning); a dead or hung one is taken over.
      const l = this.lease.acquire();
      // Its unfinished reservations get the restart rule: calling → undecided (never released), reserved → released.
      const recovered = this.decider.costs?.recoverStale ? this.decider.costs.recoverStale({ ttlMs: this.lease.ttlMs }) : null;
      this.#event({ op: 'lease', epoch: l.epoch, takenOver: l.takenOver ? { pid: l.takenOver.pid, epoch: l.takenOver.epoch } : null, recovered });
    }
    RUNNING.set(this.w.agentId, this);
    this.state = 'running';
    this.#event({ op: 'start', by });
    return this.status();
  }

  async tick() {
    if (this.state !== 'running') return { skipped: true, state: this.state };
    if (this.lease) {
      try { this.lease.renew(); } catch (e) {
        if (e.code !== 'LeaseLost') throw e;
        // Another process took this agent over: this one decides, reserves and sends nothing more.
        this.state = 'stopped-lease-lost'; this.stoppedBy = 'LeaseLost'; RUNNING.delete(this.w.agentId);
        this.#event({ op: 'stop', by: 'lease', code: 'LeaseLost' });
        return { skipped: true, state: this.state };
      }
    }
    const runId = `${runPrefix(this.w.agentId)}${++this.ticks}`;
    this.currentRun = runId;
    if (this.receipts) await this.receipts.open({ runId });
    // Acts still open from earlier ticks (pending, result unknown, could not ask): read again, bounded.
    const followed = this.acts && this.fate ? await this.#refreshOpenActs() : null;
    const txState = this.fate ? txStateFromFate(this.fate, { agentId: this.w.agentId, source: this.actSource }) : txStateFromTx(this.w.txState);
    const report = await participate({ mcp: this.mcp(), world: this.w.publicWorld, txState, meter: null, mandate: this.mandate, decider: this.decider, journal: this.journal, runId, boundary: this.#actFence() });
    const rec = decisionRecord(report);
    if (this.acts) rec.acts = await this.#registerActs(runId, report);
    if (followed) rec.followed = followed;
    if (this.receipts) {
      this.receipts.attachInference(runId, report.inference ?? null);
      // Every item that reached agent_act: its requestId is in the journal's act-begin of this run.
      const begun = this.journal.entries.filter(e => e.runId === runId && e.step === 'act-begin');
      for (const it of report.items ?? []) {
        const b = begun.find(e => e.requestId === it.requestId);
        if (b) this.receipts.attachAct(runId, { requestId: b.attemptId, outcome: it.outcome, code: it.code ?? null, signature: it.signature ?? null, proposed: it.proposed });
      }
      rec.receipt = await this.receipts.close(runId);
    }
    this.records.push(rec);
    if (report.status === 'stopped-by-budget') { this.state = 'stopped-by-budget'; this.stoppedBy = report.stoppedBy; RUNNING.delete(this.w.agentId); this.#event({ op: 'stop', by: 'budget', code: report.stoppedBy }); }
    // The relay no longer takes this autopilot's capability (the owner rotated it, e.g. when granting ③'s MCP server):
    // agent_view is a public read, so the next preflight would not see it and every tick would pay for a model call whose
    // act cannot go. Stop until the owner hands a token over and resumes.
    else if ((report.items ?? []).some(it => it.code === 'BadCapability')) { this.state = 'stopped-capability'; this.stoppedBy = 'BadCapability'; RUNNING.delete(this.w.agentId); this.#event({ op: 'stop', by: 'relay', code: 'BadCapability' }); }
    return rec;
  }

  /**
   * The check right before each act: the lease is still this process's (a takeover in the middle of a long tick stops
   * the act, not only the next reservation), then the same Citizen's boundary (③ goes first).
   */
  #actFence() {
    if (!this.lease) return this.citizen;
    const lease = this.lease, citizen = this.citizen;
    return { beforeAct: (observed, now, o) => (lease.check() ? (citizen ? citizen.beforeAct(observed, now, o) : { ok: true }) : { ok: false, code: 'LeaseLost', detail: 'another process took this agent over during the run' }) };
  }

  /**
   * Every act of this run that reached the relay (act-begin in the journal): registered under ④'s run4Id, then one
   * fate read when a reader is given. A registry refusal (another source or run under the key) is recorded, not hidden.
   */
  async #registerActs(runId, report) {
    const out = [];
    const begun = this.journal.entries.filter(e => e.runId === runId && e.step === 'act-begin');
    for (const b of begun) {
      const key = idempotencyKeyOf(this.actSource, b.attemptId);
      let run4Id;
      try { run4Id = this.acts.register({ agentId: this.w.agentId, key, source: this.actSource, runId }); } catch (e) { out.push({ requestId: b.attemptId, key, error: e.code ?? 'RegisterFailed', why: e.message }); continue; }
      const r = this.fate ? await this.acts.refresh(run4Id, this.fate) : this.acts.receipt(run4Id);
      out.push({ requestId: b.attemptId, run4Id, state: r.state, final: r.final, signature: r.signature, validUntil: r.lastValidBlockHeight, signedAt: r.signedAt });
      const item = (report.items ?? []).find(it => it.requestId === b.requestId);
      if (item) Object.assign(item, { run4Id, fateState: r.state });
    }
    return out;
  }

  /** Re-read acts not yet final (oldest first, at most ACT_REFRESH_PER_TICK per tick). */
  async #refreshOpenActs() {
    const mine = this.acts.open().filter(r => r.agentId === this.w.agentId).sort((a, b) => a.registeredAt - b.registeredAt).slice(0, ACT_REFRESH_PER_TICK);
    const out = [];
    for (const r of mine) { const x = await this.acts.refresh(r.run4Id, this.fate); out.push({ run4Id: x.run4Id, state: x.state, final: x.final }); }
    return out;
  }

  /** ③'s status question for one act, in ④'s states when a fate reader is given (status-query.mjs). */
  actStatus(requestId) {
    return statusOf({ journal: this.journal, txState: this.w.txState, fate: this.fate, agentId: this.w.agentId, source: this.actSource }, requestId);
  }

  stop({ by }) {
    if (this.state === 'running') this.state = 'stopped';
    RUNNING.delete(this.w.agentId);
    if (this.lease && this.state !== 'stopped-lease-lost') { try { this.lease.release(); } catch { /* the lease file is gone or another process holds it */ } }
    this.#event({ op: 'stop', by });
    return this.status();
  }

  /** Only the owner, with a note (e.g. "raised the inference cap"). The budget is checked again before the next call. */
  /**
   * Only the owner, with a note. After a BadCapability stop it needs the owner's new token (`capability`, turned into an
   * MCP server by `mcpFor`). The token is checked (checkAccess) BEFORE the autopilot is switched over or any model call:
   * a token that is not this agent's current one, another agent, another owner or a narrowed scope keeps it stopped.
   * The token's value is never written to the events, the records or the error (`[capability]`).
   */
  async resume({ by, note, capability = null }) {
    if (by !== 'owner') throw Object.assign(new Error('only the owner resumes'), { code: 'NeedsOwner' });
    if (!note) throw Object.assign(new Error('a resume needs a note'), { code: 'NoteRequired' });
    if (this.state === 'running') return this.status();
    const safeNote = scrub(note, capability);
    if (this.state === 'stopped-capability' && !capability) throw Object.assign(new Error('stopped on BadCapability: resume needs the owner\'s new token'), { code: 'NeedsToken' });
    if (capability) {
      if (!this.mcpFor) throw Object.assign(new Error('no mcpFor: this autopilot cannot take a token'), { code: 'NoTokenPath' });
      const next = () => this.mcpFor(capability);
      const a = await checkAccess(next(), { mandate: this.mandate, owner: this.owner, probe: this.tokenCheck?.probe ?? null });
      if (!a.ok) { this.#event({ op: 'resume', by, note: safeNote, refused: a.code }); throw Object.assign(new Error(scrub(a.detail, capability)), { code: a.code }); }
      this.mcp = next;
    }
    this.state = 'idle';
    this.#event({ op: 'resume', by, note: safeNote });
    return this.start({ by });
  }

  status() { return { state: this.state, stoppedBy: this.stoppedBy ?? null, ticks: this.ticks, scope: this.lease ? 'one per agent across processes on this machine (process lease); other machines are not seen' : this.scope, executionPath: EXECUTION_PATH }; }
}
