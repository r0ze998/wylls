// ⑯ independent verification, phase 2 (⑱ sealed marches, ⑲ MagicBlock /
// public operation). Real modules, no network, no chain.
//
//   T18-1  how long a march stays hidden: the seal's round T(arrive) is the
//          first drand round at or after the END of the arrival bell
//          (seal.mjs sealRound, clock.mjs tlockRound), but the owner's
//          self-reveal (marchbook.mjs revealStep, keeper reveal_accept.rs
//          "owners submit from the arrival bell's start") is due at the
//          bell's START. README.md:25 says the destination is "hidden by a
//          time-lock on drand … until the arrival turn has ended".
//   T19-1  the earlier prototype's MagicBlock undelegation (the Frontier
//          rebuild has none): the crank's intent order (crank.mjs
//          intentGroups: nations first) against the program's required
//          order (permutation-chain/src/state.rs undelegation_order: world
//          chunks 1..19, then the nations, then chunk 0). The program
//          refuses any other first step with UndelegationOrder
//          (svm-tests/tests/delegation.rs undelegation_intents_have_the_crank_shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealRound } from '../../permutation-server/web/frontier/seal.mjs';
import { bellEnd, bellStart, roundTime, tlockRound } from '../../permutation-server/web/frontier/clock.mjs';
import { revealStep } from '../../permutation-server/web/frontier/marchbook.mjs';
import { intentGroups } from '../src/crank.mjs';
import { NATION_TARGET, WORLD_CHUNKS } from '../client/src/codec.mjs';

test('T18-1: a march stays sealed until its arrival turn has ended (README.md:25); the self-reveal is not due before that', () => {
  // quicknet: genesis 1692803367, period 3 (web/frontier/abi.mjs QUICKNET); a season whose genesis is a round boundary.
  const clock = { genesisTs: 1_800_000_000, drand: { genesis: 1_692_803_367, period: 3 } };
  const arrive = 12;
  const T = sealRound(clock, arrive);
  assert.equal(T, tlockRound(clock.drand, clock.genesisTs, arrive), 'seal.mjs and clock.mjs agree on T(arrive)');
  const opensAt = roundTime(clock.drand.genesis, clock.drand.period, T);
  assert.ok(opensAt >= bellEnd(clock.genesisTs, arrive), 'the seal opens at or after the END of the arrival bell');
  // The owner's self-reveal timer, for a landed march with no attempt yet, at the START of the arrival bell.
  const entry = { state: 'landed', attempts: [], revealDelay: 0 };
  const step = revealStep(entry, { now: bellStart(clock.genesisTs, arrive), bellStart: bellStart(clock.genesisTs, arrive) });
  const dueAt = step.action === 'send' ? bellStart(clock.genesisTs, arrive) : step.at;
  assert.ok(dueAt >= bellEnd(clock.genesisTs, arrive),
    `the destination must not be sent in clear before the arrival turn has ended; the self-reveal is due at bell start + ${dueAt - bellStart(clock.genesisTs, arrive)} s, ${opensAt - dueAt} s before the seal's round ${T} (${step.action})`);
});

test('T19-1: the prototype crank undelegates in the order the program requires (chunks 1..19, nations, chunk 0)', () => {
  const nations = 6;
  const programOrder = [...Array.from({ length: WORLD_CHUNKS - 1 }, (_, i) => i + 1), ...Array.from({ length: nations }, (_, c) => NATION_TARGET + c), 0];
  const crankOrder = intentGroups({ nations }).flat();
  assert.deepEqual(crankOrder, programOrder,
    `the crank's first intent is ${JSON.stringify(intentGroups({ nations })[0])}; the program takes world chunk 1 first and refuses anything else with UndelegationOrder`);
});
