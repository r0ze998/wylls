// Read-only economy history: unchanged real host-dispatch export bytes,
// plus explicitly synthetic wire mutations. None proves authentication,
// replay, source coverage, ownership or live-chain execution. No fixture
// generation, keys, signing, network, transactions or external processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode as toB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf, ringPosition, WORLD_DOMAIN } from '../../permutation-server/web/frontier/map/wide.mjs';
import { parseWideIndexPage } from '../../permutation-server/web/frontier/map/widehistory.mjs';
import { wideActionReview } from '../../permutation-server/web/frontier/map/wideactions.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { mountWideMode } from '../../permutation-server/web/frontier/map/widemode.mjs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';

// Public-address arithmetic only, matching the fixed PROGRAM and SEASON_ID
// in permutation-frontier/src/map_growth_runtime_tests.rs. No keypair.
const PROGRAM = toB58(new Uint8Array(32).fill(0x12));
const SEASON_ADDR = seasonPda(PROGRAM, 11n)[0];
const WORLD = worldIdOf(SEASON_ADDR, PROGRAM);
const PINS = { programId: PROGRAM, seasonAddress: SEASON_ADDR, seasonId: '11' };
const STAMP = 'ab'.repeat(32);
const CASES = ['harvest', 'building', 'wall', 'tier', 'train'];
const FIXTURES = Object.fromEntries(CASES.map(name => [name, readFileSync(new URL(
  `../../frontier-node/crates/verify/tests/fixtures/wide_economy/${name}/record.bin`, import.meta.url,
))]));
const OPTIONS = { pins: PINS, through: 1n, snapshot: STAMP };
const scope = () => ({ v: 1, experimental: true, readOnly: true, program: PROGRAM, season: '11', seasonAddress: SEASON_ADDR,
  world: WORLD, sourceCoverage: 'unknown', captureVerification: 'unverified', indexedThrough: '1', snapshot: STAMP });

// The exporter founds site 0, generation 1 at (129, 0). Envelope metadata
// is assembled from the immutable wire key, as herald's wide_read does.
function row(body = FIXTURES.harvest, p = '129', q = '0') {
  body = Buffer.from(body);
  const province = { world: body.subarray(7, 39).toString('hex'), p, q, keyHex: body.subarray(6, 56).toString('hex') };
  return { event: '1', archiveSequence: '1', ordinal: '0', format: 'PSW1', kind: body[1],
    name: body[1] === 16 ? 'WIDE_ECONOMY_MIRROR' : 'WIDE_ECONOMY', body_b64: body.toString('base64'), province,
    holding: { ...province, keyHex: body.subarray(6, 62).toString('hex'), site: body[56], generation: body[57], hostSequence: body.readUInt32LE(58) }, host: null };
}
const page = (events = [row()], extra = {}) => ({ ...scope(), after: '0', next: String(events.length), more: false, limit: 20, events, ...extra });
const parse = (r = row()) => parseWideIndexPage(page([r]), OPTIONS).rows[0];
const refused = (f, code = 'BadWideHistory') => assert.throws(f, e => e?.code === code);
const mutateBody = (name, edit, p = '129', q = '0') => {
  const body = Buffer.from(FIXTURES[name]); edit(body); return row(body, p, q);
};
function atCoordinate(name, p, q) {
  return mutateBody(name, b => {
    const rp = ringPosition(BigInt(p), BigInt(q));
    b.writeBigUInt64BE(rp.ring, 39); b[47] = rp.wedge; b.writeBigUInt64BE(rp.pos, 48);
  }, String(p), String(q));
}

test('all five unchanged host-dispatch exports read as holding-only observations', () => {
  const expected = [{ kind: 'harvest' }, { kind: 'build', item: 0 }, { kind: 'build', item: 6 }, { kind: 'build', item: 7 }, { kind: 'train', unit: 0, n: 10 }];
  for (const [i, name] of CASES.entries()) {
    const r = parse(row(FIXTURES[name]));
    assert.equal(r.province.world, WORLD);
    assert.equal(r.province.p, 129n); assert.equal(r.province.q, 0n);
    assert.equal(r.holding.site, 0); assert.equal(r.holding.generation, 1); assert.equal(r.holding.hostSequence, 0);
    assert.equal(r.host, null);
    assert.deepEqual(r.economy.action, expected[i]);
    assert.equal(r.economy.nowTs, FIXTURES[name].readBigInt64LE(69));
    assert.equal(r.economy.becameFinal, false);
    assert.equal(r.economy.inputDigest, FIXTURES[name].subarray(78, 110).toString('hex'));
    assert.equal(r.economy.outputDigest, FIXTURES[name].subarray(110, 142).toString('hex'));
    assert.deepEqual(r.economy.links.map(l => l.entity), r.kind === 16 ? [1, 2] : [2]);
    assert.deepEqual(Buffer.from(r.body), FIXTURES[name], 'the served body is retained byte for byte');
    refused(() => wideActionReview({ pins: PINS, page: parseWideIndexPage(page([row(FIXTURES[name])]), OPTIONS), event: 1n }), 'WideHostObservationRequired');
  }
});

