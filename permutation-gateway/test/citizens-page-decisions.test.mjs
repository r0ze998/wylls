// Council page (unit AC7), decisions (contract §5.5 "What the page prints", §7.2, §9.1 beat 1). The central property:
// the "Remembered (cited by the model):" lines are the CODE text of the cited episodes (the opened record's
// `remembered`, or the AI's episode store), never the model's own words, even when the model's words imitate a
// Remembered line. Synthetic records in the shapes of §7.2 (ai-page-kit.mjs).
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { makeRosterIndex } from '../../permutation-server/web/frontier/council/badges.mjs';
import { normalizeMinds, normalizeOpenFile, normalizeEpisodes, decisionList, buildDecision, renderDecisions, planOpenProbes, rememberedBlock } from '../../permutation-server/web/frontier/council/decisions.mjs';
import { tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { makeFakeDocument, textOf, byClass, findAll } from './fixtures/ai-page-dom.mjs';
import { roster, T, sealedRecord, openedRecord, episodesFile, episodeText } from './fixtures/ai-page-kit.mjs';

const h = makeH(makeFakeDocument());
const index = makeRosterIndex(roster(), { scriptTags: [T.s0] });
const ctxOf = lang => ({ h, t: (k, v) => tl(lang, k, v), lang, index, resolve: null });
const FAKE = 'At bell 999 nation Ember destroyed your scout at (9,9) first.';

const minds = recs => normalizeMinds({ records: recs });
const openedMap = recs => new Map(normalizeOpenFile({ records: recs }).map(o => [o.id, o]));

test('Remembered lines print the code text of the cited episode, not the model\'s imitation of one (synthetic)', () => {
  const opened = openedRecord({ public: { say: [], why: `Remembered: ${FAKE}`, why_withheld: null } });
  const list = decisionList({ minds: minds([sealedRecord()]), opened: openedMap([opened]) });
  assert.equal(list.length, 1);
  const node = renderDecisions(ctxOf('en'), list);
  const rem = byClass(node, 'remembered-block')[0];
  const remText = textOf(rem);
  assert.match(remText, /Remembered \(cited by the model\):/);
  assert.match(remText, /At bell 205 nation Ember cleared the camp at \(-2,3\) first\./, 'the code text of the cited episode');
  assert.doesNotMatch(remText, /destroyed your scout/, 'the model\'s imitation never enters the Remembered block');
  assert.match(remText, /bell 205/);
  assert.match(remText, /197 bells earlier/, 'age in bells = decision bell 402 minus episode bell 205');
  // the model's words are shown separately and labelled
  const words = textOf(node);
  assert.match(words, /AI's words \(model-written, not verified\)/); // the contract's ASCII apostrophe (FB4, E2)
  assert.match(words, /Remembered: At bell 999 nation Ember destroyed your scout/, 'the imitation appears only as the labelled model-written words');
  assert.ok(byClass(node, 'words')[0], 'the words element exists');
  assert.doesNotMatch(textOf(byClass(node, 'words')[0]), /cleared the camp at \(-2,3\)/, 'and the code text never appears among the model words');
});

test('Remembered: only ids in choice.mem are shown; an id with no text is named as missing, never filled from the why', () => {
  const opened = openedRecord({
    choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: ['5f1471ffff624f49', 'ffffffffffffffff'] },
    remembered: [{ id: '5f1471ffff624f49', bell: 205, text: episodeText.camp }, { id: 'a1e34dee94bb1e02', bell: 388, text: episodeText.attacked }],
    public: { say: [], why: `Remembered: ${FAKE}`, why_withheld: null },
  });
  // the AI's episode list HAS loaded (and lacks the id): "not in the published list", not "not loaded yet"
  const d = buildDecision({ rec: minds([sealedRecord()])[0], opened: normalizeOpenFile({ records: [opened] })[0], episodes: normalizeEpisodes(episodesFile()) });
  assert.deepEqual(d.remembered.map(r => [r.id, r.missing]), [['5f1471ffff624f49', false], ['ffffffffffffffff', true]]);
  const text = textOf(rememberedBlock(ctxOf('en'), d.remembered));
  assert.doesNotMatch(text, /attacked your army/, 'an episode the model did not cite is not shown');
  assert.match(text, /episode ffffffff is not in the published list/);
  assert.doesNotMatch(text, /destroyed your scout/);
});

test('Remembered: a cited id the record lacks is resolved from the AI\'s episode store (code text), else missing', () => {
  const opened = openedRecord({ remembered: [], choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: ['a1e34dee94bb1e02'] } });
  const eps = normalizeEpisodes(episodesFile());
  const d = buildDecision({ rec: minds([sealedRecord()])[0], opened: normalizeOpenFile({ records: [opened] })[0], episodes: eps });
  assert.equal(d.remembered[0].missing, false);
  assert.equal(d.remembered[0].text.en, episodeText.attacked.en);
  assert.equal(d.remembered[0].age, 402 - 388);
  const none = buildDecision({ rec: minds([sealedRecord()])[0], opened: normalizeOpenFile({ records: [opened] })[0], episodes: null });
  assert.equal(none.remembered[0].missing, true);
});

