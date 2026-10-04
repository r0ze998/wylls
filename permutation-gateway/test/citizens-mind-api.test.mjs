// AC1a: POST /v1/decide and /v1/outcome end to end on doubles (fake llama on 127.0.0.1:0): gate, prompt,
// json_schema request, V0-V3, V5 glue, ledger, sealed commitments, records, idempotency per (index, bell).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeMindHarness, loadWireFixture, sessionAnswer, makeSocial, makeSpeech, makeEpisode, TAGS, WALLETS } from './fixtures/ai-mind-doubles.mjs';

const { json: wire } = loadWireFixture();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const req = (over = {}) => {
  const r = JSON.parse(JSON.stringify(wire.request));
  r.deadline_unix_ms = Date.now() + 60_000;
  return Object.assign(r, over);
};
const wakes = (list) => ({ wakeEvents: () => list });

test('a session: the model picks the camp march; the answer, the sealed record and the request body agree', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b, { kinds: ['march'] }) });
  try {
    const a = await h.mind.decide(req());
    assert.equal(a.v, 1);
    assert.equal(a.mode, 'model');
    assert.equal(a.reason, 'ok');
    assert.deepEqual(a.choice.ids, ['c3']);
    assert.deepEqual(a.choice.params.c3, { stance: 'hold', retreat: 0, timing: 'earliest' });
    assert.deepEqual(a.caps, { march_troops_left: 100, home_floor: 400 }, '600 - 500 troops left, floor 40 % of 1000');
    assert.deepEqual(a.standing, { reserved: [], declined_calls: [] });
    assert.deepEqual(a.social, { say: [], motion: null, ballot: null });
    assert.match(a.decision_id, /^[0-9a-f]{64}$/);
    // the llama request: pinned shape, json_schema with this prompt's enums
    assert.equal(h.llama.bodies.length, 1);
    const body = h.llama.bodies[0];
    assert.equal(body.temperature, 0);
    assert.equal(body.top_k, 1);
    assert.equal(body.cache_prompt, false);
    assert.equal(body.response_format.type, 'json_schema');
    const schema = body.response_format.json_schema.schema;
    assert.deepEqual(schema.properties.choose.items.enum, wire.request.candidates.map((c) => c.id));
    assert.equal(body.max_tokens, 384);
    // the record: sealed (a march), commitment, release one bell past the arrival bell
    const pub = h.records.get(a.decision_id);
    assert.equal(pub.sealed, true);
    assert.equal(pub.release_bell, 44, 'earliest arrival bell 43, destination public when it ends');
    assert.equal(pub.kind, 'session');
    assert.equal(pub.mode, 'model');
    assert.ok(!('choice' in pub));
    assert.equal(pub.request_hash, sha(h.records.loadRequest(a.decision_id)));
    assert.deepEqual(pub.wake.sort(), ['W-PULSE', 'W-QUEUE', 'W-READY']);
    assert.equal(pub.quota_left, 38);
    const opened = h.records.open(a.decision_id);
    assert.deepEqual(opened.choice.ids, ['c3']);
    assert.equal(opened.choice.goal_id, 'G1');
    assert.equal(opened.candidates.length, 10);
    assert.deepEqual(opened.candidates[2].refs ?? [], opened.candidates[2].refs, 'candidates carry the mind refs');
    // counters and metrics
    const doc = h.stores.ledger(TAGS[0]).s;
    assert.equal(doc.counters.sessions, 1);
    assert.equal(doc.counters.marches, 1);
    assert.equal(doc.day_start.home_troops, 1000);
    assert.equal(doc.day_start.march_troops_model, 500);
    assert.equal(h.metrics.get('model_marches'), 1);
  } finally {
    await h.close();
  }
});

test('/v1/decide is idempotent per (index, bell): a repeat returns the cached answer, no model call, no new record', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    const a = await h.mind.decide(req());
    const b = await h.mind.decide(req({ situation: { ...wire.request.situation, secs_left: 1 } }));
    assert.deepEqual(a, b);
    assert.equal(h.llama.bodies.length, 1);
    assert.equal(h.records.recordsOf(40).length, 1);
    assert.equal(h.metrics.get('decide_cached'), 1);
    // concurrent repeat while the first is in flight
    const other = () => { const r = req({ bell: 41 }); r.ai = { index: 4, tag: TAGS[1], wallet: WALLETS[1] }; return r; };
    const [x, y] = await Promise.all([h.mind.decide(other()), h.mind.decide(other())]);
    assert.deepEqual(x, y);
    assert.equal(h.llama.bodies.length, 2);
    assert.equal(h.records.recordsOf(41).length, 1);
  } finally {
    await h.close();
  }
});

