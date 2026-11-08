// Key-free tests of the browser client logic against the real controller with a FAKE host bridge and a fake fetch.
// No server, socket, child process or DOM is used. Covers repeated / refused / stale / reset requests, fail-closed recovery,
// token discard and uncertainty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, ROUTES, ACTION_HEADER, bodyFor } from '../screens/wide-economy-local/local-client.mjs';
import { createController } from '../screens/wide-economy-local/local-server.mjs';
import { createFakeBridge } from '../screens/wide-economy-local/fake-host.mjs';
import * as M from '../screens/wide-economy-local/local-model.mjs';
import { FIXTURE_DIR } from '../screens/wide-economy-fixture/model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const rd = async (c, f) => Uint8Array.from(await readFile(join(ROOT, ...FIXTURE_DIR.split('/'), c, f)));
const pre = { season: await rd('harvest', 'season.bin'), citizen: await rd('harvest', 'citizen_pre.bin'), holding: await rd('harvest', 'holding_pre.bin'), province: await rd('harvest', 'province_pre.bin') };
const post = { season: pre.season, citizen: await rd('harvest', 'citizen_post.bin'), holding: await rd('harvest', 'holding_post.bin'), province: await rd('harvest', 'province_post.bin') };
const record = await rd('harvest', 'record.bin');
const initial = M.loadInitial(pre);

