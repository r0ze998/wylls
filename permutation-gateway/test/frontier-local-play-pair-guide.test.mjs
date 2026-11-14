// TEST-ONLY contest pair: the second player learns, on the page, which fort the two players meet over and which nation
// defends it (pair trial 1, 2026-11-14: that was only in the runner's output). The launcher's view of the runner's public
// lines (pairTargetSummary), its one route (/local-play/pair, the pair's two addresses only), the page's own check of the
// answer (pairGuideView: mode, role, numbers; fail closed) and the notice's key and sentence (second player only).
// Nothing is signed or sent, nothing is chosen for the player, and no other mode gets any of it.
//
// THIS FILE MAKES NO KEY and runs under the no-key guard:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/frontier-local-play-pair-guide.test.mjs
// Stand-in worlds (WorldManager with a fake launch), a stand-in document. No runner, herald, chain, world or process.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { pairTargetSummary, WorldManager, createLauncherServer, CONTEST_PAIR_MODE } from '../src/frontier/local-play-launcher.mjs';
import { mountSessionNotice, pairGuideView, pairGuideText } from '../../permutation-server/web/frontier/flocalplay-session.mjs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';

const A = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', B = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', C = 'Avexj6jFeyqKwd6V9Y8M7PVSqQEWmFJXAnAroC1wv3FJ';
const CJK = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
// (the shape of pair trial 1's real ready line, numbers only)
const ready = (over = {}, pair = {}, fort = {}) => ({ schema: 'frontier-localnet-capture-demo-v1', demo_step: 'ready', test_only: true, synthetic_clock_scale: 30, test_participants: 38,
  ring: 4, player_nation: 0, provinces_opened: [{ p: -2, q: 4, ring: 4 }], refused: [],
  pair: { second_player_nation: 1, second_player_home: { p: 0, q: 2, site: 11, tile: 55 }, second_player_route_steps: 15, ...pair },
  new_ring_reachable: [{ p: -2, q: 4, keep_holder: 1, keep_tile: 18, route_steps: 23, from_tile: 41, ...fort }], ...over });
// (the runner's re-check: verify_pair's own fields; the second player's REAL home, which may differ from the prediction)
const check = (step, over = {}) => ({ schema: 'frontier-localnet-contest-pair-v1', pair_step: step, test_only: true,
  ...(step === 'pair_ready' ? { target: { p: -2, q: 4, keep_tile: 18, holder: 1 }, first_steps: 23, second_home: { p: 0, q: 2, site: 11, tile: 55 }, second_steps: 15, as_predicted: true } : { why: 'x' }), ...over });
const GOOD = { state: 'predicted', nation: 1, opponentNation: 0, fort: { p: -2, q: 4, tile: 18 }, home: { p: 0, q: 2, site: 11, tile: 55 } };
const EXPIRY = { schema: 'frontier-local-play-world-expiry-v1', startedAt: 1000, ttlMs: 2700000, expiresAt: 2701000, instance: 'a'.repeat(64) };
const SCOPE = { herald: 'http://localhost:41929', expiry: EXPIRY };
const NOW = 2000;

test('pairTargetSummary: the demo\'s ready line, numbers only; the runner\'s re-check moves it to ready / not ready', () => {
  assert.deepEqual(pairTargetSummary([]), { state: 'pending' }, 'before the demo is ready');
  assert.deepEqual(pairTargetSummary(null), { state: 'pending' });
  assert.deepEqual(pairTargetSummary([ready()]), GOOD);
  assert.deepEqual(pairTargetSummary([ready(), check('pair_ready')]), { ...GOOD, state: 'ready' });
  // the second player's real home is another legal one (as_predicted false): the CHECKED home is given, not the prediction
  const alt = pairTargetSummary([ready(), check('pair_ready', { second_home: { p: 1, q: 2, site: 4, tile: 9 }, second_steps: 20, as_predicted: false })]);
  assert.deepEqual(alt, { ...GOOD, state: 'ready', home: { p: 1, q: 2, site: 4, tile: 9 } });
  assert.equal(pairTargetSummary([ready(), check('pair_not_ready')]).state, 'not_ready');
  assert.equal(pairTargetSummary([ready(), check('pair_not_ready'), check('pair_ready')]).state, 'ready', 'the latest check');
  // a ready check about another fort or nation, or with a field missing or out of range: not shown (fail closed)
  for (const over of [{ target: { p: 0, q: 4, keep_tile: 18, holder: 1 } }, { target: { p: -2, q: 4, keep_tile: 3, holder: 1 } }, { target: { p: -2, q: 4, keep_tile: 18, holder: 2 } },
    { target: null }, { second_home: { p: 0, q: 2, site: 11, tile: 61 } }, { second_home: null }, { second_steps: 33 }, { first_steps: 0 }, { as_predicted: 'yes' }])
    assert.deepEqual(pairTargetSummary([ready(), check('pair_ready', over)]), { state: 'invalid' }, JSON.stringify(over));
  // nothing of the runner's text crosses: exactly these keys
  assert.deepEqual(Object.keys(pairTargetSummary([ready({ note: 'text' }), check('pair_ready')])).sort(), ['fort', 'home', 'nation', 'opponentNation', 'state']);
});

