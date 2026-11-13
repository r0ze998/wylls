// The local-play gate in launcher mode (web/frontier/flocalplay.mjs with `?localPlay=1&launcher=1`): the start, the
// launcher's refusals, and the explicit end of a listed world at the launcher's limit of two.
//
// THIS FILE MAKES NO KEY and runs under the no-key guard:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/web-frontier-local-play-launcher.test.mjs
// The gate's memory-only wallet is replaced by a stand-in that has a public address and nothing else (`makeWallet`),
// so nothing here generates, imports or signs. (web-frontier-local-play.test.mjs is the file that exercises the real
// memory-only wallet; the scenarios of its launcher tests are repeated here with the stand-in.)
// A stub document, stub herald clients and a stub `request`: no page boot, network, chain, runner or stored key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import { decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { setLang, lang, EN } from '../../permutation-server/web/lang.mjs';

const SEASON_ID = '11', ADDRS = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, SEASON_ID);
const CFG = { origin: 'http://127.0.0.1:41920', herald: 'http://127.0.0.1:41920', relay: 'http://127.0.0.1:41920/gw', dev: true, mode: 'play' };
const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, origin: u.origin }; };
const launcherLoc = () => loc('http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off');
const ME = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', W1 = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', W2 = 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3', W3 = '11111111111111111111111111111111';
const T0 = 1_800_000_000_000;

