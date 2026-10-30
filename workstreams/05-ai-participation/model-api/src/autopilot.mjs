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
import { randomBytes } from 'node:crypto';
import { participate, tool } from '../../src/participate.mjs';

const RUNNING = new Map(); // agentId → Autopilot, this process only

const runPrefix = agentId => `${String(agentId).slice(0, 8)}:t`;
function lastTickOf(journal, agentId) {
  const pre = runPrefix(agentId);
  let n = 0;
  for (const e of journal?.entries ?? []) if (typeof e.runId === 'string' && e.runId.startsWith(pre)) n = Math.max(n, Number(e.runId.slice(pre.length)) || 0);
  return n;
}
const scrub = (text, secret) => (secret ? String(text).split(secret).join('[capability]') : String(text));

/**
 * Whether the autopilot may decide through `mcp` now, checked BEFORE any model call (start and resume):
 *   the target agent is the mandate's; the owner is the one this autopilot works for; the relay is in auto and the agent's
 *   key is the Citizen's session; every command the mandate delegates is still in the relay policy; and the token is the
 *   agent's current one.
 * The relay has no authenticated read (agent_view is public), so the token is checked by an agent_act that can never pass
 * the relay's gate: its policy version and mode epoch are both far off, so the relay authenticates it and then refuses it
 * at the gate (StalePolicy) — nothing is held, sent or added to the history (only an idempotency record is kept).
 * THIS IS A WORKAROUND over the existing relay; a read-only authenticated `agent_whoami` is a shared-code choice for ④.
 */
export async function checkAccess(mcp, { mandate, owner = null }) {
  const fail = (code, detail) => ({ ok: false, code, detail });
  const v = (await tool(mcp, 'agent_view')).structuredContent;
  if (!v || v.error) return fail('ViewFailed', v?.error?.code ?? 'agent_view did not answer');
  if (mandate.agentId && v.agentId !== mandate.agentId) return fail('WrongAgent', 'the token\'s server reads another agent than the mandate\'s');
  if (owner && v.owner !== owner) return fail('WrongOwner', 'the agent belongs to another owner than the one this autopilot works for');
  if (v.mode !== 'auto') return fail('NotAuto', 'the owner has not switched the agent on (relay mode is not auto)');
  if (v.delegation?.delegated !== true) return fail('NotDelegated', 'the agent\'s key is not the Citizen\'s session: the owner delegates it with their wallet; the autopilot never does');
  const missing = (mandate.allowed ?? []).filter(n => !(v.policy?.allowed ?? []).includes(n));
  if (missing.length) return fail('ScopeNarrowed', `the relay policy no longer allows ${missing.join(', ')}`);
  const probe = await tool(mcp, 'agent_act', { requestId: `p05.probe.${randomBytes(8).toString('hex')}`, policyVersion: v.policy.version + 1_000_000, modeEpoch: v.modeEpoch + 1_000_000, action: { name: mandate.allowed?.[0] ?? 'Harvest', fields: {} }, reason: 'access check: cannot pass the gate' });
  const code = probe.structuredContent?.error?.code ?? probe.structuredContent?.code ?? null;
  if (code === 'BadCapability') return fail('BadCapability', 'the relay does not take this token for this agent');
  if (code !== 'StalePolicy') return fail('ProbeInconclusive', `the access check answered ${code ?? 'without a code'}: not resuming`);
  return { ok: true, owner: v.owner, agentId: v.agentId, policyVersion: v.policy.version, method: 'gate-refused probe (workaround; no authenticated read exists)' };
}

/** Where game operations go today, and what is NOT integrated. Carried in every status and record. */
export const EXECUTION_PATH = Object.freeze({
  via: 'existing MCP agent_act → relay POST /f/agent/action (AgentGateway), as in this repository',
  fourIntegrated: false,
  notIntegrated: Object.freeze(['④ Run (the execution unit)', '④ cancel / stop contract', '④ reconcile of signed requests and their costs']),
  why: '④ bd415e7 not received',
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
  constructor({ world, mandate, decider, journal, citizen = null, receipts = null, mcp = null, mcpFor = null, owner = null }) {
    Object.assign(this, { w: world, mandate, decider, journal, citizen, receipts, state: 'idle', records: [], events: [] });
    /** The MCP server the autopilot acts through: by default the world's; pass one created with source 'ai' (patch 0003). */
    this.mcp = mcp ?? (() => world.mcp());
    /** token → MCP server over it (for a resume with the owner's new token); the token is never stored on this object. */
    this.mcpFor = mcpFor;
    /** The owner this autopilot works for: fixed at the first successful start (or given), checked on every start and resume. */
    this.owner = owner;
    // A restarted process continues the run ids of its journal: tick n+1, never a second "t1" with a different decision.
    this.ticks = lastTickOf(journal, world.agentId);
    this.scope = 'one process: a second Autopilot in this process is refused; a second process is NOT detected (not safe)';
  }

  #event(e) { this.events.push({ at: this.w.publicWorld.clockSec(), ...e }); }

  async start({ by }) {
    const holder = RUNNING.get(this.w.agentId);
    if (holder && holder !== this) throw Object.assign(new Error('this agent already has an autopilot in this process'), { code: 'AlreadyRunning' });
    if (this.state === 'stopped-by-budget' || this.state === 'stopped-capability') throw Object.assign(new Error(`${this.state}: only the owner resumes`), { code: 'NeedsOwner' });
    const a = await checkAccess(this.mcp(), { mandate: this.mandate, owner: this.owner });
    if (!a.ok) { this.#event({ op: 'start', by, refused: a.code, why: a.detail }); throw Object.assign(new Error(a.detail), { code: a.code === 'NotAuto' || a.code === 'NotDelegated' ? 'NotReady' : a.code, check: a.code }); }
    this.owner ??= a.owner;
    RUNNING.set(this.w.agentId, this);
    this.state = 'running';
    this.#event({ op: 'start', by });
    return this.status();
  }

  async tick() {
    if (this.state !== 'running') return { skipped: true, state: this.state };
    const runId = `${runPrefix(this.w.agentId)}${++this.ticks}`;
    this.currentRun = runId;
    if (this.receipts) await this.receipts.open({ runId });
    const report = await participate({ mcp: this.mcp(), world: this.w.publicWorld, txState: this.w.txState, meter: null, mandate: this.mandate, decider: this.decider, journal: this.journal, runId, boundary: this.citizen });
    const rec = decisionRecord(report);
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

  stop({ by }) {
    if (this.state === 'running') this.state = 'stopped';
    RUNNING.delete(this.w.agentId);
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
      const a = await checkAccess(next(), { mandate: this.mandate, owner: this.owner });
      if (!a.ok) { this.#event({ op: 'resume', by, note: safeNote, refused: a.code }); throw Object.assign(new Error(scrub(a.detail, capability)), { code: a.code }); }
      this.mcp = next;
    }
    this.state = 'idle';
    this.#event({ op: 'resume', by, note: safeNote });
    return this.start({ by });
  }

  status() { return { state: this.state, stoppedBy: this.stoppedBy ?? null, ticks: this.ticks, scope: this.scope, executionPath: EXECUTION_PATH }; }
}
