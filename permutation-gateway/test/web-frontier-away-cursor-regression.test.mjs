// Workstream 07, the away reader's transport cursor (hud/awayread.mjs, 2026-11-18). The defect: the reader moved its
// cursor only over the records it could decode, so a full page of kinds this page does not read (decodeRecord → null,
// e.g. `{seq:"1", body_b64:"Af8AAAAA"}` with `next:"1", full:true`) was asked for again from the same cursor for ever,
// by `start` and by every `more`. The cursor now follows the herald's raw `next` once it is trusted (a canonical u64,
// the page's newest raw seq — the cursor asked from on an empty page — and never behind it); the records, and so the
// summary and its "seen" mark, are still only the bodies decoded. An untrusted `next` fails the page, never guessed.
//
// Pure: in-memory `events` callbacks and promises the tests resolve themselves; no timer, socket, file or key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGS } from '../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import * as RS from '../../permutation-server/web/frontier/hud/returnsum.mjs';
import * as RR from '../../permutation-server/web/frontier/hud/awayread.mjs';

// ---------------------------------------------------------------- bodies
function body(name, bell, fields = {}) {
  const spec = LOGS.kinds.find(k => k.name === name);
  const parts = [...spec.key, ...spec.payload];
  const b = new Uint8Array(6 + parts.reduce((a, f) => a + f.len, 0) + 1), v = new DataView(b.buffer);
  b[0] = 1; b[1] = spec.kind; v.setUint32(2, bell, true);
  let o = 6;
  for (const f of parts) {
    const x = fields[f.name];
    if (x !== undefined) {
      if (f.len === 8) v.setBigUint64(o, BigInt(x), true); else if (f.len === 4) v.setInt32(o, Number(x), true);
      else if (f.len === 2) v.setUint16(o, Number(x), true); else if (f.len === 1) b[o] = Number(x);
    }
    o += f.len;
  }
  return toBase64(b);
}
const ME = 0x51n;
const me = { tag: ME, faction: 2, holdings: [{ p: 0, q: 0, site: 0 }], hostOf: () => null };
/** A record this page reads and tells (a siege on the viewer's village). */
const siege = (seq, bell = 300 + Number(seq) % 100) => ({ seq: String(seq), body_b64: body('SIEGE_DECLARED', bell, { p: 0, q: 0, site: 0, attacker: 3, owner_faction: 2, owner_tag: ME, required: 44 }) });
/** A record of a kind this page does not read: version 1, kind 255 (decodeRecord → null, not counted as bad). */
const UNSUPPORTED = 'Af8AAAAA';
const unk = seq => ({ seq: String(seq), body_b64: UNSUPPORTED });
/** A body that does not decode (version 2: decodeRecord throws → counted as bad). */
const broken = seq => ({ seq: String(seq), body_b64: 'AgEAAAAA' });
const page = (events, next, full) => ({ ok: true, events, next, full });
const sum = (records, read, confirmedSeq = '100') => RS.summarize({ records, read, marks: { confirmedSeq, confirmedBell: 299, caravans: {} }, last: null, season: '7', wallet: 'W', nowBell: 400, me });

/** `events` from a table: after → answer (a function of the call number may stand for it); every `after` asked is kept. */
function scripted(table) {
  const calls = [];
  return { calls, events: async after => {
    calls.push(after);
    const a = table[after];
    if (a === undefined) return { ok: false, code: 'NoPage' };
    if (typeof a === 'function') return a(calls.length);
    return a;
  } };
}

// ---------------------------------------------------------------- the reported defect
test('the reported page (an unsupported body, next "1", full) no longer asks for after=0 for ever: start and more move on', async () => {
  const fixture = { ok: true, events: [{ seq: '1', body_b64: UNSUPPORTED }], next: '1', full: true };
  const calls = [];
  const r = RR.createAwayReader({ events: async after => { calls.push(after); return fixture; } });
  const got = await r.start({ scope: 's', from: '0' });
  // page 1 moves the cursor to 1; page 2 (the same answer from 1) moves it nowhere: stopped, not complete
  assert.deepEqual(calls, ['0', '1']);
  assert.deepEqual([got.records, got.complete, got.failed, got.bad, got.next, got.stale], [[], false, false, 0, '1', false]);
  const more = await r.more();
  assert.deepEqual(calls, ['0', '1', '1'], 'more asks from the raw cursor, once');
  assert.deepEqual([more.records, more.complete, more.failed, more.next], [[], false, false, '1']);
  assert.ok(!calls.slice(1).includes('0'), 'never after=0 again');
});