test('pairTargetSummary fails closed: a line that is not exactly right gives no nation', () => {
  const bad = [
    ready({}, { second_player_nation: 6 }), ready({}, { second_player_nation: -1 }), ready({}, { second_player_nation: '1' }),
    ready({ player_nation: 1 }), // the same nation on both sides
    ready({}, {}, { keep_holder: 2 }), // the fort's holder is not the nation offered
    ready({}, {}, { keep_tile: 61 }), ready({}, { second_player_home: { p: 0, q: 2, site: 11, tile: 61 } }), ready({}, { second_player_home: { p: 0.5, q: 2, site: 11, tile: 5 } }),
    ready({}, { second_player_route_steps: 33 }), ready({}, { second_player_route_steps: 0 }),
    ready({ pair: null }), ready({ new_ring_reachable: [] }), ready({ new_ring_reachable: [{ p: -2, q: 4, keep_holder: 1, keep_tile: 18 }, { p: 0, q: 4, keep_holder: 1, keep_tile: 3 }] }),
  ];
  for (const l of bad) assert.deepEqual(pairTargetSummary([l]), { state: 'invalid' }, JSON.stringify(l).slice(0, 160));
  // a line that does not say it is TEST-ONLY, or another schema, is not read at all
  assert.deepEqual(pairTargetSummary([ready({ test_only: false })]), { state: 'pending' });
  assert.deepEqual(pairTargetSummary([ready({ schema: 'frontier-localnet-capture-demo-v2' })]), { state: 'pending' });
  assert.equal(pairTargetSummary([ready(), { ...check('pair_ready'), test_only: false }]).state, 'predicted', 'an unmarked check is not read');
});

const fakeLaunch = (calls, view = async () => pairTargetSummary([ready()])) => async (c, wallet, slot, forget, signal, opts) => {
  calls.push(wallet);
  let stopped = false;
  return { herald: 'http://localhost:41924', expiry: EXPIRY, natural: true, marchTrial: true, captureDemo: { scale: 30 }, keeper: async () => null,
    ...(opts?.second ? { pair: { second: opts.second, herald: 'http://localhost:41929' }, pairView: view } : {}),
    stop: async () => { if (!stopped) { stopped = true; forget(); } } };
};

test('the launcher answers the pair\'s two addresses only, while its world runs; nothing else gets a nation', async () => {
  const calls = [];
  const m = new WorldManager({ contestPair: true }, fakeLaunch(calls));
  await assert.rejects(m.pair(A), e => e.code === 'NotAPair', 'a waiting first player has no pair yet');
  await m.start(A); await assert.rejects(m.pair(A), e => e.code === 'NotAPair');
  await m.start(B);
  assert.deepEqual(await m.pair(B), { pair: { mode: CONTEST_PAIR_MODE, role: 'second', target: GOOD, world: { herald: 'http://localhost:41929', expiry: EXPIRY } } }, 'the second player\'s own herald and the world\'s end');
  const a = (await m.pair(A)).pair;
  assert.equal(a.role, 'first'); assert.equal(a.world.herald, 'http://localhost:41924', 'the first player\'s own herald'); assert.equal(a.world.expiry, EXPIRY);
  await assert.rejects(m.pair(C), e => e.code === 'NotAPair', 'a third address');
  await assert.rejects(m.pair('not-a-wallet'), e => e.code === 'InvalidWallet');
  await m.stop(B);
  await assert.rejects(m.pair(B), e => e.code === 'NotAPair', 'after the end: the pair is forgotten');
  await assert.rejects(m.pair(A), e => e.code === 'NotAPair');
  // a world that is not a pair never answers it, however it was started
  const single = new WorldManager({}, fakeLaunch([]));
  await single.start(A); await assert.rejects(single.pair(A), e => e.code === 'NotAPair');
  // a view that cannot be read is refused, not guessed
  const blind = new WorldManager({ contestPair: true }, fakeLaunch([], async () => null));
  await blind.start(A); await blind.start(B);
  await assert.rejects(blind.pair(B), e => e.code === 'PairTargetUnavailable');
});

