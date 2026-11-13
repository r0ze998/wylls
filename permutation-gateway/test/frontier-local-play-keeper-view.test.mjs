// The world's keeper, shown on the player's own press: the launcher's view of the runner's latest keeper line
// (keeperSummary), its one route (/local-play/keeper), the gate's call and the standing notice's key and sentence.
//
// THIS FILE MAKES NO KEY and runs under the no-key guard:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/frontier-local-play-keeper-view.test.mjs
// Stand-in worlds (WorldManager with a fake launch), a stand-in document and window, a stub `request`. No runner, herald,
// chain, world, process or stored key.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { keeperSummary, WorldManager, createLauncherServer } from '../src/frontier/local-play-launcher.mjs';
import { mountSessionNotice, keeperText } from '../../permutation-server/web/frontier/flocalplay-session.mjs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';

const KEEPER = 'frontier-local-play-keeper-v1';
const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', OTHER = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
const line = (over = {}) => ({ schema: KEEPER, running: true, resolved_next: 14, bell: 14, resident: true, anchors_posted: 3, last_action: 'FastForward to 14', last_error: null, stopped: null, unknown_signature: null, blocked: null, ...over });

test('keeperSummary: the LATEST keeper line, as codes and numbers only', () => {
  assert.equal(keeperSummary([]), null, 'before its first line');
  assert.equal(keeperSummary(null), null);
  assert.equal(keeperSummary([{ schema: 'frontier-local-play-wide-destination-v1', running: true }]), null, 'another line is not the keeper');
  assert.deepEqual(keeperSummary([line()]), { state: 'running', resident: true, resolvedNext: 14, bell: 14 });
  assert.deepEqual(keeperSummary([line({ resolved_next: 3 }), line({ resolved_next: 9 }), { schema: 'x' }]).resolvedNext, 9, 'the last keeper line');
  assert.equal(keeperSummary([line({ blocked: 'the departure bell is not quiet' })]).state, 'waiting');
  assert.equal(keeperSummary([line({ last_error: 'drand fetch failed (retry in 4s)' })]).state, 'waiting');
  assert.equal(keeperSummary([line({ stopped: 'program refused' , running: false })]).state, 'stopped');
  assert.equal(keeperSummary([line({ running: false })]).state, 'stopped', 'not running is stopped');
  assert.equal(keeperSummary([line({ running: false, stopped: 'origin: not seen', unknown_signature: '5'.repeat(88) })]).state, 'unknown', 'the keeper halted on an unknown outcome');
  // a destination or resident driver's unknown outcome or refusal ends only that driver: the keeper (and turns) go on
  assert.deepEqual(keeperSummary([line({ unknown_signature: '5'.repeat(88), destination_step: 'Unknown { signature: "5", why: "not seen" }' })]),
    { state: 'partial', part: 'unknown', resident: true, resolvedNext: 14, bell: 14 }, 'running with one driver ended on an unknown outcome');
  assert.deepEqual(keeperSummary([line({ resident_step: 'Stopped("program refused")' })]), { state: 'partial', part: 'refused', resident: true, resolvedNext: 14, bell: 14 });
  assert.equal(keeperSummary([line({ destination_step: 'Landed("GatherClash", "x")', resident_step: 'Wait("not yet")' })]).state, 'running', 'a driver that only waited or landed is not partial');
  assert.equal(keeperSummary([line({ running: false, stopped: 'origin: refused', destination_step: 'Stopped("x")' })]).state, 'stopped', 'the whole keeper halted wins over a driver');
  assert.deepEqual(keeperSummary([line({ resolved_next: -1, bell: 1.5, resident: 'yes' })]), { state: 'running', resident: null, resolvedNext: null, bell: null });
  // no runner text crosses: exactly four keys, no string but the state code
  const v = keeperSummary([line({ stopped: 'secret text', running: false, unknown_signature: 'sig' })]);
  assert.deepEqual(Object.keys(v).sort(), ['bell', 'resident', 'resolvedNext', 'state']);
  assert.ok(!JSON.stringify(v).includes('secret') && !JSON.stringify(v).includes('sig'));
});

