// ⑮ 「依頼に応えた」 (owner decision 2026-11-22 11:56, Q1-⑮): the personal title P-board-helper from ①'s FULFILLED co-op
// requests. Awarded only to a player whose own delivery counted (①'s proven lower bound) toward a request of someone of
// ANOTHER nation that reached its requested amount — by anyone's counted deliveries, the requester's own nation's included
// (owner 2026-11-26 10:52, Q-TG2-2). Not for accepting without delivering, a partial request, one's own
// request, or a request of one's own nation. Titles and chronicle only: no win, score or prize effect.
// No chain, no key: PS2 bodies laid out from the ABI's tables and decoded by the page's own decoder (test/ps2.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLive, liveInput, fulfilledEvents, TITLES, AUDIENCE, NO_EFFECT } from '../src/live.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { hashOf } from '../src/canon.mjs';
import { heraldRows, decodeRows, cargo, place } from './ps2.mjs';

// Wallets: one byte repeated. Board wallets are strings ('A' …); the herald's JOIN carries the bytes.
const W = { A: 0x41, B: 0x52, C: 0x13, D: 0x63, E: 0x77 };
const bytes = b => new Uint8Array(32).fill(b);
const tagOf = w => {
  if (typeof w === 'string') return W[w] !== undefined ? String(W[w]) : null;
  if (w instanceof Uint8Array && w.length === 32 && w.every(x => x === w[0])) return Object.values(W).includes(w[0]) ? String(w[0]) : null;
  return null;
};
const V = place(1, -1, 2, 5, 0);   // A's village (the request's destination)

/**
 * A (nation 1) asks; B (nation 2) and D (nation 3) deliver; C (nation 1, A's own nation) delivers too; A sends one
 * caravan to their own village. E never joined (no nation on record). Rows are numbered from 1: sig<n> is row n.
 */
function world() {
  return [
    ['JOIN', 1, { wallet: bytes(W.A), faction: 1 }],                                                          // sig1
    ['JOIN', 1, { wallet: bytes(W.B), faction: 2 }],                                                          // sig2
    ['JOIN', 1, { wallet: bytes(W.C), faction: 1 }],                                                          // sig3
    ['JOIN', 1, { wallet: bytes(W.D), faction: 3 }],                                                          // sig4
    ['CARAVAN_SENT', 5, { owner_tag: W.B, seq: 0, faction: 2, dst: V, cargo: cargo([0, 20, 20]) }],            // sig5
    ['CARAVAN_SETTLED', 8, { owner_tag: W.B, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 20, 20]) }],         // sig6
    ['CARAVAN_SENT', 9, { owner_tag: W.C, seq: 0, faction: 1, dst: V, cargo: cargo([0, 20, 20]) }],            // sig7
    ['CARAVAN_SETTLED', 12, { owner_tag: W.C, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 20, 20]) }],        // sig8
    ['CARAVAN_SENT', 13, { owner_tag: W.D, seq: 0, faction: 3, dst: V, cargo: cargo([0, 0, 20]) }],            // sig9
    ['CARAVAN_SETTLED', 16, { owner_tag: W.D, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 0, 20]) }],         // sig10
    ['CARAVAN_SENT', 17, { owner_tag: W.A, seq: 0, faction: 1, dst: V, cargo: cargo([0, 20, 20]) }],           // sig11
    ['CARAVAN_SETTLED', 18, { owner_tag: W.A, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 20, 20]) }],        // sig12
  ];
}
const rows = () => decodeRows(heraldRows(world()));
const need = { wood: 20, stone: 20 };
const del = (responder, counted, ...sigs) => ({ responder, counted, arrivals: sigs.map(s => ({ caravanKey: `P/7:${W[responder]}:0`, signature: s })) });
const req = (id, requester, deliverers, n = need) => ({ id, ctx: { programId: 'P', seasonId: '7' }, goalId: 'crossing-storehouse-v1', requester, need: n, lower: {}, deliverers });
const F = (...requests) => ({ v: 1, kind: 'ws01-fulfilled', requests });
const run = (fulfilled, extra = {}) => evaluateLive({ rows: rows(), tagOf, nowBell: 30, fulfilled, ...extra });
const helpers = o => o.entries.filter(e => e.goal === 'P-board-helper');

