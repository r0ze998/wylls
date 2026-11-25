// fix-ui-b17-b21 (the loop-play3 report's small UI breaks B17–B21), in both languages:
//   B17 the map's 「記録」 panel on a source with no recorded world: a plain note (no raw code), no empty map, the button
//       taken away once closed; its canvas caption is repainted on a language switch
//   B18 after a keep capture: a notice that the host's rest returned to the reserve (with the count, from the herald's
//       `retired` event of the keep donor), and no "No hosts yet" over a village that holds troops
//   B19 the first-village welcome card is not shown again over a village already in use (local play keeps its "seen"
//       note in the page's memory only: a reload or --resume forgot it)
//   B20 a waiting march send follows the arrival turn the CLOCK moved (told), instead of being withdrawn each turn
//   B21 a launcher that no longer answers is said in a plain line, and the "About this test world" box says the world
//       ended / is stopped instead of an earlier "services running" answer
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import { mountWideMode } from '../../permutation-server/web/frontier/map/widemode.mjs';
import { mergeDonorReturns, mergeKeepEvents, RETIRE_BY_KEEP_DONOR } from '../../permutation-server/web/frontier/fconquest.mjs';
import * as FEED from '../../permutation-server/web/frontier/hud/feed.mjs';
import { troopsAtHome } from '../../permutation-server/web/frontier/screens/host.mjs';
import { villageInUse } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { setS1 } from '../../permutation-server/web/frontier/fs1.mjs';
import { BUILDINGS } from '../../permutation-server/web/frontier/fi18n.mjs';
import { buildItemOf, WORKSHOP } from '../../permutation-server/web/frontier/fland.mjs';
import * as P from '../../permutation-server/web/frontier/flocalplay-pending.mjs';
import { launcherSilent, createLauncherWatch, launcherLostText, worldStateOf, LAUNCHER_LOST_AFTER } from '../../permutation-server/web/frontier/flocalplay-ended.mjs';
import { launcherLostBannerView, endedBannerView } from '../../permutation-server/web/frontier/stale-banner.mjs';
import { mountSessionNotice, sessionNoticeOf } from '../../permutation-server/web/frontier/flocalplay-session.mjs';