test('WorldManager.keeper: only a running world of that address; never for one starting or ending', async () => {
  let release; const gate = new Promise(r => { release = r; });
  let reads = 0;
  const m = new WorldManager({}, async () => { await gate; return { herald: 'http://localhost:41926', stop: async () => {}, keeper: async () => { reads++; return keeperSummary([line()]); } }; });
  await assert.rejects(m.keeper('nope'), e => e.code === 'InvalidWallet');
  await assert.rejects(m.keeper(WALLET), e => e.code === 'WorldNotFound' && e.status === 404);
  const started = m.start(WALLET);
  await assert.rejects(m.keeper(WALLET), e => e.code === 'WorldNotFound', 'still starting: nothing yet');
  release(); await started;
  assert.deepEqual(await m.keeper(WALLET), { keeper: { state: 'running', resident: true, resolvedNext: 14, bell: 14 } });
  await assert.rejects(m.keeper(OTHER), e => e.code === 'WorldNotFound', 'another address has no world here');
  assert.equal(reads, 1, 'read once per ask');
  // the world ends WHILE its lines are read (TTL, stop, crash): the old 'running' view is not given
  let finish; const slow = new WorldManager({}, async () => ({ herald: 'http://localhost:41926', stop: async () => {}, keeper: () => new Promise(r => { finish = r; }) }));
  await slow.start(WALLET);
  const reading = slow.keeper(WALLET); await new Promise(r => setImmediate(r));
  const ending = slow.stop(WALLET);
  finish(keeperSummary([line()]));
  await assert.rejects(reading, e => e.code === 'WorldNotFound', 'ended during the read: refused');
  await ending;
  // and a world replaced by a NEW one of the same address during the read: the old read is not the new world's
  let finish2; const swap = new WorldManager({}, async () => ({ herald: 'http://localhost:41926', stop: async () => {}, keeper: () => new Promise(r => { finish2 = r; }) }));
  await swap.start(WALLET);
  const reading2 = swap.keeper(WALLET); await new Promise(r => setImmediate(r));
  await swap.stop(WALLET); await swap.start(WALLET);
  finish2(keeperSummary([line()]));
  await assert.rejects(reading2, e => e.code === 'WorldNotFound', 'a read of the previous world');
  const stopping = m.stop(WALLET);
  await assert.rejects(m.keeper(WALLET), e => e.code === 'WorldNotFound', 'ending: nothing');
  await stopping;
  // a world whose launch gives no keeper reader (an older stand-in): refused, not guessed
  const bare = new WorldManager({}, async () => ({ herald: 'http://localhost:41926', stop: async () => {} }));
  await bare.start(WALLET);
  await assert.rejects(bare.keeper(WALLET), e => e.code === 'WorldNotFound');
});

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers }, res => { let s = ''; res.on('data', b => { s += b; }); res.on('end', () => resolve({ status: res.statusCode, body: s })); }); req.on('error', reject); req.end(body); });
}

