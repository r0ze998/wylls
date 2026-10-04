// AC1a: the council calls (section 3.4: motion and ballot) the watcher drives: motion + one speech, one ballot,
// records, provenance, idempotency per (AI, kind, period).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMindHarness, loadWireFixture, sessionAnswer, makeSocial, makeSpeech, TAGS, WALLETS } from './fixtures/ai-mind-doubles.mjs';

const { json: wire } = loadWireFixture();
const council = () => ({ period: 4, state: 'motions', options: [{ option: 1, kind: 'camp', p: 3, q: 4, ratio: 'favourable' }, { option: 2, kind: 'strike', p: 5, q: 6, ratio: 'even' }], motions: [], ballots_cast: 2, closes_bell: 60, candidates_hash: 'cd'.repeat(32) });
const decideReq = () => { const r = JSON.parse(JSON.stringify(wire.request)); r.deadline_unix_ms = Date.now() + 60000; return r; };
const councilAnswer = (kind, over = {}) => (body) => ({ goal_id: 'G1', choose: [], params: {}, say: [], council: kind === 'motion' ? { motion: 2 } : { ballot: 1 }, trust: [], mem: [], why: 'Option fits goal G1.', ...over });
const arg = (over = {}) => ({ tag: TAGS[0], kind: 'motion', period: 4, bell: 48, deadline_unix_ms: Date.now() + 60000, ...over });

async function harness(respond, extra = {}) {
  const social = makeSocial({ council: council() });
  const h = await makeMindHarness({ social, respond: (b, n) => (n === 0 ? sessionAnswer(b, { kinds: ['build'] }) : respond(b, n)), ...extra });
  await h.mind.decide(decideReq()); // gives the mind the AI's situation (the last one the brain sent)
  h.llama.bodies.length = 0;
  return h;
}

test('a motion: option 2 with one speech becomes a signed-ready TALK (kind 1, nation channel, ref = period << 8 | option)', async () => {
  const h = await harness(councilAnswer('motion', { say: [{ channel: 'nation', text: 'Option 2 is within reach of our armies.' }] }));
  try {
    const a = await h.mind.councilCall(arg());
    assert.equal(a.mode, 'model');
    const m = a.social.motion;
    assert.deepEqual([m.kind, m.channel, m.target, m.ref, m.origin, m.item], [1, 1, 0, 4 * 256 + 2, 1, 0]);
    assert.equal(m.seq, 48 << 4);
    assert.equal(m.text, 'Option 2 is within reach of our armies.');
    assert.equal(m.season, 31);
    assert.equal(a.social.ballot, null);
    const body = h.llama.bodies[0];
    assert.equal(body.max_tokens, 160);
    const schema = body.response_format.json_schema.schema;
    assert.deepEqual(schema.properties.council.properties.motion.enum, [0, 1, 2]);
    assert.equal(schema.properties.choose.maxItems, 0);
    assert.equal(schema.properties.say.maxItems, 1);
    assert.match(body.messages[1].content, /option 1: camp at \(3,4\), favourable \(estimate\)/);
    assert.match(body.messages[1].content, /TASK: nation council, motion window/);
    const rec = h.records.recordsOf(48).find((r) => r.kind === 'motion');
    assert.equal(rec.mode, 'model');
    assert.equal(rec.sealed, false);
    assert.deepEqual(rec.choice.council, { motion: 2 });
    assert.deepEqual(rec.wake, ['W-COUNCIL']);
    assert.equal(h.records.provenance(a.decision_id, 0, 'talk').kind, 1);
    assert.equal(h.stores.ledger(TAGS[0]).s.counters.messages, 1);
  } finally {
    await h.close();
  }
});