/** A document that keeps what was set on it. `click()` is a browser's: nothing happens on a disabled or hidden control. */
function stubDocument() {
  const all = [], doc = { focused: null };
  const make = tag => {
    const listeners = {};
    const el = { tag, className: '', textContent: '', id: '', hidden: false, disabled: false, value: '', dataset: {}, attrs: {}, children: [], parent: null, listeners, ownerDocument: doc,
      setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { for (const x of xs) { x.parent = el; el.children.push(x); } }, prepend(x) { x.parent = el; el.children.unshift(x); }, addEventListener(k, f) { (listeners[k] ??= []).push(f); },
      focus() { doc.focused = el; },
      click() { if (el.disabled || !shown(el)) return false; for (const f of listeners.click ?? []) f(); return true; } };
    all.push(el); return el;
  };
  const shown = el => { for (let x = el; x; x = x.parent) if (x.hidden) return false; return true; };
  const body = make('body'), head = make('head');
  return Object.assign(doc, { body, head, createElement: make, byId: id => all.find(e => e.id === id), byClass: c => all.filter(e => e.className.split(' ').includes(c)), all, shown });
}
const stubWindow = () => new EventTarget();
/** The gate's wallet without a key: a public address, and whether it was destroyed. `made` lists what was asked of the maker. */
function maker(address = ME) {
  const made = [];
  const make = async options => { const w = { address, destroyed: false, announced: 0, destroy() { w.destroyed = true; }, announce() { w.announced++; } }; made.push({ wallet: w, options }); return w; };
  return Object.assign(make, { made });
}
function heralds() {
  const h = { calls: 0, made: [], season: null, me: null, hold: null };
  h.make = base => { h.made.push(base); return {
    season: async () => { h.calls++; if (h.hold) await h.hold; if (h.season instanceof Error) throw h.season; return h.season; },
    me: async address => (typeof h.me === 'function' ? h.me(address) : h.me), pin: (id, addresses) => { h.pinned = { id, season: addresses.season }; } }; };
  return h;
}
const goodSeason = (over = {}) => ({ ok: true, record: { programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', season: SEASON_ID, seasonAddress: ADDRS.season, ...over.record }, season: { programVersion: 0x4804, seasonId: 11n, ...over.season } });
const goodMe = address => ({ ok: true, citizen: { wallet: fromB58(address) }, holdings: [{}] });
const settle = () => new Promise(r => setImmediate(r));
const made = async gate => { for (let i = 0; i < 500 && gate.state().phase === 'creating'; i++) await settle(); assert.notEqual(gate.state().phase, 'creating', 'the wallet was made'); };
const launchReply = herald => ({ ok: true, status: 200, json: async () => ({ herald }) });
const refusal = (status, body) => ({ ok: false, status, json: async () => body });
const twoWorlds = () => [{ wallet: W1, herald: 'http://localhost:41926', startedAt: T0 - 12 * 60000, state: 'running' }, { wallet: W2, herald: 'http://localhost:41931', startedAt: T0 - 20000, state: 'running' }];
/** The panel's world rows as the player sees them: `[{row, where, line, end, ask, yes, no}]` of the rows that are shown. */
const rowsOf = doc => doc.byClass('local-play-world').filter(doc.shown).map(row => { const [where, line, end, ask, yes, no] = row.children; return { row, where, line, end, ask, yes, no }; });
const stops = calls => calls.filter(([url]) => url.endsWith('/local-play/stop'));
const lists = calls => calls.filter(([url]) => url.endsWith('/local-play/worlds'));
const starts = calls => calls.filter(([url]) => url.endsWith('/local-play/start'));
function open(over = {}) {
  const doc = stubDocument(), win = stubWindow(), h = heralds(), calls = []; h.season = goodSeason(); h.me = goodMe;
  const make = maker();
  const answer = { start: () => launchReply('http://localhost:41926'), stop: () => ({ ok: true, status: 200, json: async () => ({ stopped: true }) }), worlds: () => ({ ok: true, status: 200, json: async () => ({ worlds: [] }) }) };
  const request = async (url, options) => { calls.push([url, options]); return url.endsWith('/local-play/stop') ? answer.stop(url, options) : url.endsWith('/local-play/worlds') ? answer.worlds(url, options) : answer.start(url, options); };
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc, win, makeHerald: h.make, request, makeWallet: make, now: () => T0, ...over });
  return { gate, doc, win, h, calls, answer, make };
}

test('launcher mode says what it is before anything is pressed: a memory-only key, a new world on reload, ten minutes a turn, two worlds, two hours', async () => {
  const { gate, doc, calls, h, make } = open();
  await made(gate);
  assert.deepEqual(make.made.map(m => m.options), [{ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true }], 'one wallet, made for local play on this host');
  assert.equal(make.made[0].wallet.announced, 1);
  assert.equal(doc.byId('local-play-title').textContent, '新しい世界で遊ぶ'); assert.equal(doc.byId('local-play-connect').textContent, '新しい世界を開始');
  assert.equal(doc.byId('local-play-address').textContent, ME, 'the PUBLIC address is what the panel shows');
  const points = doc.byClass('local-play-note').filter(doc.shown);
  assert.equal(points.length, 4, 'four short points'); assert.ok(points.every(e => e.tag === 'li' && e.parent.tag === 'ul'));
  assert.ok(points.some(e => /再読み込み/.test(e.textContent) && /続けられません/.test(e.textContent)));
  const said = points.map(e => e.textContent).join('\n');
  for (const part of [/鍵は保存されない/, /再読み込み・ページを閉じると今の世界は続けられません/, /新しい世界から始めてください/, /通常速度では1ターン10分/, /同時に2つまで/, /既定は開始から2時間/, /自動的に終わり/, /進行は保存されません/, /勝手には止めません/]) assert.match(said, part);
  assert.equal(doc.byId('local-play-herald').hidden, true, 'no herald to name: the launcher answers where the world is');
  assert.equal(doc.byId('local-play-worlds').hidden, true); assert.equal(doc.byId('local-play-worlds-label').hidden, true); assert.deepEqual(rowsOf(doc), []);
  assert.match(doc.byId('local-play-status').textContent, /「新しい世界を開始」を押すと準備します/);
  assert.equal(doc.byId('local-play-connect').disabled, false);
  await settle(); await settle();
  assert.equal(calls.length, 0, 'nothing is asked of the launcher before the press'); assert.equal(h.calls, 0);
  // every text in the panel is a sentence or the public address: nothing key-like, nothing stored
  for (const el of doc.all) for (const v of [el.textContent, el.value, ...Object.values(el.attrs), ...Object.values(el.dataset)]) assert.ok(!/^[0-9a-f]{64}$/i.test(String(v)));
  assert.deepEqual(gate.state().worlds, []);
});

test('the start: one same-origin POST of the public address on the press, the herald verified before the boot', async () => {
  let release; const hold = new Promise(r => { release = r; });
  const { gate, doc, calls, h, answer } = open();
  answer.start = async () => { await hold; return launchReply('http://localhost:41926'); };
  await made(gate);
  const starting = gate.connect(); await settle(); await gate.connect(); doc.byId('local-play-connect').click();
  assert.equal(calls.length, 1, 'presses meanwhile start nothing more'); assert.equal(gate.state().phase, 'starting'); assert.equal(doc.byId('local-play-connect').disabled, true);
  assert.match(doc.byId('local-play-status').textContent, /世界を準備しています/);
  const clock = doc.byClass('local-play-elapsed')[0]; assert.equal(clock.hidden, false); assert.equal(clock.textContent, '0秒経過'); assert.equal(clock.attrs['aria-hidden'], 'true', 'beside the status, not read out each second');
  const [url, options] = calls[0];
  assert.equal(url, 'http://127.0.0.1:41920/local-play/start', 'the page\'s own origin');
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(options.body), { wallet: ME }, 'the public address and nothing else');
  release(); await starting; const result = await gate.ready;
  assert.equal(result.cfg.herald, 'http://localhost:41926'); assert.equal(result.cfg.relay, 'http://localhost:41926/gw'); assert.equal(result.cfg.devWallet, false); assert.equal(result.wallet, gate.wallet());
  assert.deepEqual(result.cfg.localPlay, { address: ME, programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', seasonId: SEASON_ID, seasonAddress: ADDRS.season });
  assert.deepEqual(h.made, ['http://localhost:41926']); assert.equal(gate.state().phase, 'connected'); assert.equal(doc.byId('local-play-gate').hidden, true);
  assert.equal(clock.hidden, true, 'the count ends with the start');
  await gate.connect(); doc.byId('local-play-connect').click(); assert.equal(calls.length, 1, 'one boot');
});

test('at the launcher\'s limit the refusal lists its worlds; ending one is the player\'s own two presses on that row, and nothing else stops a world', async () => {
  let full = true, releaseStop = null;
  const { gate, doc, calls, h, answer } = open();
  answer.start = () => (full ? refusal(409, { error: 'WorldLimit', worlds: twoWorlds() }) : launchReply('http://localhost:41926'));
  answer.stop = async () => { await new Promise(r => { releaseStop = r; }); full = false; return { ok: true, status: 200, json: async () => ({ stopped: true }) }; };
  await made(gate);
  await gate.connect();
  // the refusal, as it is: why, the two worlds by their public addresses, since when
  assert.equal(gate.state().phase, 'refused'); assert.equal(gate.state().code, 'WorldLimit');
  assert.match(doc.byId('local-play-status').textContent, /すでに2つの世界が動いています/); assert.match(doc.byId('local-play-status').textContent, /勝手には止めません/); assert.match(doc.byId('local-play-status').textContent, /\(WorldLimit\)$/);
  assert.equal(doc.byId('local-play-gate').dataset.phase, 'refused');
  assert.equal(doc.focused, doc.byId('local-play-connect'), 'after a refused start the keyboard is on the start key again, the rows a Tab away');
  assert.equal(doc.byId('local-play-worlds').hidden, false); assert.equal(doc.byId('local-play-worlds-label').hidden, false);
  let rows = rowsOf(doc);
  assert.deepEqual(rows.map(r => [r.where.textContent, r.line.textContent]), [[W1, '12分前に開始・動作中'], [W2, 'たった今開始・動作中']]);
  for (const r of rows) { assert.equal(r.end.textContent, 'この世界を終了…'); assert.equal(r.end.hidden, false); assert.equal(r.end.disabled, false); assert.deepEqual([r.ask.hidden, r.yes.hidden, r.no.hidden], [true, true, true], 'the question is not asked yet'); }
  assert.equal(doc.byId('local-play-connect').disabled, false, 'the start may be pressed again');
  assert.deepEqual(gate.state().worlds.map(w => Object.keys(w).sort()), [['startedAt', 'state', 'wallet'], ['startedAt', 'state', 'wallet']], 'only what the row shows is kept');
  // nothing ends by itself: no stop is asked, however long the panel stands or however often the start is pressed
  for (let i = 0; i < 5; i++) await settle();
  await gate.connect(); await gate.connect();
  assert.equal(stops(calls).length, 0, 'no world was stopped to make room'); assert.equal(starts(calls).length, 3);
  // the first press on a row only asks, on that row
  rows = rowsOf(doc); assert.equal(rows[0].end.click(), true);
  rows = rowsOf(doc);
  assert.deepEqual([rows[0].end.hidden, rows[0].ask.hidden, rows[0].yes.hidden, rows[0].no.hidden], [true, false, false, false]); assert.deepEqual([rows[1].end.hidden, rows[1].ask.hidden, rows[1].yes.hidden, rows[1].no.hidden], [false, true, true, true]);
  assert.match(rows[0].ask.textContent, /この世界を終了しますか？/); assert.match(rows[0].ask.textContent, /元に戻せません/); assert.equal(rows[0].yes.textContent, '終了する'); assert.equal(rows[0].no.textContent, 'やめる');
  assert.equal(doc.focused, rows[0].no, 'the keyboard is on the way back, not on the ending');
  assert.equal(rows[1].yes.click(), false, 'the other row has no ending key to press');
  assert.equal(stops(calls).length, 0);
  // taking the question back
  rows[0].no.click(); rows = rowsOf(doc);
  assert.deepEqual([rows[0].end.hidden, rows[0].ask.hidden, rows[0].yes.hidden, rows[0].no.hidden], [false, true, true, true]); assert.equal(doc.focused, rows[0].end); assert.equal(stops(calls).length, 0);
  // asking on the other row moves the question there: one question at a time
  rows[0].end.click(); rowsOf(doc)[1].end.click(); rows = rowsOf(doc);
  assert.deepEqual([rows[0].ask.hidden, rows[1].ask.hidden], [true, false]);
  rows[1].no.click();
  // the two presses: that world, and only it
  rowsOf(doc)[0].end.click(); rows = rowsOf(doc); assert.equal(rows[0].yes.click(), true); await settle();
  assert.equal(stops(calls).length, 1);
  const [url, options] = stops(calls)[0];
  assert.equal(url, 'http://127.0.0.1:41920/local-play/stop', 'the page\'s own origin'); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(options.body), { wallet: W1 }, 'the public address of the chosen world, nothing else');
  // while it ends: said so, and no key does anything
  assert.equal(gate.state().phase, 'stopping'); assert.match(doc.byId('local-play-status').textContent, /選んだ世界を終了しています/);
  rows = rowsOf(doc); assert.deepEqual(rows.map(r => r.end.disabled), [true, true]); assert.deepEqual(rows.map(r => r.ask.hidden), [true, true]); assert.equal(doc.byId('local-play-connect').disabled, true);
  assert.equal(rows[1].end.click(), false); doc.byId('local-play-connect').click(); await gate.connect(); await gate.endWorld(W2); await settle();
  assert.equal(calls.length, 4, 'three starts and the one stop: nothing more was asked');
  releaseStop(); await settle(); await settle();
  // ended: its row is gone, the other world stands untouched, and the start waits for the player's press
  assert.equal(gate.state().phase, 'waiting'); assert.equal(gate.state().code, null); assert.equal(gate.state().ended, W1);
  rows = rowsOf(doc); assert.deepEqual(rows.map(r => r.where.textContent), [W2]); assert.equal(rows[0].end.disabled, false);
  assert.match(doc.byId('local-play-status').textContent, /世界を終了しました/); assert.match(doc.byId('local-play-status').textContent, /もう一度押すと/);
  assert.equal(doc.focused, doc.byId('local-play-connect'), 'the keyboard goes on from the start key'); assert.equal(doc.byId('local-play-connect').disabled, false);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(starts(calls).length, 3, 'no new world is started by itself either'); assert.equal(h.calls, 0);
  assert.deepEqual(stops(calls).map(([, o]) => JSON.parse(o.body).wallet), [W1], 'the other world was never named');
  // the player's press: the new world, verified, then the boot
  doc.byId('local-play-connect').click(); const result = await gate.ready;
  assert.equal(starts(calls).length, 4); assert.equal(result.cfg.herald, 'http://localhost:41926'); assert.equal(gate.state().phase, 'connected'); assert.deepEqual(gate.state().worlds, []);
  assert.equal(doc.byId('local-play-gate').hidden, true);
  // after the boot nothing here ends a world
  await gate.endWorld(W2); assert.equal(stops(calls).length, 1);
});

test('below the limit the worlds are listed only on the player\'s own press of the panel\'s key; an earlier world can be ended before a new one is started', async () => {
  let running = [twoWorlds()[0]], releaseList = null;
  const { gate, doc, calls, answer, h } = open();
  answer.worlds = async () => { await new Promise(r => { releaseList = r; }); return { ok: true, status: 200, json: async () => ({ worlds: running, extra: 'ignored' }) }; };
  answer.stop = () => { running = []; return { ok: true, status: 200, json: async () => ({ stopped: true }) }; };
  await made(gate);
  const key = doc.byId('local-play-list');
  assert.equal(key.textContent, '動いている世界を確認'); assert.equal(key.hidden, false); assert.equal(key.disabled, false); assert.deepEqual(rowsOf(doc), []);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(calls.length, 0, 'nothing is asked of the launcher, not even its list, before a press');
  // the press: one same-origin POST that names nothing
  assert.equal(key.click(), true); await settle();
  assert.equal(gate.state().phase, 'listing'); assert.match(doc.byId('local-play-status').textContent, /動いている世界を確認しています/);
  assert.equal(key.disabled, true); assert.equal(doc.byId('local-play-connect').disabled, true);
  key.click(); doc.byId('local-play-connect').click(); await gate.listWorlds(); await gate.connect(); await settle();
  assert.equal(calls.length, 1, 'presses meanwhile ask nothing more');
  const [url, options] = calls[0];
  assert.equal(url, 'http://127.0.0.1:41920/local-play/worlds'); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
  assert.equal(options.body, '{}', 'no address, nothing: only the question');
  releaseList(); for (let i = 0; i < 4; i++) await settle();
  // the earlier world, by its public address; said in words; nothing stopped, nothing started
  assert.equal(gate.state().phase, 'waiting'); assert.equal(gate.state().listed, 1);
  assert.deepEqual(rowsOf(doc).map(r => [r.where.textContent, r.line.textContent, r.end.disabled]), [[W1, '12分前に開始・動作中', false]]);
  assert.match(doc.byId('local-play-status').textContent, /動いている世界は1個です/); assert.equal(doc.byId('local-play-gate').dataset.phase, 'waiting');
  assert.equal(doc.focused, key, 'the keyboard is back on the key that was pressed (it was disabled while the launcher answered)');
  assert.equal(key.disabled, false); assert.equal(doc.byId('local-play-connect').disabled, false);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(stops(calls).length, 0); assert.equal(starts(calls).length, 0);
  // the two presses on its row end it; then the start is the player's own press: one world at a time
  rowsOf(doc)[0].end.click(); assert.equal(stops(calls).length, 0); rowsOf(doc)[0].yes.click(); for (let i = 0; i < 4; i++) await settle();
  assert.deepEqual(stops(calls).map(([, o]) => JSON.parse(o.body)), [{ wallet: W1 }]); assert.deepEqual(rowsOf(doc), []); assert.equal(doc.byId('local-play-worlds').hidden, true);
  assert.match(doc.byId('local-play-status').textContent, /世界を終了しました/); assert.equal(gate.state().listed, null);
  // asking again: none
  answer.worlds = () => ({ ok: true, status: 200, json: async () => ({ worlds: running }) });
  key.click(); for (let i = 0; i < 4; i++) await settle();
  assert.equal(gate.state().listed, 0); assert.match(doc.byId('local-play-status').textContent, /動いている世界はありません/); assert.deepEqual(rowsOf(doc), []);
  assert.equal(starts(calls).length, 0, 'still nothing started by itself');
  doc.byId('local-play-connect').click(); await gate.ready;
  assert.equal(starts(calls).length, 1); assert.equal(gate.state().phase, 'connected'); assert.equal(h.calls, 1);
  await gate.listWorlds(); assert.equal(lists(calls).length, 2, 'after the boot the key asks nothing');
});

test('the list, when asked for, can fail or be refused: said in words, the panel as it was', async () => {
  const { gate, doc, calls, answer } = open({ stopTimeoutMs: 20 });
  await made(gate);
  const press = async () => { doc.byId('local-play-list').click(); for (let i = 0; i < 4; i++) await settle(); };
  answer.worlds = () => { throw new Error('ECONNREFUSED'); }; await press();
  assert.equal(gate.state().phase, 'refused'); assert.equal(gate.state().code, 'LauncherListFailed'); assert.match(doc.byId('local-play-status').textContent, /動いている世界を確認できませんでした/); assert.deepEqual(rowsOf(doc), []);
  assert.notEqual(LP.localPlayWhy('LauncherListFailed'), 'LauncherListFailed');
  for (const reply of [refusal(404, { error: 'NotFound' }), refusal(403, { error: 'OriginDenied' }), refusal(500, null), { ok: false }]) { answer.worlds = () => reply; await press(); assert.equal(gate.state().code, 'LauncherListFailed'); }
  answer.worlds = () => refusal(503, { error: 'LauncherClosed' }); await press(); assert.equal(gate.state().code, 'LauncherClosed');
  let signal = null; answer.worlds = (url, options) => { signal = options.signal; return new Promise(() => {}); };
  doc.byId('local-play-list').click(); await new Promise(r => setTimeout(r, 60));
  assert.equal(gate.state().code, 'LauncherListFailed'); assert.equal(signal.aborted, true);
  // an answer that is not a list, or lists what is not an address: no row
  for (const body of [null, {}, { worlds: 'x' }, { worlds: [{ wallet: '<b>x</b>' }, { wallet: 5 }] }]) { answer.worlds = () => ({ ok: true, status: 200, json: async () => body }); await press(); assert.equal(gate.state().phase, 'waiting'); assert.equal(gate.state().listed, 0); assert.deepEqual(rowsOf(doc), []); }
  answer.worlds = () => ({ ok: true, status: 200, json: async () => { throw new Error('not JSON'); } }); await press(); assert.equal(gate.state().listed, 0);
  assert.equal(stops(calls).length, 0); assert.equal(starts(calls).length, 0);
  // the list replaces what was shown: a world that is gone is gone from the panel
  answer.worlds = () => ({ ok: true, status: 200, json: async () => ({ worlds: twoWorlds() }) }); await press(); assert.deepEqual(rowsOf(doc).map(r => r.where.textContent), [W1, W2]); assert.equal(gate.state().listed, 2);
  answer.worlds = () => ({ ok: true, status: 200, json: async () => ({ worlds: [twoWorlds()[1]] }) }); await press(); assert.deepEqual(rowsOf(doc).map(r => r.where.textContent), [W2]);
});

test('the launcher\'s list is believed in nothing: public addresses and plain text only, at most two rows, and only a listed world can be ended', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  assert.deepEqual(LP.launcherWorlds(twoWorlds()), [{ wallet: W1, startedAt: T0 - 12 * 60000, state: 'running' }, { wallet: W2, startedAt: T0 - 20000, state: 'running' }]);
  for (const notAList of [null, undefined, 'x', 5, {}, { 0: { wallet: W1 }, length: 1 }]) assert.deepEqual(LP.launcherWorlds(notAList), []);
  assert.deepEqual(LP.launcherWorlds([null, 'x', 5, [], {}, { wallet: evil }, { wallet: 'ab'.repeat(32) }, { wallet: W1 + '1' }, { wallet: ' ' + W1 }, { wallet: 5 }, { wallet: [W1] }]), [], 'not an address: no row');
  assert.deepEqual(LP.launcherWorlds([{ wallet: W1, startedAt: 'yesterday', state: evil, herald: 'http://evil.example', pid: 7, command: 'rm' }]), [{ wallet: W1, startedAt: null, state: 'running' }], 'only the address, a time and one of three states');
  for (const startedAt of [NaN, Infinity, -5, 0, null, '5', {}]) assert.equal(LP.launcherWorlds([{ wallet: W1, startedAt }])[0].startedAt, null);
  assert.deepEqual(LP.launcherWorlds([{ wallet: W1 }, { wallet: W1 }, { wallet: W2, state: 'starting' }, { wallet: W3, state: 'stopping' }]).map(w => [w.wallet, w.state]), [[W1, 'running'], [W2, 'starting']], 'no duplicate, at most the launcher\'s two');
  assert.equal(LP.LAUNCHER_WORLDS, 2);
  // on the panel
  const { gate, doc, calls, answer } = open();
  answer.start = () => refusal(409, { error: 'WorldLimit', worlds: [{ wallet: evil, startedAt: T0 }, { wallet: W2, startedAt: T0 - 59 * 60000 - 59000, state: 'starting', herald: evil }, { wallet: W1, state: 'stopping' }, { wallet: W3 }] });
  await made(gate); await gate.connect();
  const rows = rowsOf(doc);
  assert.deepEqual(rows.map(r => [r.where.textContent, r.line.textContent]), [[W2, '59分前に開始・起動中'], [W1, '終了の処理中']]);
  assert.equal(rows[1].end.disabled, true, 'a world already ending has no ending to ask for');
  for (const el of doc.all) assert.ok(!String(el.textContent).includes('<img') && !String(el.textContent).includes('evil'), 'nothing of the reply but the addresses reaches the panel');
  // only what the launcher listed (and the panel shows) can be named to it
  for (const other of [W3, evil, ME, '', null, undefined]) await gate.endWorld(other);
  assert.equal(stops(calls).length, 0);
  // a refusal that is not the limit shows no rows, whatever it carries
  answer.start = () => refusal(503, { error: 'DiskFloor', worlds: twoWorlds() });
  await gate.connect(); assert.equal(gate.state().code, 'LauncherDiskFloor'); assert.deepEqual(gate.state().worlds, []); assert.deepEqual(rowsOf(doc), []); assert.equal(doc.byId('local-play-worlds').hidden, true);
  await gate.endWorld(W1); assert.equal(stops(calls).length, 0, 'a world no longer listed cannot be ended from here');
});

