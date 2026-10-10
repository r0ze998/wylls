// The achievements ledger (src/frontier/achievements.mjs) over a scripted
// chain: a capture is taken from the CONQUEST record of its transaction and
// the donor host's owner from the Holding and Citizen accounts; a
// reinforcement from the final Province account; every line re-derives from
// what it cites, and a tampered line does not. Scoring (PROVISIONAL
// weights) cannot be inflated by splitting hosts or by repeated captures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { concat, toBase64, u32le, u64le } from '../client/src/bytes.mjs';
import { FrontierAddresses, hostId } from '../client/src/frontier/addresses.mjs';
import { encodeAccount } from '../client/src/frontier/codec.mjs';
import { conquestEvents, Deriver, KEEP_SITE, KEEP_TAKEN, KINDS, recordsOf, scoreLines } from '../src/frontier/achievements.mjs';

const PROGRAM = Keypair.generate().publicKey.toBase58();
const SEASON_ID = 5n;
const A = new FrontierAddresses({ programId: PROGRAM, seasonId: SEASON_ID });
const params = JSON.parse(readFileSync(new URL('../src/frontier/prize-params.json', import.meta.url), 'utf8'));
const i32 = v => u32le(v < 0 ? v + 2 ** 32 : v);
const log = body => `Program data: UFMy ${toBase64(body)}`;

/** A CONQUEST record body (kind 82) of `(p, q)` at `bell` with `events` and the donor host. */
function conquest({ p, q, bell, events, donor = 0n, holder = 0, troops = 0 }) {
  const ev = new Uint8Array(56);
  events.forEach((e, i) => ev.set([e.site, e.code, e.faction, e.progress], 4 * i));
  return concat([1, 82], u32le(bell), i32(p), i32(q), u32le(bell), [events.length], ev, new Uint8Array(32), [holder, 255, 0], u32le(troops), u64le(donor), [0], new Uint8Array(14), [0]);
}
/** A TRANSIT_SETTLED record body (kind 34) of `host`. */
const settled = ({ host, bell, outcome, troops }) => concat([1, 34], u32le(bell), u64le(host), [outcome, 0], u32le(troops), new Uint8Array(8 * 8 + 64), [0]);

function world() {
  const accounts = new Map(), txs = new Map(), history = new Map(), keeps = new Map();
  const io = { account: async a => accounts.get(a) ?? null, transaction: async s => txs.get(s) ?? null, signatures: async a => history.get(a) ?? [], keep: async (p, q) => keeps.get(`${p},${q}`) ?? null };
  const member = (p, q, site, faction) => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const citizen = A.citizen(wallet);
    accounts.set(citizen, encodeAccount('Citizen', { SEASON_ID, WALLET: new PublicKey(wallet).toBytes(), FACTION: faction }, { profile: 2 }));
    accounts.set(A.holding(p, q, site), encodeAccount('Holding', { SEASON_ID, P: p, Q: q, SITE: site, GEN: 0, OWNER_CITIZEN: new PublicKey(citizen).toBytes() }, { profile: 2 }));
    return { wallet, citizen, faction, host: seq => hostId(p, q, site, 0, seq), holding: A.holding(p, q, site) };
  };
  const province = (p, q, { holder, since = 0, tile = 10, entries = [] }) => {
    const data = encodeAccount('Province', { SEASON_ID, P: p, Q: q, N_ENTRIES: entries.length,
      KEEP: [{ TILE: tile, HOLDER: holder, CONTENDER: 255, TROOPS: 500, SINCE_BELL: since }],
      ENTRIES: [{}, ...entries.map(e => ({ ID: e.id, FACTION: e.faction, TILE: e.tile ?? tile, STATE: e.state ?? 1, TROOPS: e.milli }))] }, { profile: 2 });
    accounts.set(A.province(p, q), data);
  };
  return { io, accounts, txs, history, keeps, member, province, deriver: () => new Deriver({ io, addresses: A, profile: 2 }) };
}
const read = async (w, p, q) => {
  const { decodeAccount } = await import('../client/src/frontier/codec.mjs');
  return { address: A.province(p, q), province: decodeAccount('Province', w.accounts.get(A.province(p, q)), { seasonId: SEASON_ID, profile: 2 }) };
};

