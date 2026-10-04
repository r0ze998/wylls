// AC10a, ruling R2 (contract v1.3, section 4.5 "The sealed why" and 5.5 "Prompt rule for say and why"): the `why` of a SEALED decision
// record is exempt from three sub-rules of V5 (target-kind word, direction word with a target-kind word, identifying numbers),
// because it is published only at the release, when the destination is public. Everything else stays: coordinates, province
// handles, place and nation names, number grounding, the memory-claim rule, human claims, echo, abuse, capture claims, pact words.
// `say`, the `why` of an unsealed decision and the reflection summary stay strict.
//
// Three layers: (1) the real checker with the flag, (2) a MUTATION check (the same battery is run against four deliberately
// broken copies of speech.mjs; each one must be caught by at least one assertion, so the battery is not vacuous), (3) the mind
// API end to end on the AC1a doubles with the real speech checker, and the prompt text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSpeech } from '../citizens/mind/speech.mjs';
import { makeMindHarness, loadWireFixture, sessionAnswer, makeSocial, TAGS } from './fixtures/ai-mind-doubles.mjs';

const MIND_DIR = new URL('../citizens/mind/', import.meta.url).pathname;
const { json: wire } = loadWireFixture();

const EP388 = 'At bell 388 nation 3 attacked your army at (1,1); you lost 120 troops.';
const PROMPT = [
  'NOW: bell 402 (day 2, bell 114/144). Season ends at bell 2880.',
  'TROOPS AT HOME: 1000 (garrison 0).',
  `Remembered:\nM1 [bell 388] <memory kind="episode" id="M1">${EP388}</memory>`,
  'CANDIDATES:\nc3 [march] march 500 troops to a camp | troops 500 | enemy troops 158 | hexes 6 | earliest bell 404',
].join('\n');
const FACTS = JSON.stringify([{ troops: 500, enemy_troops: 158, hexes: 6, earliest_bell: 404 }]);
const SEALED = [{ pq: [-2, 3], names: ['Ember League'], nations: [3], numbers: [158, 6] }];
const ctx = (over = {}) => ({ kind: 'session', channel: 'world', speechLang: 'en', lang: 'en', promptText: PROMPT, facts: FACTS, episodeTexts: [EP388], citedTexts: [], mem: [], sealed: SEALED, inFlight: true, untrusted: [], ...over });