// ---------------------------------------------------------------- unreadable kinds move the cursor, never the records
test('a full page of unsupported records, then a readable page: the cursor passes them and the record is read', async () => {
  const h = scripted({
    100: page([unk(101), unk(102)], '102', true),
    102: page([siege(103)], '103', false),
  });
  const got = await RR.createAwayReader({ events: h.events }).start({ scope: 's', from: '100' });
  assert.deepEqual(h.calls, ['100', '102']);
  assert.deepEqual([got.records.map(x => x.seq), got.complete, got.failed, got.bad, got.next], [['103'], true, false, 0, '103']);
  const s = sum(got.records, got);
  assert.equal(s.gap, null);
  assert.deepEqual([s.confirm.ok, s.confirm.toSeq], [true, '103']);
});

test('a page whose readable records are followed by unsupported ones: the cursor goes to the raw end, "seen" stops at the last record read', async () => {
  const h = scripted({
    100: page([siege(101), unk(102), broken(103), unk(104)], '104', false),
    104: page([], '104', false),
  });
  const r = RR.createAwayReader({ events: h.events });
  const got = await r.start({ scope: 's', from: '100' });
  assert.deepEqual([got.records.map(x => x.seq), got.complete, got.bad, got.next], [['101'], true, 1, '104']);
  const s = sum(got.records, got);
  assert.deepEqual([s.confirm.ok, s.confirm.toSeq, s.bad], [true, '101', 1], 'never a mark on an event that was not read');
  assert.ok(s.items.every(i => i.seq === '101'));
  const more = await r.more();
  assert.deepEqual(h.calls, ['100', '104']);
  assert.deepEqual([more.records, more.complete, more.next], [[], true, '104']);
});

test('only unsupported records up to the head: complete, nothing to confirm, the mark does not move', async () => {
  const h = scripted({ 100: page([unk(101), unk(102)], '102', false) });
  const got = await RR.createAwayReader({ events: h.events }).start({ scope: 's', from: '100' });
  assert.deepEqual([got.records, got.complete, got.next], [[], true, '102']);
  const s = sum(got.records, got);
  assert.deepEqual(s.confirm, { ok: false, why: 'nothing' });
  const st = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, v); } };
  assert.equal(RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: s.confirm, at: 1 }), null);
  assert.equal(st.m.size, 0);
});

// ---------------------------------------------------------------- terminal and no-progress pages
test('an empty last page whose next is the cursor asked from is a complete read', async () => {
  const h = scripted({ 108: page([], '108', false) });
  const got = await RR.createAwayReader({ events: h.events }).start({ scope: 's', from: '108' });
  assert.deepEqual([got.records, got.complete, got.failed, got.next], [[], true, false, '108']);
});

test('a full page that moves the cursor nowhere stops (bounded) and is not complete', async () => {
  const h = scripted({ 108: page([], '108', true) });
  const got = await RR.createAwayReader({ events: h.events }).start({ scope: 's', from: '108' });
  assert.deepEqual(h.calls, ['108']);
  assert.deepEqual([got.complete, got.failed, got.next], [false, false, '108']);
});

test('the largest u64 is a cursor like any other', async () => {
  const MAX = '18446744073709551615';
  const h = scripted({ 100: page([unk(MAX)], MAX, false) });
  const got = await RR.createAwayReader({ events: h.events }).start({ scope: 's', from: '100' });
  assert.deepEqual([got.complete, got.failed, got.next], [true, false, MAX]);
});

// ---------------------------------------------------------------- an untrusted cursor fails the page, never guessed
const BAD_PAGES = [
  ['next missing', page([siege(103)], undefined, false)],
  ['next null', page([siege(103)], null, false)],
  ['next a number', page([siege(103)], 103, false)],
  ['next with a leading zero', page([siege(103)], '0103', false)],
  ['next negative', page([siege(103)], '-1', false)],
  ['next in exponent form', page([siege(103)], '1e3', false)],
  ['next with a space', page([siege(103)], ' 103', false)],
  ['next past u64', page([siege(103)], '18446744073709551616', false)],
  ['next behind the newest raw seq', page([siege(103), unk(104)], '103', false)],
  ['next beyond the newest raw seq', page([siege(103)], '109', false)],
  ['next behind the cursor (empty page)', page([], '99', false)],
  ['next beyond the cursor on an empty page', page([], '105', false)],
  ['next behind the cursor (a page of old records)', page([siege(101)], '101', true)],
  ['a raw seq that is not a canonical u64', page([{ seq: 103, body_b64: siege(103).body_b64 }], '103', false)],
  ['events not a list', { ok: true, events: null, next: '103', full: false }],
];
for (const [name, bad] of BAD_PAGES) {
  test(`an untrusted cursor fails the page and keeps the pages before it: ${name}`, async () => {
    const h = scripted({ 100: page([siege(101), siege(102)], '102', true), 102: bad });
    const r = RR.createAwayReader({ events: h.events });
    const got = await r.start({ scope: 's', from: '100' });
    assert.deepEqual([got.failed, got.complete, got.records.map(x => x.seq), got.next], [true, false, ['101', '102'], '102']);
    const s = sum(got.records, got);
    assert.deepEqual([s.failed, s.confirm.toSeq, s.confirm.partial], [true, '102', true]);
    // the next reading asks again from the last trusted cursor
    await r.more();
    assert.deepEqual(h.calls, ['100', '102', '102']);
  });
}

