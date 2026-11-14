// A MUSTER THAT IS ACCEPTED BUT STILL PENDING vs AN ARMY THAT IS FORMED — on the page, and for departure.
//
// After a page-signed Muster the program writes a state-2 entry (pending: it stands from a later turn, once the
// world has resolved that turn). Only a state-1 entry is a formed army on the roster. This file fixes, across every
// place the page decides it, that:
//   - a pending entry is SHOWN as pending (forming, then "waiting for the world to process this formation"), never as
//     ready, and nothing lets it depart: the hosts card's depart button, the resident-action check, the march check;
//   - the same host, once formed (state 1, rested, enough stamina), is shown ready and CAN depart;
//   - the local march relay takes ANY host of this village — a host mustered later has a higher sequence number than
//     the fixture's — and refuses another village's.
// Local play and an ordinary session decide the same (only the "catch up" button differs; tested elsewhere).
// PURE: no key, no process, no network. Runs under the no-key guard.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction, actionBlocks } from '../../permutation-server/web/frontier/fland.mjs';
import { checkMarch } from '../../permutation-server/web/frontier/fmarch.mjs';
import { render as hostsScreen, hostRows, hostState } from '../../permutation-server/web/frontier/screens/host.mjs';
import { waitOf } from '../../permutation-server/web/frontier/hud/keephand.mjs';
import { localMarchIntent } from '../src/frontier/local-play-march.mjs';

afterEach(() => setLang('ja'));
// (the fixtures of web-frontier-conquest-hand.test.mjs: a final home village at (2, 0) site 2, one entry of its own)
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const ID = hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 });
const entry = (extra = {}) => ({ id: ID, unit: 0, state: 1, tile: 20, troops: 100000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, ...extra });
// (the march check reads the season's fee fields: a round set of them, as web-frontier-conquest-hand.test.mjs does)
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 },
  minRevealPriorityMilli: 1000, revealCuLimit: 200000, revealLoadedLimit: 64000, marchFee: 0n, sealBond: 0n };
const LOCAL = Object.freeze({ address: 'W', programId: 'P', seasonAddress: 'S', cluster: 'localnet' });
const fs = ({ bell = 10, resolvedNext = bell, e = entry(), extra = {} } = {}) => ({ mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: [HOME()], nowBell: bell, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext, entries: [e], ticketCohorts: [] } }]]), ...extra });
const row = s => hostRows(s)[0];
const card = s => String(hostsScreen(s));
const departButton = markup => (markup.match(/<button type="button" class="btn primary small" data-act="compose"[^>]*>/) ?? [''])[0];
const marchCheck = s => { const r = row(s), h = s.holdings[0]; return checkMarch({ season: s.season, nowBell: s.nowBell, resolvedNext: r.province.resolvedNext, province: r.province, now: 1000, holding: h, host: r.entry }); };
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;   // (web-frontier-cards.test.mjs)
const CJK = /[぀-ヿ㐀-鿿]/;
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

// the three moments of one host: just mustered (stands from turn 12), its turn has come but the world has not
// processed it yet, and formed (state 1)
const PENDING = { bell: 10, e: entry({ state: 2, fromBell: 12 }) };
const WAITING = { bell: 12, resolvedNext: 11, e: entry({ state: 2, fromBell: 12 }) };
const FORMED = { bell: 12, e: entry({ state: 1, fromBell: 12, readyBell: 12, staminaBell: 12 }) };

test('PENDING (state 2, its turn not come): shown as forming, with the turn it stands from; it cannot depart anywhere', () => {
  const s = fs(PENDING), r = row(s);
  assert.equal(r.state, 2);
  assert.deepEqual(waitOf(s, r), { why: 'forming', turn: 12 });
  assert.equal(hostState(r, s.nowBell).id, 'forming');
  assert.ok(actionBlocks('Depart', { holding: s.holdings[0], province: r.province, now: 1000, nowBell: s.nowBell, host: r }).includes('HostBusy'));
  assert.ok(marchCheck(s).includes('HostBusy'), 'the march check refuses it');
  assert.match(departButton(card(s)), / disabled/, 'the depart button is off');
});

