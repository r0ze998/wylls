// Fixed public addresses and an in-memory DOM only. No app boot, network,
// wallets, key generation, private derivation, signing, or transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountWideMode } from '../../permutation-server/web/frontier/map/widemode.mjs';
import { worldIdOf, parseWideManifest, WORLD_DOMAIN } from '../../permutation-server/web/frontier/map/wide.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

// Adapted from web-frontier-wide-world.test.mjs without importing/running its tests.
class Element {
  constructor(doc) { this.ownerDocument = doc; this.dataset = {}; this.children = []; this.events = {}; }
  set innerHTML(s) { this.ids = new Map([...s.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element(this.ownerDocument)])); }
  set textContent(s) { this.text = s; this.children = []; }
  get textContent() { return this.text ?? ''; }
  querySelector(s) { return this.ids?.get(s.replace(/^#/, '')) ?? null; }
  append(...nodes) { this.children.push(...nodes); for (const n of nodes) n.parentElement = this; }
  after(n) { this.parentElement?.append(n); }
  setAttribute() {} focus() {} remove() {} getContext() { return null; }
  addEventListener(k, f) { (this.events[k] ??= []).push(f); }
  fire(k) { for (const f of this.events[k] ?? []) f({}); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const programId = encode(new Uint8Array(32).fill(94));
const seasonAddress = encode(new Uint8Array(32).fill(3));
const world = worldIdOf(seasonAddress, programId);
const record = { season: '5', seasonAddress, programId, cluster: 'localnet' };
const snapshot = { epoch: '4', stamp: 'ab'.repeat(32), lastSlot: '100', foldedThrough: '12' };
const manifest = parseWideManifest({ v: 1, experimental: true, readOnly: true, completeness: 'captured', world, worldDomain: WORLD_DOMAIN,
  season: '5', program: programId, seasonAddress, snapshot, recorded: 0, refused: 0,
  legacy: { rMax: 16, rMaxHard: 128, ringsOpened: 4, provinces: 4 }, page: { path: '/h/world/wide/page', max: 256, default: 64 } });
const holding = { world, season: '5', p: 9007199254740993n, q: -1n };
function harness(over = {}, recordOf = () => record) {
  const doc = { createElement: () => new Element(doc) };
  const parent = doc.createElement(), canvas = doc.createElement(); parent.append(canvas);
  const herald = { wideWorld: async () => ({ ok: true, manifest }), wideWorldPage: async () => ({ ok: true,
    json: { v: 1, world, snapshot, after: null, limit: 64, entries: [], next: null } }), ...over };
  return mountWideMode({ herald, canvas, doc, recordOf });
}

test('exact holding coordinate focuses unknown space without fabricating land; reload and close', async () => {
  const mode = harness();
  try {
    assert.equal(mode.focusHolding(holding), true); await flush();
    assert.equal(mode.state().phase, 'ready');
    assert.deepEqual(mode.state().origin, { p: holding.p, q: holding.q });
    assert.equal(mode.state().walk.entries.size, 0);
    assert.equal(mode.state().selected, null);
    assert.match(mode.elements().sheet.querySelector('#wide-selected').textContent, /9007199254740993/);
    mode.elements().sheet.querySelector('#wide-reload').fire('click'); await flush();
    assert.equal(mode.state().origin.p, holding.p);
    mode.close();
    assert.equal(mode.state().focus, null);
    assert.equal(mode.state().selected, null);
    assert.equal(mode.state().walk, null);
  } finally { mode.unmount(); }
});

test('new focus wins over aborted replies; closing drops pending focus', async () => {
  const pending = [];
  const mode = harness({ wideWorld: ({ signal }) => new Promise(resolve => pending.push({ resolve, signal })) });
  try {
    mode.focusHolding(holding);
    mode.focusHolding({ ...holding, p: 129n, q: 0n });
    assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve({ ok: true, manifest }); await flush();
    pending[0].resolve({ ok: true, manifest }); await flush();
    assert.equal(mode.state().origin.p, 129n);
    mode.focusHolding(holding); mode.close();
    pending[2].resolve({ ok: true, manifest }); await flush();
    assert.equal(mode.state().open, false);
    assert.equal(mode.state().focus, null);
    assert.equal(mode.state().walk, null);
  } finally { mode.unmount(); }
});

test('invalid coordinates, season, world and source erase stale selection and focus', async () => {
  let rec = record;
  const mode = harness({}, () => rec);
  try {
    for (const bad of [null, { ...holding, p: 9007199254740992 }, { ...holding, world: '00'.repeat(32) }, { ...holding, season: '6' }]) {
      mode.focusHolding(holding); await flush();
      assert.equal(mode.focusHolding(bad), false);
      assert.equal(mode.state().focus, null);
      assert.equal(mode.state().selected, null);
      assert.equal(mode.state().walk, null);
    }
    mode.focusHolding(holding); await flush(); rec = null;
    assert.equal(mode.validateFocus(), false);
    assert.equal(mode.state().focus, null);
    rec = { ...record, cluster: 'othernet' };
    mode.focusHolding(holding); await flush(); rec = record;
    assert.equal(mode.validateFocus(), false);
  } finally { mode.unmount(); }
});

test('viewer/selection changes and throwing validity callbacks refuse pending focus', async () => {
  for (const fail of [() => false, () => { throw new Error('changed'); }]) {
    let current = () => true, finish;
    const mode = harness({ wideWorld: () => new Promise(resolve => { finish = resolve; }) });
    try {
      mode.focusHolding(holding, { isCurrent: () => current() });
      current = fail; finish({ ok: true, manifest }); await flush();
      assert.equal(mode.state().phase, 'error');
      assert.equal(mode.state().focus, null);
      assert.equal(mode.state().walk, null);
    } finally { mode.unmount(); }
  }
});

test('a bounded stale snapshot retry keeps only the exact validated focus', async () => {
  let calls = 0;
  const mode = harness({ wideWorld: async () => ++calls === 1 ? { ok: false, code: 'StaleSnapshot' } : { ok: true, manifest } });
  try {
    mode.focusHolding(holding); await flush();
    assert.equal(calls, 2);
    assert.equal(mode.state().phase, 'ready');
    assert.equal(mode.state().origin.p, holding.p);
    assert.equal(mode.state().selected, null);
    assert.equal(mode.state().walk.entries.size, 0);
    mode.state().pan = { x: 50, y: -80 };
    mode.close(); assert.deepEqual(mode.state().pan, { x: 0, y: 0 });
  } finally { mode.unmount(); }
});

test('late history and manifest poll replies cannot restore a changed viewer focus', async () => {
  let current = true, finishHistory, finishPoll;
  let reads = 0;
  const mode = harness({
    wideWorld: async () => ++reads === 1 ? { ok: true, manifest } : new Promise(resolve => { finishPoll = resolve; }),
    wideIndexStatus: async () => ({ ok: true, status: { state: 'observed', through: 0n, snapshot: 'ab'.repeat(32) } }),
    wideIndexEvents: () => new Promise(resolve => { finishHistory = resolve; }),
  });
  try {
    mode.focusHolding(holding, { isCurrent: () => current }); await flush();
    assert.equal(mode.state().history.phase, 'loading');
    const polling = mode.poll();
    current = false;
    finishPoll({ ok: true, manifest }); await polling;
    finishHistory({ ok: true, page: { rows: [], more: false } }); await flush();
    assert.equal(mode.state().phase, 'error');
    assert.equal(mode.state().focus, null);
    assert.equal(mode.state().walk, null);
    assert.equal(mode.state().history.phase, 'error');
  } finally { mode.unmount(); }
});