async function world() {
  const bridge = createFakeBridge({ pre, post, record });
  const controller = createController({ bridge, initial });
  const started = await controller.start();
  assert.equal(started.status, 200);
  const log = [];
  const switches = { fail: false };
  const fetchFn = async (url, init) => {
    log.push({ url, init });
    if (switches.fail) throw new TypeError('Failed to fetch');
    let r;
    if (url === ROUTES.state) r = controller.state();
    else {
      const route = url.slice('/api/'.length);
      r = await controller.mutate(M.commandFromBody(route, JSON.parse(init.body)));
    }
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  const client = () => createClient({ fetchFn, initial });
  return { bridge, controller, log, switches, client, fetchFn };
}
const acts = bridge => bridge.calls.filter(l => l !== 'get');

test('refresh shows the validated initial state through the production parser', async () => {
  const w = await world();
  const c = w.client();
  assert.equal(c.snapshot.phase, 'init');
  const r = await c.refresh();
  assert.equal(r.ok, true);
  const s = c.snapshot;
  assert.equal(s.phase, 'ready');
  assert.equal(s.busy, false);
  assert.equal(s.state.revision, 0);
  assert.equal(s.state.now, M.INITIAL_NOW);
  assert.deepEqual(s.state.FS.holdings, []);
  assert.equal(s.state.FS.readOnly, true);
  assert.equal(w.log.length, 1);
  assert.equal(w.log[0].init.method, 'GET');
  assert.equal(w.log[0].url, '/api/state');
});

test('requests are fixed routes with the fixed header, same-origin credentials and a canonical body', async () => {
  const w = await world();
  const c = w.client();
  await c.refresh();
  await c.submit({ kind: 'harvest' });
  await c.submit({ kind: 'build', item: 3 });
  await c.submit({ kind: 'train', unit: 2, count: 5 });
  await c.submit({ kind: 'advance', seconds: 600 });
  await c.submit({ kind: 'reset' });
  const posts = w.log.filter(l => l.init.method === 'POST');
  assert.deepEqual(posts.map(p => p.url), ['/api/action', '/api/action', '/api/action', '/api/advance', '/api/reset']);
  for (const p of posts) {
    assert.deepEqual(p.init.headers, { 'Content-Type': 'application/json', [ACTION_HEADER]: M.PROTOCOL });
    assert.equal(p.init.credentials, 'same-origin');
    assert.equal(p.init.redirect, 'error');
    assert.equal(p.init.cache, 'no-store');
    assert.equal(p.init.referrerPolicy, 'no-referrer');
    assert.equal(JSON.stringify(JSON.parse(p.init.body)), p.init.body, 'canonical JSON');
  }
  assert.deepEqual(posts.map(p => JSON.parse(p.init.body).expectedRevision), [0, 1, 2, 3, 4]);
  assert.deepEqual(JSON.parse(posts[0].init.body), { expectedRevision: 0, action: 'harvest' });
  assert.deepEqual(acts(w.bridge), ['act 0 harvest', 'act 1 build 3', 'act 2 train 2 5', 'advance 3 600', 'reset 4']);
  assert.throws(() => bodyFor({ kind: 'transfer' }, 0), M.LocalModelError);
});

test('repeated clicks: a second submit while one is in flight is refused locally and never reaches the host', async () => {
  const w = await world();
  const c = w.client();
  await c.refresh();
  const release = w.bridge.hold();
  const first = c.submit({ kind: 'harvest' });
  assert.equal(c.snapshot.busy, true);
  assert.deepEqual(await c.submit({ kind: 'harvest' }), { ok: false, reason: 'busy' });
  assert.deepEqual(await c.submit({ kind: 'reset' }), { ok: false, reason: 'busy' });
  assert.deepEqual(await c.refresh(), { ok: false, reason: 'busy' }, 'no refresh over a mutation in flight');
  release();
  assert.deepEqual(await first, { ok: true, reason: 'ok' });
  assert.equal(c.snapshot.busy, false);
  assert.deepEqual(acts(w.bridge), ['act 0 harvest']);
  assert.equal(c.snapshot.state.revision, 1);
  assert.equal(c.snapshot.lastResult.outcome, 'ok');
  assert.equal(c.snapshot.state.record.receipt.action.kind, 'Harvest');
});

test('a host refusal changes nothing and is shown as a refusal', async () => {
  const w = await world();
  const c = w.client();
  await c.refresh();
  const before = c.snapshot.state;
  const r = await c.submit({ kind: 'build', item: 8 });
  assert.deepEqual(r, { ok: false, reason: 'refused' });
  const s = c.snapshot;
  assert.equal(s.phase, 'ready');
  assert.equal(s.notice.kind, 'refused');
  assert.equal(s.notice.code, 'RefusedByHost');
  assert.equal(s.state.revision, before.revision);
  assert.equal(s.state.hex.holding, before.hex.holding);
  assert.equal(s.lastResult.outcome, 'refused');
  // still playable afterwards
  assert.equal((await c.submit({ kind: 'harvest' })).ok, true);
});

test('stale: a second player on the same server is told, adopts the newer state, and its action is not run', async () => {
  const w = await world();
  const a = w.client(), b = w.client();
  await a.refresh(); await b.refresh();
  assert.equal((await a.submit({ kind: 'harvest' })).ok, true);
  const r = await b.submit({ kind: 'harvest' });   // b still believes revision 0
  assert.deepEqual(r, { ok: false, reason: 'stale' });
  assert.equal(b.snapshot.notice.kind, 'stale');
  assert.equal(b.snapshot.state.revision, 1);
  assert.deepEqual(acts(w.bridge), ['act 0 harvest'], 'the stale request never reached the host');
  assert.equal((await b.submit({ kind: 'advance', seconds: 3600 })).ok, true);
});

test('reset bumps the revision (no reuse) and invalidates every outstanding view', async () => {
  const w = await world();
  const a = w.client(), b = w.client();
  await a.refresh(); await b.refresh();
  await a.submit({ kind: 'harvest' });
  await a.submit({ kind: 'advance', seconds: 86400 });
  assert.equal(a.snapshot.state.revision, 2);
  assert.equal((await a.submit({ kind: 'reset' })).ok, true);
  assert.equal(a.snapshot.state.revision, 3, 'revision still increments');
  assert.equal(a.snapshot.state.now, M.INITIAL_NOW);
  assert.equal(a.snapshot.state.hex.holding, initial.hex.holding);
  assert.equal(a.snapshot.state.record, null);
  // b held revision 0 from before: stale, and (even if it equalled an old number) never accepted
  assert.deepEqual(await b.submit({ kind: 'harvest' }), { ok: false, reason: 'stale' });
  assert.equal(b.snapshot.state.revision, 3);
  assert.deepEqual(acts(w.bridge), ['act 0 harvest', 'advance 1 86400', 'reset 2']);
});

test('invalid input never leaves the page', async () => {
  const w = await world();
  const c = w.client();
  await c.refresh();
  const n = w.log.length;
  for (const intent of [{ kind: 'train', unit: 0, count: 0 }, { kind: 'train', unit: 0, count: NaN }, { kind: 'train', unit: 7, count: 1 }, { kind: 'build', item: 9 },
    { kind: 'advance', seconds: 601 }, { kind: 'advance' }]) {
    assert.deepEqual(await c.submit(intent), { ok: false, reason: 'input' }, JSON.stringify(intent));
    assert.equal(c.snapshot.notice.kind, 'input');
  }
  assert.equal(await c.submit({ kind: 'transfer' }).then(r => r.reason), 'input');
  assert.equal(w.log.length, n);
  assert.equal(c.snapshot.busy, false);
});

test('a failed fetch clears the shown state, is never retried, and only an explicit GET refresh recovers', async () => {
  const w = await world();
  const c = w.client();
  await c.refresh();
  await c.submit({ kind: 'harvest' });
  assert.ok(c.snapshot.state);
  w.switches.fail = true;
  const posts = () => w.log.filter(l => l.init.method === 'POST').length;
  const before = posts();
  const r = await c.submit({ kind: 'advance', seconds: 600 });
  assert.deepEqual(r, { ok: false, reason: 'unknown' });
  assert.equal(posts(), before + 1, 'one attempt only');
  const s = c.snapshot;
  assert.equal(s.phase, 'error');
  assert.equal(s.state, null, 'the stale card is gone');
  assert.equal(s.parsed, null);
  assert.equal(s.busy, false);
  assert.equal(s.error.what, 'submit');
  // nothing can be submitted from the error phase
  assert.deepEqual(await c.submit({ kind: 'harvest' }), { ok: false, reason: 'no-state' });
  assert.equal(posts(), before + 1);
  // a failing refresh stays cleared
  assert.deepEqual(await c.refresh(), { ok: false, reason: 'error' });
  assert.equal(c.snapshot.state, null);
  // recovery: GET only, shows the host's truth (here: only the first harvest happened; the failed advance never left the page)
  w.switches.fail = false;
  assert.deepEqual(await c.refresh(), { ok: true });
  assert.equal(c.snapshot.phase, 'ready');
  assert.equal(c.snapshot.state.revision, 1);
  assert.equal(w.log.at(-1).init.method, 'GET');
  assert.equal(posts(), before + 1, 'recovery sent no POST');
});

test('a garbled or off-schema answer is also fail-closed, never retried', async () => {
  const w = await world();
  const cases = {
    notJson: async () => ({ status: 200, text: async () => 'not json' }),
    huge: async () => ({ status: 200, text: async () => ' '.repeat(200 * 1024) }),
    badView: async () => ({ status: 200, text: async () => JSON.stringify({ outcome: 'ok', view: { v: 1 } }) }),
    wrongProtocol: async () => ({ status: 200, text: async () => JSON.stringify({ outcome: 'ok', view: { v: 1, protocol: 'x', mode: 'local-simulation', mockAuth: true } }) }),
    status500: async () => ({ status: 500, text: async () => '{}' }),
    status302: async () => ({ status: 302, text: async () => '' }),
  };
  for (const [name, bad] of Object.entries(cases)) {
    let n = 0, mode = 'good';
    const fetchFn = async (url, init) => { if (mode === 'good' || init.method === 'GET') return w.fetchFn(url, init); n++; return bad(); };
    const c = createClient({ fetchFn, initial });
    await c.refresh();
    mode = 'bad';
    const r = await c.submit({ kind: 'advance', seconds: 600 });
    assert.equal(r.ok, false, name);
    assert.equal(c.snapshot.state, null, name);
    assert.equal(c.snapshot.phase, 'error', name);
    assert.equal(n, 1, `${name}: not retried`);
  }
  assert.deepEqual(acts(w.bridge), [], 'none of those reached the host');
});

test('a lying server cannot show a state that disagrees with the transition it claims', async () => {
  const w = await world();
  const c = createClient({
    initial,
    fetchFn: async (url, init) => {
      const res = await w.fetchFn(url, init);
      if (init.method !== 'POST') return res;
      const body = JSON.parse(await res.text());
      body.outcome = 'refused';                       // the state moved on, but the answer says "refused"
      return { status: res.status, text: async () => JSON.stringify(body) };
    },
  });
  await c.refresh();
  const r = await c.submit({ kind: 'harvest' });
  assert.equal(r.ok, false);
  assert.equal(c.snapshot.phase, 'error');
  assert.equal(c.snapshot.state, null);
  assert.equal(c.snapshot.error.code, 'BadResponse');
});

test('token discard: an older reply that arrives late is never painted', async () => {
  const w = await world();
  await w.controller.mutate({ kind: 'harvest', rev: 0 });
  const view1 = w.controller.state().body.view;     // revision 1
  const view0 = JSON.parse(JSON.stringify(view1));  // a deliberately OLDER, still valid view (the initial state)
  view0.revision = 0;
  view0.reply = {
    protocol: M.PROTOCOL, mode: M.MODE, auth: M.AUTH, command: 'get', action: null, status: 'ok', revision: 0, now: M.INITIAL_NOW, code: null,
    seasonHex: initial.hex.season, citizenHex: initial.hex.citizen, holdingHex: initial.hex.holding, provinceHex: initial.hex.province, recordHex: null,
  };
  view0.lastResult = null;
  const pending = [];
  const fetchFn = () => new Promise(res => pending.push(res));
  const c = createClient({ fetchFn, initial });
  const p1 = c.refresh();    // token 1
  const p2 = c.refresh();    // token 2 supersedes it
  assert.equal(pending.length, 2);
  const answer = v => ({ status: 200, text: async () => JSON.stringify({ view: v }) });
  pending[1](answer(view1));
  assert.deepEqual(await p2, { ok: true });
  pending[0](answer(view0));                    // late and older
  assert.deepEqual(await p1, { ok: false, reason: 'discarded' });
  assert.equal(c.snapshot.state.revision, 1, 'the newer reply stays');
  assert.equal(c.snapshot.phase, 'ready');
});

test('uncertainty: a host failure stops all mutations; the view is cleared; nothing is retried or restarted', async () => {
  const kinds = {
    garbage: () => 'this is not json',
    timeout: () => Object.assign(new Error('timeout'), { code: 'Timeout' }),
    fault: o => ({ ...o, status: 'fault', code: 'HostFault' }),
    badRevision: o => ({ ...o, revision: o.revision + 5 }),
    driftedHolding: o => ({ ...o, holdingHex: '00'.repeat(1344) }),
    wrongProtocol: o => ({ ...o, protocol: 'wylls-local-economy-v0' }),
    extraKey: o => JSON.stringify({ ...o, bonus: 1 }),
  };
  for (const [name, hook] of Object.entries(kinds)) {
    const w = await world();
    const c = w.client();
    await c.refresh();
    w.bridge.hook = hook;
    const r = await c.submit({ kind: 'harvest' });
    assert.deepEqual(r, { ok: false, reason: 'uncertain' }, name);
    const s = c.snapshot;
    assert.equal(s.phase, 'uncertain', name);
    assert.equal(s.state, null, `${name}: no stale card`);
    assert.ok(s.reason?.code, name);
    assert.equal(w.bridge.closed, true, `${name}: host closed`);
    const callsAfter = w.bridge.calls.length;
    // every further mutation is refused (client and server) and the host is not contacted again
    assert.deepEqual(await c.submit({ kind: 'harvest' }), { ok: false, reason: 'no-state' }, name);
    assert.equal((await w.controller.mutate({ kind: 'harvest', rev: 0 })).status, 503, name);
    assert.equal((await w.controller.mutate({ kind: 'reset', rev: 0 })).status, 503, name);
    // an explicit refresh reports uncertainty and still contacts no host
    assert.deepEqual(await c.refresh(), { ok: false, reason: 'uncertain' }, name);
    assert.equal(c.snapshot.phase, 'uncertain');
    assert.equal(w.bridge.calls.length, callsAfter, `${name}: no host traffic after the failure`);
    assert.equal(w.controller.view().reply, null);
    assert.equal(w.controller.view().revision, null);
  }
});

test('a refused or advanced reply that secretly changes the state is uncertain, not shown', async () => {
  let w = await world();
  let c = w.client();
  await c.refresh();
  w.bridge.hook = (o, line) => (line.startsWith('advance') ? { ...o, citizenHex: o.citizenHex.slice(0, -2) + (o.citizenHex.endsWith('ff') ? '00' : 'ff') } : o);
  assert.deepEqual(await c.submit({ kind: 'advance', seconds: 600 }), { ok: false, reason: 'uncertain' });
  assert.equal(c.snapshot.state, null);

  w = await world();
  c = w.client();
  await c.refresh();
  w.bridge.hook = o => ({ ...o, status: 'refused', code: 'Sneaky', now: String(BigInt(o.now) + 1n) });
  assert.deepEqual(await c.submit({ kind: 'harvest' }), { ok: false, reason: 'uncertain' });
});

test('client source: no DOM, no storage, no retry loop', async () => {
  const src = (await readFile(join(HERE, '..', 'screens', 'wide-economy-local', 'local-client.mjs'), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  for (const bad of ['document', 'window', 'localStorage', 'sessionStorage', 'setInterval', 'while (', 'for (;;', 'retry(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'innerHTML', 'location']) {
    assert.ok(!src.includes(bad), `local-client.mjs mentions ${bad}`);
  }
  assert.deepEqual([...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]), ['./local-model.mjs']);
});

test('hung fetch or body times out, clears state and never retries a mutation', async () => {
  for (const hangBody of [false, true]) {
    const w = await world(); let hang = false, calls = 0;
    const c = createClient({ initial, timeoutMs: 15, fetchFn: (url, opts) => {
      calls++; if (!hang) return w.fetchFn(url, opts);
      return hangBody ? Promise.resolve({ status: 200, text: () => new Promise(() => {}) }) : new Promise(() => {});
    } });
    await c.refresh(); hang = true;
    assert.equal((await c.submit({ kind: 'harvest' })).reason, 'unknown');
    assert.equal(c.snapshot.busy, false); assert.equal(c.snapshot.state, null);
    assert.equal(c.snapshot.error.code, 'Timeout'); assert.equal(calls, 2);
    hang = false; assert.equal((await c.refresh()).ok, true); assert.equal(calls, 3);
  }
});
