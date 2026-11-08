import { readFileSync } from 'node:fs';
const { fateOfRun } = await import(process.argv[2]);
const views = readFileSync(process.argv[3], 'utf8').trim().split('\n').map(l => JSON.parse(l).view);
const c = {};
for (const v of views) { const f = fateOfRun(v); const k = `${v.state} -> ${f.fate}${f.why ? ' (' + f.why.slice(0, 60) + ')' : ''}`; c[k] = (c[k] ?? 0) + 1; }
for (const [k, n] of Object.entries(c).sort()) console.log(n, k);