test('each of the launcher\'s refusals is said in words; anything else is one plain failure; the same wallet through every retry', async () => {
  const { gate, doc, calls, answer, make } = open();
  await made(gate);
  for (const [error, status, code, words] of [['DiskFloor', 503, 'LauncherDiskFloor', /空き容量/], ['PortBusy', 503, 'LauncherPortBusy', /ポート/], ['RunnerNotReady', 503, 'LauncherRunnerNotReady', /ランナー/], ['HeraldNotReady', 503, 'LauncherHeraldNotReady', /herald の準備/],
    ['LauncherClosed', 503, 'LauncherClosed', /開始サービス/], ['WorldStopping', 409, 'WorldStopping', /終了の処理中/], ['WorldLimit', 409, 'WorldLimit', /すでに2つの世界/]]) {
    answer.start = () => refusal(status, { error, worlds: [] });
    await gate.connect();
    assert.equal(gate.state().phase, 'refused'); assert.equal(gate.state().code, code, error); assert.match(doc.byId('local-play-status').textContent, words); assert.ok(doc.byId('local-play-status').textContent.endsWith(`(${code})`));
    assert.notEqual(LP.localPlayWhy(code), code, `${code} has a sentence`); assert.equal(doc.byId('local-play-connect').disabled, false, 'it may be tried again');
  }
  assert.notEqual(LP.localPlayWhy('LauncherStopFailed'), 'LauncherStopFailed');
  for (const reply of [refusal(500, { error: 'LauncherUnavailable' }), refusal(400, { error: 'InvalidWallet' }), refusal(403, { error: 'OriginDenied' }), refusal(500, { error: 'constructor' }), refusal(500, { error: '__proto__' }), refusal(500, { error: 5 }), refusal(500, null), refusal(500, 'text'),
    { ok: false }, { ok: false, json: async () => { throw new Error('not JSON'); } }, null, undefined]) {
    answer.start = () => reply;
    await gate.connect(); assert.equal(gate.state().code, 'LauncherFailed'); assert.deepEqual(gate.state().worlds, []);
  }
  answer.start = () => { throw new Error('ECONNREFUSED'); };
  await gate.connect(); assert.equal(gate.state().code, 'LauncherFailed');
  // a reply that names somewhere else than this machine, or more than an origin: refused before anything is read there
  for (const herald of ['http://example.com', 'http://localhost:41926/path', 'http://user:pw@localhost:41926', 'https://evil.example', '//localhost:41926', null, 5]) { answer.start = () => launchReply(herald); await gate.connect(); assert.equal(gate.state().code, 'BadHerald', String(herald)); }
  assert.equal(make.made.length, 1, 'one wallet through all of it'); assert.ok(starts(calls).every(([, o]) => JSON.parse(o.body).wallet === ME));
  answer.start = () => launchReply('http://localhost:41931'); await gate.connect(); assert.equal((await gate.ready).cfg.herald, 'http://localhost:41931');
});

test('an end that fails says so and changes nothing; a world that ended by itself meanwhile is simply gone from the list', async () => {
  const { gate, doc, calls, answer } = open({ stopTimeoutMs: 20 });
  answer.start = () => refusal(409, { error: 'WorldLimit', worlds: twoWorlds() });
  await made(gate); await gate.connect();
  const press = async i => { rowsOf(doc)[i].end.click(); rowsOf(doc)[i].yes.click(); for (let n = 0; n < 4; n++) await settle(); };
  // the launcher does not answer in time: cancelled, said, the rows as they were
  let signal = null; answer.stop = (url, options) => { signal = options.signal; return new Promise(() => {}); };
  rowsOf(doc)[0].end.click(); rowsOf(doc)[0].yes.click(); await new Promise(r => setTimeout(r, 60));
  assert.equal(gate.state().phase, 'refused'); assert.equal(gate.state().code, 'LauncherStopFailed'); assert.equal(signal.aborted, true); assert.match(doc.byId('local-play-status').textContent, /世界を終了できませんでした/);
  assert.deepEqual(rowsOf(doc).map(r => r.where.textContent), [W1, W2]); assert.deepEqual(rowsOf(doc).map(r => r.end.disabled), [false, false]);
  // unreachable, refused without a reason, refused with one
  answer.stop = () => { throw new Error('ECONNREFUSED'); }; await press(0); assert.equal(gate.state().code, 'LauncherStopFailed'); assert.equal(rowsOf(doc).length, 2);
  answer.stop = () => refusal(500, { error: 'LauncherUnavailable' }); await press(0); assert.equal(gate.state().code, 'LauncherStopFailed'); assert.equal(rowsOf(doc).length, 2);
  answer.stop = () => refusal(403, { error: 'OriginDenied' }); await press(0); assert.equal(gate.state().code, 'LauncherStopFailed');
  answer.stop = () => refusal(503, { error: 'LauncherClosed' }); await press(1); assert.equal(gate.state().code, 'LauncherClosed'); assert.equal(rowsOf(doc).length, 2);
  assert.deepEqual(stops(calls).map(([, o]) => JSON.parse(o.body).wallet), [W1, W1, W1, W1, W2]);
  // it had already ended (its two hours were over): the same to the player, its place is free
  answer.stop = () => refusal(404, { error: 'WorldNotFound' }); await press(1);
  assert.equal(gate.state().phase, 'waiting'); assert.equal(gate.state().ended, W2); assert.deepEqual(rowsOf(doc).map(r => r.where.textContent), [W1]); assert.match(doc.byId('local-play-status').textContent, /世界を終了しました/);
  // a start pressed now clears the note of the ending and lists what the launcher then says
  answer.start = () => refusal(409, { error: 'WorldLimit', worlds: [twoWorlds()[0], { wallet: W3, startedAt: T0 - 60000, state: 'running' }] });
  await gate.connect(); assert.equal(gate.state().ended, null); assert.deepEqual(rowsOf(doc).map(r => [r.where.textContent, r.line.textContent]), [[W1, '12分前に開始・動作中'], [W3, '1分前に開始・動作中']]);
});

const fastLoc = () => loc('http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off&prepare=accelerated');

