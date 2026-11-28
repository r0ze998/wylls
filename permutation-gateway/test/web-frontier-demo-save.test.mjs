// The walletless demo's save (demo/src/save.mjs) and browser notice (demo-polish-2; Q-WD-6, Q-WD-8). Keyless: the
// sample world is made with the keyless viewer and signs nothing; no key is derived or used here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { SAVE_KEY, SAVE_V, createClock, createRecorder, digest, readSave, replay, validSave, ReplayMismatch } from '../demo/src/save.mjs';
import EN from '../../permutation-server/web/lang/en-frontier-play.mjs';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const web = f => src(`../../permutation-server/web/${f}`);
/** A localStorage stand-in: `quota` characters at most (the browser throws QuotaExceededError past it). */
function memStorage(quota = Infinity) {
  const m = new Map();
  return {
    m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      const size = [...m].reduce((n, [a, b]) => n + (a === k ? 0 : a.length + b.length), 0) + k.length + String(v).length;
      if (size > quota) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v));
    },
    removeItem: k => { m.delete(k); },
  };
}
/** A clock over a hand-moved "real" time. */
const handClock = () => { let real = 1_000_000; const c = createClock(() => real); return { c, move: ms => { real += ms; } }; };
const sampleWorld = async wall => createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, turn: 12, delay: 3, landMs: 400, wall });
const stable = live => { const s = live.summary(); return JSON.stringify({ turn: s.turn, into: s.into, me: s.me, neighbours: s.neighbours, territory: s.territory, records: s.records, camp: s.camp, orders: live.orders.length }); };

test('readSave: nothing, a damaged save, another format or world build, and a good one', () => {
  const ls = memStorage(), id = 'abc';
  assert.deepEqual(readSave(ls, id), { status: 'none' });
  assert.deepEqual(readSave(null, id), { status: 'unavailable' });
  assert.deepEqual(readSave({ getItem() { throw new Error('denied'); } }, id), { status: 'unavailable' });
  for (const bad of ['{', '[]', 'null', '42', JSON.stringify({ v: SAVE_V, world: id, w: -1, events: [] }), JSON.stringify({ v: SAVE_V, world: id, w: 10, events: [{ w: 11, k: 'seen' }] }),
    JSON.stringify({ v: SAVE_V, world: id, w: 10, events: [{ w: 5, k: 'seen' }, { w: 4, k: 'seen' }] }),
    JSON.stringify({ v: SAVE_V, world: id, w: 10, events: [{ w: 5, k: 'post', m: 'POST', p: '/elsewhere', b: null, r: '0' }] }),
    JSON.stringify({ v: SAVE_V, world: id, w: 10, events: [{ w: 5, k: 'other' }] })]) {
    ls.setItem(SAVE_KEY, bad);
    assert.equal(readSave(ls, id).status, 'corrupt', bad);
  }
  ls.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_V, world: 'other', w: 10, events: [] }));
  assert.equal(readSave(ls, id).status, 'old', 'another world build');
  ls.setItem(SAVE_KEY, JSON.stringify({ v: 0, world: id, w: 10, events: [] }));
  assert.equal(readSave(ls, id).status, 'old', 'another format');
  const good = { v: SAVE_V, world: id, w: 10, events: [{ w: 1, k: 'seen' }, { w: 5, k: 'post', m: 'POST', p: '/gw/f/relay', b: '{}', r: '01234567' }] };
  ls.setItem(SAVE_KEY, JSON.stringify(good));
  assert.deepEqual(readSave(ls, id), { status: 'resume', save: good });
  assert.equal(validSave(good), true);
});

