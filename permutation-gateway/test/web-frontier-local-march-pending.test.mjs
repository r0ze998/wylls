// TEST-ONLY local play, the march's test entry only: "press now, send when ready" (flocalplay-pending.mjs; controller.mjs
// armMarchWait / pendingTick; hud/marchcard.mjs). Found in a ×60 measurement world (2026-11-14): the seal was possible only
// in windows of 4.7 s and 0.66 s (checkMarch NotResident/NotFinal while the province finishes its previous turn), so a
// person's press often missed. Nothing is loosened: the same checks, the same single send, the same key. These tests hold
// the negative cases: never with another problem, never twice, never after a change/cancel/expiry/close, never after an
// unknown outcome, never revived (memory only), never outside local play's test march.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { L } from '../../permutation-server/web/lang.mjs';
import * as P from '../../permutation-server/web/frontier/flocalplay-pending.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const CJK = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;

const base = () => ({ world: 'inst-1', wallet: 'Wallet1111', holding: { p: 1, q: 1, site: 3, gen: 0 }, host: { id: 77n, troops: 200, unit: 0, tile: 41 }, origin: { p: 1, q: 1 },
  m: { dest: { p: -2, q: 4, tile: 18 }, route: { dirs: [0, 1, 2], provinces: [{ p: 1, q: 1 }, { p: -2, q: 4 }] }, arriveBell: 36, stance: 0, retreat: { choice: 'never', ratio: null }, tip: 5000n } });

test('only the province finishing its previous turn may be waited through', () => {
  assert.deepEqual([...P.SETTLE_CODES], ['NotResident', 'NotFinal']);
  assert.equal(P.pendable(['NotResident']), true);
  assert.equal(P.pendable(['NotFinal', 'NotResident']), true);
  for (const bad of [[], null, undefined, ['ArrivalBell'], ['NotResident', 'Cooldown'], ['NoPath'], ['HostBusy'], ['TipTooLow'], ['NotResident', 'TransitState']]) assert.equal(P.pendable(bad), false, JSON.stringify(bad));
  assert.equal(P.PENDING_MAX_TURNS, 2);
});

test('the order\'s identity covers everything the send carries; any change makes another intent', () => {
  const a = P.intentOf(base());
  assert.equal(typeof a, 'string');
  const mutate = [
    x => { x.world = 'inst-2'; }, x => { x.wallet = 'Wallet2222'; }, x => { x.holding = { ...x.holding, site: 4 }; }, x => { x.host = { ...x.host, id: 78n }; },
    x => { x.host = { ...x.host, troops: 199 }; }, x => { x.host = { ...x.host, tile: 42 }; }, x => { x.origin = { p: 1, q: 2 }; }, x => { x.m.dest = { ...x.m.dest, tile: 19 }; },
    x => { x.m.route = { ...x.m.route, dirs: [0, 1, 3] }; }, x => { x.m.arriveBell = 37; }, x => { x.m.stance = 1; }, x => { x.m.retreat = { choice: 'custom', ratio: 2 }; }, x => { x.m.tip = 6000n; },
  ];
  for (const [i, f] of mutate.entries()) { const b = base(); f(b); assert.notEqual(P.intentOf(b), a, `field ${i}`); }
  // nothing to send → no intent (nothing can be armed)
  for (const f of [x => { x.world = null; }, x => { x.wallet = ''; }, x => { x.m.route = null; }, x => { x.m.dest = null; }, x => { x.m.arriveBell = null; }, x => { x.host = null; }]) { const b = base(); f(b); assert.equal(P.intentOf(b), null); }
});