test('a launcher that prepares its worlds fast: the panel says so before anything is pressed and while it waits; the page only shows it, never asks for it', async () => {
  // the launcher's own word, on the address it serves the page at
  assert.equal(LP.localPreparationAccelerated(CFG, fastLoc()), true);
  for (const href of ['http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off', 'http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&prepare=1', 'http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&prepare=Accelerated',
    'http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&prepare=accelerated', 'http://127.0.0.1:41920/frontier/frontier/index.html?launcher=1&prepare=accelerated', 'https://wylls.example/frontier/index.html?localPlay=1&launcher=1&prepare=accelerated', 'http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1#prepare=accelerated'])
    assert.equal(LP.localPreparationAccelerated(CFG, loc(href)), false, href);
  assert.equal(LP.localPreparationAccelerated({ ...CFG, mode: 'spectate' }, fastLoc()), false); assert.equal(LP.localPreparationAccelerated(null, fastLoc()), false);
  let release; const hold = new Promise(r => { release = r; });
  const { gate, doc, calls, answer } = open({ loc: fastLoc() });
  answer.start = async () => { await hold; return { ok: true, status: 200, json: async () => ({ herald: 'http://localhost:41926', prepared: { accelerated: true, scale: 30, chainSeconds: 742, wallMs: 31250, extra: 'dropped' } }) }; };
  await made(gate);
  // before the press: a fifth point, in words
  const points = doc.byClass('local-play-note').filter(doc.shown); assert.equal(points.length, 5);
  const said = points.at(-1).textContent; assert.ok(points.at(-1).className.split(' ').includes('local-play-prepare'));
  for (const part of [/試験用の世界/, /準備のあいだだけ世界の時間を早送りします/, /操作できるようになる前に通常速度へ戻し/, /そのあとは早送りしません/]) assert.match(said, part);
  assert.equal(calls.length, 0, 'saying it asks nothing of the launcher');
  // the press: the same one request as ever, the public address and nothing about the clock
  const starting = gate.connect(); await settle();
  assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0][1].body), { wallet: ME }); assert.equal(calls[0][0], 'http://127.0.0.1:41920/local-play/start');
  assert.match(doc.byId('local-play-status').textContent, /試験世界の準備として、世界の時間を早送りします/); assert.match(doc.byId('local-play-status').textContent, /最大150秒/);
  release(); await starting; const result = await gate.ready;
  // what the launcher says it did, kept as numbers and a yes/no, nothing else of the answer
  assert.deepEqual(result.prepared, { accelerated: true, scale: 30, chainSeconds: 742, wallMs: 31250 }); assert.deepEqual(gate.state().prepared, result.prepared); assert.ok(Object.isFrozen(result.prepared));
  assert.equal(result.cfg.herald, 'http://localhost:41926'); assert.equal(result.cfg.prepared, undefined, 'not part of the page\'s configuration');
  for (const [value, want] of [[{ accelerated: false, scale: 1, chainSeconds: 12, wallMs: 900 }, { accelerated: false, scale: 1, chainSeconds: 12, wallMs: 900 }], [null, null], [undefined, null], ['fast', null], [[], null], [{ accelerated: 'yes', scale: 30, chainSeconds: 1, wallMs: 1 }, null],
    [{ accelerated: true, scale: 0, chainSeconds: 1, wallMs: 1 }, null], [{ accelerated: true, scale: 30.5, chainSeconds: 1, wallMs: 1 }, null], [{ accelerated: true, scale: 30, chainSeconds: -1, wallMs: 1 }, null], [{ accelerated: true, scale: 30, chainSeconds: '742', wallMs: 1 }, null], [{ accelerated: true, scale: 30, chainSeconds: 1 }, null], [{ accelerated: true, scale: 1e12, chainSeconds: 1, wallMs: 1 }, null]])
    assert.deepEqual(LP.launcherPrepared(value), want, JSON.stringify(value));
  // a launcher that does not prepare fast: four points, no word of it, the shorter wait; and no `prepared` is made up
  const plain = open(); let go; plain.answer.start = async () => { await new Promise(r => { go = r; }); return launchReply('http://localhost:41926'); };
  await made(plain.gate);
  assert.equal(plain.doc.byClass('local-play-note').filter(plain.doc.shown).length, 4); assert.equal(plain.doc.byClass('local-play-prepare').length, 0);
  const waiting = plain.gate.connect(); await settle(); assert.ok(!plain.doc.all.some(e => /早送り/.test(e.textContent)), 'no word of a faster clock'); assert.match(plain.doc.byId('local-play-status').textContent, /最大70秒/);
  go(); await waiting; assert.equal((await plain.gate.ready).prepared, null);
});

test('a preparation the launcher could not finish is said in words with the launcher\'s own reason; the world was ended, and the press starts over', async () => {
  const { gate, doc, calls, answer } = open({ loc: fastLoc() });
  await made(gate);
  for (const error of ['PrepareTimeout', 'PrepareHalted', 'PrepareNotSettled', 'PrepareClockNotRestored', 'PrepareUnavailable', 'PrepareClock', 'PrepareFailed', 'RunnerRpcRefused']) {
    answer.start = () => refusal(503, { error, prepared: { accelerated: true, scale: 30, chainSeconds: 1, wallMs: 1 } });
    await gate.connect();
    assert.equal(gate.state().phase, 'refused'); assert.equal(gate.state().code, 'LauncherPrepareFailed'); assert.equal(gate.state().detail, error); assert.equal(gate.state().prepared, null);
    const text = doc.byId('local-play-status').textContent; assert.match(text, /試験世界の準備（時間の早送り）を終えられませんでした/); assert.match(text, /その世界は終了しました/); assert.ok(text.endsWith(`(LauncherPrepareFailed: ${error})`), text);
    assert.equal(doc.byId('local-play-connect').disabled, false);
  }
  assert.notEqual(LP.localPlayWhy('LauncherPrepareFailed'), 'LauncherPrepareFailed');
  // another refusal clears the reason beside it; an unknown word from the launcher is never shown
  answer.start = () => refusal(503, { error: 'DiskFloor' }); await gate.connect(); assert.equal(gate.state().detail, null); assert.ok(doc.byId('local-play-status').textContent.endsWith('(LauncherDiskFloor)'));
  answer.start = () => refusal(503, { error: 'Prepare<script>' }); await gate.connect(); assert.equal(gate.state().code, 'LauncherFailed'); assert.equal(gate.state().detail, null); assert.ok(!doc.byId('local-play-status').textContent.includes('script'));
  answer.start = () => launchReply('http://localhost:41926'); await gate.connect(); await gate.ready;
  assert.ok(starts(calls).every(([, o]) => o.body === JSON.stringify({ wallet: ME })), 'every start: the public address, nothing else');
});

test('a page that goes away while a world is being started or ended boots nothing and asks nothing more', async () => {
  { const { gate, win, calls, answer, h } = open(); let release; answer.start = async () => { await new Promise(r => { release = r; }); return launchReply('http://localhost:41926'); };
    let boots = 0; gate.ready.then(() => { boots++; }); await made(gate); const pending = gate.connect(); await settle();
    win.dispatchEvent(new Event('pagehide')); assert.equal(calls[0][1].signal.aborted, true); release(); await pending;
    assert.equal(gate.state().phase, 'destroyed'); assert.equal(gate.wallet().destroyed, true); assert.equal(h.calls, 0); assert.equal(boots, 0); }
  { const { gate, doc, win, calls, answer } = open(); let release; answer.start = () => refusal(409, { error: 'WorldLimit', worlds: twoWorlds() });
    answer.stop = async () => { await new Promise(r => { release = r; }); return { ok: true, status: 200, json: async () => ({ stopped: true }) }; };
    let boots = 0; gate.ready.then(() => { boots++; }); await made(gate); await gate.connect();
    rowsOf(doc)[0].end.click(); rowsOf(doc)[0].yes.click(); await settle();
    win.dispatchEvent(new Event('pagehide')); assert.equal(stops(calls)[0][1].signal.aborted, true); release(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(gate.state().phase, 'destroyed'); assert.match(doc.byId('local-play-status').textContent, /ウォレットは破棄されました/); assert.equal(doc.byId('local-play-connect').disabled, true);
    assert.deepEqual(rowsOf(doc).map(r => r.end.disabled), [true, true]);
    await gate.connect(); await gate.endWorld(W2); assert.equal(calls.length, 2, 'nothing more is asked of the launcher'); assert.equal(boots, 0); }
});

test('a verified launcher world gets a standing notice; after the page went away and came back, it says only that this world cannot be continued: no key, world or request is made', async () => {
  const { gate, doc, win, calls, make } = open();
  await made(gate);
  assert.equal(doc.byId('local-play-session'), undefined, 'nothing before the world is verified');
  doc.byId('local-play-connect').click(); await gate.ready;
  const box = doc.byId('local-play-session'); assert.ok(box && doc.shown(box), 'shown once the world is verified');
  const said = doc.byClass('local-play-session-point').map(e => e.textContent).join('\n');
  for (const part of [/再読み込み・タブを閉じると失われ/, /続けられません/, /このページでは確認できません/, /既定は開始から2時間/, /進行は保存されません/]) assert.match(said, part);
  assert.doesNotMatch(said, /[0-9]{1,2}:[0-9]{2}|残り/, 'no end time and no time left is made up (the end is not confirmed here)');
  assert.equal(doc.byClass('local-play-session-gone')[0].hidden, true);
  const asked = calls.length;
  win.dispatchEvent(new Event('pagehide'));
  assert.equal(make.made[0].wallet.destroyed, true, 'the key is discarded as before'); assert.equal(gate.notice().isDestroyed(), true);
  win.dispatchEvent(new Event('pageshow'));   // (back from the browser's cache)
  assert.equal(doc.byClass('local-play-session-gone')[0].hidden, false); assert.equal(doc.byClass('local-play-session-points')[0].hidden, true);
  assert.match(doc.byClass('local-play-session-gone')[0].textContent, /この世界は続けられません/);
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(calls.length, asked, 'nothing asked of the launcher'); assert.equal(make.made.length, 1, 'no new key made');
  assert.equal(gate.state().phase, 'destroyed'); assert.equal(doc.all.filter(e => e.id === 'local-play-session').length, 1, 'one notice');
});

test('the launcher start keeps its earlier rules with the stand-in wallet: transient readiness is retried, a wrong world is not, a late answer cannot boot', async () => {
  // (the scenarios of web-frontier-local-play.test.mjs's launcher tests, which need the real memory-only wallet and so
  //  cannot run under the no-key guard, repeated here with a wallet that has no key)
  { const { gate, h } = open({ retryDelayMs: 1 }); h.season = goodSeason({ season: { programVersion: 4 } });
    await made(gate); await gate.connect(); assert.equal(gate.state().code, 'LocalPlayVersion'); assert.equal(h.calls, 1);
    h.season = { ok: false, code: 'NotFound' };
    const start = gate.connect(); await settle(); h.season = goodSeason(); await start;
    assert.equal(gate.state().phase, 'connected'); assert.ok(h.calls >= 3); }
  { let release, attempt = 0, firstSignal; const hold = new Promise(r => { release = r; });
    const { gate, h, answer } = open({ launcherTimeoutMs: 5 });
    answer.start = async (url, options) => { if (++attempt === 1) { firstSignal = options.signal; await hold; } return launchReply('http://localhost:41926'); };
    await made(gate); await gate.connect(); assert.equal(gate.state().code, 'LauncherTimeout'); assert.equal(firstSignal.aborted, true);
    await gate.connect(); await gate.ready; assert.equal(gate.state().phase, 'connected'); release(); await settle();
    assert.equal(gate.state().phase, 'connected'); assert.equal(h.calls, 1); }
  { const { gate, h, answer } = open(); let calls = 0, reply = launchReply('http://example.com'); answer.start = () => { calls++; return reply; };
    await made(gate); await gate.connect(); assert.equal(gate.state().code, 'BadHerald'); assert.equal(h.calls, 0);
    reply = { ok: false }; await gate.connect(); assert.equal(gate.state().code, 'LauncherFailed'); assert.equal(h.calls, 0);
    reply = launchReply('http://127.0.0.1:41926'); await gate.connect(); await gate.ready; assert.equal(calls, 3); assert.equal(gate.wallet().address, ME); }
});

test('without launcher=1 there is no start or stop request and no world row: the panel is the operator\'s, as before', async () => {
  const doc = stubDocument(), h = heralds(), calls = []; h.season = goodSeason(); h.me = goodMe;
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: loc('http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1'), doc, win: stubWindow(), makeHerald: h.make, makeWallet: maker(), now: () => T0,
    request: async (...a) => { calls.push(a); return refusal(409, { error: 'WorldLimit', worlds: twoWorlds() }); } });
  await made(gate);
  assert.equal(doc.byId('local-play-title').textContent, 'ローカルプレイの準備'); assert.equal(doc.byId('local-play-connect').textContent, '接続'); assert.equal(doc.byId('local-play-herald').hidden, false);
  assert.equal(doc.byClass('local-play-points').length, 0); assert.ok(!doc.all.some(e => /2時間|同時に2つ/.test(e.textContent)), 'the launcher\'s limits are not this panel\'s');
  assert.equal(doc.byClass('local-play-note').length, 1); assert.match(doc.byClass('local-play-note')[0].textContent, /保存されません/); assert.match(doc.byId('local-play-status').textContent, /準備中/);
  await gate.endWorld(W1); assert.deepEqual(rowsOf(doc), []);
  assert.equal(doc.byId('local-play-list').hidden, true); assert.equal(doc.byId('local-play-list').click(), false); await gate.listWorlds();
  doc.byId('local-play-herald').value = 'http://127.0.0.1:41906'; await gate.connect(); await gate.ready;
  assert.equal(calls.length, 0, 'the launcher is never asked'); assert.deepEqual(h.made, ['http://127.0.0.1:41906']); assert.equal(gate.state().phase, 'connected'); assert.equal(doc.byId('local-play-session'), undefined, 'no launcher notice in the operator\'s mode');
  // a wallet that cannot be made is said on the panel, and nothing can be pressed
  const doc2 = stubDocument();
  const broken = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc: doc2, win: stubWindow(), makeHerald: () => assert.fail(), request: async () => assert.fail(), makeWallet: async () => { throw Object.assign(new Error('no Ed25519'), { code: 'NoEd25519' }); } });
  assert.equal(await broken.ready.then(() => null, e => e.code), 'NoEd25519'); assert.equal(doc2.byId('local-play-gate').dataset.phase, 'unavailable'); assert.match(doc2.byId('local-play-status').textContent, /NoEd25519/);
  assert.equal(doc2.byId('local-play-connect').disabled, true); await broken.connect(); await broken.endWorld(W1);
});