test('V5 echo runs on council motions too: the untrusted text of the prompt reaches the speech check', async () => {
  const hallText = 'All nations should rally behind option two without delay or doubt, friends.';
  let seen = null;
  const speech = makeSpeech({ refuse: (k, t, ctx) => { if (k === 'say') seen = ctx.untrusted; return null; } });
  const social = makeSocial({ council: council(), hall: [{ id: 'h1', tag: TAGS[1], wallet: WALLETS[1], bell: 47, channel: 1, target: 0, name: { en: 'Sora', ja: 'ソラ' }, text: hallText, faction: 0 }] });
  const h = await makeMindHarness({ social, speech, respond: (b, n) => (n === 0 ? sessionAnswer(b, { kinds: ['build'] }) : councilAnswer('motion', { say: [{ channel: 'nation', text: hallText }] })(b)) });
  try {
    await h.mind.decide(decideReq());
    await h.mind.councilCall(arg());
    assert.ok(Array.isArray(seen) && seen.includes(hallText), `the hall text is passed as untrusted: ${JSON.stringify(seen)}`);
  } finally {
    await h.close();
  }
});

test('motion 0 (none) posts nothing; a motion without a speech gets the code sentence', async () => {
  const h = await harness((b) => ({ goal_id: 'G1', choose: [], params: {}, say: [], council: { motion: 0 }, trust: [], mem: [], why: 'Nothing fits.' }));
  try {
    const a = await h.mind.councilCall(arg());
    assert.equal(a.social.motion, null);
    assert.equal(a.mode, 'model');
  } finally {
    await h.close();
  }
  const h2 = await harness(councilAnswer('motion'));
  try {
    const a = await h2.mind.councilCall(arg({ period: 5 }));
    assert.equal(a.social.motion.text, 'I move option 2.');
  } finally {
    await h2.close();
  }
});

test('a ballot: one BALLOT with a fresh nonce and the council\'s candidates_hash; no inbox, no counts in the prompt', async () => {
  const h = await harness(councilAnswer('ballot'));
  try {
    const a = await h.mind.councilCall(arg({ kind: 'ballot', bell: 51 }));
    const b = a.social.ballot;
    assert.deepEqual([b.season, b.period, b.faction, b.option, b.origin, b.item], [31, 4, 0, 1, 1, 0]);
    assert.equal(b.candidates_hash, 'cd'.repeat(32));
    assert.match(b.nonce, /^[0-9a-f]{32}$/);
    assert.equal(a.social.motion, null);
    const body = h.llama.bodies[0];
    assert.equal(body.max_tokens, 160);
    assert.equal(body.response_format.json_schema.schema.properties.say.maxItems, 0);
    assert.equal(body.messages[1].content.includes('INBOX'), false);
    assert.equal(/ballots_cast|ballots cast/i.test(JSON.stringify(body)), false);
    const p = h.records.provenance(a.decision_id, 0, 'ballot');
    assert.deepEqual([p.option, p.period], [1, 4]);
    assert.equal(h.records.recordsOf(51).find((r) => r.kind === 'ballot').choice.council.ballot, 1);
  } finally {
    await h.close();
  }
});

test('idempotent per (AI, kind, period): the second call returns the first answer with no model call', async () => {
  const h = await harness(councilAnswer('ballot'));
  try {
    const a = await h.mind.councilCall(arg({ kind: 'ballot' }));
    const b = await h.mind.councilCall(arg({ kind: 'ballot', deadline_unix_ms: Date.now() + 99999 }));
    assert.equal(a, b);
    assert.equal(h.llama.bodies.length, 1);
    const c = await h.mind.councilCall(arg({ kind: 'ballot', period: 5, bell: 72 }));
    assert.notEqual(c.decision_id, a.decision_id);
  } finally {
    await h.close();
  }
});