test('a pending send: sent only when every check passes; otherwise it waits only through settling, and is withdrawn on anything else', () => {
  const intent = P.intentOf(base()), p = P.armPending({ intent, nowBell: 30 });
  assert.deepEqual({ ...p }, { intent, armedBell: 30, untilBell: 32 });
  assert.equal(P.armPending({ intent: null, nowBell: 30 }), null);
  const ok = { intent, problems: [], nowBell: 30, open: true, held: false, busy: false, sameCard: true };
  assert.deepEqual(P.pendingStep(p, ok), { act: 'send' });
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: ['NotResident'] }), { act: 'wait' });
  // (loop-play4 B-2: at its last turn while only the settling blocks it, the limit moves on — the keeper behind under load)
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: ['NotFinal'], nowBell: 31 }), { act: 'wait' });
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: ['NotFinal'], nowBell: 32 }), { act: 'wait', pending: P.extendPending(p, { nowBell: 32 }) });
  assert.deepEqual(P.pendingStep(p, { ...ok, busy: true }), { act: 'wait' }, 'a send in flight: wait, never a second');
  // withdrawn
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: ['ArrivalBell'] }), { act: 'withdraw', why: 'problem' }, 'the arrival window is not waited through');
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: ['NotResident', 'Cooldown'] }), { act: 'withdraw', why: 'problem' });
  assert.deepEqual(P.pendingStep(p, { ...ok, intent: P.intentOf({ ...base(), m: { ...base().m, arriveBell: 37 } }) }), { act: 'withdraw', why: 'changed' }, 'an arrival that moved is never sent silently');
  assert.deepEqual(P.pendingStep(p, { ...ok, sameCard: false }), { act: 'withdraw', why: 'changed' }, 'another card');
  assert.deepEqual(P.pendingStep(p, { ...ok, nowBell: 33 }), { act: 'withdraw', why: 'expired' });
  assert.deepEqual(P.pendingStep(p, { ...ok, nowBell: null }), { act: 'withdraw', why: 'expired' });
  assert.deepEqual(P.pendingStep(p, { ...ok, open: false }), { act: 'withdraw', why: 'closed' }, 'world ended, expired, gate closed or a march held');
  assert.deepEqual(P.pendingStep(p, { ...ok, held: true }), { act: 'withdraw', why: 'unknown' }, 'an earlier outcome unknown: never resent');
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: null }), { act: 'withdraw', why: 'problem' });
  assert.deepEqual(P.pendingStep(null, ok), { act: 'withdraw', why: 'none' });
  // the order of the checks: closed and unknown come before anything that could send
  assert.equal(P.pendingStep(p, { ...ok, open: false, held: true }).why, 'unknown', 'a held march closes the gate too: told as the guide tells it (nothing sent again)');
  assert.equal(P.pendingStep(p, { ...ok, held: true, sameCard: false }).why, 'unknown');
});

