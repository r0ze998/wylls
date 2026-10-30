// Workstream 12: the memory module's entry point (the API workstreams 13 and 4 call; see 02-contracts.ja.md).
//
//   const m = createMemory({path?})
//   m.say({...})          an utterance from the social layer (speaker already authenticated by the caller)
//   m.observe({...})      a fact from the execution side (workstream 4), with `bell` (happened) and `created_bell` (observed)
//   m.note({...}) / m.correct({...})   the owner's own interpretation, and its correction
//   m.knowledge(viewer, clock, {observedBy})   what `viewer` knows (pure fold; isolation first)
//   m.summary(viewer, clock)                   source-carrying lines
//   await m.choosePartner({viewer, bell, request, candidates, limits, policy?})
//        builds the decision input, asks `policy` (default: the deterministic reference policy; workstream 5
//        plugs a model here), validates the answer, falls back to the reference policy when it is invalid,
//        and journals a `decision` record with its input and cited ids. It never calls a network itself.
//   m.reassess(decisionId, observedBy)
//        the same decision judged at its own bell, but with everything observed by `observedBy`: which
//        commitments read differently, how each candidate's terms moved, and whether the reference choice would
//        differ. Nothing is rewritten; the original decision stays as it was taken.
import { Journal } from './store.mjs';
import { correction, decision, fact, note, utterance } from './records.mjs';
import { knowledge } from './fold.mjs';
import { summarize } from './view.mjs';
import { decisionInput, referencePolicy, validateAnswer } from './advise.mjs';

export function createMemory({ path = null } = {}) {
  const journal = Journal.open(path);
  const m = {
    journal,
    say: args => { const r = utterance(args); return { ...journal.append(r), record: r }; },
    observe: args => { const r = fact(args); return { ...journal.append(r), record: r }; },
    note: args => { const r = note(args); return { ...journal.append(r), record: r }; },
    correct: args => { const r = correction(args); return { ...journal.append(r), record: r }; },
    knowledge: (viewer, clock, opts) => knowledge(journal.records(), viewer, clock, opts),
    summary: (viewer, clock, opts) => summarize(m.knowledge(viewer, clock, opts)),
    async choosePartner({ viewer, bell, request, candidates, limits = {}, policy = null, policyName = 'reference-v2' }) {
      const k = m.knowledge(viewer, bell);
      const input = decisionInput({ k, request, candidates, limits });
      const ref = referencePolicy(input);
      let used = 'reference-v2', answer = ref.answer, refused = null;
      if (policy) {
        let raw;
        try { raw = await policy(structuredClone(input)); } catch (e) { raw = null; refused = [`policy_error:${e.message}`.slice(0, 80)]; }
        const v = validateAnswer(input, raw);
        if (v.ok) { answer = v.answer; used = policyName; } else refused = refused ?? v.errors;
      }
      const rec = decision({ owner: viewer.tag, nation: viewer.nation, bell, request, candidates, limits, chosen: answer.choice, policy: used,
        cited: answer.cite, contributions: ref.explanation.terms });
      journal.append(rec);
      return { input, answer, policy: used, refused, explanation: ref.explanation, ranking: ref.ranking, decision_id: rec.id };
    },
    reassess(decisionId, observedBy) {
      const d = journal.get(decisionId);
      if (!d || d.type !== 'decision') throw new Error(`reassess: no decision ${decisionId}`);
      const viewer = { tag: d.owner, nation: d.nation };
      const then = m.knowledge(viewer, d.bell);
      const now = m.knowledge(viewer, d.bell, { observedBy });
      const before = referencePolicy(decisionInput({ k: then, request: d.request, candidates: d.candidates, limits: d.limits }));
      const after = referencePolicy(decisionInput({ k: now, request: d.request, candidates: d.candidates, limits: d.limits }));
      const stateThen = new Map(then.commitments.map(c => [c.id, c.state]));
      const changed = now.commitments.filter(c => stateThen.get(c.id) !== c.state)
        .map(c => ({ commitment: c.id, debtor: c.debtor, then: stateThen.get(c.id) ?? 'not_known', now: c.state }));
      const newly = now.facts.filter(f => !then.ids.has(f.id)).map(f => ({ fact: f.id, kind: f.kind, bell: f.bell, created_bell: f.created_bell }));
      return {
        decision: decisionId, bell: d.bell, observed_by: observedBy, chosen: d.chosen, policy: d.policy,
        reference_then: before.answer.choice, reference_now: after.answer.choice,
        would_differ: before.answer.choice !== after.answer.choice,
        changed_commitments: changed, late_observed_facts: newly,
        terms_then: before.explanation.terms, terms_now: after.explanation.terms,
      };
    },
  };
  return m;
}

export { knowledge } from './fold.mjs';
export { summarize, renderBlock } from './view.mjs';
export { decisionInput, referencePolicy, validateAnswer, ANSWER_SCHEMA, CONTRACT } from './advise.mjs';
