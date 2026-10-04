// Council page (unit AC7), roster and Wyll cards (contract §2.4, §2.2 R4, §5.5, §8.3). Synthetic cards in the shape of
// AC2's renderCard; one test renders a card made by AC2's real renderCard so the page and the producer stay in step.
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { makeRosterIndex } from '../../permutation-server/web/frontier/council/badges.mjs';
import { normalizeCard, renderCard, renderRoster, rosterModel, byModelShare, progressOf, temperamentIndex } from '../../permutation-server/web/frontier/council/cards.mjs';
import { tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { makeFakeDocument, textOf, byClass, findAll } from './fixtures/ai-page-dom.mjs';
import { roster, card, T, episodesFile } from './fixtures/ai-page-kit.mjs';
import { renderCard as acRenderCard } from '../citizens/memory/cards.mjs';
import { Ledger } from '../citizens/memory/ledger.mjs';
import { normalizeEpisodes } from '../../permutation-server/web/frontier/council/decisions.mjs';

const h = makeH(makeFakeDocument());
const index = makeRosterIndex(roster(), { scriptTags: [T.s0] });
const ctxOf = lang => ({ h, t: (k, v) => tl(lang, k, v), lang, index, resolve: null });

test('progress: a number is clamped to 0..100; null, missing, NaN and text are "not computed", never 0', () => {
  assert.equal(progressOf(50), 50);
  assert.equal(progressOf(0), 0);
  assert.equal(progressOf(120), 100);
  assert.equal(progressOf(-4), 0);
  assert.equal(progressOf(33.6), 34);
  for (const bad of [null, undefined, NaN, '50', {}, [], true]) assert.equal(progressOf(bad), null, String(bad));
});

test('card (synthetic): a goal whose progress is null prints "progress not computed" and no meter; 0 prints as a measurement', () => {
  const c = normalizeCard(card());
  const node = renderCard(ctxOf('en'), c, index.aiByTag(T.ai0), { episodesById: null });
  const goals = byClass(node, 'goal');
  assert.equal(goals.length, 4);
  const g3 = goals[2];
  assert.match(textOf(g3), /progress not computed/);
  assert.equal(findAll(g3, e => e.tagName === 'METER').length, 0, 'no meter for a null goal');
  assert.doesNotMatch(textOf(g3), /0%/);
  const g4 = goals[3];
  assert.match(textOf(g4), /0%/, 'a measured zero is printed as 0%');
  assert.equal(findAll(g4, e => e.tagName === 'METER').length, 1);
  assert.doesNotMatch(textOf(g4), /not computed/);
  // memory goals are marked
  assert.match(textOf(goals[0]), /memory goal/);
  assert.doesNotMatch(textOf(goals[1]), /memory goal/);
});

test('card (synthetic): Japanese prints 進捗は未計算 for null', () => {
  const node = renderCard(ctxOf('ja'), normalizeCard(card()), index.aiByTag(T.ai0), {});
  assert.match(textOf(byClass(node, 'goal')[2]), /進捗は未計算/);
});

test('card (synthetic): by:model share is printed with the by:autopilot count, with the AI badge and the label', () => {
  const c = normalizeCard(card());
  assert.deepEqual(byModelShare(c.stats), { model: 9, autopilot: 112, total: 121, pct: 7 });
  const node = renderCard(ctxOf('en'), c, index.aiByTag(T.ai0), {});
  const text = textOf(node);
  assert.match(text, /by model 9 · by autopilot 112/);
  assert.match(text, /chose 7%|chose 7% of the actions/);
  assert.match(text, /model marches 3 \(opened 2\)/);
  assert.match(text, /AI citizen — run by the operator with Gemma 4 \(local\)/);
  assert.ok(findAll(node, e => e.className.includes('badge-ai')).length >= 1);
  assert.equal(byModelShare({}).pct, null);
  assert.equal(byModelShare({ actions_by_model: 3 }).pct, 100);
});

test('card (synthetic): memory block: summary labelled as model-written, recent episodes with badges, grievance open, trust split', () => {
  const eps = normalizeEpisodes(episodesFile());
  const node = renderCard(ctxOf('en'), normalizeCard(card()), index.aiByTag(T.ai0), { episodesById: eps });
  const text = textOf(node);
  assert.match(text, /Written by the AI's model/); // the page's own fixed label, ASCII apostrophe
  assert.match(text, /not verified, not replayed/);
  assert.match(text, /At bell 388 Elrin Somere/);
  assert.match(text, /At bell 205 nation Ember cleared the camp/);
  assert.ok(findAll(byClass(node, 'memory')[0], e => e.className.includes('badge-ai')).length >= 2, 'the AI badge follows the AI names in the lines (Elrin Somere, in the episode and in the grievance)');
  assert.match(text, /open/);
  assert.match(text, /code -30 · model -5/);
  assert.match(text, /trust -35/);
  assert.match(text, /pseudonymous in-game identifiers/);
  assert.match(text, /automated judgements about named participants/);
});

test('card (synthetic): no summary yet, no episodes, no grievances: plain empty lines, no invention', () => {
  const c = normalizeCard(card(T.ai0, { memory: { summary: null, recent: [], grievances: [] }, relationships: [], revealed_reasons: [] }));
  const text = textOf(renderCard(ctxOf('en'), c, index.aiByTag(T.ai0), {}));
  assert.match(text, /No self-summary yet/);
  assert.match(text, /No episodes yet/);
  assert.match(text, /No grievances recorded/);
  assert.match(text, /No reason has been published yet/);
  assert.match(text, /No relationships recorded yet/);
});

test('card: resting is printed when the daily budget is used', () => {
  const c = normalizeCard(card(T.ai0, { budget: { messages_left: 0, reactions_left: 2, resting: true } }));
  assert.match(textOf(renderCard(ctxOf('en'), c, index.aiByTag(T.ai0), {})), /resting: daily message or reaction budget used/);
});

test('card: a malformed card is dropped or emptied, never thrown on', () => {
  for (const bad of [null, 42, 'x', {}, { v: 2, tag: 'x' }, { v: 1 }]) assert.equal(normalizeCard(bad), null);
  const c = normalizeCard({ v: 1, tag: T.ai0, goals: 'no', relationships: [null, 3], memory: 'no', revealed_reasons: [null], stats: null });
  assert.ok(c);
  assert.doesNotThrow(() => renderCard(ctxOf('en'), c, null, {}));
});

test('temperament words follow §2.1 (0-19 very low, 20-39 low, 40-59 moderate, 60-79 high, 80-100 very high)', () => {
  assert.deepEqual([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(temperamentIndex), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  const text = textOf(renderCard(ctxOf('en'), normalizeCard(card()), index.aiByTag(T.ai0), {}));
  assert.match(text, /grudge: very high/);
  assert.match(text, /sociability: moderate/);
});

test('roster (synthetic): AI citizens with badges and by:model share, script bots as a labelled group, the seat', () => {
  const cards = new Map([[T.ai0, normalizeCard(card())]]);
  const node = renderRoster(ctxOf('en'), index, cards, { selected: T.ai0 });
  const text = textOf(node);
  assert.match(text, /AI citizens \(3\)/);
  assert.match(text, /by the model 7%/);
  assert.match(text, /no actions yet/, 'an AI without a card yet');
  assert.match(text, /Script bots/);
  assert.match(text, /120 script bots: rule-driven test population, not AI and not human/);
  assert.match(text, /presenter seat \(human operator\)/);
  assert.equal(findAll(node, e => e.className.includes('badge-ai')).length, 3);
  assert.ok(findAll(node, e => e.className.includes('badge-script')).length >= 1);
  assert.equal(byClass(node, 'roster-item').length, 3);
  assert.equal(byClass(node, 'selected').length, 1);
  assert.deepEqual(rosterModel(index, cards).map(r => r.entry.tag), [T.ai0, T.ai2, T.ai1], 'ordered by nation, then index');
});

test('roster: the scripted seat is labelled as scripted for the A/B test', () => {
  const idx = makeRosterIndex(roster({ seat: { ...roster().seat, scripted: true } }));
  assert.match(textOf(renderRoster(ctxOf('en'), idx, new Map())), /Scripted for the A\/B test/);
});

test('roster: before the roster is published the page says so', () => {
  assert.match(textOf(renderRoster(ctxOf('en'), makeRosterIndex(null), new Map())), /roster has not been published yet/);
});

test('a card written by AC2\'s own renderCard renders (the page and the producer agree on the shape)', () => {
  const led = Ledger.create({ tag: T.ai0, goals: [], bell: 0 });
  const out = acRenderCard({
    tag: T.ai0, wallet: roster().ai[0].wallet, faction: 0, index: 1000, bell: 120,
    persona: { id: 'avenger', ambition: { en: 'Avenger', ja: '復讐者' }, creed: { en: 'Every wrong is answered.', ja: '必ず報いる。' }, temperament: { aggression: 65, loyalty: 70, ambition: 50, honesty: 60, risk: 60, sociability: 45, grudge: 90 }, name: { en: 'Toa Festead', ja: 'トア' },
      goals: [{ id: 'G1', text: { en: 'Answer grievances', ja: '報いる' }, memory: true }, { id: 'G2', text: { en: 'Keep half the troops home', ja: '半数を保つ' }, memory: false }] },
    ledger: led.snapshot(), episodes: [], summary: null, progress: { G1: null, G2: 80 }, revealed: [], budget: { messages_left: 4, reactions_left: 3 }, stats: { actions_by_model: 2, actions_by_autopilot: 10 },
  });
  const c = normalizeCard(out);
  assert.ok(c, 'the AC2 card normalises');
  assert.equal(c.goals[0].progress, null);
  assert.equal(c.goals[1].progress, 80);
  const text = textOf(renderCard(ctxOf('en'), c, index.aiByTag(T.ai0), {}));
  assert.match(text, /progress not computed/);
  assert.match(text, /by model 2 · by autopilot 10/);
});
