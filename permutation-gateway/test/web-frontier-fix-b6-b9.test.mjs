// The loop-play report B5–B9 (2026-11-18), the parts that are drawn or asked through the page's larger modules:
//   B5  the gate's question to the launcher (`checkWorld`): only a connected launcher world asks, the launcher's
//       WorldNotFound is the end and is kept, everything else is unknown; the notice's key says the end too.
//   B7  the nation tab's reach list gives the viewer's OWN contested keep its own list and 「守りに向かう」 / "Defend";
//       it no longer stands under "keeps of other nations".
//   B8  while the title stands, the plate behind it has no 「国を選ぶ」 key: the one in the document is the one on screen.
//   B9  the reach answer follows the keeps the page holds (a ring's list that arrives within a turn), and an empty list
//       says it is still being worked out while keeps of the control snapshot cannot be placed yet.
// (B6 — the host bar's line names the refused orders — is in web-frontier-local-play-dissolve.test.mjs.)
//
// THIS FILE MAKES NO KEY: the gate's wallet is a stand-in with a public address; a stub document, herald and request.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { WorldManager, createLauncherServer } from '../src/frontier/local-play-launcher.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import { WORLD_INSTANCE_PATH } from '../../permutation-server/web/frontier/flocalplay-instance.mjs';
import { WORLD_EXPIRY_SCHEMA } from '../../permutation-server/web/frontier/flocalplay-expiry.mjs';
import { decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldStateOf, createWorldWatch } from '../../permutation-server/web/frontier/flocalplay-ended.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import { renderReach, reachLoading } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { cachedReach, reachKey } from '../../permutation-server/web/frontier/fkeepreach.mjs';
import { keepsPending } from '../../permutation-server/web/frontier/controller.mjs';
import { ringOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { worldOf as worldShape, ringSeeded } from '../../permutation-server/web/frontier/map/world.mjs';
import { renderWideInventoryStatus } from '../../permutation-server/web/frontier/screens/wideholding.mjs';
import { readOverviews, overviewRefused } from '../../permutation-server/web/frontier/map/overviews.mjs';

afterEach(() => setLang('ja'));
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ');
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);

// ------------------------------------------------------------------ B5: the gate's question
const SEASON_ID = '11', ADDRS = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, SEASON_ID);
const CFG = { origin: 'http://127.0.0.1:41920', herald: 'http://127.0.0.1:41920', relay: 'http://127.0.0.1:41920/gw', dev: true, mode: 'play' };
const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, origin: u.origin }; };
const ME = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const HERALD = 'http://localhost:41926', INSTANCE = 'ab'.repeat(32), T0 = 1_800_000_000_000, TTL = 7_200_000;
const EXP = { schema: WORLD_EXPIRY_SCHEMA, startedAt: T0 - 60_000, ttlMs: TTL, expiresAt: T0 - 60_000 + TTL, instance: INSTANCE };
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
  return Object.assign(doc, { body, head, createElement: make, byClass: c => all.filter(e => e.className.split(' ').includes(c)), all });
}
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
/** The gate in launcher mode; `keeper` is the launcher's answer to its keeper route (a stub that may be swapped). */
function open({ launcher = true, keeper = () => reply(200, { keeper: null }) } = {}) {
  const doc = stubDocument(), win = new EventTarget(), calls = [], answer = { keeper };
  const makeHerald = () => ({ season: async () => ({ ok: true, record: { programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', season: SEASON_ID, seasonAddress: ADDRS.season }, season: { programVersion: 0x4804, seasonId: 11n } }),
    me: async address => ({ ok: true, citizen: { wallet: fromB58(address) }, holdings: [{}] }), pin() {} });
  const wallet = { address: ME, destroyed: false, destroy() { wallet.destroyed = true; }, announce() {} };
  const request = async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/local-play/keeper')) return answer.keeper(url, options);
    if (url.endsWith(WORLD_INSTANCE_PATH)) return reply(200, { wallet: ME, instance: INSTANCE });
    return reply(200, { herald: HERALD, expiry: EXP });
  };
  const href = `http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1${launcher ? '&launcher=1' : ''}&devWallet=off`;
  const gate = LP.openLocalPlayGate({ cfg: launcher ? CFG : { ...CFG, herald: HERALD }, loc: loc(href), doc, win, makeHerald, request, makeWallet: async () => wallet, now: () => T0 });
  return { gate, doc, calls, answer, wallet };
}
async function connected(o) {
  for (let i = 0; i < 500 && o.gate.state().phase === 'creating'; i++) await settle(1);
  await o.gate.connect(); await o.gate.ready; await settle();
  assert.equal(o.gate.state().phase, 'connected');
  return o;
}
/** The page's question as app.mjs asks it: the gate's answer through `worldStateOf`. */
const worldOf = async o => worldStateOf(await o.gate.checkWorld());
const keeperAsks = o => o.calls.filter(([url]) => url.endsWith('/local-play/keeper'));

test('B5 the gate\'s question: nothing is asked by itself; a world that runs is "running"; one bounded same-origin POST with the public address', async () => {
  const o = await connected(open());
  assert.equal(keeperAsks(o).length, 0, 'the launcher is not asked about the world until the page asks');
  assert.equal(await worldOf(o), 'running');
  const [[url, options]] = keeperAsks(o);
  assert.equal(url, 'http://127.0.0.1:41920/local-play/keeper', 'the launcher\'s own origin');
  assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), { wallet: ME }, 'the public address and nothing else');
});