test('a world that ends while its lines are read gives no answer', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const m = new WorldManager({ contestPair: true }, fakeLaunch([], async () => { await gate; return pairTargetSummary([ready()]); }));
  await m.start(A); await m.start(B);
  const asking = m.pair(B);
  await m.stop(A); release();
  await assert.rejects(asking, e => e.code === 'WorldNotFound');
});

test('the route: the same POST rules as the keeper\'s; a refused request never reaches the manager', async () => {
  const asked = [];
  const manager = { pair: async w => { asked.push(w); return { pair: { mode: CONTEST_PAIR_MODE, role: 'second', target: GOOD, world: SCOPE } }; }, close: async () => {} };
  const { server } = createLauncherServer({ port: 41920, web: '/nonexistent' }, manager);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  // (the server checks its own host name against its configured port: ask with the host header it expects)
  const ask = (method, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/local-play/pair', method, headers: { host: 'localhost:41920', origin: 'http://localhost:41920', 'content-type': 'application/json', ...headers } }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    const ok = await ask('POST', JSON.stringify({ wallet: B }));
    assert.equal(ok.status, 200); assert.deepEqual(JSON.parse(ok.body).pair.target, GOOD);
    assert.equal((await ask('GET', '')).status, 405);
    assert.equal((await ask('POST', JSON.stringify({ wallet: B }), { origin: 'http://evil.example' })).status, 403);
    assert.equal((await ask('POST', JSON.stringify({ wallet: B, extra: 1 }))).status, 400);
    assert.deepEqual(asked, [B], 'only the good request was asked');
  } finally { server.close(); }
});

test('the page checks the answer again (fail closed): mode, its own role, THIS world, every number', () => {
  const body = (target, world = SCOPE) => ({ pair: { mode: CONTEST_PAIR_MODE, role: 'second', target, world } });
  const view = (b, role = 'second', scope = SCOPE, now = NOW) => pairGuideView(b, role, scope, now);
  assert.deepEqual(view(body(GOOD)), GOOD);
  assert.deepEqual(view(body({ state: 'pending' })), { state: 'pending' });
  const no = { state: 'unavailable' };
  assert.deepEqual(view(body(GOOD), 'first'), no, 'an answer for another role');
  assert.deepEqual(view(body(GOOD), null), no, 'a page that is not in a pair');
  assert.deepEqual(view({ pair: { ...body(GOOD).pair, mode: 'contest-pair-v2' } }), no, 'another mode');
  assert.deepEqual(view({}), no); assert.deepEqual(view(null), no);
  // another world: another instance, another end, another life, another herald, no identity at all; or this world's end passed
  for (const world of [{ ...SCOPE, expiry: { ...EXPIRY, instance: 'b'.repeat(64) } }, { ...SCOPE, expiry: { ...EXPIRY, expiresAt: EXPIRY.expiresAt + 1 } },
    { ...SCOPE, expiry: { ...EXPIRY, ttlMs: 1 } }, { ...SCOPE, expiry: { ...EXPIRY, startedAt: 999 } }, { ...SCOPE, expiry: { ...EXPIRY, schema: 'x' } },
    { ...SCOPE, herald: 'http://localhost:41924' }, { ...SCOPE, expiry: null }, null])
    assert.deepEqual(view(body(GOOD, world)), no, JSON.stringify(world));
  assert.deepEqual(view(body(GOOD), 'second', SCOPE, EXPIRY.expiresAt), no, 'at the end: not shown');
  assert.deepEqual(view(body(GOOD), 'second', { herald: SCOPE.herald, expiry: null }), no, 'a page that verified no end');
  assert.deepEqual(view(body(GOOD), 'second', { ...SCOPE, expiry: { ...EXPIRY, instance: '' } }, NOW), no, 'a page whose end names no instance');
  assert.deepEqual(view(body(GOOD), 'second', SCOPE, NaN), no);
  for (const t of [{ ...GOOD, nation: 7 }, { ...GOOD, opponentNation: 1 }, { ...GOOD, state: 'invalid' }, { ...GOOD, fort: { p: -2, q: 4, tile: 99 } }, { ...GOOD, home: null }, { ...GOOD, state: 'done' }])
    assert.deepEqual(view(body(t)), no, JSON.stringify(t));
  // extra fields never pass through
  assert.deepEqual(Object.keys(view(body({ ...GOOD, extra: 'x' }))).sort(), ['fort', 'home', 'nation', 'opponentNation', 'state']);
});

