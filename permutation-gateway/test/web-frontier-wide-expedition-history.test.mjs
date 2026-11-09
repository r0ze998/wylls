// Immutable actual native logs, supplied archive wrappers, and synthetic codec
// variants. No keys, signing, real network, transactions or live-chain claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode } from '../../permutation-server/web/sdk/base58.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';
import { worldIdOf, WORLD_DOMAIN } from '../../permutation-server/web/frontier/map/wide.mjs';
import { parseWideIndexPage } from '../../permutation-server/web/frontier/map/widehistory.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { mountWideMode } from '../../permutation-server/web/frontier/map/widemode.mjs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';
const snapshot = 'cd'.repeat(32), bytes = readFileSync(new URL('../../frontier-node/crates/fclient/tests/fixtures/original_boundary_v1.bin', import.meta.url));
assert.equal(Buffer.from(sha256(bytes)).toString('hex'), '48e97269e39672bee2f19b7c692a8dca95b608f050c45e2e932922b4de9e47d5');
let at = 0;
const take = n => { assert.ok(n >= 0 && at + n <= bytes.length); const b = bytes.subarray(at, at + n); at += n; return b; };
const sized = () => take(take(4).readUInt32LE());
assert.equal(take(8).toString(), 'BTRCv001');
// Numeric season ID is a supplied page claim; the trace binds program+address.
const pins = { programId: encode(take(32)), seasonAddress: encode(take(32)), seasonId: '0' };
const world = worldIdOf(pins.seasonAddress, pins.programId), count = take(4).readUInt32LE();
const native = [];
for (let i = 0; i < count; i++) {
  take(16); const n = take(2).readUInt16LE();
  for (let j = 0; j < n; j++) native.push({ format: sized().toString(), b: sized(), archiveSequence: String(i + 1), ordinal: String(j) });
}
assert.equal(at, bytes.length); assert.equal(count, 51); assert.equal(native.length, 56);
function identity(b, host = false) {
  const ring = b.readBigUInt64BE(33), wedge = b[41], pos = b.readBigUInt64BE(42);
  let p = ring - pos, q = pos; for (let i = 0; i < wedge; i++) [p, q] = [-q, p + q];
  const base = { world: b.subarray(1, 33).toString('hex'), p: String(p), q: String(q), keyHex: b.toString('hex') };
  return host ? { ...base, site: b[50], generation: b[51], hostSequence: b.readUInt32LE(52) } : base;
}
const CQ = { 18: 'DECLARED', 19: 'DEBITED', 20: 'RESOLVED', 21: 'SETTLED', 22: 'CAPTURED', 23: 'CREDITED', 24: 'TABLE_CLOSED' };
function row({ b, format, archiveSequence = '1', ordinal = '0' }, i = 0) {
  const r = { event: String(i + 1), archiveSequence, ordinal, format, kind: format === 'PSWC' ? null : b[1], name: 'PS2', body_b64: b.toString('base64'), province: null, host: null, holding: null };
  const key = (offset, host = false) => identity(b.subarray(offset, offset + (host ? 56 : 50)), host);
  if (format === 'PSWC') { r.name = 'WIDE_CONQUEST_SIDECAR_CLOSED'; r.action = 7; }
  else if (r.kind === 146) { r.name = b[7] === 1 ? 'ORIGINAL_EXPEDITION_DEPART' : 'ORIGINAL_EXPEDITION_SETTLE_ORIGIN'; r.province = key(130); r.host = key(10, true); }
  else if (r.kind === 147) { r.name = b[7] === 1 ? 'ORIGINAL_EXPEDITION_REVEAL' : 'ORIGINAL_EXPEDITION_GATHER'; r.province = key(10); if (b[7] === 1) r.host = key(60, true); }
  else if ([148, 25].includes(r.kind)) { r.name = `${r.kind === 25 ? 'WIDE_' : ''}ORIGINAL_EXPEDITION_SETTLE_MEMBER`; r.province = key(162); r.host = key(10, true); }
  else if ([149, 26].includes(r.kind)) { r.name = `${r.kind === 26 ? 'WIDE_' : ''}ORIGINAL_RESIDENT_${b[7] === 1 ? 'DISSOLVE' : 'RETURN'}`; r.province = key(130); r.host = key(10, true); }
  else if (r.kind === 145) { r.name = b[7] === 1 ? 'ORIGINAL_CONQUEST_DEBIT' : 'ORIGINAL_CONQUEST_CREDIT'; r.province = key(10); r.host = key(10, true); }
  else if (format === 'PSW1') {
    r.name = r.kind === 3 ? 'WIDE_RESOLVE' : `WIDE_CONQUEST_${CQ[r.kind]}`; r.province = key(6);
    if ([19, 22, 23].includes(r.kind)) r.holding = key(6, true);
  }
  return r;
}
const nativeRows = native.map(row);
const scope = () => ({ v: 1, experimental: true, readOnly: true, program: pins.programId, seasonAddress: pins.seasonAddress, season: pins.seasonId, world, snapshot, indexedThrough: '51', sourceCoverage: 'unknown', captureVerification: 'unverified' });
const page = rows => ({ ...scope(), after: '0', next: String(rows.length), more: false, limit: 256, events: rows });
const parse = rows => parseWideIndexPage(page(rows), { pins, through: 51n, snapshot, limit: 256 });
const refused = fn => assert.throws(fn, e => e?.code === 'BadWideHistory');
const clone = x => structuredClone(x);
const isolated = r => ({ ...clone(r), event: '1' });
function mutated(r, edit) { const x = isolated(r), b = Buffer.from(x.body_b64, 'base64'); edit(b, x); x.body_b64 = b.toString('base64'); return x; }

