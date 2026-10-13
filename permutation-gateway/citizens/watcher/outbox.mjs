// AC6: delivery of the council calls' output to the brain.
//
// A council call (the motion at C0, the ballot at C0 + 3, section 3.4) is answered by the mind with a TALK or BALLOT object that the
// BRAIN signs (the mind holds no key). The brain signs and posts only what a `POST /v1/decide` answer carries in its `social` field,
// under that answer's `decision_id` (bots/src/ai/follow.rs `post_social`); a council call has no step of its own. So the watcher keeps
// the output of each council call here and attaches it to the NEXT decide answer of the same AI (the bots step every bell, so that is
// about a bell later): the motion window is three bells and the ballot window three bells, which leaves room for this.
//
// Provenance (section 6.2 rule 4): the social store asks `records.provenance(decision_id, item, type)`. The item is registered under the
// decide answer's record too (a copy of the council record's own expectation, with the item number the brain will send), and the
// item also carries the council decision's own id (`decision_id`) so a brain that posts items under their own ids works unchanged.
// No other state of the mind is touched. This is a stop-gap for a seam between AC1a (council calls) and AC3b (posting): see
// AC6-NOTES.md, deviation 2.
//
// A SEALED answer carries no talk item (contract 7.2, 7.3 M8; AC6-NOTES.md deviation 2, "sealed carriers"). A decide answer whose record
// is sealed (it sends a march, or it was made under a live Strike Order) posts nothing to the talk channel before its release, and a talk
// record filed under a sealed decision fails verify-minds M8 (`sealed_decision_posted`). Run take-2 did exactly that: the motion call was
// answered first, the same turn's step chose a march, the motion rode on that sealed answer and was posted under its id (take-1 had the
// two calls in the other order and passed by timing). So a MOTION that meets a sealed answer is HELD: it stays pending and rides on the
// AI's next unsealed answer, as it did in take-1. What that costs:
//   - a motion's turn is in its signed bytes and the social service takes it within one turn (MOTION_VALID_BELLS): a motion that meets
//     only sealed answers while it is valid expires unposted. That is counted (`outbox_held_sealed`, then `outbox_expired`) and written
//     to the delivery ledger (status `expired`, why `sealed_carrier`, `held_sealed`). The motion's own, unsealed record is public anyway.
//   - carried a turn later, the motion meets an answer whose own `say` items have later sequence numbers. The brain posts `say[]` in
//     order and then the motion slot, and the service refuses a seq that is not above the wallet's last (6.2 rule 3, `SeqReplay`; the
//     brain counts a refusal and never retries). The motion then goes in FRONT of those says inside `say[]` (the brain posts every
//     `say[]` entry as a talk under the entry's own `item`), counted `outbox_motion_first`.
// A BALLOT still rides on a sealed answer: 7.2 withholds the say and the why of a sealed decision, a ballot is neither (it is hidden by the
// council itself until the Strike Order opens, 6.5 step 4), M8 flags talk records only, and a held ballot could miss its window.
// The second line of defence is in mind/records.mjs: `attachSocial`, `provenance` and `consume` refuse a talk under a sealed record.
export const MOTION_VALID_BELLS = 1; // a motion's bell is in its signed bytes: the book accepts it within one bell of now
export const BALLOT_VALID_BELLS = 2;

