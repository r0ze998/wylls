// Writes two example logs (versions A and B) played by a SCRIPT in the
// player's seat, so the replay page and the measures can be tried before
// anyone plays. They are not human data. Run: node tools/example-logs.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const E = require('../proto/engine.js');
const B = require('../proto/bots.js');
const M = require('../proto/metrics.js');

const POLICIES = [null, 'counter', 'raider'];
const SEED = '101';

for (const variant of ['A', 'B']) {
  const s = E.newGame({ variant, seed: SEED, policies: POLICIES });
  const log = M.newLog({ variant, seed: SEED, policies: POLICIES, participant: 'SCRIPT（人間ではない）', session: { game: 'example', label: variant === 'A' ? 'K' : 'M', practice: false }, startedAt: '2026-10-24T00:00:00.000Z' });
  // The script plays the "counter" bot policy from the player's seat.
  const me = E.clone(s); me.nations[0].policy = 'counter';
  while (!s.over) {
    const bots = B.decideAll(s);
    const view = E.publicView(s, 0); view.nations[0].policy = 'counter';
    const mine = B.decide(view, 0);
    const t = { round: s.round, ms: 0, actions: [] };
    for (const a of mine) { const r = E.apply(s, 0, a); t.actions.push({ ms: 0, a, ok: r.ok, err: r.err || null }); }
    log.turns.push(t);
    E.advance(s, bots);
    log.hashes[t.round] = M.stateHash(s);
  }
  log.result = s.winner;
  log.endedAt = '2026-10-24T00:00:00.000Z';
  const out = path.join(__dirname, '..', 'logs', `example-script-${variant}.json`);
  fs.writeFileSync(out, JSON.stringify(log, null, 1));
  const m = M.measure(log);
  console.log(variant, M.csvRow(log, m));
}