test('Remembered: nothing cited prints "nothing cited"; the Japanese heading and text are used in ja', () => {
  const opened = openedRecord({ choice: { ids: ['c1'], params: {}, council: null, goal_id: 'G2', mem: [] }, remembered: [] });
  const node = renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([opened]) }));
  assert.match(textOf(byClass(node, 'remembered-block')[0]), /nothing cited/);
  const ja = renderDecisions(ctxOf('ja'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([openedRecord()]) }));
  const jaText = textOf(byClass(ja, 'remembered-block')[0]);
  assert.match(jaText, /引用した記憶（モデルが名指し）/);
  assert.match(jaText, /鐘205で、国エンバーが野営地\(-2,3\)を先に制圧した。/);
  assert.match(textOf(ja), /AIの言葉（モデルが書いたもので、検証されていません）/);
});

test('Remembered lines carry the roster badge beside every citizen name (synthetic)', () => {
  const opened = openedRecord({
    choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: ['a1e34dee94bb1e02'] },
    remembered: [{ id: 'a1e34dee94bb1e02', bell: 388, text: episodeText.attacked }],
  });
  const eps = normalizeEpisodes(episodesFile());
  const node = renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([opened]), episodesByTag: new Map([[T.ai0, eps]]) }));
  const rem = byClass(node, 'remembered-block')[0];
  assert.match(textOf(rem), /Elrin Somere AI/);
  assert.ok(findAll(rem, e => e.className.includes('badge-ai')).length >= 1);
});

test('a released decision shows by:model, the candidates, the choice, the destination from the REVEAL and both arrival bells (synthetic)', () => {
  const node = renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([openedRecord()]) }));
  const text = textOf(node);
  assert.match(text, /by: model/);
  assert.match(text, /released/);
  assert.match(text, /Toa Festead AI/);
  const cands = byClass(node, 'cand');
  assert.equal(cands.length, 3);
  assert.equal(byClass(node, 'chosen').length, 1);
  assert.match(textOf(cands[2]), /march 600 troops at the camp at \(-2,3\)/);
  assert.match(textOf(cands[2]), /target_troops: 240/);
  assert.match(textOf(cands[2]), /chosen/);
  assert.match(text, /Chose: march 600 troops at the camp/);
  assert.match(text, /Destination: \(-2,3\) tile 5/);
  assert.match(text, /arrives at bell 410 \(planned 409\)/);
  assert.match(text, /goal G1/);
});

test('a march that was never revealed says so; no destination is invented', () => {
  const node = renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([openedRecord({ destinations: [{ destination: 'unrevealed' }], destination: 'unrevealed' })]) }));
  const text = textOf(node);
  assert.match(text, /never revealed on chain; no destination is published/);
  assert.doesNotMatch(text, /Destination:/);
});

test('a sealed decision shows only what is public: commitment, release bell, the kinds of action sent; never a choice or reason (synthetic)', () => {
  const node = renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: new Map() }));
  const text = textOf(node);
  assert.match(text, /sealed/);
  assert.match(text, /release at bell 410/);
  assert.match(text, /Commitment b91b270ca5d7/);
  assert.match(text, /Sent: march, muster/);
  assert.equal(byClass(node, 'cand').length, 0);
  assert.doesNotMatch(text, /Chose:/);
  assert.doesNotMatch(text, /AI's words/);
});

test('a reason the checker withheld says so instead of printing text', () => {
  const opened = openedRecord({ public: { say: [], why: '(reason withheld by the checker: sealed_coordinate)', why_withheld: 'sealed_coordinate' } });
  const text = textOf(renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([opened]) })));
  assert.match(text, /The reason was withheld by the checker\. \(sealed_coordinate\)/);
});

test('autopilot steps are hidden unless asked; an autopilot march (Strike Order follow) stays visible as sealed', () => {
  const auto = sealedRecord({ id: '1'.repeat(64), mode: 'autopilot', sealed: false, release_bell: null, commit: null, tx: [], kind: 'autopilot', reason: 'below_gate' });
  const autoMarch = sealedRecord({ id: '2'.repeat(64), mode: 'autopilot', kind: 'autopilot', reason: 'ok' });
  assert.equal(decisionList({ minds: minds([auto]), opened: new Map() }).length, 0);
  assert.equal(decisionList({ minds: minds([auto]), opened: new Map(), showAutopilot: true }).length, 1);
  const shown = decisionList({ minds: minds([autoMarch]), opened: new Map() });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].by, 'autopilot');
  assert.match(textOf(renderDecisions(ctxOf('en'), shown)), /by: autopilot/);
});

