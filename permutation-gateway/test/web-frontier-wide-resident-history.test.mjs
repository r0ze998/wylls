// Public, deliberately synthetic wire fixtures. No outcome is asserted to
// have happened on-chain. No keys, signatures, transactions or real fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode } from '../../permutation-server/web/sdk/base58.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';
import { seedOf, withSeed } from '../../permutation-server/web/frontier/faddr.mjs';
import { captureAddress } from '../../permutation-server/web/frontier/map/widecapture.mjs';
import { worldIdOf, ringPosition, WORLD_DOMAIN } from '../../permutation-server/web/frontier/map/wide.mjs';
import { parseWideIndexPage } from '../../permutation-server/web/frontier/map/widehistory.mjs';
import { wideActionReview } from '../../permutation-server/web/frontier/map/wideactions.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { mountWideMode } from '../../permutation-server/web/frontier/map/widemode.mjs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';

const pins = { programId: encode(new Uint8Array(32).fill(23)), seasonAddress: encode(new Uint8Array(32).fill(24)), seasonId: '11' };
const world = worldIdOf(pins.seasonAddress, pins.programId), snapshot = 'ab'.repeat(32);
const options = { pins, through: 1n, snapshot };
const scope = () => ({ v: 1, experimental: true, readOnly: true, program: pins.programId, seasonAddress: pins.seasonAddress, season: pins.seasonId,
  world, snapshot, indexedThrough: '1', sourceCoverage: 'unknown', captureVerification: 'unverified' });
const page = (events, rest = {}) => ({ ...scope(), after: '0', next: String(events.length), more: false, limit: 20, events, ...rest });
const refused = f => assert.throws(f, e => e?.code === 'BadWideHistory');
function key(p, q) {
  const rp = ringPosition(BigInt(p), BigInt(q)), b = Buffer.alloc(50);
  b[0] = 1; Buffer.from(world, 'hex').copy(b, 1); b.writeBigUInt64BE(rp.ring, 33); b[41] = rp.wedge; b.writeBigUInt64BE(rp.pos, 42);
  return { world, p: String(p), q: String(q), keyHex: b.toString('hex') };
}
function fixture(action = 'dissolve', family = 'original', p = 129n, q = 0n) {
  const home = key(128n, 0n), hostBytes = Buffer.alloc(56); Buffer.from(home.keyHex, 'hex').copy(hostBytes); hostBytes[50] = 2; hostBytes[51] = 1;
  const host = { ...home, keyHex: hostBytes.toString('hex'), site: 2, generation: 1, hostSequence: 0 };
  const province = key(p, q), wide = family === 'wide', entities = wide ? [1] : action === 'dissolve' ? [4, 5] : [5];
  const b = Buffer.alloc(323 + entities.length * 41); b[0] = wide ? 0x82 : 1; b[1] = wide ? 26 : 149;
  b.writeUInt32LE(9, 2); b[6] = 1; b[7] = action === 'dissolve' ? 1 : 2; hostBytes.copy(b, 10); b.fill(31, 66, 98);
  b.set(decode(withSeed(pins.seasonAddress, seedOf('Holding', { p: 128, q: 0, site: 2 }), pins.programId)), 98);
  Buffer.from(province.keyHex, 'hex').copy(b, 130);
  b.set(decode(captureAddress('province', Buffer.from(province.keyHex, 'hex').subarray(33), null, pins.seasonAddress, pins.programId)), 180);
  b[212] = 2; b[213] = 3; b.writeUInt32LE(12345, 214); b.writeUInt32LE(9, 218); b.writeUInt32LE(action === 'return' ? 12 : 0, 222);
  b.fill(0x12, 258, 290); b.fill(0x34, 290, 322); b.set(sha256('PSF-BOUNDARY-RESIDENT-OP-v1', b.subarray(258, 290), b.subarray(290, 322)), 226);
  b[322] = entities.length; entities.forEach((e, i) => { const at = 323 + 41 * i; b[at] = e; b.writeBigUInt64LE(BigInt(i + 1), at + 1); b.fill(42, at + 9, at + 41); });
  const row = { event: wide ? '2' : '1', archiveSequence: '1', ordinal: wide ? '1' : '0', format: wide ? 'PSW1' : 'PS2', kind: b[1],
    name: `${wide ? 'WIDE_' : ''}ORIGINAL_RESIDENT_${action.toUpperCase()}`, body_b64: b.toString('base64'), province, host, holding: null };
  return { row, body: b };
}
function one(action = 'dissolve', family = 'original', edit = () => {}) {
  const f = fixture(action, family); f.row.event = '1'; edit(f); f.row.body_b64 = f.body.toString('base64');
  return parseWideIndexPage(page([f.row]), options).rows[0];
}
const pair = (action = 'dissolve') => [fixture(action).row, fixture(action, 'wide').row];

