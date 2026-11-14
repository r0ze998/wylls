// Local play, the explicit opt-in of the game page (web/frontier/flocalplay.mjs and its hooks in app.mjs and
// controller.mjs). THIS FILE MAKES KEYS: the gate creates the page's memory-only Ed25519 test wallet inside this
// process's WebCrypto. It is run WITHOUT the no-key guard, and only this file:
//   node --test ./permutation-gateway/test/web-frontier-local-play.test.mjs
// A stub document and stub herald clients only: no page boot, network, chain, runner or stored key.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import * as EW from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
const SEASON_ID = '11', ADDRS = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, SEASON_ID);

const CFG = { origin: 'http://127.0.0.1:41970', herald: 'http://127.0.0.1:41970', relay: 'http://127.0.0.1:41970/gw', dev: true, mode: 'play' };
const loc = (href = 'http://127.0.0.1:41970/frontier/index.html?localPlay=1&herald=http://127.0.0.1:41990') => { const u = new URL(href); return { href, hostname: u.hostname, origin: u.origin }; };
beforeEach(() => { EW.destroyEphemeralWallet(); });

/** The smallest document the panel needs: elements that keep what was set on them. */
function stubDocument() {
  const all = [];
  const make = tag => { const listeners = {}; const el = { tag, className: '', textContent: '', id: '', hidden: false, disabled: false, value: '', dataset: {}, attrs: {}, children: [],
    setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { el.children.push(...xs); }, addEventListener(k, f) { (listeners[k] ??= []).push(f); }, click() { for (const f of listeners.click ?? []) f(); }, listeners };
    all.push(el); return el; };
  const body = make('body'), head = make('head');
  return { body, head, createElement: make, byId: id => all.find(e => e.id === id), all };
}
const stubWindow = () => { const w = new EventTarget(); return w; };
/** A herald client that answers what the test last set. `calls` counts the season reads. */
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
/** Wait until the gate has made its wallet (key generation is the engine's own time). */
const made = async gate => { for (let i = 0; i < 500 && gate.state().phase === 'creating'; i++) await settle(); assert.notEqual(gate.state().phase, 'creating', 'the wallet was made'); };

test('local play is asked for only by ?localPlay=1 on a loopback play page; every other page is untouched', () => {
  assert.equal(LP.localPlayRequested(CFG, loc()), true);
  for (const href of ['http://127.0.0.1:41970/frontier/index.html', 'http://127.0.0.1:41970/frontier/index.html?localPlay=0', 'http://127.0.0.1:41970/frontier/index.html?localPlay=true',
    'http://127.0.0.1:41970/frontier/index.html?localPlay=', 'http://127.0.0.1:41970/frontier/index.html?localplay=1', 'http://127.0.0.1:41970/frontier/index.html#localPlay=1'])
    assert.equal(LP.localPlayRequested(CFG, loc(href)), false, href);
  for (const href of ['https://wylls.example/frontier/index.html?localPlay=1', 'http://192.168.1.5:8000/frontier/index.html?localPlay=1', 'http://wylls.test/frontier/?localPlay=1'])
    assert.equal(LP.localPlayRequested({ ...CFG, dev: false }, loc(href)), false, href);
  assert.equal(LP.localPlayRequested({ ...CFG, dev: true }, loc('https://wylls.example/frontier/index.html?localPlay=1')), false, 'the host itself is checked, not only the config');
  for (const mode of ['spectate', 'practice']) assert.equal(LP.localPlayRequested({ ...CFG, mode }, loc()), false, mode);
  assert.equal(LP.localPlayRequested(null, loc()), false);
  assert.equal(LP.LOCAL_PLAY_PROGRAM, '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn'); assert.deepEqual([...fromB58(LP.LOCAL_PLAY_PROGRAM)], Array(32).fill(0x45));
  assert.equal(LP.LOCAL_PLAY_PROGRAM_VERSION, 0x4804);
  // the herald an operator may name: this machine, http(s), origin only
  assert.equal(LP.localHeraldOrigin(' http://127.0.0.1:41990/h/season?x=1 '), 'http://127.0.0.1:41990'); assert.equal(LP.localHeraldOrigin('http://localhost:8899'), 'http://localhost:8899');
  for (const bad of ['', 'x', 'ftp://127.0.0.1', 'http://example.com', 'https://herald.wylls.example', 'http://user:pw@127.0.0.1:1', 'javascript:alert(1)', '//127.0.0.1', null]) assert.equal(LP.localHeraldOrigin(bad), null, String(bad));
});

