// Workstream 12: the memory module's entry point (the API workstreams 13 and 4 call; see 02-contracts.ja.md).
//
//   const m = createMemory({path?})
//   m.say({...})          an utterance from the social layer (speaker already authenticated by the caller)
//   m.observe({...})      a fact from the execution side (workstream 4)
//   m.note({...}) / m.correct({...})   the owner's own interpretation, and its correction
//   m.knowledge(viewer, bell)          what `viewer` knows at `bell` (pure fold; isolation first)
//   m.summary(viewer, bell)            source-carrying lines
//   await m.choosePartner({viewer, bell, request, candidates, limits, policy?})
//        builds the decision input, asks `policy` (default: the deterministic reference policy; workstream 5
//        plugs a model here), validates the answer, falls back to the reference policy when it is invalid,
//        and journals a `decision` record with the cited ids. It never calls a network itself.
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
    knowledge: (viewer, bell) => knowledge(journal.records(), viewer, bell),
    summary: (viewer, bell) => summarize(m.knowledge(viewer, bell)),
    async choosePartner({ viewer, bell, request, candidates, limits = {}, policy = null, policyName = 'reference-v1' }) {
      const k = m.knowledge(viewer, bell);
      const input = decisionInput({ k, request, candidates, limits });
      const ref = referencePolicy(input);
      let used = 'reference-v1', answer = ref.answer, refused = null;
      if (policy) {
        let raw;
        try { raw = await policy(structuredClone(input)); } catch (e) { raw = null; refused = [`policy_error:${e.message}`.slice(0, 80)]; }
        const v = validateAnswer(input, raw);
        if (v.ok) { answer = v.answer; used = policyName; } else refused = refused ?? v.errors;
      }
      const rec = decision({ owner: viewer.tag, bell, request, chosen: answer.choice, policy: used, cited: answer.cite,
        contributions: ref.explanation.terms });
      journal.append(rec);
      return { input, answer, policy: used, refused, explanation: ref.explanation, ranking: ref.ranking, decision_id: rec.id };
    },
  };
  return m;
}

export { knowledge } from './fold.mjs';
export { summarize, renderBlock } from './view.mjs';
export { decisionInput, referencePolicy, validateAnswer, ANSWER_SCHEMA, CONTRACT } from './advise.mjs';
