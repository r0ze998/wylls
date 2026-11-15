// The boundary draft and the clock (web/frontier/fexpedition-compose.mjs). The draft is bound to its host, owner,
// wallet, session, connection, season rules and the clock's SETTINGS; what the clock has been observed to say (the
// turn, the last slot and its time, the measured rate) only makes what was observed and reviewed old. An ordinary
// poll must not throw the player's steps away; nothing old may reach a signature. No keys, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { OUTBOUND_POP, openOutbound, editOutbound, reconcileOutbound, inspectOutboundRoute, inspectOutboundContext, outboundArrivalCandidate,
  useEarliestOutboundArrival, outboundClockSeen, readOutboundMap } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import * as DP from '../../permutation-server/web/frontier/fexpedition-depart-prepare.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const A = seasonAddresses(PROGRAM, '1'), PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const OWNER = A.of('Citizen', { wallet: WALLET }), HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));
const codeOf = fn => { try { fn(); return null; } catch (e) { return e.code ?? String(e); } };
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** A page as an ordinary poll leaves it: a turn, a last observed slot and time, a measured rate; the card open on a reviewed draft of two steps. */
function world() {
  const h = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 128, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1, SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 18436, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP }, nowBell: 42,
    clock: { genesisTs: 0 }, chain: { now: () => 1000, rate: 1, accelerated: false, declared: null, last: { slot: 500, unix: 1000 } },
    provinces: new Map([['128,0', { province }]]), view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: '/gw', source: {} };
  openOutbound(fs, ctx);
  for (const [action, value] of [['step', '0'], ['step', '0'], ['arriveBell', '44'], ['stance', '2'], ['retreat', 'custom'], ['ratio', '0.5'], ['tip', 'decisive']]) assert.equal(editOutbound(fs, ctx, action, value), true, `${action} ${value}`);
  assert.equal(fs.expeditionCompose.status, 'review', fs.expeditionCompose.error ?? '');
  return { fs, ctx, h, province };
}
const FIELDS = s => ({ directions: [...s.directions], arriveBell: s.arriveBell, stance: s.stance, retreat: s.retreat, ratio: s.ratio, tip: s.tip });
/** The ways an ordinary poll moves the clock forward. */
const FORWARD = [['the next slot', w => { w.fs.chain.last = { slot: 501, unix: 1000 }; }], ['a later time', w => { w.fs.chain.last = { slot: 500, unix: 1001.5 }; }],
  ['slot and time', w => { w.fs.chain.last = { slot: 520, unix: 1008 }; }], ['the next turn', w => { w.fs.nowBell = 43; }], ['another measured rate', w => { w.fs.chain.rate = 1.02; }],
  ['a first observation', w => { w.fs.chain.last = { slot: 501, unix: 1001 }; }]];
const route = w => ({ context: () => w.ctx, load: async () => ({ lands: [], captures: [], unavailable: [], snapshot: null }), evaluate: () => ({ ok: true, code: null, min: 44, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null }) });
const context = (w, hold = null) => ({ context: () => w.ctx,
  snapshot: async source => { if (hold) await new Promise(r => { hold.release = r; }); return { status: 'read', source, lands: [], season: w.fs.season, holdingBytes: null, clock: { unixTimestamp: 1000n }, contextSlot: '500', digest: 'ab'.repeat(32), coherent: true, contentConsistent: true }; },
  judge: () => ({ ok: true, code: null }), evaluate: () => ({ ok: true, code: null, min: 44, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null }) });

