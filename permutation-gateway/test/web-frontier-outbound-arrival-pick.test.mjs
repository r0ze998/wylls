// The boundary route card's "use the earliest candidate" (fexpedition-compose.mjs outboundArrivalCandidate,
// useEarliestOutboundArrival; hud/hand.mjs outboundPop). Synthetic LOCAL UI states and injected route answers only:
// no boot, network, worker, key, seal, signature or send. The route's own reading and timing are not tested here
// (the injected `evaluate` stands for fexpedition-route.mjs): what is tested is which observation may fill the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { setLang, EN, EN_GROUPS, missingKeys } from '../../permutation-server/web/lang.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import * as CTRL from '../../permutation-server/web/frontier/controller.mjs';
import { OUTBOUND_POP, OUTBOUND_CLOSED, openOutbound, editOutbound, clearOutbound, inspectOutboundRoute, inspectOutboundContext,
  outboundArrivalCandidate, useEarliestOutboundArrival } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const A = seasonAddresses(PROGRAM, '1');
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const OWNER = A.of('Citizen', { wallet: WALLET });
const HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));

/** The fixture of web-frontier-expedition-compose.test.mjs: one owned resident host at ring 128, the card open. */
function world() {
  const h = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1,
    OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 128, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1,
    SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 16388, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff,
      HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP },
    nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: '/gw', source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0');
  assert.equal(fs.expeditionCompose.error, 'ArrivalRequired', 'a route out of ring 128 with no arrival turn entered');
  return { fs, ctx, h, province };
}
const report = over => ({ ok: false, code: 'ArrivalRequired', min: 44, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null, ...over });
/** The observation a route read leaves: with no turn entered the route is sound and only the turn is asked for. */
const sound = a => (a.arriveBell === null ? report() : report({ ok: a.arriveBell >= 44 && a.arriveBell <= 47, code: a.arriveBell < 44 ? 'ArrivalTooEarly' : a.arriveBell > 47 ? 'ArrivalTooLate' : null }));
function reader(w, answer = sound) {
  const asked = [];
  const options = { context: () => w.ctx, load: async () => ({ lands: [], captures: [], unavailable: [], snapshot: null }),
    evaluate: a => { asked.push(a.arriveBell); return typeof answer === 'function' ? answer(a) : answer; } };
  return { asked, options, read: () => inspectOutboundRoute(w.fs, options) };
}
const codeOf = fn => { try { fn(); return null; } catch (e) { return e.code ?? String(e); } };
const card = w => String(hand.renderPop(w.fs, hand.handModel(w.fs)));
const BUTTON = /data-act="outbound-arrival-earliest"/;

test('one press puts the earliest observed turn in the draft\'s own field and reads the route again with it', async () => {
  setLang('ja');
  const w = world(), r = reader(w);
  assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable', 'nothing read yet: nothing to offer');
  assert.doesNotMatch(card(w), BUTTON);
  await r.read();
  assert.deepEqual({ ...outboundArrivalCandidate(w.fs) }, { arriveBell: '44', min: 44, max: 47, from: 'route' });
  const before = card(w);
  assert.match(before, BUTTON); assert.match(before, /最も早い候補（ターン 44）を使う/); assert.match(before, /到着候補：ターン 44〜47/);
  assert.equal((before.match(BUTTON) ?? []).length, 1);
  const done = await useEarliestOutboundArrival(w.fs, r.options);
  assert.deepEqual(done, { ok: true, state: 'entered-and-reread', arriveBell: '44', from: 'route' });
  const s = w.fs.expeditionCompose;
  assert.equal(s.arriveBell, '44'); assert.equal(s.status, 'review'); assert.equal(s.review.arriveBell, 44);
  assert.deepEqual(r.asked, [null, 44], 'the route is read once more, now with the chosen turn');
  assert.equal(s.routeCheck.status, 'read'); assert.equal(s.routeCheck.report.ok, true);
  // nothing is admitted, sealed, signed or sent by the press
  for (const [k, v] of Object.entries(OUTBOUND_CLOSED)) { assert.equal(v, false); assert.equal(s[k], false, k); assert.equal(s.routeCheck[k], false, k); assert.equal(s.review[k], false, k); }
  assert.equal(s.review.arrivalVerified, false); assert.ok(s.review.blockers.includes('ArrivalTravelUnverified')); assert.equal(w.fs.session, null);
  const after = card(w);
  assert.doesNotMatch(after, BUTTON, 'the turn is entered: the card says so instead of offering it again');
  assert.match(after, /outbound-arrival-set/); assert.match(after, /ターン 44/);
  assert.match(after, /data-bind="outbound-arriveBell" value="44"/, 'the manual field stays and shows the same turn');
  assert.match(after, /現在の通行・到着や出発の成功は未確認です/);
  assert.doesNotMatch(after, /<form|data-act="(?:march-send|dissolve|hand-return|seal|send)"/);
  // another turn by hand is still the player's own: the offer returns for the newly read observation
  assert.equal(editOutbound(w.fs, w.ctx, 'arriveBell', '46'), true);
  assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable', 'an edit drops the observation');
  await r.read();
  assert.equal(outboundArrivalCandidate(w.fs).arriveBell, '44'); assert.match(card(w), BUTTON); assert.match(card(w), /いまの候補：ターン 46/);
});