// ---- a conquest world: the launcher's statement of it, believed only where it is this start's
const IDENTITY = { address: ME, programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', seasonId: SEASON_ID, seasonAddress: ADDRS.season };
const conquestWorld = (over = {}) => ({ schema: 'frontier-local-play-conquest-world-v1', program: LP.LOCAL_PLAY_PROGRAM, season: ADDRS.season, world_preset: 'local-conquest-test-v1', free_city: { p: '129', q: '0', site: 3, tile: 43 }, ...over });
const conquestReply = (world, more = {}) => ({ ok: true, status: 200, json: async () => ({ herald: 'http://localhost:41926', ...more, conquestWorld: world }) });

test('the launcher\'s statement of a conquest world is kept only as this start\'s: exactly five fields, the dedicated program, the Season the page verified', async () => {
  const kept = LP.launcherConquestWorld(conquestWorld(), IDENTITY);
  assert.deepEqual(kept, conquestWorld()); assert.deepEqual(Object.keys(kept), ['schema', 'program', 'season', 'world_preset', 'free_city']); assert.deepEqual(Object.keys(kept.free_city), ['p', 'q', 'site', 'tile']);
  assert.ok(Object.isFrozen(kept) && Object.isFrozen(kept.free_city)); const given = conquestWorld(); assert.notEqual(LP.launcherConquestWorld(given, IDENTITY), given, 'a copy: what the reply held cannot change it later');
  // the words are the page module's own (flocalplay-conquest.mjs reads this object as FS.localPlay.conquestWorld)
  const page = await import('../../permutation-server/web/frontier/flocalplay-conquest.mjs');
  assert.equal(LP.LOCAL_PLAY_CONQUEST_WORLD_SCHEMA, page.LOCAL_CONQUEST_WORLD_SCHEMA); assert.equal(LP.LOCAL_PLAY_CONQUEST_WORLD_PRESET, page.LOCAL_CONQUEST_WORLD_PRESET);
  assert.equal(page.LOCAL_CONQUEST_PAGE_CONDITIONS.heapConfirmed, false, '(the page\'s own condition is the page module\'s: nothing here sets it)');
  for (const edge of [{ p: '-129', q: '0', site: 0, tile: 0 }, { p: '0', q: '-1', site: 11, tile: 60 }]) assert.deepEqual(LP.launcherConquestWorld(conquestWorld({ free_city: edge }), IDENTITY).free_city, edge);
  // anything less, more or other is no conquest world
  const no = (value, identity = IDENTITY) => assert.equal(LP.launcherConquestWorld(value, identity), null, JSON.stringify(value)?.slice(0, 160));
  for (const value of [undefined, null, true, 'local-conquest-test-v1', [], [conquestWorld()], {}, { conquestWorld: conquestWorld() }]) no(value);
  no({ ...conquestWorld(), extra: 1 }); no({ ...conquestWorld(), artifact_sha256: 'ab'.repeat(32) }); no({ ...conquestWorld(), rpc: 'http://127.0.0.1:41924' });
  for (const k of ['schema', 'program', 'season', 'world_preset', 'free_city']) { const less = conquestWorld(); delete less[k]; no(less); }
  no(conquestWorld({ schema: 'frontier-local-play-conquest-capability-v1' })); no(conquestWorld({ schema: 'frontier-local-play-conquest-world-v2' }));
  no(conquestWorld({ world_preset: 'S1_LOCAL_7D' })); no(conquestWorld({ world_preset: 'local-conquest-test-v2' })); no(conquestWorld({ world_preset: true }));
  no(conquestWorld({ program: W2 })); no(conquestWorld({ season: W2 })); no(conquestWorld({ season: null })); no(conquestWorld({ program: undefined }));
  for (const city of [null, [], '129,0,3,43', { p: '129', q: '0', site: 3 }, { p: '129', q: '0', site: 3, tile: 43, name: 'x' }, { p: 129, q: '0', site: 3, tile: 43 }, { p: '129', q: 0, site: 3, tile: 43 }, { p: '0129', q: '0', site: 3, tile: 43 },
    { p: '129', q: '+0', site: 3, tile: 43 }, { p: '129', q: '0', site: 12, tile: 43 }, { p: '129', q: '0', site: -1, tile: 43 }, { p: '129', q: '0', site: '3', tile: 43 }, { p: '129', q: '0', site: 3, tile: 61 }, { p: '129', q: '0', site: 3, tile: 4.5 },
    { p: '1'.repeat(21), q: '0', site: 3, tile: 43 }]) no(conquestWorld({ free_city: city }));
  // a statement of another world than the one this page verified: another program, another Season, no identity
  no(conquestWorld(), { ...IDENTITY, seasonAddress: W2 }); no(conquestWorld(), { ...IDENTITY, programId: W2 }); no(conquestWorld({ program: W2 }), { ...IDENTITY, programId: W2 }); no(conquestWorld(), null); no(conquestWorld(), []); no(conquestWorld(), 'identity'); assert.equal(LP.launcherConquestWorld(conquestWorld(), undefined), null);
});

test('a conquest world reaches the page on the verified identity (cfg.localPlay.conquestWorld) only from a launcher\'s answer for this very world; otherwise the identity is as it always was', async () => {
  { const { gate, answer } = open(); answer.start = () => conquestReply(conquestWorld(), { prepared: { accelerated: true, scale: 30, chainSeconds: 742, wallMs: 31250 } });
    await made(gate); assert.equal(gate.state().conquestWorld, null); await gate.connect(); const result = await gate.ready;
    assert.deepEqual(result.cfg.localPlay, { ...IDENTITY, conquestWorld: conquestWorld() }); assert.ok(Object.isFrozen(result.cfg.localPlay) && Object.isFrozen(result.cfg.localPlay.conquestWorld));
    assert.deepEqual(gate.state().conquestWorld, conquestWorld()); assert.equal(result.prepared.accelerated, true); assert.equal(result.cfg.herald, 'http://localhost:41926'); }
  // no statement, or one that is not this world's: exactly the identity of every other start (no key, not even a null one)
  for (const world of [undefined, null, {}, 'yes', conquestWorld({ season: W2 }), conquestWorld({ program: W1 === LP.LOCAL_PLAY_PROGRAM ? W2 : W1 }), { ...conquestWorld(), heapConfirmed: true }, conquestWorld({ free_city: { p: '129', q: '0', site: 99, tile: 43 } })]) {
    const { gate, answer } = open(); answer.start = () => conquestReply(world); await made(gate); await gate.connect(); const result = await gate.ready;
    assert.deepEqual(result.cfg.localPlay, IDENTITY, JSON.stringify(world)?.slice(0, 120)); assert.equal(Object.hasOwn(result.cfg.localPlay, 'conquestWorld'), false); assert.equal(gate.state().conquestWorld, null);
  }
  // the Season is the one the HERALD showed, not the one the launcher's answer names: a statement for another Season than the verified one is dropped
  { const { gate, answer, h } = open(); const other = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '12');
    answer.start = () => conquestReply(conquestWorld({ season: other.season })); await made(gate); await gate.connect(); const result = await gate.ready;
    assert.equal(result.cfg.localPlay.seasonAddress, ADDRS.season); assert.equal(Object.hasOwn(result.cfg.localPlay, 'conquestWorld'), false); assert.equal(h.pinned.season, ADDRS.season); }
  // a refused start leaves none behind, and the next start's answer decides anew
  { const { gate, answer } = open(); let n = 0; answer.start = () => (++n === 1 ? refusal(503, { error: 'RunnerNotReady', conquestWorld: conquestWorld() }) : launchReply('http://localhost:41926'));
    await made(gate); await gate.connect(); assert.equal(gate.state().phase, 'refused'); assert.equal(gate.state().conquestWorld, null);
    await gate.connect(); const result = await gate.ready; assert.deepEqual(result.cfg.localPlay, IDENTITY); }
  // without launcher=1 (the operator's own herald) nothing says a world is a conquest world: nothing is asked, nothing is attached
  { const doc = stubDocument(), h = heralds(), calls = []; h.season = goodSeason(); h.me = goodMe;
    const gate = LP.openLocalPlayGate({ cfg: { ...CFG, localPlay: { conquestWorld: conquestWorld() }, conquestWorld: conquestWorld() }, loc: loc('http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&conquestWorld=1'), doc, win: stubWindow(), makeHerald: h.make, makeWallet: maker(), now: () => T0,
      request: async (...a) => { calls.push(a); return conquestReply(conquestWorld()); } });
    await made(gate); doc.byId('local-play-herald').value = 'http://127.0.0.1:41906'; await gate.connect(); const result = await gate.ready;
    assert.equal(calls.length, 0); assert.deepEqual(result.cfg.localPlay, IDENTITY, 'the identity is made of what the herald showed, and of nothing the page was given'); assert.equal(gate.state().conquestWorld, null); }
});

