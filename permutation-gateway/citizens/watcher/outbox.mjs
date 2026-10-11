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
      const social = { ...(ans.social ?? {}) };
      social.say = social.say ?? [];
      own.priv.social ??= {};
      const attach = (type, exp) => { if (typeof records.attachSocial === 'function') records.attachSocial(ans.decision_id, type, exp); else (own.priv.social[type] ??= []).push(exp); }; // integ-B: journaled
      let attached = 0;
      for (const it of items) {
        if (it.motion && !social.motion) {
          const item = social.say.length;
          const exp = records.provenance(it.decision_id, 0, 'talk');
          if (!exp) { bump('outbox_no_provenance'); note(() => ledger?.dropped(it, req.bell, 'no_provenance')); continue; }
          attach('talk', { ...exp, item });
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
          attach('ballot', { ...exp, item });
          social.ballot = { ...it.ballot, item, decision_id: it.decision_id };
          attached++;
          note(() => ledger?.attached(it, req.bell));
        } else {
          pending.set(tag, [...(pending.get(tag) ?? []), it]); // a slot is taken: next answer
        }
      }
      if (!attached) return ans;
      bump('outbox_attached', attached);
      return { ...ans, social };
    },
  };
}