test('only an observation still bound to this host, these steps, this source and connection is used', async () => {
  // a look-alike observation that no read of this draft left
  { const w = world();
    w.fs.expeditionCompose.routeCheck = { status: 'read', report: report() };
    assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateStale');
    assert.doesNotMatch(card(w), BUTTON);
    assert.deepEqual(await useEarliestOutboundArrival(w.fs, reader(w).options), { ok: false, entered: false, code: 'ArrivalCandidateStale' });
    assert.equal(w.fs.expeditionCompose.arriveBell, ''); }
  // an older observation put back after the steps changed
  { const w = world(), r = reader(w); await r.read();
    const old = w.fs.expeditionCompose.routeCheck;
    assert.equal(editOutbound(w.fs, w.ctx, 'step', '0'), true); assert.equal(w.fs.expeditionCompose.routeCheck, null);
    w.fs.expeditionCompose.routeCheck = old;
    assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateStale');
    assert.equal((await useEarliestOutboundArrival(w.fs, r.options)).ok, false); assert.equal(w.fs.expeditionCompose.arriveBell, ''); }
  // the turn moved on since the read (an ordinary poll): the draft and its steps stand, the observation is dropped,
  // and there is nothing observed to enter until the route is read again (web-frontier-outbound-clock.test.mjs)
  { const w = world(), r = reader(w); await r.read();
    assert.equal(outboundArrivalCandidate(w.fs).arriveBell, '44'); const steps = [...w.fs.expeditionCompose.directions];
    w.fs.nowBell++;
    assert.deepEqual(await useEarliestOutboundArrival(w.fs, r.options), { ok: false, entered: false, code: 'ArrivalCandidateUnavailable' });
    assert.equal(w.fs.expeditionCompose.arriveBell, '', 'nothing was entered'); assert.deepEqual(r.asked, [null], 'nothing was read again');
    assert.deepEqual(w.fs.expeditionCompose.directions, steps, 'the steps stand'); assert.notEqual(w.fs.expeditionCompose.error, 'SourceChanged'); assert.equal(w.fs.expeditionCompose.routeCheck, null); }
  // the connection, the source, the wallet, the selected host or the card changed since the read
  const changes = [w => { w.ctx.relay = '/new'; }, w => { w.ctx.source = {}; }, w => { w.fs.wallet = { address: WALLET }; },
    w => { w.province.entries[0].troops++; }, w => { w.h.gen++; }, w => { w.fs.hand = { ...w.fs.hand, host: '1' }; }, w => { w.fs.hand = { ...w.fs.hand, pop: null }; }];
  for (const [i, change] of changes.entries()) {
    const w = world(), r = reader(w); await r.read();
    assert.equal(outboundArrivalCandidate(w.fs).arriveBell, '44', `case ${i}`);
    change(w);
    assert.deepEqual(await useEarliestOutboundArrival(w.fs, r.options), { ok: false, entered: false, code: 'SourceChanged' }, `case ${i}`);
    assert.notEqual(w.fs.expeditionCompose?.arriveBell, '44', `case ${i}: nothing was entered`);
    assert.deepEqual(r.asked, [null], `case ${i}: and nothing was read again`);
    assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable', `case ${i}`);
  }
});