test('the controller: armed only on local play\'s test march with a known world end, through the driver, memory only, cancel on close', () => {
  const c = src('controller.mjs');
  assert.match(c, /const localMarchTrial = \(\) => !!localPlay && localPlay\.march\?\.trialEntry === true && FS\.localMarch\?\.open === true && Number\.isFinite\(localPlay\.worldEndsAt\);/);
  // (devnet-page-war-2: or a verified devnet page with its wallet — marchWaitOn; nothing else arms it)
  assert.match(c, /const devnetMarchWait = \(\) => !localPlay && !!devnetPlay && devnetGate\(\)\.ok === true;/);
  assert.match(c, /const marchWaitOn = \(\) => localMarchTrial\(\) \|\| devnetMarchWait\(\);/);
  assert.match(c, /if \(!c \|\| c\.sending \|\| c\.pending \|\| pendingDriver\.armed \|\| !marchWaitOn\(\)\) return;/, 'no other path arms it');
  assert.match(c, /if \(!localPlay && devnetHeldNow\(c\)\) return;/, 'devnet: never armed past an unknown outcome');
  // (2026-11-19, fix-march-held) a held host's press asks about its march (one read) before anything else; a non-settling
  // problem never arms; ready but in the turn's last moments arms the wait (the muster's nearTurnEnd guard)
  assert.match(c, /if \(c && !c\.sending && !c\.pending && !pendingDriver\.armed && localPlay && heldNow\(c\)\) return askHeldMarches\(/, 'never armed past an unknown outcome');
  assert.match(c, /if \(problems\.length > 0 && !pendable\(problems\)\) return;/, 'never armed past a non-settling problem');
  assert.match(c, /if \(problems\.length === 0 && !marchNearEnd\(\)\) \{ FS\.lastAct = MARCH_LAST_ACT\(\); return sendTheMarch\(\); \}/, 'ready and not at the turn end: an ordinary press (named as the march: fix-loop29)');
  assert.match(c, /return loadEnvelope\(card\.origin\.p, card\.origin\.q, 'latest', still\)\.then\(/, 'the read is the ordinary read-only province read');
  assert.match(c, /const still = \(\) => herald === h0 && localPlay === lp0 && \(FS\.wallet\?\.address \?\? null\) === w0 && FS\.wallet\?\.destroyed !== true && pendingDriver\.armed === card;/, 'applied only for the same herald, world, live key and armed card');
  // a stale answer is dropped BEFORE anything is applied
  const le = c.slice(c.indexOf("async function loadEnvelope(p, q, bell = 'latest', still = null) {"), c.indexOf('FS.provinces.set(key,accepted);'));
  assert.ok(le.length > 0 && le.indexOf('if (still && !still()) return null;') > le.indexOf('await herald.province(p, q, bell);'), 'checked after the read, before the set');
  // the page's world is fixed: the herald and the local-play identity are set once, at the start of play
  assert.equal((c.match(/\blocalPlay = cfg\.localPlay \?\? null;/g) ?? []).length, 1);
  assert.equal((c.match(/^  useHerald\(h\);$/gm) ?? []).length, 1, 'startPlay sets the herald once');
  const app = src('app.mjs');
  assert.deepEqual([...app.matchAll(/\buseHerald\(/g)].length, 1, 'the only other caller is spectate mode, which has no local march');
  assert.match(app, /function startSpectate\(herald\) \{\n  useHerald\(herald\);/);
  assert.match(c, /send: card => \{ card\.pending = null; FS\.lastAct = \{ kind: 'act', name: 'march-send', data: \{\} \}; return sendTheMarch\(\); \},/, 'the send is the ordinary single send');
  assert.match(c, /keyAlive: localPlay \? !!FS\.wallet\?\.address && FS\.wallet\.destroyed !== true : dn, endsAt: localPlay \? localPlay\.worldEndsAt \?\? NaN : devnetEndsAt\(\),/);
  assert.match(c, /open: localPlay \? FS\.localMarch\?\.open === true : dn, held: localPlay \? heldNow\(card\) : devnetHeldNow\(card\),/);
  // (devnet-page-war-2) a devnet page re-reads the herald at most every DEVNET_WAIT_REFRESH_MS while it waits
  assert.match(c, /export const DEVNET_WAIT_REFRESH_MS = 5_000;/);
  assert.match(c, /if \(!localPlay\) \{ const t = Date\.now\(\); if \(t - devnetWaitRead < DEVNET_WAIT_REFRESH_MS\) return Promise\.resolve\(\); devnetWaitRead = t; \}/);
  assert.match(c, /onPageHide: f => \{ globalThis\.addEventListener\?\.\('pagehide', f\);/);
  assert.match(c, /const m = composerMarch\(FS, composerArrival\(FS\)\);\n  const problems = checkMarch\(m\)\.filter\(p => p !== 'NoDestination'\);/);
  const block = c.slice(c.indexOf('const localMarchTrial = '), c.indexOf('async function sendTheMarch()'));
  assert.doesNotMatch(block, /localStorage|sessionStorage|saveUi|indexedDB|book\.|setInterval|sign[T]ransaction/, 'memory only; the driver owns the timer; nothing is signed while it waits');
  assert.match(c, /'march-wait-cancel': \(\) => pendingDriver\.cancel\('cancel'\),/);
  assert.match(c, /'compose-close': \(\) => \{ pendingDriver\.cancel\('cancel'\); FS\.compose = null;/);
  assert.match(c, /\}\) : localPlay \? await sendMarch\(m, \{/, 'local play: one attempt, no resend (unchanged; devnet-page-war: after the devnet sender\'s own branch)');
  // the gate gives the world's end for EVERY launcher start (kept, plain, wide, demo — loop-play4 B-3: only the demo had
  // it, so every other world's pending send was withdrawn as 'closed' at once), from its checked expiry statement
  const gate = src('flocalplay.mjs');
  assert.match(gate, /const endAt = launcher \? worldEndOf\(claimedEnd, claimedMarch\?\.instance \?\? null\) : null;/);
  assert.match(gate, /const playedEnd = endAt !== null \? Object\.freeze\(\{ \.\.\.played, worldEndsAt: endAt \}\) : played;/);
  assert.doesNotMatch(gate, /claimedDemo !== null \? worldEndOf/);
});

// ---- the driver, with counted calls: fake timers, a clock the test moves, refreshes the test resolves
function harness({ ready = false, endsAt = 1e12 } = {}) {
  const calls = { look: 0, refresh: 0, send: 0, withdrawn: [], timers: 0, cleared: 0, hide: 0, unhide: 0 };
  const state = { intent: P.intentOf(base()), problems: ready ? [] : ['NotResident'], nowBell: 30, open: true, held: false, busy: false, sameCard: true, keyAlive: true, endsAt };
  let t = 0, timer = null, hideFn = null; const refreshes = [];
  const d = P.createPendingDriver({
    look: () => { calls.look++; return { ...state }; },
    refresh: () => { calls.refresh++; let done; const pr = new Promise(r => { done = r; }); refreshes.push(done); return pr; },
    send: () => { calls.send++; },
    withdrawn: (card, why) => { calls.withdrawn.push(why); },
    now: () => t, setTimer: f => { calls.timers++; timer = f; return 1; }, clearTimer: () => { calls.cleared++; timer = null; },
    onPageHide: f => { calls.hide++; hideFn = f; return () => { calls.unhide++; hideFn = null; }; },
  });
  const card = { id: 'card' }, pending = P.armPending({ intent: state.intent, nowBell: 30 });
  const flush = () => new Promise(r => setImmediate(r));
  return { d, calls, state, card, pending, refreshes, flush, advance: ms => { t += ms; }, fire: () => timer?.(), hide: () => hideFn?.(), get timer() { return timer; } };
}

test('driver: ready → exactly one send; the timer and the page-hide hook are released; no second send', async () => {
  const h = harness();
  assert.equal(h.d.arm(h.card, h.pending), true); assert.equal(h.d.arm(h.card, h.pending), false, 'one at a time');
  h.fire(); assert.equal(h.calls.send, 0); assert.equal(h.calls.refresh, 1, 'waiting: one read');
  h.state.problems = []; h.fire();
  assert.deepEqual([h.calls.send, h.calls.withdrawn.length, h.calls.cleared, h.calls.unhide], [1, 0, 1, 1]);
  h.fire(); h.fire(); h.refreshes.forEach(r => r()); await h.flush(); h.fire();
  assert.equal(h.calls.send, 1, 'never twice, not even when the old read answers');
  assert.equal(h.d.armed, null);
});

test('driver: one read at a time, not more often than its interval, only while armed', async () => {
  const h = harness(); h.d.arm(h.card, h.pending);
  h.fire(); assert.equal(h.calls.refresh, 1);
  for (let i = 0; i < 10; i++) { h.advance(30); h.fire(); }
  assert.equal(h.calls.refresh, 1, 'a read in flight: no second read');
  h.refreshes[0](); await h.flush();
  assert.equal(h.calls.refresh, 1, 'answered within the interval: no new read yet');
  h.advance(P.PENDING_REFRESH_MS - 300); h.fire(); assert.equal(h.calls.refresh, 2, 'the interval passed: the next read');
  for (let i = 0; i < 5; i++) { h.advance(1000); h.fire(); }
  assert.equal(h.calls.refresh, 2, 'that read still in flight: no third');
  h.d.cancel(); h.refreshes[1](); await h.flush();
  for (let i = 0; i < 5; i++) { h.advance(1000); h.fire(); }
  assert.equal(h.calls.refresh, 2, 'cancelled: no more reads'); assert.equal(h.calls.send, 0);
});

test('driver: a read that answers after a cancel, a destroyed key, another world or a changed order never sends', async () => {
  for (const [what, change, why] of [
    ['cancel', h => h.d.cancel('cancel'), 'cancel'],
    ['key destroyed', h => { h.state.keyAlive = false; }, 'closed'],
    ['another world', h => { h.state.intent = P.intentOf({ ...base(), world: 'inst-2' }); }, 'changed'],
    ['arrival moved', h => { h.state.intent = P.intentOf({ ...base(), m: { ...base().m, arriveBell: 37 } }); }, 'changed'],
    ['card closed', h => { h.state.sameCard = false; }, 'changed'],
    ['gate closed', h => { h.state.open = false; }, 'closed'],
    ['earlier outcome unknown', h => { h.state.held = true; }, 'unknown'],
  ]) {
    const h = harness(); h.d.arm(h.card, h.pending); h.fire();
    assert.equal(h.calls.refresh, 1, what);
    change(h); h.state.problems = [];   // the read would have made it ready
    h.refreshes[0](); await h.flush(); h.fire();
    assert.equal(h.calls.send, 0, `${what}: 0 sends`);
    assert.deepEqual(h.calls.withdrawn, [why], `${what}: withdrawn once, told why`);
    assert.equal(h.d.armed, null);
  }
});

test('driver: the world\'s absolute end and the page being hidden withdraw at once, ready or not; a failed read sends nothing', async () => {
  { const h = harness({ ready: true, endsAt: 5000 }); h.advance(5000); h.d.arm(h.card, h.pending); h.fire();
    assert.deepEqual([h.calls.send, h.calls.withdrawn], [0, ['closed']], 'at the end, even when ready'); }
  { const h = harness({ endsAt: NaN }); h.d.arm(h.card, h.pending); h.fire(); assert.deepEqual([h.calls.send, h.calls.withdrawn], [0, ['closed']], 'an unknown end'); }
  { const h = harness(); h.d.arm(h.card, h.pending); h.fire(); h.hide();
    assert.deepEqual([h.calls.send, h.calls.withdrawn, h.calls.unhide], [0, ['closed'], 1], 'pagehide');
    h.state.problems = []; h.refreshes[0](); await h.flush(); h.fire(); assert.equal(h.calls.send, 0); }
  { const calls = { send: 0, w: [] }; let f = null;
    const d = P.createPendingDriver({ look: () => ({ intent: 'i', problems: ['NotResident'], nowBell: 1, open: true, held: false, busy: false, sameCard: true, keyAlive: true, endsAt: 1e12 }),
      refresh: () => Promise.reject(new Error('herald down')), send: () => { calls.send++; }, withdrawn: (c, w) => calls.w.push(w), now: () => 0, setTimer: g => { f = g; return 1; }, clearTimer: () => {} });
    d.arm({}, P.armPending({ intent: 'i', nowBell: 1 })); f(); await new Promise(r => setImmediate(r));
    assert.deepEqual([calls.send, calls.w, d.armed !== null], [0, [], true], 'a failed read: still waiting, nothing sent'); }
});

test('driver: armed again while an old read is in flight — the old answer never acts for the new arming, and reads stay single', async () => {
  const h = harness(); h.d.arm(h.card, h.pending); h.fire(); assert.equal(h.calls.refresh, 1);
  h.d.cancel('cancel');
  const card2 = { id: 'card2' }; assert.equal(h.d.arm(card2, h.pending), true);
  h.advance(1000); h.fire(); assert.equal(h.calls.refresh, 1, 'the old read is still in flight: no second read');
  h.state.problems = []; h.refreshes[0](); await h.flush();
  assert.equal(h.calls.send, 0, 'the old read\'s answer does not tick for the new arming');
  h.fire(); assert.equal(h.calls.send, 1, 'the new arming sends on its own look');
});

test('the card offers it only on the test march (one fixed main button since round 12: web-frontier-local-fixed-seal.test.mjs), says what one press does, and its cancel', () => {
  const card = src('hud/marchcard.mjs');
  assert.match(card, /const localWait = FS\.marchWaitOn === true \|\| \(!!FS\.localPlay && FS\.localPlay\.march\?\.trialEntry === true && FS\.localMarch\?\.open === true && Number\.isFinite\(FS\.localPlay\.worldEndsAt\)\);/);
  assert.match(card, /const devnetWait = localWait && !FS\.localPlay;/);
  assert.match(card, /const mainOk = !busy && !waiting && !!c\.route && \(problems\.length === 0 \|\| pendable\(problems\)\);/);
  assert.match(card, /data-act="march-send-wait"/); assert.match(card, /data-act="march-wait-cancel"/);
  assert.match(card, /この命令を1回だけ送ります（ターン \$\{fmtNum\(c\.pending\.untilBell\)\} まで）。到着ターンなど命令の内容が変わったら、送らずに取り消します。/);
  // the seal button's own rule is untouched
  assert.match(card, /data-act="march-send" \$\{raw\(problems\.length \|\| busy \|\| !c\.route \? 'disabled' : ''\)\}/);
});

test('English: every new text, no Japanese, no banned word', () => {
  setLang('en');
  const texts = [L`送信待ちを取り消しました。命令は送られていません。`, L`送信待ちを取り消す`, L`確認した命令で出発`, L`送信待ちです。州のターンの決着がつき次第、この命令を1回だけ送ります（ターン ${36} まで。取り消せます）。`,
    L`押すと、送れる状態ならすぐ送ります。州のターンの決着を待っているときは、この同じ命令のまま整い次第1回だけ送ります（時間が進んで到着ターンが先へ動いたときは、その到着ターンで送ります。ほかの内容が変わったら送らずに取り消します）。送った命令は取り消せません。取り消せるのは送信待ちのあいだだけです。`,
    L`送信待ちを取り消しました。前に送った命令の結果がまだわからないためです。送り直しはしません。`];
  for (const t of texts) { assert.doesNotMatch(t, CJK, t); assert.doesNotMatch(t, BANNED_EN, t); }
  assert.match(texts[3], /until turn 36/);
});

test('the world\'s end the page holds: only from a well-formed expiry statement of this runner instance, else none', async () => {
  const { worldEndOf } = await import('../../permutation-server/web/frontier/flocalplay-instance.mjs');
  const { WORLD_EXPIRY_SCHEMA } = await import('../../permutation-server/web/frontier/flocalplay-expiry.mjs');
  const inst = 'ab'.repeat(32), e = { schema: WORLD_EXPIRY_SCHEMA, startedAt: 1000, ttlMs: 2700000, expiresAt: 2701000, instance: inst };
  assert.equal(worldEndOf(e, inst, 5000), 2701000);
  assert.equal(worldEndOf(e, inst, 9e12), 2701000, 'already past: still that end (the driver withdraws at once)');
  for (const [x, i, why] of [[null, inst, 'absent'], [{ ...e, expiresAt: 2701001 }, inst, 'inconsistent'], [e, 'cd'.repeat(32), 'another instance'], [e, null, 'no instance'], [{ ...e, extra: 1 }, inst, 'more keys']]) assert.equal(worldEndOf(x, i, 5000), null, why);
});

// ---- loop-play4 B-2: the keeper behind under machine load (the province 2–21 turns behind): the wait goes on, and says why
test('B-2: provinceLag is the province\'s turns behind the chain (0 when caught up, null when unknown)', () => {
  assert.equal(P.PENDING_LAG_TURNS, 2);
  assert.equal(P.provinceLag({ resolvedNext: 29 }, 30), 0, 'resolved through the previous turn: caught up');
  assert.equal(P.provinceLag({ resolvedNext: 40 }, 30), 0);
  assert.equal(P.provinceLag({ resolvedNext: 28 }, 30), 1, 'one behind: the turn\'s ordinary settling');
  assert.equal(P.provinceLag({ resolvedNext: 9 }, 30), 20);
  for (const [pr, b] of [[null, 30], [{}, 30], [{ resolvedNext: 1.5 }, 30], [{ resolvedNext: 3 }, null]]) assert.equal(P.provinceLag(pr, b), null);
});

test('B-2: only-settling at the turn limit extends (fresh limit, counted); anything else still withdraws as before', () => {
  const intent = P.intentOf(base()), p = P.armPending({ intent, nowBell: 30 });
  const ok = { intent, problems: ['NotResident'], nowBell: 32, open: true, held: false, busy: false, sameCard: true };
  const s1 = P.pendingStep(p, ok);
  assert.equal(s1.act, 'wait'); assert.deepEqual({ ...s1.pending }, { intent, armedBell: 30, untilBell: 34, extended: 1 });
  // twenty turns behind: extended again and again, never 'expired' while only the settling blocks it
  let q = s1.pending;
  for (let b = 34; b <= 52; b += 2) { const s = P.pendingStep(q, { ...ok, nowBell: b }); assert.equal(s.act, 'wait', `turn ${b}`); if (s.pending) q = s.pending; }
  assert.equal(q.untilBell, 54); assert.equal(q.extended, 11);
  // caught up: sent once, for the same order
  assert.deepEqual(P.pendingStep(q, { ...ok, problems: [], nowBell: 53 }), { act: 'send' });
  // never extended for anything else
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: [], nowBell: 33 }), { act: 'withdraw', why: 'expired' }, 'past the limit and not settling: expired, as before');
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: ['NotResident', 'Cooldown'] }), { act: 'withdraw', why: 'problem' });
  assert.deepEqual(P.pendingStep(p, { ...ok, open: false }), { act: 'withdraw', why: 'closed' });
  assert.deepEqual(P.pendingStep(p, { ...ok, held: true }), { act: 'withdraw', why: 'unknown' });
  assert.deepEqual(P.pendingStep(p, { ...ok, sameCard: false }), { act: 'withdraw', why: 'changed' });
  assert.deepEqual(P.pendingStep(p, { ...ok, nowBell: null }), { act: 'withdraw', why: 'expired' });
});

