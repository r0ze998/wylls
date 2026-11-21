// fix-loop7 (TEST/local): the loop-play7 BREAKs LP7-2…LP7-8 on the page. Synthetic LOCAL UI states and injected
// answers only: no boot, network, worker, key, seal, signature or send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import * as W from '../../permutation-server/web/frontier/map/world.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { placeName } from '../../permutation-server/web/frontier/map/names.mjs';
import { followWideHold } from '../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';
import { wideHostSayText, wideHostWaitLine, wideHoldOutcomeText } from '../../permutation-server/web/frontier/screens/wideholding.mjs';
import * as K from '../../permutation-server/web/frontier/hud/keephand.mjs';
import { arrivalShort, ARRIVAL_STATES } from '../../permutation-server/web/frontier/hud/statusview.mjs';
import { itemText, itemDetail } from '../../permutation-server/web/frontier/hud/returnwords.mjs';
import { renderToast } from '../../permutation-server/web/frontier/hud/feed.mjs';
import { OUTBOUND_POP, openOutbound, editOutbound, reconcileOutbound, inspectOutboundRoute, outboundRouteRefusal } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';

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

// ------------------------------------------------------------------ LP7-3: a refused road stays until the road changes
const impassable = over => report({ code: 'RouteImpassable', stepIndex: 1, min: null, max: null, travelSecs: null, ...over });
test('LP7-3: 「山や水のマスには進めません」 names the step and stays through clock polls until the road is changed', async () => {
  setLang('ja');
  const w = world();
  editOutbound(w.fs, w.ctx, 'step', '2');
  assert.deepEqual(w.fs.expeditionCompose.directions, [0, 2]);
  const r = reader(w, impassable());
  await r.read();
  let c = card(w);
  assert.match(c, /山や水のマスには進めません/); assert.match(c, /2 歩め（北西）のマスで止まります。/);
  assert.match(c, /「一歩戻す」で消して別の方向に変えると/);
  const m = outboundRouteRefusal(w.fs);
  assert.deepEqual([m.code, m.stepIndex, m.direction], ['RouteImpassable', 1, 2]);
  // the clock moves (×60: within a second or two): the observation itself is dropped…
  for (let i = 0; i < 3; i++) {
    w.fs.nowBell += 1; assert.equal(reconcileOutbound(w.fs, w.ctx), true);
    assert.equal(w.fs.expeditionCompose.routeCheck, null, 'the read under the earlier clock is dropped');
    c = card(w);
    // …but the road's refusal stays, with its step, and the card no longer reads as unread
    assert.match(c, /山や水のマスには進めません/, `poll ${i}`); assert.match(c, /2 歩め（北西）のマスで止まります。/);
    assert.match(c, /道を変えるまで出ています/);
    assert.doesNotMatch(c, /到着ターンはまだ入っていません/, 'not "nothing has been read"');
  }
  // EN
  setLang('en');
  c = card(w);
  assert.match(c, /A host cannot march onto mountains or water/); assert.match(c, /The road stops at step 2 \(/);
  assert.match(c, /It stays until you change the road/);
  assert.doesNotMatch(c, /[ぁ-んァ-ン一-龯]/, 'the refusal is fully English');
  setLang('ja');
  // changing the road forgets it
  editOutbound(w.fs, w.ctx, 'undo');
  assert.equal(outboundRouteRefusal(w.fs), null);
  c = card(w);
  assert.doesNotMatch(c, /山や水のマスには進めません/); assert.match(c, /到着ターンはまだ入っていません/);
  // the very same road typed again: the terrain has not changed, so its verdict is said again (it is of these steps)
  editOutbound(w.fs, w.ctx, 'step', '2');
  assert.notEqual(outboundRouteRefusal(w.fs), null);
  await reader(w, report()).read();
  assert.equal(outboundRouteRefusal(w.fs), null, 'a later read of the same road that does not refuse it forgets the refusal');
});

// ------------------------------------------------------------------ LP7-4: an opened wide-land province is not "not open yet"
test('LP7-4: a ring-130 province of the opened wide land is named as open wide land, in the brief and the card (JA/EN)', () => {
  setLang('ja');
  const REC = { rings: Array.from({ length: 129 }, (_, d) => ({ d, seed: '00' })), ringsOpened: 129, rMax: 128 };
  const FS = { record: REC, world: W.worldOf(REC), selected: { p: 130, q: -65 }, mode: 'play' };
  // before the wide land is known: as before (beyond the map of rings 0–128)
  let m = inspect.inspectModel(FS, null);
  assert.equal(m.wide, false); assert.equal(m.ring, 130);
  assert.doesNotMatch(placeName(m), /広い土地/);
  // the page's wide-land read has this province open (FS.wideLandNow, unfogged: its ring is public geometry)
  FS.wideLandNow = () => ({ byKey: new Map([['130,-65', { p: 130, q: -65, ring: 130 }]]) });
  m = inspect.inspectModel(FS, null);
  assert.equal(m.wide, true);
  assert.equal(placeName(m), '広い土地・第130輪の州');
  const brief = String(inspect.renderBrief(FS, null)), card = String(inspect.render(FS, null));
  assert.match(brief, /選択中: <span>広い土地・第130輪の州<\/span>/);
  assert.doesNotMatch(brief + card, /まだひらいていません|いまの地図の外/, 'not "not open yet" nor "outside the map"');
  assert.match(card, /第130輪（広い土地・ひらいています）/);
  // the local world's start answer's opened targets say the same without the read
  const FS2 = { ...FS, wideLandNow: () => null, localPlay: { wideLand: { targets: [{ p: 130, q: -65 }] } } };
  assert.equal(inspect.inspectModel(FS2, null).wide, true);
  // a ring-130 province that is NOT open stays as it was; a legacy ring province is never "wide"
  assert.equal(inspect.wideOpen(FS, 131, -65), false);
  assert.equal(inspect.wideOpen(FS, 3, 0), false);
  setLang('en');
  assert.match(String(inspect.renderBrief(FS, null)), /A wide-land province of ring 130/);
  assert.match(String(inspect.render(FS, null)), /Ring 130 \(wide land, open\)/);
  setLang('ja');
});

test('LP7-3 (verify-pr137): a road stopped before its last step says how many 「一歩戻す」 presses take the stopping step away (JA/EN)', async () => {
  setLang('ja');
  const w = world();
  for (const d of ['2', '2', '1']) editOutbound(w.fs, w.ctx, 'step', d);
  assert.deepEqual(w.fs.expeditionCompose.directions, [0, 2, 2, 1]);
  const r = reader(w, impassable({ stepIndex: 1 }));
  await r.read();
  let c = card(w);
  assert.match(c, /2 歩め（北西）のマスで止まります。/);
  assert.match(c, /「一歩戻す」を 3 回押して 2 歩めまで消し、別の方向に変えると、もう一度確認できます。/);
  assert.doesNotMatch(c, /その一歩を「一歩戻す」で消して/);
  // the same words from memory, after the clock poll dropped the read
  w.fs.nowBell += 1; reconcileOutbound(w.fs, w.ctx);
  c = card(w);
  assert.match(c, /「一歩戻す」を 3 回押して 2 歩めまで消し/); assert.match(c, /道を変えるまで出ています/);
  setLang('en');
  c = card(w);
  assert.match(c, /Press Undo step 3 times to remove steps back to step 2, choose another direction, then check again\./);
  assert.doesNotMatch(c, /[ぁ-んァ-ン一-龯]/);
  setLang('ja');
});

test('LP7-8 (verify-pr137): a toast already on screen takes its new hover title with a change of language (syncStack)', () => {
  // live: the toast's words turned English, its title stayed Japanese — syncStack copied class, role and children only
  const src = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function syncStack(el, items) {'), src.indexOf('function syncStack(el, items) {') + 2600);
  assert.match(body, /node\.replaceChildren\(\.\.\.next\.childNodes\); stackHtml\.set\(node, markup\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(next\.hasAttribute\('title'\)\) node\.setAttribute\('title', next\.getAttribute\('title'\)\); else node\.removeAttribute\('title'\);/);
});

// ------------------------------------------------------------------ LP7-5: the W2 card follows the hold to its end
const TO = { p: '-63', q: '-67', tile: 30, holder: 1 };
const stands = (nowBell, keep) => ({ to: TO, arrive: 373, troops: 20, phase: 'stands', nowBell, faction: 0, keep });
test('LP7-5: the hold of the keep by the own wide march is followed past 「占拠中 20 / 72」 to taken, or to lost (JA/EN)', () => {
  setLang('ja');
  // on the way, then settling: nothing to follow yet
  assert.equal(followWideHold(null, { to: TO, arrive: 373, phase: 'out', nowBell: 360 }), null);
  let h = followWideHold(null, stands(394, { holder: 1, contender: 0, progress: 20, required: 72 }));
  assert.deepEqual(h, { to: { p: '-63', q: '-67' }, progress: 20, required: 72, since: 394, outcome: null, arrive: 373 });
  let say = { kind: 'wait', wait: 'march', march: stands(394, { holder: 1, contender: 0, progress: 20, required: 72 }), hold: h };
  assert.match(wideHostSayText(say), /あなたの国が砦を占拠中です：20 \/ 72 ターン/);
  // the card keeps following (the waiting line names the hold and what is left), turn after turn
  assert.match(String(wideHostWaitLine({ reason: 'hold', hold: h })), /砦の占拠を見守っています（あと 52 ターン）/);
  h = followWideHold(h, stands(430, { holder: 1, contender: 0, progress: 56, required: 72 }));
  assert.equal(h.progress, 56); assert.equal(h.since, 394); assert.equal(h.outcome, null);
  // a lag wait of the village's own province no longer hides the count (D-loop-play7-7)
  assert.match(wideHostSayText({ kind: 'wait', wait: 'lag', lag: 2, hold: h }), /2 ターン遅れています。 あなたの国が州 -63,-67 の砦を占拠中です：56 \/ 72 ターン/);
  // 72 turns: the keep is the nation's — said, and kept said
  h = followWideHold(h, stands(447, { holder: 0, contender: 255, progress: 0, required: 72 }));
  assert.equal(h.outcome, 'taken'); assert.equal(h.at, 447);
  say = { kind: 'wait', wait: 'march', march: stands(447, { holder: 0, contender: 255, progress: 0, required: 72 }), hold: h };
  assert.equal(wideHostSayText(say), '結果：州 -63,-67 の砦を奪いました。砦はあなたの国のものです（ターン 447 に確認）。');
  assert.equal(followWideHold(h, { to: TO, phase: 'gone', nowBell: 460 }), h, 'an ended hold stays ended');
  assert.equal(wideHostSayText({ kind: 'wait', wait: 'lag', lag: 3, hold: h }), wideHoldOutcomeText(h), 'still said through a later lag wait');
  setLang('en');
  assert.equal(wideHostSayText(say), "Result: you took the keep of province -63,-67. The keep is your nation's (seen at turn 447).");
  assert.match(String(wideHostWaitLine({ reason: 'hold', hold: { progress: 20, required: 72 } })), /Following the hold of the keep \(52 turns to go\)/);
  setLang('ja');
  // lost: the host is beaten off the tile mid-hold
  let l = followWideHold(null, stands(394, { holder: 1, contender: 0, progress: 20, required: 72 }));
  l = followWideHold(l, { to: TO, arrive: 373, phase: 'gone', nowBell: 401 });
  assert.equal(l.outcome, 'lost'); assert.equal(l.why, 'gone');
  assert.match(wideHostSayText({ kind: 'wait', wait: 'march', hold: l }), /砦は奪えませんでした。軍勢が砦のマスからいなくなり、占拠が止まりました（ターン 401 に確認/);
  // lost: the host stands, but another nation now contends (or holds) the keep
  let o = followWideHold(null, stands(394, { holder: 1, contender: 0, progress: 20, required: 72 }));
  o = followWideHold(o, stands(400, { holder: 1, contender: 3, progress: 2, required: 72 }));
  assert.equal(o.outcome, 'lost'); assert.equal(o.why, 'held-by-other');
  setLang('en');
  assert.match(wideHostSayText({ kind: 'wait', wait: 'march', hold: o }), /^Result: the keep of province -63,-67 was not taken\. Your host still stands on its tile/);
  assert.doesNotMatch(wideHostSayText({ kind: 'wait', wait: 'march', hold: o }), /[ぁ-んァ-ン一-龯]/);
  setLang('ja');
  // another march (another keep) starts a new hold
  const other = followWideHold(h, { ...stands(500, { holder: 2, contender: 0, progress: 1, required: 72 }), to: { p: '-64', q: '-66', tile: 9, holder: 2 } });
  assert.deepEqual([other.to.p, other.outcome, other.progress], ['-64', null, 1]);
});

test('LP7-5 (live fix-loop7, turn 451): the capture turns the holding host into the garrison — "gone" with the keep now the nation\'s is TAKEN, not lost', () => {
  setLang('ja');
  let h = followWideHold(null, stands(397, { holder: 1, contender: 2, progress: 5, required: 72 }));
  h = followWideHold(h, { ...stands(450, { holder: 1, contender: 2, progress: 71, required: 72 }), faction: 2 });
  assert.equal(h.outcome, null); assert.equal(h.progress, 71);
  // what the live run read at turn 451: no host of the village in the province, the keep held by its nation (2), garrison 42
  // (the same march as the hold above: its arrival turn is the one `stands` carries — verify-pr137 keys a hold on its march)
  const gone = { to: TO, arrive: 373, phase: 'gone', nowBell: 451, faction: 2, keep: { holder: 2, contender: 255, progress: 0, required: 72 } };
  const t = followWideHold({ ...h, outcome: null }, gone);
  assert.equal(t.outcome, 'taken'); assert.equal(t.at, 451);
  assert.equal(wideHostSayText({ kind: 'wait', wait: 'march', march: gone, hold: t }), '結果：州 -63,-67 の砦を奪いました。砦はあなたの国のものです（ターン 451 に確認）。');
  // gone with the keep still another nation's: lost, as before
  const lost = followWideHold({ ...h, outcome: null }, { ...gone, keep: { holder: 1, contender: 255, progress: 0, required: 72 } });
  assert.equal(lost.outcome, 'lost'); assert.equal(lost.why, 'gone');
  // and the planner's marchState carries the keep for every arrived phase (source)
  const src = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay-wide-plan.mjs', import.meta.url), 'utf8');
  assert.match(src, /phase: open \? 'settling' : 'gone', nowBell, faction: holding\.faction,\n\s+keep: k \?/);
});

test('LP7-5 (verify-pr137): a LATER march onto the same keep is a new hold — the first march\'s 「奪えませんでした」 is not repeated over it', () => {
  setLang('ja');
  let l = followWideHold(null, stands(394, { holder: 1, contender: 0, progress: 20, required: 72 }));
  l = followWideHold(l, { to: TO, arrive: 373, phase: 'gone', nowBell: 401, faction: 0, keep: { holder: 1, contender: 255, progress: 0, required: 72 } });
  assert.equal(l.outcome, 'lost');
  // the same march read again: still lost, said once and kept
  assert.equal(followWideHold(l, { to: TO, arrive: 373, phase: 'gone', nowBell: 410 }), l);
  // the planner's second wide march onto the same keep, on its way: no hold yet, so the card says the march, not the old result
  const out2 = { to: TO, arrive: 470, phase: 'out', nowBell: 450 };
  assert.equal(followWideHold(l, out2), null);
  assert.equal(wideHoldOutcomeText(followWideHold(l, out2)), '');
  // it arrives and counts: a fresh hold; then the capture is said for THIS march
  let h2 = followWideHold(l, { ...stands(480, { holder: 1, contender: 0, progress: 3, required: 72 }), arrive: 470 });
  assert.deepEqual([h2.outcome, h2.progress, h2.since, h2.arrive], [null, 3, 480, 470]);
  h2 = followWideHold(h2, { to: TO, arrive: 470, phase: 'gone', nowBell: 552, faction: 0, keep: { holder: 0, contender: 255, progress: 0, required: 72 } });
  assert.equal(h2.outcome, 'taken'); assert.equal(h2.at, 552);
  assert.match(wideHostSayText({ kind: 'wait', wait: 'march', hold: h2 }), /^結果：州 -63,-67 の砦を奪いました。/);
});

test('LP7-5: the controller follows a standing host while its hold counts (about once a turn), not only out/settling', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /mem\.wideHold = followWideHold\(mem\.wideHold \?\? null, w\.march\)/);
  assert.match(src, /w\.march\?\.phase === 'stands' && mem\.wideHold && !mem\.wideHold\.outcome\) wideHostWait\(mem, \{ reason: 'hold'/);
});

// ------------------------------------------------------------------ LP7-6: a march whose result is out is not "still out"
test('LP7-6: past its arrival turn a host waiting on its village record is not told to receive the result it has (JA/EN)', () => {
  setLang('ja');
  const holding = { p: -2, q: 0, site: 11, transit: [{ state: 2, hostId: 77n, arriveBell: 6 }, { state: 0, hostId: 0n, arriveBell: 0 }] };
  const row = { id: 77n, unit: 0, troops: 487, inTransit: true, state: 1 };
  const out = K.waitOf({ nowBell: 5, holdings: [holding] }, row);
  assert.deepEqual(out, { why: 'march', turn: null, arrive: 6, arrived: false });
  assert.equal(K.waitText({ ...out, unit: 0, troops: 487 }), '槍兵 487 は進軍に出ています。結果を受け取ると、また出発できます。', 'on its way: as before');
  const after = K.waitOf({ nowBell: 8, holdings: [holding] }, row);
  assert.equal(after.arrived, true);
  const t = K.waitText({ ...after, unit: 0, troops: 487 });
  assert.match(t, /^槍兵 487 の進軍は到着のターン 6 を過ぎ、結果が出ています。村の記録で進軍の締めくくり/);
  assert.doesNotMatch(t, /結果を受け取ると/);
  setLang('en');
  assert.match(K.waitText({ ...after, unit: 0, troops: 487 }), /^487 Spearmen: the march is past its arrival turn 6 and its result is out\./);
  setLang('ja');
  // no transit record for the host (a province entry still in state 3): as before
  assert.deepEqual(K.waitOf({ nowBell: 8, holdings: [{ ...holding, transit: [] }] }, { ...row, inTransit: false, state: 3 }), { why: 'march', turn: null, arrive: null, arrived: false });
});

// ------------------------------------------------------------------ LP7-8: caravan delivery toasts in plain words
test('LP7-8: every caravan arrival state is one short plain sentence in the toast (JA/EN); the careful account is not in it', () => {
  const W40O80 = [0, 40, 0, 80, 0, 0, 0, 0];
  const cases = [
    { state: 'overdue', bell: 14 }, { state: 'settledUnverified', why: 'vault', recorded: W40O80 }, { state: 'settledUnverified', why: 'vault' },
    { state: 'settledUnverified', why: 'rulesUnknown', recorded: W40O80 }, { state: 'settledUnverified', why: 'dstUnknown', recorded: W40O80 },
    { state: 'settledUnverified', why: 'outcomeUnknown' }, { state: 'lost', recorded: W40O80 }, { state: 'unread' }, { state: 'misdelivered', recorded: W40O80 },
    { state: 'verifiedIntake', intake: W40O80, compare: 'sentUnknown' }, { state: 'verifiedPartial', basis: 'sentRecord', sent: W40O80, arrived: [0, 30, 0, 80, 0, 0, 0, 0] },
    { state: 'verifiedFull', basis: 'sentRecord', sent: W40O80, arrived: W40O80 }];
  assert.deepEqual([...new Set(cases.map(c => c.state))].sort(), [...ARRIVAL_STATES].sort(), 'every state is covered');
  setLang('ja');
  for (const c of cases) {
    const t = arrivalShort(c);
    assert.ok(t.length <= 48, `short: ${t}`);
    assert.doesNotMatch(t, /切り捨て|プログラムの版|送付記録の数量|下限|基準/, `plain: ${t}`);
    assert.equal(t.replace(/（[^）]*）/g, '').split('。').filter(Boolean).length, 1, `one sentence: ${t}`);
  }
  assert.equal(arrivalShort(cases[1]), '貯蔵庫に着きました（積荷 木材 40・鉱石 80。入った量は確かめられません）');
  assert.equal(arrivalShort(cases[3]), '着きました（入った量は確かめられません）', 'the rules-unknown case no longer explains the program version');
  // the toast, as loop-play7 saw it (a delivery to the Vault, turn 17)
  const toast = itemText({ kind: 'CARAVAN_SETTLED', bell: 17, tone: 'result', facts: { cargo: W40O80, delivered: true, arrival: cases[1] } });
  assert.equal(toast, '隊商（ターン 17）：貯蔵庫に着きました（積荷 木材 40・鉱石 80。入った量は確かめられません）');
  // the careful account is kept, as the toast's hover title (a settled caravan leaves the trade card's road list)
  const item = { kind: 'CARAVAN_SETTLED', bell: 17, tone: 'result', facts: { cargo: W40O80, delivered: true, arrival: cases[1] } };
  assert.match(itemDetail(item), /^到着しましたが、入った量は確認できません（記録の積荷：木材 40・鉱石 80）。倉庫は上限を超えた分を切り捨てます/);
  const markup = String(renderToast({ id: 'aw:1', kind: 's1', bell: 17, text: itemText(item), hint: itemDetail(item) }));
  assert.match(markup, /title="到着しましたが、入った量は確認できません/); assert.match(markup, /貯蔵庫に着きました（積荷 木材 40・鉱石 80。入った量は確かめられません）/);
  assert.doesNotMatch(String(renderToast({ id: 'x', kind: 's1', text: 'a' })), /title=/, 'no title without a detail');
  assert.equal(itemDetail({ kind: 'CARAVAN_SETTLED', tone: 'uncertain', facts: { arrival: cases[1] } }), '');
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /text: returnWords\.itemText\(i\), hint: returnWords\.itemDetail\(i\) \|\| undefined/);
  setLang('en');
  for (const c of cases) assert.doesNotMatch(arrivalShort(c), /[ぁ-んァ-ン一-龯]/, `English: ${arrivalShort(c)}`);
  assert.equal(itemText({ kind: 'CARAVAN_SETTLED', bell: 17, tone: 'result', facts: { cargo: W40O80, delivered: true, arrival: cases[1] } }),
    'Your caravan (turn 17): Reached the storehouse (cargo Wood 40, Ore 80; the amount taken in cannot be confirmed)');
  setLang('ja');
});