test('without a situation from the brain, with no council options, or with the feed behind: autopilot with the reason and a record', async () => {
  const social = makeSocial({ council: council() });
  const h = await makeMindHarness({ social, respond: () => { throw new Error('no model'); } });
  try {
    const a = await h.mind.councilCall(arg());
    assert.deepEqual([a.mode, a.reason], ['autopilot', 'not_ready']);
    assert.equal(h.records.recordsOf(48)[0].kind, 'motion');
    assert.equal(h.records.recordsOf(48)[0].mode, 'autopilot');
    social.read.council = () => null;
    const b = await h.mind.councilCall(arg({ period: 9 }));
    assert.equal(b.reason, 'not_ready');
    await assert.rejects(h.mind.councilCall(arg({ kind: 'reflection' })), (e) => e.status === 400);
    await assert.rejects(h.mind.councilCall(arg({ tag: 'ffffffffffffffff' })), (e) => e.status === 403);
  } finally {
    await h.close();
  }
  let cursor = 10;
  const h2 = await harness(councilAnswer('motion'), { feed: { cursorBell: () => cursor } });
  try {
    await assert.rejects(h2.mind.councilCall(arg()), (e) => e.retry === true, 'integ-B: with time left it is a retryable error');
    const a = await h2.mind.councilCall(arg({ deadline_unix_ms: Date.now() + 5000 }));
    assert.equal(a.reason, 'feed_lag');
  } finally {
    await h2.close();
  }
});

test('an invalid council answer is retried once, then autopilot invalid:V1; an option outside the council is refused', async () => {
  const h = await harness((b) => ({ goal_id: 'G1', choose: [], params: {}, say: [], council: { motion: 3 }, trust: [], mem: [], why: 'x' }));
  try {
    const a = await h.mind.councilCall(arg());
    assert.deepEqual([a.mode, a.reason], ['autopilot', 'invalid:V1']);
    assert.equal(h.llama.bodies.length, 2);
  } finally {
    await h.close();
  }
});

test('under a live Strike Order the motion is made but its speech is withheld and the record is sealed until S + 2', async () => {
  const social = makeSocial({ council: { ...council(), adopted: true, strike_bell: 50 }, call: { option: 1, kind: 'camp', p: 3, q: 4, tile: 1, strike_bell: 50, follow_from: 46, invited: [], nonce: 'n' } });
  const h = await makeMindHarness({ social, respond: (b, n) => (n === 0 ? sessionAnswer(b, { kinds: ['build'] }) : councilAnswer('motion', { say: [{ channel: 'nation', text: 'Move option 2.' }] })(b)) });
  try {
    await h.mind.decide(decideReq());
    const a = await h.mind.councilCall(arg());
    assert.equal(a.social.motion, null);
    assert.equal(h.metrics.get('say_withheld'), 1);
    const rec = h.records.recordsOf(48).find((r) => r.kind === 'motion');
    assert.equal(rec.sealed, true);
    assert.equal(rec.release_bell, 52);
    assert.equal(h.records.getPrivate(rec.id).full.public.say[0], 'Move option 2.');
  } finally {
    await h.close();
  }
});

test('integ-B: a ballot asked while the feed cannot vouch for bell - 1 yet is a retryable error (no record, nothing cached); it runs once the feed has caught up; past the deadline it is the feed_lag autopilot answer', async () => {
  let cursor = 40;
  const feed = { cursorBell: () => cursor, async waitCursor() { return false; }, wakeEvents: () => [] };
  const h = await harness(councilAnswer('ballot'), { feed });
  try {
    const before = h.records.recordsOf(51).length;
    await assert.rejects(() => h.mind.councilCall(arg({ kind: 'ballot', bell: 51 })), (e) => e.retry === true);
    assert.equal(h.records.recordsOf(51).length, before, 'no record for a retry');
    assert.equal(h.llama.bodies.length, 0);
    cursor = 50;
    const ok = await h.mind.councilCall(arg({ kind: 'ballot', bell: 51 }));
    assert.equal(ok.mode, 'model');
    assert.ok(ok.social.ballot);
    // with no time left the answer is the autopilot one and is final for the period
    cursor = 40;
    const late = await h.mind.councilCall(arg({ kind: 'ballot', bell: 51, period: 5, deadline_unix_ms: Date.now() + 5000 }));
    assert.equal(late.reason, 'feed_lag');
  } finally {
    await h.close();
  }
});
