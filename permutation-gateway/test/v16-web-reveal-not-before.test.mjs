// ⑯ independent verification of ⑱'s web change (r18 b71b8197): the page's
// self-reveal must not leave the browser before the drand round that opens
// the seal is published. Real marchbook.mjs / clock.mjs / seal.mjs; the
// controller's one line that computes `notBefore` is checked by reading its
// source (the controller needs a page). No key is generated, derived or
// signed; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mb from '../../permutation-server/web/frontier/marchbook.mjs';
import { sealRound } from '../../permutation-server/web/frontier/seal.mjs';
import { bellEnd, bellStart, roundTime, tlockRound } from '../../permutation-server/web/frontier/clock.mjs';

const clock = { genesisTs: 1_800_000_000, drand: { genesis: 1_692_803_367, period: 3 } };
const entry = delay => ({ state: 'landed', attempts: [], revealDelay: delay });
// The controller's formula (controller.mjs readMarches, r18): T(arrive)'s round time + the margin.
const tPubOf = arrive => roundTime(clock.drand.genesis, clock.drand.period, tlockRound(clock.drand, clock.genesisTs, arrive)) + mb.REVEAL_PUBLISH_MARGIN;

test('V16-T18-1b: with notBefore the self-reveal is never due before the seal\'s round is published, for every arrival bell and delay', () => {
  assert.equal(typeof mb.REVEAL_PUBLISH_MARGIN, 'number', 'this tree has no notBefore (⑱ not applied)');
  for (let arrive = 1; arrive <= 300; arrive++) {
    const T = sealRound(clock, arrive);
    assert.equal(T, tlockRound(clock.drand, clock.genesisTs, arrive));
    const opensAt = roundTime(clock.drand.genesis, clock.drand.period, T);
    const notBefore = tPubOf(arrive);
    for (const delay of [0, 7, mb.REVEAL_DELAY_MAX]) {
      const e = entry(delay);
      const start = bellStart(clock.genesisTs, arrive);
      // Ask at every second from the bell start to just past the publication.
      for (let now = start; now <= notBefore + delay + 1; now += 1) {
        const s = mb.revealStep(e, { now, bellStart: start, notBefore });
        if (s.action === 'send') {
          assert.ok(now >= opensAt + mb.REVEAL_PUBLISH_MARGIN && now >= bellEnd(clock.genesisTs, arrive),
            `arrive ${arrive} delay ${delay}: sent at ${now}, the round ${T} is published at ${opensAt}`);
          break;
        }
      }
    }
  }
});

test('V16-T18-1c: the retry after a first self attempt also stays after the publication', () => {
  const arrive = 12, start = bellStart(clock.genesisTs, arrive), notBefore = tPubOf(arrive);
  // A first attempt recorded before the publication (an older page, or a clock jump back): the retry still waits.
  const e = { state: 'landed', revealDelay: 0, attempts: [{ route: 'self', t: start + 10, result: 'accepted' }] };
  const s = mb.revealStep(e, { now: start + 80, bellStart: start, notBefore });
  assert.deepEqual(s, { action: 'wait', at: notBefore });
});

test('V16-T18-1d (reading): the controller passes notBefore computed from tlockRound and the margin', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /roundTime\([^;]*tlockRound\([^;]*REVEAL_PUBLISH_MARGIN/);
  const calls = src.match(/revealStep\([^)]*\{[^}]*\}/g) ?? [];
  assert.ok(calls.length >= 1 && calls.every(c => /notBefore:/.test(c)), `every revealStep call passes notBefore: ${calls.join(' | ')}`);
});
