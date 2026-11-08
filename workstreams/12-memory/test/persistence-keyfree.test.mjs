// Key-free. Interrupted local persistence, a malformed receipt in a feed, partial history, malformed provenance, and
// private facts behind public views. Imports: 12's src and adapters only (no signed allocation, no key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/index.mjs';
import { SEND_ROUTES } from '../src/records.mjs';
import { ingestReceipts, parseJsonU64 } from '../adapters/ws04-receipts.mjs';
import { b58encode, worldFromSeason, ws12EvidencePort } from '../adapters/canonical.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ws12-persist-')), 'm.jsonl');
const note = i => ({ owner: 'A', bell: i, about: null, by: 'code', basis: [], text: `n${i}` });

// ---------------------------------------------------------------- interrupted writes
test('a torn last line: what is appended after the reload is kept, the torn bytes stay, and every later reload opens', () => {
  const path = tmp();
  const m = createMemory({ path });
  m.note(note(1)); m.note(note(2));
  appendFileSync(path, '{"record":{"id":"half-writ'); // a crash mid-write
  const m2 = createMemory({ path });
  assert.deepEqual([m2.journal.torn, m2.journal.records().length], [1, 2]);
  assert.equal(m2.note(note(3)).status, 'added');
  for (let k = 0; k < 2; k++) { // two more reloads
    const again = createMemory({ path });
    assert.deepEqual(again.journal.records().map(r => r.text), ['n1', 'n2', 'n3'], 'the record written after the tear is not lost');
    assert.equal(again.journal.torn, 1);
  }
  assert.ok(readFileSync(path, 'utf8').includes('{"record":{"id":"half-writ'), 'nothing removed or rewritten');
  // a second tear later is handled the same way
  appendFileSync(path, '{"rec');
  const m4 = createMemory({ path });
  assert.equal(m4.journal.torn, 2);
  m4.note(note(4));
  assert.deepEqual(createMemory({ path }).journal.records().map(r => r.text), ['n1', 'n2', 'n3', 'n4']);
});

test('an unreadable last line that ends in a newline is handled the same way; damage in the middle is still refused', () => {
  const path = tmp();
  const m = createMemory({ path });
  m.note(note(1));
  appendFileSync(path, 'garbage\n');
  const m2 = createMemory({ path });
  assert.equal(m2.journal.torn, 1);
  m2.note(note(2));
  assert.deepEqual(createMemory({ path }).journal.records().map(r => r.text), ['n1', 'n2']);
  // a corrupt line that no reload has named is not silently skipped
  const p2 = tmp();
  const a = createMemory({ path: p2 });
  a.note(note(1)); a.note(note(2));
  const lines = readFileSync(p2, 'utf8').split('\n');
  lines[0] = lines[0].slice(0, 10);
  writeFileSync(p2, lines.join('\n'));
  assert.throws(() => createMemory({ path: p2 }), /corrupt line 1/);
  // nor is a marker that names a different line or other bytes
  const p3 = tmp();
  const b = createMemory({ path: p3 });
  b.note(note(1));
  appendFileSync(p3, '{"x\n{"torn":{"line":1,"sha256":"00"}}\n');
  assert.throws(() => createMemory({ path: p3 }), /corrupt line 2/);
});

test('a failed write leaves memory unchanged; the same append can be retried and survives a restart', () => {
  const path = tmp();
  const m = createMemory({ path });
  const write = m.journal._write.bind(m.journal);
  m.journal._write = () => { throw new Error('ENOSPC'); };
  assert.throws(() => m.note(note(1)), /ENOSPC/);
  assert.equal(m.journal.records().length, 0, 'not kept in memory either');
  m.journal._write = write;
  assert.equal(m.note(note(1)).status, 'added', 'a retry is not a "duplicate" of something never written');
  assert.deepEqual(createMemory({ path }).journal.records().map(r => r.text), ['n1']);
});

// ---------------------------------------------------------------- a malformed receipt in a feed
const v = JSON.parse(readFileSync(new URL('../fixtures/ws04-receipts/happy.json', import.meta.url), 'utf8'));
const receipts = v.receipts.map(r => ({ run_id: r.run_id, kind: r.kind, subject: r.subject, source: r.source, slot: r.slot, body: parseJsonU64(r.body_json) }));
const runSpecs = Object.fromEntries(Object.entries(v.run_specs_json).map(([k, s]) => [k, parseJsonU64(s)]));
const ctx = { partition: 'p1', observedBell: 500, bellOfSlot: s => 100 + s, finalizedSlot: 1000, runSpecs, resolveOwner: () => ({ principal: 'Bwallet', source: 'fixture' }) };