test('an ordinary poll keeps the draft: steps, arrival, stance, retreat, ratio and tip stay; the observations go and the review is worked out again', async () => {
  for (const [name, move] of FORWARD) {
    const w = world(), s = w.fs.expeditionCompose, fields = FIELDS(s), review = s.review, source = s.source;
    await inspectOutboundRoute(w.fs, route(w)); assert.equal(s.routeCheck?.status, 'read');
    await inspectOutboundContext(w.fs, context(w)); assert.equal(s.contextCheck?.status, 'read');
    assert.equal(outboundArrivalCandidate(w.fs).from, 'context');
    const seen = outboundClockSeen(w.fs), last = w.fs.chain.last, bell = w.fs.nowBell;
    move(w);
    assert.notEqual(outboundClockSeen(w.fs), seen, name);
    assert.equal(reconcileOutbound(w.fs, w.ctx), true, `${name}: the draft stands`);
    assert.equal(w.fs.expeditionCompose, s, 'the same draft object'); assert.deepEqual(FIELDS(s), fields, `${name}: every entered field is kept`);
    assert.equal(s.error, null); assert.equal(s.status, 'review'); assert.ok(s.map, 'the map of the steps is there');
    assert.equal(s.routeCheck, null, `${name}: the route read is dropped`); assert.equal(s.contextCheck, null, `${name}: the departure-conditions read is dropped`);
    assert.notEqual(s.review, review, `${name}: the review is another one`); assert.equal(s.review.plainHex, review.plainHex, 'of the same steps and fields');
    assert.equal(JSON.stringify(s.source), JSON.stringify(source), 'from the same source');
    assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable', `${name}: nothing observed is left to offer`);
    assert.equal(codeOf(() => DP.departPreparationRequest(w.fs, { sealed: { commit: '01'.repeat(32), seal: 'a7'.repeat(264) } })), 'DepartObservationUnavailable', `${name}: nothing can be prepared for signing without a new read`);
    // the page's own clock was not written to make the two equal
    assert.notEqual(w.fs.chain.last === last && w.fs.nowBell === bell && name !== 'another measured rate', true);
    // the card's other reads see the same standing draft; an edit goes on from it
    assert.ok(readOutboundMap(w.fs, w.ctx)); assert.equal(editOutbound(w.fs, w.ctx, 'step', '0'), true); assert.equal(s.directions.length, 3);
    // a new read under the new clock is usable again
    await inspectOutboundContext(w.fs, context(w)); assert.equal(outboundArrivalCandidate(w.fs).from, 'context');
  }
});

test('a clock that goes backward, or is no longer known, is not this draft\'s clock: the draft is dropped', () => {
  for (const [name, move] of [['an earlier turn', w => { w.fs.nowBell = 41; }], ['an earlier slot', w => { w.fs.chain.last = { slot: 499, unix: 1000 }; }], ['an earlier time', w => { w.fs.chain.last = { slot: 500, unix: 999 }; }],
    ['a later slot at an earlier time', w => { w.fs.chain.last = { slot: 600, unix: 900 }; }], ['no observation any more', w => { w.fs.chain.last = null; }], ['no turn any more', w => { w.fs.nowBell = null; }],
    ['a slot that is not a number', w => { w.fs.chain.last = { slot: 'abc', unix: 1000 }; }]]) {
    const w = world(); move(w);
    assert.equal(reconcileOutbound(w.fs, w.ctx), false, name);
    assert.equal(w.fs.expeditionCompose.error, 'SourceChanged', name); assert.deepEqual(w.fs.expeditionCompose.directions, [], name); assert.equal(w.fs.expeditionCompose.review, null);
  }
});