test('both dedicated record families retain original identity, units, hashes and no executable action', () => {
  for (const action of ['dissolve', 'return']) for (const family of ['original', 'wide']) {
    const r = one(action, family), x = r.resident;
    assert.equal(x.action, action); assert.equal(x.family, family); assert.equal(x.bell, 9);
    assert.equal(r.host.p, 128n); assert.equal(r.host.hostSequence, 0); assert.equal(r.province.p, 129n); assert.equal(r.holding, null);
    assert.equal(x.troopsMilli, 12345); assert.equal(x.creditedUnits, action === 'return' ? 12 : 0);
    assert.equal(x.links[0].sequence, 1n); assert.equal(x.executable, false); assert.equal(x.publicDispatch, false);
    assert.equal(r.residentPairEvent, null); assert.equal(r.economy, null); assert.equal(r.garrison, null);
    assert.throws(() => wideActionReview({ pins, page: parseWideIndexPage(page(pair(action)), options), event: 2n }), e => e.code === 'WideHostObservationRequired');
  }
});

test('same-transaction parts match raw identities; a page split stays an unpaired observation', () => {
  const rows = parseWideIndexPage(page(pair()), options).rows;
  assert.equal(rows[0].residentPairEvent, 2n); assert.equal(rows[1].residentPairEvent, 1n);
  const first = parseWideIndexPage(page([pair()[0]], { limit: 1, more: true }), { ...options, limit: 1 });
  const second = parseWideIndexPage(page([pair()[1]], { after: '1', next: '2', limit: 1 }), { ...options, after: 1n, limit: 1 });
  assert.equal(first.rows[0].residentPairEvent, null); assert.equal(second.rows[0].residentPairEvent, null);
  const otherTx = pair(); otherTx[1].archiveSequence = '2';
  const distinct = parseWideIndexPage(page(otherTx, { indexedThrough: '2' }), { ...options, through: 2n });
  assert.ok(distinct.rows.every(r => r.residentPairEvent === null));
  const duplicate = pair(); duplicate[1] = { ...duplicate[0], event: '2', ordinal: '1' }; refused(() => parseWideIndexPage(page(duplicate), options));
  const mixed = pair(); mixed[1] = fixture('return', 'wide').row; refused(() => parseWideIndexPage(page(mixed), options));
  const ordinal = pair(); ordinal[1].ordinal = '0'; refused(() => parseWideIndexPage(page(ordinal), options));
});

test('canonical body, tails, family, operation digest, recipients and raw metadata are mandatory', () => {
  assert.equal(one('dissolve', 'original', f => { f.body[213] = 7; }).resident.unit, 7, 'receipt ABI has eight units, independently of private writer support');
  const edits = [
    f => { f.body[0] = 0x81; }, f => { f.body[1] = 25; }, f => { f.body[6] = 2; }, f => { f.body[7] = 0; },
    f => { f.body[8] = 1; }, f => { f.body[9] = 1; }, f => { f.body[226] ^= 1; }, f => { f.body[258] ^= 1; },
    f => { f.body[212] = 56; }, f => { f.body[213] = 8; }, f => { f.body.writeUInt32LE(0xffffffff, 218); },
    f => { f.body.writeUInt32LE(10, 218); }, f => { f.body.writeUInt32LE(1, 222); },
    f => { f.body[322] = 0; }, f => { f.body[323] = 6; }, f => { f.body.writeBigUInt64LE(0n, 324); },
    f => { f.body[98] ^= 1; }, f => { f.body[180] ^= 1; }, f => { f.body.fill(0, 66, 98); },
    f => { f.body.copy(f.body, 66, 98, 130); }, f => { f.row.host.hostSequence = 1; }, f => { f.row.host.site = 1; },
    f => { f.row.holding = f.row.host; }, f => { f.row.name = 'WIDE_RETURN'; }, f => { f.row.province.p = '130'; },
    f => { f.body = Buffer.concat([f.body, Buffer.from([0])]); },
  ];
  for (const edit of edits) refused(() => one('dissolve', 'original', edit));
  refused(() => one('return', 'original', f => f.body.writeUInt32LE(13, 222)));
  for (const family of ['original', 'wide']) {
    const n = fixture('dissolve', family).body.length;
    for (let i = 0; i < n; i++) refused(() => one('dissolve', family, f => { f.body = f.body.subarray(0, i); }));
  }
});

