// Council page (unit AC7), the nation council (contract §6.5): options with the ratio word, motions, the hidden ballot,
// the tally split, the pivotal indicator, the sealed Strike Order and the scope statement. Synthetic states in the
// shapes of AC4's routes (ai-page-kit.mjs); the pivotal logic is also checked against AC4's own tally rule.
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { makeRosterIndex } from '../../permutation-server/web/frontier/council/badges.mjs';
import { normalizeCouncil, renderCouncil, ratioWord, pivotal, decideTally, adoptionParts } from '../../permutation-server/web/frontier/council/ballot.mjs';
import { encodeBallot, toBase64 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { makeFakeDocument, textOf, byClass, findAll } from './fixtures/ai-page-dom.mjs';
import { roster, councilState, W, T } from './fixtures/ai-page-kit.mjs';
import { createCouncil } from '../citizens/social/council.mjs';

const h = makeH(makeFakeDocument());
const index = makeRosterIndex(roster());
const ctxOf = lang => ({ h, t: (k, v) => tl(lang, k, v), lang, index, resolve: null });
const view = (council, over = {}) => ({ council, bell: 50, faction: 0, me: null, mine: null, note: '', slots: {}, draft: { option: 1, text: '' }, onDraft() {}, onNation() {}, onVote() {}, onMotion() {}, ...over });

const ballotRec = (wallet, option, origin, period = 2, faction = 0) => ({
  bytes_b64: toBase64(encodeBallot({ season: 41, period, wallet, faction, option, candidates_hash: 'ab'.repeat(32), nonce: crypto.randomBytes(16), origin })),
  sig_b64: 'AA==',
});
const WL = Array.from({ length: 6 }, (_, i) => (['7ChGBztTvT1ymVk43AgTyaAcWcwkcHPjGRFWAE2d7Ceb', '9VUWXMvPqqBvcQj47oE5VkSvEAqaz8zDkTgXkrcXziS6', 'D2vEqQ5EEVYZ7z8RorZvNjfYsq2oCrtQTnSzseyYHvVT', '57ACoYGGRcCyx4Qwfbdkk5k7ESmih5B2xG87xyEF2LaP', 'GHAw5eAE28B4JLUyRARvT1HiSxTkmyBPS2AtvQc9zHUC', '4Nd1mYQq8KqM6bVx3dEo7rLw9XkTzPcFhJ2uAaYsRbGv'])[i]);

test('ratio word: the file\'s word wins; a number is classified as §4.3 (>= 2 favourable, >= 1 even, else unfavourable)', () => {
  assert.equal(ratioWord({ ratio: 'even' }), 'even');
  assert.equal(ratioWord({ own: 400, value: 120 }), 'favourable');
  assert.equal(ratioWord({ own: 150, value: 100 }), 'even');
  assert.equal(ratioWord({ own: 90, value: 100 }), 'unfavourable');
  assert.equal(ratioWord({ ratio: 2 }), 'favourable');
  assert.equal(ratioWord({ ratio: 0.4 }), 'unfavourable');
  assert.equal(ratioWord({ ratio: 'whatever' }), null);
  assert.equal(ratioWord({}), null);
});

test('options: three code-made options with kind, place, strength, own troops and the ratio word labelled as an estimate (synthetic)', () => {
  const node = renderCouncil(ctxOf('en'), view(normalizeCouncil(councilState())));
  const opts = byClass(node, 'option');
  assert.equal(opts.length, 3);
  assert.match(textOf(opts[0]), /Option 1.*camp \(-2,3\).*target strength 120.*our nearby troops 400.*ratio: favourable \(estimate\)/);
  assert.match(textOf(opts[1]), /enemy stack \(1,4\).*ratio: even \(estimate\)/);
  assert.match(textOf(opts[2]), /village raid \(3,-1\).*ratio: unfavourable \(estimate\)/);
  assert.match(textOf(node), /Options \(made by code, same for everyone\)/);
  const ja = textOf(renderCouncil(ctxOf('ja'), view(normalizeCouncil(councilState()))));
  assert.match(ja, /兵力比：有利（推定）/);
  assert.match(ja, /攻撃命令/);
});

test('motions are listed with the author\'s roster badge and the speech as text; the phase and the bells left are printed', () => {
  const node = renderCouncil(ctxOf('en'), view(normalizeCouncil(councilState())));
  const text = textOf(node);
  assert.match(text, /Ballot window: one ballot each, hidden until the order opens/);
  assert.match(text, /period 2 · closes at bell 54 \(4 bells left\)/);
  assert.match(text, /Vanasha Soridge AI/);
  assert.match(text, /moved option 1/);
  assert.match(text, /The camp is close; let us take it\./);
  assert.match(text, /Ballots cast: 1 \(counts stay hidden until the order opens\)/);
  assert.equal(findAll(byClass(node, 'motion')[0], e => e.className.includes('badge-ai')).length, 1);
});

test('no council: the page says so and still prints the scope statement', () => {
  for (const c of [null, normalizeCouncil({ period: null, faction: 0, state: 'none', options: [], motions: [] }), normalizeCouncil(councilState({ state: 'none', options: [] }))]) {
    const text = textOf(renderCouncil(ctxOf('en'), view(c)));
    assert.match(text, /No council this period/);
    assert.match(text, /What this council is, and is not/);
  }
});

test('the §6.5 scope statement: off-chain, nothing enforces the order, the human-present rule binds only a nation with a human and only the collective order, nation 0 and the operator (EN and JA)', () => {
  const en = textOf(renderCouncil(ctxOf('en'), view(normalizeCouncil(councilState()))));
  assert.match(en, /The council is off-chain: the program has no governance, and nothing on chain enforces a Strike Order/);
  assert.match(en, /binds only a nation that has an eligible human \(in the hackathon: nation 0 with the operator’s seat\)/);
  assert.match(en, /never an individual AI citizen’s own march/);
  assert.match(en, /In the hackathon the human is the operator, for nation 0 only/);
  assert.match(en, /Motions are public, so they leak preference/);
  const ja = textOf(renderCouncil(ctxOf('ja'), view(normalizeCouncil(councilState()))));
  assert.match(ja, /オフチェーン/);
  assert.match(ja, /チェーン上で攻撃命令を強制するものはありません/);
  assert.match(ja, /国0に限ります/);
  assert.match(ja, /AI市民個人の進軍は縛りません/);
});

test('closed and adopted: the tally split by who cast the ballots and the sentence "adopted with 1 AI ballot and the presenter\'s ballot"; the target stays sealed', () => {
  const c = normalizeCouncil(councilState({ state: 'closed', adopted: true, strike_bell: 60, follow_from: 54, tally_split: { ai: 1, human: 1, scripted: 0 }, ballots_cast: 2, call_commit: 'cd'.repeat(32) }));
  const text = textOf(renderCouncil(ctxOf('en'), view(c)));
  assert.match(text, /Ballots by who cast them: AI 1 · human \(the presenter\) 1 · scripted seat 0/);
  assert.match(text, /Strike Order adopted with 1 AI ballot\(s\) \+ the presenter’s ballot — strike at bell 60 \(target sealed\)\./);
  assert.doesNotMatch(text, /Target: option/, 'the target is not shown before the order opens');
  assert.doesNotMatch(text, /The Strike Order opened/);
  const scripted = textOf(renderCouncil(ctxOf('en'), view(normalizeCouncil(councilState({ state: 'closed', adopted: true, strike_bell: 60, tally_split: { ai: 1, human: 0, scripted: 1 } })))));
  assert.match(scripted, /1 AI ballot\(s\) \+ a scripted seat ballot/);
  assert.doesNotMatch(scripted, /the presenter’s ballot/, 'an A/B ballot is never described as a human decision');
  assert.equal(adoptionParts((k, v) => tl('en', k, v), null), 'no ballot recorded');
});

test('closed and not adopted: the reason is printed', () => {
  for (const [reason, re] of [['quorum', /fewer than two ballots/], ['tie', /tie/], ['none_wins', /“none” won/], ['human_present', /no human or scripted-seat ballot/]]) {
    const text = textOf(renderCouncil(ctxOf('en'), view(normalizeCouncil(councilState({ state: 'closed', adopted: false, reason, tally_split: { ai: 2, human: 0, scripted: 0 } })))));
    assert.match(text, /No Strike Order adopted/);
    assert.match(text, re);
  }
});

test('opened: the target, the tally per option and the strike result (present, bounced, troops lost per nation) (synthetic)', () => {
  const open = { option: 1, kind: 'camp', p: -2, q: 3, tile: 5, nonce: 'ee'.repeat(32), invited: ['1', '2'], tally: { 0: 0, 1: 3, 2: 0, 3: 0 }, ballots: [] };
  const result = { present: 2, bounced: 1, clash: { engagements: 2, lost: { 0: 100, 4: 340 } } };
  const c = normalizeCouncil(councilState({ state: 'closed', adopted: true, strike_bell: 60, tally_split: { ai: 2, human: 1, scripted: 0 }, open, result }));
  const node = renderCouncil(ctxOf('en'), view(c));
  const text = textOf(node);
  assert.match(text, /The Strike Order opened/);
  assert.match(text, /Target: option 1, camp at \(-2,3\)/);
  assert.match(text, /Tally: 1: 3 · 2: 0 · 3: 0 · none: 0/);
  assert.match(text, /armies present at the target: 2/);
  assert.match(text, /bounced: 1/);
  assert.match(text, /2 engagements; Aster lost 100, Ember lost 340/);
  assert.doesNotMatch(text, /eeee/, 'the nonce is never printed');
  assert.equal(byClass(node, 'adopted').length, 1, 'the adopted option is marked');
  const waiting = textOf(renderCouncil(ctxOf('en'), view(normalizeCouncil(councilState({ state: 'closed', adopted: true, strike_bell: 60, open: { ...open, ballots: [] }, result: null })))));
  assert.match(waiting, /strike result is published after the strike bell/);
});

// ------------------------------------------------------------------ pivotal
const asCouncil = (ballots, over = {}) => normalizeCouncil(councilState({
  state: 'closed', adopted: true, strike_bell: 60, tally_split: { ai: 1, human: 1, scripted: 0 },
  open: { option: 1, kind: 'camp', p: -2, q: 3, tile: 5, nonce: 'aa'.repeat(32), invited: [], tally: { 0: 0, 1: ballots.filter(b => b.option === 1).length, 2: 0, 3: 0 }, ballots: ballots.map(b => ballotRec(b.wallet, b.option, b.origin)) },
  ...over,
}));
const me = W.seat;

test('pivotal: the presenter\'s ballot is pivotal when it is the only human ballot for the adopted option (the human-present rule)', () => {
  const c = asCouncil([{ wallet: WL[0], option: 1, origin: 1 }, { wallet: WL[1], option: 1, origin: 1 }, { wallet: WL[2], option: 1, origin: 1 }, { wallet: me, option: 1, origin: 0 }]);
  assert.deepEqual(pivotal({ council: c, wallet: me, humanSeatHere: true }), { state: 'yes', why: 'human' });
});

test('pivotal: with one AI ballot and the presenter\'s (2 ballots), removing the presenter\'s leaves one: quorum', () => {
  const c = asCouncil([{ wallet: WL[0], option: 1, origin: 1 }, { wallet: me, option: 1, origin: 0 }]);
  assert.deepEqual(pivotal({ council: c, wallet: me, humanSeatHere: true }), { state: 'yes', why: 'quorum' });
});

test('pivotal: not pivotal when another human or scripted ballot also backs the option and the quorum holds', () => {
  const c = asCouncil([{ wallet: WL[0], option: 1, origin: 1 }, { wallet: WL[3], option: 1, origin: 2 }, { wallet: me, option: 1, origin: 0 }]);
  assert.deepEqual(pivotal({ council: c, wallet: me, humanSeatHere: true }), { state: 'no', why: null });
});

test('pivotal: losing the strict lead counts (3 against 2 becomes a tie without the ballot)', () => {
  const c = asCouncil([{ wallet: WL[0], option: 1, origin: 1 }, { wallet: WL[1], option: 1, origin: 2 }, { wallet: me, option: 1, origin: 0 }, { wallet: WL[2], option: 2, origin: 1 }, { wallet: WL[4], option: 2, origin: 1 }]);
  assert.deepEqual(pivotal({ council: c, wallet: me, humanSeatHere: true }), { state: 'yes', why: 'lead' });
});

test('pivotal: a ballot for another option, no ballot, an unclosed or unadopted period', () => {
  const other = asCouncil([{ wallet: WL[0], option: 1, origin: 1 }, { wallet: WL[1], option: 1, origin: 2 }, { wallet: me, option: 2, origin: 0 }]);
  assert.equal(pivotal({ council: other, wallet: me, humanSeatHere: true }).state, 'other');
  assert.equal(pivotal({ council: other, wallet: WL[5], humanSeatHere: true }).state, 'none_cast');
  assert.equal(pivotal({ council: normalizeCouncil(councilState()), wallet: me }).state, 'unknown', 'ballot window still open');
  assert.equal(pivotal({ council: normalizeCouncil(councilState({ state: 'closed', adopted: false, reason: 'tie' })), wallet: me }).state, 'not_adopted');
  assert.equal(pivotal({ council: null, wallet: me }).state, 'unknown');
});

test('pivotal: before the order opens the ballots are hidden, so only the human-present reading is possible, and only for a ballot this page cast', () => {
  const closed = normalizeCouncil(councilState({ state: 'closed', adopted: true, strike_bell: 60, tally_split: { ai: 2, human: 1, scripted: 0 } }));
  assert.deepEqual(pivotal({ council: closed, wallet: me, humanSeatHere: true, mine: { option: 1, origin: 0 } }), { state: 'yes', why: 'human' });
  assert.equal(pivotal({ council: closed, wallet: me, humanSeatHere: true, mine: null }).state, 'unknown');
  const two = normalizeCouncil(councilState({ state: 'closed', adopted: true, strike_bell: 60, tally_split: { ai: 1, human: 1, scripted: 1 } }));
  assert.equal(pivotal({ council: two, wallet: me, humanSeatHere: true, mine: { option: 1, origin: 0 } }).state, 'unknown', 'two non-AI ballots: not decidable from the split alone');
});

test('pivotal: the page\'s tally rule is AC4\'s tally rule (every combination of up to 5 ballots over 3 options and none, human present or not)', async () => {
  // Compare decideTally with the council store's own close, for a sample of ballot multisets.
  const origins = [1, 1, 0, 2, 1];
  let checked = 0;
  for (let mask = 0; mask < 4 ** 5; mask += 7) {
    const opts = Array.from({ length: 5 }, (_, i) => (mask >> (2 * i)) & 3);
    const ballots = opts.map((option, i) => ({ option, origin: origins[i] }));
    for (const humans of [false, true]) {
      // as pivotal() computes it: a human is present when the seat is in the nation or any ballot is origin 0 or 2
      const page = decideTally(ballots, humans || ballots.some(b => b.origin === 0 || b.origin === 2));
      const book = { nameOf: () => ({ en: 'x', ja: 'x' }), setHooks() {}, rosterNow: () => ({ seat: null }), resolveMe: async () => ({ ok: false }), records: [] };
      const store = createCouncil({ aiDir: null, book, config: { period: 24, offset: 0, strike_lead: 6, human_present: true }, clock: { bell: () => 40, unix: () => 0 } });
      store.open({ faction: 0, period: 1, c0: 24, candidates: [{ option: 1, kind: 'camp', p: 0, q: 0, value: 1, own: 2, ratio: 'favourable' }, { option: 2, kind: 'camp', p: 1, q: 0, value: 1, own: 2, ratio: 'favourable' }, { option: 3, kind: 'camp', p: 2, q: 0, value: 1, own: 2, ratio: 'favourable' }], humans: humans ? ['HUMAN'] : [] });
      const P = store.periodOf(0, 1);
      ballots.forEach((b, i) => P.ballots.set(`w${i}`, { id: i, wallet: `w${i}`, kind: b.origin === 1 ? 'ai' : 'human', option: b.option, origin: b.origin, inner: `i${i}`, rec: { bytes: new Uint8Array(1), sig: new Uint8Array(64) } }));
      await store.tick(40);
      const out = store.winner(0, 1);
      assert.equal(page.adopted, out.adopted, `ballots ${JSON.stringify(ballots)} humans ${humans}`);
      if (page.adopted) assert.equal(page.option, out.option);
      else assert.equal(page.reason, out.reason);
      checked++;
    }
  }
  assert.ok(checked > 200);
});

// ------------------------------------------------------------------ writing
test('voting and motions appear only in their windows, only with a key, and only in the viewer\'s own nation', () => {
  const ballots = normalizeCouncil(councilState());
  const noKey = textOf(renderCouncil(ctxOf('en'), view(ballots)));
  assert.match(noKey, /Import the presenter key below to vote/);
  assert.equal(byClass(renderCouncil(ctxOf('en'), view(ballots)), 'vote').length, 0);
  const withKey = renderCouncil(ctxOf('en'), view(ballots, { me: { wallet: W.seat, faction: 0 } }));
  assert.equal(byClass(withKey, 'vote').length, 1);
  assert.equal(findAll(byClass(withKey, 'vote')[0], e => e.tagName === 'BUTTON').length, 4, 'three options and "none"');
  const votes = [];
  const clicked = renderCouncil(ctxOf('en'), view(ballots, { me: { wallet: W.seat, faction: 0 }, onVote: o => votes.push(o) }));
  findAll(byClass(clicked, 'vote')[0], e => e.tagName === 'BUTTON').forEach(b => b.click());
  assert.deepEqual(votes, [1, 2, 3, 0]);
  const wrongNation = textOf(renderCouncil(ctxOf('en'), view(ballots, { me: { wallet: W.seat, faction: 3 } })));
  assert.match(wrongNation, /Your key belongs to another nation/);
  const motions = normalizeCouncil(councilState({ state: 'motions' }));
  assert.equal(byClass(renderCouncil(ctxOf('en'), view(motions, { me: { wallet: W.seat, faction: 0 } })), 'motion-form').length, 1);
  assert.equal(byClass(renderCouncil(ctxOf('en'), view(motions, { me: null })), 'motion-form').length, 0);
  assert.equal(byClass(renderCouncil(ctxOf('en'), view(motions, { me: { wallet: W.seat, faction: 2 } })), 'motion-form').length, 0);
  const closed = normalizeCouncil(councilState({ state: 'closed' }));
  assert.equal(byClass(renderCouncil(ctxOf('en'), view(closed, { me: { wallet: W.seat, faction: 0 } })), 'vote').length, 0);
});

test('the pivotal verdict is printed for the viewer after the close, in both languages', () => {
  const c = asCouncil([{ wallet: WL[0], option: 1, origin: 1 }, { wallet: WL[1], option: 1, origin: 1 }, { wallet: me, option: 1, origin: 0 }]);
  const en = textOf(renderCouncil(ctxOf('en'), view(c, { me: { wallet: me, faction: 0 } })));
  assert.match(en, /Was your ballot pivotal\?/);
  assert.match(en, /Yes: without your ballot this option would not have been adopted \(yours was the only human or scripted-seat ballot for it/);
  const ja = textOf(renderCouncil(ctxOf('ja'), view(c, { me: { wallet: me, faction: 0 } })));
  assert.match(ja, /あなたの票は決め手でしたか/);
  assert.doesNotMatch(textOf(renderCouncil(ctxOf('en'), view(c, { me: null }))), /Was your ballot pivotal/);
});

test('nation tabs: six nations by name; a click asks for that nation', () => {
  const picks = [];
  const node = renderCouncil(ctxOf('en'), view(normalizeCouncil(councilState()), { onNation: n => picks.push(n) }));
  const tabs = findAll(node, e => e.className.split(' ').includes('tab'));
  assert.deepEqual(tabs.map(x => textOf(x)), ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal']);
  tabs[4].click();
  assert.deepEqual(picks, [4]);
  assert.equal(findAll(node, e => e.className.includes('selected')).length, 1);
});

test('live state and period file both normalise (options/candidates, open ballots decoded, junk dropped)', () => {
  const live = normalizeCouncil(councilState());
  const file = normalizeCouncil({ ...councilState(), options: undefined, candidates: councilState().options });
  assert.deepEqual(live.options, file.options);
  const withOpen = normalizeCouncil({ ...councilState(), state: 'closed', adopted: true, open: { option: 1, kind: 'camp', p: 1, q: 2, tile: 3, tally: { 1: 2 }, ballots: [ballotRec(W.seat, 1, 0), { bytes_b64: '!!!' }, null] } });
  assert.equal(withOpen.open.ballots.length, 1);
  assert.equal(withOpen.open.ballots[0].wallet, W.seat);
  assert.equal(withOpen.open.ballots[0].origin, 0);
  assert.equal(normalizeCouncil(null), null);
  assert.deepEqual(normalizeCouncil({ options: [{ option: 9 }, { option: 2, kind: '<b>' }] }).options.map(o => [o.option, o.kind]), [[2, '']]);
});