test('the wallet, the session, the host, the owner, the transit slots, the connection and the clock\'s settings still drop the draft, with or without a tick beside them', () => {
  const other = encode(new Uint8Array(32).fill(66));
  const hard = [['another wallet object', w => { w.fs.wallet = { address: WALLET }; }], ['a session', w => { w.fs.session = { publicKey: new Uint8Array(32) }; }], ['another host in hand', w => { w.fs.hand = { ...w.fs.hand, host: '1' }; }],
    ['another relay', w => { w.ctx = { ...w.ctx, relay: '/other' }; }], ['another herald', w => { w.ctx = { ...w.ctx, source: {} }; }], ['another chain object', w => { w.fs.chain = { ...w.fs.chain }; }],
    ['another owner', w => { w.fs.holdings[0].ownerCitizen = fromB58(other); }], ['a transit slot taken', w => { w.fs.holdings[0].transit[0].state = 1; }], ['the host gone from the province', w => { w.province.entries.length = 0; }],
    ['an accelerated clock', w => { w.fs.chain.accelerated = true; }], ['a declared time', w => { w.fs.chain.declared = 5; }], ['another season schedule', w => { w.fs.clock = { genesisTs: 7 }; }],
    ['another reveal window', w => { w.fs.season.revealWindow = Number(w.fs.season.revealWindow ?? 0) + 1; }], ['a resident played', w => { w.fs.resident = { asset: 'x' }; }]];
  for (const withTick of [false, true]) for (const [name, change] of hard) {
    const w = world(); change(w); if (withTick) { w.fs.nowBell++; if (w.fs.chain.last) w.fs.chain.last = { slot: w.fs.chain.last.slot + 1, unix: w.fs.chain.last.unix + 1 }; }
    assert.equal(reconcileOutbound(w.fs, w.ctx), false, `${name}${withTick ? ' with a tick' : ''}`);
    assert.equal(w.fs.expeditionCompose.error, 'SourceChanged'); assert.deepEqual(w.fs.expeditionCompose.directions, []);
  }
});

test('a read that finishes after the clock has moved is not kept: the route read, the departure-conditions read, the earliest-arrival press', async () => {
  // the route read
  let w = world(), s = w.fs.expeditionCompose, release;
  const slow = { ...route(w), load: () => new Promise(r => { release = () => r({ lands: [], captures: [], unavailable: [], snapshot: null }); }) };
  let reading = inspectOutboundRoute(w.fs, slow); await tick(); assert.equal(s.routeCheck?.status, 'loading');
  w.fs.chain.last = { slot: 501, unix: 1001 }; release(); await reading;
  assert.notEqual(s.routeCheck?.status, 'read', 'the old route read is not kept'); assert.equal(s.directions.length, 2, 'the steps are');
  assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable');
  // the departure-conditions read
  w = world(); s = w.fs.expeditionCompose; const hold = {};
  reading = inspectOutboundContext(w.fs, context(w, hold)); await tick(); assert.equal(s.contextCheck?.status, 'loading');
  w.fs.nowBell = 43; hold.release(); await reading;
  assert.notEqual(s.contextCheck?.status, 'read', 'the old conditions read is not kept'); assert.equal(s.arriveBell, '44');
  assert.equal(codeOf(() => DP.departPreparationRequest(w.fs, { sealed: { commit: '01'.repeat(32), seal: 'a7'.repeat(264) } })), 'DepartObservationUnavailable');
  // an observation object that somebody kept and puts back is told by its clock
  w = world(); s = w.fs.expeditionCompose;
  await inspectOutboundContext(w.fs, context(w)); const kept = s.contextCheck; assert.equal(outboundArrivalCandidate(w.fs).from, 'context');
  w.fs.chain.last = { slot: 501, unix: 1001 }; assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateStale', 'before any reconcile: bound to the clock it was read under');
  assert.equal(reconcileOutbound(w.fs, w.ctx), true); s.contextCheck = kept;
  assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateStale', 'put back after the tick: still not this clock\'s');
  // the earliest-arrival press, with the clock moving while its reread is under way
  w = world(); s = w.fs.expeditionCompose; editOutbound(w.fs, w.ctx, 'arriveBell', '60');
  await inspectOutboundContext(w.fs, { ...context(w), evaluate: () => ({ ok: false, code: 'ArrivalTooLate', min: 44, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null }) });
  const hold2 = {}, press = useEarliestOutboundArrival(w.fs, context(w, hold2)); await tick();
  assert.equal(s.arriveBell, '44', 'the turn is entered at once');
  w.fs.chain.last = { slot: 502, unix: 1002 }; hold2.release();
  const out = await press;
  assert.equal(out.ok, false); assert.equal(out.code, 'ArrivalRereadSuperseded'); assert.equal(out.entered, true, 'the field keeps the turn');
  assert.notEqual(s.contextCheck?.status, 'read'); assert.equal(s.arriveBell, '44'); assert.equal(s.directions.length, 2);
});