test('B5 the gate\'s question: the launcher\'s 404 WorldNotFound is the end, and is kept; any other refusal or failure is unknown', async () => {
  const o = await connected(open({ keeper: () => reply(503, { error: 'LauncherClosed' }) }));
  assert.equal(await worldOf(o), 'unknown');
  o.answer.keeper = () => { throw new Error('connection refused'); };
  assert.equal(await worldOf(o), 'unknown', 'a launcher that cannot be reached proves nothing');
  o.answer.keeper = () => reply(404, { error: 'NotFound' });
  assert.equal(await worldOf(o), 'unknown', 'a 404 that is not the launcher\'s own code');
  o.answer.keeper = () => reply(404, { error: 'WorldNotFound' });
  assert.equal(await worldOf(o), 'ended');
  // (that an ended world is not asked about again, and that the end is not taken back, is the watch's:
  //  web-frontier-world-ended.test.mjs)
});

test('B5 the page reaches the question by the cfg the gate resolved, and only a launcher world has one', async () => {
  const o = await connected(open());
  const cfg = (await o.gate.ready).cfg;
  const check = LP.localPlayWorldCheck(cfg);
  assert.equal(typeof check, 'function');
  assert.equal(worldStateOf(await check()), 'running');
  assert.equal(keeperAsks(o).length, 1);
  assert.deepEqual(Object.keys(cfg).filter(k => typeof cfg[k] === 'function'), [], 'nothing is put on the cfg itself');
  for (const other of [null, undefined, {}, { ...cfg }, 'cfg', 7]) assert.equal(LP.localPlayWorldCheck(other), null, 'any other cfg (a copy too): no question');
});

test('B5 the gate\'s question: a page that is not a connected launcher world, or lost its key, asks nothing', async () => {
  const waiting = open();
  assert.equal(await waiting.gate.checkWorld(), null);
  assert.equal(await worldOf(waiting), 'unknown', 'before the world is connected');
  assert.equal(keeperAsks(waiting).length, 0);
  const o = await connected(open());
  o.wallet.destroyed = true;
  assert.equal(await worldOf(o), 'unknown');
  assert.equal(keeperAsks(o).length, 0);
});

test('B5 the notice\'s key: a world the launcher no longer runs is said to have ended (either language)', async () => {
  for (const [lang, want] of [['en', /^This world has ended\./], ['ja', /^この世界は終了しました。/]]) {
    setLang(lang);
    const o = await connected(open({ keeper: () => reply(404, { error: 'WorldNotFound' }) }));
    const key = o.doc.byClass('local-play-session-check')[0], said = o.doc.byClass('local-play-session-keeper')[0];
    key.click(); await settle();
    assert.match(said.textContent, want, lang);
    assert.equal(said.hidden, false);
    o.gate.notice().unmount();
  }
});