test('the sentence: the fort, the nation to choose to defend it, and that the choice stays free; English with no Japanese', () => {
  const was = lang(); setLang('ja');
  try {
    const t = pairGuideText(GOOD);
    assert.match(t, /州 -2,4 の砦（ボレアリス が保持）/); assert.match(t, /ボレアリス を選ぶと、あなたはこの砦を守る側/); assert.match(t, /相手（アステル）/);
    assert.match(t, /標準の村候補は 州 0,2 です/, 'before the check: a candidate, not a promise'); assert.match(t, /ほかの国も選べます/);
    const r = pairGuideText({ ...GOOD, state: 'ready', home: { p: 1, q: 2, site: 4, tile: 9 } });
    assert.match(r, /州 1,2 の村からこの砦を守れます/, 'after the check: the real village'); assert.match(r, /世界の記録で確かめました/); assert.doesNotMatch(r, /標準の村候補/);
    assert.match(pairGuideText({ ...GOOD, state: 'not_ready' }), /用意できませんでした。終了して/);
    assert.match(pairGuideText({ state: 'pending' }), /まだ決まっていません/);
    assert.match(pairGuideText({ state: 'unavailable' }), /何も送信していません/);
    assert.equal(pairGuideText(null), null);
    setLang('en');
    for (const v of [GOOD, { ...GOOD, state: 'ready' }, { ...GOOD, state: 'not_ready' }, { state: 'pending' }, { state: 'unavailable' }]) {
      const e = pairGuideText(v); assert.doesNotMatch(e, CJK, e); assert.doesNotMatch(e, BANNED_EN, e);
    }
    assert.match(pairGuideText(GOOD), /fort of Province -2,4/); assert.match(pairGuideText(GOOD), /You may choose another nation/);
  } finally { setLang(was); }
});

function stubDocument() {
  const all = [], doc = {};
  const make = tag => {
    const listeners = {};
    const el = { tag, className: '', textContent: '', id: '', hidden: false, disabled: false, type: '', dataset: {}, attrs: {}, children: [], parent: null, listeners,
      setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { for (const x of xs) { x.parent = el; el.children.push(x); } }, addEventListener(k, f) { (listeners[k] ??= []).push(f); },
      click() { for (const f of listeners.click ?? []) f(); return true; } };
    all.push(el); return el;
  };
  const body = make('body');
  return Object.assign(doc, { body, createElement: make, byClass: c => all.filter(e => e.className.split(' ').includes(c)) });
}
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

test('the notice: the pair key only when the gate gives one (second player of a pair); one read per press, its sentence shown', async () => {
  const plain = stubDocument(); mountSessionNotice({ doc: plain, win: new EventTarget(), onCheck: () => null });
  assert.equal(plain.byClass('local-play-session-pair').length, 0, 'no pair key without onPair (every other world)');
  const was = lang(); setLang('ja');
  try {
    const doc = stubDocument(); let calls = 0, resolve;
    const notice = mountSessionNotice({ doc, win: new EventTarget(), onCheck: () => null, demo: 30, onPair: () => { calls++; return new Promise(r => { resolve = r; }); } });
    const key = doc.byClass('local-play-session-pair')[0], said = doc.byClass('local-play-session-pair-said')[0];
    assert.equal(key.type, 'button'); assert.equal(key.textContent, '二人の対戦の国と砦を確認'); assert.equal(said.hidden, true);
    key.click(); await settle(); key.click(); await settle();
    assert.equal(calls, 1, 'one read at a time'); assert.equal(key.disabled, true);
    resolve(GOOD); await settle();
    assert.equal(said.hidden, false); assert.match(said.textContent, /ボレアリス を選ぶと/);
    notice.destroyed(); assert.equal(key.hidden, true); assert.equal(said.hidden, true);
    notice.unmount();
  } finally { setLang(was); }
});

test('the gate: the pair key only for the SECOND player of a capture-demo pair; a read only, through the launcher\'s own route', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay.mjs', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.\(state\.pairRole === 'second' && claimedDemo !== null \? \{ onPair: \(\) => checkPair\(mine, \{ herald: base, expiry: claimedEnd \}\) \} : \{\}\)/, 'the scope verified at its own start');
  assert.match(src, /if \(!launcher \|\| !handle \|\| handle\.destroyed \|\| handle\.address !== wallet \|\| state\.pairRole !== 'second' \|\| state\.herald !== scope\?\.herald\) return null;/);
  assert.match(src, /const result = await askLauncher\('\/local-play\/pair', \{ wallet \}, 'LauncherPairFailed'\);/);
  assert.match(src, /if \(!handle \|\| handle\.destroyed \|\| handle\.address !== wallet \|\| state\.herald !== scope\.herald\) return null;/, 'still the same page and world after the read');
  assert.match(src, /return result\.ok \? pairGuideView\(result\.body, state\.pairRole, scope, now\(\)\) : \{ state: 'unavailable' \};/);
  assert.equal(src.split('checkPair(').length - 1, 1, 'only the notice\'s key calls it');
});
