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
import { participate, tool } from '../../src/participate.mjs';

const RUNNING = new Map(); // agentId → Autopilot, this process only

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
  constructor({ world, mandate, decider, journal }) {
    Object.assign(this, { w: world, mandate, decider, journal, state: 'idle', ticks: 0, records: [], events: [] });
    this.scope = 'one process: a second Autopilot in this process is refused; a second process is NOT detected (not safe)';
  }

  #event(e) { this.events.push({ at: this.w.publicWorld.clockSec(), ...e }); }

  async start({ by }) {
    const holder = RUNNING.get(this.w.agentId);
    if (holder && holder !== this) throw Object.assign(new Error('this agent already has an autopilot in this process'), { code: 'AlreadyRunning' });
    if (this.state === 'stopped-by-budget') throw Object.assign(new Error('stopped by the budget: only the owner resumes'), { code: 'NeedsOwner' });
    const v = (await tool(this.w.mcp(), 'agent_view')).structuredContent;
    const why = v?.mode !== 'auto' ? 'the owner has not switched the agent on (relay mode is not auto)' : v?.delegation?.delegated !== true ? 'the agent\'s key is not the Citizen\'s session: the owner delegates it with their wallet; the autopilot never does' : null;
    if (why) { this.#event({ op: 'start', by, refused: why }); throw Object.assign(new Error(why), { code: 'NotReady' }); }
    RUNNING.set(this.w.agentId, this);
    this.state = 'running';
    this.#event({ op: 'start', by });
    return this.status();
  }

  async tick() {
    if (this.state !== 'running') return { skipped: true, state: this.state };
    const runId = `${this.w.agentId.slice(0, 8)}:t${++this.ticks}`;
    this.currentRun = runId;
    const report = await participate({ mcp: this.w.mcp(), world: this.w.publicWorld, txState: this.w.txState, meter: null, mandate: this.mandate, decider: this.decider, journal: this.journal, runId });
    const rec = decisionRecord(report);
    this.records.push(rec);
    if (report.status === 'stopped-by-budget') { this.state = 'stopped-by-budget'; this.stoppedBy = report.stoppedBy; RUNNING.delete(this.w.agentId); this.#event({ op: 'stop', by: 'budget', code: report.stoppedBy }); }
    return rec;
  }

  stop({ by }) {
    if (this.state === 'running') this.state = 'stopped';
    RUNNING.delete(this.w.agentId);
    this.#event({ op: 'stop', by });
    return this.status();
  }

  /** Only the owner, with a note (e.g. "raised the inference cap"). The budget is checked again before the next call. */
  async resume({ by, note }) {
    if (by !== 'owner') throw Object.assign(new Error('only the owner resumes'), { code: 'NeedsOwner' });
    if (!note) throw Object.assign(new Error('a resume needs a note'), { code: 'NoteRequired' });
    if (this.state === 'running') return this.status();
    this.state = 'idle';
    this.#event({ op: 'resume', by, note });
    return this.start({ by });
  }

  status() { return { state: this.state, stoppedBy: this.stoppedBy ?? null, ticks: this.ticks, scope: this.scope, executionPath: EXECUTION_PATH }; }
}