test('B5 end to end, the real launcher (its server and manager, a stand-in world): started, the page\'s question says it runs; stopped by the launcher, the watch learns the end once', async t => {
  // (the launcher's own server on an ephemeral port — it checks the Host it was configured with, so the gate's requests
  //  are forwarded with that Host, as frontier-local-play-keeper-view.test.mjs asks it; the world is a stand-in: no
  //  process, no chain, no key)
  let stops = 0;
  const manager = new WorldManager({}, async () => ({ herald: HERALD, expiry: EXP, stop: async () => { stops += 1; }, keeper: async () => null }));
  const { server } = createLauncherServer({ port: 41920, web: '/nonexistent' }, manager);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const forward = (url, options) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port, path: u.pathname, method: options.method, setHost: false, headers: { host: u.host, origin: u.origin, 'content-type': 'application/json' } }, res => {
      const parts = []; res.on('data', c => parts.push(c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(Buffer.concat(parts).toString('utf8')) }));
    });
    req.on('error', reject); req.end(options.body);
  });
  const doc = stubDocument(), wallet = { address: ME, destroyed: false, destroy() { wallet.destroyed = true; }, announce() {} };
  const makeHerald = () => ({ season: async () => ({ ok: true, record: { programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', season: SEASON_ID, seasonAddress: ADDRS.season }, season: { programVersion: 0x4804, seasonId: 11n } }),
    me: async address => ({ ok: true, citizen: { wallet: fromB58(address) }, holdings: [{}] }), pin() {} });
  const request = (url, options) => (url.endsWith(WORLD_INSTANCE_PATH) ? reply(200, { wallet: ME, instance: INSTANCE }) : forward(url, options));
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: loc('http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off'), doc, win: new EventTarget(), makeHerald, request, makeWallet: async () => wallet, now: () => T0 });
  await connected({ gate });
  assert.deepEqual(manager.list().map(w => [w.wallet, w.state]), [[ME, 'running']], 'the launcher runs this page\'s world');
  // the page's side, as app.mjs wires it: the cfg's question through worldStateOf, asked by the watch on a failed read
  const check = LP.localPlayWorldCheck((await gate.ready).cfg);
  let now = 0, ended = 0;
  const watch = createWorldWatch({ ask: () => check().then(worldStateOf), onEnded: () => { ended += 1; }, now: () => now });
  assert.equal(await watch.readFailed(), 'unknown', 'a herald read failed, but the launcher still runs the world: nothing is concluded');
  assert.equal(watch.isEnded(), false);
  // the launcher ends the world (its own stop path: the owner's press, the world's life, its guard)
  await manager.stop(ME);
  assert.equal(stops, 1); assert.deepEqual(manager.list(), []);
  now += 5000;
  assert.equal(await watch.readFailed(), 'ended', 'the launcher\'s own 404 WorldNotFound');
  assert.equal(watch.isEnded(), true); assert.equal(ended, 1);
  now += 60000;
  assert.equal(watch.readFailed(), null, 'and it is not asked again');
  assert.equal(ended, 1);
  gate.notice().unmount();
});

// ------------------------------------------------------------------ B7, B9: the nation tab's reach list
const HOME = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 5, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, conquestParams: { keepBells: 72 } };
const route = (hexes, n, secs) => ({ hexes, provinces: Array.from({ length: n }, (_, i) => ({ p: i, q: 0 })), secs });
const reachRow = (p, q, holder, extra = {}) => ({ p, q, tile: 30, holder, troops: 0, origin: { p: 2, q: 0, tile: 20, unit: 0 }, route: route(12, 2, 1500), ...extra });
const fs = (rows, conquest = {}) => ({ mode: 'play', season: SEASON, citizen: { faction: 5 }, holdings: [HOME], activeHolding: 0, nowBell: 10, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0, provinces: new Map(),
  conquest: { status: 'ready', keeps: new Map(), reach: { key: 'k', ok: true, home: false, rows, unreachable: [] }, ...conquest } });