test('a herald is this wallet\'s local play only by its own records: program, cluster, version and the Citizen\'s wallet', async () => {
  const address = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', other = 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3';
  const pins = [];
  const check = (season, me) => LP.verifyLocalPlayHerald({ season: async () => { if (season instanceof Error) throw season; return season; }, me: async a => (typeof me === 'function' ? me(a) : me), pin: (id, addresses) => { pins.push([id, addresses.season]); } }, address);
  const good = await check(goodSeason(), goodMe(address));
  assert.equal(good.ok, true); assert.deepEqual(good.identity, { address, programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', seasonId: SEASON_ID, seasonAddress: ADDRS.season });
  assert.deepEqual(pins, [[SEASON_ID, ADDRS.season]], 'the client is pinned to the canonical Season before the player is read');
  const cases = [
    [new Error('fetch failed'), null, 'HeraldUnreachable'], [{ ok: false, code: 'network' }, null, 'HeraldUnreachable'], [{ ok: false, code: 'NotFound' }, null, 'HeraldNotReady'], [{ ok: false, code: 'BadRecord' }, null, 'HeraldNotReady'],
    [goodSeason({ record: { programId: other } }), goodMe(address), 'LocalPlayProgram'], [goodSeason({ record: { cluster: 'devnet' } }), goodMe(address), 'LocalPlayCluster'], [goodSeason({ record: { cluster: 'mainnet-beta' } }), goodMe(address), 'LocalPlayCluster'],
    [goodSeason({ season: { programVersion: 4 } }), goodMe(address), 'LocalPlayVersion'], [goodSeason({ season: { programVersion: 0x4004 } }), goodMe(address), 'LocalPlayVersion'], [goodSeason({ season: { programVersion: '18436' } }), goodMe(address), 'LocalPlayVersion'],
    [goodSeason({ record: { seasonAddress: other } }), goodMe(address), 'LocalPlaySeason'], [goodSeason({ record: { season: '12' } }), goodMe(address), 'LocalPlaySeason'], [goodSeason({ season: { seasonId: 12n } }), goodMe(address), 'LocalPlaySeason'],
    [goodSeason({ record: { season: 'x' } }), goodMe(address), 'LocalPlaySeason'], [goodSeason(), { ok: false, code: 'WrongKey' }, 'WalletBindingMismatch'], [goodSeason(), { ok: false, code: 'WrongSeason' }, 'WalletBindingMismatch'],
    [goodSeason(), { ok: false, code: 'NotFound' }, 'WalletNotBound'], [goodSeason(), { ok: true, citizen: null, holdings: [] }, 'WalletNotBound'], [goodSeason(), { ok: true, citizen: { wallet: fromB58(address) }, holdings: [] }, 'WalletNotBound'],
    [goodSeason(), { ok: false, code: 'network' }, 'HeraldUnreachable'], [goodSeason(), goodMe(other), 'WalletBindingMismatch'], [goodSeason(), { ok: true, citizen: { wallet: 'not bytes' }, holdings: [{}] }, 'WalletBindingMismatch'],
  ];
  for (const [season, me, want] of cases) assert.deepEqual(await check(season, me), { ok: false, code: want }, want);
  // the wallet asked about is this wallet, and nothing is asked of a herald that is not the local program's
  let asked = null; await check(goodSeason(), a => { asked = a; return goodMe(address); }); assert.equal(asked, address);
  let reached = false; await check(goodSeason({ record: { programId: other } }), () => { reached = true; return goodMe(address); }); assert.equal(reached, false);
  for (const code of ['HeraldUnreachable', 'HeraldNotReady', 'LocalPlayProgram', 'LocalPlayCluster', 'LocalPlayVersion', 'LocalPlaySeason', 'WalletNotBound', 'WalletBindingMismatch', 'BadHerald', 'NoEd25519', 'EphemeralWalletHost']) assert.notEqual(LP.localPlayWhy(code), code, `${code} has a sentence`);
});

test('before the boot: the wallet is made, the public address shown, and Connect goes on only for a verified herald, with the same wallet', async () => {
  const doc = stubDocument(), win = stubWindow(), h = heralds(), touched = [], saved = {};
  for (const name of ['localStorage', 'sessionStorage']) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { configurable: true, value: new Proxy({}, { get: (_, k) => { touched.push(`${name}.${String(k)}`); return () => null; } }) }); }
  let resolved = 0, result = null;
  try {
    const gate = LP.openLocalPlayGate({ cfg: CFG, loc: loc(), doc, win, makeHerald: h.make });
    gate.ready.then(v => { resolved++; result = v; });
    assert.equal(gate.state().phase, 'creating'); assert.ok(doc.byId('local-play-gate'), 'the panel stands before the wallet is made'); assert.match(doc.byId('local-play-status').textContent, /作っています/);
    assert.equal(doc.byId('local-play-connect').disabled, true); assert.match(doc.byId('local-play-css').href, /\/frontier\/flocalplay\.css$/); assert.equal(doc.byId('local-play-css').rel, 'stylesheet');
    await made(gate);
    const s0 = gate.state(), address = s0.address;
    assert.equal(s0.phase, 'waiting'); assert.equal(fromB58(address).length, 32);
    assert.equal(doc.byId('local-play-address').textContent, address, 'the PUBLIC address is what the panel shows');
    assert.equal(doc.byId('local-play-herald').value, CFG.herald); assert.match(doc.byId('local-play-status').textContent, /準備中/);
    assert.equal(h.calls, 0, 'nothing is read before Connect'); assert.equal(resolved, 0);
    // the panel holds no secret: every text and value in it is the address, the herald or a sentence
    for (const el of doc.all) for (const v of [el.textContent, el.value, ...Object.values(el.attrs), ...Object.values(el.dataset)]) assert.ok(!/^[0-9a-f]{64}$/i.test(String(v)), 'no key-like value in the panel');
    // the runner is not up yet
    h.season = new Error('connection refused'); doc.byId('local-play-connect').click(); await settle();
    assert.equal(gate.state().phase, 'refused'); assert.equal(gate.state().code, 'HeraldUnreachable'); assert.match(doc.byId('local-play-status').textContent, /HeraldUnreachable/);
    assert.equal(resolved, 0); assert.equal(doc.byId('local-play-connect').disabled, false, 'it may be tried again');
    // a herald that is up but is another world's, then one that does not know this wallet
    h.season = goodSeason({ record: { programId: 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3' } }); await gate.connect(); assert.equal(gate.state().code, 'LocalPlayProgram');
    h.season = goodSeason(); h.me = { ok: false, code: 'NotFound' }; await gate.connect(); assert.equal(gate.state().code, 'WalletNotBound');
    // the operator names another herald in the panel; a place that is not this machine is refused without a read
    doc.byId('local-play-herald').value = 'http://example.com:41990'; const before = h.calls; await gate.connect();
    assert.equal(gate.state().code, 'BadHerald'); assert.equal(h.calls, before, 'no read of a herald elsewhere');
    doc.byId('local-play-herald').value = 'http://127.0.0.1:41990/';
    // a slow herald: one check at a time, presses meanwhile do nothing
    let release; h.hold = new Promise(r => { release = r; }); h.me = goodMe;
    const reads = h.calls; doc.byId('local-play-connect').click(); await settle();
    assert.equal(gate.state().phase, 'checking'); assert.equal(doc.byId('local-play-connect').disabled, true);
    doc.byId('local-play-connect').click(); doc.byId('local-play-connect').click(); await gate.connect(); await settle();
    assert.equal(h.calls, reads + 1, 'three more presses made no second check'); assert.equal(resolved, 0);
    release(); await settle(); await settle();
    assert.equal(gate.state().phase, 'connected'); assert.equal(resolved, 1);
    assert.equal(gate.state().address, address, 'the same wallet through every retry'); assert.equal(gate.wallet().address, address); assert.equal(gate.wallet().destroyed, false);
    assert.deepEqual(result.cfg, { ...CFG, herald: 'http://127.0.0.1:41990', relay: 'http://127.0.0.1:41990/gw', devWallet: false,
      localPlay: { address, programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', seasonId: SEASON_ID, seasonAddress: ADDRS.season } });
    assert.deepEqual(h.pinned, { id: SEASON_ID, season: ADDRS.season });
    assert.equal(h.made.at(-1), 'http://127.0.0.1:41990'); assert.equal(doc.byId('local-play-gate').hidden, true);
    // once connected, further presses do nothing: one boot, no second set of reads
    const after = h.calls; doc.byId('local-play-connect').click(); await gate.connect(); await settle();
    assert.equal(h.calls, after); assert.equal(resolved, 1);
    // the wallet is offered to the page's wallet layer when that starts (app-ready), under its own name
    const offered = []; win.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: { register: w => { offered.push(w.name); return () => {}; } } }));
    assert.deepEqual(offered, [LP.EPHEMERAL_WALLET_NAME]);
    // the page going away destroys the wallet
    win.dispatchEvent(new Event('pagehide')); assert.equal(gate.wallet().destroyed, true); assert.equal(EW.currentEphemeralWallet(), null);
  } finally { for (const [name, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, name, d); else delete globalThis[name]; } }
  assert.deepEqual(touched, [], 'the gate touched no storage');
});

test('a wallet destroyed while a herald is being checked connects nothing; a page that cannot make the wallet says so', async () => {
  { const doc = stubDocument(), win = stubWindow(), h = heralds(); let resolved = 0;
    const gate = LP.openLocalPlayGate({ cfg: CFG, loc: loc(), doc, win, makeHerald: h.make }); gate.ready.then(() => { resolved++; });
    await made(gate);
    let release; h.hold = new Promise(r => { release = r; }); h.season = goodSeason(); h.me = goodMe;
    const pending = gate.connect(); await settle(); gate.wallet().destroy(); release(); await pending; await settle();
    assert.equal(gate.state().phase, 'destroyed'); assert.equal(resolved, 0, 'the game does not boot for a destroyed wallet');
    assert.equal(doc.byId('local-play-connect').disabled, true);
    await gate.connect(); assert.equal(h.calls, 1, 'and nothing more is read'); }
  // not a loopback page (the gate itself refuses, whatever called it), and an engine without Ed25519
  { const gate = LP.openLocalPlayGate({ cfg: CFG, loc: loc('https://wylls.example/frontier/index.html?localPlay=1'), doc: stubDocument(), win: stubWindow(), makeHerald: () => assert.fail() });
    assert.equal(await gate.ready.then(() => null, e => e.code), 'EphemeralWalletHost'); assert.equal(gate.state().phase, 'unavailable'); }
  { const doc = stubDocument(), gate = LP.openLocalPlayGate({ cfg: CFG, loc: loc(), doc, win: stubWindow(), makeHerald: () => assert.fail(), subtle: { generateKey: async () => { throw new Error('NotSupported'); } } });
    assert.equal(await gate.ready.then(() => null, e => e.code), 'NoEd25519');
    // the failure is on the panel, in words, with what to do; Connect cannot be pressed
    assert.ok(doc.byId('local-play-gate') && !doc.byId('local-play-gate').hidden); assert.equal(doc.byId('local-play-gate').dataset.phase, 'unavailable');
    assert.match(doc.byId('local-play-status').textContent, /NoEd25519/); assert.match(doc.byId('local-play-status').textContent, /ブラウザ/); assert.equal(doc.byId('local-play-connect').disabled, true); assert.equal(doc.byId('local-play-address').textContent, ''); }
});

test('the hooks: the page boots once, after the gate, only for local play; the controller restores no session, reconnects no stored wallet and sends nothing', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), ctrl = read('controller.mjs'), lp = read('flocalplay.mjs');
  // app.mjs: the gate is awaited at the very start of boot, behind the request check, and boot is otherwise as it was
  assert.match(app, /export async function boot\(\) \{\n  let cfg = config\(\);\n(  \/\/[^\n]*\n)+  if \(localPlayRequested\(cfg\)\) cfg = \(await openLocalPlayGate\(\{ cfg, makeHerald: base => createHerald\(\{ base \}\) \}\)\.ready\)\.cfg;\n  FS\.mode = cfg\.mode;/);
  assert.equal(app.split('openLocalPlayGate(').length - 1, 1, 'one gate, one boot'); assert.equal(app.split('localPlayRequested(').length - 1, 1);
  // controller.mjs
  assert.match(ctrl, /export async function startPlay\(\{ herald: h, cfg \}\) \{\n(  \/\/[^\n]*\n)+  localPlay = cfg\.localPlay \?\? null;\n  FS\.localPlay = localPlay;\n  useHerald\(h\);/, 'settled first, before discovery or any read of this start');
  // every effect entry that does not pass through `act` refuses on its own
  assert.match(ctrl, /async function sendTheMarch\(\) \{\n  const c = FS\.compose;\n  if \(!c \|\| c\.sending \|\| FS\.inFlight > 0\) return;\n(  \/\/[^\n]*\n)+  if \(localPlay && FS\.localMarch\?\.open !== true\) return failed\(localPlayReadOnly\(\)\);/);   // (2026-11-13, march lane: refused unless the march's own answer is open)
  assert.match(ctrl, /if \(step\.action === 'send' && !localPlay\) \{\n      const r = await io\.reveal\(/);
  assert.match(ctrl, /if \(!localPlay && shouldAutoNudge\(/);
  assert.match(ctrl, /async function catchUp\(target = null\) \{\n  if \(localPlay\) return false;/);
  assert.match(ctrl, /async function paidJoin\(s, \{ onSent, onLost \} = \{\}\) \{\n  if \(localPlay\) return failed\(localPlayReadOnly\(\)\);/);
  assert.match(ctrl, /if \(localPlay\) \{ orderAnswered\(order, false, \{ code: 'LocalPlayReadOnly', sent: false \}\); return failed\(localPlayReadOnly\(\)\); \}/);
  // every call of a sending or relay-asking API in the controller stands behind one of those refusals
  for (const [api, n] of [['io.reveal(', 1], ['sendMarchRetrying(', 1], ['tx.submit(', 1], ['protoIo.land(', 2], ['prizeIo.payAndJoin(', 1]]) assert.equal(ctrl.split(api).length - 1, n, `${api}: a new call site needs its own local-play refusal`);
  assert.equal(ctrl.split('io.nudge(').length - 1, 4, 'io.nudge: catchUp, the auto nudge, the march\'s retry and the nudge action');
  // the boot's own read is checked against what the gate verified, before the wallet is connected and after the player is read
  assert.match(ctrl, /if \(localPlay && !localPlayIdentityOk\(localPlay, pin, FS\.season\)\) \{/);
  assert.match(ctrl, /if \(localPlay && FS\.wallet && !localPlayIdentityOk\(localPlay, io\.pinned\(\), FS\.season, FS\.citizen\)\) \{\n    await wallet\.disconnect\(\)/);
  assert.match(ctrl, /const last = localPlay \? null : wallet\.lastWalletName\(\);/, 'no remembered wallet is reconnected (and so no session restored for it)');
  assert.match(ctrl, /const restored = sc && !localPlay \? await fsession\.restore\(sc, address\) : null;/);
  assert.equal(ctrl.split('fsession.restore(').length - 1, 2, 'the two session restores: both are out of local play\'s path');
  // (2026-11-12, the economy path: the order path asks ONE decision before anything is built — and every order but the
  //  six economy commands in their plain form stops there. The decision itself, for every command the page can send
  //  and outside local play, is tested as behaviour in web-frontier-local-play-act.test.mjs.)
  assert.equal(ctrl.split("const route = localAct.localOrderRoute({ localPlay, name, v, signer, requester });\n  if (route === 'refuse') return early(localPlayReadOnly());").length - 1, 1, 'every order but the six stops before anything is built');
  assert.ok(ctrl.indexOf("if (route === 'refuse') return early(localPlayReadOnly());") < ctrl.indexOf('const key = sendKey(name, fields);'), 'and it is the first thing the order path does');
  const refused = /export const LOCAL_PLAY_REFUSED = Object\.freeze\(\[([^\]]*)\]\);/.exec(ctrl)[1].split(',').map(x => x.trim().replace(/'/g, ''));
  // (2026-11-12, the economy path: `join` and `home-confirm` left this list. They still make no key and pay nothing in
  //  local play — pinned just below — and what they send is only the page-signed Join / PlaceHome of flocalplay-act.mjs.)
  for (const name of ['session', 'nft-login', 'nft-logout', 'prize-faucet', 'nudge', 'forget']) assert.ok(refused.includes(name), `${name} does not run in local play`);
  assert.deepEqual(refused.sort(), ['forget', 'nft-login', 'nft-logout', 'nudge', 'prize-faucet', 'session'], 'and nothing else was taken off or put on');
  { const from = ctrl.indexOf('  join: async () => {'), local = ctrl.slice(from, ctrl.indexOf('    const pin = io.pinned();', from));
    assert.match(local, /if \(localPlay\) \{\n\s+if \(FS\.prize \|\| FS\.season\?\.joinGate\?\.some\?\.\(x => x !== 0\)\) return failed\(localPlayReadOnly\(\)\);/, 'join in local play: a pool or a gate is refused');
    assert.doesNotMatch(local, /fsession|FS\.session =|remember\(|publicKeyBytes|faucet|payAndJoin/, 'join in local play derives, stores and pays nothing'); }
  assert.match(ctrl, /if \(!localPlay && !FS\.resident && \(!FS\.session \|\| FS\.sessionProblem\)\) \{\n\s+await ACTIONS\.session\(\);/, 'home-confirm in local play never asks for an in-game key');
  assert.match(ctrl, /const homeStorage = \(\) => \(localPlay \? localHomeMemory : uiStorage\);/, 'and its record is kept in the page\'s memory, not on the device');
  assert.match(ctrl, /const readHome = \(\) => homeKeyNow\(\) \? loadHome\(homeStorage\(\), homeKeyNow\(\)\)/); assert.match(ctrl, /const saveHomePatch = patch => homeKeyNow\(\) \? saveHome\(homeStorage\(\), homeKeyNow\(\), patch\) : null;/);
  assert.equal(ctrl.split('saveHome(uiStorage').length - 1 + ctrl.split('loadHome(uiStorage').length - 1, 0, 'no direct use of the device\'s storage for the home record is left');
  assert.match(ctrl, /if \(run\) ACTIONS\[name\] = \(\.\.\.a\) => \(localPlay \? failed\(localPlayReadOnly\(\)\) : run\(\.\.\.a\)\);/, 'and runs as before on an ordinary page');
  assert.match(ctrl, /if \(cfg\.dev && cfg\.devWallet !== false && pin\?\.cluster === 'localnet'\) await wallet\.enableDevWallet/, 'the dev wallet stays behind cfg.devWallet, which the gate sets false');
  assert.match(ctrl, /const mine = \(FS\.walletList \?\? \[\]\)\.find\(w => w\.name === EPHEMERAL_WALLET_NAME && !w\.why\);\n    const c = mine \? await wallet\.connect\(mine, \{ chain: wallet\.chainOf\('localnet'\) \}\)\.catch\(\(\) => null\) : null;\n    if \(c && c\.address === localPlay\.address\) adoptConnectedWallet\(c\);/, 'connected through the ordinary Wallet Standard path, and only if it is the gate\'s wallet');
  // flocalplay.mjs itself: no storage, console, key or send API
  const code = lp.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /localStorage|sessionStorage|console\.|innerHTML|insertAdjacentHTML|\.style\b|signTransaction|signMessage|keyFromSeed|fsession|sendTransaction|fetch\(/);
  // (the launcher world's standing notice and the read that confirms its end: web-frontier-local-play-session / -world-instance tests)
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort(), ['../lang.mjs', '../sdk/base58.mjs', './faddr.mjs', './fephemeral-wallet.mjs', './flocallanes.mjs', './flocalplay-instance.mjs', './flocalplay-session.mjs']);   // flocallanes: the served versions read from the deployment (0x4804; the local test candidate 0xC804)
  // the panel's own stylesheet: every rule scoped to the panel, nothing of the game's styles named
  const css = read('flocalplay.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of css.split('}').map(r => r.split('{')[0].trim()).filter(r => r && !r.startsWith('@'))) for (const sel of rule.split(',')) assert.match(sel.trim(), /^#local-play-(gate|session)\b/, `scoped to the panel or the standing notice: ${sel.trim()}`);
  assert.match(css, /#local-play-gate \{ position: fixed; inset: 0; z-index: \d+;/); assert.match(css, /overflow: auto/); assert.match(css, /@media \(max-width: 759px\)/); assert.match(css, /:focus-visible/);
});

test('the boot\'s own read must be the identity the gate verified, and the player it read this wallet\'s', () => {
  const identity = { address: '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', seasonId: SEASON_ID, seasonAddress: ADDRS.season };
  const pin = { programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', seasonId: SEASON_ID, addresses: ADDRS }, season = { programVersion: 0x4804 };
  assert.equal(LP.localPlayIdentityOk(identity, pin, season), true);
  assert.equal(LP.localPlayIdentityOk(identity, pin, season, { wallet: fromB58(identity.address) }), true);
  assert.equal(LP.localPlayIdentityOk(identity, pin, season, null), true, 'no player read yet');
  for (const [name, args] of Object.entries({ 'another program': [identity, { ...pin, programId: 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3' }, season], 'another cluster': [identity, { ...pin, cluster: 'devnet' }, season],
    'another Season id': [identity, { ...pin, seasonId: '12' }, season], 'another Season account': [identity, { ...pin, addresses: seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '12') }, season],
    'another revision': [identity, pin, { programVersion: 0x4004 }], 'no pin': [identity, null, season], 'no identity': [null, pin, season],
    'another wallet\'s Citizen': [identity, pin, season, { wallet: fromB58('B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3') }], 'a Citizen with no wallet': [identity, pin, season, { wallet: 'x' }] }))
    assert.equal(LP.localPlayIdentityOk(...args), false, name);
});

// ---- the REAL herald client (createHerald) over a fetch that serves fixed public records: its own decoding and checks
function served({ program = LP.LOCAL_PLAY_PROGRAM, seasonId = SEASON_ID, version = 0x4804, cluster = 'localnet', wallet, citizenWallet = wallet, citizenSeason = seasonId, seasonAddress = null, owner = null }) {
  const A = seasonAddresses(program, seasonId), b64 = bytes => Buffer.from(bytes).toString('base64');
  const citizenAt = A.of('Citizen', { wallet });
  // (the dispatch revision is a version-2 world: its accounts carry layout version 2)
  const season = encodeAccount('Season', { LAYOUT_VERSION: 2, SEASON_ID: BigInt(seasonId), PROGRAM_VERSION: version }, { profile: 2 });
  const citizen = encodeAccount('Citizen', { LAYOUT_VERSION: 2, SEASON_ID: BigInt(citizenSeason), WALLET: fromB58(citizenWallet), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 1, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }, { profile: 2 });
  const holding = encodeAccount('Holding', { LAYOUT_VERSION: 2, SEASON_ID: BigInt(seasonId), P: 1, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(owner ?? citizenAt) }, { profile: 2 });
  const routes = { '/h/season': { v: 1, season: seasonId, programId: program, cluster, seasonAddress: seasonAddress ?? A.season, bytes_b64: b64(season) },
    [`/h/me/${wallet}`]: { v: 1, citizen: { bytes_b64: b64(citizen), address: citizenAt }, holdings: [{ bytes_b64: b64(holding), address: A.of('Holding', { p: 1, q: 0, site: 3 }) }], slots: [] } };
  const asked = [];
  const fetch = async url => { const path = new URL(url).pathname; asked.push(path); const body = routes[path]; return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) }; };
  return { herald: createHerald({ base: 'http://127.0.0.1:41990', fetch }), asked, A };
}

test('with the real herald client: the canonical Season and this wallet\'s own Citizen pass; another Season, address or owner does not', async () => {
  const wallet = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', other = 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3';
  { const probe = await served({ wallet }).herald.season(); assert.equal(probe.ok, true, `the real client reads the fixture Season: ${JSON.stringify({ code: probe.code, error: probe.error })}`); assert.equal(probe.season.programVersion, 0x4804); }
  const good = served({ wallet }), ok = await LP.verifyLocalPlayHerald(good.herald, wallet);
  assert.equal(ok.ok, true, `refused: ${ok.code}`); assert.deepEqual(ok.identity, { address: wallet, programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', seasonId: SEASON_ID, seasonAddress: good.A.season });
  assert.deepEqual(good.asked, ['/h/season', `/h/me/${wallet}`]);
  const refused = async (options, want) => { const x = served({ wallet, ...options }); assert.deepEqual(await LP.verifyLocalPlayHerald(x.herald, wallet), { ok: false, code: want }, `${JSON.stringify(options)} → ${want}`); return x; };
  await refused({ program: other }, 'LocalPlayProgram');
  await refused({ cluster: 'devnet' }, 'LocalPlayCluster');
  await refused({ version: 0x4004 }, 'LocalPlayVersion'); await refused({ version: 4 }, 'LocalPlayVersion');
  // the record names a Season account that is not the dedicated program's canonical one: the player is never asked for
  const forged = await refused({ seasonAddress: seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '12').season }, 'LocalPlaySeason'); assert.deepEqual(forged.asked, ['/h/season']);
  // the Citizen served for this wallet is another wallet's, is of another Season, or its village is another owner's:
  // refused by the pinned client's own checks
  await refused({ citizenWallet: other }, 'WalletBindingMismatch');
  await refused({ citizenSeason: '12' }, 'WalletBindingMismatch');
  await refused({ owner: other }, 'WalletBindingMismatch');
  // a herald that has no record of this wallet at all
  const none = served({ wallet: other }); assert.deepEqual(await LP.verifyLocalPlayHerald(none.herald, wallet), { ok: false, code: 'WalletNotBound' });
  // nothing answering
  const down = createHerald({ base: 'http://127.0.0.1:41990', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(await LP.verifyLocalPlayHerald(down, wallet), { ok: false, code: 'HeraldUnreachable' });
});

const launcherLoc = () => loc('http://127.0.0.1:41920/frontier/index.html?localPlay=1&launcher=1');
const launchReply = herald => ({ ok: true, json: async () => ({ herald }) });

test('launcher opt-in is explicit and its returned herald must be an exact loopback origin', () => {
  assert.equal(LP.localLauncherRequested(CFG, launcherLoc()), true);
  for (const href of ['http://127.0.0.1:41920/?launcher=1', 'http://127.0.0.1:41920/?localPlay=1', 'http://127.0.0.1:41920/?localPlay=1&launcher=true', 'https://example.com/?localPlay=1&launcher=1', 'http://user:pass@localhost/?localPlay=1&launcher=1']) assert.equal(LP.localLauncherRequested(CFG, loc(href)), false);
  for (const value of ['http://127.0.0.1:41926/path', 'http://127.0.0.1:41926/', 'http://127.0.0.1:41926?x=1', 'http://user:pw@localhost:1', 'http://example.com', '//localhost:1', null, {}]) assert.equal(LP.launcherHeraldOrigin(value), null);
  assert.equal(LP.launcherHeraldOrigin('http://127.0.0.1:41926'), 'http://127.0.0.1:41926');
});

test('launcher sends only public wallet on explicit press, suppresses duplicate starts, verifies before boot', async () => {
  const doc = stubDocument(), h = heralds(), calls = []; let release;
  const hold = new Promise(r => { release = r; }); h.season = goodSeason(); h.me = goodMe;
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc, win: stubWindow(), makeHerald: h.make,
    request: async (...args) => { calls.push(args); await hold; return launchReply('http://127.0.0.1:41926'); } });
  await made(gate); assert.equal(calls.length, 0); assert.equal(h.calls, 0);
  assert.equal(doc.byId('local-play-connect').textContent, '新しい世界を開始'); assert.equal(doc.byId('local-play-herald').hidden, true);
  assert.ok(doc.all.some(e => /再読み込み/.test(e.textContent) && /続けられません/.test(e.textContent)));
  const starting = gate.connect(); await settle(); await gate.connect(); doc.byId('local-play-connect').click();
  assert.equal(calls.length, 1); assert.equal(gate.state().phase, 'starting'); assert.equal(doc.byId('local-play-connect').disabled, true);
  assert.equal(calls[0][0], 'http://127.0.0.1:41920/local-play/start');
  const options = calls[0][1]; assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
  assert.deepEqual(JSON.parse(options.body), { wallet: gate.wallet().address });
  release(); await starting; const result = await gate.ready;
  assert.equal(result.cfg.herald, 'http://127.0.0.1:41926'); assert.equal(result.cfg.relay, 'http://127.0.0.1:41926/gw'); assert.equal(result.wallet, gate.wallet());
  assert.equal(gate.state().phase, 'connected'); await gate.connect(); assert.equal(calls.length, 1);
});

test('launcher refuses a bad destination and failed start; retry uses same wallet', async () => {
  const h = heralds(); h.season = goodSeason(); h.me = goodMe;
  let answer = launchReply('http://example.com'), calls = 0;
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc: stubDocument(), win: stubWindow(), makeHerald: h.make, request: async () => { calls++; return answer; } });
  await made(gate); const address = gate.wallet().address;
  await gate.connect(); assert.equal(gate.state().code, 'BadHerald'); assert.equal(h.calls, 0);
  answer = { ok: false }; await gate.connect(); assert.equal(gate.state().code, 'LauncherFailed'); assert.equal(h.calls, 0);
  answer = launchReply('http://127.0.0.1:41926'); await gate.connect(); await gate.ready;
  assert.equal(calls, 3); assert.equal(gate.wallet().address, address);
});

test('launcher retries only transient herald readiness and does not accept a different program', async () => {
  const h = heralds(); h.season = goodSeason({ season: { programVersion: 4 } }); h.me = goodMe;
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc: stubDocument(), win: stubWindow(), makeHerald: h.make, request: async () => launchReply('http://127.0.0.1:41926'), retryDelayMs: 1 });
  await made(gate); await gate.connect(); assert.equal(gate.state().code, 'LocalPlayVersion'); assert.equal(h.calls, 1);
  h.season = { ok: false, code: 'NotFound' };
  const start = gate.connect(); await settle(); h.season = goodSeason(); await start;
  assert.equal(gate.state().phase, 'connected'); assert.ok(h.calls >= 3);
});

test('launcher timeout cancels pending work and a late response cannot boot or clobber a retry', async () => {
  const h = heralds(); h.season = goodSeason(); h.me = goodMe; let release, attempt = 0, firstSignal;
  const hold = new Promise(r => { release = r; });
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc: stubDocument(), win: stubWindow(), makeHerald: h.make, launcherTimeoutMs: 5,
    request: async (url, options) => { if (++attempt === 1) { firstSignal = options.signal; await hold; } return launchReply('http://127.0.0.1:41926'); } });
  await made(gate); await gate.connect(); assert.equal(gate.state().code, 'LauncherTimeout'); assert.equal(firstSignal.aborted, true);
  await gate.connect(); await gate.ready; assert.equal(gate.state().phase, 'connected'); release(); await settle();
  assert.equal(gate.state().phase, 'connected'); assert.equal(h.calls, 1);
});

test('launcher cannot boot after pagehide destroys wallet while start is pending', async () => {
  const win = stubWindow(), h = heralds(); h.season = goodSeason(); h.me = goodMe; let release;
  const hold = new Promise(r => { release = r; });
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: launcherLoc(), doc: stubDocument(), win, makeHerald: h.make,
    request: async () => { await hold; return launchReply('http://127.0.0.1:41926'); } });
  let boots = 0; gate.ready.then(() => { boots++; }); await made(gate); const pending = gate.connect();
  win.dispatchEvent(new Event('pagehide')); release(); await pending;
  assert.equal(gate.state().phase, 'destroyed'); assert.equal(gate.wallet().destroyed, true); assert.equal(h.calls, 0); assert.equal(boots, 0);
});