test('all56 native receipts reach original history without altering raw bodies or inventing live state', () => {
  const p = parse(nativeRows); assert.equal(p.rows.length, 56);
  assert.equal(p.rows.filter(x => x.expedition).length, 49);
  assert.equal(p.rows.filter(x => x.resident).length, 4);
  assert.deepEqual(p.rows.map(x => Buffer.from(x.body)), native.map(x => x.b));
  assert.equal(p.sourceCoverage, 'unknown'); assert.equal(p.captureVerification, 'unverified');
  for (const r of p.rows.filter(x => x.expedition)) {
    assert.equal(r.expedition.executable, false); assert.equal(r.expedition.sourceVerification, 'unverified');
    if (r.host) assert.equal(r.host.p, 128n);
    if (r.expedition.pairClass) assert.ok(r.expeditionPairEvent !== null);
    if (r.expedition.stage === 'gather') assert.equal(r.host, null);
    if (r.kind === 145) assert.equal(r.expedition.sourceReference, true);
  }
});

test('dedicated bodies reject truncation, trailing data, bad digests, identities and addresses', () => {
  const samples = [...new Map(nativeRows.filter(r => [145,146,147,148,25].includes(r.kind)).map(r => [r.name,r])).values()];
  for (const r of samples) {
    const body = Buffer.from(r.body_b64, 'base64');
    for (let n = 0; n < body.length; n++) refused(() => parse([{ ...isolated(r), body_b64: body.subarray(0,n).toString('base64') }]));
    refused(() => parse([{ ...isolated(r), body_b64: Buffer.concat([body,Buffer.from([0])]).toString('base64') }]));
    for (const i of [0,6,9]) refused(() => parse([mutated(r,b=>{b[i]^=1;})]));
    if (r.host) refused(() => parse([mutated(r,(_,x)=>{x.host.hostSequence++;})]));
    const digest = r.kind === 145 ? 102 : r.kind === 146 ? 248 : r.kind === 147 ? (body[7] === 1 ? 217 : 64) : 358;
    refused(() => parse([mutated(r,b=>{b[digest]^=1;})]));
  }
  const depart = nativeRows.find(r => r.name === 'ORIGINAL_EXPEDITION_DEPART');
  for (const i of [8,98,180,212,345]) refused(() => parse([mutated(depart,b=>{b[i]=i===8?4:b[i]^1;})]));
  refused(() => parse([mutated(depart,b=>{b.fill(0,66,98);})]));
  const settlement = nativeRows.find(r=>r.kind===148);
  for (const i of [7,8,98,130,212,244,294,326]) refused(() => parse([mutated(settlement,b=>{b[i]=i===7?8:i===8?4:b[i]^1;})]));
});

