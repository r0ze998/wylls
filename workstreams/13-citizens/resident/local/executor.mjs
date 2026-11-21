// ⑬ local resident × workstream 04: the PLAN EXECUTOR port (2026-11-22, reports/playable-2-3-4-13.md §2 step 3).
// KEY-FREE: it never signs or sends; runner.mjs does, and tells this port each fact in order.
//
// The plan lives in workstream 04's store (workstreams/04-execution src/plans.rs, `runexec plan …` through
// clients/plans.mjs): SQLite (WAL, synchronous=FULL), one write transaction per fact, a lease with an epoch. So it
// survives the resident's restarts (SIGKILL included), and a second copy of the resident cannot act on it.
//
//   reconcile({obs, follow})  every open step of the store (a recorded signature, fate unknown) is read by its
//                             signature: landed / failed settle it; past OPEN_LINE_MS with no landing it is
//                             `expired-unknown`, which stops the plan (the next plan is made from what the chain shows,
//                             the step is never sent again)
//   next({obs, mem})          → {use: {cand, plan, idx, epoch}} | {wait: why} | {none: why}
//                             makes a plan when there is none (plan.mjs makePlanSteps, `replaces` the stopped one),
//                             claims/renews the lease, checks the step (plan.mjs checkStep): a wait past
//                             PLAN_LIMITS.maxWaitBells, or a changed world, stops the plan (replan next round)
//   intend(use, bell)         the intent, BEFORE anything is signed (refused: TurnUsed, OpenStep, NotDue, Fenced …)
//   signed(use, signature)    BEFORE the one submit; a throw here means: do not submit (runner's sign hook throws)
//   settle(use, fact)         the outcome the runner read (landed / failed by signature; refused; not-sent; unknown)
import { makePlanSteps, planSpec, checkStep, PLAN_LIMITS } from './plan.mjs';
import { OPEN_LINE_MS } from './journal.mjs';

const codeText = c => (typeof c === 'string' && c ? c.replace(/[^A-Za-z0-9_()]/g, '').slice(0, 64) || null : null);

