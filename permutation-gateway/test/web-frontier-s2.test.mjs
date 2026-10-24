// The redesign's stage 2a (S2, program_version 5) on the web page:
//  - the Issue and Lot addresses and the ticket shapes are fclient's
//    (fixtures/s2-tickets-v1.json, written by fclient caravan_path_vectors.rs
//    s2_ticket_vectors), and the relay's profile 4 takes them;
//  - the herald's h/tickets.json read strictly, as herald/src/ticket.rs
//    writes it;
//  - an S2 season is told apart from an S1 one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S1 from '../../permutation-server/web/frontier/fs1.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { accountsFor, SIGNED_BY } from '../../permutation-server/web/frontier/fplay.mjs';
import { parseTickets, createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { frontierIx, shapeMessage, classify } from '../../permutation-server/web/sdk/frontier/shapes.mjs';
import { parseTransaction, wireTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { profileForHash, rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';

const V = JSON.parse(readFileSync(new URL('./fixtures/s2-tickets-v1.json', import.meta.url), 'utf8'));
const ME = 0x77n;

test('an S2 season is S1 with program_version 5 or later', () => {
  assert.equal(S1.s2Season({ layoutVersion: 2, programVersion: 5 }), true);
  assert.equal(S1.s2Season({ layoutVersion: 2, programVersion: 4 }), false);
  assert.equal(S1.s2Season({ layoutVersion: 1, programVersion: 5 }), false);
  S1.setS1({ layoutVersion: 2, programVersion: 5 });
  try { assert.equal(S1.s1On(), true); assert.equal(S1.s2On(), true); } finally { S1.setS1(null); }
  assert.equal(S1.s2On(), false);
  assert.equal(profileForHash(rulesetFor(4)), 4);
});

test('the Issue and Lot addresses are fclient\'s', () => {
  const A = seasonAddresses(V.program, V.seasonId);
  for (const x of V.issue) assert.equal(A.of('Issue', { tag: BigInt(x.tag), seq: x.seq }), x.address);
  for (const x of V.lot) assert.equal(A.of('Lot', { tag: BigInt(x.tag), seq: x.seq }), x.address);
});

test('the ticket shapes are fclient\'s instructions, and the relay\'s profile 4 takes them', () => {
  const A = seasonAddresses(V.program, V.seasonId);
  const h = { p: 3, q: -1, site: 4 };
  const vault = { kind: 'vault', p: 4, q: -2, tile: 17 };
  const shapes = [
    ['IssueTickets', { holding: h, source: vault, issuerTag: ME, seq: 0, lotSeq: 0 }, { kind: 2, resource: 3, amount: 10n, per_unit: 2000n, until_day: 0xffffffff }],
    ['IssueTickets', { holding: h, source: { kind: 'holding', ...h }, issuerTag: ME, seq: 1, lotSeq: 3 }, { kind: 3, resource: 0, amount: 4n, per_unit: 3n, until_day: 9 }],
    ['GiveLot', { lot: { tag: ME, seq: 0 }, issue: { tag: ME, seq: 0 }, source: vault, recipient: V.recipient, toLot: { tag: ME, seq: 4 } }, { amount: 4n }],
    ['GiveLot', { lot: { tag: ME, seq: 0 }, issue: { tag: ME, seq: 0 }, source: vault, recipient: V.recipient, toLot: { tag: ME, seq: 0 } }, { amount: 10n }],
    ['CloseLot', { issue: { tag: ME, seq: 0 }, source: vault, issueRentTo: V.rentTo, lot: { tag: ME, seq: 0 }, rentTo: V.rentTo }, { close_issue: 0 }],
    ['CloseLot', { issue: { tag: ME, seq: 0 }, source: vault, issueRentTo: V.rentTo }, { close_issue: 1 }],
  ];
  assert.equal(shapes.length, V.cases.length);
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  shapes.forEach(([name, v, fields], i) => {
    const want = V.cases[i];
    assert.equal(name, want.name);
    assert.ok(SIGNED_BY[name]);
    const accounts = accountsFor(name, { addresses: A, wallet: V.wallet, actor: V.actor, profile: 4, ...v });
    const ix = frontierIx(V.program, name, { ...accounts, payer: V.payer }, fields, 4);
    assert.deepEqual(ix.keys.map(k => [k.pubkey, k.isSigner, k.isWritable]), want.keys, `${name} #${i} keys`);
    assert.equal(hex(ix.data), want.data, `${name} #${i} data`);
    const msg = shapeMessage({ programId: V.program, name, accounts: { ...accounts, payer: V.payer }, fields, feePayer: V.payer, recentBlockhash: V.program, profile: 4 });
    const tx = parseTransaction(wireTransaction(msg));
    const c = classify(tx, { programId: V.program, profile: 4 });
    assert.equal(c.ok, true, `${name} #${i}: ${c.problem}`);
    assert.equal(c.kind, 'player');
  });
});

const TICKETS = {
  v: 1,
  issues: [{ issuerTag: '11', seq: 0, kind: 2, src: { kind: 2, p: 3, q: 0, at: 40, gen: 1, tile: 40 }, resource: 3, perUnit: 2000, untilDay: 4294967295, supply: 10, state: 1, void: false }],
  lots: [
    { key: ['11', 0], issuerTag: '11', issueSeq: 0, holderTag: '11', amount: 6, state: 1, void: false },
    { key: ['11', 1], issuerTag: '11', issueSeq: 0, holderTag: '18446744073709551615', amount: 4, state: 1, void: true },
  ],
};
const clone = o => JSON.parse(JSON.stringify(o));
const code = fn => { try { fn(); return null; } catch (e) { return e.code ?? e.message; } };

test('h/tickets.json is read strictly', () => {
  const t = parseTickets(JSON.stringify(TICKETS));
  assert.equal(t.issues[0].src.tile, 40);
  assert.deepEqual(t.lots[1].key, ['11', 1]);
  assert.equal(t.lots[1].holderTag, '18446744073709551615');
  assert.equal(t.lots[1].void, true);
  const bad = [
    o => { o.v = 2; },
    o => { o.issues[0].kind = 5; },
    o => { o.issues[0].src.kind = 3; },
    o => { o.issues[0].void = 0; },
    o => { o.lots[0].key = ['11']; },
    o => { o.lots[0].key[0] = '0x11'; },
    o => { o.lots[0].holderTag = '18446744073709551616'; },
    o => { delete o.lots; },
  ];
  for (const f of bad) { const o = clone(TICKETS); f(o); assert.ok(code(() => parseTickets(o)), String(f)); }
  assert.deepEqual(parseTickets({ v: 1, issues: [], lots: [] }), { v: 1, issues: [], lots: [] });
});

test('the herald client reads h/tickets.json', async () => {
  const seen = [];
  const h = createHerald({ base: 'http://h', seasonId: 7, fetch: async url => { seen.push(url); return new Response(JSON.stringify(TICKETS), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const r = await h.tickets();
  assert.equal(r.ok, true);
  assert.equal(r.tickets.lots.length, 2);
  assert.match(seen[0], /\/h\/tickets\.json$/);
});