test('a receipt the record rules refuse is held whole, with its reason; the rest of the feed is still taken in, once', () => {
  const bad = receipts.map(r => (r.kind === 'caravan_settled' ? { ...r, body: { ...r.body, outcome: 'Bogus' } } : r));
  const path = tmp();
  const m = createMemory({ path });
  const out = ingestReceipts(m, [...bad].reverse(), ctx); // the bad one first: it must not stop the others
  assert.equal(out.held.filter(h => h.why.startsWith('malformed_fact:')).length, 1);
  assert.deepEqual(m.journal.records().map(r => r.kind).sort(), ['caravan_sent', 'identity_alias']);
  assert.ok(!m.journal.records().some(r => r.kind === 'caravan_settled' || r.kind === 'caravan_credited'), 'nothing of the bad receipt written');
  // restart, the corrected feed: only the settle (and its credit) are new
  const m2 = createMemory({ path });
  const again = ingestReceipts(m2, receipts, ctx);
  assert.equal(again.added, 2);
  assert.equal(again.collision, 0);
});

// ---------------------------------------------------------------- unknown stays unknown, private stays private
const A = b58encode(Buffer.alloc(32, 10)), B = b58encode(Buffer.alloc(32, 11));
const W = worldFromSeason({ programId: b58encode(Buffer.alloc(32, 0x21)), cluster: 'localnet-fixture', season: '1', seasonAddress: b58encode(Buffer.alloc(32, 0x42)), genesisTs: 0, bellSecs: 600, continuous: true, latestUnix: 600 * 400 });
const TAG = '0000000000000077';
const PUB = { scope: 'public' }, DM = { scope: 'parties', members: [A, B] };
function promised() {
  const m = createMemory({ world: W.world, partitions: W.partitions });
  const place = { partition: W.partition, kind: 2, p: 1, q: 0, at: 5, gen: 1 };
  const req = m.say({ speaker: A, bell: 0, visibility: PUB, act: { type: 'request', to: B, resource: 'science', qty: 3, by_bell: 10, place } });
  m.say({ speaker: B, bell: 0, visibility: PUB, act: { type: 'accept', ref: req.id, qty: 3, by_bell: 10 } });
  return m;
}
const cov = ({ from = 0, to = 20, vis = PUB, basis = { kind: 'fixture', source: 'test' }, sig = `cov-${from}-${to}` } = {}) => ({ kind: 'coverage', bell: to, visibility: vis, source: { chain: 'index', sig, ix: 0 }, ...(basis === null ? {} : { basis }),
  data: { world: W.world, partition: W.partition, sender: TAG, from_bell: from, to_bell: to, routes: [...SEND_ROUTES], finality: 'finalized', completeness: { gapless: true, from_slot: 0, to_slot: 99 }, caravans: [] } });
const alias = (vis = PUB, basis = { kind: 'fixture', source: 'test' }) => ({ kind: 'identity_alias', bell: 0, visibility: vis, source: { chain: 'r', sig: `alias-${vis.scope}`, ix: 0 }, ...(basis === null ? {} : { basis }), data: { partition: W.partition, tag: TAG, principal: B } });
const viewA = m => m.knowledge({ tag: A, nation: null }, 300).commitments[0];

test('partial history: a coverage over part of the promise window leaves the promise unconfirmed, never not_sent', () => {
  const m = promised();
  m.observe(alias());
  m.observe(cov({ from: 0, to: 5 })); // the window runs to the due bell plus grace
  const c = viewA(m);
  assert.equal(c.state, 'unconfirmed');
  assert.ok(c.reasons.includes('coverage_insufficient'));
  assert.ok(c.coverage_gaps.includes('window_not_fully_covered'));
  // two coverages that leave a hole between them: still unconfirmed
  const m2 = promised();
  m2.observe(alias());
  m2.observe(cov({ from: 0, to: 5 }));
  m2.observe(cov({ from: 8, to: 40 }));
  assert.equal(viewA(m2).state, 'unconfirmed');
});

test('malformed or missing provenance: never chain; a malformed basis is refused, a missing one is unstated', () => {
  const m = promised();
  for (const bad of [{ kind: 'chain' }, { kind: 'Chain', source: 'x' }, { kind: 'chain', source: 'x', extra: 1 }, { kind: 'chain', source: 7 }, 'chain'])
    assert.throws(() => m.observe(cov({ basis: bad, sig: `bad-${JSON.stringify(bad)}` })), /basis/, JSON.stringify(bad));
  assert.equal(m.journal.records().filter(r => r.type === 'fact').length, 0, 'nothing written by a refused fact');
  m.observe(alias(PUB, null));
  m.observe(cov({ basis: null }));
  const c = viewA(m);
  assert.equal(c.state, 'not_sent', 'the fold still decides from the records it has');
  assert.equal(c.evidence_basis.kind, 'unstated', 'but says the grounds have no stated provenance');
});

