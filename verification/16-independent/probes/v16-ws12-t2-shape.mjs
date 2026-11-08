// characterise T2 failures: which first-cut c1 and which region of the 2nd append (by structure) refuse
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
const { createMemory } = await import(process.env.V16_WS12_INDEX);
const dir = mkdtempSync(join(tmpdir(), 'v16-ws12s-')); let q = 0; const tmp = () => join(dir, `m${q++}.jsonl`);
const note = i => ({ owner: 'A', bell: i, about: null, by: 'code', basis: [], text: `n${i}` });
const w = t => { const p = tmp(); writeFileSync(p, t); return p; };
const opens = t => { try { createMemory({ path: w(t) }); return true; } catch { return false; } };
const next = (t, i) => { const p = w(t); createMemory({ path: p }).note(note(i)); return readFileSync(p, 'utf8').slice(t.length); };
const p0 = tmp(); const m = createMemory({ path: p0 }); m.note(note(1)); m.note(note(2)); appendFileSync(p0, '{"record":{"id":"half-writ');
const t0 = readFileSync(p0, 'utf8'); const a = next(t0, 3);
const region = (s, c) => { // name the piece of append s that byte c falls in
  let off = 0; const parts = s.split('\n'); if (parts[0] === '') { if (c <= 1) return 'opening \\n'; off = 1; parts.shift(); }
  for (const [k, l] of parts.entries()) { if (!l) continue; const kind = l.startsWith('{"torn"') ? `marker#${k + 1}` : 'row';
    if (c < off + l.length) return `inside ${kind}`; if (c === off + l.length) return `${kind} w/o \\n`; off += l.length + 1; }
  return 'complete';
};
const groups = {};
for (let c1 = 0; c1 <= a.length; c1++) {
  const t1 = t0 + a.slice(0, c1); const b = next(t1, 4);
  for (let c2 = 0; c2 <= b.length; c2++) if (!opens(t1 + b.slice(0, c2))) { const g = `1st: ${region(a, c1)} | 2nd: ${region(b, c2)}`; groups[g] = (groups[g] ?? 0) + 1; }
}
console.log('first append structure:', JSON.stringify(a.split('\n').map(l => l.slice(0, 24))));
console.log(JSON.stringify(groups, null, 1));