test('a preparation under way when the clock moves keeps nothing; one already shown is dropped by the next look', async () => {
  const sealed = { commit: '01'.repeat(32), seal: 'a7'.repeat(264) };
  const blocked = request => ({ ...JSON.parse(readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-heap256k-rust.json', import.meta.url), 'utf8')), status: 'blocked', request, source: null, blockhash: null, prepared: null, blocker: { code: 'TransitSlotBusy' } });
  // while the relay is asked
  let w = world(), release, asked = 0;
  const options = held => ({ ...context(w), sealed, requestId: 'run-1', read: async request => { asked++; if (held) await new Promise(r => { release = r; }); return blocked(request); } });
  const run = DP.prepareOutboundDeparture(w.fs, options(true)); await tick(40);
  assert.equal(asked, 1); w.fs.chain.last = { slot: 501, unix: 1001 }; release();
  assert.equal(await run, null, 'the run is not this draft\'s any more'); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle');
  assert.equal(w.fs.expeditionCompose.directions.length, 2, 'the steps stand');
  // a finished preparation, then a tick
  w = world();
  const state = await DP.prepareOutboundDeparture(w.fs, options(false));
  assert.equal(state.status, 'blocked'); assert.equal(DP.departPreparationOf(w.fs, w.ctx), state);
  w.fs.nowBell = 43;
  assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle', 'a result prepared under the earlier clock is not shown'); assert.equal(w.fs.expeditionCompose.directions.length, 2);
});

test('a value that is not a clock reading is refused before anything is compared, also when it has not changed; not yet observed is a reading', () => {
  const bad = [['a rate that is not a number', w => { w.fs.chain.rate = NaN; }], ['an endless rate', w => { w.fs.chain.rate = Infinity; }], ['a rate of nought', w => { w.fs.chain.rate = 0; }], ['a negative rate', w => { w.fs.chain.rate = -1; }], ['a rate as text', w => { w.fs.chain.rate = '1'; }],
    ['half a slot', w => { w.fs.chain.last = { slot: 500.5, unix: 1000 }; }], ['a negative slot', w => { w.fs.chain.last = { slot: -1, unix: 1000 }; }], ['a slot past the safe integers', w => { w.fs.chain.last = { slot: 2 ** 60, unix: 1000 }; }],
    ['a slot with a leading nought', w => { w.fs.chain.last = { slot: '0501', unix: 1000 }; }], ['a slot of garbage', w => { w.fs.chain.last = { slot: 'abc', unix: 1000 }; }], ['a slot past u64', w => { w.fs.chain.last = { slot: '18446744073709551616', unix: 1000 }; }],
    ['no slot beside a time', w => { w.fs.chain.last = { unix: 1000 }; }], ['no time beside a slot', w => { w.fs.chain.last = { slot: 501 }; }], ['a time that is not a number', w => { w.fs.chain.last = { slot: 501, unix: NaN }; }],
    ['a negative time', w => { w.fs.chain.last = { slot: 501, unix: -5 }; }], ['a time as text', w => { w.fs.chain.last = { slot: 501, unix: '1001' }; }], ['a last that is not a record', w => { w.fs.chain.last = 7; }],
    ['half a turn', w => { w.fs.nowBell = 42.5; }], ['a negative turn', w => { w.fs.nowBell = -1; }], ['a turn past u32', w => { w.fs.nowBell = 2 ** 32; }], ['a turn as text', w => { w.fs.nowBell = '43'; }]];
  for (const [name, change] of bad) {
    // on a standing draft: dropped, whatever direction the value would have read as
    const w = world(); change(w);
    assert.equal(codeOf(() => outboundClockSeen(w.fs)), 'OutboundClockInvalid', name);
    assert.equal(reconcileOutbound(w.fs, w.ctx), false, name); assert.equal(w.fs.expeditionCompose.error, 'SourceChanged'); assert.deepEqual(w.fs.expeditionCompose.directions, [], name);
    // and a card opened under it never reaches a review; looking again changes nothing (the same bad value is not "unchanged")
    openOutbound(w.fs, w.ctx);
    assert.equal(w.fs.expeditionCompose.error, 'OutboundClockInvalid', name); assert.equal(w.fs.expeditionCompose.review, null); assert.equal(w.fs.expeditionCompose.source, null);
    assert.equal(editOutbound(w.fs, w.ctx, 'step', '0'), false, `${name}: no step is taken on it`);
    assert.equal(w.fs.expeditionCompose.review, null); assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable');
  }
  // accepted readings: whole slots as number, BigInt or canonical text; a time with a fraction or as BigInt; turn 0; nothing observed yet
  for (const [name, set] of [['a BigInt slot and time', w => { w.fs.chain.last = { slot: 501n, unix: 1001n }; }], ['a text slot', w => { w.fs.chain.last = { slot: '501', unix: 1000.25 }; }], ['slot 0 at time 0', w => { w.fs.chain.last = { slot: 0, unix: 0 }; w.fs.nowBell = 0; }],
    ['nothing observed yet', w => { w.fs.chain.last = undefined; w.fs.chain.rate = undefined; w.fs.nowBell = undefined; }]]) {
    const w = world(); set(w); openOutbound(w.fs, w.ctx); editOutbound(w.fs, w.ctx, 'step', '0');
    assert.notEqual(w.fs.expeditionCompose.error, 'OutboundClockInvalid', name); assert.ok(w.fs.expeditionCompose.source, name);
    assert.equal(typeof outboundClockSeen(w.fs), 'string');
  }
  // the first observation after "nothing observed yet" is forward; the same slot written another way is the same reading
  const w = world(); w.fs.chain.last = undefined; w.fs.chain.rate = undefined; openOutbound(w.fs, w.ctx);
  for (const [a, v] of [['step', '0'], ['step', '0'], ['arriveBell', '44']]) editOutbound(w.fs, w.ctx, a, v);
  const review = w.fs.expeditionCompose.review; assert.ok(review);
  w.fs.chain.last = { slot: 700, unix: 2000 }; assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.notEqual(w.fs.expeditionCompose.review, review); assert.equal(w.fs.expeditionCompose.directions.length, 2);
  const again = w.fs.expeditionCompose.review;
  w.fs.chain.last = { slot: '700', unix: 2000 }; assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.equal(w.fs.expeditionCompose.review, again, 'the same reading in another notation moves nothing');
  w.fs.chain.last = { slot: 700n, unix: 2000n }; assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.equal(w.fs.expeditionCompose.review, again);
});

test('the page\'s own poll (every 30 s: a new last slot and time on the same chain object): within a turn the draft stands and its readiness lapses; across a turn the earliest arrival is worked out again', async () => {
  /** What app.mjs does on a poll: `FS.chain.observe` writes a later `last` on the same chain object; the turn follows the clock. */
  const poll = (w, { slots = 75, secs = 30, bell = null } = {}) => { w.fs.chain.last = { slot: w.fs.chain.last.slot + slots, unix: w.fs.chain.last.unix + secs }; if (bell !== null) w.fs.nowBell = bell; };
  const w = world(), s = w.fs.expeditionCompose, fields = FIELDS(s);
  const sealed = { commit: '01'.repeat(32), seal: 'a7'.repeat(264) };
  // observed and ready within turn 42
  await inspectOutboundContext(w.fs, context(w));
  assert.equal(s.contextCheck.ready.ok, true); assert.equal(codeOf(() => DP.departPreparationRequest(w.fs, { sealed })), null, 'ready: a request can be built');
  // three polls inside the same turn: the same draft each time, never ready without a new read
  for (let i = 0; i < 3; i++) {
    poll(w);
    assert.equal(w.fs.nowBell, 42, 'the same turn');
    assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.equal(w.fs.expeditionCompose, s); assert.deepEqual(FIELDS(s), fields, `poll ${i + 1}: the draft stands`);
    assert.equal(s.contextCheck, null, `poll ${i + 1}: the readiness has lapsed`); assert.equal(s.error, null); assert.equal(s.status, 'review');
    assert.equal(codeOf(() => DP.departPreparationRequest(w.fs, { sealed })), 'DepartObservationUnavailable');
    await inspectOutboundContext(w.fs, context(w)); assert.equal(codeOf(() => DP.departPreparationRequest(w.fs, { sealed })), null, 'read again under this clock: ready again');
  }
  // the turn turns over (42 → 43): the fields stay; the earliest arrival is another one, read under the new turn
  const laterRange = { ...context(w), evaluate: a => ({ ok: a.arriveBell >= 45 && a.arriveBell <= 48, code: a.arriveBell === null ? 'ArrivalRequired' : a.arriveBell < 45 ? 'ArrivalTooEarly' : a.arriveBell > 48 ? 'ArrivalTooLate' : null, min: 45, max: 48, travelSecs: 120, wearBps: 0, stepIndex: null }) };
  assert.equal(outboundArrivalCandidate(w.fs).arriveBell, '44', 'turn 42\'s earliest');
  poll(w, { bell: 43 });
  assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.deepEqual(FIELDS(s), fields, 'across the turn: every field is kept, the entered arrival too');
  assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable', 'turn 42\'s earliest is not offered in turn 43');
  await inspectOutboundContext(w.fs, laterRange);
  assert.equal(s.contextCheck.report.code, 'ArrivalTooEarly', 'the entered turn 44 is judged again, under turn 43');
  assert.equal(outboundArrivalCandidate(w.fs).arriveBell, '45', 'the earliest arrival is worked out again');
  const out = await useEarliestOutboundArrival(w.fs, laterRange);
  assert.deepEqual(out, { ok: true, state: 'entered-and-reread', arriveBell: '45', from: 'context' }); assert.equal(s.arriveBell, '45'); assert.deepEqual(s.directions, fields.directions);
  // an observation is of ITS clock only: not of an earlier one, not of a later one
  const kept = s.contextCheck, at = { last: { ...w.fs.chain.last }, bell: w.fs.nowBell };
  poll(w); assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateStale', 'the page is ahead of the observation');
  w.fs.chain.last = { ...at.last }; w.fs.nowBell = at.bell; assert.equal(outboundArrivalCandidate(w.fs).arriveBell, '45', '(the test puts the clock back to show the binding: the same reading, the same observation)');
  // and the clock put back BEHIND a reading the draft has reconciled under is not its clock: the draft is dropped
  poll(w); assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.equal(s.contextCheck, null);
  w.fs.chain.last = { ...at.last }; s.contextCheck = kept;
  assert.equal(reconcileOutbound(w.fs, w.ctx), false, 'backward: fail closed'); assert.equal(w.fs.expeditionCompose.error, 'SourceChanged'); assert.deepEqual(w.fs.expeditionCompose.directions, []);
  // a poll together with a change of owner, host, transit or wallet is that change: dropped, never kept as "only a poll"
  const other = encode(new Uint8Array(32).fill(66));
  for (const [name, change] of [['the owner', v => { v.fs.holdings[0].ownerCitizen = fromB58(other); }], ['the host in hand', v => { v.fs.hand = { ...v.fs.hand, host: '1' }; }], ['a transit slot', v => { v.fs.holdings[0].transit[0].state = 1; }],
    ['the wallet', v => { v.fs.wallet = { address: WALLET }; }], ['the host\'s troops', v => { v.province.entries[0].troops++; }]]) {
    const v = world(); await inspectOutboundContext(v.fs, context(v)); poll(v); change(v);
    assert.equal(reconcileOutbound(v.fs, v.ctx), false, `${name} with a poll`); assert.equal(v.fs.expeditionCompose.error, 'SourceChanged'); assert.deepEqual(v.fs.expeditionCompose.directions, []);
    assert.equal(codeOf(() => DP.departPreparationRequest(v.fs, { sealed })), 'DepartDraftUnavailable');
  }
});