test('idempotency survives a mind restart (the answer is read back from STATE)', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    const a = await h.mind.decide(req());
    h.mind._cache.clear();
    const b = await h.mind.decide(req());
    assert.deepEqual(a, b);
    assert.equal(h.llama.bodies.length, 1);
  } finally {
    await h.close();
  }
});

test('gate closed: a synchronous autopilot answer with no model call, and still exactly one record', async () => {
  const h = await makeMindHarness({ respond: () => { throw new Error('the model must not be called'); } });
  try {
    const t0 = Date.now();
    const a = await h.mind.decide(req({ bell: 1006 }));
    assert.ok(Date.now() - t0 < 50, 'target < 50 ms');
    assert.equal(a.mode, 'autopilot');
    assert.equal(a.reason, 'season_end');
    assert.deepEqual(a.choice, { ids: ['c1'], params: {}, mem: [] });
    assert.deepEqual(a.caps, { march_troops_left: null, home_floor: null });
    assert.equal(h.llama.bodies.length, 0);
    const recs = h.records.recordsOf(1006);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].kind, 'autopilot');
    assert.equal(recs[0].mode, 'autopilot');
    assert.equal(recs[0].sealed, false);
    assert.deepEqual(recs[0].choice, { ids: ['c1'], params: {}, council: null, goal_id: null, mem: [] });
  } finally {
    await h.close();
  }
});

test('not ready (no final village) and an unknown roster are autopilot with their reasons', async () => {
  const h = await makeMindHarness({ respond: () => { throw new Error('no model'); } });
  try {
    const r = req();
    r.situation.me.home.final = false;
    assert.equal((await h.mind.decide(r)).reason, 'not_ready');
    const bad = req({ bell: 50 });
    bad.ai.tag = 'ffffffffffffffff';
    await assert.rejects(h.mind.decide(bad), (e) => e.status === 403);
  } finally {
    await h.close();
  }
});

test('below the gate: no pulse, no events -> autopilot below_gate; the day budget -> budget', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    await h.mind.decide(req({ bell: 40 })); // session (pulse)
    const a = await h.mind.decide(req({ bell: 45, wake_hints: [] }));
    assert.equal(a.mode, 'autopilot');
    assert.equal(a.reason, 'below_gate');
    h.stores.ledger(TAGS[0]).s.counters.sessions = 8;
    const b = await h.mind.decide(req({ bell: 70 }));
    assert.equal(b.reason, 'budget');
  } finally {
    await h.close();
  }
});