test('PS2 records are read from a transaction\'s log lines; a CONQUEST record yields its events', () => {
  const body = conquest({ p: 4, q: -1, bell: 228, events: [{ site: 3, code: 1, faction: 2, progress: 0 }, { site: KEEP_SITE, code: KEEP_TAKEN, faction: 0, progress: 5 }], donor: 77n, holder: 0, troops: 496 });
  const rs = recordsOf(['Program x invoke [1]', log(body), 'Program data: AAAA', 'Program data: UFMy !!!']);
  assert.equal(rs.length, 1);
  assert.deepEqual([rs[0].name, rs[0].p, rs[0].q, rs[0].bell, rs[0].donor_host_id, rs[0].keep_troops], ['CONQUEST', 4, -1, 228, 77n, 496]);
  assert.deepEqual(conquestEvents(rs[0])[1], { site: KEEP_SITE, code: KEEP_TAKEN, faction: 0, progress: 5 });
  assert.deepEqual(Object.entries(KINDS).map(([k, v]) => [k, v.derivable]), [['capture', true], ['reinforcement', true], ['defence', false], ['resourceSupply', false]]);
  for (const k of ['defence', 'resourceSupply']) assert.ok(KINDS[k].reason && KINDS[k].missingRecord);
});

test('capture: the last capture of a keep still held, the donor host\'s owner, the transaction; reinforcement: the hosts standing on the keep at the end', async () => {
  const w = world();
  const attacker = w.member(3, 0, 2, 0), supporter = w.member(3, 0, 8, 0), early = w.member(3, -1, 4, 0), enemy = w.member(4, -2, 1, 5);
  // (4,-1) was taken twice by nation 0 (first by `early`, lost, then by `attacker`); only the last counts.
  w.txs.set('sigOld', { err: null, logs: [log(conquest({ p: 4, q: -1, bell: 100, events: [{ site: KEEP_SITE, code: KEEP_TAKEN, faction: 0, progress: 5 }], donor: early.host(0), holder: 0 }))] });
  w.txs.set('sigCap', { err: null, logs: [log(conquest({ p: 4, q: -1, bell: 228, events: [{ site: KEEP_SITE, code: KEEP_TAKEN, faction: 0, progress: 5 }], donor: attacker.host(0), holder: 0, troops: 496 }))] });
  w.keeps.set('4,-1', { captures: [{ bell: 100, from: 5, to: 0, donor: String(early.host(0)), sig: 'sigOld' }, { bell: 228, from: 5, to: 0, donor: String(attacker.host(0)), sig: 'sigCap' }] });
  w.txs.set('sigArr', { err: null, logs: [log(settled({ host: supporter.host(0), bell: 161, outcome: 1, troops: 394_395 }))] });
  w.history.set(supporter.holding, ['sigLater', 'sigArr']);
  w.txs.set('sigLater', { err: null, logs: [] });
  w.province(4, -1, { holder: 0, since: 229, entries: [
    { id: supporter.host(0), faction: 0, milli: 394_395 },                 // stands on the keep: counted
    { id: supporter.host(1), faction: 0, milli: 200_000, tile: 11 },       // another tile: not on the keep
    { id: enemy.host(0), faction: 5, milli: 900_000 },                     // another nation's host
    { id: attacker.host(3), faction: 0, milli: 600_000, state: 2 }] });    // not in the roster
  const d = w.deriver();
  const lines = await d.lines([await read(w, 4, -1)]);
  assert.deepEqual(lines.map(l => [l.kind, l.wallet, l.quantity, l.unit, l.bell, l.signatures]), [
    ['capture', attacker.wallet, 1, 'province', 228, ['sigCap']],
    ['reinforcement', supporter.wallet, 394, 'troops', 161, ['sigArr']]]);
  assert.deepEqual([lines[0].citizen, lines[0].host, lines[0].nation, lines[0].detail.takenFrom], [attacker.citizen, String(attacker.host(0)), 0, 5]);
  for (const l of lines) assert.deepEqual(await d.verifyLine(l), { ok: true, problems: [] });
  // A line that names another player, another transaction or more troops does not re-derive.
  assert.equal((await d.verifyLine({ ...lines[0], wallet: supporter.wallet, citizen: supporter.citizen })).ok, false);
  assert.match((await d.verifyLine({ ...lines[0], signatures: ['sigOld'] })).problems.join(), /donor host/);
  assert.match((await d.verifyLine({ ...lines[1], quantity: 4000 })).problems.join(), /394 troops/);
  assert.match((await d.verifyLine({ ...lines[1], signatures: ['sigLater'] })).problems.join(), /did not settle/);
  // The keep falls to nation 5 afterwards: nothing of nation 0's stands.
  w.province(4, -1, { holder: 5, since: 300, entries: [{ id: supporter.host(0), faction: 0, milli: 394_395 }] });
  const d2 = w.deriver();
  assert.deepEqual(await d2.lines([await read(w, 4, -1)]), []);
  assert.equal((await d2.verifyLine(lines[0])).ok, false);
  // A herald file naming a capture the chain's transaction does not carry earns nothing.
  w.province(4, 0, { holder: 0 });
  w.keeps.set('4,0', { captures: [{ bell: 228, from: 5, to: 0, donor: String(attacker.host(0)), sig: 'sigCap' }] });
  assert.deepEqual(await w.deriver().lines([await read(w, 4, 0)]), []);
});

