// The launcher world's end, confirmed before it is shown (web/frontier/flocalplay-instance.mjs, the standing notice's
// showEnd, and the gate that calls them once after the world was verified).
//
// THIS FILE MAKES NO KEY and runs under the no-key guard:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/web-frontier-local-play-world-instance.test.mjs
// The gate's memory-only wallet is a stand-in with a public address and nothing else (`makeWallet`); a stub document,
// stub herald clients and a stub `request`. No page boot, network, chain, runner, world or stored key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import { readWorldInstance, confirmWorldEnd, WORLD_INSTANCE_PATH, WORLD_INSTANCE_SCHEMA } from '../../permutation-server/web/frontier/flocalplay-instance.mjs';
import { mountSessionNotice, endTimeText } from '../../permutation-server/web/frontier/flocalplay-session.mjs';
import { WORLD_EXPIRY_SCHEMA } from '../../permutation-server/web/frontier/flocalplay-expiry.mjs';
import { decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';

const SEASON_ID = '11', ADDRS = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, SEASON_ID);
const CFG = { origin: 'http://127.0.0.1:41920', herald: 'http://127.0.0.1:41920', relay: 'http://127.0.0.1:41920/gw', dev: true, mode: 'play' };
const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, origin: u.origin }; };
const launcherLoc = () => loc('http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off');
const ME = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', W1 = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
const HERALD = 'http://localhost:41926', INSTANCE = 'ab'.repeat(32), OTHER = 'cd'.repeat(32);
const T0 = 1_800_000_000_000, TTL = 7_200_000;
const EXP = (over = {}) => ({ schema: WORLD_EXPIRY_SCHEMA, startedAt: T0 - 60_000, ttlMs: TTL, expiresAt: T0 - 60_000 + TTL, instance: INSTANCE, ...over });