test('a reaction (W-DM) answers social only: choose [], the answer carries the autopilot id and a TALK with seq (bell << 4) | k', async () => {
  const social = makeSocial({ inbox: [{ id: 'm1', bell: 39, wallet: WALLETS[1], tag: TAGS[1], name: 'Sora', channel: 'direct', text: 'Hello there', inner: 'ab'.repeat(32) }] });
  const h = await makeMindHarness({
    social,
    watcher: wakes(['W-DM']),
    respond: (b) => {
      assert.equal(b.response_format.json_schema.schema.properties.choose.maxItems, 0);
      assert.equal(b.max_tokens, 256);
      return { goal_id: 'G1', choose: [], params: {}, say: [{ channel: 'direct', to: 'C1', text: 'Greetings, Sora.' }], council: null, trust: [{ who: 'C1', delta: 3 }], mem: [], why: 'Answering a message.' };
    },
  });
  try {
    h.stores.ledger(TAGS[0]).s.counters.day = 0;
    h.stores.ledger(TAGS[0]).s.counters.sessions = 8; // sessions used up: a reaction is the only door
    const a = await h.mind.decide(req({ wake_hints: [] }));
    assert.equal(a.mode, 'model');
    assert.deepEqual(a.choice.ids, ['c1']);
    assert.equal(h.records.recordsOf(40)[0].kind, 'reaction');
    assert.equal(a.social.say.length, 1);
    const t = a.social.say[0];
    assert.equal(t.channel, 3);
    assert.equal(t.target, WALLETS[1]);
    assert.equal(t.kind, 0);
    assert.equal(t.origin, 1);
    assert.equal(t.seq, 40 << 4);
    assert.equal(t.item, 0);
    assert.equal(t.text, 'Greetings, Sora.');
    assert.equal(t.season, 31);
    assert.equal(t.lang, 'en');
    // provenance for the social service: the signed-ready text, consumed once
    const p = h.records.provenance(a.decision_id, 0, 'talk');
    assert.equal(p.text, 'Greetings, Sora.');
    assert.equal(h.records.consume(a.decision_id, 0, 'talk'), true);
    assert.equal(h.records.consume(a.decision_id, 0, 'talk'), false);
    // the model's trust delta reached the ledger, by tag
    assert.deepEqual(h.stores.ledger(TAGS[0]).modelDeltas, [{ who: TAGS[1], delta: 3, bell: 40 }]);
    assert.equal(h.stores.ledger(TAGS[0]).s.counters.reactions, 1);
    assert.equal(h.stores.ledger(TAGS[0]).s.counters.messages, 1);
  } finally {
    await h.close();
  }
});

test('V0/V1 failure retries once with the refusal reason appended and a new seed; a second failure is autopilot invalid:V1', async () => {
  let n = 0;
  const h = await makeMindHarness({ respond: (b) => { n++; return { goal_id: 'G1' }; } });
  try {
    const a = await h.mind.decide(req());
    assert.equal(a.mode, 'autopilot');
    assert.equal(a.reason, 'invalid:V1');
    assert.equal(h.llama.bodies.length, 2);
    assert.match(h.llama.bodies[1].messages[1].content, /Your previous answer was refused: missing key/);
    assert.notEqual(h.llama.bodies[0].seed, h.llama.bodies[1].seed);
    assert.equal(h.records.recordsOf(40)[0].attempts, 2);
    assert.equal(h.records.recordsOf(40)[0].kind, 'session');
    assert.equal(h.metrics.get('retries'), 1);
  } finally {
    await h.close();
  }
});

test('a retry that succeeds is valid (attempts 2); a cut-off answer (finish length) is V0', async () => {
  let n = 0;
  const h = await makeMindHarness({ respond: (b) => (n++ === 0 ? { raw: '{"goal_id": "G1", "cho', finish_reason: 'length' } : sessionAnswer(b, { kinds: ['build'] })) });
  try {
    const a = await h.mind.decide(req());
    assert.equal(a.mode, 'model');
    assert.deepEqual(a.choice.ids, ['c5']);
    assert.equal(h.records.recordsOf(40)[0].attempts, 2);
    assert.equal(h.records.recordsOf(40)[0].sealed, false, 'a build seals nothing');
    assert.equal(h.metrics.snapshot().groups.invalid_layer.V0, 1);
  } finally {
    await h.close();
  }
});

test('V2 failure (autopilot chosen with another id) retries; stray params are dropped and counted, not invalid', async () => {
  let n = 0;
  const h = await makeMindHarness({
    respond: (b) => {
      n++;
      const ans = sessionAnswer(b, { kinds: ['march'] });
      if (n === 1) return { ...ans, choose: ['c1', 'c5'] };
      return { ...ans, params: { ...ans.params, c4: { stance: 'hold', retreat: 0, timing: 'earliest' } } };
    },
  });
  try {
    const a = await h.mind.decide(req());
    assert.equal(a.mode, 'model');
    assert.equal(h.metrics.get('params_stray_dropped'), 1);
    assert.deepEqual(Object.keys(a.choice.params), ['c3']);
    assert.match(h.llama.bodies[1].messages[1].content, /alone/);
  } finally {
    await h.close();
  }
});