test('wide coordinates and chain sequence stay lossless, and original source cannot be aliased to a wide holding', () => {
  const f = fixture('return', 'wide', 9007199254740993n, 0n); f.row.event = '1'; f.body.writeBigUInt64LE(0xffffffffffffffffn, 324); f.row.body_b64 = f.body.toString('base64');
  const r = parseWideIndexPage(page([f.row]), options).rows[0];
  assert.equal(r.province.p, 9007199254740993n); assert.equal(r.resident.links[0].sequence, 0xffffffffffffffffn);
  refused(() => one('return', 'wide', f => { const h = key(129n, 0n); f.row.host = { ...f.row.host, ...h, keyHex: h.keyHex + f.row.host.keyHex.slice(100) }; Buffer.from(f.row.host.keyHex, 'hex').copy(f.body, 10); }));
  const legacy = fixture('return', 'wide', 128n, 0n); legacy.row.event = '1'; refused(() => parseWideIndexPage(page([legacy.row]), options));
});

// Minimal DOM contract, not a browser screenshot or visual acceptance run.
class Element {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.dataset = {}; this.children = []; this.events = {}; this.attrs = {}; this.clientWidth = 640; this.clientHeight = 400; }
  set innerHTML(s) { this.ids = new Map([...s.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element(this.ownerDocument, 'div')])); }
  set textContent(s) { this.text = s; this.children = []; }
  get textContent() { return [this.text ?? '', ...this.children.map(x => x.textContent)].join(' '); }
  querySelector(s) { return this.ids?.get(s.replace(/^#/, '')) ?? null; }
  append(...nodes) { this.children.push(...nodes); for (const n of nodes) n.parentElement = this; }
  after(node) { this.parentElement?.append(node); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, f) { (this.events[k] ??= []).push(f); }
  focus() {} remove() {} getContext() { return null; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const doc = { createElement: tag => new Element(doc, tag) }, parent = doc.createElement('div'), canvas = doc.createElement('canvas'); parent.append(canvas);
  const record = { season: pins.seasonId, seasonAddress: pins.seasonAddress, programId: pins.programId, cluster: 'localnet' };
  let history = page(pair('return')); const requests = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname; requests.push({ path, method: init?.method ?? 'GET' });
    const json = path === '/h/world/wide' ? { v: 1, experimental: true, readOnly: true, completeness: 'captured', world, worldDomain: WORLD_DOMAIN,
      season: pins.seasonId, program: pins.programId, seasonAddress: pins.seasonAddress, snapshot: { epoch: '0', stamp: snapshot }, recorded: 0, refused: 0 }
      : path === '/h/world/wide/page' ? { v: 1, world, snapshot: { epoch: '0', stamp: snapshot }, after: null, entries: [], next: null }
      : path === '/h/wide-index/status' ? { ...scope(), state: 'observed', caughtUp: true, automaticWrites: false }
      : path === '/h/wide-index/events' ? history : null;
    assert.ok(json); return { ok: true, status: 200, json: async () => json };
  };
  return { mode: mountWideMode({ herald: createHerald({ base: 'http://resident.invalid', fetch }), canvas, doc, recordOf: () => record }),
    requests, setHistory: v => { history = v; } };
}

test('original UI reads both parts with explicit original-home attribution and no host action controls', async () => {
  const old = lang(), { mode, requests, setHistory } = harness();
  try {
    setLang('en'); mode.open(); await flush();
    assert.equal(mode.state().history.phase, 'ready');
    const list = mode.elements().sheet.querySelector('#wide-history-list'); assert.equal(list.children.length, 2);
    for (const li of list.children) {
      assert.match(li.textContent, /Return to original village/); assert.match(li.textContent, /Origin P 128, Q 0/);
      assert.match(li.textContent, /Reserve units returned \(recorded\) 12/); assert.match(li.textContent, /Matching receipt on this page/);
      assert.match(li.textContent, /Public execution is not connected/); assert.match(li.textContent, /Unverified/);
      assert.ok(li.children.every(x => x.tagName === 'p'));
    }
    assert.equal(mode.elements().sheet.querySelector('#wide-action-review').children.length, 0);
    assert.equal(mode.state().walk.entries.size, 0);
    setLang('ja'); assert.match(list.children[0].textContent, /元の村へ帰還/); assert.match(list.children[0].textContent, /署名・送信は行いません/);
    setHistory(page([pair('return')[0]])); mode.close(); mode.open(); await flush();
    assert.match(list.children[0].textContent, /対応する記録はこのページにありません/);
    const bad = pair('return'); bad[0].host.hostSequence = 7; setHistory(page(bad)); mode.close(); mode.open(); await flush();
    assert.equal(mode.state().history.phase, 'error'); assert.equal(list.children.length, 0);
    setHistory(page(pair('dissolve'))); mode.close(); mode.open(); await flush();
    assert.equal(mode.state().history.phase, 'ready'); assert.match(list.children[0].textContent, /帰還を予約/);
    assert.ok(requests.every(x => x.method === 'GET'));
  } finally { mode.unmount(); setLang(old); }
});

// Immutable output of the real, guarded native capture-to-return test. The
// BRES wrapper contains synthetic initial account state and actual handler
// output. Reading these bytes is not evidence of a live chain or full replay.
test('unchanged native Dissolve and Return receipt exports reach the original history parser', () => {
  for (const [file, digest] of [
    ['dissolve_v1.bin', '0d46cd2d175c57c947af8e67f14f2d002e18c9e7e7d47fb4a944e98023f39a84'],
    ['return_v1.bin', '6f22a8e606852e52d87f66e0f2452fd00c6a26aa42716a2fc874feb4643d7da3'],
  ]) {
    const bytes = readFileSync(new URL(`../../frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/${file}`, import.meta.url));
    assert.equal(Buffer.from(sha256(bytes)).toString('hex'), digest);
    let at = 0;
    const take = n => { assert.ok(n >= 0 && at + n <= bytes.length); const b = bytes.subarray(at, at + n); at += n; return b; };
    const sized = () => take(take(4).readUInt32LE());
    assert.equal(take(8).toString(), 'BRESv001'); const action = take(1)[0];
    const programId = encode(take(32)), seasonAddress = encode(take(32)); take(56 + 8 + 8);
    const count = take(1)[0]; assert.equal(count, action === 1 ? 8 : 6);
    const captures = [];
    for (let i = 0; i < count * 2; i++) { take(32 + 32 + 4 + 8); captures.push(sized()); }
    assert.equal(take(1)[0], 2); const events = [sized(), sized()]; assert.equal(at, bytes.length);
    const nativePins = { programId, seasonAddress, seasonId: captures[2].readBigUInt64LE(8).toString() };
    const nativeWorld = worldIdOf(seasonAddress, programId);
    const identity = (b, host = false) => {
      const ring = b.readBigUInt64BE(33), wedge = b[41], pos = b.readBigUInt64BE(42);
      let p = ring - pos, q = pos; for (let i = 0; i < wedge; i++) [p, q] = [-q, p + q];
      const base = { world: b.subarray(1, 33).toString('hex'), p: String(p), q: String(q), keyHex: b.toString('hex') };
      return host ? { ...base, site: b[50], generation: b[51], hostSequence: b.readUInt32LE(52) } : base;
    };
    const rows = events.map((b, i) => ({ event: String(i + 1), archiveSequence: '1', ordinal: String(i), format: i ? 'PSW1' : 'PS2',
      kind: b[1], name: `${i ? 'WIDE_' : ''}ORIGINAL_RESIDENT_${action === 1 ? 'DISSOLVE' : 'RETURN'}`, body_b64: b.toString('base64'),
      province: identity(b.subarray(130, 180)), host: identity(b.subarray(10, 66), true), holding: null }));
    const parsed = parseWideIndexPage({ ...page(rows), program: programId, seasonAddress, season: nativePins.seasonId, world: nativeWorld }, { ...options, pins: nativePins });
    assert.deepEqual(parsed.rows.map(r => Buffer.from(r.body)), events);
    assert.equal(parsed.rows[0].residentPairEvent, 2n); assert.equal(parsed.rows[1].residentPairEvent, 1n);
    assert.equal(parsed.rows[0].host.p, 128n);
    assert.equal(ringPosition(parsed.rows[0].province.p, parsed.rows[0].province.q).ring, 129n);
    assert.equal(parsed.sourceCoverage, 'unknown'); assert.equal(parsed.captureVerification, 'unverified');
    assert.equal(parsed.rows[0].resident.executable, false);
    if (action === 2) assert.ok(parsed.rows[0].resident.creditedUnits > 0);
  }
});