test('the route: strict same-origin POST of exactly {wallet}; the manager answers', async t => {
  const asked = [];
  const manager = { keeper: async w => { asked.push(w); if (w === OTHER) throw Object.assign(new Error('x'), { code: 'WorldNotFound', status: 404 }); return { keeper: { state: 'waiting', resident: false, resolvedNext: 12, bell: 14 } }; }, close() {} };
  const { server } = createLauncherServer({ port: 41920, web: '/nonexistent' }, manager);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  t.after(() => new Promise(r => server.close(r)));
  const h = { host: 'localhost:41920', origin: 'http://localhost:41920', 'content-type': 'application/json' };
  let r = await request(port, 'POST', '/local-play/keeper', JSON.stringify({ wallet: WALLET }), h);
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { keeper: { state: 'waiting', resident: false, resolvedNext: 12, bell: 14 } });
  r = await request(port, 'POST', '/local-play/keeper', JSON.stringify({ wallet: OTHER }), h);
  assert.equal(r.status, 404); assert.equal(JSON.parse(r.body).error, 'WorldNotFound');
  assert.equal((await request(port, 'GET', '/local-play/keeper', null, h)).status, 405);
  assert.equal((await request(port, 'POST', '/local-play/keeper', JSON.stringify({ wallet: WALLET, extra: 1 }), h)).status, 400);
  assert.equal((await request(port, 'POST', '/local-play/keeper', JSON.stringify({}), h)).status, 400);
  assert.equal((await request(port, 'POST', '/local-play/keeper', JSON.stringify({ wallet: WALLET }), { ...h, origin: 'http://evil.example' })).status, 403);
  assert.equal((await request(port, 'POST', '/local-play/keeper', JSON.stringify({ wallet: WALLET }), { ...h, host: 'evil.example' })).status, 403);
  assert.deepEqual(asked, [WALLET, OTHER], 'refused requests never reach the manager');
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

test('keeperText: one sentence per state; "processed through" is resolved_next − 1; no view changes nothing', () => {
  const was = lang(); setLang('ja');
  try {
    assert.equal(keeperText(null), null); assert.equal(keeperText({ state: 'other' }), null);
    assert.match(keeperText({ state: 'reported', keeper: { state: 'running', resolvedNext: 14 } }), /動いています（ターン 13 まで処理済み）/);
    assert.match(keeperText({ state: 'reported', keeper: { state: 'running', resolvedNext: 0 } }), /^世界の進行役は動いています。$/);
    assert.match(keeperText({ state: 'reported', keeper: { state: 'waiting', resolvedNext: null } }), /次の処理を待っています。編成や進軍/);
    assert.match(keeperText({ state: 'reported', keeper: { state: 'stopped' } }), /止まりました。この世界のターンはもう進まず/);
    assert.match(keeperText({ state: 'reported', keeper: { state: 'unknown' } }), /再送しません/);
    const partial = keeperText({ state: 'reported', keeper: { state: 'partial', part: 'unknown', resolvedNext: 14 } });
    assert.match(partial, /動いていますが/); assert.match(partial, /再送しません/); assert.doesNotMatch(partial, /ターンはもう進みません/, 'turns still advance');
    assert.match(keeperText({ state: 'reported', keeper: { state: 'partial', part: 'refused' } }), /拒否されて止まりました/);
    assert.match(keeperText({ state: 'reported', keeper: null }), /報告はまだありません/);
    assert.match(keeperText({ state: 'unavailable' }), /確認できませんでした/);
    setLang('en');
    assert.equal(keeperText({ state: 'reported', keeper: { state: 'running', resolvedNext: 14 } }), 'The world\'s keeper is running (turns processed through 13).');
    assert.match(keeperText({ state: 'reported', keeper: { state: 'unknown' } }), /never sent again/);
    assert.match(keeperText({ state: 'reported', keeper: { state: 'partial', part: 'unknown' } }), /^The world's keeper is running, but/);
  } finally { setLang(was); }
});

test('the notice: without onCheck no key at all; with it one ask per press, its answer shown, nothing after the key is gone', async () => {
  const plain = stubDocument(); mountSessionNotice({ doc: plain, win: new EventTarget() });
  assert.equal(plain.byClass('local-play-session-check').length, 0, 'no key without the gate\'s ask');
  const was = lang(); setLang('ja');
  try {
    const doc = stubDocument(); let calls = 0, resolve;
    const notice = mountSessionNotice({ doc, win: new EventTarget(), onCheck: () => { calls++; return new Promise(r => { resolve = r; }); } });
    const key = doc.byClass('local-play-session-check')[0], said = doc.byClass('local-play-session-keeper')[0];
    assert.equal(key.type, 'button'); assert.equal(key.textContent, '世界の進行を確認'); assert.equal(said.hidden, true);
    key.click(); await settle();
    assert.equal(calls, 1); assert.equal(key.disabled, true); assert.equal(key.textContent, '確認しています…');
    key.click(); await settle(); assert.equal(calls, 1, 'one ask at a time');
    resolve({ state: 'reported', keeper: { state: 'stopped', resolvedNext: 20 } }); await settle();
    assert.equal(key.disabled, false); assert.equal(said.hidden, false); assert.match(said.textContent, /止まりました/);
    // a dropped ask (another wallet meanwhile: null) keeps the last answer; a failing ask says it could not check
    key.click(); await settle(); resolve(null); await settle(); assert.match(said.textContent, /止まりました/);
    const failing = stubDocument();
    mountSessionNotice({ doc: failing, win: new EventTarget(), onCheck: async () => { throw new Error('x'); } });
    failing.byClass('local-play-session-check')[0].click(); await settle();
    assert.match(failing.byClass('local-play-session-keeper')[0].textContent, /確認できませんでした/);
    // after the key was discarded: no key, no answer, no ask
    notice.destroyed();
    assert.equal(key.hidden, true); assert.equal(said.hidden, true);
    key.click(); await settle(); assert.equal(calls, 2, 'no ask after the key is gone');
  } finally { setLang(was); }
});