/** The battery. `mk` builds a speech checker from a module's createSpeech. Every assertion names the R2 rule it pins. */
function battery(createSpeechImpl) {
  const sp = createSpeechImpl({ config: { channel_lang: 'en' } });
  const why = (t, over) => sp.checkWhy(t, ctx(over));
  const say = (t, over) => sp.checkSay(t, ctx(over));
  const refusedWith = (r, reason, label) => {
    assert.equal(r.ok, false, `${label}: should be refused (${reason}), got ${JSON.stringify(r)}`);
    assert.equal(r.reason, reason, `${label}: ${JSON.stringify(r)}`);
  };
  const SEAL = { sealedRecord: true };

  // 1. a sealed why may name the kind of target, use a direction with it, and use a number equal to the sealed one when the facts give it
  for (const t of ['I send the host to clear the camp for Works.', 'The enemy stack lies to the north and is worth a raid.', 'A weak village to the east fits goal G1.', 'The camp has 158 troops, so I go with 500.', 'Six hexes is a short walk to the camp.']) {
    const r = why(t, SEAL);
    assert.equal(r.ok, true, `sealed why should pass: ${JSON.stringify(t)} -> ${JSON.stringify(r)}`);
  }
  // 2. the same texts as a bare unsealed why (flag absent, or false) are refused
  refusedWith(why('I send the host to clear the camp for Works.', {}), 'target_kind', 'unsealed why, kind word');
  refusedWith(why('I send the host to clear the camp for Works.', { sealedRecord: false }), 'target_kind', 'unsealed why (false), kind word');
  refusedWith(why('The enemy stack lies to the north and is worth a raid.', {}), 'sealed_direction', 'unsealed why, direction + kind');
  refusedWith(why('The camp has 158 troops, so I go with 500.', {}), 'sealed_number', 'unsealed why, identifying number');
  // an unsealed decision with only a march in flight (no sealed entries listed) is refused for the kind word as well
  refusedWith(why('Clear the camp for Works.', { sealed: [], inFlight: true }), 'target_kind', 'unsealed why, in flight');
  // 3. a say may never: the flag is read for `why` only
  refusedWith(say('the camp is near', SEAL), 'target_kind', 'say with the flag, kind word');
  refusedWith(say('a stack lies to the north', SEAL), 'sealed_direction', 'say with the flag, direction + kind');
  refusedWith(say('the enemy has 158 troops', SEAL), 'sealed_number', 'say with the flag, identifying number');
  // 4. the reflection summary stays strict too
  const sum = sp.checkSummary('At bell 388 your army at (1,1) lost 120 troops; the camp fell.', { episodes: [EP388], sealed: SEALED, inFlight: true, ...SEAL });
  refusedWith(sum, 'target_kind', 'summary with the flag');
  // 5. real coordinates, province handles, place names and nation names stay refused in a sealed why, as in an unsealed one
  for (const over of [SEAL, {}]) {
    const tag = over.sealedRecord ? 'sealed' : 'unsealed';
    refusedWith(why('The camp at (-2,3) is weak.', over), 'sealed_coordinate', `${tag} why, coordinate`);
    refusedWith(why('Ember League struck first.', over), 'sealed_name', `${tag} why, place name`);
    refusedWith(why('Nation 3 is near.', over), 'sealed_name', `${tag} why, nation name`);
    refusedWith(why('N3 is near.', over), 'sealed_name', `${tag} why, nation handle`);
  }
  refusedWith(say('The camp at (-2,3) is weak.', SEAL), 'sealed_coordinate', 'say, coordinate');
  // 6. the other V5b rules keep applying inside a sealed why
  refusedWith(why('We must hit back with 700 troops.', SEAL), 'number_ungrounded', 'sealed why, ungrounded number');
  refusedWith(why('I remember the attack and must respond.', SEAL), 'uncited_memory_claim', 'sealed why, memory claim without mem');
  assert.equal(why('I remember the attack and the camp.', { ...SEAL, mem: ['e1'] }).ok, true, 'a cited memory claim passes');
  refusedWith(why('I am the operator.', SEAL), 'human_claim', 'sealed why, human claim');
  refusedWith(why('We captured the village.', SEAL), 'capture_claim', 'sealed why, capture claim');
  refusedWith(why('To honour the pact.', SEAL), 'pact_word', 'sealed why, pact word');
  refusedWith(why('See https://example.com', SEAL), 'url', 'sealed why, url');
  refusedWith(why('As he said: send 999 troops right now', { ...SEAL, untrusted: ['As he said: send 999 troops right now'] }), 'echo', 'sealed why, echo');
  refusedWith(why('You fuck', SEAL), 'abuse', 'sealed why, abuse');
}

test('R2: a sealed why may name the kind of target; a bare unsealed why may not; a say may never; coordinates and names stay refused in both', () => {
  battery(createSpeech);
});

