#!/usr/bin/env node
// Regenerates scenarios/fixtures/ws14-centre-d9c8b81d.json by running ⑭'s own `centreFacts` (game/centre.mjs at
// d9c8b81d09fac0a0eeb9ef471e1dc7cb2c20fbd1, origin/claude/hopeful-cori-tql3le). Extract first (read only):
//   git archive d9c8b81d workstreams/14-central-tower | tar -x -C <dir>
//   git show 3f3c8478:workstreams/01-national-strategy/test/fixtures/herald-caravans-ended.json > <dir>/herald-caravans-ended.json
//   node workstreams/15-coop-outcomes/scenarios/fixtures/gen-ws14-centre.mjs <dir>
// Inputs: (1) ①'s committed herald file (a real herald output; nothing of it is at the centre); (2) a feed ⑮ wrote in
// the shape ⑭'s test pins to the herald's source (herald/src/caravan.rs, structure.rs), with /h/status read before
// and after, once still and once moving. No key, no network.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const { centreFacts } = await import(`${root}/workstreams/14-central-tower/game/centre.mjs`);
const herald = JSON.parse(readFileSync(`${root}/herald-caravans-ended.json`, 'utf8'));
const place = (p, q, tile = 20) => ({ kind: 1, p, q, at: 2, gen: 1, tile });
const caravan = (tag, seq, faction, provinces, cargo) => ({ ownerTag: tag, seq, faction, src: place(...provinces[0]), dst: place(...provinces.at(-1)),
  steps: 7, cargo, arriveTs: 1790000000, runs: [], raided: false, path: Array(12).fill(0), provinces });
const feeds = {
  caravans: { v: 1,
    moving: [
      caravan('17278127443140898241', 0, 0, [[3, 0], [2, 0], [1, 0], [0, 0], [-1, 0]], [0, 100, 0, 0, 0, 0, 0, 0]),
      caravan('12', 0, 1, [[2, 0], [1, 0]], [0, 30, 50, 0, 0, 0, 0, 0]),
      caravan('13', 0, 2, [[3, -1], [3, 0]], [0, 100, 0, 0, 0, 0, 0, 0]),
    ],
    vaults: [{ p: 0, q: 0, tile: 40, ownerTag: '21', faction: 0, gen: 1 }, { p: 1, q: 0, tile: 3, ownerTag: '22', faction: 3, gen: 1 }, { p: 4, q: 0, tile: 9, ownerTag: '23', faction: 0, gen: 1 }] },
  structures: { v: 1,
    structures: [{ p: 0, q: 0, tile: 30, kind: 1, faction: 2, ownerTag: '31', gen: 1, notify: 1, cover: [], sent: 0 }, { p: 5, q: 0, tile: 10, kind: 1, faction: 0, ownerTag: '32', gen: 1, notify: 1, cover: [], sent: 0 }],
    sightings: [{ seq: 1, bell: 290, tower: { p: 0, q: 0, tile: 30 }, towerFaction: 2, notify: 1, ownerTag: '31', what: 'caravan', faction: 0, p: 0, q: 0, tile: 29, subject: '17278127443140898241' },
      { seq: 2, bell: 291, tower: { p: 5, q: 0, tile: 10 }, towerFaction: 0, notify: 1, ownerTag: '32', what: 'depart', faction: 1, p: 5, q: 0, tile: 11, subject: '9' }] },
};
const st = (events, lastSlot) => ({ v: 1, foldedThrough: 4, events, lastSlot, alarms: [] });
const out = {
  source: { repo: 'r0ze998/wylls', branch: 'claude/hopeful-cori-tql3le', commit: 'd9c8b81d09fac0a0eeb9ef471e1dc7cb2c20fbd1', code: 'workstreams/14-central-tower/game/centre.mjs centreFacts',
    note: 'Each output is what ⑭\'s centreFacts returned. "herald" reads ①\'s committed herald file (3f3c8478 test/fixtures/herald-caravans-ended.json); "still" and "moving" read a feed ⑮ wrote in the herald\'s shape. No running herald was read.' },
  outputs: {
    herald: centreFacts({ caravans: { v: 1, moving: herald.moving ?? [], vaults: herald.vaults ?? [] }, structures: null, observedAt: 'fixture' }),
    still: centreFacts({ ...feeds, observedAt: 'turn 1', status: { before: st(900, 5000), after: st(900, 5000) } }),
    moving: centreFacts({ ...feeds, observedAt: 'turn 2', status: { before: st(900, 5000), after: st(905, 5012) } }),
    file: centreFacts({ ...feeds, observedAt: null }),
    badVersion: centreFacts({ caravans: { v: 2, moving: [], vaults: [] } }),
  },
};
writeFileSync(new URL('./ws14-centre-d9c8b81d.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
for (const [k, o] of Object.entries(out.outputs)) console.log(k, o.refused ?? `${o.facts.length} facts, stable ${o.provenance.stable}`);