test('B7: the viewer\'s own contested keep has its own list and says "Defend" — it is not under "keeps of other nations"', () => {
  // (world 2 of the report: the viewer is Fjordal (5); Aster holds the tile of Fjordal's fort at 4,-2)
  const s = fs([reachRow(4, -2, 5, { defend: true }), reachRow(3, 1, 0, { troops: 100 })]);
  setLang('en');
  const out = String(renderReach(s)), text = plain(out);
  assert.match(out, /<h4 class="kr-defend-title" id="conquest-defend-title">Keeps of your nation that another nation is taking<\/h4>/);
  const defend = /<ul class="list kr-rows kr-rows-defend"[^>]*>(.*?)<\/ul>/s.exec(out)[1], others = /<ul class="list kr-rows" aria-labelledby="conquest-reach-title">(.*?)<\/ul>/s.exec(out)[1];
  assert.match(defend, /data-keep-defend="4,-2"/);
  assert.match(plain(defend), /Province 4,-2 · Held by your nation · 0 defenders · .* Defend · staying on the tile stops their hold/);
  assert.match(defend, /data-act="goto" data-p="4" data-q="-2"/, 'the way there is kept');
  assert.doesNotMatch(plain(defend), /Fjordal/, 'not named as if it were another nation\'s');
  assert.doesNotMatch(others, /data-p="4" data-q="-2"|Defend/, 'the other nations\' list is theirs alone');
  assert.ok(out.indexOf('conquest-defend-title') < out.indexOf('id="conquest-reach-title"'), 'the keeps to defend come first, each list under its own heading');
  assert.match(others, /data-p="3" data-q="1"/);
  assert.doesNotMatch(text, /[぀-ヿ一-鿿]/, 'English without Japanese');
  setLang('ja');
  const ja = plain(renderReach(s));
  assert.match(ja, /他国が占拠を進めている、あなたの国の砦/);
  assert.match(ja, /州 4,-2 · あなたの国が保持 · 守備兵 0 · .* 守りに向かう · マスに残れば占拠を止めます/);
});

