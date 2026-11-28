// test-gaps-9: the walletless demo's load-time decisions (#308 demo-polish-2) and its build's Dev Wallet line (#307
// fix-demo-wallet-p0), checked in Node on every pull request. Until now these were checked only in a browser (verify-pr308,
// fix-demo-wallet-p0) or by source pins (web-frontier-demo-save.test.mjs).
//
// KEY-FREE, and NO SIGNATURE (Q-FDW-2 is not answered): the demo boot (demo/src/boot.mjs) tests the browser's Ed25519 at
// load by deriving a key from a fixed seed and signing a fixed text. Here that test never gets that far: every boot below
// runs either in an insecure context (it stops before any crypto) or with a WebCrypto stub that rejects every Ed25519
// operation and the seed's SHA-512 with NotSupportedError (a browser without Ed25519). The stub records each call and
// the tests assert that no Ed25519 operation and no seed hash was attempted. The world is then the keyless sample world
// (W.viewer({ keyless: true })). The key-free CI run also preloads scripts/ci/no-keys-guard.mjs.
//
// How boot.mjs runs in Node: it is the module esbuild bundles as demo-world.js. Its one bundle-only import, `demo:config`
// (build.mjs's DEMO record), is answered by a module resolve hook registered below; the browser globals it reads
// (location, localStorage, document, isSecureContext, crypto, confirm, fetch) are stand-ins set before each load. Each
// load imports a fresh instance (`boot.mjs?load=N`: a computed import, so the key-test scan pins boot.mjs and build.mjs
// as `targets=` of this file's review, scripts/ci/node-key-reviewed.txt).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { SAVE_KEY, SAVE_V, createClock, createRecorder, readSave, replay } from '../demo/src/save.mjs';

