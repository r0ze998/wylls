// World goal ② research on the page (hud/research.mjs; owner r0ze 2026-11-25 08:56, every Q-RS recommendation): the
// world goals card's research part and the village card's two-press contribution, in Japanese and English, under the
// fog rule Q-RS-9 (1) (b) — other nations' known techs and the world firsts are told, their totals never.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as RC from '../../permutation-server/web/frontier/hud/research.mjs';
import * as UI from '../../permutation-server/web/frontier/hud/worldgoals.mjs';
import * as J from '../src/frontier/world-research.mjs';
import { decodeResearchWorld, decodeNationResearch } from '../../permutation-server/web/frontier/flocalplay-research.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { worldBytes, nationBytes } from './research-fixtures.mjs';

const ME = 3;
const read = () => ({
  world: decodeResearchWorld(worldBytes({ startBell: 10, first: { 0: 40 }, firstNations: { 0: 0b1 }, known: { 0: 0b1 } })),
  nations: Array.from({ length: 6 }, (_, f) => decodeNationResearch(nationBytes(f, f === 0 ? { learned: { 0: 40 }, pledged: { 0: 300, 1: 123 } } : f === ME ? { pledged: { 0: 200, 1: 77 } } : {}))),
});
const answer = (viewer, bell = 50) => {
  const r = read();
  return { ok: true, v: 1, kind: 'world-goals', ruleset: 'flag-keeps-v2', testOnly: true, season: { programId: 'P', seasonId: '11' }, effects: { money: 'none', chain: 'none' }, bell, error: null,
    goals: [{ id: 'flag-keeps', kind: 'hegemony', live: true }, { id: 'world-first-tech', kind: 'science', live: true }], flagKeeps: null, achievements: [],
    research: { ruleset: J.RESEARCH_RULESET, posting: J.postingOf(r.world), firsts: [], problems: [], view: J.viewOf(r.world, r.nations, viewer), viewer, history: [] } };
};
const FS = (extra = {}) => ({ season: { seasonId: '11' }, citizen: { faction: ME }, wallet: { address: 'W' }, ...extra });
const text = h => String(h).replace(/<[^>]+>/g, ' ');

test('the answer stays a good world-goals answer and the card shows the research part (JA)', () => {
  setLang('ja');
  const a = answer(ME);
  assert.ok(UI.goodAnswer(a));
  const card = String(UI.render(FS(), { read: 'ok', goals: a }));
  assert.match(card, /data-era="1"/);
  assert.match(text(card), /世界初：/);
  assert.match(text(card), /あなたの国 200 \/ 240/, 'the discounted cost for the viewer (one nation knows it)');
  assert.match(text(card), /効果はまだ動いていません/, 'roads: not wired yet');
  assert.match(text(card), /時代 2・3 の技術は準備中/);
});

test('fog (Q-RS-9 (1) (b)): another nation\'s totals are never in the card; a spectator sees no totals', () => {
  setLang('ja');
  const mine = String(UI.render(FS(), { read: 'ok', goals: answer(ME) }));
  assert.doesNotMatch(mine, /123/, 'nation 0 pledged 123 to masonry: not told');
  const spectator = String(UI.render(FS({ citizen: null }), { read: 'ok', goals: answer(null) }));
  assert.doesNotMatch(text(spectator), /あなたの国 \d/);
  assert.match(text(spectator), /覚えた国 1/);
  assert.equal(RC.researchQuery(FS()), '?nation=3');
  assert.equal(RC.researchQuery({}), '');
});

test('the village card: the two presses, the banked-science note, the effects not yet here (EN)', () => {
  setLang('en');
  const b = { read: 'ok', goals: answer(ME) };
  const h = { p: 2, q: 0, site: 1, faction: ME };
  const first = String(RC.villageResearchCard(FS(), h, { science: 30, answer: b }));
  assert.match(first, /data-act="research-arm" data-tech="0" data-amount="30"/);
  assert.match(text(first), /Contribute \(30\)/);
  assert.match(text(first), /Science stored before research started \(turn 10\) does not count/);
  assert.doesNotMatch(text(first), /[぀-ヿ一-鿿]/, 'no Japanese left in the English card');
  const armed = String(RC.villageResearchCard(FS({ ui: { researchArm: { at: '2,0,1', tech: 0, amount: 30 } } }), h, { science: 30, answer: b }));
  assert.match(armed, /data-act="research-pledge"/);
  assert.match(text(armed), /You will contribute 30 science to “Agriculture”\. Contributed science does not come back\./);
  // the nation knows masonry, the village has none of it: the apply button
  const known = read(); known.nations[ME] = decodeNationResearch(nationBytes(ME, { learned: { 1: 45 } }));
  const kb = { read: 'ok', goals: { ...answer(ME), research: { ...answer(ME).research, view: J.viewOf(known.world, known.nations, ME) } } };
  const fx = String(RC.villageResearchCard(FS(), { ...h, researchMask: { techs: 0, nation: null, rebased: true } }, { science: 0, answer: kb }));
  assert.match(fx, /data-act="research-apply"/);
  assert.match(text(fx), /Masonry/);
  setLang('ja');
});

test('before the start bell nothing can be contributed; refusals have their own words', () => {
  setLang('ja');
  const b = { read: 'ok', goals: answer(ME, 5) };
  const c = String(RC.villageResearchCard(FS(), { p: 2, q: 0, site: 1 }, { science: 30, answer: b }));
  assert.match(c, /data-act="research-arm"[^>]*disabled/);
  assert.match(text(c), /研究はターン 10 に始まります/);
  for (const pc of [12, 13, 21, 40, 43, 52, 99]) assert.ok(RC.researchRefusalText(pc), String(pc));
  assert.equal(RC.researchRefusalText(1), null);
  // no research in this world: nothing drawn
  assert.equal(String(RC.villageResearchCard(FS(), { p: 2, q: 0, site: 1 }, { science: 30, answer: { read: 'ok', goals: { ...answer(ME), research: null } } })), '');
});
