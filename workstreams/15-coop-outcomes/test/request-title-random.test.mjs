// test-gaps-2 (2026-11-26; tests only, no behaviour changed): ⑮ 「依頼に応えた」 (P-board-helper, ruleset B v4) over
// random ① proofs. verify-pr152 checked the rule live and with an offline judge it did not commit (judge-offline.mjs);
// request-title.test.mjs pins chosen cases. Here 600 random proofs over the same recorded world are judged against the
// rule's safety side, read from the owner's decision (2026-11-22 11:56, Q1-⑮; ⑮ = B: titles and chronicle only):
//   1. never a title to the requester, to anyone of the requester's nation, or for a requester with no nation;
//   2. never for a request whose counted deliveries (all deliverers together) fall short of the requested amount in
//      any resource;
//   3. never to a deliverer whose own delivery counted nothing, or whose arrival the herald rows do not show;
//   4. at most one P-board-helper per player;
//   5. no win, score or prize effect, ever (effects = NO_EFFECT);
//   6. the same answer in any order of the proof (requests and deliverers).
// Only the safety side is pinned: whether a delivery of the requester's own nation counts toward the amount for
// another deliverer is not stated by the decision, so it is not assumed here (see the test-gaps-2 report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLive, NO_EFFECT } from '../src/live.mjs';
import { heraldRows, decodeRows, cargo, place } from './ps2.mjs';

const W = { A: 0x41, B: 0x52, C: 0x13, D: 0x63, E: 0x77 };
const NATION = { A: 1, B: 2, C: 1, D: 3, E: null };
const bytes = b => new Uint8Array(32).fill(b);
const tagOf = w => {
  if (typeof w === 'string') return W[w] !== undefined ? String(W[w]) : null;
  if (w instanceof Uint8Array && w.length === 32 && w.every(x => x === w[0])) return Object.values(W).includes(w[0]) ? String(w[0]) : null;
  return null;
};
const V = place(1, -1, 2, 5, 0);
// request-title.test.mjs's world: A, B, C, D joined (E never); B, C, D and A each delivered one caravan (sig6, 8, 10, 12)
const ROWS = decodeRows(heraldRows([
  ['JOIN', 1, { wallet: bytes(W.A), faction: 1 }], ['JOIN', 1, { wallet: bytes(W.B), faction: 2 }],
  ['JOIN', 1, { wallet: bytes(W.C), faction: 1 }], ['JOIN', 1, { wallet: bytes(W.D), faction: 3 }],
  ['CARAVAN_SENT', 5, { owner_tag: W.B, seq: 0, faction: 2, dst: V, cargo: cargo([0, 20, 20]) }],
  ['CARAVAN_SETTLED', 8, { owner_tag: W.B, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 20, 20]) }],
  ['CARAVAN_SENT', 9, { owner_tag: W.C, seq: 0, faction: 1, dst: V, cargo: cargo([0, 20, 20]) }],
  ['CARAVAN_SETTLED', 12, { owner_tag: W.C, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 20, 20]) }],
  ['CARAVAN_SENT', 13, { owner_tag: W.D, seq: 0, faction: 3, dst: V, cargo: cargo([0, 0, 20]) }],
  ['CARAVAN_SETTLED', 16, { owner_tag: W.D, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 0, 20]) }],
  ['CARAVAN_SENT', 17, { owner_tag: W.A, seq: 0, faction: 1, dst: V, cargo: cargo([0, 20, 20]) }],
  ['CARAVAN_SETTLED', 18, { owner_tag: W.A, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 20, 20]) }],
]));
const SIG = { A: 'sig12', B: 'sig6', C: 'sig8', D: 'sig10', E: 'sig-none' };
const SEEN = new Set(['sig6', 'sig8', 'sig10', 'sig12']);
const who = id => Object.keys(W).find(k => `tag:${W[k]}` === id);

function rng(seed) {
  let s = BigInt(seed);
  return n => { s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number((s >> 33n) % BigInt(n)); };
}
const RES = ['wood', 'stone'];
function proof(r) {
  const requests = [];
  for (let i = 0, n = 1 + r(3); i < n; i++) {
    const requester = 'ABCDE'[r(5)];
    const need = Object.fromEntries(RES.filter(() => r(3) !== 0).map(x => [x, 5 + r(20)]));
    if (!Object.keys(need).length) need.wood = 10;
    const deliverers = [];
    for (const p of 'ABCDE') {
      if (r(2)) continue;
      const counted = Object.fromEntries(RES.filter(() => r(2)).map(x => [x, r(4) === 0 ? 0 : 1 + r(25)]));
      const sig = r(8) === 0 ? 'sig-unknown' : SIG[p];
      deliverers.push({ responder: p, counted, arrivals: [{ caravanKey: `P/7:${W[p]}:0`, signature: sig }] });
    }
    requests.push({ id: `r${i}`, ctx: { programId: 'P', seasonId: '7' }, goalId: 'crossing-storehouse-v1', requester, need, lower: {}, deliverers });
  }
  return { v: 1, kind: 'ws01-fulfilled', requests };
}
const run = f => evaluateLive({ rows: ROWS, tagOf, nowBell: 30, fulfilled: f });

test('⑮ P-board-helper over 600 random ① proofs: never to the requester\'s side, never for a short request, one per player, no effect', () => {
  let titles = 0, withTitle = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed);
    const f = proof(r);
    const o = run(f);
    assert.deepEqual(o.effects, { ...NO_EFFECT }, `seed ${seed}: a title must have no effect`);
    const got = o.entries.filter(e => e.goal === 'P-board-helper');
    titles += got.length; if (got.length) withTitle++;
    assert.equal(new Set(got.map(e => e.subject.id)).size, got.length, `seed ${seed}: more than one title for one player`);
    for (const e of got) {
      const x = who(e.subject.id);
      assert.ok(x, `seed ${seed}: a title for an unknown subject ${e.subject.id}`);
      // some request it answered must justify it on every safety point
      const ok = f.requests.some(q => {
        const mine = q.deliverers.find(d => d.responder === x);
        if (!mine) return false;
        if (q.requester === x || NATION[q.requester] === null || NATION[q.requester] === NATION[x]) return false;
        if (!mine.arrivals.every(a => SEEN.has(a.signature))) return false;
        if (!Object.values(mine.counted).some(v => v > 0)) return false;
        const total = Object.fromEntries(Object.keys(q.need).map(k => [k, 0]));
        for (const d of q.deliverers) for (const [k, v] of Object.entries(d.counted)) if (k in total) total[k] += v;
        return Object.entries(q.need).every(([k, n]) => total[k] >= n);
      });
      assert.ok(ok, `seed ${seed}: ${x} got 「依頼に応えた」 without a request that justifies it: ${JSON.stringify(f.requests)}`);
      assert.equal(e.audience, 'subject', `seed ${seed}: a title is shown to its holder only`);
    }
    // 6. the same answer in any order of the proof
    const rev = { ...f, requests: [...f.requests].reverse().map(q => ({ ...q, deliverers: [...q.deliverers].reverse() })) };
    const o2 = run(rev);
    assert.equal(o2.verdictHash, o.verdictHash, `seed ${seed}: the order of the proof changed the verdict`);
    assert.equal(o2.outcomesHash, o.outcomesHash, `seed ${seed}: the order of the proof changed the outcomes`);
  }
  assert.ok(withTitle > 40 && titles > 40, `the random proofs must give titles too (${withTitle} proofs, ${titles} titles)`);
});