test('PROVISIONAL scoring: points only for paid members of a winning nation; splitting hosts cannot pass the cap; the fallbacks', () => {
  const line = (kind, wallet, nation, quantity, extra = {}) => ({ kind, wallet, nation, province: { p: 4, q: -1 }, quantity, unit: kind === 'capture' ? 'province' : 'troops', bell: 1, host: '1',
    detail: { supplierNation: nation, ownerNation: nation }, signatures: ['s'], ...extra });
  const paid = new Set(['A', 'S', 'X']);
  const members = [{ wallet: 'A', nation: 0 }, { wallet: 'S', nation: 0 }, { wallet: 'X', nation: 5 }, { wallet: 'AI', nation: 0 }];
  const r = scoreLines([line('capture', 'A', 0, 1), line('reinforcement', 'S', 0, 394), line('capture', 'X', 5, 1), line('capture', 'AI', 0, 1, { province: { p: 3, q: 1 } })], { params, winners: [0], paid, members });
  assert.deepEqual([...r.points], [['A', { nation: 0, points: 10 }], ['S', { nation: 0, points: 3 }]]);
  assert.deepEqual(r.lines.map(l => [l.wallet, l.eligible, l.points]), [['A', true, 10], ['S', true, 3], ['X', false, 0], ['AI', false, 0]]);
  assert.equal(r.mode, 'shares');
  // 5,000 troops in one host or in fifty hosts of 100: the same capped points for the province.
  const one = scoreLines([line('reinforcement', 'S', 0, 5000)], { params, winners: [0], paid, members });
  const many = scoreLines(Array.from({ length: 50 }, (_, i) => line('reinforcement', 'S', 0, 100, { host: String(i) })), { params, winners: [0], paid, members });
  assert.deepEqual([one.points.get('S').points, many.points.get('S').points], [10, 10]);
  // No points at all: the winners' paid members share equally; no paid member: a refund.
  const equal = scoreLines([], { params, winners: [0], paid, members });
  assert.deepEqual([equal.mode, [...equal.points.keys()]], ['equal', ['A', 'S']]);
  assert.equal(scoreLines([], { params, winners: [3], paid, members }).mode, 'refund');
  assert.equal(params.provisional, true);
  assert.ok(params.provisionalRules.length >= 4 && params.decided.winner.includes('most provinces'));
});
