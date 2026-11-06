import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const dir = process.argv[2];
const { evaluate } = await import(pathToFileURL(`${dir}/src/evaluate.mjs`).href);
const { RULESETS } = await import(pathToFileURL(`${dir}/src/rulesets.mjs`).href);
const { fromTowerFacts } = await import(pathToFileURL(`${dir}/src/adapters/ws14.mjs`).href);
const map = { actorOf: v => `v${v}` };
for (const c of ['A', 'B', 'C']) {
  const facts = JSON.parse(readFileSync(`${dir}/scenarios/fixtures/ws14-v1-bde8d1c1-case${c}.json`, 'utf8'));
  for (const rs of ['A', 'B', 'C']) {
    const mk = w => { const { events, streams } = fromTowerFacts(facts, map); const vs = new Map(); for (const f of facts.events) if (f.actor !== null) vs.set(f.actor, f.nation);
      return { state: { at: 0, nations: [...new Set(vs.values())].sort().map(n => `n${n}`), actors: [...vs].sort((a, b) => a[0] - b[0]).map(([v, n]) => ({ id: `v${v}`, nation: `n${n}` })), lots: [], keeps: [], streams: w ? streams : {} }, events: w ? events : [], windows: [{ id: 'given', opensAt: 0, endsAt: 21 * 24 * 6 }] }; };
    const a = evaluate(RULESETS[rs], mk(true)), b = evaluate(RULESETS[rs], mk(false));
    const st = v => { const m = {}; for (const p of v.achievements?.personal ?? []) m[p.status] = (m[p.status] ?? 0) + 1; return m; };
    console.log(rs, c, JSON.stringify({ awardsWith: a.awards?.length, awardsWithout: b.awards?.length, statusWith: st(a), statusWithout: st(b), prize: a.prize ?? a.world?.prize ?? null, worldEnds: a.world?.ends }));
  }
}