function stubDocument() {
  const all = [], doc = { focused: null };
  const make = tag => {
    const listeners = {};
    const el = { tag, className: '', textContent: '', id: '', hidden: false, disabled: false, value: '', dataset: {}, attrs: {}, children: [], parent: null, listeners, ownerDocument: doc,
      setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { for (const x of xs) { x.parent = el; el.children.push(x); } }, prepend(x) { x.parent = el; el.children.unshift(x); }, addEventListener(k, f) { (listeners[k] ??= []).push(f); },
      focus() { doc.focused = el; }, click() { for (const f of listeners.click ?? []) f(); return true; } };
    all.push(el); return el;
  };
  const body = make('body'), head = make('head');
  return Object.assign(doc, { body, head, createElement: make, byId: id => all.find(e => e.id === id), byClass: c => all.filter(e => e.className.split(' ').includes(c)), all });
}
function maker(address = ME) {
  const made = [];
  const make = async options => { const w = { address, destroyed: false, destroy() { w.destroyed = true; }, announce() {} }; made.push({ wallet: w, options }); return w; };
  return Object.assign(make, { made });
}
function heralds() {
  const h = { calls: 0 };
  h.make = () => ({ season: async () => { h.calls++; return { ok: true, record: { programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', season: SEASON_ID, seasonAddress: ADDRS.season }, season: { programVersion: 0x4804, seasonId: 11n } }; },
    me: async address => ({ ok: true, citizen: { wallet: fromB58(address) }, holdings: [{}] }), pin() {} });
  return h;
}
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const endPoint = doc => doc.byClass('local-play-session-point')[1].textContent;
const UNKNOWN = /このページでは確認できません/;

/** The gate in launcher mode; `answer.start` / `answer.instance` are the launcher's and the relay's (stubs). */
function open({ start = () => reply(200, { herald: HERALD, expiry: EXP() }), instance = () => reply(200, { wallet: ME, instance: INSTANCE }) } = {}) {
  const doc = stubDocument(), win = new EventTarget(), h = heralds(), calls = [], make = maker();
  const answer = { start, instance };
  const request = async (url, options) => { calls.push([url, options]); return url.endsWith(WORLD_INSTANCE_PATH) ? answer.instance(url, options) : answer.start(url, options); };
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc, win, makeHerald: h.make, request, makeWallet: make, now: () => T0 });
  return { gate, doc, win, calls, make, answer };
}
async function connected(o) {
  for (let i = 0; i < 500 && o.gate.state().phase === 'creating'; i++) await settle(1);
  await o.gate.connect(); await o.gate.ready; await settle();
  assert.equal(o.gate.state().phase, 'connected');
  return o;
}
const reads = calls => calls.filter(([url]) => url.endsWith(WORLD_INSTANCE_PATH));

test('confirmed: the real end time is shown in either language, after ONE same-origin read of the verified herald\'s relay', async () => {
  const before = lang();
  try {
    setLang('ja');
    const o = await connected(open());
    const when = endTimeText(EXP().expiresAt);
    const d = new Date(EXP().expiresAt), two = n => String(n).padStart(2, '0');
    assert.equal(when, `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`);
    assert.equal(endPoint(o.doc), `この世界は ${when} ごろに自動的に終わります（開始サービスが決めた時刻。この端末の時計で表示）。`);
    assert.equal(o.gate.notice().endState(), 'known');
    setLang('en');
    assert.equal(endPoint(o.doc), `This world ends by itself at about ${when} (the time set by the start service, shown in this device's clock).`);
    // exactly two requests: the start, then the one read — a same-origin POST of the schema alone, no credentials, no redirect, no cache
    assert.equal(o.calls.length, 2);
    const [[url, opt]] = reads(o.calls);
    assert.equal(url, `${HERALD}/gw/f/local-play/act/context`);
    assert.deepEqual({ ...opt, signal: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: WORLD_INSTANCE_SCHEMA }), signal: undefined, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    assert.equal(o.make.made.length, 1, 'no other key'); assert.equal(o.gate.wallet().destroyed, false);
  } finally { setLang(before); }
});

test('the boot does not wait for the read: a read that never answers leaves the world connected and the end unknown', async () => {
  const o = open({ instance: () => new Promise(() => {}) });
  await connected(o);
  assert.match(endPoint(o.doc), UNKNOWN); assert.equal(o.gate.notice().endState(), 'unknown');
  assert.equal(reads(o.calls).length, 1);
});

test('every other answer leaves the end unknown and the connection as it is: older relay, 404, no pin, failure, another instance, wallet or shape', async () => {
  const cases = {
    'older relay (v1 only)': () => reply(400, { error: 'invalid local-play command request', code: 'LocalActInvalid' }),
    'no economy routes': () => reply(404, { error: 'not found' }),
    'no pinned instance': () => reply(404, { error: 'x', code: 'LocalActNoInstance' }),
    'runner unavailable': () => reply(503, { error: 'x', code: 'LocalActRpcUnavailable' }),
    'request throws': () => { throw new TypeError('network'); },
    'body not JSON': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }),
    'another instance': () => reply(200, { wallet: ME, instance: OTHER }),
    'instance missing': () => reply(200, { wallet: ME }),
    'instance null': () => reply(200, { wallet: ME, instance: null }),
    'instance zero': () => reply(200, { wallet: ME, instance: '0'.repeat(64) }),
    'instance upper-case': () => reply(200, { wallet: ME, instance: INSTANCE.toUpperCase() }),
    'more in the body': () => reply(200, { wallet: ME, instance: INSTANCE, expiresAt: T0 }),
    'another wallet': () => reply(200, { wallet: W1, instance: INSTANCE }),
    'the v1 answer': () => reply(200, { wallet: ME, blockhash: { hash: 'x', last_valid_block_height: '1', context_slot: '1' } }),
    'an array': () => reply(200, [ME, INSTANCE]),
  };
  for (const [name, instance] of Object.entries(cases)) {
    const o = await connected(open({ instance }));
    assert.match(endPoint(o.doc), UNKNOWN, name); assert.equal(o.gate.notice().endState(), 'unknown', name);
    assert.equal(o.gate.state().phase, 'connected', name); assert.equal(o.calls.length, 2, `${name}: asked once, never again`);
  }
});

test('no statement worth confirming: nothing is asked (no expiry, no instance in it, malformed)', async () => {
  for (const [name, body] of Object.entries({
    'no expiry': { herald: HERALD }, 'instance null': { herald: HERALD, expiry: EXP({ instance: null }) },
    'inconsistent': { herald: HERALD, expiry: EXP({ expiresAt: T0 }) }, 'another schema': { herald: HERALD, expiry: EXP({ schema: 'x' }) },
    'more keys': { herald: HERALD, expiry: { ...EXP(), extra: 1 } },
  })) {
    const o = await connected(open({ start: () => reply(200, body) }));
    assert.equal(reads(o.calls).length, 0, name); assert.match(endPoint(o.doc), UNKNOWN, name);
  }
});

test('the statement\'s instance differs from the one the relay confirms: unknown (the statement\'s own instance confirms nothing)', async () => {
  const o = await connected(open({ start: () => reply(200, { herald: HERALD, expiry: EXP({ instance: OTHER }) }) }));
  assert.equal(reads(o.calls).length, 1); assert.match(endPoint(o.doc), UNKNOWN);
});