test('B7: only a defend row — no "no keep of another nation" claim is lost, and no defend list without one', () => {
  setLang('en');
  const only = plain(renderReach(fs([reachRow(4, -2, 5, { defend: true })])));
  assert.match(only, /Defend/);
  assert.match(only, /No keep of another nation is within reach now\./, 'true of the other nations\' keeps, and still said');
  const none = String(renderReach(fs([reachRow(3, 1, 0)])));
  assert.doesNotMatch(none, /kr-rows-defend|conquest-defend-title|Defend/);
  // the doc that describes it (LOCAL-PLAY-START.md §3(3) "Defending") and the list's source agree
  const doc = readFileSync(new URL('../../docs/frontier/LOCAL-PLAY-START.md', import.meta.url), 'utf8');
  assert.match(doc, /\*\*Defending:\*\* the fort's own nation sees its fort as 「守りに向かう」 while another nation is counting on it/);
  assert.match(doc, /in 「国と領土」 under its own heading\n  「他国が占拠を進めている、あなたの国の砦」/);
});

test('B9: an empty reach list says it is still being worked out while keeps of the control snapshot cannot be placed', () => {
  setLang('en');
  const loading = fs([], { keepsPending: 3 });
  assert.equal(reachLoading(loading), true);
  const text = plain(renderReach(loading));
  assert.match(text, /Finding the keeps you can reach…/);
  assert.doesNotMatch(text, /No keep of another nation is within reach/);
  // everything placed: the empty list is the answer
  for (const keepsPending of [0, undefined]) {
    const s = fs([], { keepsPending });
    assert.equal(reachLoading(s), false);
    assert.match(plain(renderReach(s)), /No keep of another nation is within reach now\./);
  }
  // rows found are shown whatever is still pending
  assert.match(String(renderReach(fs([reachRow(3, 1, 0)], { keepsPending: 3 }))), /data-p="3" data-q="1"/);
  // the host's forts card says the same
  assert.match(readFileSync(new URL('hud/keephand.mjs', WEB), 'utf8'), /: Number\(FS\.conquest\?\.keepsPending \?\? 0\) > 0 \? html`<p class="pop-line kh-loading">\$\{L`届く砦を調べています…`\}<\/p>`/);
});

test('B9: keepsPending counts the control provinces whose keep is not held and whose SEEDED ring is not read yet', () => {
  const provinces = [{ p: 2, q: 0 }, { p: -2, q: 4 }, { p: 0, q: 4 }, { p: 1, q: 1 }];
  const far = ringOf(-2, 4);
  assert.equal(ringOf(0, 4), far); assert.notEqual(ringOf(2, 0), far);
  const read = new Set([ringOf(2, 0), ringOf(1, 1)]), all = () => true;
  assert.equal(keepsPending(provinces, new Map(), d => read.has(d), all), 2, 'the far ring\'s two');
  assert.equal(keepsPending(provinces, new Map([['-2,4', {}]]), d => read.has(d), all), 1, 'a keep held from a province record is placed');
  read.add(far);
  assert.equal(keepsPending(provinces, new Map(), d => read.has(d), all), 0, 'every ring read: nothing pending (a province without a keep is not one)');
  assert.equal(keepsPending(null, new Map(), () => false, all), 0);
  // fail-safe: without a word on which rings the world seeds, nothing is pending (never "finding…" for ever)
  assert.equal(keepsPending(provinces, new Map(), () => false), 0);
  const ctl = readFileSync(new URL('controller.mjs', WEB), 'utf8');
  assert.match(ctl, /cq\.keepsPending = keepsPending\(cq\.control\.provinces, cq\.keeps, /, 'the controller\'s call: its exact arguments are pinned in the round-3 test');
});

// (PR #46 verification R1, 2026-11-18: seen live in a natural launcher world at turn 16 — FS.overviews held rings 2, 3, 4,
//  the control snapshot named 0,0 and the six ring-1 provinces too, and keepsPending stood at 7 for good: Borealis, with
//  no other nation's keep in reach, read "Finding the keeps you can reach…" from turn 7 until after the world ended)
test('B9 round 2: a sparse world whose inner rings are unseeded — its rings 0 and 1 are never read and are NOT pending; the empty list says "no keep within reach"', () => {
  // the natural world's shape: rings 2, 3 and 4 seeded, 0 and 1 not (map/world.mjs worldOf of a sparse season record)
  const world = worldShape({ rings: [2, 3, 4].map(d => ({ d, seed: String(d).repeat(64) })) });
  assert.deepEqual(world.seeded, [2, 3, 4]);
  for (const d of [0, 1]) assert.equal(ringSeeded(world, d), false, `ring ${d} has no seed: map/overviews.mjs never reads it`);
  const seeded = d => ringSeeded(world, d);
  // the control snapshot as the live world had it: the centre, the six of ring 1, and provinces of rings 2-4
  const ring1 = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]].map(([p, q]) => ({ p, q }));
  const provinces = [{ p: 0, q: 0 }, ...ring1, { p: 2, q: 0 }, { p: -2, q: 4 }, { p: 3, q: 0 }];
  assert.deepEqual(ring1.map(c => ringOf(c.p, c.q)), [1, 1, 1, 1, 1, 1]);
  // every ring the world seeds is read (as in the live dump: FS.overviews = rings [2, 3, 4])
  const read = new Set([2, 3, 4]);
  assert.equal(keepsPending(provinces, new Map(), d => read.has(d), () => true), 7, 'the fault: counting every unread ring, the seven never go away');
  assert.equal(keepsPending(provinces, new Map(), d => read.has(d), seeded), 0, 'fixed: a ring the world does not seed is not waited for');
  // and the page says the truthful line again, in either language, on the tab and on the host\'s card
  for (const [lang, none] of [['en', /No keep of another nation is within reach now\./], ['ja', /いま届く他国の砦はありません。/]]) {
    setLang(lang);
    const s = fs([], { keepsPending: keepsPending(provinces, new Map(), d => read.has(d), seeded) });
    assert.equal(reachLoading(s), false);
    const text = plain(renderReach(s));
    assert.match(text, none); assert.doesNotMatch(text, /Finding the keeps|調べています/);
  }
  // while a SEEDED ring is still to be read, it is pending — and only its provinces
  read.delete(4);
  assert.equal(keepsPending(provinces, new Map(), d => read.has(d), seeded), 1, 'the one province of ring 4 named (-2,4)');
  read.delete(3);
  assert.equal(keepsPending(provinces, new Map(), d => read.has(d), seeded), 2);
  // a contiguous world (every ring below ringsOpen seeded) is as before: its unread rings are pending
  const whole = worldShape({ rings: [0, 1, 2, 3, 4].map(d => ({ d, seed: String(d).repeat(64) })) });
  assert.equal(keepsPending(provinces, new Map(), () => false, d => ringSeeded(whole, d)), provinces.length);
});

