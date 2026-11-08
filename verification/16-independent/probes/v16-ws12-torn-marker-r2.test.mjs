// ⑯ round 2 on ⑫'s journal (workstreams/12-memory/src/store.mjs, ⑫ 13903d94): crashes at EVERY byte of the
// appends that follow a torn tail, two and three crashes deep, and partial in-process writes that are retried.
// Notes only (no allocation, so the verification path is not reached); temp files; the memory module's import
// closure has no key generation or signing (audited). RECORDS every reload that refuses or loses a written note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createMemory } = await import(process.env.V16_WS12_INDEX);
const dir = mkdtempSync(join(tmpdir(), 'v16-ws12r2-'));
let seq = 0;
const tmp = () => join(dir, `m${seq++}.jsonl`);
const note = i => ({ owner: 'A', bell: i, about: null, by: 'code', basis: [], text: `n${i}` });
const open = path => { try { const m = createMemory({ path }); return { ok: true, m, torn: m.journal.torn, texts: m.journal.records().map(r => r.text) }; } catch (e) { return { ok: false, error: e.message.replace(/ in \/.*/, '') }; } };
// the exact bytes the next note would append to a file holding `text` (computed on a copy)
const nextAppend = (text, i) => { const p = tmp(); writeFileSync(p, text); createMemory({ path: p }).note(note(i)); return readFileSync(p, 'utf8').slice(text.length); };
const base = () => { const p = tmp(); const m = createMemory({ path: p }); m.note(note(1)); m.note(note(2)); appendFileSync(p, '{"record":{"id":"half-writ'); return readFileSync(p, 'utf8'); };
const expect = (r, want) => r.ok && want.every(t => r.texts.includes(t));

test('T2 two crashes: every cut of the 1st append after a torn tail x every cut of the 2nd', () => {
  const t0 = base(); const a = nextAppend(t0, 3);
  const bad = []; let n = 0;
  for (let c1 = 0; c1 <= a.length; c1++) {
    const t1 = t0 + a.slice(0, c1);
    const r1 = open(writeAndPath(t1)); n++;
    const want1 = c1 === a.length ? ['n1', 'n2', 'n3'] : ['n1', 'n2'];
    if (!expect(r1, want1)) { bad.push({ c1, r: r1.ok ? r1.texts : r1.error }); continue; }
    const b = nextAppend(t1, 4);
    for (let c2 = 0; c2 <= b.length; c2++) {
      const r2 = open(writeAndPath(t1 + b.slice(0, c2))); n++;
      const want2 = [...want1, ...(c2 === b.length ? ['n4'] : [])];
      if (!expect(r2, want2)) bad.push({ c1, c2, r: r2.ok ? r2.texts : r2.error });
    }
  }
  console.log('T2', JSON.stringify({ reloads: n, firstAppendBytes: a.length, failures: bad.length, sample: bad.slice(0, 6) }));
  assert.ok(n > 0);
});

test('T3 three crashes, each inside the marker block of the next append', () => {
  let t = base(); const trail = [];
  for (let k = 0; k < 3; k++) {
    const a = nextAppend(t, 10 + k);
    const cut = a.lastIndexOf('{"torn"') + 12; // inside the LAST marker of the block
    t = t + a.slice(0, cut);
    const r = open(writeAndPath(t));
    trail.push(r.ok ? `crash ${k + 2}: opens (torn ${r.torn}, ${r.texts.join(',')})` : `crash ${k + 2}: REFUSES ${r.error}`);
  }
  console.log('T3', JSON.stringify(trail, null, 1));
  assert.ok(true);
});

test('T4 in-process partial writes (failed append, then retry), every cut, after a torn tail', () => {
  const t0 = base(); const a = nextAppend(t0, 3);
  const bad = [];
  for (let c = 0; c <= a.length; c++) {
    const p = writeAndPath(t0);
    const m = createMemory({ path: p });
    let thrown = false;
    m.journal._appendFile = (path, s) => { appendFileSync(path, s.slice(0, c)); throw new Error('EIO (injected)'); };
    try { m.note(note(3)); } catch { thrown = true; }
    delete m.journal._appendFile;
    let retried = 'ok'; try { m.note(note(3)); } catch (e) { retried = e.message; }
    const live = m.journal.records().map(r => r.text);
    const r = open(p);
    const okLive = thrown && retried === 'ok' && ['n1', 'n2', 'n3'].every(x => live.includes(x)) && live.filter(x => x === 'n3').length === 1;
    const okReload = r.ok && ['n1', 'n2', 'n3'].every(x => r.texts.includes(x)) && r.texts.filter(x => x === 'n3').length === 1;
    if (!okLive || !okReload) bad.push({ c, retried, live, reload: r.ok ? r.texts : r.error });
  }
  console.log('T4', JSON.stringify({ cuts: a.length + 1, failures: bad.length, sample: bad.slice(0, 6) }));
  assert.ok(true);
});

function writeAndPath(text) { const p = tmp(); writeFileSync(p, text); return p; }
