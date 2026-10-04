// Provenance of test/fixtures/ai-ac9-slice4/: a VERBATIM subset of the wave-A slice-4 run (local test chain, real Gemma 4
// decisions, 2026-10-04). Nothing in the copied files is edited; only which files and which lines are kept is chosen here.
//   node ai-ac9-slice4-extract.mjs <slice-4 AI_DIR> <out dir>
// Kept: pub/{roster,commitments}.json, pub/anchors/commit.json, pub/metrics/latest.json (the full-run snapshot, bell 85),
// pub/minds/{40,52,64,70}.json (the bells of the 7 model marches), pub/memory/<tag>/episodes.json (all 6 AIs), fleet/ai-brain.json,
// state/records.jsonl lines (op add and op tx) of the records of those four bells, and 5 stored llama request bodies.
// What is NOT verbatim-complete: the minds files of the other 81 bells and the other 9 request bodies are left out, so numbers
// computed on this subset differ from the full run's (the tests say which).
import fs from 'node:fs';
import path from 'node:path';
const [src, out] = process.argv.slice(2);
const copy = (rel) => { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.copyFileSync(path.join(src, rel), path.join(out, rel)); };
for (const f of ['pub/roster.json', 'pub/commitments.json', 'pub/anchors/commit.json', 'pub/metrics/latest.json', 'fleet/ai-brain.json', 'census/summary.json']) copy(f);
for (const b of [40, 52, 64, 70]) copy(`pub/minds/${b}.json`);
for (const d of fs.readdirSync(path.join(src, 'pub/memory'))) copy(`pub/memory/${d}/episodes.json`);
const ids = new Set();
for (const b of [40, 52, 64, 70]) for (const r of JSON.parse(fs.readFileSync(path.join(src, `pub/minds/${b}.json`), 'utf8')).records) ids.add(r.id);
const keep = fs.readFileSync(path.join(src, 'state/records.jsonl'), 'utf8').split('\n').filter((l) => { if (!l) return false; const j = JSON.parse(l); return ids.has(j.entry?.id ?? j.id); });
fs.mkdirSync(path.join(out, 'state'), { recursive: true });
fs.writeFileSync(path.join(out, 'state/records.jsonl'), keep.join('\n') + '\n');
// request bodies: 3 eligible for the probe (a threat episode in the MEMORY block), 1 with clash episodes and no key kind, 1 with no Remembered line
const want = ['40bfe3dc', 'adf2b577', 'f8812bf4', '042aca5c', '5ccec64b'];
const reqs = fs.readdirSync(path.join(src, 'state/requests')).filter((f) => want.some((w) => f.startsWith(w)));
for (const f of reqs) { fs.mkdirSync(path.join(out, 'state/requests'), { recursive: true }); fs.copyFileSync(path.join(src, 'state/requests', f), path.join(out, 'state/requests', f)); }
// their records (for the probe's stored choices): the records of bells 16 and 52 and 70 are not all in the four minds files
const all = fs.readFileSync(path.join(src, 'state/records.jsonl'), 'utf8').split('\n').filter(Boolean);
const reqIds = new Set(reqs.map((f) => f.slice(0, -5)));
const extra = all.filter((l) => { const j = JSON.parse(l); return reqIds.has(j.entry?.id ?? j.id) && !ids.has(j.entry?.id ?? j.id); });
fs.appendFileSync(path.join(out, 'state/records.jsonl'), extra.join('\n') + (extra.length ? '\n' : ''));
console.log(JSON.stringify({ minds_records: ids.size, journal_lines: keep.length + extra.length, requests: reqs.length }));