test('synthetic extreme coordinates, receipt times, counts and link sequences stay exact', () => {
  for (const [p, q] of [[9007199254740993n, 0n], [0n, -(1n << 62n)], [1n << 62n, 1n << 62n]]) {
    const wire = atCoordinate('train', p, q), body = Buffer.from(wire.body_b64, 'base64');
    body.writeUInt32LE(0xffffffff, 65); body.writeBigInt64LE(-(1n << 63n), 69); body[77] = 1;
    body.writeBigUInt64LE(0xffffffffffffffffn, 144);
    const r = parse(row(body, String(p), String(q)));
    assert.equal(r.province.p, p); assert.equal(r.province.q, q); assert.equal(r.holding.p, p);
    assert.equal(r.economy.action.n, 0xffffffff); assert.equal(r.economy.nowTs, -(1n << 63n));
    assert.equal(r.economy.links[0].sequence, 0xffffffffffffffffn); assert.equal(r.economy.becameFinal, true);
  }
  assert.equal(parse(mutateBody('harvest', b => b.writeBigInt64LE((1n << 63n) - 1n, 69))).economy.nowTs, (1n << 63n) - 1n);
  // The changed payloads and keys above deliberately do not recompute any
  // digest/head: this parser checks format and never claims replay validity.
});

test('canonical action ranges and mirror-kind distinction match the ABI', () => {
  for (let item = 0; item <= 8; item++) {
    const mirror = item === 6 || item === 7;
    const r = parse(mutateBody(mirror ? 'wall' : 'building', b => { b[64] = item; }));
    assert.equal(r.kind, mirror ? 16 : 15); assert.deepEqual(r.economy.action, { kind: 'build', item });
  }
  for (let unit = 0; unit < 7; unit++) {
    assert.deepEqual(parse(mutateBody('train', b => { b[64] = unit; })).economy.action, { kind: 'train', unit, n: 10 });
  }
  for (const [name, edit] of [
    ['harvest', b => { b[62] = 2; }], ['harvest', b => { b[63] = 3; }],
    ['harvest', b => { b[64] = 1; }], ['harvest', b => { b[65] = 1; }],
    ['building', b => { b[64] = 9; }], ['building', b => { b[65] = 1; }],
    ['building', b => { b[64] = 6; }], ['building', b => { b[64] = 7; }],
    ['wall', b => { b[64] = 0; }], ['tier', b => { b[64] = 8; }],
    ['train', b => { b[64] = 7; }], ['train', b => b.writeUInt32LE(0, 65)],
    ['harvest', b => { b[77] = 2; }],
  ]) refused(() => parse(mutateBody(name, edit)));
});

test('holding attribution refuses phantom hosts, legacy keys and summary/raw mismatches', () => {
  for (const edit of [
    r => { r.holding = null; }, r => { r.host = { ...r.holding }; }, r => { delete r.host; },
    r => { r.holding.site = 1; }, r => { r.holding.generation = 2; }, r => { r.holding.hostSequence = 1; },
    r => { r.province.p = '130'; }, r => { r.holding.p = '130'; },
    r => { r.holding.keyHex = r.holding.keyHex.slice(0, 102) + '02' + r.holding.keyHex.slice(104); r.holding.generation = 2; },
    r => { r.province.world = '11'.repeat(32); },
  ]) { const r = row(); edit(r); refused(() => parse(r)); }
  for (const edit of [b => { b[56] = 12; }, b => { b[57] = 0; }, b => { b[57] = 255; }, b => b.writeUInt32LE(1, 58)]) {
    refused(() => parse(mutateBody('harvest', edit)));
  }
  refused(() => parse(atCoordinate('harvest', 128n, 0n)));
  refused(() => parse(atCoordinate('harvest', 0n, 0n)));
  const mismatch = atCoordinate('harvest', 9007199254740993n, 0n);
  mismatch.province.p = '9007199254740992'; refused(() => parse(mismatch));
});