test('B-2: the driver keeps the arming past its limit, tells the lag when it changes (≥ 2 turns), and still sends exactly once', () => {
  let timer = null; const told = [], sent = [], gone = [];
  const state = { intent: 'I', problems: ['NotResident'], nowBell: 10, open: true, held: false, busy: false, sameCard: true, keyAlive: true, endsAt: 1e15, lag: 1 };
  const d = P.createPendingDriver({ look: () => ({ ...state }), refresh: () => Promise.resolve(), send: c => sent.push(c), withdrawn: (c, w) => gone.push(w),
    lagging: (c, p, lag) => told.push([p.untilBell, lag]), now: () => 0, setTimer: f => { timer = f; return 1; }, clearTimer: () => { timer = null; } });
  d.arm({ id: 1 }, P.armPending({ intent: 'I', nowBell: 10 }));
  timer(); assert.deepEqual(told, [], 'one turn behind: the ordinary settling, nothing said');
  state.lag = 3; timer(); timer(); assert.deepEqual(told, [[12, 3]], 'three behind: said once');
  state.nowBell = 12; state.lag = 3; timer(); assert.deepEqual(told.at(-1), [14, 3], 'the limit moved on: said with the new limit');
  for (let b = 13; b <= 40; b++) { state.nowBell = b; state.lag = 20; timer(); }
  assert.deepEqual(gone, [], 'never withdrawn while only the settling blocks it');
  assert.ok(d.armed);
  state.problems = []; state.lag = 0; timer(); timer?.();
  assert.equal(sent.length, 1, 'caught up: sent once'); assert.equal(d.armed, null);
});