test('the deliverer of another nation earns 「依頼に応えた」 (EN + JA); the requester does not', () => {
  const o = run(F(req('r1', 'A', [del('B', { wood: 20, stone: 20 }, 'sig6')])));
  const t = helpers(o);
  assert.deepEqual(t.map(e => [e.subject.id, e.subject.nation, e.at, e.audience]), [['tag:82', 'n2', 8, 'subject']], 'B (tag 0x52), dated the arrival\'s turn, shown to B only');
  assert.deepEqual(t[0].title, { ja: '依頼に応えた', en: 'Answered a request' });
  assert.match(t[0].reason.ja, /ほかの国の人の協力の依頼/);
  assert.match(t[0].reason.en, /another nation/);
  assert.ok(t[0].evidence.includes('ws01-fulfilled:r1'));
  assert.ok(!o.entries.some(e => e.subject.id === 'tag:65'), 'nothing for A (tag 0x41), who only asked');
  assert.deepEqual(o.effects, { ...NO_EFFECT });
  assert.equal(o.ruleset.version, 4);
});

test('no title for accepting without delivering, or for a delivery that counted nothing', () => {
  // ①'s export lists only deliverers with a counted arrival; a stray zero is dropped here too
  assert.equal(helpers(run(F(req('r1', 'A', [del('B', { wood: 20, stone: 20 }, 'sig6'), del('D', { wood: 0 }, 'sig10')])))).map(e => e.subject.id).join(), 'tag:82');
  assert.equal(helpers(run(F(req('r1', 'A', [])))).length, 0);
  assert.equal(helpers(run(null)).length, 0, 'no board proof at all: nothing');
});

test('a partial request gives nothing: the counted lower bounds must add up to the requested amount', () => {
  const o = run(F(req('r1', 'A', [del('B', { wood: 20, stone: 19 }, 'sig6')])));
  assert.equal(helpers(o).length, 0);
  assert.equal(o.notes.fulfilledHeld, 1);
  // a resource that was not requested does not make up for one that was
  assert.equal(helpers(run(F(req('r1', 'A', [del('B', { wood: 20, food: 99 }, 'sig6')])))).length, 0);
});

test('two deliverers of two other nations who together reached the amount both earn it', () => {
  const o = run(F(req('r1', 'A', [del('B', { wood: 20 }, 'sig6'), del('D', { stone: 20 }, 'sig10')])));
  assert.deepEqual(helpers(o).map(e => [e.subject.id, e.at]).sort(), [['tag:82', 16], ['tag:99', 16]], 'dated the latest counted arrival');
});

test('farming: one\'s own request, and a request of one\'s own nation (a puppet next door), give nothing', () => {
  // A delivers to their own request (①'s board refuses the answer; the evaluator refuses it again)
  assert.equal(helpers(run(F(req('r1', 'A', [del('A', { wood: 20, stone: 20 }, 'sig12')])))).length, 0);
  // C is of A's nation
  const o = run(F(req('r1', 'A', [del('C', { wood: 20, stone: 20 }, 'sig8')])));
  assert.equal(helpers(o).length, 0);
  // the reason is kept in the verdict (same_nation)
  const { input } = liveInput({ rows: rows(), tagOf, nowBell: 30, fulfilled: F(req('r1', 'A', [del('C', { wood: 20, stone: 20 }, 'sig8')])) });
  const v = evaluate(RULESETS.B, input);
  const c = v.achievements.personal.find(x => x.goal === 'P-board-helper' && x.subject === 'tag:19');
  assert.equal(c.status, 'not_achieved');
  assert.equal(c.reasons[0].code, 'same_nation');
  const s = evaluate(RULESETS.B, liveInput({ rows: rows(), tagOf, nowBell: 30, fulfilled: F(req('r1', 'A', [del('A', { wood: 20, stone: 20 }, 'sig12')])) }).input)
    .achievements.personal.find(x => x.goal === 'P-board-helper' && x.subject === 'tag:65');
  assert.equal(s.reasons[0].code, 'self_request');
});