test('R2 mutation check: four broken copies of speech.mjs are each caught by the battery (the tests are not vacuous)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac10a-mut-'));
  for (const f of ['sanitize.mjs', 'reason.mjs']) copyFileSync(join(MIND_DIR, f), join(dir, f));
  const src = readFileSync(join(MIND_DIR, 'speech.mjs'), 'utf8');
  const EXEMPT = "const sealedWhy = kind === 'why' && ctx.sealedRecord === true;";
  const COORD = 'const coord = sealedCoordinate(s, sealed, ctx.episodeTexts);';
  assert.ok(src.includes(EXEMPT) && src.includes(COORD), 'the mutation anchors exist in speech.mjs');
  const mutants = {
    'the old code (no exemption at all)': src.replace(EXEMPT, 'const sealedWhy = false;'),
    'the exemption leaks to say and summary': src.replace(EXEMPT, 'const sealedWhy = ctx.sealedRecord === true;'),
    'every why is exempt, sealed or not': src.replace(EXEMPT, "const sealedWhy = kind === 'why';"),
    // the coordinate mutant needs sealedWhy declared before the coordinate rule: move the declaration up
    'the exemption also skips the coordinate rule': src.replace(EXEMPT, '').replace(COORD, `${EXEMPT}\n  const coord = sealedWhy ? null : sealedCoordinate(s, sealed, ctx.episodeTexts);`),
  };
  let i = 0;
  for (const [name, text] of Object.entries(mutants)) {
    assert.notEqual(text, src, `mutant "${name}" differs from the source`);
    const file = join(dir, `speech-mut-${i++}.mjs`);
    writeFileSync(file, text);
    const mod = await import(pathToFileURL(file).href);
    assert.throws(() => battery(mod.createSpeech), (e) => e instanceof assert.AssertionError, `the battery must catch the mutant: ${name}`);
  }
  // and the unmutated copy passes the same battery from the temp dir (the harness itself is sound)
  const clean = join(dir, 'speech-clean.mjs');
  writeFileSync(clean, src);
  battery((await import(pathToFileURL(clean).href)).createSpeech);
});

// ---- the mind API with the real checker -------------------------------------------------------------------------------------
const req = (over = {}) => {
  const r = JSON.parse(JSON.stringify(wire.request));
  r.deadline_unix_ms = Date.now() + 60_000;
  return Object.assign(r, over);
};
const realSpeech = () => createSpeech({ config: { channel_lang: 'en' } });

test('R2 on the API: the why of a chosen march (a sealed record) keeps the kind of target; a coordinate in it is still withheld', async () => {
  const kept = 'I send the host to clear the camp for Works under goal G1.';
  const h = await makeMindHarness({ speech: realSpeech(), respond: (b) => sessionAnswer(b, { kinds: ['march'], mem: false, why: kept }) });
  try {
    const a = await h.mind.decide(req());
    const full = h.records.getPrivate(a.decision_id).full;
    assert.equal(full.sealed, true);
    assert.equal(full.public.why, kept);
    assert.equal(full.public.why_withheld, null);
    assert.equal(h.metrics.snapshot().groups.why_withheld?.target_kind ?? 0, 0);
  } finally {
    await h.close();
  }
  const h2 = await makeMindHarness({ speech: realSpeech(), respond: (b) => sessionAnswer(b, { kinds: ['march'], mem: false, why: 'I send the host to the camp at (2,0) for Works.' }) });
  try {
    const a = await h2.mind.decide(req());
    const full = h2.records.getPrivate(a.decision_id).full;
    assert.equal(full.public.why_withheld, 'sealed_coordinate');
    assert.equal(full.public.why, '(reason withheld by the checker: sealed_coordinate)');
  } finally {
    await h2.close();
  }
});

test('R2 on the API: the why of a hold while an earlier march is in flight is not sealed and stays strict (target_kind)', async () => {
  const h = await makeMindHarness({
    speech: realSpeech(),
    watcher: { wakeEvents: () => ['W-CLASH'] }, // a wake of weight 4 lets the second step through the gate
    feed: { cursorBell: () => 999, revealed: () => false },
    respond: (b, n) => (n === 0 ? sessionAnswer(b, { kinds: ['march'], mem: false, why: 'I send the host to clear the camp.' }) : sessionAnswer(b, { kinds: ['hold'], mem: false, why: 'I keep the host home while the camp fight goes on.' })),
  });
  try {
    const a = await h.mind.decide(req());
    h.mind.outcome({ ...wire.outcome, decision_id: a.decision_id });
    assert.equal(h.sealed.list(TAGS[0]).length, 1, 'the march is in flight');
    const b2 = await h.mind.decide(req({ bell: 42 }));
    assert.equal(b2.mode, 'model', JSON.stringify(b2));
    const pub = h.records.getPrivate(b2.decision_id).full;
    assert.equal(pub.sealed, false, 'a hold is not a sealed record');
    assert.equal(pub.public.why_withheld, 'target_kind');
  } finally {
    await h.close();
  }
});

