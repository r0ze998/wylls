// The S1 adapter on real record bytes: PS2 bodies laid out from the ABI's
// generated log table, decoded by the page's own decoder (flog.mjs
// `decodePage`), then adapted and judged. No chain is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGS } from '../../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { decodePage } from '../../../permutation-server/web/frontier/flog.mjs';
import { fromS1Records, placeOf } from '../src/adapters/s1-chain.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { baseState } from '../scenarios/world.mjs';

const spec = Object.fromEntries(LOGS.kinds.map(k => [k.name, k]));
/** One PS2 body (`version ‖ kind ‖ bell u32 ‖ key ‖ payload`, no tail) as base64. */
function body(name, bell, fields) {
  const k = spec[name];
  const parts = [1, k.kind, ...le(bell, 4)];
  for (const { name: f, len } of [...k.key, ...k.payload]) {
    const v = fields[f] ?? 0;
    parts.push(...(v instanceof Uint8Array ? [...v] : le(v, len)));
  }
  return Buffer.from(parts).toString('base64');
}
function le(v, n) {
  let x = BigInt(v);
  if (x < 0n) x += 1n << BigInt(8 * n);
  return Array.from({ length: n }, () => { const b = Number(x & 0xffn); x >>= 8n; return b; });
}
const cargo = a => { const b = new Uint8Array(32); const dv = new DataView(b.buffer); a.forEach((q, i) => dv.setUint32(4 * i, q, true)); return b; };
/** A logged place as its u64 value: storehouse kind 2 at (p, q) tile `t`. */
const place = (kind, p, q, t) => BigInt.asUintN(64, BigInt(kind) | (BigInt(p & 0xffff) << 8n) | (BigInt(q & 0xffff) << 24n) | (BigInt(t) << 56n));

const TAGS = { 11: 'n1-0', 21: 'n2-0', 31: 'n3-0', 12: 'n1-1', 22: 'n2-1' };
const FORT = place(2, 3, -2, 7);
const resolve = {
  actorOfTag: t => TAGS[Number(t)] ?? null,
  destination: pl => (pl.p === 3 && pl.q === -2 ? { actor: 'n1-0', project: 'P-north', kind: 'village' } : null),
  projectOfStructure: (p, q) => (p === 3 && q === -2 ? 'P-north' : null),
};

function page() {
  const recs = [
    ['CARAVAN_SENT', 30, { owner_tag: 21, seq: 1, faction: 2, src: 0, dst: FORT, steps: 3, cargo: cargo([0, 0, 300, 0, 0, 50, 0, 0]) }],
    ['CARAVAN_SENT', 40, { owner_tag: 31, seq: 1, faction: 3, src: 0, dst: FORT, steps: 4, cargo: cargo([0, 200, 200, 0, 20, 50, 0, 0]) }],
    ['CARAVAN_SETTLED', 40, { owner_tag: 21, seq: 1, outcome: 0, dst: FORT, cargo: cargo([0, 0, 300, 0, 0, 50, 0, 0]) }],
    ['VAULT_BUILT', 45, { p: 3, q: -2, tile: 9, owner_tag: 11, faction: 1 }],
    ['CARAVAN_SETTLED', 55, { owner_tag: 31, seq: 1, outcome: 0, dst: FORT, cargo: cargo([0, 200, 200, 0, 20, 50, 0, 0]) }],
    ['STRUCTURE_BUILT', 100, { p: 3, q: -2, tile: 7, owner_tag: 11, faction: 1, kind: 3 }],
    ['FORT_GARRISONED', 110, { p: 3, q: -2, tile: 7, owner_tag: 12, troops: 200 }],
    ['FORT_GARRISONED', 120, { p: 3, q: -2, tile: 7, owner_tag: 22, troops: 150 }],
  ];
  return decodePage(recs.map(([n, bell, f], i) => ({ seq: i, slot: 1000 + i, sig: `sig${i}`, body_b64: body(n, bell, f) }))).records;
}

test('logged places decode (kind, signed p and q, tile)', () => {
  assert.deepEqual(placeOf(FORT), { kind: 2, p: 3, q: -2, site: 0, gen: 0, tile: 7 });
});

test('records → events: one ship per resource, arrivals to a village as lower bounds, unmapped kinds hold their position', () => {
  const { events, skipped, unresolved } = fromS1Records(page(), resolve);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(skipped.map(s => s.name), ['VAULT_BUILT']);
  const sends = events.filter(e => e.kind === 'ship.send');
  assert.deepEqual(sends.map(e => `${e.from}:${e.resource}:${e.qty}`), ['n2-0:stone:300', 'n2-0:gold:50', 'n3-0:wood:200', 'n3-0:stone:200', 'n3-0:arms:20', 'n3-0:gold:50']);
  assert.ok(events.filter(e => e.kind === 'ship.arrive').every(e => e.verified === 'chain_lower_bound'));
  assert.deepEqual([...new Set(events.map(e => e.seq))], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('end to end: the adapted page plus ①\'s board inputs judge the joint fort', () => {
  const { events } = fromS1Records(page(), resolve);
  const board = [
    { id: 'ws01:0', stream: 'ws01', seq: 0, at: 20, kind: 'project.open', verified: 'chain', project: 'P-north', goal: 'J-north-fort', structure: 'fort', steward: 'n1-0' },
    ...['wood:300', 'stone:300', 'arms:30', 'gold:100'].map((x, i) => { const [r, q] = x.split(':'); return { id: `ws01:${i + 1}`, stream: 'ws01', seq: i + 1, at: 25, kind: 'contribute', verified: 'chain', project: 'P-north', actor: 'n1-0', lot: `init:n1-0:${r}`, qty: Number(q) }; }),
  ];
  const v = evaluate(RULESETS.B, { state: baseState(), events: [...board, ...events] });
  const j = v.achievements.joint[0];
  assert.equal(j.status, 'achieved');
  assert.equal(j.achievedAt, 120);
  assert.deepEqual(j.projects[0].stages.diversity.qualifying, ['n1', 'n2', 'n3']);
  assert.equal(j.projects[0].stages.inputs.perResource.stone.lowerBound, 500);
  // Drop one record of the page: the evaluator sees the gap and does not decide.
  const gap = evaluate(RULESETS.B, { state: baseState(), events: [...board, ...events.filter(e => e.seq !== 4)] });
  assert.equal(gap.achievements.joint[0].status, 'indeterminate');
});