test('settlement and conquest pairs are page-local and transaction-local, with exact bodies and opposite roles', () => {
  for (const first of nativeRows.filter(r=>r.kind===148 || r.kind===145)) {
    const partner = nativeRows.find(r=>r.archiveSequence===first.archiveSequence && r.event!==first.event);
    const a = isolated(first), b = { ...clone(partner), event:'2' };
    assert.equal(parse([a,b]).rows[0].expeditionPairEvent,2n);
    assert.equal(parse([a]).rows[0].expeditionPairEvent,null);
    assert.equal(parse([a,{...b,archiveSequence:'51'}]).rows[0].expeditionPairEvent,null);
    refused(()=>parse([a,{...clone(a),event:'2',ordinal:'19'}]));
    refused(()=>parse([a,{...b,ordinal:a.ordinal}]));
    refused(()=>parse([a,mutated(b, bb=>{bb[2]^=1;})].map((r,i)=>({...r,event:String(i+1)}))));
  }
});

function cqReceipt(action) { const b=Buffer.alloc(100); b[0]=1;b[1]=action;b.fill(11,36,68);b.fill(12,68,100);b.set(sha256('PSF-WIDE-CONQUEST-OP-v1',new Uint8Array([action,0]),b.subarray(36,68),b.subarray(68)),4);return b; }
function cq(kind, action) {
  const holding = [19,22,23].includes(kind), target=nativeRows.find(r=>r.kind===22), key=Buffer.from((holding?target.holding:target.province).keyHex,'hex');
  const entities=kind===22?[1,2]:kind===24?[]:holding?[2]:[1], b=Buffer.alloc(6+key.length+100+1+41*entities.length);
  b[0]=0x82;b[1]=kind;b.writeUInt32LE(4,2);key.copy(b,6);cqReceipt(action).copy(b,6+key.length);const at=6+key.length+100;b[at]=entities.length;
  entities.forEach((e,i)=>{b[at+1+i*41]=e;b.writeBigUInt64LE(1n,at+2+i*41);});return row({b,format:'PSW1'});
}
test('all conquest stages and PSWC have distinct non-host schemas; zero-link closures stay zero-link', () => {
  for(const [k,a] of [[18,1],[19,1],[20,2],[21,3],[21,4],[22,5],[23,4],[23,5],[24,6]]) {
    const r=cq(k,a), x=parse([r]).rows[0];assert.equal(x.host,null);assert.equal(x.expedition.action,a);assert.equal(x.expedition.executable,false);
    refused(()=>parse([mutated(r,(_,v)=>{v.name='WIDE_RESOLVE';})]));
    refused(()=>parse([mutated(r,b=>{b[(k===19||k===22||k===23?62:56)+4]^=1;})]));
  }
  const b=Buffer.alloc(169);b[0]=1;b.set(decode(pins.seasonAddress),1);b.fill(7,33,65);b.writeUInt32LE(4,65);cqReceipt(7).copy(b,69);
  const r=row({b,format:'PSWC'}), x=parse([r]).rows[0];assert.equal(x.kind,null);assert.equal(x.expedition.stage,'sidecar_closed');assert.equal(x.expedition.links.length,0);
  for(const edit of [(bb,v)=>{v.kind=7;},(bb,v)=>{v.action=6;},bb=>{bb[1]^=1;},bb=>{bb[73]^=1;}]) refused(()=>parse([mutated(r,edit)]));
});

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