// (owner-answers-logic, owner 2026-11-26 10:52 answer 9 / Q-TG2-2) "reached" counts EVERY counted delivery, the
// requester's own nation's included: A (nation 1) asks 20 wood, C (nation 1, A's own) delivers 15, B (nation 2) 5 →
// the request reached its amount and B earns the title for its 5; C, of A's nation, earns nothing itself.
test('Q-TG2-2: same-nation deliveries count toward "reached": A asks 20, C (A\'s nation) 15, B (another) 5 → B gets the title', () => {
  const ask = F(req('r1', 'A', [del('C', { wood: 15 }, 'sig8'), del('B', { wood: 5 }, 'sig6')], { wood: 20 }));
  const t = helpers(run(ask));
  assert.deepEqual(t.map(e => [e.subject.id, e.subject.nation, e.at]), [['tag:82', 'n2', 12]], 'B only, dated the latest counted arrival (C\'s, turn 12)');
  assert.equal(run(ask).notes.fulfilledHeld, 0, 'the request is not held as short');
  const v = evaluate(RULESETS.B, liveInput({ rows: rows(), tagOf, nowBell: 30, fulfilled: ask }).input);
  assert.equal(v.achievements.personal.find(x => x.goal === 'P-board-helper' && x.subject === 'tag:19').reasons[0].code, 'same_nation', 'C: nothing for its own nation\'s request');
  // without C's 15 the request is short: B's 5 alone earns nothing
  const short = F(req('r1', 'A', [del('B', { wood: 5 }, 'sig6')], { wood: 20 }));
  assert.equal(helpers(run(short)).length, 0);
  assert.equal(run(short).notes.fulfilledHeld, 1);
});

test('a requester with no nation on record: undecided, never a title', () => {
  const o = run(F(req('r1', 'E', [del('B', { wood: 20, stone: 20 }, 'sig6')])));
  assert.equal(helpers(o).length, 0);
  assert.equal(o.undecided, 1);
});

test('an arrival the herald rows do not show yet waits; once it shows, the title comes, dated that turn', () => {
  const f = F(req('r1', 'A', [del('B', { wood: 20, stone: 20 }, 'sig6')]));
  const early = evaluateLive({ rows: rows().slice(0, 5), tagOf, nowBell: 30, fulfilled: f });
  assert.equal(helpers(early).length, 0);
  assert.equal(early.notes.fulfilledHeld, 1);
  assert.equal(helpers(run(f))[0].at, 8);
  assert.equal(helpers(run(F(req('r1', 'A', [del('B', { wood: 20, stone: 20 }, 'sig-unknown')])))).length, 0, 'a signature not in the records');
});

test('one title per player per window, however many requests they answered', () => {
  const o = run(F(req('r1', 'A', [del('B', { wood: 20, stone: 20 }, 'sig6')]), req('r2', 'A', [del('B', { wood: 10, stone: 10 }, 'sig6')], { wood: 10, stone: 10 })));
  assert.equal(helpers(o).length, 1);
});

test('deterministic: the same records and proof give the same answer, in any order of the proof', () => {
  const a = F(req('r1', 'A', [del('B', { wood: 20 }, 'sig6'), del('D', { stone: 20 }, 'sig10')]), req('r2', 'C', [del('D', { wood: 20, stone: 20 }, 'sig10')]));
  const b = F(...[...a.requests].reverse().map(q => ({ ...q, deliverers: [...q.deliverers].reverse() })));
  assert.equal(run(a).verdictHash, run(b).verdictHash);
  assert.equal(run(a).outcomesHash, run(b).outcomesHash);
});