test('mem: cited handles map to episode ids, unknown ones are dropped and counted; the record keeps retrieved in handle order', async () => {
  const h = await makeMindHarness({ respond: (b) => ({ ...sessionAnswer(b, { kinds: ['march'], mem: false }), mem: ['M1', 'M2'] }) });
  try {
    const a = await h.mind.decide(req());
    const ids = a.choice.mem;
    assert.equal(ids.length, 2);
    const pub = h.records.getPrivate(a.decision_id);
    assert.deepEqual(pub.full.retrieved.slice(0, 2), ids);
    assert.deepEqual(pub.full.choice.mem, ids);
    assert.equal(h.metrics.get('decisions_citing_memory'), 1);
    assert.equal(pub.priv.remembered.length, 2);
    assert.equal(pub.priv.remembered[0].text.en.startsWith('At bell'), true);
    // the schema enum is this prompt's handles: M1..Mk and nothing else
    const schema = h.llama.bodies[0].response_format.json_schema.schema;
    assert.deepEqual(schema.properties.mem.items.enum, pub.full.retrieved.map((_, i) => `M${i + 1}`));
  } finally {
    await h.close();
  }
  const h2 = await makeMindHarness({ respond: (b) => ({ ...sessionAnswer(b, { kinds: ['build'], mem: false }), mem: ['M1', 'M7'] }) });
  try {
    const a = await h2.mind.decide(req());
    assert.equal(a.mode, 'model', 'a dropped handle never invalidates');
    assert.equal(a.choice.mem.length, 1);
    assert.equal(h2.metrics.get('mem_dropped'), 1);
  } finally {
    await h2.close();
  }
});

test('V3: a march over the caps is dropped; nothing left means autopilot invalid:V3; the rest of the choice stays valid', async () => {
  const big = req();
  big.situation.me.home_troops = 700; // 500 > 60 % of 700
  big.situation.me.home_troops_day_start = 700;
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b, { kinds: ['march'] }) });
  try {
    const a = await h.mind.decide(big);
    assert.equal(a.mode, 'autopilot');
    assert.equal(a.reason, 'invalid:V3');
    assert.equal(h.metrics.snapshot().groups.v3_drop.a, 1);
  } finally {
    await h.close();
  }
  const h2 = await makeMindHarness({ respond: (b) => sessionAnswer(b, { kinds: ['march', 'build'] }) });
  try {
    const big2 = req({ bell: 41 });
    big2.situation.me.home_troops = 700;
    big2.situation.me.home_troops_day_start = 700;
    const a = await h2.mind.decide(big2);
    assert.equal(a.mode, 'model');
    assert.deepEqual(a.choice.ids, ['c5']);
    assert.equal(h2.records.get(a.decision_id).sealed, false, 'the dropped march seals nothing');
  } finally {
    await h2.close();
  }
});

test('V5: a refused say is dropped, a refused why is replaced by the code string; the choice stays valid', async () => {
  const speech = makeSpeech({ refuse: (k, t) => (t.includes('SECRET') ? (k === 'say' ? 'pact_word' : 'sealed_coordinate') : null) });
  const h = await makeMindHarness({ speech, respond: (b) => sessionAnswer(b, { kinds: ['build'], say: [{ channel: 'world', text: 'SECRET plan' }, { channel: 'nation', text: 'Building a wood producer.' }], why: 'SECRET reason' }) });
  try {
    const a = await h.mind.decide(req());
    assert.equal(a.mode, 'model');
    assert.deepEqual(a.social.say.map((s) => s.text), ['Building a wood producer.']);
    assert.equal(a.social.say[0].channel, 1);
    assert.equal(a.social.say[0].target, 0, 'nation channel: the AI\'s own nation');
    const rec = h.records.get(a.decision_id);
    assert.equal(rec.public.why, '(reason withheld by the checker: sealed_coordinate)');
    assert.equal(rec.public.why_withheld, 'sealed_coordinate');
    assert.deepEqual(rec.public.say, ['Building a wood producer.']);
    assert.equal(h.metrics.snapshot().groups.speech_drop.pact_word, 1);
  } finally {
    await h.close();
  }
});

test('a sealed decision (a march) withholds its say items: not posted, counted, published only in the opened record', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b, { kinds: ['march'], say: [{ channel: 'world', text: 'Marching out.' }] }) });
  try {
    const a = await h.mind.decide(req());
    assert.deepEqual(a.social.say, []);
    assert.equal(h.metrics.get('say_withheld'), 1);
    assert.equal(h.records.getPrivate(a.decision_id).full.public.say[0], 'Marching out.');
    assert.equal(h.records.provenance(a.decision_id, 0, 'talk'), null);
    assert.equal(h.stores.ledger(TAGS[0]).s.counters.messages, 0, 'a withheld message does not use the budget');
  } finally {
    await h.close();
  }
});

