// ⑯ independent challenge of ⑫'s torn-line marker (workstreams/12-memory/src/store.mjs, ⑫ 5370d0fe in ④'s 7c7fe932):
// a SECOND crash while the first write after a torn tail appends its `{torn:{line,sha256}}` marker. Notes only (no
// allocation, so no verification path); temp files; the memory module's import closure names no key API (audited).
// RECORDS what each reload does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createMemory } = await import(process.env.V16_WS12_INDEX);
const tmp = () => join(mkdtempSync(join(tmpdir(), 'v16-ws12-')), 'm.jsonl');
const note = i => ({ owner: 'A', bell: i, about: null, by: 'code', basis: [], text: `n${i}` });
const open = path => { try { const m = createMemory({ path }); return { ok: true, torn: m.journal.torn, texts: m.journal.records().map(r => r.text) }; } catch (e) { return { ok: false, error: e.message }; } };

// What the first append after the reload writes: '\n' + marker + '\n' + row + '\n'. Cut it at several points.
test('T1 a crash inside the marker append after a torn tail', () => {
  const base = tmp();
  const m = createMemory({ path: base }); m.note(note(1)); m.note(note(2));
  appendFileSync(base, '{"record":{"id":"half-writ'); // crash 1: torn tail
  const before = readFileSync(base, 'utf8');
  // the full append the next note would make (captured on a copy)
  const copy = tmp(); writeFileSync(copy, before);
  createMemory({ path: copy }).note(note(3));
  const full = readFileSync(copy, 'utf8').slice(before.length);
  const cuts = { 'newline only': 1, 'inside the marker': 12, 'marker without its newline': full.indexOf('\n', 1), 'marker and newline': full.indexOf('\n', 1) + 1, 'inside the row': full.indexOf('\n', 1) + 10 };
  const out = {};
  for (const [name, n] of Object.entries(cuts)) {
    const p = tmp(); writeFileSync(p, before + full.slice(0, n)); // crash 2 after n bytes
    const r = open(p);
    out[name] = r.ok ? `opens (torn ${r.torn}, ${r.texts.join(',')})` : `REFUSES: ${r.error.replace(/ in \/.*/, '')}`;
  }
  console.log('T1', JSON.stringify(out, null, 1));
  assert.ok(open(base).ok, 'the single-crash case opens');
});