test('exact record width, link count, ordered entity set and known versions are required', () => {
  for (const name of CASES) {
    const b = FIXTURES[name];
    for (let n = 0; n < b.length; n++) {
      const r = row(b); r.body_b64 = b.subarray(0, n).toString('base64'); refused(() => parse(r));
    }
    const extra = row(b); extra.body_b64 = Buffer.concat([b, Buffer.from([0])]).toString('base64'); refused(() => parse(extra));
    for (const edit of [b => { b[0] = 0x81; }, b => { b[0] = 0x83; }, b => { b[1] = 17; }, b => { b[142] = 0; }, b => { b[143] = 3; }]) {
      refused(() => parse(mutateBody(name, edit)));
    }
  }
  refused(() => parse(mutateBody('harvest', b => { b[143] = 1; })));
  refused(() => parse(mutateBody('wall', b => { b[143] = 2; b[184] = 1; })));
  refused(() => parse(mutateBody('wall', b => { b[184] = 1; })));
  const wrongName = row(); wrongName.name = 'WIDE_MUSTER'; refused(() => parse(wrongName));
});

test('history keeps scope, snapshot, pagination and trust refusals with economy records', () => {
  const events = CASES.map((name, i) => ({ ...row(FIXTURES[name]), event: String(i + 1), ordinal: String(i) }));
  const parsed = parseWideIndexPage(page(events), OPTIONS);
  assert.equal(parsed.rows.length, 5); assert.equal(parsed.next, 5n);
  assert.equal(parsed.sourceCoverage, 'unknown'); assert.equal(parsed.captureVerification, 'unverified');
  const first = parseWideIndexPage(page(events.slice(0, 2), { limit: 2, more: true }), { ...OPTIONS, limit: 2 });
  assert.equal(first.next, 2n); assert.equal(first.more, true);
  const last = parseWideIndexPage(page(events.slice(2), { after: '2', next: '5', limit: 3 }), { ...OPTIONS, after: 2n, limit: 3 });
  assert.equal(last.next, 5n);
  for (const edit of [
    p => { p.events[0].event = '2'; }, p => { p.events[0].archiveSequence = '2'; },
    p => { p.next = '0'; }, p => { p.more = true; }, p => { p.sourceCoverage = 'complete'; },
    p => { p.captureVerification = 'verified'; }, p => { p.events[0].body_b64 += '='; },
  ]) { const p = page(); edit(p); refused(() => parseWideIndexPage(p, OPTIONS)); }
  refused(() => parseWideIndexPage(page(), { ...OPTIONS, through: 2n }), 'WideIndexChanged');
  refused(() => parseWideIndexPage(page(), { ...OPTIONS, snapshot: 'cd'.repeat(32) }), 'WideIndexChanged');
  refused(() => parseWideIndexPage(page(), { ...OPTIONS, pins: { ...PINS, seasonId: '12' } }), 'WrongSeason');
});

// Minimal DOM contract harness, not browser/visual acceptance. All reads
// go through the real herald client with an injected fake fetch.
class Element {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.dataset = {}; this.children = []; this.events = {}; this.attrs = {}; this.clientWidth = 640; this.clientHeight = 400; }
  set innerHTML(text) { this.ids = new Map([...text.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element(this.ownerDocument, 'div')])); }
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return [this.text ?? '', ...this.children.map(x => x.textContent)].join(' '); }
  querySelector(s) { return this.ids?.get(s.replace(/^#/, '')) ?? null; }
  append(...nodes) { this.children.push(...nodes); for (const n of nodes) n.parentElement = this; }
  after(node) { this.parentElement?.append(node); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, f) { (this.events[k] ??= []).push(f); }
  fire(k, e = {}) { for (const f of this.events[k] ?? []) f(e); }
  focus() {} remove() {} getContext() { return null; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const doc = { createElement: tag => new Element(doc, tag) };
  const parent = doc.createElement('div'), canvas = doc.createElement('canvas'); parent.append(canvas);
  const record = { season: '11', seasonAddress: SEASON_ADDR, programId: PROGRAM, cluster: 'localnet' };
  let history = page(CASES.map((name, i) => ({ ...row(FIXTURES[name]), event: String(i + 1), ordinal: String(i) })));
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ path: new URL(url).pathname, method: init?.method ?? 'GET' });
    const path = new URL(url).pathname;
    const json = path === '/h/world/wide' ? { v: 1, experimental: true, readOnly: true, completeness: 'captured', world: WORLD,
      worldDomain: WORLD_DOMAIN, season: '11', program: PROGRAM, seasonAddress: SEASON_ADDR,
      snapshot: { epoch: '0', stamp: STAMP }, recorded: 0, refused: 0 }
      : path === '/h/world/wide/page' ? { v: 1, world: WORLD, snapshot: { epoch: '0', stamp: STAMP }, after: null, entries: [], next: null }
      : path === '/h/wide-index/status' ? { ...scope(), state: 'observed', caughtUp: true, automaticWrites: false }
      : path === '/h/wide-index/events' ? history : null;
    assert.ok(json, `unexpected request ${path}`);
    return { ok: true, status: 200, json: async () => json };
  };
  const mode = mountWideMode({ herald: createHerald({ base: 'http://history.invalid', fetch }), canvas, doc, recordOf: () => record });
  return { mode, requests, setHistory: p => { history = p; }, record };
}