test('the speech check of the deciding step already sees this decision\'s own march targets as sealed', async () => {
  let seen = null;
  const speech = makeSpeech({ refuse: (k, t, ctx) => { if (k === 'why') seen = ctx.sealed; return null; } });
  const h = await makeMindHarness({ speech, respond: (b) => sessionAnswer(b, { kinds: ['march'] }) });
  try {
    await h.mind.decide(req());
    assert.deepEqual(seen.map((e) => e.pq), [[2, 0]]);
    assert.deepEqual(seen[0].numbers.sort((a, b) => a - b), [4, 158]);
    assert.deepEqual(seen[0].kinds, ['camp']);
  } finally {
    await h.close();
  }
});

test('/v1/outcome: tx are attached to the record; a sent march enters the sealed set and then constrains the next step\'s text', async () => {
  let ctxSealed = null;
  const speech = makeSpeech({ refuse: (k, t, ctx) => { if (k === 'why') ctxSealed = ctx.sealed; return null; } });
  const h = await makeMindHarness({ speech, respond: (b) => sessionAnswer(b, { kinds: ['march'] }) });
  try {
    const a = await h.mind.decide(req());
    assert.deepEqual(h.mind.outcome({ ...wire.outcome, decision_id: a.decision_id }), { ok: true });
    assert.equal(h.records.get(a.decision_id).tx[0].sig, wire.outcome.actions[0].sig);
    assert.deepEqual(h.sealed.list(TAGS[0]).map((e) => e.pq), [[2, 0]]);
    // next step (hold chosen): the earlier target is still sealed for the text checks
    const h2req = req({ bell: 41 });
    await h.mind.decide(h2req);
    assert.ok(ctxSealed.some((e) => e.pq[0] === 2 && e.pq[1] === 0));
    assert.throws(() => h.mind.outcome({ decision_id: 'nope', actions: [] }), (e) => e.status === 404);
    assert.throws(() => h.mind.outcome({}), (e) => e.status === 400);
  } finally {
    await h.close();
  }
});

test('an outcome with no sent march does not seal the set; the sealed set is pruned when the decision is opened or the target is public', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b, { kinds: ['march'] }), feed: { cursorBell: () => 999, revealed: () => false } });
  try {
    const a = await h.mind.decide(req());
    h.mind.outcome({ decision_id: a.decision_id, actions: [{ intent: 'depart', status: 'refused', code: 'x' }] });
    assert.deepEqual(h.sealed.list(TAGS[0]), []);
    h.mind.outcome({ decision_id: a.decision_id, actions: [{ intent: 'depart', status: 'sent', sig: 's' }] });
    assert.equal(h.sealed.list(TAGS[0]).length, 1);
    h.records.markOpened(a.decision_id);
    await h.mind.decide(req({ bell: 60, wake_hints: [] }));
    assert.deepEqual(h.sealed.list(TAGS[0]), [], 'released');
  } finally {
    await h.close();
  }
});

test('llm errors: http 500 -> llm_error; deadline -> timeout; a late finish -> late; no time left -> no_time (never an uncaught error)', async () => {
  const h = await makeMindHarness({ respond: () => 'http500' });
  try {
    assert.equal((await h.mind.decide(req())).reason, 'llm_error');
  } finally {
    await h.close();
  }
  const slow = await makeMindHarness({ respond: (b) => sessionAnswer(b), delayMs: 1500 });
  try {
    const a = await slow.mind.decide(req({ deadline_unix_ms: Date.now() + 1500 })); // minus the 300 ms slack: about 1.2 s left, the model needs 1.5 s
    assert.ok(['timeout', 'late'].includes(a.reason), a.reason);
    assert.equal(a.mode, 'autopilot');
    const r2 = req({ bell: 41, deadline_unix_ms: Date.now() + 350 });
    r2.ai = { index: 4, tag: TAGS[1], wallet: WALLETS[1] };
    const b = await slow.mind.decide(r2);
    assert.equal(b.reason, 'no_time');
    assert.equal(slow.records.recordsOf(41)[0].kind, 'session');
  } finally {
    await slow.close();
  }
});