// (PR #46 round 3, 2026-11-18: the verifier's live natural world, round 2 — FS.world had NO `seeded` (the record's rings
//  carry no `d`), so every ring 0..4 counted as seeded; rings 0 and 1 went unread because the HERALD refused them:
//  /h/overview{,2}/{0,1}/latest.bin → 404 NoSuchRing. keepsPending stood at 7: (0,0) and the six ring-1 provinces)
test('B9 round 3: the LIVE record shape (rings without d) and a herald that refuses rings 0–1 with 404 — nothing is pending, the empty list says "no keep within reach"', async () => {
  const record = { rings: [1, 2, 3, 4, 5].map(i => ({ seed: String(i).repeat(64) })), ringProvinces: [1, 6, 12, 18, 24] };
  const world = worldShape(record);
  assert.equal(world.seeded, undefined); assert.equal(ringSeeded(world, 0), true); assert.equal(ringSeeded(world, 1), true);
  // the page's own overview queue, over a herald that answers as the live one did
  const asked = [];
  const answer = ring => (ring <= 1 ? { ok: false, code: 'NotFound', error: 'HTTP 404', httpStatus: 404 } : { ok: true, ring, bell: 0, provinces: [] });
  const herald = { overview: async ring => { asked.push(ring); return answer(ring); }, overview2: async ring => { asked.push(ring); return answer(ring); } };
  const PS = { world, overviews: new Map(), holdings: [] };
  await readOverviews(PS, { herald, v2: true });
  for (let i = 0; i < 3; i++) await readOverviews(PS, { herald, v2: true });   // the page's refreshes
  assert.deepEqual([...PS.overviews.keys()].sort(), [2, 3, 4], 'as in the live dump: FS.overviews = rings 2, 3, 4');
  assert.equal(asked.filter(d => d <= 1).length, 2, 'rings 0 and 1 asked once each, then not again (the live page asked 125 times)');
  // the control snapshot of the live world: the centre (control 6), ring 1 unheld (7), and rings 2–4
  const ring1 = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]].map(([p, q]) => ({ p, q, control: 7, contender: 7, heartland: false }));
  const provinces = [{ p: 0, q: 0, control: 6, contender: 7, heartland: false }, ...ring1,
    { p: 2, q: 0, control: 1, contender: 7, heartland: true }, { p: -2, q: 4, control: 1, contender: 7, heartland: true }, { p: 3, q: 0, control: 0, contender: 7, heartland: false }];
  const origins = [{ p: 0, q: 2, tile: 20, unit: 0 }], read = d => PS.overviews.has(d) || overviewRefused(PS, d), seeded = d => ringSeeded(world, d);
  // the round-2 count (no refusal, no holder) is the live fault: 7
  assert.equal(keepsPending(provinces, new Map(), d => PS.overviews.has(d), seeded, origins), 7, 'the fault, reproduced');
  // either half of round 3 alone ends it — the refusal, or the holder rule (p2 is Borealis, nation 1) —, and both together
  assert.equal(keepsPending(provinces, new Map(), read, seeded, origins), 0, 'herald-refused rings are not waited for');
  assert.equal(keepsPending(provinces, new Map(), d => PS.overviews.has(d), seeded, origins, 1), 0, 'no keep that could be a row is in rings 0–1');
  assert.equal(keepsPending(provinces, new Map(), read, seeded, origins, 1), 0);
  for (const [lang, none] of [['en', /No keep of another nation is within reach now\./], ['ja', /いま届く他国の砦はありません。/]]) {
    setLang(lang);
    const text = plain(renderReach(fs([], { keepsPending: keepsPending(provinces, new Map(), read, seeded, origins, 1) })));
    assert.match(text, none); assert.doesNotMatch(text, /Finding the keeps|調べています/);
  }
  // the controller passes both
  const ctl = readFileSync(new URL('controller.mjs', WEB), 'utf8');
  assert.match(ctl, /cq\.keepsPending = keepsPending\(cq\.control\.provinces, cq\.keeps, d => FS\.overviews\.has\(d\) \|\| overviewRefused\(FS, d\), d => !!w && ringSeeded\(w, d\), reachOrigins\(FS\)\.origins, FS\.citizen\?\.faction \?\? null, FS\.overviews\);/);
});

test('B9 round 3: the holder rule waits only for a keep that could be a row — another nation\'s outside a heartland, or the viewer\'s own contested', () => {
  const all = () => true, none = () => false, at = (p, q, extra) => ({ p, q, control: 7, contender: 7, heartland: false, ...extra });
  const provinces = [at(2, 0, { control: 0 }), at(3, 0, { control: 2, heartland: true }), at(2, 1, { control: 1 }), at(2, -1, { control: 1, contender: 0 }), at(0, 0, { control: 6 }), at(1, 0)];
  assert.deepEqual(provinces.map(c => keepsPending([c], new Map(), none, all, [], 1)), [1, 0, 0, 1, 0, 0],
    'Aster\'s (another nation): yes · Cinder\'s heartland: no · Borealis\'s own, quiet: no · Borealis\'s own, contested: yes · the centre: no · unheld: no');
  assert.equal(keepsPending(provinces, new Map(), none, all, []), 6, 'without the viewer\'s nation: not narrowed');
});