const HERE = new URL('.', import.meta.url);
const WEB = new URL('../../permutation-server/web/', import.meta.url);
const WORLD_ID = '0123456789abcdef';
const DEMO = { turnSecs: 12, delaySecs: 3, landMs: 400, liveUrl: '', worldId: WORLD_ID };
const NOTE_KEY = 'wylls-demo-save-note';

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'demo:config') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export const DEMO = Object.freeze(${JSON.stringify(DEMO).replace(/'/g, "\\'")});') };
    return next(spec, ctx);
  }`)}`);

/** localStorage as a browser has it: the items are the object's own keys (boot.mjs walks Object.keys(localStorage)). */
class Store {
  getItem(k) { return Object.hasOwn(this, k) ? this[k] : null; }
  setItem(k, v) { this[k] = String(v); }
  removeItem(k) { delete this[k]; }
  snapshot() { return Object.fromEntries(Object.keys(this).sort().map(k => [k, this[k]])); }
}
Object.defineProperties(Store.prototype, Object.fromEntries(['getItem', 'setItem', 'removeItem', 'snapshot'].map(k => [k, { enumerable: false }])));

/** A WebCrypto with no Ed25519 (and that refuses the seed's SHA-512): every call is recorded. */
function noEd25519() {
  const calls = [];
  const refuse = (what, alg) => { calls.push([`refused:${what}`, typeof alg === 'string' ? alg : alg?.name]); return Promise.reject(new DOMException(`${what}: Ed25519 is not supported (test stub)`, 'NotSupportedError')); };
  const real = globalThis.crypto;
  const subtle = {
    digest: (alg, data) => { const n = typeof alg === 'string' ? alg : alg?.name; if (/^SHA-512$/i.test(n)) return refuse('digest', n); calls.push(['digest', n]); return real.subtle.digest(alg, data); },
    importKey: (f, k, alg) => refuse('importKey', alg), exportKey: (f, k) => refuse('exportKey', k?.algorithm),
    generateKey: alg => refuse('generateKey', alg), sign: alg => refuse('sign', alg), verify: alg => refuse('verify', alg),
  };
  return { crypto: { subtle, getRandomValues: a => real.getRandomValues(a), randomUUID: () => real.randomUUID() }, calls };
}

const wasm = f => readFileSync(new URL(`frontier/wasm/${f}`, WEB));
/** The page's own fetch for the files boot.mjs reads itself (the kernel); anything else is a test failure. */
async function diskFetch(input) {
  const u = String(input?.url ?? input);
  if (u.endsWith('/wasm/frontier.wasm')) return new Response(wasm('frontier.wasm'));
  if (u.endsWith('/wasm/frontier.wasm.sha256')) return new Response(wasm('frontier.wasm.sha256'));
  throw new Error(`test: unexpected fetch ${u}`);
}

const realCrypto = globalThis.crypto;
let loads = 0;
/**
 * One page load of the demo boot at the real Pages address. `storage`: what the browser kept from before; `secure`:
 * an https page; `confirm`: the answer to Start over's question. Returns the stand-ins and the boot's handles.
 */
async function load({ storage = new Store(), secure = true, confirm = () => false, lang = 'en' } = {}) {
  const page = { reloads: 0, listeners: {}, docListeners: {}, confirms: [] };
  const href = `https://r0ze998.github.io/wylls/frontier/index.html${lang ? `?lang=${lang}` : ''}`;
  globalThis.location = { href, origin: 'https://r0ze998.github.io', hostname: 'r0ze998.github.io', protocol: 'https:', reload() { page.reloads++; } };
  globalThis.localStorage = storage;
  globalThis.document = { visibilityState: 'visible', addEventListener: (t, f) => { (page.docListeners[t] ??= []).push(f); } };
  globalThis.addEventListener = (t, f) => { (page.listeners[t] ??= []).push(f); };
  globalThis.confirm = q => { page.confirms.push(q); return confirm(q); };
  globalThis.fetch = diskFetch;
  const stub = noEd25519();
  Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'crypto', { value: stub.crypto, configurable: true, writable: true });
  const boot = await import(new URL(`../demo/src/boot.mjs?load=${++loads}`, HERE).href);
  const demo = globalThis.__wyllsDemo, own = globalThis.fetch;   // (this load's own shim: a later load replaces the global)
  const get = async path => { const r = await own(new URL(path, href)); return { status: r.status, body: await r.json() }; };
  const post = async (path, body) => { const r = await own(new URL(path, href), { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const click = attrs => { const el = { getAttribute: k => attrs[k] ?? null }; for (const f of page.docListeners.click ?? []) f({ target: { closest: s => (s === '[data-demo-reset]' && attrs['data-demo-reset'] ? el : null) }, preventDefault() {} }); };
  const hide = () => { for (const f of page.listeners.pagehide ?? []) f(); globalThis.document.visibilityState = 'hidden'; for (const f of page.docListeners.visibilitychange ?? []) f(); };
  return { boot, demo, page, storage, stub, get, post, click, hide };
}
test.after(() => { Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true, writable: true }); });

const STALE = { 'ps-wallet': 'Some Other Wallet', 'ps-session-old': 'x', 'ps-lang': 'ja', 'unrelated': 'kept' };
const goodSave = (extra = {}) => JSON.stringify({ v: SAVE_V, world: WORLD_ID, w: 5_000, events: [{ w: 100, k: 'seen' }], ...extra });
const withItems = items => { const s = new Store(); for (const [k, v] of Object.entries(items)) s.setItem(k, v); return s; };
const freshPs = lang => Object.fromEntries(Object.entries(W.storageFor(null, { stage: 'none', lang, live: true })).map(([k, v]) => [k, String(v)]));
/** Every crypto call the boot made was refused, or a digest other than the seed's SHA-512; it never reached a signature. */
const noEd25519Touched = stub => {
  for (const [what, alg] of stub.calls) assert.ok(what.startsWith('refused:') || (what === 'digest' && !/512/.test(alg)), `${what} ${alg}`);
  assert.ok(!stub.calls.some(([w]) => /sign|verify|generateKey|exportKey/.test(w)), 'the browser test stopped at its first step');
};

test('#308 a damaged save, an old save (another world build or format), and no save: a fresh world at the picker, stale page storage cleared, the note said once', async () => {
  const cases = [
    ['corrupt', '{', 'corrupt'], ['corrupt', '[]', 'corrupt'],
    ['corrupt', JSON.stringify({ v: SAVE_V, world: WORLD_ID, w: 10, events: [{ w: 5, k: 'seen' }, { w: 4, k: 'seen' }] }), 'corrupt'],
    ['corrupt', JSON.stringify({ v: SAVE_V, world: WORLD_ID, w: 10, events: [{ w: 5, k: 'post', m: 'POST', p: '/elsewhere', b: null, r: '0' }] }), 'corrupt'],
    ['old', goodSave({ world: 'fedcba9876543210' }), 'old'], ['old', goodSave({ v: SAVE_V + 1 }), 'old'],
    ['none', null, 'none'],
  ];
  for (const [kind, text, restore] of cases) {
    const storage = withItems({ ...STALE, ...(text === null ? {} : { [SAVE_KEY]: text }) });
    const x = await load({ storage, secure: false, lang: null });
    const why = `${kind}: ${text}`;
    assert.equal(x.demo.save().restore, restore, why);
    assert.equal(storage.getItem(SAVE_KEY), null, `${why}: the save is gone`);
    // the demo's page storage is the fresh guest's (no Citizen yet: the picker), the language kept, other sites' keys kept
    assert.deepEqual(Object.fromEntries(Object.entries(storage.snapshot()).filter(([k]) => k.startsWith('ps-'))), freshPs('ja'), `${why}: fresh ps-* (language ja kept)`);
    assert.equal(storage.getItem('unrelated'), 'kept', why);
    const rec0 = await x.get('/h/season');
    assert.equal(rec0.status, 200);
    assert.equal(rec0.body.sample.demo.save.restore, restore, `${why}: the page is told (its note: demoRestoreNote)`);
    assert.equal(rec0.body.sample.demo.crypto, 'InsecureContext');
    assert.deepEqual(x.stub.calls, [], `${why}: an insecure page tries no crypto at all`);
  }
});

test('#308 a note left by the last load (a replay that differed → "failed") is said at this load only, then removed', async () => {
  const storage = withItems({ [NOTE_KEY]: 'failed', 'ps-lang': 'en' });
  const one = await load({ storage, secure: false });
  assert.equal(one.demo.save().restore, 'failed');
  assert.equal(storage.getItem(NOTE_KEY), null, 'read once');
  assert.equal((await one.get('/h/season')).body.sample.demo.save.restore, 'failed');
  const two = await load({ storage, secure: false });
  assert.equal(two.demo.save().restore, 'none', 'the next load says nothing');
  // a note never overrides a save that is there, and an unknown note is ignored
  const three = await load({ storage: withItems({ [NOTE_KEY]: 'old', [SAVE_KEY]: '{' }), secure: false });
  assert.equal(three.demo.save().restore, 'corrupt');
  const four = await load({ storage: withItems({ [NOTE_KEY]: 'nonsense' }), secure: false });
  assert.equal(four.demo.save().restore, 'none');
});

test('#308 no Ed25519: a good save is left exactly as it was (no replay, nothing written — not by POSTs, turns, pagehide or a hidden tab); the world\'s record says NoEd25519', async () => {
  const save = goodSave();
  const kept = { 'ps-wallet': 'Dev Wallet (localnet)', 'ps-lang': 'en', 'ps-something': 'x' };
  const storage = withItems({ ...kept, [SAVE_KEY]: save });
  const x = await load({ storage, secure: true });
  const rec0 = await x.get('/h/season');
  assert.equal(rec0.body.sample.demo.crypto, 'NoEd25519');
  assert.deepEqual(rec0.body.sample.demo.save, { on: false, why: 'NoEd25519', inputs: 0, restore: 'resume' });
  noEd25519Touched(x.stub);
  assert.ok(x.stub.calls.length >= 1, 'the browser test ran (and was refused)');
  const refused = await x.post('/gw/f/relay', { tx: 'AAAA' });
  assert.equal(refused.body.ok, false, 'a keyless world refuses every order');
  await x.get('/h/season');
  x.hide();
  assert.equal(storage.getItem(SAVE_KEY), save, 'the save is byte for byte the same');
  assert.deepEqual(storage.snapshot(), { ...kept, [SAVE_KEY]: save }, 'the page storage of a resumable save is not cleared');
  assert.equal(x.page.reloads, 0);
  assert.deepEqual(x.demo.log.blocked, []);
  assert.deepEqual(x.demo.log.errors, []);
});

test('#308 not https: the world\'s record says InsecureContext and no crypto is tried; with a save it is left as it was too', async () => {
  const save = goodSave();
  const storage = withItems({ 'ps-lang': 'en', [SAVE_KEY]: save });
  const x = await load({ storage, secure: false });
  assert.equal((await x.get('/h/season')).body.sample.demo.crypto, 'InsecureContext');
  assert.deepEqual(x.demo.save(), { on: false, why: 'InsecureContext', inputs: 0, restore: 'resume', key: SAVE_KEY, world: WORLD_ID });
  x.hide();
  assert.equal(storage.getItem(SAVE_KEY), save);
  assert.deepEqual(x.stub.calls, []);
});

test('#308 Start over: asks first (the button\'s own question); dismissed changes nothing; accepted removes the save and the demo\'s page storage (not the language), then reloads once', async () => {
  const items = { 'ps-wallet': 'Dev Wallet (localnet)', 'ps-lang': 'ja', 'ps-x': '1', 'unrelated': 'kept', [SAVE_KEY]: goodSave() };
  let answer = false;
  const storage = withItems(items);
  const x = await load({ storage, secure: false, confirm: () => answer, lang: null });
  x.click({ 'data-demo-reset': '1', 'data-confirm': 'Start over? Your saved world in this browser is deleted.' });
  assert.deepEqual(x.page.confirms, ['Start over? Your saved world in this browser is deleted.']);
  assert.equal(x.page.reloads, 0, 'dismissed: no reload');
  assert.deepEqual(storage.snapshot(), withItems(items).snapshot(), 'dismissed: nothing changed');
  x.click({ 'data-something-else': '1' });
  assert.equal(x.page.confirms.length, 1, 'another click is not Start over');
  answer = true;
  x.click({ 'data-demo-reset': '1' });
  assert.equal(x.page.confirms[1], 'Start over?', 'a button without its own question still asks');
  assert.equal(x.page.reloads, 1);
  assert.deepEqual(storage.snapshot(), { 'ps-lang': 'ja', unrelated: 'kept' }, 'the save and every ps-* key but the language are gone; no note for the next load');
  // and the next load is a fresh world that says nothing about a save
  const next = await load({ storage, secure: false, lang: null });
  assert.equal(next.demo.save().restore, 'none');
});

test('#308 the notice reaches the nation picker: from the boot\'s world record, the picker shows the notice in place of the start button (EN + JA), no wording of the old kind', async () => {
  const { renderNations } = await import('../../permutation-server/web/frontier/screens/join.mjs');
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  const x = await load({ secure: true });
  const y = await load({ secure: false });
  const demoOf = async b => (await b.get('/h/season')).body.sample.demo;
  const base = { mode: 'play', season: { programVersion: 2 }, joinDraft: { faction: 2 }, wallet: { address: 'Dev', name: 'Dev Wallet (localnet)' }, homeChoice: null, holdings: [] };
  try {
    for (const lang of ['en', 'ja']) {
      setLang(lang);
      for (const [b, code] of [[x, 'NoEd25519'], [y, 'InsecureContext']]) {
        const out = String(renderNations({ ...base, sample: { world: 'sample', demo: await demoOf(b) } }));
        assert.match(out, new RegExp(`data-demo-crypto="${code}"`), `${lang} ${code}`);
        assert.doesNotMatch(out, /data-stable="join-go"/, `${lang} ${code}: no start button (it would fail)`);
        assert.doesNotMatch(out.replace(/<[^>]+>/g, ' '), /season|シーズン/i);
        if (lang === 'en') assert.match(out, code === 'NoEd25519' ? /Chrome or Edge 137 or later/ : /https address/);
      }
      // the same page with a browser that can sign has its start button (the boot says 'ok')
      const ok = String(renderNations({ ...base, sample: { world: 'sample', demo: { ...(await demoOf(x)), crypto: 'ok' } } }));
      assert.match(ok, /data-stable="join-go"/);
      assert.doesNotMatch(ok, /data-demo-crypto=/);
    }
  } finally { setLang('ja'); }
});

// ------------------------------------------------------------------ the save → replay → the same world, polled as the page polls
/** Everything the page can read of the world, hashed: the summary, the world's record, every province it shows, the event log. */
function worldHash(live, { slots = false } = {}) {
  const s = live.summary();
  const events = structuredClone(live.herald('/h/events', new URL('http://x/h/events?after=0'))?.body);
  // (D-test-gaps-9-2: an event's `slot` is stamped when the world steps, which is at the next READ — so it differs
  //  between a world read on the page's cadence and its replay; compared on its own in the todo test below)
  if (!slots) for (const e of events?.events ?? []) delete e.slot;
  const reads = { summary: s, record: live.herald('/h/season', new URL('http://x/h/season'))?.body, events };
  const provinces = new Set([...(s.territory ?? [])].map(t => `${t.p},${t.q}`));
  for (const n of s.neighbours ?? []) if (Number.isInteger(n.p)) provinces.add(`${n.p},${n.q}`);
  for (const k of [...provinces].sort()) { const [p, q] = k.split(','); reads[`province ${k}`] = live.herald(`/h/province/${p},${q}/latest`, new URL(`http://x/h/province/${p},${q}/latest`))?.body; }
  return JSON.stringify(reads, (k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v));
}
const handClock = () => { let real = 1_000_000; const c = createClock(() => real); return { c, move: ms => { real += ms; } }; };
const keylessWorld = async wall => createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, turn: 12, delay: 3, landMs: 400, wall });
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };

test('#308 save → reload → the same world: a world the page polled every few seconds, and the same world replayed from its save with no reads between, read identically — and again after a second reload', async () => {
  const ls = memory(), A = handClock();
  const one = await keylessWorld(A.c.wall);
  const rec = createRecorder({ storage: ls, worldId: 'w', clock: A.c });
  A.move(900); rec.seen(one);
  // the page reads the world on its own cadence (2–7 s, mid-turn reads included) and sends what a keyless page can
  const steps = [2_000, 3_500, 7_000, 5_200, 2_100, 6_600, 4_400, 3_000];
  let t = 0;
  for (let i = 0; i < 60; i++) {
    A.move(steps[i % steps.length]); t += steps[i % steps.length];
    one.summary(); one.herald('/h/season', new URL('http://x/h/season'));
    if (i % 17 === 5) await rec.post('POST', '/gw/f/relay', JSON.stringify({ tx: `AAAA${i}` }), () => one.relay('POST', '/gw/f/relay', { tx: `AAAA${i}` }));
    if (i % 23 === 11) await rec.post('POST', '/gw/f/nudge', '{}', () => one.relay('POST', '/gw/f/nudge', {}));
    rec.tick(one.turn());
  }
  rec.write();
  const at = A.c.wall(), want = worldHash(one), turn = one.turn();
  assert.ok(turn >= 20, `the world moved on (turn ${turn})`);
  const found = readSave(ls, 'w');
  assert.equal(found.status, 'resume');
  assert.equal(found.save.w, at, 'the save holds the clock reading of its last write');
  // reload 1: made again from the save, read only at the end
  const B = handClock();
  const two = await keylessWorld(B.c.wall);
  await replay(two, found.save, B.c);
  assert.equal(B.c.wall(), at);
  assert.equal(worldHash(two), want, 'the same world (every read the page makes)');
  // it runs on, saved by a recorder that continues the old save (as boot.mjs does: `from`), and a second reload is the same again
  const rec2 = createRecorder({ storage: ls, worldId: 'w', clock: B.c, from: found.save });
  for (let i = 0; i < 25; i++) { B.move(4_321); A.move(4_321); if (i % 3 === 0) two.summary(); rec2.tick(two.turn()); }
  await rec2.post('POST', '/gw/f/relay', '{"tx":"BBBB"}', () => two.relay('POST', '/gw/f/relay', { tx: 'BBBB' }));
  await one.relay('POST', '/gw/f/relay', { tx: 'BBBB' });
  rec2.write();
  const want2 = worldHash(one);
  assert.equal(worldHash(two), want2, 'the replayed world and the first one stay the same as they run on');
  const C = handClock();
  const three = await keylessWorld(C.c.wall);
  await replay(three, readSave(ls, 'w').save, C.c);
  assert.equal(worldHash(three), want2, 'reload 2 is the same world');
  assert.notEqual(want2, want, 'and the world did move between the two reloads');
});