test('private facts decide only for their parties; public views show neither the decision nor the private records', () => {
  const m = promised();
  m.observe(alias(DM, { kind: 'fixture', source: 'PRIVATE-SOURCE-TEXT' }));
  m.observe(cov({ vis: DM, basis: { kind: 'fixture', source: 'PRIVATE-SOURCE-TEXT' }, sig: 'cov-secret' }));
  assert.equal(viewA(m).state, 'not_sent');
  const pub = m.knowledge({ tag: null, nation: null }, 300).commitments[0];
  assert.equal(pub.state, 'unconfirmed');
  assert.deepEqual(pub.reasons, ['no_record_found']);
  assert.equal(pub.evidence_basis, null);
  const ids = { walletKnown: w => (w === B ? { tag: TAG, partition: W.partition, source: 'fixture pairing' } : null) };
  const shown = JSON.stringify([
    ws12EvidencePort(m, { identity: ids, worldBellOf: b => b }).read({ counterparty: B, worldBell: 300 }),
    m.summary({ tag: null, nation: null }, 300),
    m.knowledge({ tag: null, nation: null }, 300).facts,
  ]);
  assert.ok(!/cov-secret|alias-parties|PRIVATE-SOURCE-TEXT/.test(shown), 'no private record id, source or basis text in any public view');
  // a third party is the public here
  const C = b58encode(Buffer.alloc(32, 12));
  assert.equal(m.knowledge({ tag: C, nation: null }, 300).commitments[0].state, 'unconfirmed');
});

test('a crash at ANY byte of the write that names a torn tail (and a third crash after that) still opens, keeps every record and loses none written later', () => {
  const base = tmp();
  const m = createMemory({ path: base });
  m.note(note(1)); m.note(note(2));
  appendFileSync(base, '{"record":{"id":"half-writ'); // crash 1
  const before = readFileSync(base, 'utf8');
  const copy = tmp(); writeFileSync(copy, before);
  createMemory({ path: copy }).note(note(3));
  const full = readFileSync(copy, 'utf8').slice(before.length); // newline + marker + the n3 row
  for (let n = 0; n <= full.length; n++) {
    const p = tmp();
    writeFileSync(p, before + full.slice(0, n)); // crash 2 after n bytes
    const r = createMemory({ path: p });
    const texts = r.journal.records().map(x => x.text);
    assert.deepEqual(texts, n >= full.length - 1 ? ['n1', 'n2', 'n3'] : ['n1', 'n2'], `cut ${n}`); // the row is whole once only its newline is missing
    r.note(note(4));
    assert.deepEqual(createMemory({ path: p }).journal.records().map(x => x.text), [...texts, 'n4'], `cut ${n}: written after the reload`);
    if (n % 7 === 3) { // crash 3, inside the next naming write
      const p3 = tmp();
      writeFileSync(p3, before + full.slice(0, n));
      const r3 = createMemory({ path: p3 });
      const pre = readFileSync(p3, 'utf8');
      const c3 = tmp(); writeFileSync(c3, pre); createMemory({ path: c3 }).note(note(5));
      const full3 = readFileSync(c3, 'utf8').slice(pre.length);
      for (const k of [1, Math.floor(full3.length / 2), full3.length - 1]) {
        const q = tmp();
        writeFileSync(q, pre + full3.slice(0, k));
        const r4 = createMemory({ path: q });
        const seen = r4.journal.records().map(x => x.text);
        assert.deepEqual(seen.slice(0, texts.length), texts, `cut ${n} then ${k}: nothing earlier lost`);
        assert.ok(seen.length === texts.length || (seen.length === texts.length + 1 && seen.at(-1) === 'n5'), `cut ${n} then ${k}: ${seen}`);
        r4.note(note(6));
        assert.deepEqual(createMemory({ path: q }).journal.records().map(x => x.text), [...seen, 'n6'], `cut ${n} then ${k}`);
      }
      void r3;
    }
  }
});

test('valid JSON that is not a journal row is refused as a corrupt line, not a crash', () => {
  for (const junk of ['5', '{}', '"x"', 'null', '{"record":3}']) {
    const p = tmp();
    const m = createMemory({ path: p });
    m.note(note(1));
    appendFileSync(p, `${junk}\n`);
    m.note(note(2)); // not last: no tear story can explain it
    assert.throws(() => createMemory({ path: p }), /corrupt line 2/, junk);
  }
});