function harness(rows) {
  const doc = { createElement: tag => new Element(doc, tag) }, parent = doc.createElement('div'), canvas = doc.createElement('canvas'); parent.append(canvas);
  const record = { season: pins.seasonId, seasonAddress: pins.seasonAddress, programId: pins.programId, cluster: 'localnet' };
  let history = rows; const requests = [];
  const fetch = async (url, init) => {
    const u = new URL(url), path = u.pathname; requests.push({ path, method: init?.method ?? 'GET' });
    const after = Number(u.searchParams.get('after') ?? 0), limit = Number(u.searchParams.get('limit') ?? 20);
    const selected = history.slice(after,after+limit), paged = { ...page(selected), after:String(after), limit, more:after+selected.length<history.length, next:String(after+selected.length) };
    const json = path === '/h/world/wide' ? { v: 1, experimental: true, readOnly: true, completeness: 'captured', world, worldDomain: WORLD_DOMAIN,
      season: pins.seasonId, program: pins.programId, seasonAddress: pins.seasonAddress, snapshot: { epoch: '0', stamp: snapshot }, recorded: 0, refused: 0 }
      : path === '/h/world/wide/page' ? { v: 1, world, snapshot: { epoch: '0', stamp: snapshot }, after: null, entries: [], next: null }
      : path === '/h/wide-index/status' ? { ...scope(), state: 'observed', caughtUp: true, automaticWrites: false }
      : path === '/h/wide-index/events' ? paged : null;
    assert.ok(json); return { ok: true, status: 200, json: async () => json };
  };
  return { mode: mountWideMode({ herald: createHerald({ base: 'http://boundary.invalid', fetch }), canvas, doc, recordOf: () => record }),
    requests, setHistory: v => { history = v; } };
}
test('original UI displays native boundary and conquest pages without actions or inferred terrain', async () => {
  const old=lang(), {mode,requests,setHistory}=harness(nativeRows);
  try {
    setLang('en');mode.open();await flush();
    const list=mode.elements().sheet.querySelector('#wide-history-list');
    assert.equal(mode.state().history.phase,'ready');assert.equal(list.children.length,20);
    assert.match(list.children[0].textContent,/Boundary movement and conquest record/);
    assert.match(list.children[0].textContent,/No instruction is constructed, signed or submitted/);
    const source=list.children.find(x=>x.textContent.includes('ORIGINAL_CONQUEST_DEBIT'));
    assert.match(source.textContent,/Source identity reference \(not proof of a host\)/);
    assert.ok(list.children.every(li=>li.children.every(x=>x.tagName==='p')));
    assert.equal(mode.elements().sheet.querySelector('#wide-action-review').children.length,0);
    assert.equal(mode.state().walk.entries.size,0);
    const next=mode.elements().sheet.querySelector('#wide-history-next');next.events.click[0]();await flush();
    assert.equal(mode.state().history.page.rows[0].event,21n);next.events.click[0]();await flush();
    assert.ok(list.children.some(li=>li.textContent.includes('ORIGINAL_RESIDENT_RETURN')));
    setLang('ja');assert.match(list.textContent,/署名・送信は行いません/);
    const bad=nativeRows.map(clone);bad[0].host.hostSequence++;
    setHistory(bad);mode.close();mode.open();await flush();
    assert.equal(mode.state().history.phase,'error');assert.equal(list.children.length,0);
    setHistory(nativeRows);mode.close();mode.open();await flush();
    assert.equal(mode.state().history.phase,'ready');assert.equal(mode.state().history.page.rows[0].event,1n);
    assert.ok(requests.every(r=>r.method==='GET'));
  } finally {mode.unmount();setLang(old);}
});