test('the conquest statement: read from the start answer only, attached to the identity only, and the page reads it from there', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const code = read('flocalplay.mjs').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(code.split('body?.conquestWorld').length - 1, 1, 'one read, of the start\'s answer'); assert.equal(code.split('launcherConquestWorld(').length - 1, 2, 'its definition and its one use');
  assert.match(code, /const world = launcher \? launcherConquestWorld\(claimed, result\.identity\) : null;/, 'only in launcher mode, only against the identity the herald verified');
  assert.match(code, /const identity = world \? Object\.freeze\(\{ \.\.\.result\.identity, conquestWorld: world \}\) : result\.identity;/);
  // nothing of the siege itself is the gate's: no route, no condition, no heap, no artefact
  assert.doesNotMatch(code, /heapConfirmed|pageBinding|conquest\/prepare|conquest\/submit|artifact|markers|PSF_/);
  // where the page reads it (the controller makes the gate's identity FS.localPlay; the card and the conquest step read conquestWorld from it): read-only here
  const controller = read('controller.mjs'), hand = read('hud/hand.mjs');
  assert.match(controller, /localPlay = cfg\.localPlay \?\? null/); assert.match(controller, /FS\.localPlay = localPlay/); assert.match(controller, /localPlay\?\.conquestWorld \?\? null/); assert.match(hand, /FS\.localPlay\.conquestWorld \?\? null/);
});

// ---- English: the same panel with English shown (lang.mjs `setLang`), every state of it
const JP = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60\uff66-\uff9f]/;
const english = async fn => { setLang('en'); try { await fn(); } finally { setLang('ja'); } };
const isLangKey = e => e.className.split(' ').includes('lang-toggle');
/** Every text the player can read on the panel now (the language key apart: it names the OTHER language, in that language). */
const readable = doc => doc.all.filter(e => doc.shown(e) && e.children.length === 0 && !isLangKey(e) && e.tag !== 'link').map(e => e.textContent).filter(Boolean);
const allEnglish = (doc, at) => { const texts = readable(doc); assert.ok(texts.length >= 4, at); for (const text of texts) assert.doesNotMatch(text, JP, `${at}: Japanese left on the panel: ${text}`); return texts; };
const status = doc => doc.byId('local-play-status').textContent;

test('every text of the gate has an English entry: English only, only the key\'s placeholders, a plural where a count is said', () => {
  const code = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay.mjs', import.meta.url), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const keys = [...new Set([...code.matchAll(/\bL`((?:[^`\\]|\\.)*)`/g)].map(m => { let i = 0; return m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`); }))];
  assert.ok(keys.length >= 60, `${keys.length} texts in flocalplay.mjs`);
  const holes = text => [...String(text).matchAll(/\{(\d+)\}/g)].map(m => +m[1]);
  for (const key of keys) {
    const en = EN[key];
    assert.ok(typeof en === 'string' || typeof en === 'function', `no English for ${JSON.stringify(key)}`);
    const n = new Set(holes(key)).size;
    for (const out of typeof en === 'function' ? [en(...Array(n).fill(1)), en(...Array(n).fill(2))] : [en]) {
      assert.equal(typeof out, 'string'); assert.doesNotMatch(out, JP, `Japanese in the English of ${JSON.stringify(key)}`); assert.ok(out.trim().length > 0);
      for (const hole of holes(out)) assert.ok(hole < n, `{${hole}} is not in ${JSON.stringify(key)}`);
      assert.deepEqual([...new Set(holes(out))].sort(), [...new Set(holes(key))].sort(), `the English of ${JSON.stringify(key)} uses each value`);
    }
  }
  // a count is said as English says it: one world / two worlds, one second / two seconds
  for (const key of ['{0}秒経過', '動いている世界は{0}個です。終了する世界があれば、下の一覧のその行で選べます。']) { assert.equal(typeof EN[key], 'function', key); assert.notEqual(EN[key](1), EN[key](2)); }
  // a sentence that quotes a key's label quotes that key's English
  const start = EN['新しい世界を開始'], connect = EN['接続'];
  for (const key of keys.filter(k => k.includes('「新しい世界を開始」'))) assert.ok(EN[key].includes(`"${start}"`), key);
  for (const key of keys.filter(k => k.includes('「接続」'))) assert.ok(EN[key].includes(`"${connect}"`), key);
  assert.ok(keys.filter(k => k.includes('「新しい世界を開始」')).length >= 2 && keys.filter(k => k.includes('「接続」')).length >= 1);
  // every refusal code the panel can show has its sentence in English too
  setLang('en');
  try {
    for (const c of ['HeraldUnreachable', 'HeraldNotReady', 'LocalPlayProgram', 'LocalPlayCluster', 'LocalPlayVersion', 'LocalPlaySeason', 'WalletNotBound', 'WalletBindingMismatch', 'BadHerald', 'NoEd25519', 'EphemeralWalletHost',
      'LauncherFailed', 'LauncherTimeout', 'WorldLimit', 'WorldStopping', 'LauncherDiskFloor', 'LauncherPortBusy', 'LauncherRunnerNotReady', 'LauncherHeraldNotReady', 'LauncherClosed', 'LauncherStopFailed', 'LauncherListFailed', 'LauncherPrepareFailed']) {
      const said = LP.localPlayWhy(c); assert.notEqual(said, c, `${c} has a sentence`); assert.doesNotMatch(said, JP, `${c}: ${said}`); assert.match(said, /^[A-Z]/); assert.match(said, /\.$|\)\.$|\)$/);
    }
  } finally { setLang('ja'); }
  assert.equal(lang(), 'ja');
});