// (round 3, seen live in this round's own natural world: the herald's latest control snapshot lags the turn by about
//  three (control bell 6 at turn 9). Ring 4 opened at the start; its overview held −2,4 with keep tile 18 from turn 2,
//  but the latest snapshot still covered rings 0–3 only until turn 5 — p1's list said "no keep" for turns 2–4)
test('B9 round 3: a keep the overview shows in a province the lagging control snapshot does not cover yet is waited for; covered, it is a row or nothing', () => {
  const all = () => true, read = () => true, origins = [{ p: 1, q: 1, tile: 34, unit: 0 }];
  const overviews = new Map([[4, { provinces: [{ p: -2, q: 4, keepTile: 18 }, { p: 4, q: 0, keepTile: null }] }], [2, { provinces: [{ p: 2, q: 0, keepTile: 30 }] }]]);
  // the snapshot of turn 0–1: rings 0..3 only (no −2,4), every one of them settled
  const lagging = [{ p: 0, q: 0, control: 6, contender: 7 }, { p: 2, q: 0, control: 0, contender: 7, heartland: true }];
  assert.equal(keepsPending(lagging, new Map(), read, all, origins, 0, overviews), 1, '−2,4: in the overview, not in the snapshot yet');
  assert.equal(keepsPending(lagging, new Map(), read, all, origins, 0, null), 0, 'without the overviews: as round 2');
  // a province with no keep tile is never waited for; one beyond reach neither
  assert.equal(keepsPending(lagging, new Map(), read, all, [{ p: 9, q: -9 }], 0, overviews), 0, 'beyond 4 provinces of every origin');
  // the snapshot covers it now (turn 5): it is a row (held by Borealis) — or, held by the viewer's own quiet nation, nothing
  const caught = [...lagging, { p: -2, q: 4, control: 1, contender: 7, heartland: false }];
  assert.equal(keepsPending(caught, new Map([['-2,4', {}]]), read, all, origins, 0, overviews), 0, 'covered and held: placed');
  assert.equal(keepsPending([...lagging, { p: -2, q: 4, control: 0, contender: 7, heartland: false }], new Map(), read, all, origins, 0, overviews), 0, 'covered, the viewer\'s own quiet keep: nothing to wait for');
  // what the page then says while it waits, either language
  for (const [lang, want] of [['en', /Finding the keeps you can reach…/], ['ja', /届く砦を調べています…/]]) {
    setLang(lang);
    assert.match(plain(renderReach(fs([], { keepsPending: keepsPending(lagging, new Map(), read, all, origins, 0, overviews) }))), want);
  }
});

test('B9 round 2: only provinces a march could reach from an origin are waited for (at most 4 provinces away)', () => {
  const all = () => true, none = () => false;
  const provinces = [{ p: 2, q: 0 }, { p: 5, q: 0 }, { p: 6, q: 0 }, { p: -4, q: 0 }];
  const origins = [{ p: 1, q: 0, tile: 20, unit: 0 }];
  assert.equal(keepsPending(provinces, new Map(), none, all, origins), 2, '2,0 (1 away) and 5,0 (4 away); 6,0 and -4,0 are 5 away');
  assert.equal(keepsPending(provinces, new Map(), none, all, [...origins, { p: -3, q: 0 }]), 3, 'the nearest origin decides');
  assert.equal(keepsPending(provinces, new Map(), none, all, []), 4, 'no origin known: not narrowed');
  assert.equal(keepsPending(provinces, new Map(), none, all, [{ p: 'x' }, null]), 4, 'a malformed origin is no origin');
});

test('PR #46 verification: after a confirmed end the far-village card raises no second "could not be read (network) · Retry"', () => {
  setLang('en');
  const base = { mode: 'play', citizen: { faction: 0 }, wideStatus: 'error', wideError: { code: 'network' } };
  assert.match(String(renderWideInventoryStatus(base)), /Far-village information could not be read \(network\)[\s\S]*data-act="me-retry"/, 'a world that runs: as before');
  assert.equal(String(renderWideInventoryStatus({ ...base, worldEnded: { at: 1 } })), '', 'the banner says the world ended; nothing is left to retry');
  // any other failure, and the "unavailable from this source" line, are still said after the end
  assert.match(String(renderWideInventoryStatus({ ...base, worldEnded: { at: 1 }, wideError: { code: 'BadWideRecord' } })), /BadWideRecord/);
  assert.match(String(renderWideInventoryStatus({ ...base, worldEnded: { at: 1 }, wideStatus: 'unavailable', wideError: null })), /unavailable from this source/);
});