test('feed_lag: a model session is refused while the feed is behind the end of bell b - 1', async () => {
  let cursor = 30;
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b), feed: { cursorBell: () => cursor } });
  try {
    const a = await h.mind.decide(req());
    assert.equal(a.reason, 'feed_lag');
    assert.equal(h.llama.bodies.length, 0);
    cursor = 40;
    assert.equal((await h.mind.decide(req({ bell: 41 }))).mode, 'model');
    assert.equal(h.metrics.get('feed_lag'), 1);
  } finally {
    await h.close();
  }
});

test('hold reserves the hosts of its facts; the standing order comes back in the answer and expires by bell', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b, { kinds: [], why: 'Keep them home.' }) });
  try {
    h.llama.close;
    const holdAns = (b) => ({ ...sessionAnswer(b, { kinds: [] }), choose: ['c2'], params: {} });
    h.llama.bodies.length = 0;
    const h2 = await makeMindHarness({ respond: holdAns });
    try {
      const a = await h2.mind.decide(req());
      assert.deepEqual(a.choice.ids, ['c2']);
      assert.deepEqual(a.standing.reserved, [{ host_id: '123149597278209', until_bell: 52 }]);
      assert.equal(h2.records.get(a.decision_id).sealed, false);
      const later = await h2.mind.decide(req({ bell: 53, wake_hints: [] }));
      assert.deepEqual(later.standing.reserved, [], 'expired');
    } finally {
      await h2.close();
    }
  } finally {
    await h.close();
  }
});

test('the Strike Order candidate not chosen declines its period; a live Call seals even a build decision and moves the release to S + 2', async () => {
  const call = { option: 1, kind: 'camp', p: 5, q: 5, tile: 3, strike_bell: 50, follow_from: 46, invited: [1], nonce: 'n' };
  const social = makeSocial({ council: { period: 4, state: 'closed', options: [{ option: 1, kind: 'camp', p: 5, q: 5, ratio: 'favourable' }], motions: [], adopted: true, strike_bell: 50 }, call });
  const r = req();
  r.candidates[3] = { ...r.candidates[3], flags: { council: true }, facts: { ...r.candidates[3].facts, period: 4, strike_bell: 50 } };
  const h = await makeMindHarness({ social, respond: (b) => sessionAnswer(b, { kinds: ['build'] }) });
  try {
    const a = await h.mind.decide(r);
    assert.deepEqual(h.stores.ledger(TAGS[0]).s.standing.declined_calls, [4]);
    assert.deepEqual(a.standing.declined_calls, [4]);
    const pub = h.records.get(a.decision_id);
    assert.equal(pub.sealed, true);
    assert.equal(pub.release_bell, 52);
    assert.equal(h.metrics.get('calls_declined'), 1);
    assert.deepEqual(h.sealed.list(TAGS[0]).map((e) => e.via), ['call']);
  } finally {
    await h.close();
  }
});

test('the model is given exactly one system and one user message; no key, seed, or journal text is in them (T-K1 in miniature)', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    await h.mind.decide(req());
    const body = h.llama.bodies[0];
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
    const all = JSON.stringify(body);
    for (const forbidden of ['secret', 'seed:', 'salt', 'private key']) assert.equal(all.toLowerCase().includes(forbidden), false, forbidden);
    assert.ok(body.messages[0].content.includes('AI citizen run by the operator'), 'the disclosure rule');
    assert.ok(body.messages[0].content.includes('No land can be captured'));
  } finally {
    await h.close();
  }
});

test('request_hash of a model record is the sha256 of the exact stored llama body, replayable', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    const a = await h.mind.decide(req());
    const stored = h.records.loadRequest(a.decision_id);
    const rec = h.records.getPrivate(a.decision_id).full;
    assert.equal(rec.request_hash, sha(stored));
    assert.equal(JSON.parse(stored).seed, rec.seed);
    assert.equal(rec.output_hash.length, 64);
    assert.equal(rec.prompt_hash.length, 64);
  } finally {
    await h.close();
  }
});