export function createOutbox({ records, stats = {}, ledger = null } = {}) {
  const pending = new Map(); // tag -> [item]
  const bump = (k, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
  const note = (fn) => { try { fn?.(); } catch { /* the delivery ledger (call_ledger.mjs) is a record, never a reason to lose an item */ } };

  return {
    /** item = {tag, kind: 'motion'|'ballot', period, decision_id, bell, motion, ballot} */
    push(item) {
      const l = pending.get(item.tag) ?? [];
      l.push(item);
      pending.set(item.tag, l);
      bump('outbox_pushed');
      note(() => ledger?.pushed(item));
    },
    pendingCount: tag => (pending.get(tag)?.length ?? 0),
    /** the items still valid at `bell`; expired ones are dropped and counted */
    take(tag, bell) {
      const l = pending.get(tag) ?? [];
      const keep = [];
      const out = [];
      for (const it of l) {
        const ttl = it.kind === 'motion' ? MOTION_VALID_BELLS : BALLOT_VALID_BELLS;
        if (bell - it.bell > ttl) { bump('outbox_expired'); note(() => ledger?.expired(it, bell)); continue; }
        if (bell < it.bell) { keep.push(it); continue; }
        out.push(it);
      }
      if (keep.length) pending.set(tag, keep); else pending.delete(tag);
      return out;
    },
    /**
     * Attach the pending council output of the AI that asked to its decide answer. Returns the answer to send (a new object when something
     * was attached; the mind's cached answer is never mutated).
     */
    decorate(req, ans) {
      const tag = req?.ai?.tag;
      if (!tag || !ans?.decision_id) return ans;
      const items = this.take(tag, req.bell);
      if (!items.length) return ans;
      const own = records.getPrivate(ans.decision_id);
      if (!own) { bump('outbox_no_record', items.length); for (const it of items) note(() => ledger?.dropped(it, req.bell, 'no_record')); return ans; }
      const sealedCarrier = Boolean(own.full?.sealed); // decided when the record was added; it never flips (mind/records.mjs)
      const keep = it => pending.set(tag, [...(pending.get(tag) ?? []), it]);
      const social = { ...(ans.social ?? {}) };
      social.say = social.say ?? [];
      own.priv.social ??= {};
      // integ-B: journaled. False when the records refuse the item (a talk under a sealed record): then nothing is handed to the brain.
      const attach = (type, exp) => {
        if (typeof records.attachSocial === 'function') return records.attachSocial(ans.decision_id, type, exp) !== false;
        (own.priv.social[type] ??= []).push(exp);
        return true;
      };
      let attached = 0;
      // motions first: the item numbers follow the brain's post order (its says, the motion, the ballot) whatever order the items wait in
      for (const it of [...items.filter(x => x.motion), ...items.filter(x => !x.motion)]) {
        if (it.motion && sealedCarrier) {
          // a sealed answer carries no talk item (see the header): the motion waits for the AI's next unsealed answer
          keep(it);
          it.held_by ??= [];
          if (!it.held_by.includes(ans.decision_id)) { // a same-turn repeat hands out the same cached answer: one hold per sealed answer
            it.held_by.push(ans.decision_id);
            bump('outbox_held_sealed');
            note(() => ledger?.held?.(it, req.bell));
          }
        } else if (it.motion && !social.motion) {
          const item = social.say.length;
          const exp = records.provenance(it.decision_id, 0, 'talk');
          if (!exp) { bump('outbox_no_provenance'); note(() => ledger?.dropped(it, req.bell, 'no_provenance')); continue; }
          if (!attach('talk', { ...exp, item })) { bump('outbox_refused'); note(() => ledger?.dropped(it, req.bell, 'refused_by_records')); continue; }
          social.motion = { ...it.motion, item, decision_id: it.decision_id };
          attached++;
          note(() => ledger?.attached(it, req.bell));
        } else if (it.ballot && !social.ballot) {
          const exp = records.provenance(it.decision_id, 0, 'ballot');
          if (!exp) { bump('outbox_no_provenance'); note(() => ledger?.dropped(it, req.bell, 'no_provenance')); continue; }
          // The item number is the position in the brain's post order (its says, then the motion, then the ballot) and a (decision_id, item) pair is
          // used once whatever the record type (verify-minds M8, FB3). A fixed 0 collided with the answer's own `say[0]` (a talk with item 0 under
          // the same decide answer): pilot ai-pilot-A1 had 3 such ballots, M8 `duplicate_use`.
          const item = social.say.length + (social.motion ? 1 : 0);
          if (!attach('ballot', { ...exp, item })) { bump('outbox_refused'); note(() => ledger?.dropped(it, req.bell, 'refused_by_records')); continue; }
          social.ballot = { ...it.ballot, item, decision_id: it.decision_id };
          attached++;
          note(() => ledger?.attached(it, req.bell));
        } else {
          keep(it); // a slot is taken: next answer
        }
      }
      if (!attached) return ans;
      // A motion decided before this answer's own says has the lower sequence number: posted after them (the motion slot) the social
      // service would refuse it as SeqReplay and the brain would not retry. It goes in front of them in `say[]`, with the item number
      // it was registered under (see the header). An answer without such a say keeps the motion in its slot, as before.
      if (social.motion && Number.isFinite(social.motion.seq) && social.say.some(x => Number.isFinite(x?.seq) && x.seq > social.motion.seq)) {
        social.say = [social.motion, ...social.say];
        social.motion = null;
        bump('outbox_motion_first');
      }
      bump('outbox_attached', attached);
      return { ...ans, social };
    },
  };
}
