// Workstream 12: the memory module's entry point (the API workstreams 13 and 4 call; see 02-contracts.ja.md).
//
//   const m = createMemory({path?, world, partitions, legacy, keys})
//        world      = {cluster, world_id}: the one, continuing world this memory is about (workstream 4 defines it)
//        partitions = {id: {program, season}}: 4's registry of this world's partitions (today the Season accounts);
//                     facts of an unregistered partition are kept in the journal but not used (reported as unusable)
//        legacy     = {partition}: the partition the v3 records were written in (read as they are, not rewritten)
//        keys       = {principal: ed25519 public key hex}: the registry allocations are verified against (the roster)
//   Nothing in this module ends, resets or expires with a war period or a Season: memory and reputation history stay;
//   decay is a separate, continuous rule over world bells.
//   m.say({...})          an utterance from the social layer (speaker already authenticated by the caller)
//   m.observe({...})      a fact from the execution side (workstream 4), with `bell` (happened) and `created_bell` (observed)
//   m.allocate({...})     a signed allocation operation (verified here; refused without a valid signature)
//   m.note({...}) / m.correct({...})   the owner's own interpretation, and its correction
//   m.knowledge(viewer, clock, {observedBy})   what `viewer` knows (pure fold; isolation first)
//   m.summary(viewer, clock)                   source-carrying lines
//   await m.choosePartner({viewer, bell, request, candidates, limits, policy?})
//        builds the decision input, asks `policy` (default: the deterministic reference policy; workstream 5
//        plugs a model here), validates the answer, falls back to the reference policy when it is invalid,
//        and journals a `decision` record that keeps the exact input shown and the cited ids. No network.
//   m.reassess(decisionId, observedBy)
//        the decision judged again at its own bell. It keeps three things apart:
//          late_arrivals  records of things that HAD happened by the decision bell but were observed after it:
//                         these are used;
//          later_events   things that happened after the decision bell (new acts, new deliveries): listed, never
//                         used to judge the past decision;
//          backdated      records that reached memory after the decision but claim to have been observed by then:
//                         contradictory, excluded and listed.
//        The original decision, its input as shown and what was visible then stay as recorded; `then_reproducible`
//        checks that the journal still yields the same input.
import { Journal } from './store.mjs';
import { allocation, canonical, correction, decision, fact, note, sha256hex, utterance, visibleTo } from './records.mjs';
import { knowledge } from './fold.mjs';
import { summarize } from './view.mjs';
import { decisionInput, referencePolicy, validateAnswer } from './advise.mjs';

export function createMemory({ path = null, world = null, partitions = {}, legacy = null, keys = {} } = {}) {
  const journal = Journal.open(path, { keys });
  const fold = (records, viewer, clock, opts = {}) => knowledge(records, viewer, clock, { ...opts, world, partitions, legacy });
  const m = {
    journal, world, partitions, legacy,
    say: args => { const r = utterance(args); return { ...journal.append(r), record: r }; },
    observe: args => { const r = fact(args); return { ...journal.append(r), record: r }; },
    allocate: args => { const r = allocation(args); return { ...journal.append(r), record: r }; },
    note: args => { const r = note(args); return { ...journal.append(r), record: r }; },
    correct: args => { const r = correction(args); return { ...journal.append(r), record: r }; },
    knowledge: (viewer, clock, opts) => fold(journal.records(), viewer, clock, opts),
    summary: (viewer, clock, opts) => summarize(m.knowledge(viewer, clock, opts)),
    async choosePartner({ viewer, bell, request, candidates, limits = {}, policy = null, policyName = 'reference-v4' }) {
      const k = m.knowledge(viewer, bell);
      const input = decisionInput({ k, request, candidates, limits });
      const ref = referencePolicy(input);
      let used = 'reference-v4', answer = ref.answer, refused = null;
      if (policy) {
        let raw;
        try { raw = await policy(structuredClone(input)); } catch (e) { raw = null; refused = [`policy_error:${e.message}`.slice(0, 80)]; }
        const v = validateAnswer(input, raw);
        if (v.ok) { answer = v.answer; used = policyName; } else refused = refused ?? v.errors;
      }
      const rec = decision({ owner: viewer.tag, nation: viewer.nation, bell, request, candidates, limits, input, chosen: answer.choice, policy: used,
        cited: answer.cite, contributions: ref.explanation.terms });
      journal.append(rec);
      return { input, answer, policy: used, refused, explanation: ref.explanation, ranking: ref.ranking, decision_id: rec.id };
    },
    reassess(decisionId, observedBy) {
      const d = journal.get(decisionId);
      if (!d || d.type !== 'decision') throw new Error(`reassess: no decision ${decisionId}`);
      const viewer = { tag: d.owner, nation: d.nation };
      const all = journal.records();
      const at = journal.indexOf(decisionId);
      const obs = r => r.created_bell ?? r.bell;
      const mine = r => r.type !== 'decision' && visibleTo(r.visibility, viewer);
      // what had reached memory before the decision record: the journal must still yield the input it was shown
      const before = all.slice(0, at);
      const thenInput = decisionInput({ k: fold(before, viewer, d.bell), request: d.request, candidates: d.candidates, limits: d.limits });
      const backdated = all.slice(at + 1).filter(r => mine(r) && obs(r) <= d.bell);
      const backdatedIds = new Set(backdated.map(r => r.id));
      const usable = all.filter(r => !backdatedIds.has(r.id));
      const now = fold(usable, viewer, d.bell, { observedBy });
      const then = fold(before, viewer, d.bell);
      const nowRef = referencePolicy(decisionInput({ k: now, request: d.request, candidates: d.candidates, limits: d.limits }));
      const thenRef = referencePolicy(d.input);
      const stateThen = new Map(then.commitments.map(c => [c.id, c.state]));
      const brief = r => ({ id: r.id, type: r.type, kind: r.kind ?? r.act?.type ?? r.op ?? null, bell: r.bell, created_bell: obs(r) });
      return {
        decision: decisionId, bell: d.bell, observed_by: observedBy,
        original: { chosen: d.chosen, policy: d.policy, cited: d.cited, input_sha256: d.input_sha256 },
        then_reproducible: sha256hex(canonical(thenInput)) === d.input_sha256,
        reference_then: thenRef.answer.choice, reference_now: nowRef.answer.choice,
        would_differ: thenRef.answer.choice !== nowRef.answer.choice,
        changed_commitments: now.commitments.filter(c => stateThen.get(c.id) !== c.state)
          .map(c => ({ commitment: c.id, debtor: c.debtor, then: stateThen.get(c.id) ?? 'not_known', now: c.state })),
        late_arrivals: usable.filter(r => mine(r) && r.bell <= d.bell && obs(r) > d.bell && obs(r) <= observedBy).map(brief),
        later_events: usable.filter(r => mine(r) && r.bell > d.bell && obs(r) <= observedBy).map(brief),
        backdated: backdated.map(brief),
        terms_then: thenRef.explanation.terms, terms_now: nowRef.explanation.terms,
      };
    },
  };
  return m;
}

export { knowledge } from './fold.mjs';
export { summarize, renderBlock } from './view.mjs';
export { decisionInput, referencePolicy, validateAnswer, ANSWER_SCHEMA, CONTRACT } from './advise.mjs';
