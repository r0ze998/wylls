// ⑯ round 3 on ⑫'s journal (⑫ a7ac51b7, the "stretch" rule): THREE crashes deep (1st and 2nd cut every STEP
// bytes, 3rd at every byte), and negative controls that real damage is still refused and no complete note is
// dropped. Notes only (no allocation: the verification path is not reached); temp files; no key API in the
// memory module's import closure (audited). RECORDS every reload that refuses or loses a complete note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createMemory } = await import(process.env.V16_WS12_INDEX);
const STEP = Number(process.env.V16_WS12_STEP ?? 11);
const dir = mkdtempSync(join(tmpdir(), 'v16-ws12r3-'));
let seq = 0;
const tmp = () => join(dir, `m${seq++}.jsonl`);
const w = t => { const p = tmp(); writeFileSync(p, t); return p; };
const note = i => ({ owner: 'A', bell: i, about: null, by: 'code', basis: [], text: `n${i}` });
const open = t => { try { const m = createMemory({ path: w(t) }); return { ok: true, texts: m.journal.records().map(r => r.text) }; } catch (e) { return { ok: false, error: e.message.replace(/ in \/.*/, '') }; } };
const next = (t, i) => { const p = w(t); createMemory({ path: p }).note(note(i)); return readFileSync(p, 'utf8').slice(t.length); };
const base = () => { const p = tmp(); const m = createMemory({ path: p }); m.note(note(1)); m.note(note(2)); appendFileSync(p, '{"record":{"id":"half-writ'); return readFileSync(p, 'utf8'); };
const cuts = (len, step) => { const c = []; for (let x = 0; x <= len; x += step) c.push(x); if (c.at(-1) !== len) c.push(len); return c; };

test('T6 three crashes after a torn tail (1st, 2nd every STEP bytes; 3rd every byte)', () => {
  const t0 = base(); const a = next(t0, 3);
  let n = 0; const bad = [];
  for (const c1 of cuts(a.length, STEP)) {
    const t1 = t0 + a.slice(0, c1); const want1 = ['n1', 'n2', ...(c1 === a.length ? ['n3'] : [])];
    const b = next(t1, 4);
    for (const c2 of cuts(b.length, STEP)) {
      const t2 = t1 + b.slice(0, c2); const want2 = [...want1, ...(c2 === b.length ? ['n4'] : [])];
      const c = next(t2, 5);
      for (let c3 = 0; c3 <= c.length; c3++) {
        const r = open(t2 + c.slice(0, c3)); n++;
        const want = [...want2, ...(c3 === c.length ? ['n5'] : [])];
        if (!r.ok || !want.every(x => r.texts.includes(x)) || new Set(r.texts).size !== r.texts.length) bad.push({ c1, c2, c3, r: r.ok ? r.texts : r.error });
      }
    }
  }
  console.log('T6', JSON.stringify({ step: STEP, reloads: n, failures: bad.length, sample: bad.slice(0, 5) }));
  assert.equal(bad.length, 0);
});

test('T7 negative controls: damage that no crash makes is still refused; a marker never hides a record', () => {
  const p = tmp(); const m = createMemory({ path: p }); for (const i of [1, 2, 3]) m.note(note(i));
  const good = readFileSync(p, 'utf8'); const L = good.split('\n');
  const flip = s => s.slice(0, 20) + (s[20] === 'x' ? 'y' : '\u0001') + s.slice(21);
  const sha = async s => (await import('node:crypto')).createHash('sha256').update(s).digest('hex');
  const out = {};
  out.middleRecordUnreadable = open([L[0], '{"record":{"id":"brok', L[1], L[2], ''].join('\n'));
  out.middleRecordFlipped = open([L[0], flip(L[1]), L[2], ''].join('\n'));
  return sha('{"record":{"id":"brok').then(h => {
    out.namedWithWrongSha = open([L[0], '{"record":{"id":"brok', JSON.stringify({ torn: { line: 2, sha256: '0'.repeat(64) } }), L[1], ''].join('\n'));
    out.namedProperly = open([L[0], '{"record":{"id":"brok', JSON.stringify({ torn: { line: 2, sha256: h } }), L[1], L[2], ''].join('\n'));
    // a marker that names a READABLE record's line must not drop that record
    out.markerNamesRecord = open([L[0], L[1], JSON.stringify({ torn: { line: 2, sha256: 'f'.repeat(64) } }), L[2], ''].join('\n'));
    // a damaged line in the middle, followed only by markers that name OTHER lines, then a record
    out.namedOtherLine = open([L[0], '{"record":{"id":"brok', JSON.stringify({ torn: { line: 9, sha256: h } }), L[1], ''].join('\n'));
    console.log('T7', JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, r]) => [k, r.ok ? `opens ${r.texts.join(',')}` : `REFUSES ${r.error}`])), null, 1));
    assert.equal(out.middleRecordUnreadable.ok, false);
    assert.equal(out.middleRecordFlipped.ok, false);
    assert.equal(out.namedWithWrongSha.ok, false);
    assert.equal(out.namedOtherLine.ok, false);
    assert.deepEqual(out.namedProperly.texts?.sort(), ['n1', 'n2', 'n3']);
    assert.ok(!out.markerNamesRecord.ok || ['n1', 'n2', 'n3'].every(x => out.markerNamesRecord.texts.includes(x)), 'a marker never drops a readable record');
  });
});
