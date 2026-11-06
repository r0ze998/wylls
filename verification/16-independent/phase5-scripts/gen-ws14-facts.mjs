// ⑯: regenerate ⑭'s contract-v1 facts (seed 1, 21 days, 168 h period) for cases A/B/C
// from ⑭'s own model and print the sha256 of a few serialisations. No key, no network.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const dir = process.argv[2];
const { createSim, run } = await import(pathToFileURL(`${dir}/model.mjs`).href);
const { toFacts, checkFacts } = await import(pathToFileURL(`${dir}/contract.mjs`).href);
const h = s => createHash('sha256').update(s).digest('hex');
for (const c of ['A', 'B', 'C']) {
  const sim = createSim({ seed: 1, case: c, days: 21, periodHours: 7 * 24 }); run(sim);
  const f = toFacts(sim);
  const chk = checkFacts(f);
  const forms = { compact: JSON.stringify(f), compactNL: JSON.stringify(f) + '\n', ind1NL: JSON.stringify(f, null, 1) + '\n', ind2NL: JSON.stringify(f, null, 2) + '\n', ind1: JSON.stringify(f, null, 1), ind2: JSON.stringify(f, null, 2) };
  console.log(c, JSON.stringify({ check: chk === true || chk?.ok === undefined ? chk : chk.ok, events: f.events.length, ...Object.fromEntries(Object.entries(forms).map(([k, v]) => [k, h(v)])) }));
}