test('the clock: held while a POST is taken (nested holds), runs on from where it was held, set by the replay', () => {
  const { c, move } = handClock();
  assert.equal(c.wall(), 0);
  move(500);
  assert.equal(c.wall(), 500);
  assert.equal(c.freeze(), 500);
  move(300);
  assert.equal(c.freeze(), 500, 'a second hold keeps the first reading');
  c.thaw();
  move(100);
  assert.equal(c.wall(), 500, 'still held by the first');
  c.thaw();
  assert.equal(c.wall(), 500, 'runs on from where it was held (the held time is not counted)');
  move(250);
  assert.equal(c.wall(), 750);
  c.set(9_000);
  move(1_000);
  assert.equal(c.wall(), 9_000);
  c.release();
  move(40);
  assert.equal(c.wall(), 9_040);
  c.thaw();
  assert.equal(c.wall(), 9_040, 'a stray thaw changes nothing');
});

test('the recorder: each POST with its clock reading and answer digest, one at a time; a write at every turn change', async () => {
  const ls = memStorage(), { c, move } = handClock();
  const rec = createRecorder({ storage: ls, worldId: 'w1', clock: c });
  const seen = { n: 0, seen() { this.n++; } };
  move(100);
  rec.seen(seen); rec.seen(seen);
  assert.equal(seen.n, 2, 'the world is told each time');
  assert.equal(rec.events.filter(e => e.k === 'seen').length, 1, 'the first reading only is saved');
  let order = [];
  const slow = (name, ms) => () => new Promise(r => setTimeout(() => { order.push(name); r({ ok: true, name }); }, ms));
  move(200);
  const a = rec.post('POST', '/gw/f/relay', '{"a":1}', slow('a', 30));
  move(50);   // (a POST is taken when its turn in the queue comes: both are read at 350, the second after the first thawed)
  const b = rec.post('POST', '/gw/f/relay', '{"b":2}', slow('b', 1));
  assert.deepEqual(await Promise.all([a, b]), [{ ok: true, name: 'a' }, { ok: true, name: 'b' }]);
  assert.deepEqual(order, ['a', 'b'], 'one POST at a time, in the order they came');
  const posts = rec.events.filter(e => e.k === 'post');
  assert.deepEqual(posts.map(e => [e.w, e.b, e.r]), [[350, '{"a":1}', digest({ ok: true, name: 'a' })], [350, '{"b":2}', digest({ ok: true, name: 'b' })]]);
  const saved = JSON.parse(ls.getItem(SAVE_KEY));
  assert.equal(saved.v, SAVE_V); assert.equal(saved.world, 'w1'); assert.equal(saved.events.length, 3);
  // the world reads one time for the whole of a POST, however long it takes (the replay reads that same time)
  const inside = [];
  await rec.post('POST', '/gw/f/relay', '{}', async () => { move(700); inside.push(c.wall()); await new Promise(r => setTimeout(r, 5)); move(300); inside.push(c.wall()); return { ok: true }; });
  assert.deepEqual(inside, [rec.events.at(-1).w, rec.events.at(-1).w], 'the clock is held while the POST is taken');
  // a POST that throws is saved as thrown (the replay must throw the same)
  await assert.rejects(rec.post('POST', '/gw/f/relay', null, () => Promise.reject(new Error('boom'))), /boom/);
  assert.match(rec.events.at(-1).r, /^throw:/);
  // a turn change writes the clock reading
  move(5_000);
  rec.tick(43); const w1 = JSON.parse(ls.getItem(SAVE_KEY)).w;
  move(1_000);
  rec.tick(43); assert.equal(JSON.parse(ls.getItem(SAVE_KEY)).w, w1, 'same turn: no write');
  rec.tick(44); assert.equal(JSON.parse(ls.getItem(SAVE_KEY)).w, w1 + 1_000);
  assert.deepEqual(rec.state(), { on: true, why: null, inputs: 4 });
  // Start over: removed, and nothing written after it
  rec.clear();
  assert.equal(ls.getItem(SAVE_KEY), null);
  rec.tick(45); rec.write();
  assert.equal(ls.getItem(SAVE_KEY), null);
  assert.equal(rec.state().on, false);
});