test('B-2: the page says the load (JA/EN) on the waiting notices and on the Form a host card', async () => {
  const c = src('controller.mjs');
  assert.match(c, /lag: provinceLag\(FS\.provinces\.get\(`\$\{card\.origin\?\.p\},\$\{card\.origin\?\.q\}`\)\?\.province, nowBell\(\)\) \};/);
  assert.match(c, /lag: provinceLag\(FS\.provinces\.get\(`\$\{card\.holding\.p\},\$\{card\.holding\.q\}`\)\?\.province, nowBell\(\)\) \};/);
  assert.match(c, /lagging: \(card, p, lag\) => \{ card\.pending = p; setNotice\(\{ busy: false, waiting: true, text: lagWaitText\(lag, p\.untilBell, 'march', \{ devnet: !localPlay \}\) \}\); \},/);
  assert.match(c, /lagging: \(card, p, lag\) => \{ FS\.musterWait = \{ untilBell: p\.untilBell, lag \}; setNotice\(\{ busy: false, waiting: true, text: lagWaitText\(lag, p\.untilBell, 'muster'\) \}\); \},/);
  const hand = src('hud/hand.mjs');
  assert.match(hand, /const lag = local \? provinceLag\(FS\.provinces\?\.get\(`\$\{h\.p\},\$\{h\.q\}`\)\?\.province, FS\.nowBell\) : null;/);
  const ja = [L`この州の決着が ${20} ターン遅れています。このマシンの負荷が高く、世界の進行（ターンの決着）が追いついていないためです。送信待ちはそのまま続け、州が追いつき次第${L`この編成`}を1回だけ送ります。押し直す必要はありません（取り消せます）。`,
    L`送信待ちを続けています。州のターンの決着がまだつかないため、待つ期限をターン ${14} まで延ばしました。決着がつき次第${L`この命令`}を1回だけ送ります（取り消せます）。`,
    L`この州の決着が ${3} ターン遅れています。このマシンの負荷が高く、世界の進行が追いついていないためです。`, L`決着が追いつくまで、送信待ちは自動で延ばします。`];
  for (const s of ja) assert.match(s, CJK);
  setLang('en');
  const en = [L`この州の決着が ${20} ターン遅れています。このマシンの負荷が高く、世界の進行（ターンの決着）が追いついていないためです。送信待ちはそのまま続け、州が追いつき次第${L`この編成`}を1回だけ送ります。押し直す必要はありません（取り消せます）。`,
    L`送信待ちを続けています。州のターンの決着がまだつかないため、待つ期限をターン ${14} まで延ばしました。決着がつき次第${L`この命令`}を1回だけ送ります（取り消せます）。`,
    L`この州の決着が ${3} ターン遅れています。このマシンの負荷が高く、世界の進行が追いついていないためです。`, L`決着が追いつくまで、送信待ちは自動で延ばします。`];
  for (const s of en) { assert.doesNotMatch(s, CJK, s); assert.doesNotMatch(s, BANNED_EN, s); }
  assert.match(en[0], /20 behind: this machine is under heavy load.*this order to form a host is sent once/);
});