afterEach(() => setLang('ja'));
const JP = /[぀-ヿ一-鿿]/;
const src = p => readFileSync(new URL(`../../permutation-server/web/frontier/${p}`, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ------------------------------------------------------------------ B17
class FakeElement {
  constructor(doc) { this.ownerDocument = doc; this.dataset = {}; this.children = []; this.events = {}; this.attrs = {}; this.clientWidth = 640; this.clientHeight = 400; this.hidden = false; this.painted = []; }
  set innerHTML(text) { this.ids = new Map([...text.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new FakeElement(this.ownerDocument)])); }
  set textContent(t) { this.text = t; this.children = []; }
  get textContent() { return this.text ?? ''; }
  querySelector(s) { return this.ids?.get(s.replace(/^#/, '')) ?? null; }
  append(...nodes) { this.children.push(...nodes); for (const n of nodes) n.parentElement = this; }
  after(node) { this.parentElement?.append(node); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, f) { (this.events[k] ??= []).push(f); }
  fire(k, e = {}) { for (const f of this.events[k] ?? []) f(e); }
  focus() {} remove() {}
  getContext() { const el = this; return { setTransform() {}, fillRect() {}, save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, setLineDash() {}, stroke() {}, fill() {}, fillText(t) { el.painted.push(t); } }; }
}
function wideHarness(client) {
  const doc = { createElement: () => new FakeElement(doc) };
  const parent = doc.createElement('div'), canvas = doc.createElement('canvas'); parent.append(canvas);
  const record = { season: '5', seasonAddress: '11111111111111111111111111111112', programId: '11111111111111111111111111111113', cluster: 'localnet' };
  return mountWideMode({ herald: client, canvas, doc, recordOf: () => record });
}
const UNSERVED = { wideWorld: async () => ({ ok: false, code: 'WideWorldUnavailable', httpStatus: 404 }), wideWorldPage: async () => ({ ok: false, code: 'WideWorldUnavailable' }) };

test('B17: a source with no recorded world — a plain note in both languages, no raw code, no empty map, and the button goes once closed', async () => {
  const mode = wideHarness(UNSERVED);
  try {
    const { button, sheet } = mode.elements();
    assert.equal(button.hidden, false, 'offered until the source is known to serve none');
    mode.open(); await flush(); await flush();
    assert.equal(mode.state().phase, 'error'); assert.equal(mode.state().code, 'WideWorldUnavailable');
    const ja = sheet.querySelector('#wide-status').textContent;
    assert.match(ja, /この世界には「記録された世界」の表示（実験中）はありません。遊ぶうえで困ることはありません。/);
    assert.doesNotMatch(ja, /WideWorldUnavailable|配信元/);
    assert.equal(sheet.querySelector('#wide-body').hidden, true, 'the empty map and its side list are not shown');
    assert.equal(sheet.querySelector('#wide-facts').hidden, true);
    assert.equal(button.hidden, false, 'while its own sheet is open the button stays (it closes the sheet)');
    setLang('en'); await flush();
    const en = sheet.querySelector('#wide-status').textContent;
    assert.match(en, /^This world has no “recorded world” view \(an experimental display\)\. Nothing is wrong with your game/);
    assert.doesNotMatch(en, JP); assert.doesNotMatch(en, /WideWorldUnavailable/);
    mode.close();
    assert.equal(button.hidden, true, 'closed: an experimental button that leads nowhere is not offered again');
  } finally { mode.unmount(); }
});

test('B17: a source that serves a recorded world keeps the button and the map; the canvas caption is repainted on a language switch', async () => {
  const mode = wideHarness({ wideWorld: async () => ({ ok: false, code: 'network' }), wideWorldPage: async () => ({ ok: false, code: 'network' }) });
  try {
    const { button, sheet, canvas } = mode.elements();
    mode.open(); await flush(); await wait(40);
    assert.equal(sheet.querySelector('#wide-body').hidden, false, 'any other failure keeps the sheet as it was');
    assert.ok(canvas.painted.length >= 1, 'the caption was painted');
    assert.match(canvas.painted.at(-1), /記録された世界/);
    const before = canvas.painted.length;
    setLang('en'); await wait(40);
    assert.ok(canvas.painted.length > before, 'a language switch repaints the canvas (widemode.mjs: label → invalidate)');
    assert.doesNotMatch(canvas.painted.at(-1), JP, 'and its caption is in the page\'s language');
    mode.close();
    assert.equal(button.hidden, false);
  } finally { mode.unmount(); }
  assert.match(src('map/widemode.mjs'), /    renderText\(\);\n    \/\/ B17: the canvas caption is painted text; repaint it when the language changes\n    invalidate\(\);\n  \};/);
  assert.doesNotMatch(src('fi18n.mjs'), /（WideWorldUnavailable）/, 'the page\'s own table says it plainly too');
});

// ------------------------------------------------------------------ B18
const SIG = '5rrLeMCbGbdZq5Lkzzp8RzppFqSWVECwPfXduRATYf8bXDuw3e5HQC2ehyPcyygmCZhSY33wy76m5o2fEM4M7xff';
const retired = (seq, bell, by, troops, home = { p: 2, q: -3, site: 4 }) => ({ seq: String(seq), bell, sig: SIG, kind: 'retired', ...home, march: null, from: null, to: null, citizens: ['00'], detail: { host: '123456789', troops, by, homeKey: '9' } });
const taken = (seq, bell) => ({ seq: String(seq), bell, sig: SIG, kind: 'keep_taken', p: 2, q: -4, site: null, march: null, from: 4, to: 0, citizens: [], detail: { troops: 241 } });

test('B18: the keep donor\'s return is read from the herald\'s `retired` events (by = keep donor only), in whole troops', () => {
  assert.equal(RETIRE_BY_KEEP_DONOR, 2, 'frontier-abi retire_by::KEEP_DONOR');
  assert.match(readFileSync(new URL('../../permutation-frontier/src/proc/clash.rs', import.meta.url), 'utf8'), /\.u8\(retire_by::KEEP_DONOR\);/, 'the program logs RETIRE with that `by` for the donor');
  assert.match(readFileSync(new URL('../../frontier-node/crates/herald/src/conquest.rs', import.meta.url), 'utf8'), /json!\(\{"host": id\.to_string\(\), "troops": p32\(r, "troops"\), "by": p8\(r, "by"\),/, 'the herald serves host, troops (milli) and by');
  const day = [taken(10, 88), retired(11, 88, 2, 242_500), retired(12, 88, 0, 100_000), retired(13, 89, 2, 'x'), { ...retired(14, 89, 2, 5000), site: null }];
  const list = mergeDonorReturns(null, day);
  assert.deepEqual(list, [{ seq: '11', bell: 88, p: 2, q: -3, site: 4, troops: 242, host: '123456789' }], 'a player\'s own retire (by 0), a malformed count and a record with no site are not donor returns');
  assert.equal(mergeDonorReturns(list, day).length, 1, 'a day read again adds nothing');
  assert.equal(mergeKeepEvents(null, day).length, 1, 'the keep events are as before');
  assert.match(src('controller.mjs'), /    cq\.events = mergeKeepEvents\(cq\.events, r\.day\.events\);\n    \/\/ B18[^\n]*\n    cq\.returns = mergeDonorReturns\(cq\.returns, r\.day\.events\);/);
});

function feedWorld({ returns = [], events = [], bell = 88, holdings = [{ p: 2, q: -3, site: 4, gen: 0, state: 2, tier: 0, queue: [] }] } = {}) {
  return { nowBell: bell, holdings, marches: [], chronicle: [], incoming: [], provinces: new Map(), citizen: { faction: 0 }, conquest: { events, returns } };
}
test('B18: the notice — the rest of the host returned to the reserve, with the count, once, in both languages; nobody else\'s return is told', () => {
  const before = FEED.snapshot(feedWorld({ events: [] }), 0);
  const ev = mergeKeepEvents(null, [taken(10, 88)]), ret = mergeDonorReturns(null, [retired(11, 88, 2, 242_000), retired(15, 88, 2, 300_000, { p: 5, q: 5, site: 1 })]);
  const after = FEED.snapshot(feedWorld({ events: ev, returns: ret }), 0, before);
  const items = FEED.diffFeed(before, after).filter(x => x.id.startsWith('kr:'));
  assert.equal(items.length, 1, 'only the return to the viewer\'s own village');
  assert.equal(items[0].kind, 'keep'); assert.equal(items[0].p, 2); assert.equal(items[0].q, -3);
  assert.match(items[0].text, /残りの 242 人は.+の控えに戻ります。戻ったあと、村でもう一度、軍勢に編成できます。/);
  assert.match(items[0].words.en, /the other 242 troops go back to the reserve of .+\. Once they are back, you can form them into a host again in the village\./);
  assert.doesNotMatch(items[0].words.en, JP);
  assert.equal(FEED.diffFeed(after, FEED.snapshot(feedWorld({ events: ev, returns: ret }), 0, after)).filter(x => x.id.startsWith('kr:')).length, 0, 'told once');
  // the first reading of the season's days is the record, not news; nor is a return of long ago
  const cold = { ...feedWorld(), conquest: null };
  assert.equal(FEED.diffFeed(FEED.snapshot(cold, 0), after).filter(x => x.id.startsWith('kr:')).length, 0, 'days not read before: the past is not news');
  const late = FEED.snapshot(feedWorld({ events: ev, returns: ret, bell: 88 + FEED.KEEP_NEWS_BELLS + 1 }), 0, before);
  assert.equal(FEED.diffFeed({ ...before, bell: late.bell }, late).filter(x => x.id.startsWith('kr:')).length, 0, 'older than the keep-news turns');
});

test('B18: the troops a village holds at home (reserve without Settlers; its own garrison in whole troops)', () => {
  const h = { p: 2, q: -3, site: 1, reserve: [242, 0, 0, 0, 0, 0, 50, 9] };
  const FS = { provinces: new Map([['2,-3', { province: { siteMirror: [null, { garrison: 120_000 }] } }]]) };
  assert.deepEqual(troopsAtHome(FS, h), { reserveN: 292, garrisonN: 120 }, 'index 7 (Settlers) is not a troop to form a host from');
  assert.deepEqual(troopsAtHome({ provinces: new Map() }, { ...h, reserve: [0, 0, 0, 0, 0, 0, 0, 3] }), { reserveN: 0, garrisonN: 0 });
  assert.deepEqual(troopsAtHome({}, null), { reserveN: 0, garrisonN: 0 });
  const host = src('screens/host.mjs');
  assert.match(host, /if \(placesKnown && !unreadPlaces && \(reserveN > 0 \|\| garrisonN > 0\)\) \{/, 'only over a list that is known and has nothing unread — as "no hosts" itself');
});

// ------------------------------------------------------------------ B19
test('B19: a village already in use is not welcomed again', () => {
  const fresh = { tier: 0, hostSeq: 0, walls: 0, reserve: [0, 0, 0, 0, 0, 0, 0, 0], queue: [{ doneAt: 0, kind: 0 }, null], transit: [{ state: 0 }] };
  assert.equal(villageInUse(fresh), false, 'a village nothing was done with: the card is for it');
  assert.equal(villageInUse(null), false);
  for (const [why, over] of [['a build queued', { queue: [{ doneAt: 1234, kind: 1, arg: 0 }] }], ['troops trained', { reserve: [100, 0, 0, 0, 0, 0, 0, 0] }], ['a host was formed once', { hostSeq: 1 }],
    ['a march under way', { transit: [{ state: 1 }] }], ['walls', { walls: 100 }], ['promoted', { tier: 1 }]]) assert.equal(villageInUse({ ...fresh, ...over }), true, why);
  // (loop-play7: an S1 village with terrain ore (ore +34/h = base 4 + terrain 30) whose terrain is not read yet is not
  //  "in use": its ore over the tier's base is the terrain's, not mines; the welcome card stood for no such village)
  setS1({ layoutVersion: 2, programVersion: 4 });
  try {
    const oreHome = { ...fresh, queue: [{ doneAt: 0, kind: 0 }], p: -2, q: 0, production: [40000n, 30000n, 20000n, 34000n, 0n, 15000n, 5000n, 0n] };
    assert.equal(villageInUse(oreHome), false, 'terrain not read: the ore is not taken for mines');
    assert.equal(villageInUse({ ...oreHome, production: [64000n, 30000n, 20000n, 34000n, 0n, 15000n, 5000n, 0n] }), true, 'two farms built: still in use');
  } finally { setS1(null); }
  const ctl = src('controller.mjs');
  assert.match(ctl, /  if \(rec\.seen !== grantId\(h\) && !FS\.homeGrant && villageInUse\(h\)\) \{ saveHomePatch\(\{ seen: grantId\(h\) \}\); FS\.homeGrant = null; return; \}\n  if \(rec\.seen !== grantId\(h\)\) \{/,
    'before the card is raised; a card already on screen is left to its own button');
});

// ------------------------------------------------------------------ B20
const base = () => ({ world: 'inst-1', wallet: 'W1', holding: { p: 1, q: 1, site: 2, gen: 0 }, host: { id: '77', troops: 500, unit: 0, tile: 9 }, origin: { p: 1, q: 1 },
  m: { dest: { p: -2, q: 4, tile: 18 }, route: { dirs: [0, 1, 2], provinces: [{ p: 1, q: 1 }, { p: -2, q: 4 }] }, arriveBell: 36, stance: 0, retreat: { choice: 'never', ratio: null }, tip: 5000n } });
const at = (bell, over = {}) => P.intentOf({ ...base(), ...over, m: { ...base().m, ...(over.m ?? {}), arriveBell: bell } });

test('B20: only the arrival turn, moved on by the clock to exactly the turn the card names — else it is not "followed"', () => {
  assert.deepEqual(P.arrivalFollowed(at(36), at(37), 37), { from: 36, to: 37 });
  assert.equal(P.arrivalFollowed(at(36), at(37), null), null, 'the card\'s clock did not move it (the player picked the turn): withdrawn as before');
  assert.equal(P.arrivalFollowed(at(36), at(37), 38), null, 'not the turn the card names');
  assert.equal(P.arrivalFollowed(at(36), at(35), 35), null, 'never backwards');
  assert.equal(P.arrivalFollowed(at(36), at(36), 36), null);
  assert.equal(P.arrivalFollowed(at(36), at(37, { m: { stance: 1 } }), 37), null, 'anything else different: not followed');
  assert.equal(P.arrivalFollowed(at(36), at(37, { host: { id: '77', troops: 400, unit: 0, tile: 9 } }), 37), null);
  assert.equal(P.arrivalFollowed(at(36), at(37, { world: 'inst-2' }), 37), null);
  assert.equal(P.arrivalFollowed(at(36), 'not json', 37), null);
});

test('B20: pendingStep keeps the waiting send and re-aims it; every other rule is as it was', () => {
  const p = P.armPending({ intent: at(36), nowBell: 30 });
  const ok = { intent: at(36), problems: [], nowBell: 30, open: true, held: false, busy: false, sameCard: true };
  assert.deepEqual(P.pendingStep(p, { ...ok, intent: at(37) }), { act: 'withdraw', why: 'changed' }, 'without the clock\'s own move: never sent silently, as before');
  const step = P.pendingStep(p, { ...ok, intent: at(37), nowBell: 31, follow: 37, problems: ['NotResident'] });
  assert.equal(step.act, 'follow'); assert.deepEqual(step.moved, { from: 36, to: 37 });
  assert.deepEqual({ ...step.pending }, { intent: at(37), armedBell: 30, untilBell: 31 + P.PENDING_MAX_TURNS, follows: 1 }, 'the same arming, a fresh turn limit');
  assert.deepEqual(P.pendingStep(step.pending, { ...ok, intent: at(37), nowBell: 31 }), { act: 'send' }, 'then sent once, for the turn the card names');
  // the refusals that come first still come first
  assert.equal(P.pendingStep(p, { ...ok, intent: at(37), follow: 37, held: true }).why, 'unknown');
  assert.equal(P.pendingStep(p, { ...ok, intent: at(37), follow: 37, open: false }).why, 'closed');
  assert.equal(P.pendingStep(p, { ...ok, intent: at(37), follow: 37, sameCard: false }).why, 'changed');
  // bounded
  let q = p;
  for (let i = 1; i <= P.PENDING_MAX_FOLLOWS; i++) { const s = P.pendingStep(q, { ...ok, intent: at(36 + i), follow: 36 + i, nowBell: 30 + i }); assert.equal(s.act, 'follow', `follow ${i}`); q = s.pending; }
  assert.deepEqual(P.pendingStep(q, { ...ok, intent: at(36 + P.PENDING_MAX_FOLLOWS + 1), follow: 36 + P.PENDING_MAX_FOLLOWS + 1, nowBell: 37 }), { act: 'withdraw', why: 'changed' }, 'after the last follow: withdrawn and told, as before');
});

test('B20: the driver — a turn passes, the arrival moves, the send stays armed, is told once per move, and is sent exactly once', async () => {
  const calls = { send: 0, withdrawn: [], followed: [] };
  const state = { intent: at(36), problems: ['NotResident'], nowBell: 30, open: true, held: false, busy: false, sameCard: true, keyAlive: true, endsAt: 1e12, follow: null };
  let timer = null;
  const d = P.createPendingDriver({ look: () => ({ ...state }), refresh: () => Promise.resolve(), send: () => { calls.send++; }, withdrawn: (c, why) => calls.withdrawn.push(why),
    followed: (c, p, moved) => calls.followed.push([p.untilBell, moved.from, moved.to]), now: () => 0, setTimer: f => { timer = f; return 1; }, clearTimer: () => { timer = null; } });
  const card = { id: 'card' };
  assert.equal(d.arm(card, P.armPending({ intent: state.intent, nowBell: 30 })), true);
  timer(); await flush();
  // the turn passes before the province settles: composeTick moved the card's arrival (36 → 37), twice (→ 38)
  Object.assign(state, { nowBell: 31, intent: at(37), follow: 37 }); timer();
  assert.equal(d.armed, card, 'still armed'); assert.deepEqual(calls.followed, [[33, 36, 37]]);
  timer(); timer(); assert.equal(calls.followed.length, 1, 'told once per move');
  Object.assign(state, { nowBell: 32, intent: at(38), follow: 38 }); timer();
  assert.deepEqual(calls.followed.at(-1), [34, 37, 38]);
  state.problems = []; timer();
  assert.deepEqual([calls.send, calls.withdrawn.length, d.armed], [1, 0, null], 'one press, one send');
  timer?.(); assert.equal(calls.send, 1);
  // a driver without the hook (the muster's) is as before: a changed order is withdrawn
  const calls2 = { withdrawn: [] };
  const d2 = P.createPendingDriver({ look: () => ({ ...state, problems: ['NotResident'], intent: 'other' }), refresh: () => Promise.resolve(), send: () => {}, withdrawn: (c, why) => calls2.withdrawn.push(why), now: () => 0, setTimer: f => { timer = f; return 1; }, clearTimer: () => {} });
  d2.arm(card, P.armPending({ intent: 'x', nowBell: 30 })); timer();
  assert.deepEqual(calls2.withdrawn, ['changed']);
});

test('B20: the controller follows only the turn its own clock moved; the notice and the card say so in both languages; #75\'s refusal path is untouched', () => {
  const ctl = src('controller.mjs');
  assert.match(ctl, /follow: same && Number\.isInteger\(card\.moved\?\.to\) \? card\.moved\.to : null,\n/);
  assert.match(ctl, /  followed: \(card, p, moved\) => \{ card\.pending = p; setNotice\(\{ busy: false, waiting: true, text: L`時間が進んだため、到着はターン /);
  assert.match(ctl, /c\.moved = null;   \/\/ \(the turn is the player's own choice again\)/, 'a turn the player picks is never followed');
  assert.match(ctl, /send: card => \{ card\.pending = null; FS\.lastAct = \{ kind: 'act', name: 'march-send', data: \{\} \}; return sendTheMarch\(\); \},/, 'the send is the ordinary single send');
  // (devnet-page-war: the devnet sender's ONE attempt comes first, then local play's, both the ordinary single send)
  assert.match(ctl, /const r = dm \? await sendMarch\(m, \{/, 'devnet: one attempt, no resend');
  assert.match(ctl, /\}\) : localPlay \? await sendMarch\(m, \{/, 'one attempt, no resend (the #75 refusal handling is the send\'s own)');
  assert.equal((ctl.match(/followed:/g) ?? []).length, 1, 'the march\'s driver only: the muster\'s waiting send is as it was');
  setLang('en');
  const texts = [L`時間が進んだため、到着はターン ${37} になりました（さきほどまではターン ${36}）。送信待ちは続けています。州のターンの決着がつき次第、この到着ターンで1回だけ送ります（ターン ${39} まで。取り消せます）。`,
    L`ただし、時間が進んで到着ターンだけが先へ動いたときは、取り消さずに新しい到着ターンに合わせて待ち続けます。`];
  for (const t of texts) assert.doesNotMatch(t, JP, t);
  assert.match(texts[0], /arrival is now turn 37 \(it was turn 36\)\. The send is still waiting/); assert.match(texts[0], /until turn 39/);
});

// ------------------------------------------------------------------ B21
test('B21: a launcher that gives no answer at all is "silent"; an answer of any kind is the launcher being there', () => {
  assert.equal(launcherSilent({ ok: false, launcher: null, code: 'LauncherKeeperFailed' }), true, 'no reply, a timeout, a network failure');
  assert.equal(launcherSilent({ ok: false, launcher: 'WorldNotFound', code: 'WorldNotFound' }), false, 'that is the world\'s end (worldStateOf), said as that');
  assert.equal(launcherSilent({ ok: true, body: {} }), false);
  assert.equal(launcherSilent(null), false);
  assert.equal(worldStateOf({ ok: false, launcher: null, code: 'LauncherKeeperFailed' }), 'unknown', 'never taken as an end');
});

test('B21: said once the launcher is silent after a failed herald read; taken back by any answer or a herald read that worked; it asks nothing itself', () => {
  const silent = { ok: false, launcher: null, code: 'LauncherKeeperFailed' };
  // (the page's own setting: ONE silent answer — it is asked only after the herald read failed too, and the season is
  //  read every 30 s or slower: with two, a stopped launcher was not said for over a minute in the live check)
  assert.equal(LAUNCHER_LOST_AFTER, 1);
  { const said = []; const one = createLauncherWatch({ onLost: () => said.push('lost') }); assert.equal(one.heard(silent), true); assert.deepEqual(said, ['lost']); }
  // the count itself, with a higher bar
  const seen = [];
  const w = createLauncherWatch({ onLost: () => seen.push('lost'), onBack: () => seen.push('back'), after: 2 });
  assert.equal(w.heard(silent), false, 'below the bar: not said');
  assert.equal(w.heard({ ok: true, body: {} }), false); assert.equal(w.heard(silent), false, 'the count starts again after an answer');
  assert.equal(w.heard(silent), true); assert.equal(w.heard(silent), true);
  assert.deepEqual(seen, ['lost'], 'once');
  assert.equal(w.heard(null), true, 'no result (the page lost its key): nothing changes');
  w.readOk(); assert.deepEqual(seen, ['lost', 'back']); assert.equal(w.isLost(), false);
  w.readOk(); assert.deepEqual(seen, ['lost', 'back']);
  w.heard(silent); w.heard(silent); w.heard({ ok: false, launcher: 'WorldNotFound' });
  assert.deepEqual(seen, ['lost', 'back', 'lost', 'back'], 'the launcher answers again (its world ended: the end\'s own banner says so)');
  assert.deepEqual(Object.keys(w).sort(), ['heard', 'isLost', 'readOk'], 'no ask, no timer');
});

test('B21: the banner\'s plain line in both languages; the page wires it beside the world-ended watch with ONE launcher question', () => {
  const ja = launcherLostBannerView();
  assert.deepEqual([ja.hidden, ja.reread, ja.lost], [false, false, true]);
  assert.match(ja.text, /^開始サービス（ターミナルで動かしている開始用のプログラム）に届きません。止めたのであれば、この世界はいま止まっています。/);
  setLang('en');
  assert.match(launcherLostText(), /^The start service \(the program you run in a terminal\) cannot be reached\. If you stopped it, this world is stopped now/);
  assert.doesNotMatch(launcherLostText(), JP);
  assert.equal(endedBannerView().ended, true);
  const app = src('app.mjs');
  assert.match(app, /    if \(!FS\.worldEnded && FS\.launcherLost\) Object\.assign\(v, launcherLostBannerView\(\{ kept: FS\.localPlay\?\.wideLand \|\| FS\.localPlay\?\.clockScale \? false : undefined \}\)\);/, 'an ended world\'s own banner stays first');
  assert.match(app, /launcherWatch = createLauncherWatch\(\{ onLost: \(\) => launcherLost\(true\), onBack: \(\) => launcherLost\(false\) \}\);/);
  assert.match(app, /  if \(r\.ok\) launcherWatch\?\.readOk\(\);/);
  assert.equal(app.split('readFailed(').length - 1, 1, 'the launcher is still asked from one place only, after a failed read');
  assert.match(app, /  if \(err && FS\.launcherLost && FS\.error\?\.source === 'season'\) \{ err\.hidden = true; err\.textContent = ''; \}/, 'the poll\'s "could not connect" pill is not drawn over the plain line');
  assert.match(app, /  FS\.launcherLost = null;\n  try \{ sessionNoticeOf\(globalThis\.document\)\?\.worldState\('ended'\); \}/, 'worldEnded tells the test-world box');
});

function fakeDoc() {
  const all = [];
  const el = (tag) => { const e = { tag, className: '', textContent: '', hidden: false, dataset: {}, children: [], events: {}, attrs: {},
    append(...n) { e.children.push(...n); }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener(k, f) { (e.events[k] ??= []).push(f); }, click() { for (const f of e.events.click ?? []) f(); }, remove() {} }; all.push(e); return e; };
  const body = el('body');
  return { createElement: el, querySelector: () => null, body, all, byClass: c => all.filter(e => e.className.split(' ').includes(c)) };
}
test('B21: the "About this test world" box — an ended or stopped world is said, not an earlier "services running" answer', async () => {
  const doc = fakeDoc();
  const notice = mountSessionNotice({ doc, win: null, onCheck: async () => ({ state: 'reported', keeper: { state: 'running', resolvedNext: 6 } }) });
  try {
    assert.equal(sessionNoticeOf(doc), notice, 'the page finds the mounted notice');
    const check = doc.byClass('local-play-session-check')[0], said = doc.byClass('local-play-session-keeper')[0], points = doc.byClass('local-play-session-point');
    setLang('en');
    check.click(); await flush(); await flush();
    assert.equal(said.textContent, 'The world\'s automatic services are running (turns processed through 5).', 'the answer the report saw left on an ended world');
    notice.worldState('lost');
    assert.match(said.textContent, /^The start service \(the program you run in a terminal\) cannot be reached\./); assert.equal(said.hidden, false);
    assert.equal(points[1].textContent, 'This world seems to be stopped now (the start service cannot be reached).');
    notice.worldState('live');
    assert.equal(said.hidden, true, 'the launcher answers again: the stale answer is not brought back');
    assert.doesNotMatch(points[1].textContent, /stopped now/);
    notice.worldState('ended');
    assert.match(said.textContent, /^This test world has ended \(/); assert.doesNotMatch(said.textContent, /running/);
    assert.equal(points[1].textContent, 'This test world has ended. Its turns no longer advance.');
    notice.worldState('live'); notice.worldState('lost');
    assert.equal(notice.worldStateNow(), 'ended', 'an end is never taken back');
    setLang('ja'); await flush();
    assert.match(said.textContent, /^このテスト用の世界は終了しました（/); assert.equal(points[1].textContent, 'このテスト用の世界は終了しました。ターンはもう進みません。');
    check.click(); await flush(); await flush();
    assert.match(said.textContent, /^このテスト用の世界は終了しました（/, 'a later "running" answer of the keeper does not replace the end');
  } finally { notice.unmount(); }
  assert.equal(sessionNoticeOf(doc), null);
});

// Owner decision 2026-11-24 21:51 (LP14-1): a KEPT world's box says "paused, progress saved", never "ended".
test('LP14-1: the "About this test world" box of a kept world the launcher stopped — paused, progress saved, how to continue', async () => {
  const doc = fakeDoc();
  const notice = mountSessionNotice({ doc, win: null, persisted: true, onCheck: async () => ({ state: 'ended' }) });
  try {
    const check = doc.byClass('local-play-session-check')[0], said = doc.byClass('local-play-session-keeper')[0], points = doc.byClass('local-play-session-point');
    setLang('en');
    check.click(); await flush(); await flush();
    assert.match(said.textContent, /^This world is paused\. Your progress is saved\./, 'the key\'s own answer (the launcher\'s WorldNotFound) on a kept world');
    notice.worldState('ended');
    assert.equal(points[1].textContent, 'This world is paused. Your progress is saved.');
    assert.match(said.textContent, /continues from where it stopped/); assert.match(said.textContent, /--resume/);
    assert.doesNotMatch(points.map(p => p.textContent).join(' ') + said.textContent, /has ended|new world/);
    setLang('ja'); await flush();
    assert.equal(points[1].textContent, 'この世界は止まっています。進行は保存されています。');
    assert.match(said.textContent, /^この世界は止まっています。進行は保存されています。/); assert.doesNotMatch(said.textContent, /終了/);
    setLang('en');
  } finally { notice.unmount(); }
  // the dial: "Turn N · paused" for a kept world, "Turn N · ended" for a memory-only test world (app.mjs)
  const { stoppedChip, chipText, dialParts } = await import('../../permutation-server/web/frontier/app.mjs');
  const chip = stoppedChip({ bell: 26, secondsLeft: 12, ended: false, beforeGenesis: false }, { at: 1, paused: true });
  assert.equal(chip.stopped, true); assert.equal(chip.paused, true);
  assert.equal(chipText(chip), 'Turn 26 · paused'); assert.equal(dialParts(chip).left, 'paused');
  const over = stoppedChip({ bell: 26, secondsLeft: 12, ended: false, beforeGenesis: false }, { at: 1 });
  assert.equal(over.paused, undefined); assert.equal(chipText(over), 'Turn 26 · ended', 'a memory-only test world still says ended');
  setLang('ja'); assert.equal(chipText(chip), 'ターン 26 · 一時停止'); assert.equal(chipText(over), 'ターン 26 · 終了済み'); setLang('en');
});

// ------------------------------------------------------------------ loop-play7: the workshop's name in build labels
// (fix-loop9: screens/wideholding.mjs names a building twice since devnet-p17's wide acts card (queueLabel and itemName), both by buildItemOf; a stale pin on main)
test('loop-play7: build labels name the workshop (item 8), not 「の建設を始めました」', () => {
  assert.equal(BUILDINGS[buildItemOf(WORKSHOP.item)?.resource], '工房');
  for (const [file, n] of [['controller.mjs', 1], ['app.mjs', 1], ['screens/holding.mjs', 1], ['screens/wideholding.mjs', 2], ['screens/villageorders.mjs', 2], ['people/activity.mjs', 1]]) {
    const s = src(file);
    assert.equal((s.match(/BUILDINGS\[BUILD_ITEMS\[/g) ?? []).length, 0, `${file}: no BUILD_ITEMS lookup for a building's name (it has no item 8)`);
    assert.equal((s.match(/BUILDINGS\[buildItemOf\(/g) ?? []).length, n, file);
  }
});