test('quota-safe: a full storage, or a save past its size, drops the save (a reload then starts fresh) and says so', async () => {
  const ls = memStorage(400), { c } = handClock();
  const rec = createRecorder({ storage: ls, worldId: 'w', clock: c });
  rec.seen({ seen() {} });
  assert.ok(ls.getItem(SAVE_KEY));
  await rec.post('POST', '/gw/f/relay', 'x'.repeat(600), async () => ({ ok: true }));
  assert.equal(ls.getItem(SAVE_KEY), null, 'no half-saved world is left behind');
  assert.deepEqual(rec.state(), { on: false, why: 'full', inputs: 1 });
  const big = createRecorder({ storage: memStorage(), worldId: 'w', clock: c, maxChars: 200 });
  await big.post('POST', '/gw/f/relay', 'y'.repeat(300), async () => ({ ok: true }));
  assert.equal(big.state().why, 'full');
  const none = createRecorder({ storage: null, worldId: 'w', clock: c });
  assert.deepEqual(none.state(), { on: false, why: 'unavailable', inputs: 0 });
  const off = createRecorder({ storage: memStorage(), worldId: 'w', clock: c });
  off.disable('NoEd25519');
  assert.deepEqual(off.state(), { on: false, why: 'NoEd25519', inputs: 0 });
});

test('replay: the sample world made again from its save is the same world at the same clock reading; a differing answer throws', async () => {
  const ls = memStorage(), A = handClock();
  const one = await sampleWorld(A.c.wall);
  const rec = createRecorder({ storage: ls, worldId: 'w', clock: A.c });
  A.move(700);
  rec.seen(one);
  A.move(9 * 12_000 + 345);
  // a POST the keyless world answers (it refuses to sign: a deterministic answer, saved and replayed)
  const r = await rec.post('POST', '/gw/f/relay', JSON.stringify({ tx: 'AAAA' }), () => one.relay('POST', '/gw/f/relay', { tx: 'AAAA' }));
  assert.equal(r.status ?? 200, 200);
  A.move(31 * 12_000 + 77);
  one.summary();
  rec.tick(one.turn());
  const want = stable(one);
  const found = readSave(ls, 'w');
  assert.equal(found.status, 'resume');
  const B = handClock();
  const two = await sampleWorld(B.c.wall);
  await replay(two, found.save, B.c);
  assert.equal(stable(two), want, 'same turn, neighbours, land, log, camp');
  assert.ok(two.turn() >= 42 + 40, `the clock was caught up (turn ${two.turn()})`);
  B.move(12_000);
  assert.equal(two.turn(), one.turn() + 1, 'and it runs on after the replay');
  // a saved answer that does not come again: the world would not be the saved one
  const bad = structuredClone(found.save);
  bad.events.find(e => e.k === 'post').r = 'deadbeef';
  const C = handClock();
  await assert.rejects(replay(await sampleWorld(C.c.wall), bad, C.c), e => e instanceof ReplayMismatch && e.code === 'ReplayMismatch');
});