test('verify-pr98 BREAK-1: the settling is judged at the chain\'s turn now, so a turn change never sends into a refusal', () => {
  // the program's rule (fland.mjs actionBlocks): NotResident while resolvedNext + 1 < nowBell
  assert.deepEqual(P.settleNow([], { resolvedNext: 218 }, 220), ['NotResident'], 'the page\'s model still on turn 219: the province has not settled 219');
  assert.deepEqual(P.settleNow([], { resolvedNext: 219 }, 220), [], 'settled through the previous turn: nothing added');
  assert.deepEqual(P.settleNow(['NotFinal'], { resolvedNext: 200 }, 220), ['NotFinal', 'NotResident']);
  assert.deepEqual(P.settleNow(['NotResident'], { resolvedNext: 200 }, 220), ['NotResident'], 'never twice');
  assert.deepEqual(P.settleNow(['Cooldown'], { resolvedNext: 200 }, 220), ['Cooldown', 'NotResident'], 'another problem stays: still withdrawn');
  for (const [pr, b] of [[null, 220], [{}, 220], [{ resolvedNext: 1.5 }, 220], [{ resolvedNext: 3 }, null]]) assert.deepEqual(P.settleNow([], pr, b), [], 'unknown: unchanged');
  assert.equal(P.settleNow(null, { resolvedNext: 1 }, 220), null);
  // so the step waits (and extends at its limit) instead of sending
  const intent = P.intentOf(base()), p = P.armPending({ intent, nowBell: 219 });
  const look = { intent, nowBell: 220, open: true, held: false, busy: false, sameCard: true };
  assert.deepEqual(P.pendingStep(p, { ...look, problems: [] }), { act: 'send' }, 'the model\'s stale view alone would send');
  assert.equal(P.pendingStep(p, { ...look, problems: P.settleNow([], { resolvedNext: 218 }, 220) }).act, 'wait');
  assert.deepEqual(P.pendingStep(p, { ...look, problems: P.settleNow([], { resolvedNext: 219 }, 220) }), { act: 'send' });
});