test('the page goes away while the read is awaited: the key is discarded, nothing is shown but that, nothing more is asked', async () => {
  let release; const held = new Promise(r => { release = r; });
  const o = await connected(open({ instance: async () => { await held; return reply(200, { wallet: ME, instance: INSTANCE }); } }));
  o.win.dispatchEvent(new Event('pagehide'));
  release(); await settle();
  assert.equal(o.gate.wallet().destroyed, true); assert.equal(o.gate.notice().isDestroyed(), true);
  assert.equal(o.gate.notice().endState(), 'unknown', 'the late answer was dropped');
  assert.equal(o.doc.byClass('local-play-session-points')[0].hidden, true); assert.equal(o.doc.byClass('local-play-session-gone')[0].hidden, false);
  assert.equal(o.calls.length, 2); assert.equal(o.make.made.length, 1);
});

test('a known end, then the page goes away: the key-discarded line takes over, the end is not shown', async () => {
  const o = await connected(open());
  assert.equal(o.gate.notice().endState(), 'known');
  o.win.dispatchEvent(new Event('pagehide')); o.win.dispatchEvent(new Event('pageshow'));
  assert.equal(o.doc.byClass('local-play-session-points')[0].hidden, true); assert.equal(o.doc.byClass('local-play-session-gone')[0].hidden, false);
  o.gate.notice().showEnd({ state: 'known', instance: INSTANCE, expiresAt: T0 + 1, ttlMs: TTL, remainingMs: 1 });
  assert.equal(o.doc.byClass('local-play-session-points')[0].hidden, true, 'nothing is shown after the key is gone');
});

test('the scope changed while the read was awaited (another wallet or herald): the answer is dropped', async () => {
  const doc = stubDocument(), win = new EventTarget(), notice = mountSessionNotice({ doc, win });
  let same = true, release; const held = new Promise(r => { release = r; });
  const request = async () => { await held; return reply(200, { wallet: ME, instance: INSTANCE }); };
  const p = confirmWorldEnd({ expiry: EXP(), origin: HERALD, wallet: ME, request, notice, still: () => same, now: () => T0 });
  same = false; release();
  assert.equal(await p, null); assert.equal(notice.endState(), 'unknown'); assert.match(endPoint(doc), UNKNOWN);
  notice.unmount();
});

test('the same world\'s end changing is not believed: once shown, another end (or none) makes it unknown for good', () => {
  const doc = stubDocument(), notice = mountSessionNotice({ doc, win: new EventTarget() });
  const known = (over = {}) => ({ state: 'known', instance: INSTANCE, expiresAt: EXP().expiresAt, ttlMs: TTL, remainingMs: 1, ...over });
  notice.showEnd({ state: 'unknown', why: 'absent' }); assert.equal(notice.endState(), 'unknown');
  notice.showEnd(known()); assert.equal(notice.endState(), 'known');
  notice.showEnd(known({ remainingMs: 0 })); assert.equal(notice.endState(), 'known', 'the same end again is kept');
  notice.showEnd(known({ expiresAt: EXP().expiresAt + 3_600_000, ttlMs: TTL + 3_600_000 })); assert.equal(notice.endState(), 'unknown', 'a later end of the same world');
  assert.match(endPoint(doc), UNKNOWN);
  notice.showEnd(known()); assert.equal(notice.endState(), 'unknown', 'latched: not even the first end again');
  notice.unmount();
  const b = mountSessionNotice({ doc: stubDocument(), win: new EventTarget() });
  b.showEnd(known()); b.showEnd({ state: 'unknown', why: 'other-instance' }); assert.equal(b.endState(), 'unknown', 'an end that turns unknown stays unknown');
  b.showEnd(known({ instance: OTHER })); assert.equal(b.endState(), 'unknown');
  b.unmount();
});