test('versioning: B is version 4 with a new hash; A and C keep version 3 and their hashes; C does not read ①', () => {
  assert.equal(RULESETS.B.version, 4);
  assert.equal(RULESETS.B.status, 'production-titles-only');
  assert.equal(hashOf(RULESETS.B), '463e248750be17366358f55aec192d629f08ed7b58205e179cac2e78b577579a');
  // version 3 (d3bd326d…) is what every verdict before 2026-11-22 names
  assert.notEqual(hashOf(RULESETS.B), 'd3bd326d15ddd1fe5e508b2ea25f1fc7f2f5eeac36d04e67fe9065686b7a42ae');
  assert.equal(RULESETS.A.version, 3);
  assert.equal(RULESETS.C.version, 3);
  assert.equal(hashOf(RULESETS.A), '44dcced761a664fbbc5351dc4f6cdb14c44a467d39eb9c72e71e6bf0c01cb533');
  assert.equal(hashOf(RULESETS.C), 'cb659477d8fe746c89902ba3cb60d866fcac7762e8e0ab28211f37d3aa1b4683', 'C is frozen');
  const { input } = liveInput({ rows: rows(), tagOf, nowBell: 30, fulfilled: F(req('r1', 'A', [del('B', { wood: 20, stone: 20 }, 'sig6')])) });
  const c = evaluate(RULESETS.C, input).achievements.personal.filter(x => x.goal === 'P-board-helper');
  assert.deepEqual(c.map(x => x.status), ['not_offered'], 'C\'s P-board-helper reads ⑭ only (none here)');
  assert.deepEqual(evaluate(RULESETS.B, input).awards.filter(x => x.goal === 'P-board-helper').map(x => x.beneficiary), ['tag:82']);
});

test('the title reads as the page\'s words and is for its holder only', () => {
  assert.equal(AUDIENCE['P-board-helper'], 'subject');
  for (const k of ['ja', 'en']) assert.doesNotMatch(`${TITLES['P-board-helper'].title[k]} ${TITLES['P-board-helper'].reason[k]}`, /bell|鐘|tower|塔|lower_bound|ws01/i);
});

test('the proof is re-checked: a malformed or foreign proof is ignored', () => {
  const ev = (f, r = rows()) => fulfilledEvents(f, { rows: r, actorOfWallet: w => (tagOf(w) ? `tag:${tagOf(w)}` : null) });
  assert.deepEqual(ev({ v: 2, kind: 'ws01-fulfilled', requests: [] }).events, []);
  assert.deepEqual(ev({ v: 1, kind: 'other', requests: [] }).events, []);
  assert.deepEqual(ev(F(req('r1', 'nobody', [del('B', { wood: 20, stone: 20 }, 'sig6')]))).held.map(h => h.why), ['request or requester unknown']);
  assert.equal(ev(F(req('r1', 'A', [del('B', { wood: 20, stone: 20 }, 'sig6')]))).events[0].verified, 'derived');
});

// (fix-loop9, loop-play9 LP9-8: the request title's English reason read "You earned the title … Why: Delivered goods by
//  their own caravan" — a person's title is shown to that person, so its English reason names no person)
test('a person\'s titles (P-…) give English reasons that name no person; the texts are not part of the ruleset hash', () => {
  for (const [k, t] of Object.entries(TITLES).filter(([k]) => k.startsWith('P-'))) assert.doesNotMatch(t.reason.en, /\b(their|they|them)\b/i, `${k}: ${t.reason.en}`);
  assert.match(TITLES['P-board-helper'].reason.en, /^Sent the caravan that delivered goods to a co-op request from someone of another nation/);
  assert.equal(hashOf(RULESETS.B), '463e248750be17366358f55aec192d629f08ed7b58205e179cac2e78b577579a');
});