test('a route that cannot be walked or timed, an empty range and broken values offer nothing', async () => {
  const cases = [
    [report({ code: 'RouteLandMissing', min: null, max: null, travelSecs: null, wearBps: null, stepIndex: 0 }), 'ArrivalCandidateUnavailable'],
    [report({ code: 'RouteImpassable', stepIndex: 0 }), 'ArrivalCandidateUnavailable'],
    [report({ code: 'RoutePalisade' }), 'ArrivalCandidateUnavailable'],
    [report({ code: 'ArrivalWindowEmpty', min: 48, max: 47 }), 'ArrivalCandidateUnavailable'],
    [report({ min: 48, max: 47 }), 'ArrivalWindowEmpty'],
    [report({ min: -1 }), 'ArrivalCandidateInvalid'], [report({ min: 44.5 }), 'ArrivalCandidateInvalid'], [report({ min: '44' }), 'ArrivalCandidateInvalid'],
    [report({ min: NaN }), 'ArrivalCandidateInvalid'], [report({ max: 4294967296 }), 'ArrivalCandidateInvalid'], [report({ max: Infinity }), 'ArrivalCandidateInvalid'],
    [report({ min: 44, max: null }), 'ArrivalCandidateUnavailable'], [null, 'ArrivalCandidateUnavailable'],
  ];
  for (const [answer, code] of cases) {
    const w = world(), r = reader(w, () => answer);
    await r.read();
    const label = `${JSON.stringify(answer)} → ${code}`;
    assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), code, label);
    if (answer) assert.doesNotMatch(card(w), BUTTON, label);
    assert.deepEqual(await useEarliestOutboundArrival(w.fs, r.options), { ok: false, entered: false, code }, label);
    assert.equal(w.fs.expeditionCompose.arriveBell, '', label); assert.equal(r.asked.length, 1, label);
  }
  // the two ends of a u32 turn are turn numbers like any other
  for (const [min, max] of [[0, 0], [0, 4294967295], [4294967295, 4294967295]]) {
    const w = world(), r = reader(w, () => report({ min, max })); await r.read();
    assert.equal(outboundArrivalCandidate(w.fs).arriveBell, String(min));
  }
});