test('B9: the reach answer follows the keeps held — a keep that arrives within the same turn is in the list at once', () => {
  const kernel = { calls: 0, call(name) { kernel.calls += 1; return name === 'plan_path' ? { ok: true, value: { dirs: new Array(23).fill(0), pathLen: 23, path: [], secs: 3000, hexes: 23, provinces: [{ p: 0, q: 0 }, { p: 0, q: 1 }] } } : { ok: false }; } };
  const keep = (p, q) => ({ p, q, tile: 30, holder: 1, troops: 100, heartland: false, consolidatedUntil: null, contender: null });
  const keeps = new Map();
  const ask = { kernel, keeps, origins: [{ p: 1, q: 1, tile: 38, unit: 0 }], seeds: [{ ring: 0, seed: '00' }], faction: 0, nowBell: 3, controlBell: 2 };
  // turn 3, the far ring not read yet: no keep is held
  const empty = cachedReach(null, ask);
  assert.equal(empty.ok, true); assert.deepEqual(empty.rows, []);
  assert.equal(cachedReach(empty, ask), empty, 'the same question: the same answer, no new search');
  // the ring's list arrives in the SAME turn and control snapshot: the keep at -2,4 is held now
  keeps.set('-2,4', keep(-2, 4));
  const next = cachedReach(empty, ask);
  assert.notEqual(next, empty, 'the answer of before the keep arrived is not kept');
  assert.deepEqual(next.rows.map(x => [x.p, x.q, x.route.hexes]), [[-2, 4, 23]]);
  assert.notEqual(next.key, empty.key);
  assert.equal(cachedReach(next, ask), next);
  // the key: as before when no keeps are named, and the count of them otherwise (a Map, a list or a plain object)
  const base = { origins: ask.origins, nowBell: 3, controlBell: 2, faction: 0 };
  assert.equal(reachKey(base), '0|3|2|1,1,38,0');
  assert.equal(reachKey({ ...base, keeps }), '0|3|2|1,1,38,0|k1');
  assert.equal(reachKey({ ...base, keeps: [1, 2] }), '0|3|2|1,1,38,0|k2');
  assert.equal(reachKey({ ...base, keeps: { a: 1 } }), '0|3|2|1,1,38,0|k1');
});

// ------------------------------------------------------------------ B8: the title and the plate
test('B8: while the title stands the plate has no 「国を選ぶ」 key; when it lifts the key is there', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const name = lang === 'en' ? 'Choose a nation' : '国を選ぶ';
    const base = { mode: 'play', citizen: null, holdings: [], playReady: true };
    const under = String(hud.renderPlate({ ...base, titleUp: true }));
    assert.doesNotMatch(under, /data-act="join-open"/, `${lang}: no hidden key of the title's name`);
    assert.ok(!under.includes(name), `${lang}: the name is not in the hidden plate`);
    assert.match(under, /class="plate plate-open"/, 'the plate itself stays (its words are hidden with the game)');
    const shown = String(hud.renderPlate({ ...base, titleUp: false }));
    assert.match(shown, new RegExp(`<button type="button" class="btn primary plate-go" data-act="join-open">${name}</button>`), `${lang}: the key is on the plate once the title is gone`);
    assert.match(String(hud.renderPlate(base)), /data-act="join-open"/, 'a page without a title: as before');
  }
});

test('B8: the title\'s own key is a real button, and the game behind it is hidden and inert (source)', () => {
  const title = readFileSync(new URL('intro/title.mjs', WEB), 'utf8'), css = readFileSync(new URL('frontier.css', WEB), 'utf8'), app = readFileSync(new URL('app.mjs', WEB), 'utf8');
  assert.match(title, /<button type="button" class="btn primary intro-go" data-act="intro-close">/);
  assert.match(css, /body\[data-title="up"\] :is\(main, main \*, \.tabs, \.strip-l, \.dial, \.banner, \.mile-banner, \.res-pop\) \{ visibility: hidden !important; \}/);
  assert.match(app, /for \(const el of \[\$\('frontier'\), \$\('tabs'\)\]\) if \(el\) el\.inert = up;/);
  // the plate is drawn again when the title comes and goes
  assert.match(app, /markTitle\(false\);[\s\S]{0,700}invalidate\('panel', 'tabs', 'rail'\);/);
});