test('ITS TURN HAS COME, NOT PROCESSED YET (still state 2): shown as waiting for the world, still not departable', () => {
  const s = fs(WAITING), r = row(s);
  assert.equal(waitOf(s, r).why, 'settling');
  assert.equal(hostState(r, s.nowBell).id, 'forming', 'still "awaiting formation", never "ready"');
  assert.ok(marchCheck(s).includes('HostBusy'));
  assert.match(departButton(card(s)), / disabled/);
});

test('FORMED (state 1, rested, enough stamina): shown ready; nothing blocks departure', () => {
  const s = fs(FORMED), r = row(s);
  assert.equal(r.state, 1);
  assert.equal(waitOf(s, r), null, 'no wait');
  assert.equal(hostState(r, s.nowBell).id, 'ready');
  assert.deepEqual(actionBlocks('Depart', { holding: s.holdings[0], province: r.province, now: 1000, nowBell: s.nowBell, host: r }), []);
  assert.ok(!marchCheck(s).includes('HostBusy') && !marchCheck(s).includes('Cooldown'), 'the march check has nothing against the host');
  assert.doesNotMatch(departButton(card(s)), / disabled/, 'the depart button is on');
  assert.notEqual(departButton(card(s)), '');
});

test('the card tells the two apart in words (English, the glossary\'s words only): pending says it waits for the world; formed says ready', () => {
  setLang('en');
  const pending = plain(card(fs(PENDING))), waiting = plain(card(fs(WAITING))), formed = plain(card(fs(FORMED)));
  assert.match(pending, /Estimated formation wait|Waiting for the world to process this formation\./);
  assert.match(waiting, /Waiting for the world to process this formation\./);
  assert.doesNotMatch(formed, /formation wait|Waiting for the world to process this formation/);
  assert.notEqual(plain(hostState(row(fs(PENDING)), 10).text), plain(hostState(row(fs(FORMED)), 12).text));
  for (const t of [pending, waiting, formed]) { assert.doesNotMatch(t, BANNED_EN); assert.doesNotMatch(t, CJK, 'no untranslated text on the card'); }
});

test('LOCAL PLAY decides the same as an ordinary session, at each moment (only the "catch up" button may differ)', () => {
  for (const m of [PENDING, WAITING, FORMED]) {
    const ordinary = fs(m), local = fs({ ...m, extra: { localPlay: LOCAL } });
    assert.deepEqual(waitOf(local, row(local))?.why ?? null, waitOf(ordinary, row(ordinary))?.why ?? null);
    assert.equal(hostState(row(local), local.nowBell).id, hostState(row(ordinary), ordinary.nowBell).id);
    assert.deepEqual(marchCheck(local), marchCheck(ordinary));
    assert.equal(departButton(card(local)), departButton(card(ordinary)));
  }
});

test('THE LOCAL MARCH RELAY takes any host of this village — a host mustered later (higher sequence) included — and refuses another village\'s', () => {
  const home = { p: 2, q: 0, site: 11 };
  const body = id => ({ name: 'Depart', subject: { holding: { ...home }, province: { p: 2, q: 0 } },
    fields: { host_id: id.toString(), commit: 'cd'.repeat(32), seal: '80' + 'ab'.repeat(164), arrive_bell: 12, tip: '1000', transit_slot: 0 } });
  for (const seq of [0, 1, 2, 7, 255, 65535]) assert.equal(localMarchIntent(body(hostId({ ...home, gen: 2, seq }))).fields.host_id, hostId({ ...home, gen: 2, seq }).toString(), `seq ${seq}`);
  for (const other of [{ ...home, site: 10 }, { p: 2, q: 1, site: 11 }, { p: 3, q: 0, site: 11 }])
    assert.throws(() => localMarchIntent(body(hostId({ ...other, gen: 2, seq: 1 }))), e => e.code === 'LocalMarchNotYourHost', JSON.stringify(other));
});