test('the gate, case by case: late answer then pagehide; another wallet; 404 with the boot already done; known → mismatch → known stays unknown', async () => {
  // a late answer that arrives after pagehide is dropped; the boot had resolved before it
  { let release; const held = new Promise(r => { release = r; });
    const o = open({ instance: async () => { await held; return reply(200, { wallet: ME, instance: INSTANCE }); } });
    let booted = null; o.gate.ready.then(v => { booted = v; });
    await connected(o); assert.ok(booted && booted.cfg.herald === HERALD, 'booted while the read is pending');
    o.win.dispatchEvent(new Event('pagehide')); release(); await settle();
    assert.equal(o.gate.notice().endState(), 'unknown'); assert.equal(o.doc.byClass('local-play-session-gone')[0].hidden, false); assert.equal(o.calls.length, 2); }
  // the page became another wallet while the read was awaited (the handle's address changed): dropped
  { let release; const held = new Promise(r => { release = r; });
    const o = open({ instance: async () => { await held; return reply(200, { wallet: ME, instance: INSTANCE }); } });
    await connected(o); o.gate.wallet().address = W1; release(); await settle();
    assert.equal(o.gate.notice().endState(), 'unknown'); assert.match(endPoint(o.doc), UNKNOWN); }
  // the relay answers for another wallet: unknown
  { const o = await connected(open({ instance: () => reply(200, { wallet: W1, instance: INSTANCE }) }));
    assert.equal(o.gate.notice().endState(), 'unknown'); }
  // 404 (no economy routes / an older relay): the boot went on, connected, the end unknown, asked once
  { const o = open({ instance: () => reply(404, { error: 'not found' }) }); let booted = null; o.gate.ready.then(v => { booted = v; });
    await connected(o); assert.ok(booted && booted.cfg.relay === `${HERALD}/gw` && booted.cfg.localPlay);
    assert.equal(o.gate.state().phase, 'connected'); assert.equal(o.gate.notice().endState(), 'unknown'); assert.equal(reads(o.calls).length, 1); }
  // known (confirmed by the gate), then a mismatching end, then the first end again: unknown, latched
  { const o = await connected(open()); const n = o.gate.notice(); assert.equal(n.endState(), 'known');
    n.showEnd({ state: 'known', instance: INSTANCE, expiresAt: EXP().expiresAt + 60_000, ttlMs: TTL + 60_000, remainingMs: 1 }); assert.equal(n.endState(), 'unknown');
    n.showEnd({ state: 'known', instance: INSTANCE, expiresAt: EXP().expiresAt, ttlMs: TTL, remainingMs: 1 }); assert.equal(n.endState(), 'unknown');
    assert.match(endPoint(o.doc), UNKNOWN); }
});

test('readWorldInstance: a bounded read; bad origins and a timeout give null', async () => {
  const ok = async () => reply(200, { wallet: ME, instance: INSTANCE });
  assert.equal(await readWorldInstance({ origin: HERALD, wallet: ME, request: ok }), INSTANCE);
  for (const origin of [`${HERALD}/`, `${HERALD}/gw`, 'not a url', null, `http://u:p@localhost:41926`]) assert.equal(await readWorldInstance({ origin, wallet: ME, request: ok }), null, String(origin));
  assert.equal(await readWorldInstance({ origin: HERALD, wallet: '', request: ok }), null);
  let signal; const t0 = Date.now();
  assert.equal(await readWorldInstance({ origin: HERALD, wallet: ME, request: (u, o) => { signal = o.signal; return new Promise(() => {}); }, timeoutMs: 5 }), null);
  assert.equal(signal.aborted, true); assert.ok(Date.now() - t0 < 2000);
  // a late answer after the timeout is not taken
  let late; const slow = (u, o) => new Promise(r => { late = () => r(reply(200, { wallet: ME, instance: INSTANCE })); });
  const p = readWorldInstance({ origin: HERALD, wallet: ME, request: slow, timeoutMs: 5 });
  assert.equal(await p, null); late();
});

test('the read module: one request, no timer beyond its bound, no storage, key, signature or start/stop', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay-instance.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(code.split('request(').length - 1, 1, 'one request');
  assert.equal(code.split('setTimeout(').length - 1, 1, 'only its own bound');
  for (const word of ['setInterval', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'createEphemeralWallet', 'signTransaction', 'signMessage', 'sendTransaction', '/local-play/start', '/local-play/stop', 'fetch(', 'sendBeacon', 'innerHTML']) {
    assert.ok(!code.includes(word), `no ${word}`);
  }
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]), ['./flocalplay-expiry.mjs']);
  // the gate hands it the verified herald's origin, the page's own wallet and a scope check; it does not await it
  const gate = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay.mjs', import.meta.url), 'utf8');
  assert.match(gate, /confirmWorldEnd\(\{ expiry: claimedEnd, origin: at, wallet: asked, request, notice: session, now, still: \(\) => !handle\.destroyed && handle\.address === asked && state\.herald === at \}\)\.catch\(\(\) => \{\}\);/);
  assert.doesNotMatch(gate, /await confirmWorldEnd/);
});