test('a whole last record without its newline is kept, and the next record is not run onto it', () => {
  const p = tmp();
  const m = createMemory({ path: p });
  m.note(note(1)); m.note(note(2));
  writeFileSync(p, readFileSync(p, 'utf8').slice(0, -1)); // the crash took only the final newline
  const r = createMemory({ path: p });
  assert.deepEqual([r.journal.torn, r.journal.records().length], [0, 2]);
  r.note(note(3));
  assert.deepEqual(createMemory({ path: p }).journal.records().map(x => x.text), ['n1', 'n2', 'n3']);
});

test('a write that fails part-way (with or without a torn tail before it): the retry keeps every record, at every cut', () => {
  for (const torn of [false, true]) {
    const base = tmp();
    const m = createMemory({ path: base });
    m.note(note(1));
    if (torn) appendFileSync(base, '{"record":{"id":"ha');
    const before = readFileSync(base, 'utf8');
    const c = tmp(); writeFileSync(c, before); createMemory({ path: c }).note(note(2));
    const full = readFileSync(c, 'utf8').slice(before.length);
    for (let n = 0; n < full.length; n++) {
      const p = tmp(); writeFileSync(p, before);
      const r = createMemory({ path: p });
      r.journal._appendFile = (f, s) => { appendFileSync(f, s.slice(0, n)); throw new Error('ENOSPC'); };
      assert.throws(() => r.note(note(2)), /ENOSPC/);
      assert.equal(r.journal.records().length, 1, 'not kept after a failed write');
      delete r.journal._appendFile;
      assert.equal(r.note(note(2)).status, 'added', `torn ${torn} cut ${n}: retry`);
      r.note(note(3));
      const back = createMemory({ path: p });
      assert.deepEqual(back.journal.records().map(x => x.text), ['n1', 'n2', 'n3'], `torn ${torn} cut ${n}`);
      assert.ok(readFileSync(p, 'utf8').startsWith(before), 'nothing before it rewritten');
    }
  }
});

test('markers: a repeated marker is harmless; a marker for other bytes or another line does not excuse damage', () => {
  const p = tmp();
  const m = createMemory({ path: p });
  m.note(note(1));
  appendFileSync(p, '{"rec');
  const r = createMemory({ path: p });
  r.note(note(2));
  const text = readFileSync(p, 'utf8');
  const marker = text.split('\n').find(l => l.startsWith('{"torn"'));
  writeFileSync(p, text.replace(`${marker}\n`, `${marker}\n${marker}\n`)); // the same marker twice
  assert.deepEqual(createMemory({ path: p }).journal.records().map(x => x.text), ['n1', 'n2']);
  const other = marker.replace(/"sha256":"[0-9a-f]+"/, '"sha256":"00"');
  writeFileSync(p, text.replace(marker, other));
  assert.throws(() => createMemory({ path: p }), /corrupt line 2/, 'a marker that names other bytes');
});

test('journals written by earlier versions open unchanged and take new records', () => {
  const row = (i, extra = '') => JSON.stringify({ record: createMemory({}).note(note(i)).record }) + extra;
  const cases = {
    // before 5370d0fe: a torn tail, never named
    'pre-5370d0fe torn tail': `${row(1)}\n{"record":{"id":"x`,
    // before 5370d0fe: the old defect already happened (a record written onto a torn line): those bytes stay torn
    'pre-5370d0fe fused record': `${row(1)}\n{"record":{"id":"x${row(2)}\n`,
    // 5370d0fe: one marker per torn line, then the record
    '5370d0fe marker': null,
    'garbage last line with newline': `${row(1)}\ngarbage\n`,
  };
  { const p0 = tmp(); writeFileSync(p0, `${row(1)}\n{"rec`); createMemory({ path: p0 }).note(note(2)); cases['5370d0fe marker'] = readFileSync(p0, 'utf8'); }
  for (const [name, text] of Object.entries(cases)) {
    const p = tmp();
    writeFileSync(p, text);
    const m = createMemory({ path: p });
    const had = m.journal.records().map(x => x.text);
    assert.ok(had.includes('n1'), name);
    m.note(note(9));
    assert.deepEqual(createMemory({ path: p }).journal.records().map(x => x.text), [...had, 'n9'], name);
    assert.ok(readFileSync(p, 'utf8').startsWith(text), `${name}: the old bytes are kept as they were`);
  }
});
