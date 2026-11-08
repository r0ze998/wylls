// node workstreams/14-central-tower/proto/check-ws15.mjs <path to ⑮'s adapters/ws14.mjs>
// Feeds ⑭'s real facts (contract version 1) to ⑮'s tower adapter and prints
// what it makes of them. ⑮'s code is not copied here: give the path of a
// checkout of ⑮'s branch. A report, not a test: ⑮ owns its adapter.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createSim, run } from './model.mjs';
import { toFacts, BELLS_PER_HOUR } from './contract.mjs';

const adapter = await import(pathToFileURL(resolve(process.argv[2])).href);
const sim = createSim({ seed: 1, case: 'B', days: 21, periodHours: 7 * 24 }); run(sim);
const facts = toFacts(sim);
const map = { bellOfHour: h => h * BELLS_PER_HOUR, actorOf: id => `v${id}`, relayStructure: 'central-relay' };
const asIs = adapter.fromTowerFacts(facts, map);
const asV0 = adapter.fromTowerFacts({ ...facts, schema: 'wylls.ws14.tower-facts/0' }, map);
const count = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
console.log(JSON.stringify({
  ws14: { schema: facts.schema, events: facts.events.length, kinds: count(facts.events, e => e.kind) },
  ws15_with_v1: { refused: asIs.refused, events: asIs.events.length },
  ws15_if_relabelled_v0: {
    refused: asV0.refused,
    kinds: count(asV0.events, e => e.kind),
    verified: count(asV0.events, e => e.verified),
    atUndefined: asV0.events.filter(e => e.at === undefined || Number.isNaN(e.at)).length,
    sightingIdsUndefined: asV0.events.filter(e => e.kind === 'tower.report.used' && e.sighting === undefined).length,
    boardPostsAsSightings: asV0.events.filter(e => e.kind === 'tower.sighting').length,
    boundariesPassed: asV0.events.filter(e => e.src?.kind === 'period.boundary' && e.kind !== 'position').length,
  },
}, null, 1));