test('a reflection record is labelled as a reflection: no "Chose", no "wrote no reason", no Remembered block (run-tree review, smoke-r1)', () => {
  const rec = sealedRecord({ id: '4'.repeat(64), kind: 'reflection', sealed: false, release_bell: null, commit: null, tx: [], choice: { ids: [], params: {}, council: null, goal_id: '', mem: [] }, public: { say: [], why: null, why_withheld: null } });
  const list = decisionList({ minds: minds([rec]), opened: new Map() });
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'reflection');
  for (const lang of ['en', 'ja']) {
    const text = textOf(renderDecisions(ctxOf(lang), list));
    assert.match(text, lang === 'en' ? /reflection/ : /振り返り/);
    assert.match(text, lang === 'en' ? /A reflection: the AI looked back/ : /振り返り：AI は最近の出来事/);
    assert.doesNotMatch(text, /no candidate named|The model wrote no reason|候補が特定できません|モデルは理由を書きませんでした|Remembered|記憶/);
  }
  // a session decision still prints all three (the reflection branch does not leak)
  const sess = textOf(renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([openedRecord()]) })));
  assert.match(sess, /Chose:/);
  assert.match(sess, /Remembered/);
});

test('an unsealed model decision is published at once, with its cited episodes resolved from the store (synthetic)', () => {
  const rec = sealedRecord({ id: '3'.repeat(64), sealed: false, release_bell: null, commit: null, tx: [{ intent: 'build', status: 'sent' }], choice: { ids: ['c4'], params: {}, council: null, goal_id: 'G2', mem: ['a1e34dee94bb1e02'] }, retrieved: ['a1e34dee94bb1e02'], public: { say: ['Hello'], why: 'Build a farm.', why_withheld: null } });
  const list = decisionList({ minds: minds([rec]), opened: new Map(), episodesByTag: new Map([[T.ai0, normalizeEpisodes(episodesFile())]]) });
  assert.equal(list[0].state, 'plain');
  const text = textOf(renderDecisions(ctxOf('en'), list));
  assert.match(text, /published/);
  assert.match(text, /Build a farm\./);
  assert.match(text, /At bell 388 Elrin Somere/);
  assert.match(text, /Said: Hello/);
});

test('an opened record whose published record is not loaded still renders, and decisions sort newest first', () => {
  const op2 = openedRecord({ id: '9'.repeat(64), bell: 440, release_bell: 450 });
  const list = decisionList({ minds: minds([sealedRecord()]), opened: openedMap([openedRecord(), op2]) });
  assert.deepEqual(list.map(d => d.bell), [440, 402]);
  assert.equal(list[0].state, 'released');
});

test('malformed files are dropped, not thrown on', () => {
  assert.deepEqual(normalizeMinds(null), []);
  assert.deepEqual(normalizeMinds({ records: [null, {}, { id: 1 }, { id: 'x', ai: 'nothex' }] }), []);
  assert.deepEqual(normalizeOpenFile('x'), []);
  assert.equal(normalizeOpenFile({ records: [{ id: 'a', ai: T.ai0, candidates: 'no', remembered: [null, {}], destinations: [null] }] }).length, 1);
  assert.equal(normalizeOpenFile([openedRecord()]).length, 1, 'a bare array is accepted');
  assert.equal(normalizeOpenFile(openedRecord()).length, 1, 'a single record is accepted');
  assert.equal(normalizeEpisodes({ episodes: [{ id: 'r', redacted: true }, null] }).size, 0);
});

test('open probes: release bell to release + 8, never a future bell, a present file is not fetched again, a miss is retried then given up', () => {
  const sealed = [{ id: 'a', releaseBell: 410 }];
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 409 }), [], 'not due yet');
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 412 }), [412, 411, 410]);
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 412, have: new Set([411]) }), [412, 410]);
  // a miss is not repeated in the same bell, is retried next bell, and is given up after bell + 3
  const missed = new Map([[410, 412]]);
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 412, missedAt: missed }), [412, 411]);
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 413, missedAt: missed }), [413, 412, 411, 410]);
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 420, missedAt: new Map([[410, 419]]) }).includes(410), false);
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 440 }), [418, 417, 416, 415, 414, 413, 412, 411], 'at most 8 per poll, newest first');
  assert.ok(planOpenProbes({ sealed, bellNow: 440 }).every(b => b >= 410 && b <= 418));
  assert.deepEqual(planOpenProbes({ sealed: [], hintBells: [415], bellNow: 420 }), [415], 'a chronicle hint is tried');
  assert.deepEqual(planOpenProbes({ sealed: [{ id: 'z', releaseBell: null }], bellNow: 500 }), []);
  assert.ok(planOpenProbes({ sealed: Array.from({ length: 50 }, (_, i) => ({ id: String(i), releaseBell: 100 + i * 10 })), bellNow: 700 }).length <= 8, 'bounded per poll');
});