// D-test-gaps-9-2 (found here; behaviour NOT changed, Q-TG9-1 to r0ze): every herald read of the replayed world is the
// same as the polled one's EXCEPT the event log's `slot` stamps. liveworld.mjs `emit` stamps an event with slotNow() at
// the moment the world steps, and the world steps lazily at the next read: on the page's 2–7 s cadence before the reload,
// at the saved POSTs and the last write in the replay. save.mjs says the keeper steps "run at fixed world times whatever
// reads come between" — true of the world's state, not of these stamps. The page decodes `slot` (flog.mjs) but no
// screen found reads it, so nothing visible changes (verify-pr308's records matched). Expected to fail until answered.
test('D-test-gaps-9-2: the replayed world\'s event log has the same slot stamps as the world the page polled', { todo: 'Q-TG9-1: event slots are stamped at read time (liveworld.mjs emit → slotNow), so a replay differs in them' }, async () => {
  const ls = memory(), A = handClock();
  const one = await keylessWorld(A.c.wall);
  const rec = createRecorder({ storage: ls, worldId: 'w', clock: A.c });
  A.move(900); rec.seen(one);
  for (let i = 0; i < 40; i++) { A.move(3_000 + (i % 5) * 900); one.summary(); rec.tick(one.turn()); }
  rec.write();
  const want = worldHash(one, { slots: true });
  const B = handClock();
  const two = await keylessWorld(B.c.wall);
  await replay(two, readSave(ls, 'w').save, B.c);
  assert.equal(worldHash(two, { slots: true }), want);
});