/** A route reader whose every load waits to be answered by the test: `gates[i].res()` / `gates[i].rej(error)`. */
function gated(w, answer = sound) {
  const asked = [], gates = [];
  const options = { context: () => w.ctx,
    load: () => new Promise((res, rej) => gates.push({ res: () => res({ lands: [], captures: [], unavailable: [], snapshot: null }), rej })),
    evaluate: a => { asked.push(a.arriveBell); return answer(a); } };
  return { asked, gates, options };
}
/** A draft with one finished route observation (range 44–47) and the next load held. */
async function observedDraft(answer = sound) {
  const w = world(), g = gated(w, answer), first = inspectOutboundRoute(w.fs, g.options);
  g.gates[0].res(); await first;
  assert.equal(outboundArrivalCandidate(w.fs).arriveBell, '44');
  return { w, g };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('a candidate of the departure-conditions read is used the same way, and that read is the one made again', async () => {
  setLang('ja');
  const w = world(), asked = [];
  let blocked = false;
  const options = { context: () => w.ctx, judge: () => ({ ok: true, code: null }), evaluate: a => { asked.push(a.arriveBell); return sound(a); },
    snapshot: async source => (blocked ? { status: 'blocked', code: 'ExpeditionPreviewDisabled' }
      : { status: 'read', source, lands: [], season: w.fs.season, holdingBytes: null, clock: { unixTimestamp: 1000n },
        contextSlot: '7', digest: 'ab'.repeat(32), coherent: true, contentConsistent: true }) };
  await inspectOutboundContext(w.fs, options);
  assert.equal(w.fs.expeditionCompose.contextCheck.status, 'read'); assert.equal(w.fs.expeditionCompose.routeCheck, null);
  assert.deepEqual({ ...outboundArrivalCandidate(w.fs) }, { arriveBell: '44', min: 44, max: 47, from: 'context' });
  const before = card(w);
  assert.equal((before.match(BUTTON) ?? []).length, 1); assert.match(before, /outbound-context-report/);
  assert.deepEqual(await useEarliestOutboundArrival(w.fs, options), { ok: true, state: 'entered-and-reread', arriveBell: '44', from: 'context' });
  const s = w.fs.expeditionCompose;
  assert.deepEqual(asked, [null, 44]); assert.equal(s.arriveBell, '44'); assert.equal(s.contextCheck.status, 'read'); assert.equal(s.routeCheck, null);
  for (const k of Object.keys(OUTBOUND_CLOSED)) { assert.equal(s[k], false, k); assert.equal(s.contextCheck[k], false, k); }
  const after = card(w);
  assert.doesNotMatch(after, BUTTON); assert.match(after, /出発の送信はまだ利用できません/);
  // the read made again is refused by the connection: the field holds the turn, and the answer does not say "ok"
  assert.equal(editOutbound(w.fs, w.ctx, 'arriveBell', '46'), true);
  await inspectOutboundContext(w.fs, options);
  blocked = true;
  assert.deepEqual(await useEarliestOutboundArrival(w.fs, options),
    { ok: false, entered: true, code: 'ArrivalRereadFailed', reason: 'ExpeditionPreviewDisabled', arriveBell: '44', from: 'context' });
  assert.equal(w.fs.expeditionCompose.arriveBell, '44'); assert.equal(w.fs.expeditionCompose.contextCheck.status, 'error');
  assert.doesNotMatch(card(w), BUTTON);
});

test('a second press while the first is reading enters nothing and does not disturb the first', async () => {
  const { w, g } = await observedDraft();
  const first = useEarliestOutboundArrival(w.fs, g.options), second = useEarliestOutboundArrival(w.fs, g.options);
  assert.deepEqual(await second, { ok: false, entered: false, code: 'ArrivalCandidateUnavailable' });
  assert.equal(g.gates.length, 2, 'one read under way, not two');
  g.gates[1].res();
  assert.deepEqual(await first, { ok: true, state: 'entered-and-reread', arriveBell: '44', from: 'route' });
  assert.deepEqual(g.asked, [null, 44]); assert.equal(w.fs.expeditionCompose.arriveBell, '44');
});

test('a press whose read ends after the card was closed, edited or re-sourced is not a success', async () => {
  // closed (app.mjs: clearOutbound, then the hand's pop goes)
  { const { w, g } = await observedDraft(), press = useEarliestOutboundArrival(w.fs, g.options);
    clearOutbound(w.fs); w.fs.hand = { ...w.fs.hand, pop: null };
    g.gates[1].res();
    assert.deepEqual(await press, { ok: false, entered: false, code: 'ArrivalRereadSuperseded', arriveBell: '44', from: 'route' });
    assert.equal(w.fs.expeditionCompose.arriveBell, ''); assert.deepEqual(g.asked, [null], 'the late answer was not evaluated'); }
  // closed and opened again on the same host: a new draft, not the press's
  { const { w, g } = await observedDraft(), press = useEarliestOutboundArrival(w.fs, g.options);
    openOutbound(w.fs, w.ctx); editOutbound(w.fs, w.ctx, 'step', '0'); editOutbound(w.fs, w.ctx, 'arriveBell', '44');
    g.gates[1].res();
    assert.equal((await press).code, 'ArrivalRereadSuperseded'); assert.equal((await press).ok, false);
    assert.equal(w.fs.expeditionCompose.routeCheck, null, 'the new draft has no observation from the old press'); }
  // another turn typed meanwhile
  { const { w, g } = await observedDraft(), press = useEarliestOutboundArrival(w.fs, g.options);
    assert.equal(editOutbound(w.fs, w.ctx, 'arriveBell', '45'), true);
    g.gates[1].res();
    assert.deepEqual(await press, { ok: false, entered: false, code: 'ArrivalRereadSuperseded', arriveBell: '44', from: 'route' });
    assert.equal(w.fs.expeditionCompose.arriveBell, '45'); assert.equal(w.fs.expeditionCompose.routeCheck, null); }
  // a step added meanwhile: the field still holds the turn, but the observation of the press is gone
  { const { w, g } = await observedDraft(), press = useEarliestOutboundArrival(w.fs, g.options);
    assert.equal(editOutbound(w.fs, w.ctx, 'step', '0'), true);
    g.gates[1].res();
    assert.deepEqual(await press, { ok: false, entered: true, code: 'ArrivalRereadSuperseded', arriveBell: '44', from: 'route' });
    assert.equal(w.fs.expeditionCompose.routeCheck, null); assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable'); }
  // the turn moved on meanwhile: the read that was under way is not this clock's; the field keeps the turn, the draft stands
  { const { w, g } = await observedDraft(), press = useEarliestOutboundArrival(w.fs, g.options);
    w.fs.nowBell++; g.gates[1].res();
    assert.deepEqual(await press, { ok: false, entered: true, code: 'ArrivalRereadSuperseded', arriveBell: '44', from: 'route' });
    assert.notEqual(w.fs.expeditionCompose.error, 'SourceChanged'); assert.equal(w.fs.expeditionCompose.arriveBell, '44'); assert.notEqual(w.fs.expeditionCompose.routeCheck?.status, 'read'); }
  // the connection changed meanwhile
  for (const change of [w => { w.ctx.relay = '/new'; }, w => { w.ctx.source = {}; }]) {
    const { w, g } = await observedDraft(), press = useEarliestOutboundArrival(w.fs, g.options);
    change(w); g.gates[1].res();
    assert.deepEqual(await press, { ok: false, entered: false, code: 'ArrivalRereadSuperseded', arriveBell: '44', from: 'route' });
    assert.equal(w.fs.expeditionCompose.error, 'SourceChanged'); assert.equal(w.fs.expeditionCompose.arriveBell, '');
  }
});

test('a read that fails after the turn was entered says so: entered, not read', async () => {
  setLang('ja');
  const { w, g } = await observedDraft(), press = useEarliestOutboundArrival(w.fs, g.options);
  await tick();
  g.gates[1].rej(Object.assign(new Error('offline'), { code: 'RouteReadUnavailable' }));
  assert.deepEqual(await press, { ok: false, entered: true, code: 'ArrivalRereadFailed', reason: 'RouteReadUnavailable', arriveBell: '44', from: 'route' });
  const s = w.fs.expeditionCompose;
  assert.equal(s.arriveBell, '44'); assert.equal(s.routeCheck.status, 'error'); assert.equal(s.status, 'review');
  assert.doesNotMatch(card(w), BUTTON); assert.match(card(w), /道の記録を読めませんでした/);
  assert.equal(codeOf(() => outboundArrivalCandidate(w.fs)), 'ArrivalCandidateUnavailable');
});

test('a turn typed past the season\'s end comes back to the earliest observed turn in one press', async () => {
  setLang('ja');
  const w = world(), r = reader(w, a => (a.arriveBell !== null && a.arriveBell > 47 ? report({ code: 'ArrivalAfterSeason' }) : sound(a)));
  assert.equal(editOutbound(w.fs, w.ctx, 'arriveBell', '999999'), true);
  await r.read();
  assert.equal(w.fs.expeditionCompose.routeCheck.report.code, 'ArrivalAfterSeason');
  assert.deepEqual({ ...outboundArrivalCandidate(w.fs) }, { arriveBell: '44', min: 44, max: 47, from: 'route' });
  const before = card(w);
  assert.match(before, BUTTON); assert.match(before, /いまの候補：ターン 999999/); assert.match(before, /到着ターンの候補が、記録から計算した範囲に入りません/);
  assert.deepEqual(await useEarliestOutboundArrival(w.fs, r.options), { ok: true, state: 'entered-and-reread', arriveBell: '44', from: 'route' });
  assert.deepEqual(r.asked, [999999, 44]); assert.equal(w.fs.expeditionCompose.routeCheck.report.ok, true); assert.equal(w.fs.expeditionCompose.review.arriveBell, 44);
});

test('in English the offer, the entered turn and the empty field are said as proposals, never as a departure', async () => {
  const KEYS = ['最も早い候補（ターン {0}）を使う', 'いまの候補：ターン {0}', '到着ターンの候補は未入力です',
    '到着ターンの候補はターン {0}（観測した範囲で最も早い候補）です。詳細で変更できます。'];
  for (const key of KEYS) {
    assert.equal(typeof EN[key], 'string', key);
    assert.equal(EN_GROUPS['frontier-hand'][key], EN[key], `${key}: beside the card's other words`);
    assert.match(EN[key], /propos/i, `${key}: a proposal`);
    assert.doesNotMatch(EN[key], /\b(sent|send|depart\w*|arrives|will arrive|guarantee\w*|confirm\w*|accepted|sealed|signed)\b/i, key);
    // every value of the Japanese stands in the English
    assert.deepEqual(EN[key].match(/\{\d\}/g) ?? [], key.match(/\{\d\}/g) ?? [], key);
  }
  setLang('en');
  try {
    const w = world(), r = reader(w);
    await r.read();
    const before = card(w);
    assert.match(before, BUTTON);
    assert.ok(before.includes('Use the earliest proposed turn (44)')); assert.ok(before.includes('No proposed arrival turn entered'));
    assert.ok(before.includes('Proposed arrival range: turns 44–47'));
    assert.equal((await useEarliestOutboundArrival(w.fs, r.options)).ok, true);
    const after = card(w);
    assert.ok(after.includes('The proposed arrival turn is turn 44, the earliest in the observed range. You can change it in Details.'));
    assert.ok(after.includes('Current passage, arrival and successful departure remain unverified.'), 'the observation\'s own caution stays beside it');
    editOutbound(w.fs, w.ctx, 'arriveBell', '46'); await r.read();
    assert.ok(card(w).includes('Current proposal: turn 46'));
    for (const text of [before, after, card(w)]) for (const ja of ['最も早い候補', 'いまの候補', '未入力です', '観測した範囲']) assert.ok(!text.includes(ja), `${ja} is not left in Japanese`);
    for (const key of KEYS) assert.ok(!missingKeys().includes(key), key);
  } finally { setLang('ja'); }
});

test('the page wires every boundary control the card renders, and keeps the draft when one is pressed', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), acts = [...new Set([...read('hud/hand.mjs').matchAll(/data-act="(outbound-[a-z-]+)"/g)].map(m => m[1]))].sort();
  assert.deepEqual(acts, ['outbound-arrival-earliest', 'outbound-context-read', 'outbound-local-depart', 'outbound-local-reconcile', 'outbound-reset', 'outbound-route-read', 'outbound-step', 'outbound-undo']);
  const from = app.indexOf('export const HUD_ACTIONS = {'), table = app.slice(from, app.indexOf('\n};', from));
  assert.ok(from > 0 && table.length > 0);
  for (const act of acts) assert.ok(table.includes(`\n  '${act}': `), `${act} is a HUD action`);
  assert.match(table, /\n  'outbound-arrival-earliest': \(\) => useEarliestOriginalOutboundArrival\(\),\n/);
  assert.match(app, /import \{[^}]*\buseEarliestOriginalOutboundArrival\b[^}]*\} from '\.\/controller\.mjs';/);
  // (the local reveal strip's own presses — LOCAL_REVEAL_ACTS — keep the draft too; they are no boundary control)
  const kept = /FS\.hand\?\.pop === OUTBOUND_POP && !LOCAL_REVEAL_ACTS\.includes\(el\.dataset\.act\) && !\[([^\]]*)\]\.includes\(el\.dataset\.act\)\) clearOutbound\(FS\);/.exec(app);
  assert.ok(kept, 'the click handler\'s list of presses that keep the boundary draft');
  assert.deepEqual(kept[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).sort(), acts, 'a control missing here would clear the draft before it runs');
  const reveal = /const LOCAL_REVEAL_ACTS = Object\.freeze\(\[([^\]]*)\]\)/.exec(app);
  assert.ok(reveal, 'the reveal strip\'s presses are a list of their own');
  assert.ok(!reveal[1].split(',').some(x => x.trim().replace(/^'|'$/g, '').startsWith('outbound-')), 'no boundary control hides in the reveal list: each is named in the list above');
});

test('the press is a local edit and a read: an export beside the other boundary reads, outside ACTIONS and FORMS', () => {
  assert.equal(typeof CTRL.useEarliestOriginalOutboundArrival, 'function');
  for (const table of [CTRL.ACTIONS, CTRL.FORMS]) assert.ok(!Object.keys(table).some(k => k.startsWith('outbound-')));
  const src = readFileSync(new URL('../../permutation-server/web/frontier/fexpedition-compose.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function useEarliestOutboundArrival'), src.indexOf('/** Relative local coordinates only'));
  assert.match(body, /editOutbound\(fs, ctx, 'arriveBell', pick\.arriveBell\)/, 'the field\'s own edit path');
  assert.doesNotMatch(body, /seal|sign|submit|send|fetch|relay/i);
});