test('original recorded-history UI renders economy detail in both languages without host or send controls', async () => {
  const oldLang = lang(), h = harness(), { mode } = h;
  try {
    setLang('en'); mode.open(); await flush();
    assert.equal(mode.state().history.phase, 'ready');
    const list = mode.elements().sheet.querySelector('#wide-history-list');
    assert.equal(list.children.length, 5);
    for (const [i, expected] of ['Harvest', 'Building Farm', 'Building Walls', 'Building Village upgrade', 'Train 10 Spearmen'].entries()) {
      const r = list.children[i]; assert.match(r.textContent, new RegExp(expected));
      assert.match(r.textContent, /Site 0 · generation 1/); assert.match(r.textContent, /Unverified/i);
      assert.equal(r.children.length, 1); assert.equal(r.children[0].tagName, 'p');
    }
    assert.equal(mode.elements().sheet.querySelector('#wide-action-review').children.length, 0);
    assert.equal(mode.state().walk.entries.size, 0, 'observed economy never creates land');
    setLang('ja'); assert.match(list.children[0].textContent, /収穫/); assert.match(list.children[4].textContent, /訓練.*槍兵 10/);
    const far = atCoordinate('train', 9007199254740993n, 0n);
    h.setHistory(page([far])); mode.close(); mode.open(); await flush();
    assert.match(list.children[0].textContent, /9007199254740993/);
    assert.equal(mode.state().walk.entries.size, 0);
    assert.ok(h.requests.every(r => r.method === 'GET'));
    assert.deepEqual([...new Set(h.requests.map(r => r.path))].sort(), ['/h/wide-index/events', '/h/wide-index/status', '/h/world/wide', '/h/world/wide/page']);
  } finally { mode.unmount(); setLang(oldLang); }
});

test('all S1 build and train display names retain their ABI item ids and exact u32 count', async () => {
  const oldLang = lang(), { mode, setHistory } = harness();
  const events = Array.from({ length: 9 }, (_, item) => mutateBody(item === 6 || item === 7 ? 'wall' : 'building', b => { b[64] = item; }));
  for (let unit = 0; unit < 7; unit++) events.push(mutateBody('train', b => { b[64] = unit; b.writeUInt32LE(0xffffffff, 65); }));
  setHistory(page(events.map((r, i) => ({ ...r, event: String(i + 1), ordinal: String(i) }))));
  try {
    setLang('en'); mode.open(); await flush();
    const rows = mode.elements().sheet.querySelector('#wide-history-list').children;
    assert.equal(rows.length, 16);
    const builds = ['Farm', 'Lumber camp', 'Quarry', 'Mine', 'Mint', 'Library', 'Walls', 'Village upgrade', 'Workshop'];
    builds.forEach((name, i) => assert.match(rows[i].textContent, new RegExp(`Building ${name}`)));
    const units = ['Spearmen', 'Archers', 'Horsemen', 'Pikemen', 'Crossbowmen', 'Knights', 'Scouts'];
    units.forEach((name, i) => assert.match(rows[9 + i].textContent, new RegExp(`Train 4,294,967,295 ${name}`)));
    assert.ok(rows.every(r => r.children.every(child => child.tagName === 'p')));
    assert.equal(mode.state().walk.entries.size, 0);
  } finally { mode.unmount(); setLang(oldLang); }
});

test('a malformed economy history clears old rows and recovers only after a valid read', async () => {
  const { mode, setHistory, record } = harness();
  try {
    mode.open(); await flush();
    const list = mode.elements().sheet.querySelector('#wide-history-list');
    assert.equal(list.children.length, 5);
    setHistory(page([mutateBody('train', b => { b[64] = 7; })]));
    mode.close(); mode.open(); await flush();
    assert.equal(mode.state().history.phase, 'error'); assert.equal(mode.state().history.code, 'BadWideHistory'); assert.equal(list.children.length, 0);
    assert.match(mode.elements().sheet.querySelector('#wide-history-status').textContent, /BadWideHistory/);
    setHistory(page([row(FIXTURES.train)])); mode.close(); mode.open(); await flush();
    assert.equal(mode.state().history.phase, 'ready'); assert.equal(list.children.length, 1);
    record.programId = 'invalid'; await mode.poll(); assert.equal(list.children.length, 0);
  } finally { mode.unmount(); }
});