// ------------------------------------------------------------------ #307: the demo build's Dev Wallet line
test('#307 the demo build says dev on any host (the Pages host included) — the real page only on loopback; the patch is exactly the one line', async () => {
  const build = readFileSync(new URL('../demo/build.mjs', HERE), 'utf8');
  const cfgSrc = readFileSync(new URL('frontier/config.mjs', WEB), 'utf8');
  const lineOf = name => { const m = new RegExp(`${name} = '([^']+)'`).exec(build); assert.ok(m, `build.mjs ${name}`); return m[1]; };
  const DEV_LINE = lineOf('DEV_LINE'), DEMO_DEV_LINE = lineOf('DEMO_DEV_LINE');
  assert.equal(cfgSrc.split(DEV_LINE).length, 2, 'config.mjs has the line build.mjs replaces, once (else the build throws)');
  assert.match(DEMO_DEV_LINE, /^const dev = true;/);
  // build.mjs replaces it with String.replace (first occurrence), counts the patch, and throws unless it was made once
  assert.match(build, /if \(!src\.includes\(DEV_LINE\)\) throw new Error\(/);
  assert.match(build, /src = src\.replace\(DEV_LINE, DEMO_DEV_LINE\); configPatched\+\+;/);
  assert.match(build, /if \(configPatched !== 1\) throw new Error\(/);
  const asModule = text => import(`data:text/javascript,${encodeURIComponent(text)}`);
  const real = await asModule(cfgSrc), demo = await asModule(cfgSrc.replace(DEV_LINE, DEMO_DEV_LINE));
  const at = (href, body = null) => [new URL(href), body ? { body: { dataset: body } } : null];
  for (const href of ['https://r0ze998.github.io/wylls/frontier/index.html', 'https://r0ze998.github.io/wylls/', 'https://example.org/demo/frontier/', 'http://r0ze998.github.io/wylls/']) {
    assert.equal(real.config(...at(href)).dev, false, `the real page is not dev at ${href}`);
    assert.equal(demo.config(...at(href)).dev, true, `the demo is dev at ${href} (its guest's Dev Wallet is offered)`);
  }
  for (const href of ['http://127.0.0.1:41610/frontier/', 'http://localhost:8080/', 'http://[::1]:9/', 'http://game.localhost/']) {
    assert.equal(real.config(...at(href)).dev, true, href);
    assert.equal(demo.config(...at(href)).dev, true, href);
  }
  // what else dev opens in the demo (fix-demo-wallet-p0's list): ?devWallet=off is honoured; ?herald= only to a loopback herald
  const pages = 'https://r0ze998.github.io/wylls/frontier/index.html';
  assert.equal(demo.config(...at(`${pages}?devWallet=off`)).devWallet, false);
  assert.equal(real.config(...at(`${pages}?devWallet=off`)).devWallet, undefined, 'the real page off loopback has no Dev Wallet to turn off');
  assert.equal(demo.config(...at(`${pages}?herald=https://evil.example`)).herald, 'https://r0ze998.github.io', 'never a remote herald');
  assert.equal(demo.config(...at(`${pages}?herald=http://127.0.0.1:9`)).herald, 'http://127.0.0.1:9', 'a loopback herald (the demo\'s fetch shim refuses other origins anyway)');
  assert.equal(real.config(...at(`${pages}?herald=http://127.0.0.1:9`)).herald, 'https://r0ze998.github.io');
  // everything but `dev` is the same object
  for (const href of [pages, `${pages}?lang=ja`]) {
    const { dev: a, ...ra } = real.config(...at(href, { mode: 'spectate' })), { dev: b, ...rb } = demo.config(...at(href, { mode: 'spectate' }));
    assert.deepEqual(rb, ra);
  }
});

// ------------------------------------------------------------------ #311 × #307: the demo-fort exception never on the Pages demo
// (#311 fix-lp29-fog-fort lets the guide and the keep list name a TEST-ONLY capture demo's prepared fort under the fog; the
//  page asks the launcher for it only in a launcher world. #307 made the Pages demo's config say dev on any host, and
//  local play is entered only when dev — so what keeps the exception off the Pages demo is localPlayRequested's own
//  loopback check. verify-pr311 #14 saw 0 /local-play/* requests in a browser; this is that rule, on every PR.)
test('#311 the Pages demo (dev on any host since #307) never enters local play — so never asks for the demo fort — even with ?localPlay=1; a loopback page still does', async () => {
  const { localPlayRequested } = await import('../../permutation-server/web/frontier/flocalplay.mjs');
  const build = readFileSync(new URL('../demo/build.mjs', HERE), 'utf8');
  const cfgSrc = readFileSync(new URL('frontier/config.mjs', WEB), 'utf8');
  const line = name => new RegExp(`${name} = '([^']+)'`).exec(build)[1];
  const demo = await import(`data:text/javascript,${encodeURIComponent(cfgSrc.replace(line('DEV_LINE'), line('DEMO_DEV_LINE')))}`);
  for (const href of ['https://r0ze998.github.io/wylls/frontier/index.html?localPlay=1', 'https://r0ze998.github.io/wylls/?localPlay=1&lang=ja', 'http://r0ze998.github.io/wylls/?localPlay=1']) {
    const loc = new URL(href), cfg = demo.config(loc, null);
    assert.equal(cfg.dev, true, href);
    assert.equal(localPlayRequested(cfg, loc), false, `${href}: no local play, so no launcher and no demo-fort asks`);
  }
  const loop = new URL('http://127.0.0.1:41610/frontier/?localPlay=1');
  assert.equal(localPlayRequested(demo.config(loop, null), loop), true, 'a loopback launcher page still enters local play');
  assert.equal(localPlayRequested(demo.config(new URL('http://127.0.0.1:41610/frontier/'), null), new URL('http://127.0.0.1:41610/frontier/')), false, 'and only when asked');
  // the asks start in one place only: a launcher world that stated a demo clock (flocalplay.mjs), and the fog reads the fort only from fdemofort
  const web = f => readFileSync(new URL(`frontier/${f}`, WEB), 'utf8');
  const callers = ['flocalplay.mjs', 'controller.mjs', 'app.mjs', 'map/fog.mjs'].filter(f => /startDemoFortAsks\(/.test(web(f)));
  assert.deepEqual(callers, ['flocalplay.mjs']);
  assert.equal(web('flocalplay.mjs').split('startDemoFortAsks(').length, 2, 'one call');
  assert.match(web('flocalplay.mjs'), /if \(launcher && claimedDemo !== null\) \{ const asked = handle\.address; startDemoFortAsks\(/);
  assert.doesNotMatch(readFileSync(new URL('../demo/src/boot.mjs', HERE), 'utf8'), /local-play|demoFort/i, 'the Pages demo world answers no launcher route');
});