export function createPlanExecutor({ plans, owner, holder, goal, goalName, limits = PLAN_LIMITS, leaseMs = 20_000, log = () => {}, nowMs = () => Date.now() }) {
  let lastSaid = '';
  const say = (what, fields) => {
    const k = `${what}:${fields.plan ?? ''}:${fields.planStep ?? ''}:${fields.bell ?? ''}:${String(fields.why ?? fields.outcome ?? '').replace(/[0-9]+/g, '#')}`;   // (a wait is said once a turn)
    if (k === lastSaid) return;
    lastSaid = k; log('plan', { what, ...fields });
  };
  const worldOf = obs => `${obs.seasonId}:${obs.genesisTs}`;
  let lease = null;   // {plan, epoch}

  async function hold(plan) {
    const c = await plans.claim({ plan, holder, leaseMs });
    if (!c.granted) { lease = null; return { held: `the plan is held by ${c.holder} until ${new Date(c.until).toISOString()} (another copy of me, or one stopped mid-step: its lease runs out)` }; }
    if (lease?.plan !== plan || lease.epoch !== c.epoch) say('claimed', { plan, epoch: c.epoch, resetIntents: c.resetIntents });
    lease = { plan, epoch: c.epoch };
    return { epoch: c.epoch };
  }

  async function stopPlan(plan, epoch, why) {
    try { await plans.stop({ plan, holder, epoch, why: why.slice(0, 400) }); say('stopped', { plan, why }); }
    catch (e) { say('stop-refused', { plan, code: e.code, why: e.message }); }
  }

  return Object.freeze({
    holder,
    async reconcile({ obs, follow }) {
      const cur = await plans.current({ owner, world: worldOf(obs) });
      for (const o of cur.open) {
        const h = await hold(o.planId);
        if (h.held) continue;
        let r = null;
        try { r = await follow(o.signature); } catch { r = null; }
        if (r === 'landed' || r === 'failed') {
          await plans.settle({ plan: o.planId, holder, epoch: h.epoch, step: o.idx, outcome: r, signature: o.signature, code: r === 'failed' ? 'TransactionFailed' : null });
          say('reconciled', { plan: o.planId, planStep: o.idx, order: o.name, outcome: r, signature: o.signature });
        } else if (nowMs() - o.updatedMs >= OPEN_LINE_MS) {
          await plans.settle({ plan: o.planId, holder, epoch: h.epoch, step: o.idx, outcome: 'expired-unknown', code: 'NoLandingSeen' });
          say('reconciled', { plan: o.planId, planStep: o.idx, order: o.name, outcome: 'expired-unknown', why: 'no landing seen within the blockhash life: the plan stops; never sent again', signature: o.signature });
        }
      }
    },

    async next({ obs, mem }) {
      const world = worldOf(obs);
      const cur = await plans.current({ owner, world });
      if (cur.open.length) return { wait: `step ${cur.open[0].idx} of plan ${cur.open[0].planId} is ${cur.open[0].state}: nothing new until it is settled` };
      let active = cur.active;
      if (!active) {
        if (!obs.holding) return { none: 'no village yet: my brain joins and places the home; plans start after' };
        if (cur.plans >= limits.maxPlans) return { none: `${cur.plans} plans made in this world (my cap ${limits.maxPlans})` };
        const steps = makePlanSteps(obs, goal, { limits });
        if (!steps) return { wait: 'my village\'s record is not readable: no plan yet' };
        const replaces = cur.latest?.state === 'stopped' ? cur.latest.planId : null;
        const spec = planSpec({ planId: `${owner.slice(0, 8)}.${obs.seasonId}.${cur.plans + 1}`, owner, world, goal: goalName, steps, replaces });
        active = await plans.accept(spec);
        say('made', { plan: active.planId, replaces, why: replaces ? `replan: ${cur.latest.stopReason}` : cur.latest ? `the previous plan ${cur.latest.planId} is ${cur.latest.state}` : 'first plan', steps: steps.map(s => `${s.name}${s.name === 'Build' ? `:${s.fields.item}#${s.expect.copy}` : ''}`) });
      }
      const h = await hold(active.planId);
      if (h.held) return { wait: h.held };
      const step = active.steps[active.cursor];
      if (!step) return { none: `plan ${active.planId} has no step ${active.cursor}` };
      const r = checkStep(step, obs, mem, { patience: limits.maxWaitBells });
      if (r.replan) { await stopPlan(active.planId, h.epoch, `step ${step.idx} (${step.name}): ${r.replan}`); return { wait: `replanning: ${r.replan}` }; }
      if (r.wait) {
        // (how long this step has waited, kept in the resident's own memory: survives a restart with state.json)
        const key = `${active.planId}#${step.idx}`;
        if (mem.planWait?.key !== key) mem.planWait = { key, since: obs.bell };
        const waited = obs.bell - mem.planWait.since;
        if (waited > limits.maxWaitBells) { await stopPlan(active.planId, h.epoch, `step ${step.idx} (${step.name}) waited ${waited} turns: ${r.wait}`); return { wait: 'replanning: waited too long' }; }
        say('wait', { plan: active.planId, planStep: step.idx, order: step.name, bell: obs.bell, waited, why: r.wait });
        return { wait: r.wait };
      }
      return { use: { cand: r.go, plan: active.planId, idx: step.idx, epoch: h.epoch, of: active.steps.length } };
    },

    async intend(use, bell) {
      return plans.intend({ plan: use.plan, holder, epoch: use.epoch, step: use.idx, bell });
    },

    async signed(use, signature) {
      try { return await plans.signed({ plan: use.plan, holder, epoch: use.epoch, step: use.idx, signature }); }
      catch (e) { throw Object.assign(new Error(`plan store refused the signature: ${e.message}`), { code: `Plan${e.code ?? 'Unknown'}` }); }
    },

    async settle(use, { outcome, signature = null, code = null, bookedBell = null }) {
      const r = await plans.settle({ plan: use.plan, holder, epoch: use.epoch, step: use.idx, outcome, signature: ['landed', 'failed'].includes(outcome) ? signature : null, code: codeText(code), bookedBell });
      say('settled', { plan: use.plan, planStep: use.idx, outcome, planState: r.planState, cursor: r.cursor, of: use.of });
      return r;
    },
  });
}