test('verify-pr98 BREAK-1: both drivers look with settleNow, and their send names its own order for a refusal and its "try again"', () => {
  const c = src('controller.mjs');
  assert.match(c, /return \{ \.\.\.now, problems: settleNow\(now\.problems, origin, nowBell\(\)\), nowBell: nowBell\(\),/);
  assert.match(c, /return \{ intent: n\.intent, problems: settleNow\(n\.problems, province, nowBell\(\)\), nowBell: nowBell\(\),/);
  assert.match(c, /send: card => \{ card\.pending = null; FS\.lastAct = \{ kind: 'act', name: 'march-send', data: \{\} \}; return sendTheMarch\(\); \},/);
  // (fix-loop29: the muster's lastAct is one shared helper — flocalplay-muster-wait.mjs musterLastAct — for both the waiting
  //  send and the immediate one)
  assert.match(c, /FS\.lastAct = musterLastAct\(card\.draft\);\n    invalidate\('panel'\);\n    return musterOrder\(/);
  // (the retry runs ACTIONS[FS.lastAct.name](data): both names are the page's own direct sends)
  assert.match(c, /  muster: d => musterOrder\(num\(d\.unit\), num\(d\.troops\), d\.tile === undefined \|\| d\.tile === '' \? null : num\(d\.tile\)\),/);
  assert.match(c, /  'march-send': \(\) => sendTheMarch\(\),/);
});
