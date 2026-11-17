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
  assert.deepEqual(P.pendingStep(p, { ...ok, problems: ['NotFinal'], nowBell: 32 }), { act: 'wait' });
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
  assert.match(c, /if \(!c \|\| c\.sending \|\| c\.pending \|\| pendingDriver\.armed \|\| !localMarchTrial\(\)\) return;/, 'no other path arms it');
  assert.match(c, /if \(heldNow\(c\) \|\| !pendable\(problems\)\) return;/, 'never armed past an unknown outcome or a non-settling problem');
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
  assert.match(c, /send: card => \{ card\.pending = null; return sendTheMarch\(\); \},/, 'the send is the ordinary single send');
  assert.match(c, /keyAlive: !!FS\.wallet\?\.address && FS\.wallet\.destroyed !== true, endsAt: localPlay\?\.worldEndsAt \?\? NaN/);
  assert.match(c, /onPageHide: f => \{ globalThis\.addEventListener\?\.\('pagehide', f\);/);
  assert.match(c, /const m = composerMarch\(FS, composerArrival\(FS\)\);\n  const problems = checkMarch\(m\)\.filter\(p => p !== 'NoDestination'\);/);
  const block = c.slice(c.indexOf('const localMarchTrial = '), c.indexOf('async function sendTheMarch()'));
  assert.doesNotMatch(block, /localStorage|sessionStorage|saveUi|indexedDB|book\.|setInterval/, 'memory only; the driver owns the timer');
  assert.match(c, /'march-wait-cancel': \(\) => pendingDriver\.cancel\('cancel'\),/);
  assert.match(c, /'compose-close': \(\) => \{ pendingDriver\.cancel\('cancel'\); FS\.compose = null;/);
  assert.match(c, /const r = localPlay \? await sendMarch\(m, \{/, 'local play: one attempt, no resend (unchanged)');
  // the gate gives the world's end only for a capture-demo start, from its checked expiry statement
  const gate = src('flocalplay.mjs');
  assert.match(gate, /const endAt = launcher && claimedDemo !== null \? worldEndOf\(claimedEnd, claimedMarch\?\.instance \?\? null\) : null;/);
  assert.match(gate, /\.\.\.\(endAt !== null \? \{ worldEndsAt: endAt \} : \{\}\)/);
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
  assert.match(card, /const localWait = !!FS\.localPlay && FS\.localPlay\.march\?\.trialEntry === true && FS\.localMarch\?\.open === true && Number\.isFinite\(FS\.localPlay\.worldEndsAt\);/);
  assert.match(card, /const mainOk = !busy && !waiting && !!c\.route && \(problems\.length === 0 \|\| pendable\(problems\)\);/);
  assert.match(card, /data-act="march-send-wait"/); assert.match(card, /data-act="march-wait-cancel"/);
  assert.match(card, /この命令を1回だけ送ります（ターン \$\{fmtNum\(c\.pending\.untilBell\)\} まで）。到着ターンなど命令の内容が変わったら、送らずに取り消します。/);
  // the seal button's own rule is untouched
  assert.match(card, /data-act="march-send" \$\{raw\(problems\.length \|\| busy \|\| !c\.route \? 'disabled' : ''\)\}/);
});

test('English: every new text, no Japanese, no banned word', () => {
  setLang('en');
  const texts = [L`送信待ちを取り消しました。命令は送られていません。`, L`送信待ちを取り消す`, L`確認した命令で出発`, L`送信待ちです。州のターンの決着がつき次第、この命令を1回だけ送ります（ターン ${36} まで。取り消せます）。`,
    L`押すと、送れる状態ならすぐ送ります。州のターンの決着を待っているときは、この同じ命令のまま整い次第1回だけ送ります（到着ターンなどが変わったら送らずに取り消します）。送った命令は取り消せません。取り消せるのは送信待ちのあいだだけです。`,
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