test('an untrusted cursor on the first page: nothing read, the cursor stays at the start', async () => {
  const h = scripted({ 100: page([siege(101)], null, false) });
  const r = RR.createAwayReader({ events: h.events });
  const got = await r.start({ scope: 's', from: '100' });
  assert.deepEqual([got.failed, got.complete, got.records, got.next], [true, false, [], '100']);
  await r.more();
  assert.deepEqual(h.calls, ['100', '100']);
});

// ---------------------------------------------------------------- page failures
test('a page that fails or throws stops the reading; the pages before it stand and the next reading resumes from them', async () => {
  for (const failing of [{ ok: false, code: 'Down' }, () => { throw new Error('down'); }]) {
    const h = scripted({ 100: page([unk(101), siege(102)], '102', true), 102: failing, });
    const r = RR.createAwayReader({ events: h.events });
    const got = await r.start({ scope: 's', from: '100' });
    assert.deepEqual([got.failed, got.complete, got.records.map(x => x.seq), got.next], [true, false, ['102'], '102']);
    await r.more();
    assert.deepEqual(h.calls, ['100', '102', '102']);
  }
});

// ---------------------------------------------------------------- the page budget
test('the page budget ends a reading over unsupported records without calling it complete; more goes on from the raw cursor', async () => {
  const h = scripted({
    100: page([unk(101)], '101', true),
    101: page([unk(102)], '102', true),
    102: page([siege(103)], '103', false),
  });
  const r = RR.createAwayReader({ events: h.events, pages: 2 });
  const got = await r.start({ scope: 's', from: '100' });
  assert.deepEqual([got.complete, got.failed, got.records, got.next], [false, false, [], '102']);
  assert.deepEqual(sum(got.records, got).confirm, { ok: false, why: 'nothing' });
  const more = await r.more();
  assert.deepEqual(h.calls, ['100', '101', '102']);
  assert.deepEqual([more.complete, more.records.map(x => x.seq), more.next], [true, ['103'], '103']);
});

// ---------------------------------------------------------------- scope changes (controlled promises, no timer)
function controlled() {
  const pending = [];
  return { pending, events: after => new Promise(resolve => pending.push({ after, resolve })) };
}

test('a reading overtaken by another scope is stale, gives nothing, and does not move the new scope\'s cursor', async () => {
  const c = controlled();
  const r = RR.createAwayReader({ events: c.events });
  const a = r.start({ scope: 'A', from: '100' });
  const b = r.start({ scope: 'B', from: '200' });
  assert.deepEqual(c.pending.map(p => p.after), ['100', '200']);
  c.pending[1].resolve(page([unk(201), unk(202)], '202', false));
  const rb = await b;
  assert.deepEqual([rb.stale, rb.scope, rb.complete, rb.next], [false, 'B', true, '202']);
  // A's late answer, far ahead: stale, empty, and B's cursor stands
  c.pending[0].resolve(page([siege(101), unk(500)], '500', false));
  const ra = await a;
  assert.deepEqual([ra.stale, ra.records, ra.next], [true, [], null]);
  const m = r.more();
  assert.equal(c.pending[2].after, '202');
  c.pending[2].resolve(page([], '202', false));
  assert.deepEqual([(await m).complete, (await m).scope], [true, 'B']);
});

test('a reset while a page is out: the reading is stale and more says so without asking', async () => {
  const c = controlled();
  const r = RR.createAwayReader({ events: c.events });
  const a = r.start({ scope: 'A', from: '100' });
  r.reset();
  c.pending[0].resolve(page([unk(101)], '101', false));
  assert.deepEqual([(await a).stale, (await a).records], [true, []]);
  const m = await r.more();
  assert.deepEqual([m.stale, m.next], [true, null]);
  assert.equal(c.pending.length, 1, 'nothing asked after the reset');
});