test('in English: the start, the wait, the boot; then the limit, the list, the explicit end and the start again', async () => {
  await english(async () => {
    let full = false, releaseStart = null, releaseStop = null, running = [];
    const { gate, doc, calls, answer } = open();
    answer.start = async () => { await new Promise(r => { releaseStart = r; }); return full ? refusal(409, { error: 'WorldLimit', worlds: twoWorlds() }) : launchReply('http://localhost:41926'); };
    answer.stop = async () => { await new Promise(r => { releaseStop = r; }); full = false; return { ok: true, status: 200, json: async () => ({ stopped: true }) }; };
    answer.worlds = () => ({ ok: true, status: 200, json: async () => ({ worlds: running }) });
    assert.equal(status(doc), 'Making the test wallet…');
    await made(gate);
    // before the press
    assert.equal(doc.byId('local-play-title').textContent, 'Play in a new world'); assert.equal(doc.byId('local-play-connect').textContent, 'Start a new world'); assert.equal(doc.byId('local-play-list').textContent, 'Check running worlds');
    const points = doc.byClass('local-play-note').filter(doc.shown).map(e => e.textContent); assert.equal(points.length, 4);
    for (const [i, part] of [[0, /A test world on this machine only/], [1, /The key is never stored/], [1, /after a reload or closing the page this world cannot be continued/], [1, /start from a new world/], [2, /a turn takes 10 minutes/], [3, /At most two worlds/], [3, /two hours/], [3, /none is ended for you/]]) assert.match(points[i], part);
    assert.equal(doc.byClass('local-play-label').filter(doc.shown)[0].textContent, 'This world\'s public address'); assert.equal(doc.byId('local-play-address').textContent, ME);
    assert.equal(status(doc), 'Press "Start a new world" to prepare one. Sending and signing are yours to confirm in the game.');
    allEnglish(doc, 'before the press');
    // the list, asked for: none, then one, then two
    doc.byId('local-play-list').click(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(status(doc), 'No world is running.'); allEnglish(doc, 'no world');
    running = [twoWorlds()[0]]; doc.byId('local-play-list').click(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(status(doc), '1 world is running. To end it, use its row in the list below.');
    assert.deepEqual(rowsOf(doc).map(r => [r.line.textContent, r.end.textContent]), [['Started 12 min ago · Running', 'End this world…']]);
    assert.equal(doc.byId('local-play-worlds-label').textContent, 'Running worlds (public addresses)'); allEnglish(doc, 'one world');
    running = [{ ...twoWorlds()[0], state: 'starting' }, { ...twoWorlds()[1], state: 'stopping' }]; doc.byId('local-play-list').click(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(status(doc), '2 worlds are running. To end one, use its row in the list below.');
    assert.deepEqual(rowsOf(doc).map(r => r.line.textContent), ['Started 12 min ago · Starting', 'Started just now · Ending']); allEnglish(doc, 'two worlds');
    // the start: the wait, said with how long so far
    doc.byId('local-play-connect').click(); await settle();
    assert.equal(status(doc), 'Preparing the world… (up to 70 seconds)'); assert.equal(doc.byClass('local-play-elapsed')[0].textContent, '0 seconds elapsed'); allEnglish(doc, 'the wait');
    releaseStart(); const result = await gate.ready;
    assert.equal(status(doc), 'Connected: loading this wallet\'s citizen and village (reads only; nothing is sent).'); assert.equal(result.cfg.herald, 'http://localhost:41926');
    // a second page, at the limit: the refusal in words with its code, the rows, the question and its two keys
    full = true; const second = open(); second.answer.start = answer.start; second.answer.stop = answer.stop;
    await made(second.gate); second.doc.byId('local-play-connect').click(); await settle(); releaseStart(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(status(second.doc), 'Two worlds are already running. To start a new one, choose a world to end from the list below (none is ended for you). (WorldLimit)');
    let rows = rowsOf(second.doc); assert.deepEqual(rows.map(r => r.line.textContent), ['Started 12 min ago · Running', 'Started just now · Running']);
    rows[0].end.click(); rows = rowsOf(second.doc);
    assert.equal(rows[0].ask.textContent, 'End this world? This cannot be undone. A page playing in this world will not be able to continue.'); assert.deepEqual([rows[0].yes.textContent, rows[0].no.textContent], ['End it', 'Cancel']);
    allEnglish(second.doc, 'the question');
    rows[0].yes.click(); await settle(); assert.equal(status(second.doc), 'Ending the chosen world…'); allEnglish(second.doc, 'ending');
    releaseStop(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(status(second.doc), 'The world was ended. Press "Start a new world" again to prepare a new one.'); allEnglish(second.doc, 'ended');
    second.doc.byId('local-play-connect').click(); await settle(); releaseStart(); await second.gate.ready; assert.equal(second.gate.state().phase, 'connected');
    assert.equal(stops(second.calls).length, 1); assert.equal(calls.length, 4, 'the first page: three lists and one start');
  });
  assert.equal(lang(), 'ja', 'the tests after this one read Japanese again');
});

test('in English: a prepared world, and every way a start, a stop or a list can fail, each with the way to try again', async () => {
  await english(async () => {
    let go = null;
    const fast = open({ loc: fastLoc(), stopTimeoutMs: 20 });
    fast.answer.start = async () => { await new Promise(r => { go = r; }); return refusal(503, { error: 'PrepareTimeout' }); };
    await made(fast.gate);
    const points = fast.doc.byClass('local-play-note').filter(fast.doc.shown).map(e => e.textContent); assert.equal(points.length, 5);
    assert.equal(points[4], 'During its preparation only, this test world\'s clock is run faster (to open the destination province). It is set back to normal speed before you can act, and is not run faster after that.');
    fast.doc.byId('local-play-connect').click(); await settle();
    assert.equal(status(fast.doc), 'Preparing the world… (as part of preparing this test world, its clock is run faster; up to 150 seconds)'); allEnglish(fast.doc, 'the prepared wait');
    go(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(status(fast.doc), 'The test world\'s preparation (running its clock faster) could not be finished. That world was ended. Press again to prepare a new world. (LauncherPrepareFailed: PrepareTimeout)');
    assert.equal(fast.doc.byId('local-play-connect').disabled, false, 'and the key may be pressed again'); allEnglish(fast.doc, 'the preparation refused');
    // each refusal of a start: its sentence, its code, the key enabled
    const { gate, doc, answer } = open({ stopTimeoutMs: 20, launcherTimeoutMs: 20 });
    await made(gate);
    for (const [reply, said] of [
      [refusal(503, { error: 'DiskFloor' }), 'This machine is short of free disk space, so a world cannot be prepared (at least 5.25 GiB free is needed). (LauncherDiskFloor)'],
      [refusal(503, { error: 'PortBusy' }), 'A port the world needs is in use by another program. Wait a moment, then press again. (LauncherPortBusy)'],
      [refusal(503, { error: 'RunnerNotReady' }), 'The world\'s runner could not be started. Check the start service\'s record (runner.err). (LauncherRunnerNotReady)'],
      [refusal(503, { error: 'HeraldNotReady' }), 'The world\'s herald was not ready in time. Press again. (LauncherHeraldNotReady)'],
      [refusal(503, { error: 'LauncherClosed' }), 'The start service is shutting down. Start it again, then reopen this page. (LauncherClosed)'],
      [refusal(409, { error: 'WorldStopping' }), 'This world is being ended. Wait a moment, then press again. (WorldStopping)'],
      [refusal(500, { error: 'anything' }), 'The world could not be started. Check the start service, then press again. (LauncherFailed)'],
      [launchReply('http://example.com'), 'The herald address must be an http(s) URL on this machine (localhost / 127.0.0.1). (BadHerald)'],
    ]) { answer.start = () => reply; await gate.connect(); assert.equal(status(doc), said); assert.equal(doc.byId('local-play-connect').disabled, false); allEnglish(doc, said); }
    answer.start = () => new Promise(() => {}); await gate.connect();
    assert.equal(status(doc), 'The world is not ready yet. You can try again with the same wallet. (LauncherTimeout)'); allEnglish(doc, 'timeout');
    // the world answers, but it is not this wallet's local play
    const refusedBy = async (season, me, said) => { const x = open(); x.h.season = season; x.h.me = me; await made(x.gate); await x.gate.connect(); assert.equal(status(x.doc), said); allEnglish(x.doc, said); };
    await refusedBy(goodSeason({ season: { programVersion: 4 } }), goodMe, 'This herald\'s season is not the local-play revision. (LocalPlayVersion)');
    await refusedBy(goodSeason({ record: { programId: W2 } }), goodMe, 'This herald does not serve the dedicated local-play program. (LocalPlayProgram)');
    await refusedBy(goodSeason({ record: { cluster: 'devnet' } }), goodMe, 'This herald is not on localnet. (LocalPlayCluster)');
    await refusedBy(goodSeason({ record: { seasonAddress: W2 } }), goodMe, 'This herald\'s season is not the canonical season of the dedicated local-play program. (LocalPlaySeason)');
    await refusedBy(goodSeason(), goodMe.bind(null, W2), 'The citizen this herald serves belongs to another wallet. (WalletBindingMismatch)');
    // the list and the end can fail too
    answer.worlds = () => { throw new Error('ECONNREFUSED'); }; doc.byId('local-play-list').click(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(status(doc), 'The running worlds could not be checked. Check the start service, then press again. (LauncherListFailed)'); allEnglish(doc, 'list failed');
    answer.worlds = () => ({ ok: true, status: 200, json: async () => ({ worlds: twoWorlds() }) }); answer.stop = () => refusal(500, null);
    doc.byId('local-play-list').click(); for (let i = 0; i < 4; i++) await settle(); rowsOf(doc)[0].end.click(); rowsOf(doc)[0].yes.click(); for (let i = 0; i < 4; i++) await settle();
    assert.equal(status(doc), 'The world could not be ended. Check the start service, then press again. (LauncherStopFailed)'); assert.equal(rowsOf(doc).length, 2); allEnglish(doc, 'stop failed');
    // a wallet that cannot be made, and one destroyed
    const broken = open({ makeWallet: async () => { throw Object.assign(new Error('x'), { code: 'NoEd25519' }); } }); await broken.gate.ready.catch(() => {});
    assert.equal(status(broken.doc), 'This browser cannot make the test wallet (open the page in a recent browser that supports Ed25519). (NoEd25519)'); allEnglish(broken.doc, 'no wallet');
    const gone = open(); await made(gone.gate); gone.win.dispatchEvent(new Event('pagehide'));
    assert.equal(status(gone.doc), 'The wallet was destroyed. Reopen the page.'); allEnglish(gone.doc, 'destroyed');
  });
});

test('in English: the operator\'s panel (no launcher) reads in English too', async () => {
  await english(async () => {
    const doc = stubDocument(), h = heralds(); h.season = new Error('refused'); h.me = goodMe;
    const gate = LP.openLocalPlayGate({ cfg: CFG, loc: loc('http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1'), doc, win: stubWindow(), makeHerald: h.make, makeWallet: maker(), request: async () => assert.fail() });
    await made(gate);
    assert.equal(doc.byId('local-play-title').textContent, 'Local play setup'); assert.equal(doc.byId('local-play-connect').textContent, 'Connect');
    assert.deepEqual(doc.byClass('local-play-label').filter(doc.shown).map(e => e.textContent), ['Public address (used to start the runner)', 'Herald address']);
    assert.equal(doc.byClass('local-play-note')[0].textContent, 'A test wallet for this machine only. Its key is kept only in this page\'s memory and is never stored. Closing or reloading the page loses it.');
    assert.equal(status(doc), 'Getting ready: start the runner and the herald for this address, then press "Connect".'); allEnglish(doc, 'operator waiting');
    await gate.connect(); assert.equal(status(doc), 'This herald cannot be reached yet. Start the runner and the herald, then connect again. (HeraldUnreachable)');
    h.season = { ok: false, code: 'NotFound' }; await gate.connect(); assert.equal(status(doc), 'The herald answered, but it has no season record yet. Wait a moment, then connect again. (HeraldNotReady)');
    h.season = goodSeason(); h.me = { ok: false, code: 'NotFound' }; await gate.connect(); assert.equal(status(doc), 'This herald has no citizen or village for this wallet. Start the runner with the address above. (WalletNotBound)');
    allEnglish(doc, 'operator refused');
    let release; h.hold = new Promise(r => { release = r; }); h.me = goodMe; const checking = gate.connect(); await settle();
    assert.equal(status(doc), 'Checking the herald\'s records…'); release(); await checking; assert.equal(gate.state().phase, 'connected');
  });
});

test('the language can be chosen on the panel itself, and a switch while the panel stands rewrites every text in place', async () => {
  assert.equal(lang(), 'ja');
  const { gate, doc, answer, calls } = open();
  answer.start = () => refusal(409, { error: 'WorldLimit', worlds: twoWorlds() });
  await made(gate); await gate.connect(); rowsOf(doc)[0].end.click();
  // the page's own language key stands on the panel (the page's is not mounted until the boot, and the panel covers it)
  const keys = doc.all.filter(isLangKey); assert.equal(keys.length, 1);
  assert.equal(keys[0].tag, 'button'); assert.equal(keys[0].dataset.langToggle, '', 'lang.mjs takes its clicks, as for every such key on the page'); assert.equal(keys[0].textContent, 'EN'); assert.equal(keys[0].attrs['aria-label'], 'Switch to English');
  assert.ok(keys[0].className.split(' ').includes('local-play-lang')); assert.equal(keys[0].parent.className, 'local-play-head'); assert.equal(keys[0].parent.children[1], doc.byId('local-play-title'));
  const japanese = { title: doc.byId('local-play-title').textContent, start: doc.byId('local-play-connect').textContent, status: status(doc), line: rowsOf(doc)[0].line.textContent, ask: rowsOf(doc)[0].ask.textContent };
  assert.equal(japanese.title, '新しい世界で遊ぶ'); assert.match(japanese.status, /すでに2つの世界が動いています/);
  const requests = calls.length;
  setLang('en');
  try {
    // the same panel, the same state (the question still asked on the same row), in English; nothing was asked of the launcher for it
    assert.equal(doc.byId('local-play-title').textContent, 'Play in a new world'); assert.equal(doc.byId('local-play-connect').textContent, 'Start a new world');
    assert.equal(status(doc), 'Two worlds are already running. To start a new one, choose a world to end from the list below (none is ended for you). (WorldLimit)');
    const rows = rowsOf(doc); assert.equal(rows[0].line.textContent, 'Started 12 min ago · Running'); assert.equal(rows[0].ask.hidden, false); assert.equal(rows[0].yes.textContent, 'End it'); assert.equal(rows[1].end.textContent, 'End this world…');
    assert.equal(gate.state().phase, 'refused'); assert.equal(calls.length, requests); allEnglish(doc, 'after the switch');
  } finally { setLang('ja'); }
  // and back, exactly as it was
  assert.deepEqual({ title: doc.byId('local-play-title').textContent, start: doc.byId('local-play-connect').textContent, status: status(doc), line: rowsOf(doc)[0].line.textContent, ask: rowsOf(doc)[0].ask.textContent }, japanese);
  // a switch while a start is under way: the wait's words and the count change too
  let go; answer.start = async () => { await new Promise(r => { go = r; }); return launchReply('http://localhost:41926'); };
  rowsOf(doc)[0].no.click(); doc.byId('local-play-connect').click(); await settle();
  assert.equal(doc.byClass('local-play-elapsed')[0].textContent, '0秒経過');
  setLang('en');
  try { assert.equal(status(doc), 'Preparing the world… (up to 70 seconds)'); assert.equal(doc.byClass('local-play-elapsed')[0].textContent, '0 seconds elapsed'); } finally { setLang('ja'); }
  go(); await gate.ready;
  // once the page has booted the hidden panel is left alone
  const title = doc.byId('local-play-title').textContent; setLang('en'); try { assert.equal(doc.byId('local-play-title').textContent, title); } finally { setLang('ja'); }
});

test('a document that cannot hold the language key (the plain stub of web-frontier-local-play.test.mjs) still gets the whole panel, and a switch still rewrites it', async () => {
  // (that file's own tests need the real memory-only wallet and are not run under the guard: this is its document, with the stand-in wallet)
  const all = [];
  const make = tag => { const listeners = {}; const el = { tag, className: '', textContent: '', id: '', hidden: false, disabled: false, value: '', dataset: {}, attrs: {}, children: [],
    setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { el.children.push(...xs); }, addEventListener(k, f) { (listeners[k] ??= []).push(f); }, click() { for (const f of listeners.click ?? []) f(); }, listeners };
    all.push(el); return el; };
  const doc = { body: make('body'), head: make('head'), createElement: make, byId: id => all.find(e => e.id === id), all }, h = heralds(); h.season = goodSeason(); h.me = goodMe;
  const calls = [];
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc, win: stubWindow(), makeHerald: h.make, makeWallet: maker(), now: () => T0,
    request: async (...a) => { calls.push(a); return refusal(409, { error: 'WorldLimit', worlds: twoWorlds() }); } });
  assert.match(doc.byId('local-play-status').textContent, /作っています/); assert.equal(doc.byId('local-play-connect').disabled, true);
  await made(gate);
  assert.equal(all.filter(e => e.className.includes('lang-toggle')).length, 0, 'no key where there is nothing to hold it');
  assert.equal(doc.byId('local-play-title').textContent, '新しい世界で遊ぶ'); assert.equal(doc.byId('local-play-connect').textContent, '新しい世界を開始'); assert.equal(doc.byId('local-play-herald').hidden, true);
  assert.equal(doc.byId('local-play-address').textContent, ME); assert.ok(all.some(e => /再読み込み/.test(e.textContent) && /続けられません/.test(e.textContent)));
  assert.match(doc.byId('local-play-css').href, /\/frontier\/flocalplay\.css$/); assert.equal(doc.byId('local-play-css').rel, 'stylesheet');
  doc.byId('local-play-connect').click(); for (let i = 0; i < 4; i++) await settle();
  assert.equal(gate.state().code, 'WorldLimit'); assert.equal(calls.length, 1);
  const rows = all.filter(e => e.className === 'local-play-world' && !e.hidden); assert.equal(rows.length, 2); assert.equal(rows[0].children[2].textContent, 'この世界を終了…');
  setLang('en');
  try { assert.equal(doc.byId('local-play-title').textContent, 'Play in a new world'); assert.equal(rows[0].children[2].textContent, 'End this world…'); assert.match(doc.byId('local-play-status').textContent, /^Two worlds are already running/); } finally { setLang('ja'); }
  assert.equal(doc.byId('local-play-title').textContent, '新しい世界で遊ぶ');
});

test('the source: four launcher routes and no other, no storage, no markup from a reply; the page wiring is untouched', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const lp = read('flocalplay.mjs'), code = lp.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.deepEqual([...new Set([...code.matchAll(/'(\/local-play\/[^']*)'/g)].map(m => m[1]))].sort(), ['/local-play/keeper', '/local-play/start', '/local-play/stop', '/local-play/worlds'], 'the only launcher routes the page knows');
  // (that it names no signing call either is the hooks test of web-frontier-local-play.test.mjs, which runs under the guard too)
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|innerHTML|outerHTML|insertAdjacentHTML|\.style\b|keyFromSeed|fsession|sendTransaction|fetch\(|sendBeacon|XMLHttpRequest|WebSocket|eval\(|Function\(/);
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort(), ['../lang.mjs', '../sdk/base58.mjs', './faddr.mjs', './fephemeral-wallet.mjs', './flocalplay-instance.mjs', './flocalplay-session.mjs']);
  assert.match(code, /import \{ mountSessionNotice \} from '\.\/flocalplay-session\.mjs';/, 'the standing notice (a display only)');
  assert.match(code, /import \{ confirmWorldEnd \} from '\.\/flocalplay-instance\.mjs';/, 'and the one read that confirms its end (web-frontier-local-play-world-instance.test.mjs)');
  assert.equal(code.split('confirmWorldEnd(').length - 1, 1, 'called once, after the world was verified');
  assert.match(code, /makeWallet = createEphemeralWallet/, 'the page\'s wallet is the memory-only one unless a test replaces it');
  // the language: lang.mjs's own text function, switch listener and key; the panel sets no language itself and stores none
  assert.match(code, /import \{ L, onLangChange, mountLangToggle \} from '\.\.\/lang\.mjs';/); assert.doesNotMatch(code, /setLang|toggleLang|ps-lang/);
  assert.equal(code.split('mountLangToggle(').length - 1, 1); assert.equal(code.split('onLangChange(').length - 1, 1); assert.match(code, /if \(s\.phase === 'connected'\) \{ root\.hidden = true; unlabel\(\); \}/);
  // every launcher request: a same-origin POST of JSON, no credentials, no redirect followed; the start names the page's own public address,
  // the stop the chosen world's, the list nothing
  const shape = "{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(BODY), signal: abort.signal, credentials: 'omit', redirect: 'error' }";
  assert.equal(code.split(`await request(new URL('/local-play/start', loc.href).href, ${shape.replace('BODY', '{ wallet: handle.address }')})`).length - 1, 1);
  assert.equal(code.split(`await request(new URL(route, loc.href).href, ${shape.replace('BODY', 'body')})`).length - 1, 1);
  assert.equal(code.split('request(').length - 1, 2, 'and no other request');
  assert.deepEqual([...code.matchAll(/askLauncher\(([^)]*)\)/g)].map(m => m[1]).sort(), ["'/local-play/keeper', { wallet }, 'LauncherKeeperFailed'", "'/local-play/stop', { wallet: address }, 'LauncherStopFailed'", "'/local-play/worlds', {}, 'LauncherListFailed'"]);
  // the keeper's view: asked only from the standing notice's key, for this page's own address, never polled
  assert.match(code, /if \(launcher\) \{ const mine = handle\.address; session = mountSessionNotice\(\{ doc, win, onCheck: \(\) => checkKeeper\(mine\) \}\); \}/);
  assert.equal(code.split('checkKeeper(').length - 1, 1, 'only the notice\'s key calls it');
  // the preparation is the launcher's alone: the page reads its word from the page address and its answer, and names no clock call, scale or option
  assert.doesNotMatch(code, /setScale|frontier_|prepare-scale|prepareScale/); assert.equal(code.split("searchParams.get('prepare')").length - 1, 1);
  assert.match(code, /const accelerated = localPreparationAccelerated\(cfg, loc\), natural = localNaturalWorld\(cfg, loc\), longest = natural \? NATURAL_START_MS : accelerated \? 150000 : 70000;/); assert.match(code, /const deadline = Math\.min\(longest, Math\.max\(1, launcherTimeoutMs \?\? longest\)\);/);
  // the end of a world is reachable only from the confirming key of a row, the list only from its own key
  assert.equal(code.split('onEnd(').length - 1, 1); assert.match(code, /yes\.addEventListener\('click', \(\) => \{ const w = shown\[i\]; if \(!w \|\| armed !== w\.wallet \|\| yes\.disabled\) return; armed = null; onEnd\(w\.wallet\); \}\);/);
  assert.equal(code.split('onList(').length - 1, 1); assert.match(code, /list\.addEventListener\('click', \(\) => \{ if \(!list\.disabled\) onList\(\); \}\);/);
  assert.equal(code.split('endWorld(').length - 1, 0, 'the gate itself never calls them'); assert.equal(code.split('listWorlds(').length - 1, 0);
  assert.equal(code.split('onEnd: endWorld').length - 1, 1); assert.equal(code.split('onList: listWorlds').length - 1, 1);
  // app.mjs still opens the gate exactly as it did: the launcher changes nothing of the boot
  const app = read('app.mjs');
  assert.match(app, /if \(localPlayRequested\(cfg\)\) cfg = \(await openLocalPlayGate\(\{ cfg, makeHerald: base => createHerald\(\{ base \}\) \}\)\.ready\)\.cfg;/);
  assert.equal(app.split('makeWallet').length - 1, 0); assert.equal(app.split('/local-play/').length - 1, 0);
  // the rows' styles: scoped to the panel, and a hidden row stays hidden
  const css = read('flocalplay.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of css.split('}').map(r => r.split('{')[0].trim()).filter(r => r && !r.startsWith('@'))) for (const sel of rule.split(',')) assert.match(sel.trim(), /^#local-play-(gate|session)\b/, `scoped to the panel or the standing notice: ${sel.trim()}`);
  for (const rule of css.split('}').filter(r => /display:\s*(grid|flex|block)/.test(r.split('{')[1] ?? '') && /\.local-play-world(s)?\b(?!-)/.test(r.split('{')[0]))) assert.match(rule.split('{')[0], /:not\(\[hidden\]\)/, 'what sets display does not show a hidden row');
  assert.match(css, /\.local-play-end:focus-visible/); assert.match(css, /min-height: 44px/);
});
