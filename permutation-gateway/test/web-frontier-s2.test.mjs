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
import { seasonAddresses, depositSeq } from '../../permutation-server/web/frontier/faddr.mjs';
import { accountsFor, SIGNED_BY } from '../../permutation-server/web/frontier/fplay.mjs';
import { parseTickets, parseCaravans, createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { placeData } from '../../permutation-server/web/frontier/fplay.mjs';
import * as CAR from '../../permutation-server/web/frontier/fcaravan.mjs';
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
  // 2b: a holder's deposit lot.
  assert.equal(A.of('Lot', { tag: ME, seq: depositSeq(ME, 2) }), V.depositLot);
  assert.ok(depositSeq(ME, 2) >= 0x80000000);
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
    ['OpenShares', { holding: h, at: { p: 4, q: -2, tile: 17 }, issuerTag: ME, seq: 2 }, {}],
    ['WithdrawShares', { lot: { tag: ME, seq: depositSeq(ME, 2) }, issue: { tag: ME, seq: 2 }, vault: { p: 4, q: -2, tile: 17 },
      dst: { kind: 'holding', ...h, gen: 1 }, seq: 5, provinces: [{ p: 4, q: -2 }, { p: 3, q: -1 }] },
    { seq: 5, amount: 40n, ...placeData({ kind: 'holding', ...h, gen: 1 }), steps: 2, path: CAR.pack([3, 4]), fee: 50000n }],
    ['ClaimReceipt', { lot: { tag: ME, seq: 1 }, issue: { tag: ME, seq: 0 }, vault: { p: 4, q: -2, tile: 17 } }, {}],
    ['WithdrawReceipt', { lot: { tag: ME, seq: 1 }, issue: { tag: ME, seq: 0 }, vault: { p: 4, q: -2, tile: 17 },
      dst: { kind: 'holding', ...h, gen: 1 }, seq: 6, provinces: [{ p: 4, q: -2 }, { p: 3, q: -1 }] },
    { seq: 6, ...placeData({ kind: 'holding', ...h, gen: 1 }), steps: 2, path: CAR.pack([3, 4]), fee: 50000n }],
    ['UseRun', { lot: { tag: ME, seq: 3 }, issue: { tag: ME, seq: 1 }, workshop: h, vault: { p: 3, q: -1, tile: 20 } }, { runs: 2 }],
    ['OpenEscrow', { escrow: { tag: ME, seq: 4 }, taker: V.recipient, give: { kind: 'goods', vault: { p: 4, q: -2, tile: 17 } } },
      { deadline_bell: 500, taker_tag: BigInt(V.takerTag), give_kind: 1, give_resource: 3, give_p: 4, give_q: -2, give_tile: 17, give_amount: 50000n, give_lot_tag: 0n, give_lot_seq: 0,
        want_kind: 2, want_resource: 0, want_amount: 5n, want_lot_tag: 0x99n, want_lot_seq: 2 }],
    ['AcceptEscrow', { escrow: { tag: 0x99n, seq: 4 }, makerItem: { kind: 'lot', lot: { tag: 0x99n, seq: 2 } }, takerItem: { kind: 'goods', vault: { p: 4, q: -2, tile: 17 } } },
      { vault_p: 4, vault_q: -2, vault_tile: 17 }],
    ['CancelEscrow', { escrow: { tag: ME, seq: 4 }, rentTo: V.rentTo, srcs: [{ kind: 'lot', lot: { tag: ME, seq: 0 } }] }, {}],
    ['WithdrawEscrow', { escrow: { tag: 0x99n, seq: 4 }, vault: { p: 4, q: -2, tile: 17 }, dst: { kind: 'holding', ...h, gen: 1 }, seq: 7, rentTo: V.rentTo,
      provinces: [{ p: 4, q: -2 }, { p: 3, q: -1 }] },
    { side: 0, seq: 7, ...placeData({ kind: 'holding', ...h, gen: 1 }), steps: 2, path: CAR.pack([3, 4]), fee: 50000n }],
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
  assert.equal(t.lots[0].claim, null, 'a feed from before 2c');
  const withClaim = clone(TICKETS);
  withClaim.lots[0].claimDay = 4; withClaim.lots[0].claim = 20000;
  withClaim.issues[0].ratioPpm = 750000; withClaim.issues[0].ratioDay = 5;
  const tc = parseTickets(withClaim);
  assert.deepEqual([tc.lots[0].claimDay, tc.lots[0].claim, tc.issues[0].ratioPpm], [4, 20000, 750000]);
  withClaim.issues[0].ratioPpm = 1000001;
  assert.ok(code(() => parseTickets(withClaim)));
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

test('a vault\'s shares in h/caravans.json (2b)', () => {
  const file = { v: 1, moving: [], vaults: [
    { p: 3, q: 0, tile: 41, ownerTag: '9', faction: 1, gen: 2, shares: { issuerTag: '9', seq: 3 } },
    { p: 3, q: 0, tile: 40, ownerTag: '9', faction: 1, gen: 1 },
  ] };
  const c = parseCaravans(file);
  assert.deepEqual(c.vaults[0].shares, { issuerTag: '9', seq: 3 });
  assert.equal(c.vaults[1].shares, null, 'a feed from before S2');
  const bad = clone(file);
  bad.vaults[0].shares.issuerTag = 'x';
  assert.ok(code(() => parseCaravans(bad)));
});

test('the herald client reads h/tickets.json', async () => {
  const seen = [];
  const h = createHerald({ base: 'http://h', seasonId: 7, fetch: async url => { seen.push(url); return new Response(JSON.stringify(TICKETS), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const r = await h.tickets();
  assert.equal(r.ok, true);
  assert.equal(r.tickets.lots.length, 2);
  assert.match(seen[0], /\/h\/tickets\.json$/);
});

// ---------------------------------------------------------------- the shares on the play screens (screens/s1.mjs)

import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';

test('the shares model lists the viewer\'s live share lots with their vault; the tile offers to share the viewer\'s vault', () => {
  const me = new Uint8Array(32); me[0] = 9;
  const vault = { p: 3, q: 0, tile: 40, ownerTag: '9', faction: 1, gen: 1, shares: { issuerTag: '9', seq: 0 } };
  const issue = { issuerTag: '9', seq: 0, kind: 1, src: { kind: 2, p: 3, q: 0, at: 40, gen: 1, tile: 40 }, resource: 0, perUnit: 0, untilDay: 4294967295, supply: 250, state: 1, void: false };
  const lots = [
    { key: ['9', 2147483700], issuerTag: '9', issueSeq: 0, holderTag: '9', amount: 150, state: 1, void: false },
    { key: ['22', 2147483700], issuerTag: '9', issueSeq: 0, holderTag: '22', amount: 100, state: 1, void: false },
    { key: ['9', 0], issuerTag: '9', issueSeq: 1, holderTag: '9', amount: 5, state: 1, void: true },
  ];
  const store = { value: 1000000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n };
  const h = { p: 3, q: 0, site: 0, tile: 30, gen: 1, state: 2, tier: 1, faction: 1, ownerCitizen: me, stores: Array.from({ length: 8 }, () => store), reserve: [0, 0, 0, 0, 0, 0, 0, 0], queue: [] };
  const FS = { mode: 'play', nowBell: 100, chain: { now: () => 1000 }, holdings: [h], activeHolding: 0, s1: { caravans: { moving: [], vaults: [vault] }, tickets: { v: 1, issues: [issue], lots } } };
  const m = SCR.s2SharesModel(FS);
  assert.equal(m.lots.length, 1, 'the viewer\'s live share lots only');
  assert.deepEqual([m.lots[0].amount, m.lots[0].supply, m.lots[0].vault], [150, 250, { p: 3, q: 0, tile: 40 }]);
  assert.equal(SCR.vaultIssue(FS, vault).supply, 250);
  assert.equal(SCR.vaultIssue(FS, { ...vault, shares: null }), null);
  // the tile: a shared vault says so; the viewer's unshared vault is offered (S2 only)
  S1.setS1({ layoutVersion: 2, programVersion: 5 });
  try {
    const P = { p: 3, q: 0, layoutVersion: 2, passableMask: (1n << 61n) - 1n, roughMask: 0n, roadMask: 0n, siteCount: 0, sites: [], structures: [], forts: [], caravans: [] };
    const base = { ...FS, citizen: { faction: 1 }, provinces: new Map([['3,0', { province: P }]]) };
    assert.match(String(SCR.renderS1Tile(base, { p: 3, q: 0, idx: 40 })), /250/);
    const own = { ...base, s1: { ...base.s1, caravans: { moving: [], vaults: [{ ...vault, shares: null }] } } };
    assert.match(String(SCR.renderS1Tile(own, { p: 3, q: 0, idx: 40 })), /s2-open-shares/);
  } finally { S1.setS1(null); }
});

test('the receipts model: claim once a day, collect the next day (2c)', () => {
  const me = new Uint8Array(32); me[0] = 9;
  const issue = { issuerTag: '9', seq: 0, kind: 2, src: { kind: 2, p: 3, q: 0, at: 40, gen: 1, tile: 40 }, resource: 3, perUnit: 10000, untilDay: 4294967295, supply: 4, state: 1, void: false, ratioPpm: null, ratioDay: null };
  const lot = (claimDay, claim) => ({ key: ['9', 0], issuerTag: '9', issueSeq: 0, holderTag: '9', amount: 2, state: 1, void: false, claimDay, claim });
  const at = (l, bell) => SCR.s2ReceiptsModel({ nowBell: bell, holdings: [{ ownerCitizen: me }], s1: { tickets: { v: 1, issues: [issue], lots: [l] } } }).lots[0];
  assert.deepEqual([at(lot(null, null), 10).canClaim, at(lot(null, null), 10).canWithdraw], [true, false]);
  assert.deepEqual([at(lot(0, 20000), 10).canClaim, at(lot(0, 20000), 10).canWithdraw], [false, false], 'claimed today');
  // Yesterday's claim: collect it, or claim anew when its grant rounds to 0
  // (the program decides; the feed has no ratio before a withdrawal).
  assert.deepEqual([at(lot(0, 20000), 150).canClaim, at(lot(0, 20000), 150).canWithdraw], [true, true], 'collect, or claim');
  assert.deepEqual([at(lot(0, 0), 150).canClaim, at(lot(0, 20000), 300).canClaim], [true, true], 'collected, or lapsed');
  assert.equal(at(lot(null, null), 10).vault.tile, 40);
});

test('the uses model: runs left today, the vault in the workshop\'s province (2d)', () => {
  const me = new Uint8Array(32); me[0] = 9;
  const issue = { issuerTag: '7', seq: 1, kind: 3, src: { kind: 1, p: 3, q: 0, at: 4, gen: 1, tile: 12 }, resource: 0, perUnit: 2, untilDay: 4294967295, supply: 3, state: 1, void: false, ratioPpm: null, ratioDay: null };
  const lot = (runDay, runs) => ({ key: ['7', 2], issuerTag: '7', issueSeq: 1, holderTag: '9', amount: 3, state: 1, void: false, claimDay: null, claim: null, runDay, runs });
  const vault = { p: 3, q: 0, tile: 40, ownerTag: '9', faction: 0, gen: 1, shares: null };
  const at = (l, bell, vaults = [vault]) => SCR.s2UsesModel({ nowBell: bell, holdings: [{ ownerCitizen: me }], s1: { tickets: { v: 1, issues: [issue], lots: [l] }, caravans: { moving: [], vaults } } }).lots[0];
  assert.deepEqual([at(lot(null, null), 10).runsLeft, at(lot(null, null), 10).canRun], [6, true]);
  assert.deepEqual([at(lot(0, 6), 10).runsLeft, at(lot(0, 6), 10).canRun], [0, false], 'used up today');
  assert.equal(at(lot(0, 6), 150).runsLeft, 6, 'a new day');
  assert.deepEqual(at(lot(null, null), 10).vault, { p: 3, q: 0, tile: 40 });
  assert.equal(at(lot(null, null), 10, [{ ...vault, q: 1 }]).canRun, false, 'no vault in the province');
  assert.deepEqual(at(lot(null, null), 10).workshop, { p: 3, q: 0, site: 4 });
});

test('the escrows model: accept, cancel, collect (2e)', () => {
  const me = new Uint8Array(32); me[0] = 9;
  const src = { kind: 2, p: 3, q: 0, at: 40, gen: 1, tile: 40 };
  const esc = over => ({ makerTag: '7', seq: 1, takerTag: '9', deadlineBell: 100, state: 1, giveKind: 1, giveAmount: 50000, giveLot: ['0', 0],
    giveSrc: src, wantKind: 2, wantAmount: 5, wantLot: ['9', 2], rentTo: '11111111111111111111111111111111', giveResource: 3, wantResource: 0,
    takeSrc: null, owed: [false, false], ...over });
  const lot = { key: ['9', 2], issuerTag: '9', issueSeq: 0, holderTag: '9', amount: 5, state: 1, void: false };
  const at = (e, bell, lots = [lot]) => SCR.s2EscrowsModel({ nowBell: bell, holdings: [{ ownerCitizen: me }], s1: { tickets: { v: 1, issues: [], lots, escrows: [e] }, caravans: { moving: [], vaults: [] } } }).escrows[0];
  const open = at(esc({}), 10);
  assert.deepEqual([open.mineAs, open.canAccept, open.canCancel, open.collect], ['taker', true, false, null]);
  assert.deepEqual([at(esc({}), 101).canAccept, at(esc({}), 101).canCancel], [false, true], 'past the deadline');
  const owed = at(esc({ state: 2, owed: [true, false] }), 10);
  assert.deepEqual([owed.collect, owed.collectFrom, owed.canCancel], [0, { p: 3, q: 0, tile: 40 }, false]);
  // Its vault seized: nothing to collect, and a party may close it.
  const lost = at(esc({ state: 2, owed: [true, false], voidSides: [true, false] }), 10);
  assert.deepEqual([lost.collect, lost.canCancel], [null, true]);
  assert.equal(at(esc({ makerTag: '1', takerTag: '2' }), 10), undefined, 'not the viewer\'s');
  // The wanted lot must be the viewer's, with the units wanted.
  assert.equal(at(esc({}), 10, [{ ...lot, amount: 4 }]).canAccept, false, 'short of units');
  assert.equal(at(esc({}), 10, []).canAccept, false, 'not held');
  // Wanted goods need a vault of the viewer's.
  assert.equal(at(esc({ wantKind: 1, wantAmount: 10000 }), 10).canAccept, false);
});