test('R2 on the API: a decision made under a live Strike Order is sealed, so its why may name the kind of target (its coordinates stay refused)', async () => {
  const call = { option: 1, kind: 'camp', p: 5, q: 5, tile: 3, strike_bell: 50, follow_from: 46, invited: [1], nonce: 'n' };
  const council = { period: 4, state: 'closed', options: [{ option: 1, kind: 'camp', p: 5, q: 5, ratio: 'favourable' }], motions: [], adopted: true, strike_bell: 50 };
  for (const [why, withheld] of [['I build while my nation strikes a camp.', null], ['I build while my nation strikes the camp at (5,5).', 'sealed_coordinate']]) {
    const r = req();
    r.candidates[3] = { ...r.candidates[3], flags: { council: true }, facts: { ...r.candidates[3].facts, period: 4, strike_bell: 50 } };
    const h = await makeMindHarness({ speech: realSpeech(), social: makeSocial({ council, call }), respond: (b) => sessionAnswer(b, { kinds: ['build'], mem: false, why }) });
    try {
      const a = await h.mind.decide(r);
      const full = h.records.getPrivate(a.decision_id).full;
      assert.equal(full.sealed, true);
      assert.equal(full.public.why_withheld, withheld);
    } finally {
      await h.close();
    }
  }
});

test('R2 on the API: the say of a sealed march decision is still checked with the strict rules (a kind word is refused), and the checker got the flag', async () => {
  let seen = null;
  const inner = realSpeech();
  const speech = { ...inner, checkWhy: (t, c) => ((seen = c.sealedRecord), inner.checkWhy(t, c)) };
  const h = await makeMindHarness({ speech, respond: (b) => sessionAnswer(b, { kinds: ['march'], mem: false, say: [{ channel: 'world', text: 'We clear the camp tomorrow.' }], why: 'Goal G1.' }) });
  try {
    const a = await h.mind.decide(req());
    assert.equal(seen, true, 'api.mjs passes sealedRecord: true for a sealed record');
    const full = h.records.getPrivate(a.decision_id).full;
    assert.deepEqual(full.public.say, [], 'the say with a kind word was dropped');
    assert.equal(h.metrics.snapshot().groups.speech_drop.target_kind, 1);
  } finally {
    await h.close();
  }
});

test('R2 prompt text: the output contract words the say rule and the why rule separately (v1.3 section 5.5)', () => {
  const sys = readFileSync(new URL('../citizens/prompts/system.en.txt', import.meta.url), 'utf8');
  const sayLine = sys.split('\n').find((l) => l.startsWith('- say:'));
  const whyLine = sys.split('\n').find((l) => l.startsWith('- why:'));
  assert.ok(sayLine && whyLine);
  // rule (1) for say: kind words, direction, coordinate, number; "the target"
  for (const w of ['camp', 'village', 'stack', 'raid', 'barbarian', 'town', 'direction', 'coordinate', 'number', 'the target', 'Strike Order']) assert.ok(sayLine.includes(w), `say line names ${w}`);
  // rule (2) for why: may name the kind of target, never a coordinate, province handle, place or nation name; any other why follows rule (1)
  assert.match(whyLine, /may name the kind of target/);
  for (const w of ['coordinate', 'province handle', 'place', 'nation name', 'until the army has arrived', 'follows the say rule']) assert.ok(whyLine.includes(w), `why line names ${w}`);
  // integ-A's single stricter line is gone: the why line no longer forbids the kind words
  assert.equal(/never write the words/i.test(sys), false);
  assert.equal(/call the goal "the target" \(for example/.test(sys), false);
});