test('the demo boot: reads answered only after the replay; every POST through the recorder; Start over asks first; no Ed25519 → a keyless world', () => {
  const boot = src('../demo/src/boot.mjs');
  assert.match(boot, /const createLive = opts => makeLive\(\{ \.\.\.opts, wall: CLOCK\.wall, \.\.\.\(NO_KEYS \? \{ keyless: true \} : \{\}\) \}\);/);
  assert.match(boot, /const \{ v, live \} = await ready\(\);/);
  assert.match(boot, /if \(method === 'POST'\) return \(await SAVER\.post\(method, path, bodyText \?\? null, \(\) => live\.relay\(method, path, body\)\)\) \?\? stillRelay\(v, path, method\);/);
  assert.match(boot, /if \(path === '\/h\/season'\) SAVER\.seen\(live\);/);
  // (demo-solo-goal: the result screen's "Play again" — data-demo-reset="now" — starts over without the question; the tag's
  //  Start over still asks)
  assert.match(boot, /if \(b\.getAttribute\('data-demo-reset'\) === 'now' \|\| globalThis\.confirm\(b\.getAttribute\('data-confirm'\) \|\| 'Start over\?'\)\) startOver\(\);/);
  assert.match(boot, /if \(FOUND\.status !== 'resume' \|\| NO_KEYS\) return x;/);
  assert.match(boot, /try \{ await replay\(x\.live, FOUND\.save, CLOCK\); \} catch \(e\) \{\n\s+log\.errors\.push\(`save: \$\{e\?\.message \?\? e\}`\);\n\s+startOver\('failed'\);/);
  assert.match(boot, /const v = await W\.viewer\(\{ keyless: NO_KEYS \}\);/);
  // the page storage is cleared only for a fresh world
  assert.match(boot, /\} else if \(LS\) \{\n\s+if \(FOUND\.status === 'old' \|\| FOUND\.status === 'corrupt'\) LS\.removeItem\(SAVE_KEY\);\n\s+freshStorage\(\);/);
  assert.equal(SAVE_KEY.startsWith('ps-'), false, 'the save is not one of the page keys a fresh world clears');
});

test('the page: the Ed25519 notice replaces the join button in a demo world; the tag has Start over only while saving; EN for each, never "season"', async () => {
  const join = web('frontier/screens/join.mjs'), app = web('frontier/app.mjs');
  assert.match(join, /\$\{demoCrypto \? demoCryptoNotice\(demoCrypto\) : FS\.wallet \? html`<button type="button" class="btn primary nc-btn" data-stable="join-go"/);
  assert.match(join, /const demoCrypto = FS\.sample\?\.demo && typeof FS\.sample\.demo\.crypto === 'string' && FS\.sample\.demo\.crypto !== 'ok' \? FS\.sample\.demo\.crypto : null;/);
  assert.match(app, /const reset = saved \? html`<button type="button" class="sample-reset" data-demo-reset="1" data-confirm="\$\{L`/);
  const { demoCryptoNotice, demoRestoreNote } = await import('../../permutation-server/web/frontier/screens/join.mjs');
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  try {
    setLang('en');
    const no = String(demoCryptoNotice('NoEd25519'));
    assert.match(no, /data-demo-crypto="NoEd25519"/);
    assert.match(no, /Chrome or Edge 137 or later, Firefox 129 or later, or Safari 17 or later/);
    assert.match(String(demoCryptoNotice('InsecureContext')), /https address/);
    assert.match(String(demoRestoreNote({ save: { restore: 'old' } })), /earlier version of the demo/);
    assert.match(String(demoRestoreNote({ save: { restore: 'corrupt' } })), /couldn(?:'|&#39;)t be loaded/);
    assert.match(String(demoRestoreNote({ save: { restore: 'failed' } })), /data-demo-restore="failed"/);
    for (const r of ['none', 'resume', undefined]) assert.equal(String(demoRestoreNote({ save: { restore: r } })), '');
    setLang('ja');
    assert.match(String(demoCryptoNotice('NoEd25519')), /Chrome または Edge 137 以降、Firefox 129 以降、Safari 17 以降で開いてください。/);
  } finally { setLang('ja'); }
  const mine = Object.keys(EN).filter(k => /体験版|最初から|このブラウザ|保存されていた/.test(k) && /保存|最初から|署名|https/.test(k));
  assert.ok(mine.length >= 9, `EN for the new strings (${mine.length})`);
  for (const k of mine) assert.doesNotMatch(EN[k], /season/i, k);
  // (the version numbers are the repository's own statement of WebCrypto Ed25519 support: session.mjs preflight)
  assert.match(web('session.mjs'), /\(Chrome\/Edge 137\+, Firefox 129\+, Safari 17\+\)/);
});
